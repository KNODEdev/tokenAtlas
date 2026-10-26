import { Database } from "../db/sqlite";
import { syncOwnerAlive } from "./process-owner";
import { rebuildBlockingSync } from "./rebuild-source-gate";
import { normalizeRebuildAccounts, normalizeRebuildMeters, type RebuildAccount } from "../shared/rebuild-accounts";
import {
  VENDOR_IDS,
  pendingVendorResult,
  vendorsForScope,
  type RevisionSnapshot,
  type SyncRunResult,
  type SyncRunStatus,
  type SyncScope,
  type SyncTrigger,
  type SyncMode,
  type ConfigDomain,
  type DirtyTimestampRange,
  type VendorId,
  type VendorSyncResult,
} from "./contracts";

interface RevisionRow {
  data_revision: number;
  config_revision: number;
  config_fingerprint: string;
}

interface StoredRunRow {
  run_id: string;
  trigger: SyncTrigger;
  scope: "all" | "vendor" | "vendors" | "accounts";
  vendor: string | null;
  mode: SyncMode;
  status: SyncRunStatus;
  started_at: string;
  finished_at: string | null;
  before_data_revision: number;
  after_data_revision: number;
  before_config_revision: number;
  after_config_revision: number;
  result_json: string | null;
  error: string | null;
}

function emptyVendorRevisions(): Record<VendorId, number> {
  return { codex: 0, claude: 0, opencode: 0, grok: 0, gemini: 0, gauges: 0 };
}

function canonicalScope(scope: SyncScope): SyncScope {
  const vendors = vendorsForScope(scope);
  if (scope.kind === "all") return { kind: "all" };
  if (scope.kind === "vendor") return { kind: "vendor", vendor: vendors[0]! };
  if (scope.kind === "accounts") {
    const meters = normalizeRebuildMeters(scope.meters);
    return {
      kind: "accounts",
      accounts: normalizeRebuildAccounts(scope.accounts),
      ...(meters === undefined ? {} : { meters }),
    };
  }
  return { kind: "vendors", vendors };
}

/**
 * Diagnostic lists are evidence samples, not archives. A run that fails over
 * every source file must not store one entry per file: keep the first entries
 * and report the real count beside them as `<name>Total`.
 */
export const DIAGNOSTIC_LIST_LIMIT = 50;
/** Hard ceiling for one persisted `result_json`. */
export const SYNC_RUN_RESULT_MAX_BYTES = 1024 * 1024;
const REDUCED_LIST_LIMIT = 5;
const REDUCED_TEXT_LIMIT = 2_000;
const REDUCED_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cap every list-valued diagnostic, keeping the first entries and the true count. */
export function boundedDiagnostics(
  diagnostics: Record<string, unknown>,
  limit = DIAGNOSTIC_LIST_LIMIT,
  depth = 3,
): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(diagnostics)) {
    if (Array.isArray(value)) {
      bounded[key] = depth > 0
        ? value.slice(0, limit).map((item) => (isPlainObject(item) ? boundedDiagnostics(item, limit, depth - 1) : item))
        : value.slice(0, limit);
      // A producer that already counted its own list keeps its count.
      if (value.length > limit && diagnostics[`${key}Total`] === undefined) bounded[`${key}Total`] = value.length;
    } else if (isPlainObject(value) && depth > 0) {
      bounded[key] = boundedDiagnostics(value, limit, depth - 1);
    } else bounded[key] = value;
  }
  return bounded;
}

function reducedValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length <= REDUCED_TEXT_LIMIT
      ? value
      : `${value.slice(0, REDUCED_TEXT_LIMIT)} … [${value.length - REDUCED_TEXT_LIMIT} more characters omitted from the stored record]`;
  }
  if (Array.isArray(value)) {
    return depth <= 0 ? [] : value.slice(0, REDUCED_LIST_LIMIT).map((item) => reducedValue(item, depth - 1));
  }
  if (isPlainObject(value)) {
    if (depth <= 0) return {};
    const reduced: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, DIAGNOSTIC_LIST_LIMIT)) {
      reduced[key] = reducedValue(item, depth - 1);
      if (Array.isArray(item) && item.length > REDUCED_LIST_LIMIT && value[`${key}Total`] === undefined) {
        reduced[`${key}Total`] = item.length;
      }
    }
    return reduced;
  }
  return value;
}

function reducedVendors(vendors: SyncRunResult["vendors"], diagnostics: (vendor: SyncRunResult["vendors"][number]) => Record<string, unknown>) {
  return vendors.map((vendor) => ({
    ...vendor,
    error: reducedValue(vendor.error, 1) as string | null,
    diagnostics: diagnostics(vendor),
  }));
}

function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Dirty ranges are the evidence a summary replay reads, never a sample: losing one
 * period silently drops the work it stands for. Readers expand every range to whole
 * days, so ranges whose days overlap or touch can be merged into one without
 * changing a single day they cover, and the merged form keeps real timestamps.
 */
function mergedDayRanges(ranges: readonly DirtyTimestampRange[]): DirtyTimestampRange[] {
  const ordered = ranges
    .map((range) => (range.from <= range.to ? { ...range } : { from: range.to, to: range.from }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const merged: DirtyTimestampRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && dayOf(range.from) <= nextDay(dayOf(previous.to))) {
      if (range.to > previous.to) previous.to = range.to;
    } else merged.push(range);
  }
  return merged;
}

/** The evidence a reader walks, bounded without sampling: exact day coverage and exact counts. */
function boundedVendorEvidence(vendor: VendorSyncResult): VendorSyncResult {
  const impact = vendor.sourceImpact;
  return {
    ...vendor,
    ...(vendor.dirtyRanges ? { dirtyRanges: mergedDayRanges(vendor.dirtyRanges) } : {}),
    ...(impact && impact.evidence.length > REDUCED_LIST_LIMIT
      ? {
          sourceImpact: {
            ...impact,
            evidence: impact.evidence.slice(0, REDUCED_LIST_LIMIT),
            evidenceTotal: impact.evidence.length,
          },
        }
      : {}),
  };
}

/**
 * The stored result of one run, never larger than `maxBytes`. Above the cap the
 * run keeps everything its readers walk - status, timestamps, revisions, per-vendor
 * status, counts, dirty ranges, source impact, rebuild identity and progress - and
 * says so with `truncated`. Used both when persisting and when compacting.
 */
export function boundedSyncRunResult(result: SyncRunResult, maxBytes = SYNC_RUN_RESULT_MAX_BYTES): SyncRunResult {
  const serialized = JSON.stringify(result);
  if (serialized === undefined || Buffer.byteLength(serialized) <= maxBytes) return result;
  const reduced: SyncRunResult = {
    ...result,
    error: reducedValue(result.error, 1) as string | null,
    vendors: reducedVendors(result.vendors, (vendor) => reducedValue(vendor.diagnostics, REDUCED_DEPTH) as Record<string, unknown>),
    truncated: true,
  };
  const reducedJson = JSON.stringify(reduced);
  if (reducedJson !== undefined && Buffer.byteLength(reducedJson) <= maxBytes) return reduced;
  // Sampled diagnostics still exceed the ceiling: keep only the evidence readers need.
  const sampled = { ...reduced, vendors: reducedVendors(reduced.vendors, () => ({ truncated: true })) };
  const sampledJson = JSON.stringify(sampled);
  if (sampledJson !== undefined && Buffer.byteLength(sampledJson) <= maxBytes) return sampled;
  // The remaining bulk is publication evidence, which is bounded losslessly, never cut.
  const bounded = { ...sampled, vendors: sampled.vendors.map(boundedVendorEvidence) };
  const boundedJson = JSON.stringify(bounded);
  if (boundedJson !== undefined && Buffer.byteLength(boundedJson) <= maxBytes) return bounded;
  throw new Error(
    `Sync run ${result.runId} needs ${boundedJson === undefined ? "unknown" : Buffer.byteLength(boundedJson)} bytes`
      + ` after bounding and cannot be stored within ${maxBytes} bytes without discarding publication evidence`
  );
}

function serializedRun(result: SyncRunResult): string {
  return JSON.stringify(boundedSyncRunResult({ ...result, scope: canonicalScope(result.scope) }));
}

function accountScopeFromStored(value: string): SyncScope {
  const stored = JSON.parse(value) as unknown;
  if (Array.isArray(stored)) return canonicalScope({ kind: "accounts", accounts: stored });
  if (!stored || typeof stored !== "object") throw new Error("Stored account sync scope is invalid");
  const record = stored as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(record, "accounts")
    || !Object.prototype.hasOwnProperty.call(record, "meters"))
    throw new Error("Stored account sync scope is invalid");
  const meters = normalizeRebuildMeters(record.meters);
  if (meters === undefined) throw new Error("Stored account sync scope is invalid");
  return canonicalScope({
    kind: "accounts",
    accounts: record.accounts as RebuildAccount[],
    meters,
  });
}

function scopeFromRow(row: StoredRunRow): SyncScope {
  if (row.scope === "accounts") {
    if (!row.vendor) throw new Error("Stored account sync scope is unavailable");
    return accountScopeFromStored(row.vendor);
  }
  if (row.scope === "vendors") {
    if (!row.vendor) throw new Error("Stored selected sync scope is unavailable");
    return canonicalScope({ kind: "vendors", vendors: JSON.parse(row.vendor) });
  }
  if (row.scope === "vendor" && row.vendor) return canonicalScope({ kind: "vendor", vendor: row.vendor as VendorId });
  if (row.scope === "all") return { kind: "all" };
  throw new Error("Stored sync scope is invalid");
}

function fallbackResult(row: StoredRunRow): SyncRunResult {
  const scope = scopeFromRow(row);
  const vendors = vendorsForScope(scope);
  const beforeVendors = emptyVendorRevisions();
  const afterVendors = emptyVendorRevisions();
  return {
    runId: row.run_id,
    trigger: row.trigger,
    scope,
    mode: row.mode,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    beforeRevisions: {
      data: row.before_data_revision,
      config: row.before_config_revision,
      vendors: beforeVendors,
    },
    afterRevisions: {
      data: row.after_data_revision,
      config: row.after_config_revision,
      vendors: afterVendors,
    },
    aggregateWorkRequested: false,
    vendors: vendors.map(pendingVendorResult),
    error: row.error,
  };
}

function parseStoredRun(row: StoredRunRow): SyncRunResult {
  if (!row.result_json) return fallbackResult(row);
  try {
    const result = JSON.parse(row.result_json) as SyncRunResult;
    result.scope = canonicalScope(result.scope);
    return result;
  } catch {
    return fallbackResult(row);
  }
}

function isBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (((error as Error & { code?: string }).code ?? "") === "SQLITE_BUSY" ||
      /database is (?:locked|busy)/i.test(error.message))
  );
}

const CLAIM_RETRY_WINDOW_MS = 5_000;
const CLAIM_RETRY_DELAY_MS = 10;
const claimRetrySignal = new Int32Array(new SharedArrayBuffer(4));
const releasedRunClaims = new Map<string, SyncRunResult>();

export class SyncStore {
  constructor(private readonly sqlite: Database, private readonly ownerAlive: (owner: SyncRunResult) => boolean = syncOwnerAlive) {
  }

  revisions(): RevisionSnapshot {
    const row = this.sqlite
      .query(
        `SELECT data_revision, config_revision, config_fingerprint
           FROM sync_revisions WHERE id = 1`
      )
      .get() as RevisionRow | null;
    if (!row) throw new Error("sync_revisions is not initialized; run bun run db:migrate");
    const vendors = emptyVendorRevisions();
    const rows = this.sqlite
      .query("SELECT vendor, data_revision FROM vendor_sync_revisions")
      .all() as Array<{ vendor: string; data_revision: number }>;
    for (const item of rows) {
      if (VENDOR_IDS.some((vendor) => vendor === item.vendor)) {
        vendors[item.vendor as VendorId] = item.data_revision;
      }
    }
    return { data: row.data_revision, config: row.config_revision, vendors };
  }

  configurationFingerprint(): string {
    const row = this.sqlite
      .query("SELECT config_fingerprint FROM sync_revisions WHERE id = 1")
      .get() as { config_fingerprint: string } | null;
    if (!row) throw new Error("sync_revisions is not initialized; run bun run db:migrate");
    return row.config_fingerprint;
  }

  sourceBookmark(vendor: VendorId): string | null {
    try {
      const row = this.sqlite
        .query("SELECT value FROM meta WHERE key = ?")
        .get(`sync_source_fingerprint:${vendor}`) as { value: string } | null;
      return row?.value ?? null;
    } catch (error) {
      if (String(error).includes("no such table")) return null;
      throw error;
    }
  }

  completedReparseVendors(generation:number,configuration:string):Map<VendorId,SyncRunResult["vendors"][number]> {
    const completed=new Map<VendorId,SyncRunResult["vendors"][number]>();
    const rows=this.sqlite.query(`SELECT result_json FROM sync_runs
      WHERE json_extract(CASE WHEN json_valid(result_json) THEN result_json END,'$.rebuildGeneration')=?
        AND json_extract(CASE WHEN json_valid(result_json) THEN result_json END,'$.rebuildConfiguration')=?
      ORDER BY started_at DESC`).all(generation,configuration) as {result_json:string}[];
    for(const row of rows) {
      const run=JSON.parse(row.result_json) as SyncRunResult;
      for(const vendor of run.vendors) {
        const reparse=vendor.diagnostics?.reparse as {unavailable?:unknown[]}|undefined;
        const unavailableInputs=vendor.diagnostics?.unavailableInputs;
        // A successful incremental sync can still have required inputs left to reread.
        const evidenceComplete=!reparse?.unavailable?.length
          && (!Array.isArray(unavailableInputs) || unavailableInputs.length===0);
        // A reduced run samples its diagnostics, so absent evidence is not proof:
        // completeness then has to come from the flag the reduction keeps intact.
        const sampled=run.truncated===true || vendor.diagnostics?.truncated===true;
        const complete=vendor.inputsComplete===undefined
          ? !sampled && evidenceComplete
          : vendor.inputsComplete && evidenceComplete;
        if(vendor.status==="success" && complete && !completed.has(vendor.vendor))
          completed.set(vendor.vendor,{...vendor,diagnostics:{...vendor.diagnostics,resumedFromRun:run.runId}});
      }
    }
    return completed;
  }

  saveSourceBookmark(vendor: VendorId, fingerprint: string): void {
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    this.sqlite
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(`sync_source_fingerprint:${vendor}`, fingerprint);
  }

  clearSourceBookmark(vendor: VendorId): void {
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    this.sqlite.query("DELETE FROM meta WHERE key = ?").run(`sync_source_fingerprint:${vendor}`);
  }

  observeConfig(fingerprint: string, now: string): RevisionSnapshot {
    return this.observeConfigDomains(fingerprint, {}, now);
  }

  configDomainFingerprint(domain: ConfigDomain): string | null {
    try {
      const row = this.sqlite
        .query("SELECT value FROM meta WHERE key = ?")
        .get(`sync_config_fingerprint:${domain}`) as { value: string } | null;
      return row?.value ?? null;
    } catch (error) {
      if (String(error).includes("no such table")) return null;
      throw error;
    }
  }

  observeConfigDomains(
    fingerprint: string,
    domainFingerprints: Partial<Record<ConfigDomain, string>>,
    now: string
  ): RevisionSnapshot {
    this.sqlite.transaction(() => {
      const row = this.sqlite
        .query("SELECT config_fingerprint FROM sync_revisions WHERE id = 1")
        .get() as { config_fingerprint: string } | null;
      if (!row) throw new Error("sync_revisions is not initialized; run bun run db:migrate");
      if (row.config_fingerprint === fingerprint) return;
      this.sqlite
        .query(
          `UPDATE sync_revisions
              SET config_revision = config_revision + 1,
                  config_fingerprint = ?, updated_at = ?
            WHERE id = 1`
        )
        .run(fingerprint, now);
      this.sqlite.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
      const save = this.sqlite.query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      for (const [domain, value] of Object.entries(domainFingerprints)) {
        if (value != null) save.run(`sync_config_fingerprint:${domain}`, value);
      }
    }).immediate();
    return this.revisions();
  }

  seedConfigDomainFingerprints(domainFingerprints: Partial<Record<ConfigDomain, string>>): void {
    this.sqlite.transaction(() => {
      this.sqlite.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
      const save = this.sqlite.query(
        `INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`
      );
      for (const [domain, value] of Object.entries(domainFingerprints)) {
        if (value != null) save.run(`sync_config_fingerprint:${domain}`, value);
      }
    }).immediate();
  }

  advanceDataInTransaction(vendor: VendorId, now: string): RevisionSnapshot {
    this.sqlite
      .query("UPDATE sync_revisions SET data_revision = data_revision + 1, updated_at = ? WHERE id = 1")
      .run(now);
    return this.advanceVendorInTransaction(vendor, now);
  }

  // Vendor-only bump: rollup coverage keys on the global data revision, so a
  // vendor whose rows never feed rollups (gauges) must not move it.
  advanceVendorInTransaction(vendor: VendorId, now: string): RevisionSnapshot {
    this.sqlite
      .query(
        `INSERT INTO vendor_sync_revisions (vendor, data_revision, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(vendor) DO UPDATE SET
           data_revision = vendor_sync_revisions.data_revision + 1,
           updated_at = excluded.updated_at`
      )
      .run(vendor, now);
    return this.revisions();
  }

  claimRun(result: SyncRunResult): { run: SyncRunResult; claimed: boolean } {
    const deadline = Date.now() + CLAIM_RETRY_WINDOW_MS;
    for (;;) {
      try {
        return this.tryClaimRun(result);
      } catch (error) {
        if (!isBusyError(error)) throw error;
        try {
          const active = this.activeRun();
          if (active) return { run: active, claimed: false };
        } catch (readError) {
          if (!isBusyError(readError)) throw readError;
        }
        if (Date.now() >= deadline) throw error;
        Atomics.wait(claimRetrySignal, 0, 0, CLAIM_RETRY_DELAY_MS);
      }
    }
  }

  private tryClaimRun(result: SyncRunResult): { run: SyncRunResult; claimed: boolean } {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const rebuilding = rebuildBlockingSync(this.sqlite);
      if (rebuilding !== null && result.rebuildGeneration !== rebuilding)
        throw new Error("Synchronization deferred until rebuild source verification completes");
      const active = this.activeRun();
      if (active) {
        this.sqlite.exec("COMMIT");
        return { run: active, claimed: false };
      }
      this.insertRunRow(result);
      this.sqlite.exec("COMMIT");
      return { run: result, claimed: true };
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // The original claim error is the useful one.
      }
      const active = this.activeRun();
      if (active) return { run: active, claimed: false };
      throw error;
    }
  }

  private insertRunRow(result: SyncRunResult): void {
    const scope = canonicalScope(result.scope);
    const vendor = scope.kind === "accounts"
      ? JSON.stringify(scope.meters === undefined ? scope.accounts : { accounts: scope.accounts, meters: scope.meters })
      : scope.kind === "vendors" ? JSON.stringify(scope.vendors) : scope.kind === "vendor" ? scope.vendor : null;
    // Preserve the selector even if an interrupted write has no result payload.
    const storedScope = scope.kind;
    this.sqlite
      .query(
        `INSERT INTO sync_runs (
           run_id, trigger, scope, vendor, mode, status, started_at, finished_at,
           before_data_revision, after_data_revision,
           before_config_revision, after_config_revision, result_json, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.runId,
        result.trigger,
        storedScope,
        vendor,
        result.mode,
        result.status,
        result.startedAt,
        result.finishedAt,
        result.beforeRevisions.data,
        result.afterRevisions.data,
        result.beforeRevisions.config,
        result.afterRevisions.config,
        serializedRun(result),
        result.error
      );
  }

  saveRun(result: SyncRunResult): void {
    this.sqlite
      .query(
        `UPDATE sync_runs SET
           status = ?, finished_at = ?, after_data_revision = ?,
           after_config_revision = ?, result_json = ?, error = ?
         WHERE run_id = ?`
      )
      .run(
        result.status,
        result.finishedAt,
        result.afterRevisions.data,
        result.afterRevisions.config,
        serializedRun(result),
        result.error,
        result.runId
      );
  }

  saveRunWithBusyRetry(result: SyncRunResult): void {
    const deadline = Date.now() + CLAIM_RETRY_WINDOW_MS;
    for (;;) {
      try {
        this.saveRun(result);
        return;
      } catch (error) {
        if (!isBusyError(error) || Date.now() >= deadline) throw error;
        Atomics.wait(claimRetrySignal, 0, 0, CLAIM_RETRY_DELAY_MS);
      }
    }
  }

  releaseRunClaim(result: SyncRunResult): void {
    releasedRunClaims.set(result.runId, result);
  }

  activeRun(): SyncRunResult | null {
    const row = this.sqlite
      .query("SELECT * FROM sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
      .get() as StoredRunRow | null;
    return row ? parseStoredRun(row) : null;
  }

  latestRun(): SyncRunResult | null {
    // The newest run is found from the keys alone. Ordering whole rows sorted every stored
    // result, hundreds of megabytes of JSON, on each status poll.
    const row = this.sqlite
      .query("SELECT * FROM sync_runs WHERE rowid = (SELECT rowid FROM sync_runs ORDER BY started_at DESC LIMIT 1)")
      .get() as StoredRunRow | null;
    return row ? parseStoredRun(row) : null;
  }

  runById(runId: string): SyncRunResult | null {
    const row = this.sqlite
      .query("SELECT * FROM sync_runs WHERE run_id = ?")
      .get(runId) as StoredRunRow | null;
    return row ? parseStoredRun(row) : null;
  }

  recoverInterrupted(now: string): SyncRunResult[] {
    const rows = this.sqlite
      .query("SELECT * FROM sync_runs WHERE status = 'running' ORDER BY started_at")
      .all() as StoredRunRow[];
    const recovered: SyncRunResult[] = [];
    for (const row of rows) {
      const released = releasedRunClaims.get(row.run_id);
      const inspected = released ?? parseStoredRun(row);
      if (!released && this.ownerAlive(inspected)) continue;
      // The owner may have committed its last results while its process was being inspected.
      const result = this.sqlite.transaction(() => {
        const current = this.sqlite.query("SELECT * FROM sync_runs WHERE run_id = ?").get(row.run_id) as StoredRunRow | null;
        if (!current || current.status !== "running") return null;
        const latest = parseStoredRun(current);
        if (!released && (latest.ownerPid !== inspected.ownerPid || latest.ownerProcessStart !== inspected.ownerProcessStart
          || latest.startedAt !== inspected.startedAt)) return null;
        const result = released ?? latest;
        let interrupted = false;
        if (!released) {
          for (const vendor of result.vendors) {
            if (vendor.status !== "pending") continue;
            interrupted = true;
            vendor.status = "failure";
            vendor.error = "Sync interrupted by process shutdown";
            vendor.finishedAt = now;
          }
          const successes = result.vendors.filter((vendor) => vendor.status === "success").length;
          const failures = result.vendors.filter((vendor) => vendor.status === "failure").length;
          result.status = failures === 0 ? "success" : successes === 0 ? "failure" : "partial_success";
          result.finishedAt = now;
          const errors = result.vendors.filter((vendor) => vendor.error).map((vendor) => `${vendor.vendor}: ${vendor.error}`);
          const onlyInterruptionErrors = result.vendors.filter((vendor) => vendor.error)
            .every((vendor) => vendor.error === "Sync interrupted by process shutdown");
          result.error = interrupted && onlyInterruptionErrors ? "Sync interrupted by process shutdown"
            : errors.length > 0 ? errors.join("; ") : null;
        }
        this.saveRun(result);
        return result;
      }).immediate();
      releasedRunClaims.delete(row.run_id);
      if (result) recovered.push(result);
    }
    return recovered;
  }
}

export function recoverInterruptedSyncRuns(sqlite: Database, now = new Date().toISOString()): number {
  try {
    return new SyncStore(sqlite).recoverInterrupted(now).length;
  } catch (error) {
    if (String(error).includes("no such table")) return 0;
    throw error;
  }
}
