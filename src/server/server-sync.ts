import { appendLogTail, readProcessLines } from "./server-process-output";
import type { SyncRunResult, SyncMode, VendorId } from "../sync/contracts";
import type { Database } from "../db/sqlite";
import { storedFingerprint, rulesFingerprint } from "../projects/remap";
import { ledgerRevision } from "../db/ledger-revision";
import type { SyncRequest } from "../sync/coordinator";
import { ARCHIVE_ROOT, CONFIG_ROOT, MACHINE, LOGIN, HOME_DIR } from "../config/paths";
import path from "path";
import type { RebuildMode } from "../shared/analysis-rebuild";
import { rebuildBlockingSync } from "../sync/rebuild-source-gate";
import { resolveDbPath } from "../db";
import { DEFAULT_PROBE_MINUTES } from "./probe-health";
import { ProgressRegistry, progressDirectory } from "../sync/progress";
import { SyncStore } from "../sync/store";
import type { AppContext } from "./app-context-types";
import { awaitingLocations, firstImportPending } from "./server-bootstrap";
import { getRemapState } from "./server-remap";
import { reloadAppContextConfiguration } from "./app-context";
import { analysisRebuildStatus, updateAnalysisRebuild } from "./analysis-rebuild";
import { gaugeJournalDeliveryStatus } from "../providers/core/journal-runtime";
import { gaugeJournalOutboxStatus } from "../providers/core/journal";
import { withLiveProgress } from "../sync/live-progress";

/** Mirrors the stage banners _sync.bat prints. The script numbers them [1/4]
 *  through [4/4] with lettered sub-stages, which counts to eight actual waits -
 *  so the UI counts stages, not the script's own numbering. Kept in step with
 *  the `echo [n/4]` lines there; an unrecognised banner simply leaves the phase
 *  where it was rather than resetting it. */
const SYNC_PHASES: Array<{ pattern: RegExp; index: number; label: string }> = [
  { pattern: /^\[1\/4\]\s*/, index: 1, label: "Kopiuję lokalne źródła do archiwum" },
  { pattern: /^\[2\/4\]\s*/, index: 2, label: "Indeksuję historię Codex" },
  { pattern: /^\[3\/4\]\s*/, index: 3, label: "Indeksuję transkrypty Claude Code" },
  { pattern: /^\[3b\/4\]\s*/, index: 4, label: "Indeksuję użycie OpenCode" },
  { pattern: /^\[3c\/4\]\s*/, index: 5, label: "Indeksuję wywołania Grok" },
  { pattern: /^\[3d\/4\]\s*/, index: 6, label: "Indeksuję generacje Antigravity" },
  { pattern: /^\[3e\/4\]\s*/, index: 7, label: "Mapuję zdarzenia do projektów" },
  { pattern: /^\[4\/4\]\s*/, index: 8, label: "Weryfikuję bazę" },
];

const SYNC_PHASE_COUNT = SYNC_PHASES.length;

export function syncPhaseFromLine(line: string): { index: number; label: string } | null {
  const phase = SYNC_PHASES.find(({ pattern }) => pattern.test(line));
  if (!phase) return null;
  return { index: phase.index, label: phase.label };
}

function captureSyncLine(line: string): void {
  appendLogTail(syncState, line);
  const phase = syncPhaseFromLine(line);
  if (!phase) return;
  syncState.phase_index = phase.index;
  syncState.phase = phase.label;
}

export interface SyncState {
  running: boolean;
  trigger: "manual" | "auto" | "cli" | null;
  mode: "incremental" | "full" | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  ok: boolean | null;
  /** Derived from the stage banners _sync.bat prints. phase_index is 0 before
   *  the first stage is recognised, so a caller can tell "starting" from
   *  "stage 1 running" instead of showing a filled first step immediately. */
  phase: string | null;
  phase_index: number;
  phase_count: number;
  log_tail: string[];
  run: SyncRunResult | null;
  completion_id: string | null;
  revisions: SyncRevisionState;
}

export interface SyncRevisionState {
  data: number | null;
  config: number | null;
  derived: number | null;
}

const unavailableSyncRevisions: SyncRevisionState = { data: null, config: null, derived: null };

const syncState: SyncState = {
  running: false,
  trigger: null,
  mode: null,
  started_at: null,
  finished_at: null,
  exit_code: null,
  ok: null,
  phase: null,
  phase_index: 0,
  phase_count: SYNC_PHASE_COUNT,
  log_tail: [],
  run: null,
  completion_id: null,
  revisions: unavailableSyncRevisions,
};

export function isIndexEmpty(sqlite: Database): boolean {
  const tables = ["events", "claude_events", "oc_events", "grok_events", "gemini_events"];
  for (const t of tables) {
    try {
      const row = sqlite.query(`SELECT 1 FROM ${t} LIMIT 1`).get();
      if (row) return false;
    } catch {
    }
  }
  return true;
}

export function needsRemap(sqlite: Database): boolean {
  if (isIndexEmpty(sqlite)) return false;
  if (storedFingerprint(sqlite) !== rulesFingerprint()) return true;
  for (const t of ["events", "claude_events", "oc_events", "grok_events"]) {
    const cols = sqlite.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>;
    if (cols.length === 0) continue;
    if (!cols.some((c) => c.name === "repo")) return true;
  }
  return false;
}

function readSyncRevisions(sqlite: Database): SyncRevisionState {
  let data: number | null = null;
  let config: number | null = null;
  let derived: number | null = null;
  try {
    const row = sqlite
      .query("SELECT data_revision, config_revision FROM sync_revisions WHERE id = 1")
      .get() as { data_revision: number; config_revision: number } | null;
    data = row?.data_revision ?? null;
    config = row?.config_revision ?? null;
  } catch {
    // Schema 0012 remains readable while the application waits for an explicit migration.
  }
  derived = ledgerRevision(sqlite);
  return { data, config, derived };
}

function revisionKey(revisions: SyncRevisionState): string {
  return `${revisions.data ?? "legacy"}:${revisions.config ?? "legacy"}:${revisions.derived ?? "legacy"}`;
}

export let activeSyncCompletion: Promise<SyncRunResult | null> | null = null;

// The periodic mirror pass; a sync run waits for it so two copies of the
// same archive destination never race (the OpenCode/Claude helpers rewrite
// files in place).
let standaloneMirror: Promise<void> | null = null;

export type SyncProcessRunner = (
  rootDir: string,
  dbPath: string,
  request: SyncRequest
) => Promise<SyncRunResult>;

const SYNC_RESULT_PREFIX = "TOKENATLAS_SYNC_RESULT:";

export function resolvedSyncRunnerEnvironment(dbPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) env[key] = value;
  }
  return {
    ...env,
    TOKENATLAS_ARCHIVE: ARCHIVE_ROOT,
    TOKENATLAS_CONFIG: CONFIG_ROOT,
    TOKENATLAS_DB: dbPath,
    TOKENATLAS_MACHINE: MACHINE,
    TOKENATLAS_LOGIN: LOGIN,
    TOKENATLAS_SYNC_MINUTES: process.env.TOKENATLAS_SYNC_MINUTES ?? "",
    TOKENATLAS_PROBE_MINUTES: process.env.TOKENATLAS_PROBE_MINUTES ?? "",
    TOKENATLAS_GEMINI_MINUTES: process.env.TOKENATLAS_GEMINI_MINUTES ?? "",
    USERPROFILE: HOME_DIR,
    HOME: HOME_DIR,
    APPDATA: process.env.APPDATA || path.join(HOME_DIR, "AppData", "Roaming"),
  };
}

export async function runSyncProcess(
  rootDir: string,
  dbPath: string,
  request: SyncRequest
): Promise<SyncRunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(rootDir, "src", "sync", "runner.ts"), JSON.stringify({ dbPath, rootDir, request })],
    cwd: rootDir,
    env: resolvedSyncRunnerEnvironment(dbPath),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderrLog, stderrDetail] = child.stderr.tee();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(stderrDetail).text(),
    readProcessLines(stderrLog, line => console.error(`[tokenAtlas sync] ${line}`)),
  ]);
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(SYNC_RESULT_PREFIX));
  if (exitCode !== 0 || !resultLine) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`Sync worker failed: ${detail}`);
  }
  return JSON.parse(resultLine.slice(SYNC_RESULT_PREFIX.length)) as SyncRunResult;
}

export function startSyncCompletion(
  rootDir: string,
  trigger: "manual" | "auto",
  mode: SyncMode = "incremental",
  ctx?: AppContext,
  vendor?: VendorId,
  reparse?: import("../sync/reparse").ReparseRange,
  rebuildGeneration?:number,
  collection?:RebuildMode|"mirror-only",
  vendors?:VendorId[],
  accounts?:import("../shared/rebuild-accounts").RebuildAccount[],
  meters?:"archive",
  bootstrapRecoveryId?:string
): Promise<SyncRunResult | null> | null {
  if (activeSyncCompletion) return activeSyncCompletion;
  if (awaitingLocations || getRemapState().running) return null;
  if (ctx?.sqlite && rebuildGeneration === undefined && rebuildBlockingSync(ctx.sqlite) !== null) return null;
  const dbPath = ctx?.dbPath ?? resolveDbPath();
  const before = ctx ? readSyncRevisions(ctx.sqlite) : unavailableSyncRevisions;
  const request: SyncRequest = {
    trigger,
    mode,
    scope: accounts ? {kind:"accounts",accounts,...(meters ? {meters} : {})} : vendors ? { kind: "vendors", vendors } : vendor ? { kind: "vendor", vendor } : { kind: "all" },
    ...(reparse?{reparse}:{}),
    ...(rebuildGeneration!==undefined?{rebuildGeneration}:{}),
    ...(collection?{collection}:{}),
    ...(bootstrapRecoveryId?{bootstrapRecoveryId}:{}),
  };
  const initial: SyncRunResult = {
    ...(rebuildGeneration !== undefined ? { rebuildGeneration } : {}),
    progress: { phase: "readings", startedAt: new Date().toISOString(), completed: 0, total: 0 },
    runId: crypto.randomUUID(),
    ownerPid: process.pid,
    trigger,
    scope: request.scope,
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    beforeRevisions: { data: before.data ?? 0, config: before.config ?? 0, vendors: { codex: 0, claude: 0, opencode: 0, grok: 0, gemini: 0, gauges: 0 } },
    afterRevisions: { data: before.data ?? 0, config: before.config ?? 0, vendors: { codex: 0, claude: 0, opencode: 0, grok: 0, gemini: 0, gauges: 0 } },
    aggregateWorkRequested: false,
    vendors: [],
    error: null,
  };
  Object.assign(syncState, syncStateFromRun(initial, before));
  const runner = ctx?.syncRunner ?? runSyncProcess;
  const completion = Promise.resolve()
    .then(async () => {
      if (collection !== "archive" && request.scope.kind !== "accounts" && !firstImportPending) {
        const readingVendors = vendors && !vendors.includes("gauges") ? vendors : [vendor];
        // A manual run reads the accounts now; an automatic one only when the probe interval has passed.
        const probeMinutes = Number(process.env.TOKENATLAS_PROBE_MINUTES ?? DEFAULT_PROBE_MINUTES);
        const notWithinMs = trigger === "auto" && Number.isFinite(probeMinutes) && probeMinutes > 0 ? probeMinutes * 60_000 : 0;
        const register = new ProgressRegistry(progressDirectory(dbPath));
        try {
          for (const readingVendor of readingVendors) await ctx?.refreshLiveReadings?.(readingVendor, (completed, total) =>
            register.report("sync", "readings", "Reading current account limits", "sources", completed, total), notWithinMs);
        } finally { register.end("sync"); }
      }
      initial.progress = { phase: "scan", startedAt: new Date().toISOString(), completed: 0, total: 0 };
      await standaloneMirror?.catch(() => undefined);
    })
    .then(() => {
      if (ctx?.sqlite && rebuildGeneration === undefined && rebuildBlockingSync(ctx.sqlite) !== null) {
        Object.assign(syncState, { ...syncStateFromRun(new SyncStore(ctx.sqlite).latestRun(), readSyncRevisions(ctx.sqlite)), running: false });
        return null;
      }
      return runner(rootDir, dbPath, request);
    })
    .then(
    (result) => {
      if (!result) return null;
      if (ctx && result.status !== "failure") {
        reloadAppContextConfiguration(ctx, result.changedConfigDomains ?? []);
      }
      const after = ctx ? readSyncRevisions(ctx.sqlite) : unavailableSyncRevisions;
      if (ctx && revisionKey(before) !== revisionKey(after)) ctx.responseCache?.invalidate();
      Object.assign(syncState, syncStateFromRun(result, after));
      return result;
    },
    (error): SyncRunResult => {
      const message = error instanceof Error ? error.message : String(error);
      const failedRun: SyncRunResult = {
        ...initial,
        status: "failure",
        finishedAt: new Date().toISOString(),
        error: `Sync completion failed: ${message}`,
      };
      Object.assign(
        syncState,
        syncStateFromRun(failedRun, ctx ? readSyncRevisions(ctx.sqlite) : unavailableSyncRevisions)
      );
      appendLogTail(syncState, failedRun.error!);
      return failedRun;
    }
  );
  const tracked = completion.finally(() => {
    if (activeSyncCompletion === tracked) {
      activeSyncCompletion = null;
    }
  });
  activeSyncCompletion = tracked;
  return tracked;
}

const sourceRebuilds=new WeakSet<Database>();

export async function advanceAnalysisRebuildSources(ctx:AppContext):Promise<void> {
  if(sourceRebuilds.has(ctx.sqlite) || activeSyncCompletion || getRemapState().running)return;
  const job=analysisRebuildStatus(ctx.sqlite);
  if(!job || job.phase!=="sources" || (job.state!=="queued" && job.state!=="running"))return;
  sourceRebuilds.add(ctx.sqlite);
  try {
    updateAnalysisRebuild(ctx.sqlite,job.generation,{state:"running"});
    const completion=startSyncCompletion(ctx.rootDir??path.resolve(import.meta.dir,"../.."),"manual","incremental",ctx,undefined,job.range??{},job.generation,job.mode??"archive",job.vendors,job.accounts,job.meters);
    if(!completion)return;
    const result=await completion;
    // Another process may still own an older sync after an application restart.
    if(result && result.rebuildGeneration!==job.generation)return;
    if(!result)throw new Error("Source verification failed");
    const warnings=result.vendors.flatMap(v=> {
      const reparse=v.diagnostics?.reparse as {unavailable?:unknown[]}|undefined;
      const mirror=v.diagnostics?.mirror as {warnings?:string[]}|undefined;
      const sourceWarnings=(v.diagnostics?.warnings??[]) as string[];
      return [...[...(mirror?.warnings??[]),...sourceWarnings].map(warning=>`${v.vendor}: ${warning}`),
        ...(reparse?.unavailable?.length?[`${v.vendor}: ${reparse.unavailable.length} source files unavailable; previously indexed data preserved. / Niedostępne pliki źródłowe: ${reparse.unavailable.length}; wcześniejsze dane zachowano.`]:[])];
    });
    const unavailable=result.vendors.reduce((count,v)=>count+((v.diagnostics?.reparse as {unavailable?:unknown[]}|undefined)?.unavailable?.length??0),0);
    const missing=result.vendors.flatMap(v=>((v.diagnostics?.reparse as {unavailable?:unknown[]}|undefined)?.unavailable??[])
      .map(identity=>`${v.vendor}: ${typeof (identity as {path?:unknown}).path==="string"?(identity as {path:string}).path:JSON.stringify(identity)}`));
    const {recordAnalysisRebuildSources}=await import("./analysis-rebuild");
    if(!recordAnalysisRebuildSources(ctx.sqlite,job.generation,result,warnings,unavailable))return;
    updateAnalysisRebuild(ctx.sqlite,job.generation,{warnings});
    if(unavailable) {
      updateAnalysisRebuild(ctx.sqlite,job.generation,{state:"error",warnings,
        error:`Source verification incomplete: ${unavailable} required source files unavailable (${missing.slice(0,5).join("; ")}${unavailable>5?"; …":""}). Restore access and resume this rebuild. / Weryfikacja źródeł nieukończona: ${unavailable} wymaganych plików jest niedostępnych. Przywróć dostęp i wznów odbudowę.`});
      return;
    }
    if(result.status!=="success")throw new Error(result.error || result.vendors.filter(v=>v.status==="failure").map(v=>v.error).join("; ") || "Source verification failed");
    updateAnalysisRebuild(ctx.sqlite,job.generation,{state:"queued",phase:"summaries",warnings});
  } catch(error) {
    if(!/database is locked|SQLITE_BUSY/i.test(String(error)))updateAnalysisRebuild(ctx.sqlite,job.generation,{state:"error",error:String(error)});
  } finally {sourceRebuilds.delete(ctx.sqlite);}
}

export function startSync(
  rootDir: string,
  trigger: "manual" | "auto",
  mode: SyncMode = "incremental",
  ctx?: AppContext,
  vendor?: VendorId
): SyncState {
  void startSyncCompletion(rootDir, trigger, mode, ctx, vendor);
  return syncState;
}

function syncStateFromRun(
  run: SyncRunResult | null,
  revisions: SyncRevisionState = unavailableSyncRevisions
): SyncState {
  if (!run) return { ...syncState, run: null, completion_id: null, revisions };
  const completed = run.vendors.filter((vendor) => vendor.status !== "pending").length;
  const pending = run.vendors.find((vendor) => vendor.status === "pending");
  const running = run.status === "running";
  return {
    running,
    trigger: run.trigger,
    mode: run.mode,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    exit_code: running ? null : run.status === "success" ? 0 : 1,
    ok: running ? null : run.status === "success",
    phase: running
      ? run.progress?.phase === "scan"
        ? "Sprawdzam zmienione pliki"
        : pending
          ? `Synchronizuję ${pending.vendor}`
          : "Kończę synchronizację"
      : run.status === "success"
        ? "Synchronizacja zakończona"
        : run.status === "partial_success"
          ? "Synchronizacja zakończona częściowo"
          : "Synchronizacja zakończona błędem",
    phase_index: running ? Math.min(SYNC_PHASE_COUNT - 1, completed + 1) : SYNC_PHASE_COUNT,
    phase_count: SYNC_PHASE_COUNT,
    log_tail: run.vendors
      .filter((vendor) => vendor.error)
      .map((vendor) => `${vendor.vendor}: ${vendor.error}`),
    run,
    completion_id: running ? null : run.runId,
    revisions,
  };
}

/**
 * Gauge journal backlog and delivery health. Four bounded fields: a queue that has
 * stopped draining was previously invisible outside one console warning.
 */
export function gaugeJournalOutbox(ctx: AppContext) {
  const delivery = gaugeJournalDeliveryStatus();
  try {
    const { pending, oldestQueuedAt } = gaugeJournalOutboxStatus(ctx.sqlite);
    return { pending, oldestQueuedAt, lastError: delivery.lastError, lastDeliveredAt: delivery.lastDeliveredAt,
      delivering: delivery.running };
  } catch {
    return { pending: null, oldestQueuedAt: null, lastError: delivery.lastError,
      lastDeliveredAt: delivery.lastDeliveredAt, delivering: delivery.running };
  }
}

export function currentSyncState(ctx: AppContext): SyncState {
  const persistedRevisions = readSyncRevisions(ctx.sqlite);
  let run = syncState.run;
  try {
    const store = new SyncStore(ctx.sqlite);
    run = store.activeRun() ?? (activeSyncCompletion ? run : store.latestRun() ?? run);
  } catch {
    // A legacy database can still report the in-memory state until it is migrated.
  }
  // The run writes its newest status outside the database it is writing (see live-progress.ts).
  run = withLiveProgress(ctx.sqlite.filename, run);
  const revisions = run?.status === "running" ? syncState.revisions : persistedRevisions;
  const current = syncStateFromRun(run, revisions);
  Object.assign(syncState, current);
  return syncState;
}
