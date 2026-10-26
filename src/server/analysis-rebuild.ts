import type { Database } from "bun:sqlite";
import { readRebuildStatusJson, writeRebuildStatusJson } from "../db/rebuild-status";
import { normalizeRebuildAccounts, type RebuildAccount } from "../shared/rebuild-accounts";
import { subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { buildEraIndex, type EraDeclaration, type EraIndex } from "./eras";
import { loadAccountResolver } from "./account-resolver";
import type { RebuildAccountTotalsContext } from "./rebuild-account-totals";
import type { SourceDeclaration } from "./archive-source";
import type {RateCard} from "./pricing";
import { hasCurrentSchema, publishCurrentBatch } from "./current/store";
import { currentRegistry } from "./current/registry";
import { markAllCurrentAccountsDirty } from "./current/v2";
import type { CurrentConfig } from "./current/registry";
import { parseRebuildOptions, resolveRebuildRange, rebuildTimeBounds, type RebuildDateRange, type RebuildScope, type RebuildOptions, type RebuildMode } from "../shared/analysis-rebuild";
import { isUsageVendor, vendorsForScope, type SyncRunResult, type UsageVendorId, type VendorId } from "../sync/contracts";
import {
  createAnalysisRebuildReport,
  evolveAnalysisRebuildReport,
  finalizeAnalysisRebuildReport,
  recordSourceAttemptInReport,
  type AnalysisRebuildReport,
} from "./analysis-rebuild-report";

export type { RebuildScope } from "../shared/analysis-rebuild";
export type RebuildStatus = {
  generation: number; scope: RebuildScope; range: RebuildDateRange | null;
  vendors?: VendorId[];
  accounts?: RebuildAccount[];
  meters?: "archive";
  accountDays?: Array<{vendor: UsageVendorId; day: string}>;
  accountMeterDays?: Array<{vendor: UsageVendorId; account: string; day: string}>;
  mode?: RebuildMode;
  timeBounds?: {from:string;untilExclusive:string} | null;
  requestedAt?: string;
  state: "queued" | "running" | "complete" | "error"; error: string | null;
  /**
   * Sources reread, then summaries republished, then the "reports" phase: the derived registers every
   * screen reads (price registers, limit windows, window sums) catch up with the rebuilt facts.
   */
  phase?: "sources" | "summaries" | "reports";
  /** In the "reports" phase: derived registers caught up, of `total`. */
  completed?: number;
  total?: number;
  warnings?: string[];
  report?:AnalysisRebuildReport;
};

export function analysisRebuildStatus(db: Database): RebuildStatus | null {
  const json = readRebuildStatusJson(db);
  return json ? JSON.parse(json) : null;
}
function save(db: Database, status: RebuildStatus): void {
  writeRebuildStatusJson(db, JSON.stringify(status));
}
function mergeStatus(db:Database,current:RebuildStatus,changes:Partial<RebuildStatus>,now=new Date()):RebuildStatus {
  const next={...current,...changes};
  next.report=evolveAnalysisRebuildReport(db,current,next,now);
  return next;
}
export function updateAnalysisRebuild(db:Database,generation:number,changes:Partial<RebuildStatus>):void {
  db.transaction(()=> {
    const current=analysisRebuildStatus(db);
    if(current?.generation===generation)save(db,mergeStatus(db,current,changes));
  }).immediate();
}
export function recordAnalysisRebuildSources(db:Database,generation:number,result:SyncRunResult,warnings:string[],unavailable:number):boolean {
  return db.transaction(()=> {
    const current=analysisRebuildStatus(db);
    if(!current || current.generation!==generation)return false;
    if(result.rebuildGeneration!==generation)return false;
    if(current.phase!=="sources" || (current.state!=="queued" && current.state!=="running"))return false;
    let accountDays: RebuildStatus["accountDays"];
    let accountMeterDays: RebuildStatus["accountMeterDays"];
    if (current.accounts && result.status === "success") {
      if (result.scope.kind !== "accounts" || result.scope.meters !== current.meters
        || JSON.stringify(normalizeRebuildAccounts(result.scope.accounts)) !== JSON.stringify(current.accounts))
        throw new Error("Source verification did not cover the selected accounts exactly");
      accountDays = result.vendors.flatMap(vendor => {
        if (vendor.vendor === "gauges" && current.meters === "archive") {
          const evidence = vendor.diagnostics.reparse as {accountScope?:string;meterDays?:unknown} | undefined;
          if (evidence?.accountScope !== "usage-with-archived-counters" || !Array.isArray(evidence.meterDays))
            throw new Error("Source verification has no account meter evidence");
          accountMeterDays = evidence.meterDays.map((item: unknown) => {
            if (!item || typeof item !== "object") throw new Error("Invalid account meter day evidence");
            const row = item as {vendor:UsageVendorId;account:string;day:string};
            if (!current.accounts!.some(account => account.vendor === row.vendor && account.account === row.account)
              || typeof row.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)
              || !Number.isFinite(Date.parse(row.day)) || new Date(row.day).toISOString().slice(0,10) !== row.day
              || current.range && (row.day < current.range.from || row.day > current.range.until))
              throw new Error("Invalid account meter day evidence");
            return {vendor:row.vendor,account:row.account,day:row.day};
          });
          return [];
        }
        const days = (vendor.diagnostics.reparse as {selectedDays?: unknown} | undefined)?.selectedDays;
        if (!isUsageVendor(vendor.vendor) || !Array.isArray(days) || days.some(day => typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)))
          throw new Error("Source verification has no exact account summary day evidence");
        return days.map(day => ({vendor: vendor.vendor as UsageVendorId, day: day as string}));
      });
    }
    if (current.vendors && result.status === "success") {
      const expected=vendorsForScope({kind:"vendors",vendors:current.vendors});
      const actual=vendorsForScope(result.scope);
      if (JSON.stringify(actual)!==JSON.stringify(expected) || result.vendors.length!==expected.length
        || expected.some(vendor=>result.vendors.filter(item=>item.vendor===vendor && item.status==="success").length!==1))
        throw new Error("Source verification did not cover the selected vendors exactly");
    }
    const report=recordSourceAttemptInReport(db,
      evolveAnalysisRebuildReport(db,current,current),result,warnings,unavailable,new Date());
    if (current.meters === "archive" && result.status === "success" && !accountMeterDays)
      throw new Error("Source verification omitted archived account meters");
    save(db,{...current,report,...(accountDays ? {accountDays} : {}),...(accountMeterDays ? {accountMeterDays} : {})});
    return true;
  }).immediate();
}
export function completeAnalysisRebuild(db:Database,generation:number,context?:RebuildAccountTotalsContext):boolean {
  return db.transaction(()=> {
    const current=analysisRebuildStatus(db);
    if(!current || current.generation!==generation)return false;
    if(current.phase!=="reports" || current.state!=="running")throw new Error("Rebuild reports are not in the running readiness phase");
    const {completed:completedCount,total}=current;
    if(typeof completedCount!=="number" || typeof total!=="number"
      || !Number.isSafeInteger(completedCount) || !Number.isSafeInteger(total)
      || completedCount<0 || total<0 || completedCount<total)
      throw new Error("Rebuild report preparation is not complete");
    const completed=mergeStatus(db,current,{state:"complete",error:null});
    completed.report=finalizeAnalysisRebuildReport(db,completed.report!,completedCount,total,new Date(),context);
    save(db,completed);
    return true;
  }).immediate();
}

function validateAccountSelection(db:Database,accounts:readonly RebuildAccount[],subscriptions:readonly EraDeclaration[]):void {
  const exists=(table:string)=>!!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  for(const selected of accounts) {
    const declared=subscriptions.some(sub=>{
      if(sub.id.toLowerCase()!==selected.account)return false;
      const vendor=(sub.vendor??"codex").toLowerCase();
      if(["codex","openai"].includes(vendor))return selected.vendor==="codex";
      if(vendor==="opencode")return selected.vendor==="opencode";
      try {
        const provider=subscriptionAccountingAdapter(vendor).id;
        return (provider==="glm"?"opencode":provider)===selected.vendor;
      } catch {return false;}
    });
    // A Claude account is known from its periods or from a session identity that named it (stage 4, W4),
    // a Codex account from its periods (W6).
    const retained=selected.vendor==="claude"
      ? loadAccountResolver(db,subscriptions).accounts("claude").includes(selected.account)
        || exists("claude_events") && !!db.query("SELECT 1 FROM claude_events WHERE account_key IS NOT NULL AND lower(subscription_id)=? LIMIT 1").get(selected.account)
      : selected.vendor==="codex" && loadAccountResolver(db,subscriptions).accounts("codex").includes(selected.account);
    if(!declared && !retained)throw new Error(`Unknown historical rebuild account: ${selected.vendor}:${selected.account}`);
  }
}

export function queueAnalysisRebuild(db: Database, selection: RebuildScope | RebuildOptions, now = new Date(), verifySources=false,
  subscriptions:readonly EraDeclaration[]=[], eras?:EraIndex, rateCards?:RateCard, sourceHomes?:readonly string[],
  sources:readonly SourceDeclaration[]=[]): RebuildStatus {
  const options = parseRebuildOptions(typeof selection === "string" ? {scope:selection} : selection);
  if (options.accounts && !verifySources) throw new Error("Account rebuild requires source verification");
  if (options.accounts) validateAccountSelection(db, options.accounts, subscriptions);
  const selectedVendors = options.accounts ? vendorsForScope({kind:"accounts",accounts:options.accounts,...(options.meters ? {meters:options.meters} : {})}) : options.vendors;
  const scope = options.scope, range = resolveRebuildRange(options, now);
  const { timeout } = db.query("PRAGMA busy_timeout").get() as {timeout:number};
  db.exec("PRAGMA busy_timeout=0");
  try {
    return db.transaction(() => {
      const current = analysisRebuildStatus(db);
      if (current?.state === "queued" || current?.state === "running") throw new Error("A recalculation is already queued or running. / Przeliczanie jest już zlecone lub trwa.");
      if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_runs'").get()
        && db.query("SELECT 1 FROM sync_runs WHERE status='running' LIMIT 1").get())
        throw new Error("Wait for the active synchronization before starting a rebuild");
      const status: RebuildStatus = {
        generation:(current?.generation ?? 0) + 1, scope, range,
        ...(selectedVendors ? {vendors:[...selectedVendors]} : {}),
        ...(options.accounts ? {accounts:options.accounts} : {}),
        ...(options.meters ? {meters:options.meters} : {}),
        mode:options.mode, requestedAt:now.toISOString(), timeBounds:range?rebuildTimeBounds(range):null,
        state:"queued", phase:verifySources?"sources":"summaries", error:null,
      };
      status.report=createAnalysisRebuildReport(db,status,now,{subscriptions,sources,eras:eras??buildEraIndex([...subscriptions]),rateCards,sourceHomes});
      save(db, status);
      return status;
    }).immediate();
  } finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
}

export function resumeAnalysisRebuild(db:Database):RebuildStatus {
  return db.transaction(()=>{
    const current=analysisRebuildStatus(db);
    if(!current || current.state!=="error")throw new Error("No failed recalculation to resume");
    const status=mergeStatus(db,current,{state:current.phase==="reports"?"running":"queued",error:null});
    save(db,status);
    return status;
  }).immediate();
}

/** Runs under the existing background writer gate; an interrupted job resumes after restart. */
export function runAnalysisRebuild(db: Database, config: CurrentConfig): boolean {
  const job = analysisRebuildStatus(db);
  if (!job || job.state === "complete" || job.state === "error" || job.phase === "sources" || job.phase === "reports") return false;
  save(db,mergeStatus(db,job,{state:"running"}));
  try {
    db.transaction(() => {
      // Usage sums follow the republished facts in the ledgers' own producers; this phase republishes the current projection.
      const global = job.vendors === undefined;
      if (!job.accounts && job.scope === "all" && hasCurrentSchema(db) && (global || job.vendors!.includes("gauges"))) {
        const registry = currentRegistry(config.subscriptions);
        db.exec("UPDATE current_projection_state SET config_fingerprint='',generated_at=NULL WHERE id=1");
        markAllCurrentAccountsDirty(db, registry);
        while (publishCurrentBatch(db, registry, new Date().toISOString(), 256, config)) {}
      }
      const current=analysisRebuildStatus(db);
      if(!current || current.generation!==job.generation)throw new Error("Rebuild generation changed during summary publication");
      save(db,mergeStatus(db,current,{state:"running",phase:"reports",completed:0,total:REBUILD_REGISTERS}));
    }).immediate();
  } catch (error) {
    // A busy writer is retryable; invalid data is shown to the user rather than retried forever.
    if (/database is locked|SQLITE_BUSY/i.test(String(error))) throw error;
    const current=analysisRebuildStatus(db);
    if(current?.generation===job.generation)save(db,mergeStatus(db,current,
      {state:"error",error:error instanceof Error ? error.message : String(error)}));
    throw error;
  }
  return true;
}

/** The derived registers of the "reports" phase: price registers, limit windows, window sums. */
export const REBUILD_REGISTERS = 3;
export interface RebuildRegisterState { prices: boolean; limitWindows: boolean; windowSums: boolean }
/**
 * The "reports" phase (plan U4.4): no report is prepared any more; every screen reads the derived
 * registers, so the rebuild is complete once the maintenance worker's turn finds all of them caught up
 * with the rebuilt facts. Records progress (registers caught up, of `REBUILD_REGISTERS`) and completes
 * the job; returns whether it completed.
 */
export function advanceRebuildReadiness(db:Database,state:RebuildRegisterState,context?:RebuildAccountTotalsContext):boolean {
  const job=analysisRebuildStatus(db);
  if(!job || job.phase!=="reports" || job.state!=="running")return false;
  const completed=[state.prices,state.limitWindows,state.windowSums].filter(Boolean).length;
  if(completed!==job.completed || job.total!==REBUILD_REGISTERS)updateAnalysisRebuild(db,job.generation,{completed,total:REBUILD_REGISTERS});
  return completed===REBUILD_REGISTERS && completeAnalysisRebuild(db,job.generation,context);
}
