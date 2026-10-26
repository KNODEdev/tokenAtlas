import { Database } from "./sqlite";
import { readRebuildStatusJson } from "./rebuild-status";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_ROOT, atlasIndexSnapshotPool } from "../config/paths";
import { applyDrizzleMigrations } from "./migrate";
import { rebaseArchivePaths, type ArchiveRebaseResult } from "./rebase";
import * as schema from "./schema";
import { AtlasSnapshotDiscoveryError, type AtlasIndexSnapshotManifest, type AtlasSnapshotCandidate } from "./snapshot-contracts";
import { currentAtlasSchemaVersion } from "./snapshot-schema";
import { discoverAtlasSnapshotCandidates } from "./snapshot-discovery";
import { validateAtlasSnapshotFiles } from "./snapshot-validation";

export type AtlasBootstrapStage =
  | "local-check"
  | "snapshot-discovery"
  | "snapshot-validation"
  | "snapshot-installation"
  | "migration"
  | "path-rebase"
  | "incremental-catch-up"
  | "full-ingest-fallback"
  | "complete";

export interface AtlasBootstrapAttempt {
  snapshotId: string | null;
  accepted: boolean;
  stage: AtlasBootstrapFailureStage | null;
  code: AtlasBootstrapReasonCode | null;
  reason: string | null;
}

export type AtlasBootstrapFailureStage =
  | "discovery"
  | "validation"
  | "copy"
  | "migration"
  | "rebase"
  | "integrity"
  | "installation";

export type AtlasBootstrapReasonCode =
  | "snapshot-pool-read-failed"
  | "snapshot-validation-failed"
  | "snapshot-copy-failed"
  | "snapshot-migration-failed"
  | "snapshot-rebase-failed"
  | "snapshot-integrity-failed"
  | "snapshot-installation-failed";

export interface AtlasBootstrapResult {
  status: "local-ready" | "snapshot-installed" | "full-ingest-required";
  selectedSnapshotId: string | null;
  attempts: AtlasBootstrapAttempt[];
  catchUpMode: "incremental" | "full" | null;
  rebase: ArchiveRebaseResult | null;
}

const RECOVERY_KEY = "atlas_bootstrap_recovery_id";
const EMPTY_READY_KEY = "atlas_bootstrap_empty_ready";
const RECOVERY_VENDORS_KEY = "atlas_bootstrap_recovery_vendors";
const LEGACY_REVIEWED_KEY = "atlas_bootstrap_legacy_reviewed";

function coversWholeVendor(scope:{kind?:string;vendor?:string;vendors?:string[]}|undefined,vendor:string):boolean {
  return scope?.kind === "all" || scope?.kind === "vendor" && scope.vendor === vendor
    || scope?.kind === "vendors" && Array.isArray(scope.vendors) && scope.vendors.includes(vendor);
}

/** A complete, unbounded manual source rebuild can prove old bootstrap gaps closed. */
function completedManualHistory(sqlite:Database,failedAt:string,vendors:readonly string[]):Set<string> {
  const completed=new Set<string>();
  const failedAtMs=Date.parse(failedAt);
  if(!vendors.length||!Number.isFinite(failedAtMs))return completed;
  const json=readRebuildStatusJson(sqlite);
  if(!json)return completed;
  try {
    const job=JSON.parse(json) as {state?:string;scope?:string;range?:unknown;accounts?:unknown;vendors?:string[];
      generation?:number;requestedAt?:string;report?:{generation?:number;lastRecordedSourceRunId?:string}};
    if(job.state!=="complete"||job.scope!=="all"||job.range!==null
      || job.accounts!=null && (!Array.isArray(job.accounts)||job.accounts.length>0)
      || !Number.isSafeInteger(job.generation)||job.report?.generation!==job.generation
      || typeof job.requestedAt!=="string"||!Number.isFinite(Date.parse(job.requestedAt))
      || Date.parse(job.requestedAt)<=failedAtMs
      || typeof job.report?.lastRecordedSourceRunId!=="string")return completed;
    const receipt=sqlite.query("SELECT result_json FROM sync_runs WHERE run_id=?")
      .get(job.report.lastRecordedSourceRunId) as {result_json:string|null}|null;
    if(!receipt?.result_json)return completed;
    const run=JSON.parse(receipt.result_json) as {status?:string;rebuildGeneration?:number;scope?:{kind?:string;vendor?:string;vendors?:string[]};
      vendors?:Array<{vendor?:string;status?:string;inputsComplete?:boolean}>};
    if(run.status!=="success"||run.rebuildGeneration!==job.generation)return completed;
    for(const vendor of vendors) {
      if(job.vendors && (!Array.isArray(job.vendors)||!job.vendors.includes(vendor)))continue;
      if(!coversWholeVendor(run.scope,vendor))continue;
      if(run.vendors?.some(outcome=>outcome.vendor===vendor&&outcome.status==="success"&&outcome.inputsComplete===true))
        completed.add(vendor);
    }
  } catch { /* Incomplete or unreadable evidence cannot discharge a historical gap. */ }
  return completed;
}

export function pendingAtlasBootstrapRecovery(dbPath: string, currentSchemaVersion = currentAtlasSchemaVersion()): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true, strict: true });
    if (!tableExists(sqlite, "meta")) return null;
    const row = sqlite.query("SELECT value FROM meta WHERE key=?").get(RECOVERY_KEY) as {value:string}|null;
    return row?.value && migrationVersion(sqlite) === currentSchemaVersion ? row.value : null;
  } catch { return null; }
  finally { sqlite?.close(true); }
}

export function pendingAtlasBootstrapVendors(dbPath: string): string[] | null {
  const sqlite = new Database(dbPath, { readonly: true, strict: true });
  try {
    const row = sqlite.query("SELECT value FROM meta WHERE key=?").get(RECOVERY_VENDORS_KEY) as {value:string}|null;
    const parsed = row ? JSON.parse(row.value) : null;
    return Array.isArray(parsed) && parsed.every(value => typeof value === "string") ? parsed : null;
  } finally { sqlite.close(true); }
}

function resumePartialAutomaticBootstrap(dbPath: string): string | null {
  const sqlite = new Database(dbPath);
  try {
    if (rowExists(sqlite, "meta", `key = '${EMPTY_READY_KEY}'`)) return null;
    const priorReview = sqlite.query("SELECT value FROM meta WHERE key=?").get(LEGACY_REVIEWED_KEY) as {value:string}|null;
    // Version 1 incorrectly accepted a small ordinary incremental receipt as
    // proof that a failed full historical import had recovered.
    if (priorReview?.value === "2") return null;
    if (!tableExists(sqlite, "sync_runs")) return null;
    const reviewed = () => sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(LEGACY_REVIEWED_KEY, "2");
    const row = sqlite.query("SELECT started_at,finished_at,result_json FROM sync_runs WHERE trigger='auto' AND mode='full' ORDER BY started_at DESC LIMIT 1")
      .get() as {started_at:string;finished_at:string|null;result_json:string|null}|null;
    if (!row?.result_json) { reviewed(); return null; }
    const result = JSON.parse(row.result_json) as {status?:string;vendors?:Array<{vendor?:string;status?:string;inputsComplete?:boolean}>};
    if (!Array.isArray(result.vendors)) { reviewed(); return null; }
    const vendors = [...new Set(result.vendors.filter(vendor => vendor.status !== "success" || vendor.inputsComplete !== true)
      .map(vendor => vendor.vendor).filter((vendor):vendor is string=>typeof vendor === "string"))];
    for (const later of sqlite.query("SELECT mode,result_json FROM sync_runs WHERE started_at>? AND status<>'running' ORDER BY started_at")
      .iterate(row.started_at) as Iterable<{mode:string;result_json:string|null}>) {
      if (later.mode !== "full") continue;
      if (!later.result_json) continue;
      try {
        const completed = JSON.parse(later.result_json) as typeof result & {scope?:{kind?:string;vendor?:string;vendors?:string[]}};
        for (const vendor of completed.vendors??[]) {
          const index = vendors.indexOf(vendor.vendor ?? "");
          const selected = coversWholeVendor(completed.scope,vendor.vendor ?? "");
          if (index >= 0 && selected && vendor.status === "success" && vendor.inputsComplete === true)
            vendors.splice(index, 1);
        }
      } catch { /* An unreadable receipt cannot prove recovery. */ }
      if (!vendors.length) break;
    }
    for(const vendor of completedManualHistory(sqlite,row.finished_at??row.started_at,vendors))
      vendors.splice(vendors.indexOf(vendor),1);
    if (!vendors.length) { reviewed(); return null; }
    const id = crypto.randomUUID();
    sqlite.transaction(() => {
      sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(RECOVERY_KEY, id);
      sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(RECOVERY_VENDORS_KEY, JSON.stringify(vendors));
    }).immediate();
    return id;
  } catch { return null; }
  finally { sqlite.close(true); }
}

export function finishAtlasBootstrapRecovery(sqlite: Database, id: string): void {
  sqlite.transaction(() => {
    const removed = sqlite.query("DELETE FROM meta WHERE key=? AND value=?").run(RECOVERY_KEY, id);
    if (removed.changes) sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(EMPTY_READY_KEY, "1");
    if (removed.changes) sqlite.query("DELETE FROM meta WHERE key=?").run(RECOVERY_VENDORS_KEY);
  }).immediate();
}

export interface BootstrapAtlasIndexOptions {
  localDbPath: string;
  archiveRoot?: string;
  poolPath?: string;
  migrationsFolder?: string;
  currentSchemaVersion?: number;
  onStage?: (stage: AtlasBootstrapStage, message: string) => void;
  failpoints?: AtlasBootstrapFailpoints;
}

export interface AtlasBootstrapFailpoints {
  beforeCandidateCopy?: () => void;
  beforeCandidateMigration?: () => void;
  beforeCandidateRebase?: () => void;
  beforeCandidateIntegrity?: () => void;
  beforeFinalSwap?: () => void;
  afterBackupRename?: () => void;
  afterInstallRename?: () => void;
  duringBackupCleanup?: () => void;
}

export class AtlasBootstrapCrashSimulation extends Error {
  constructor() {
    super("Simulated Atlas bootstrap interruption");
    this.name = "AtlasBootstrapCrashSimulation";
  }
}

const LOCAL_DATA_TABLES = [
  "events",
  "ratelimit",
  "claude_events",
  "oc_events",
  "grok_events",
  "gemini_events",
] as const;

const LOCAL_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  meta: ["key", "value"],
  files: ["home", "path"],
  events: ["home", "path", "ts", "cwd", "project_id"],
  ratelimit: ["home", "path", "ts"],
  claude_events: ["store", "path", "ts", "cwd", "project"],
  claude_files: ["store", "path"],
  oc_events: ["store", "ts", "directory", "project"],
  grok_events: ["store", "path", "ts", "cwd", "project"],
  grok_files: ["store", "path"],
  gemini_events: ["store", "path", "ts", "workspace"],
  gemini_files: ["store", "path"],
};

function integrityOk(sqlite: Database): boolean {
  const statement = sqlite.prepare("PRAGMA integrity_check");
  try {
    const rows = statement.all() as Array<Record<string, unknown>>;
    return rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
  } catch {
    return false;
  } finally {
    statement.finalize();
  }
}

function tableExists(sqlite: Database, table: string): boolean {
  const statement = sqlite.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?");
  try {
    const row = statement.get(table) as { present: number } | null;
    return row?.present === 1;
  } finally {
    statement.finalize();
  }
}

function tableHasColumns(sqlite: Database, table: string, required: readonly string[]): boolean {
  const statement = sqlite.prepare(`PRAGMA table_info("${table}")`);
  try {
    const columns = new Set((statement.all() as Array<{ name: string }>).map((column) => column.name));
    return required.every((column) => columns.has(column));
  } finally {
    statement.finalize();
  }
}

function migrationVersion(sqlite: Database): number {
  if (!tableExists(sqlite, "__drizzle_migrations")) return -1;
  const statement = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations");
  try {
    const row = statement.get() as { n: number } | null;
    return (row?.n ?? 0) - 1;
  } finally {
    statement.finalize();
  }
}

/** Server startup must not mistake an existing database awaiting migration for a
 * damaged index and replace it from an older snapshot or an empty fallback. */
export function assertExistingAtlasSchemaCurrent(
  dbPath: string,
  currentSchemaVersion = currentAtlasSchemaVersion(),
): void {
  const existingPath = fs.existsSync(dbPath) ? dbPath : installBackupPath(dbPath);
  if (!fs.existsSync(existingPath) || fs.statSync(existingPath).size === 0) return;
  const sqlite = new Database(existingPath, { readonly: true, strict: true });
  try {
    const installed = migrationVersion(sqlite);
    if (installed < 0) throw new Error("Existing Atlas database has no migration history; recover it explicitly before server startup");
    if (installed !== currentSchemaVersion) {
      throw new Error(`Atlas schema ${installed} requires migration to ${currentSchemaVersion} before server startup`);
    }
  } finally {
    sqlite.close(true);
  }
}

function rowExists(sqlite: Database, table: string, predicate: string): boolean {
  const statement = sqlite.prepare(`SELECT 1 AS present FROM "${table}" WHERE ${predicate} LIMIT 1`);
  try {
    return (statement.get() as { present: number } | null)?.present === 1;
  } finally {
    statement.finalize();
  }
}

export function localAtlasIndexUsable(
  dbPath: string,
  currentSchemaVersion = currentAtlasSchemaVersion(),
): boolean {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return false;
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true, strict: true });
    // Startup checks schema and readability only. A full integrity_check walks
    // every page and index in multi-GB databases before HTTP can start. Keep
    // that validation on snapshot installation, where the database is replaced.
    const installedVersion = migrationVersion(sqlite);
    if (installedVersion < 0 || installedVersion > currentSchemaVersion) return false;
    for (const [table, columns] of Object.entries(LOCAL_REQUIRED_COLUMNS)) {
      if (!tableHasColumns(sqlite, table, columns)) return false;
    }
    if (installedVersion >= 13) {
      if (!tableHasColumns(sqlite, "sync_revisions", ["id", "data_revision", "config_revision"])) return false;
      if (!tableHasColumns(sqlite, "vendor_sync_revisions", ["vendor", "data_revision"])) return false;
      if (!rowExists(sqlite, "sync_revisions", "id = 1")) return false;
    }
    // Summary coverage existed from migration 14 until the ledgers replaced it (0054_ledger_sums).
    if (installedVersion >= 14 && installedVersion < 54) {
      if (!tableHasColumns(sqlite, "rollup_coverage", ["id", "derived_revision"])) return false;
      if (!rowExists(sqlite, "rollup_coverage", "id = 1")) return false;
    }
    for (const table of LOCAL_DATA_TABLES) {
      if (!tableExists(sqlite, table)) continue;
      if (rowExists(sqlite, table, "1 = 1")) return true;
    }
    if (tableExists(sqlite, "meta") && rowExists(sqlite, "meta", `key = '${EMPTY_READY_KEY}'`)) return true;
    return false;
  } catch {
    return false;
  } finally {
    sqlite?.close();
  }
}

function applyMigrations(dbPath: string, migrationsFolder?: string): void {
  const sqlite = new Database(dbPath, { create: true });
  try {
    sqlite.exec("PRAGMA journal_mode = DELETE");
    sqlite.exec("PRAGMA synchronous = FULL");
    applyDrizzleMigrations(drizzle(sqlite, { schema }), migrationsFolder);
  } finally {
    // Drizzle owns uncached prepared statements. Finish them before a bootstrap
    // rename/delete; close(false) can retain the file handle until a later GC.
    sqlite.close(true);
  }
}

function initializeActiveAtlasCore(dbPath: string): void {
  const sqlite = new Database(dbPath, { create: true });
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (
        home TEXT, path TEXT, size INTEGER, mtime REAL, events INTEGER,
        PRIMARY KEY (home, path)
      );
      CREATE TABLE IF NOT EXISTS events (
        home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT,
        model TEXT, effort TEXT, project TEXT,
        in_tok INTEGER, cached_in INTEGER, cache_write INTEGER,
        out_tok INTEGER, reasoning_out INTEGER, cwd TEXT, project_id TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(home, ts);
      CREATE INDEX IF NOT EXISTS events_path ON events(home, path);
      CREATE INDEX IF NOT EXISTS events_project_id ON events(project_id);
      CREATE TABLE IF NOT EXISTS ratelimit (
        home TEXT, path TEXT, ts TEXT, window_minutes INTEGER,
        used_percent REAL, resets_at INTEGER, plan_type TEXT,
        limit_id TEXT, limit_name TEXT
      );
      CREATE INDEX IF NOT EXISTS rl_ts ON ratelimit(home, limit_id, window_minutes, ts);
      CREATE INDEX IF NOT EXISTS rl_path ON ratelimit(home, path);
    `);
  } finally {
    sqlite.close();
  }
}

function removeIfPresent(filePath: string): void {
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
}

function moveIfPresent(source: string, destination: string): void {
  if (fs.existsSync(source)) fs.renameSync(source, destination);
}

class AtlasBootstrapStageError extends Error {
  constructor(
    readonly stage: AtlasBootstrapFailureStage,
    readonly code: AtlasBootstrapReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "AtlasBootstrapStageError";
  }
}

function stageFailure(
  stage: AtlasBootstrapFailureStage,
  code: AtlasBootstrapReasonCode,
  reason: string,
  operation: () => void,
): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof AtlasBootstrapCrashSimulation || error instanceof AtlasBootstrapStageError) throw error;
    throw new AtlasBootstrapStageError(stage, code, reason);
  }
}

function installBackupPath(localDbPath: string): string {
  return `${localDbPath}.bootstrap-backup`;
}

function cleanupInstallBackup(backupPath: string): void {
  removeIfPresent(backupPath);
  removeIfPresent(`${backupPath}-wal`);
  removeIfPresent(`${backupPath}-shm`);
}

function recoverInterruptedInstall(localDbPath: string): void {
  const backupPath = installBackupPath(localDbPath);
  if (!fs.existsSync(backupPath)) return;
  if (!fs.existsSync(localDbPath)) {
    fs.renameSync(backupPath, localDbPath);
    moveIfPresent(`${backupPath}-wal`, `${localDbPath}-wal`);
    moveIfPresent(`${backupPath}-shm`, `${localDbPath}-shm`);
    return;
  }
  try {
    cleanupInstallBackup(backupPath);
  } catch {
    // The installed database is already committed; a later startup can retry stale-backup cleanup.
  }
}

function syncDatabaseFile(dbPath: string): void {
  const descriptor = fs.openSync(dbPath, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicInstall(
  preparedPath: string,
  localDbPath: string,
  failpoints?: AtlasBootstrapFailpoints,
): void {
  recoverInterruptedInstall(localDbPath);
  const backupPath = installBackupPath(localDbPath);
  const hadLocal = fs.existsSync(localDbPath);
  let installed = false;
  try {
    if (hadLocal) fs.renameSync(localDbPath, backupPath);
    moveIfPresent(`${localDbPath}-wal`, `${backupPath}-wal`);
    moveIfPresent(`${localDbPath}-shm`, `${backupPath}-shm`);
    failpoints?.afterBackupRename?.();
    fs.renameSync(preparedPath, localDbPath);
    installed = true;
    failpoints?.afterInstallRename?.();
  } catch (error) {
    if (error instanceof AtlasBootstrapCrashSimulation) throw error;
    if (installed) {
      removeIfPresent(localDbPath);
      removeIfPresent(`${localDbPath}-wal`);
      removeIfPresent(`${localDbPath}-shm`);
    }
    if (hadLocal) fs.renameSync(backupPath, localDbPath);
    moveIfPresent(`${backupPath}-wal`, `${localDbPath}-wal`);
    moveIfPresent(`${backupPath}-shm`, `${localDbPath}-shm`);
    throw error;
  }
  try {
    failpoints?.duringBackupCleanup?.();
    cleanupInstallBackup(backupPath);
  } catch {
    // Backup cleanup happens after the commit point and is recoverable on the next startup.
  }
}

function installCandidate(
  candidate: AtlasSnapshotCandidate & { manifest: AtlasIndexSnapshotManifest },
  options: BootstrapAtlasIndexOptions,
  archiveRoot: string,
  currentSchemaVersion: number,
): ArchiveRebaseResult {
  const directory = path.dirname(options.localDbPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const preparedPath = `${options.localDbPath}.bootstrap-${crypto.randomUUID()}.tmp`;
  try {
    stageFailure("copy", "snapshot-copy-failed", "Snapshot copy failed", () => {
      options.failpoints?.beforeCandidateCopy?.();
      fs.copyFileSync(candidate.databasePath, preparedPath, fs.constants.COPYFILE_EXCL);
      const copied = validateAtlasSnapshotFiles(preparedPath, candidate.manifest, { currentSchemaVersion });
      if (!copied.valid || !copied.compatible) throw new Error("copy validation failed");
    });
    options.onStage?.("migration", "Migrating the prepared Atlas snapshot");
    stageFailure("migration", "snapshot-migration-failed", "Snapshot migration failed", () => {
      options.failpoints?.beforeCandidateMigration?.();
      applyMigrations(preparedPath, options.migrationsFolder);
    });
    options.onStage?.("path-rebase", "Rebasing archive-owned paths in the prepared snapshot");
    let rebaseResult: ArchiveRebaseResult;
    try {
      options.failpoints?.beforeCandidateRebase?.();
      const sqlite = new Database(preparedPath);
      try {
        rebaseResult = rebaseArchivePaths(sqlite, candidate.manifest.sourceArchiveRoot, archiveRoot);
      } finally {
        sqlite.close();
      }
    } catch (error) {
      if (error instanceof AtlasBootstrapCrashSimulation) throw error;
      throw new AtlasBootstrapStageError("rebase", "snapshot-rebase-failed", "Snapshot path rebase failed");
    }
    stageFailure("integrity", "snapshot-integrity-failed", "Prepared snapshot integrity check failed", () => {
      options.failpoints?.beforeCandidateIntegrity?.();
      const reopened = new Database(preparedPath, { readonly: true, strict: true });
      try {
        if (!integrityOk(reopened)) throw new Error("integrity check failed");
      } finally {
        reopened.close();
      }
      syncDatabaseFile(preparedPath);
    });
    stageFailure("installation", "snapshot-installation-failed", "Snapshot installation failed", () => {
      options.failpoints?.beforeFinalSwap?.();
      atomicInstall(preparedPath, options.localDbPath, options.failpoints);
    });
    return rebaseResult;
  } finally {
    try {
      removeIfPresent(preparedPath);
    } catch {
    }
  }
}

function installEmptyFallback(options: BootstrapAtlasIndexOptions): void {
  const directory = path.dirname(options.localDbPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const workingPath = `${options.localDbPath}.bootstrap-work-${crypto.randomUUID()}.tmp`;
  const preparedPath = `${options.localDbPath}.bootstrap-${crypto.randomUUID()}.tmp`;
  try {
    options.onStage?.("migration", "Preparing a migrated empty Atlas index");
    initializeActiveAtlasCore(workingPath);
    applyMigrations(workingPath, options.migrationsFolder);
    const writable = new Database(workingPath);
    try { writable.query("INSERT INTO meta(key,value) VALUES(?,?)").run(RECOVERY_KEY, crypto.randomUUID()); }
    finally { writable.close(true); }
    const sqlite = new Database(workingPath, { readonly: true });
    try {
      if (!integrityOk(sqlite)) throw new Error("empty fallback database failed its integrity check");
    } finally {
      sqlite.close();
    }
    fs.copyFileSync(workingPath, preparedPath, fs.constants.COPYFILE_EXCL);
    syncDatabaseFile(preparedPath);
    atomicInstall(preparedPath, options.localDbPath, options.failpoints);
  } finally {
    try {
      removeIfPresent(preparedPath);
    } catch {
    }
    Bun.gc(true);
    try {
      removeIfPresent(workingPath);
    } catch {
    }
  }
}

export function bootstrapAtlasIndex(options: BootstrapAtlasIndexOptions): AtlasBootstrapResult {
  recoverInterruptedInstall(options.localDbPath);
  const currentSchemaVersion = options.currentSchemaVersion ?? currentAtlasSchemaVersion();
  options.onStage?.("local-check", "Checking the local Atlas index");
  const pendingRecovery = pendingAtlasBootstrapRecovery(options.localDbPath, currentSchemaVersion);
  if (pendingRecovery) {
    options.onStage?.("full-ingest-fallback", "Resuming archive recovery for the local Atlas index");
    return { status: "full-ingest-required", selectedSnapshotId: null, attempts: [], catchUpMode: "full", rebase: null };
  }
  if (localAtlasIndexUsable(options.localDbPath, currentSchemaVersion)) {
    if (resumePartialAutomaticBootstrap(options.localDbPath)) {
      options.onStage?.("full-ingest-fallback", "Resuming incomplete archive inputs in the existing Atlas index");
      return { status: "full-ingest-required", selectedSnapshotId: null, attempts: [], catchUpMode: "full", rebase: null };
    }
    options.onStage?.("complete", "The populated local Atlas index remains authoritative");
    return {
      status: "local-ready",
      selectedSnapshotId: null,
      attempts: [],
      catchUpMode: null,
      rebase: null,
    };
  }
  const archiveRoot = path.resolve(options.archiveRoot ?? ARCHIVE_ROOT);
  const poolPath = path.resolve(options.poolPath ?? atlasIndexSnapshotPool(options.localDbPath));
  options.onStage?.("snapshot-discovery", "Discovering local Atlas index snapshots");
  const attempts: AtlasBootstrapAttempt[] = [];
  let candidates: AtlasSnapshotCandidate[] = [];
  try {
    candidates = discoverAtlasSnapshotCandidates(poolPath, { currentSchemaVersion });
  } catch (error) {
    const reason = error instanceof AtlasSnapshotDiscoveryError
      ? "Atlas snapshot pool could not be read"
      : "Atlas snapshot discovery failed";
    attempts.push({
      snapshotId: null,
      accepted: false,
      stage: "discovery",
      code: "snapshot-pool-read-failed",
      reason,
    });
  }
  for (const candidate of candidates) {
    options.onStage?.("snapshot-validation", `Validating snapshot ${candidate.snapshotId}`);
    if (!candidate.valid || !candidate.compatible || !candidate.manifest) {
      attempts.push({
        snapshotId: candidate.snapshotId,
        accepted: false,
        stage: "validation",
        code: "snapshot-validation-failed",
        reason: candidate.errors[0] ?? "snapshot validation failed",
      });
      continue;
    }
    try {
      options.onStage?.("snapshot-installation", `Installing snapshot ${candidate.snapshotId}`);
      const rebase = installCandidate(
        candidate as AtlasSnapshotCandidate & { manifest: AtlasIndexSnapshotManifest },
        options,
        archiveRoot,
        currentSchemaVersion,
      );
      attempts.push({
        snapshotId: candidate.snapshotId,
        accepted: true,
        stage: null,
        code: null,
        reason: null,
      });
      options.onStage?.("incremental-catch-up", "The installed snapshot needs incremental catch-up");
      return {
        status: "snapshot-installed",
        selectedSnapshotId: candidate.snapshotId,
        attempts,
        catchUpMode: "incremental",
        rebase,
      };
    } catch (error) {
      if (error instanceof AtlasBootstrapCrashSimulation) throw error;
      const failure = error instanceof AtlasBootstrapStageError
        ? error
        : new AtlasBootstrapStageError("installation", "snapshot-installation-failed", "Snapshot installation failed");
      attempts.push({
        snapshotId: candidate.snapshotId,
        accepted: false,
        stage: failure.stage,
        code: failure.code,
        reason: failure.message,
      });
    }
  }
  options.onStage?.("full-ingest-fallback", "No snapshot was usable; preparing a full-ingest fallback");
  options.onStage?.("snapshot-installation", "Installing a clean empty Atlas index");
  installEmptyFallback(options);
  return {
    status: "full-ingest-required",
    selectedSnapshotId: null,
    attempts,
    catchUpMode: "full",
    rebase: null,
  };
}
