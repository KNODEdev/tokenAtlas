// Reports and, with `--apply`, reclaims the stores that grow without limit: abandoned sync
// stages and surplus index snapshots.
//
// What it must not touch: a stage whose run is still running, or whose run left no record and
// is younger than the orphan window, is kept. The newest validated snapshot is kept, because
// recovery reads it.
import fs from "node:fs";
import path from "node:path";
import { Database } from "../../src/db/sqlite";
import { resolveDbPath } from "../../src/db";
import { discoverAtlasSnapshotCandidates } from "../../src/db/snapshot-discovery";
import { RETAINED_VALIDATED_SNAPSHOTS } from "../../src/db/snapshot-retention";
import { stageRunIsDisposable } from "../../src/sync/staging";
import { SyncStore } from "../../src/sync/store";

const STAGE_ARTIFACT =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([a-z]+)\.sqlite(?:-wal|-shm|-journal)?$/i;

export interface RetentionOptions {
  apply?: boolean;
  now?: Date;
  /** Directory holding `sync-staging` and `atlas-index-snapshots`; defaults to the database's. */
  dataDir?: string;
}

export interface RetentionReport {
  stages: { files: number; bytes: number; disposableFiles: number; disposableBytes: number; removed: number };
  snapshots: { validated: number; surplus: number; surplusBytes: number; removed: number };
  applied: boolean;
}

export class SyncInProgressError extends Error {
  constructor() {
    super("A sync run is in progress; retention would compete with its writer. Retry when it has finished.");
    this.name = "SyncInProgressError";
  }
}

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}
function removeQuietly(file: string): boolean {
  try { fs.rmSync(file); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

interface StageGroup { runId: string; vendor: string; files: string[]; bytes: number; modifiedAtMs: number }

function stageGroups(stagingRoot: string): StageGroup[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(stagingRoot, { withFileTypes: true }); }
  catch { return []; }
  const groups = new Map<string, StageGroup>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = STAGE_ARTIFACT.exec(entry.name);
    if (!match) continue;
    const key = `${match[1]!}-${match[2]!}`;
    const group = groups.get(key) ?? { runId: match[1]!, vendor: match[2]!, files: [], bytes: 0, modifiedAtMs: 0 };
    const file = path.join(stagingRoot, entry.name);
    group.files.push(file);
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(file); } catch { stat = null; }
    group.bytes += stat?.size ?? 0;
    // An unreadable stat leaves the stage looking new, so ageing can only keep it.
    group.modifiedAtMs = Math.max(group.modifiedAtMs, stat?.mtimeMs ?? Date.now());
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function runRetention(sqlite: Database, dbPath: string, options: RetentionOptions = {}): RetentionReport {
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const dataDir = options.dataDir ?? path.dirname(path.resolve(dbPath));
  if (sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_runs'").get()
    && sqlite.query("SELECT 1 FROM sync_runs WHERE status='running' LIMIT 1").get()) {
    throw new SyncInProgressError();
  }
  const stagingRoot = path.join(dataDir, "sync-staging");
  const store = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_runs'").get()
    ? new SyncStore(sqlite) : null;
  const stages = { files: 0, bytes: 0, disposableFiles: 0, disposableBytes: 0, removed: 0 };
  for (const group of stageGroups(stagingRoot)) {
    stages.files += group.files.length;
    stages.bytes += group.bytes;
    let run = null;
    try { run = store?.runById(group.runId) ?? null; } catch { run = null; }
    // An unreadable run record proves nothing; treat it as present and running.
    if (!stageRunIsDisposable(run, group.modifiedAtMs, now.getTime())) continue;
    stages.disposableFiles += group.files.length;
    stages.disposableBytes += group.bytes;
    if (apply) for (const file of group.files) if (removeQuietly(file)) stages.removed += 1;
  }

  const poolPath = path.join(dataDir, "atlas-index-snapshots");
  const validated = discoverAtlasSnapshotCandidates(poolPath)
    .filter((candidate) => candidate.valid && candidate.compatible);
  const surplus = validated.slice(RETAINED_VALIDATED_SNAPSHOTS);
  const snapshots = {
    validated: validated.length, surplus: surplus.length,
    surplusBytes: surplus.reduce((bytes, candidate) => bytes + fileSize(candidate.databasePath), 0), removed: 0,
  };
  if (apply) for (const candidate of surplus) {
    // Removing the manifest first makes a partially deleted pair ineligible to readers.
    if (removeQuietly(candidate.manifestPath) && removeQuietly(candidate.barrierPath)
      && removeQuietly(candidate.databasePath)) snapshots.removed += 1;
  }

  return { stages, snapshots, applied: apply };
}

function megabytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const databasePath = resolveDbPath(value("--db"));
  const apply = args.includes("--apply");
  const vacuum = args.includes("--vacuum");
  if (vacuum && !apply) {
    console.error("--vacuum rewrites the database and only runs together with --apply.");
    process.exit(1);
  }
  const sqlite = new Database(databasePath, apply ? { readwrite: true } : { readonly: true });
  try {
    const report = runRetention(sqlite, databasePath, { apply });
    console.log(`Database: ${path.resolve(databasePath)}`);
    console.log(`Sync stages: ${report.stages.files} file(s), ${megabytes(report.stages.bytes)}; `
      + `disposable ${report.stages.disposableFiles} (${megabytes(report.stages.disposableBytes)}); removed ${report.stages.removed}`);
    console.log(`Index snapshots: ${report.snapshots.validated} validated, keeping ${RETAINED_VALIDATED_SNAPSHOTS}; `
      + `surplus ${report.snapshots.surplus} (${megabytes(report.snapshots.surplusBytes)}); removed ${report.snapshots.removed}`);
    if (!apply) {
      console.log("Dry run. Re-run with --apply to write.");
    } else if (vacuum) {
      const before = fileSize(databasePath);
      console.warn(`VACUUM rewrites the whole database. It needs free disk space of about ${megabytes(before)} `
        + "and can take a long time; nothing else may write until it finishes.");
      sqlite.exec("VACUUM");
      console.log(`Database file: ${megabytes(before)} before, ${megabytes(fileSize(databasePath))} after.`);
    } else {
      console.log("Freed pages stay in the file and are reused. Add --vacuum to shrink it.");
    }
  } catch (error) {
    if (!(error instanceof SyncInProgressError)) throw error;
    console.error(error.message);
    process.exit(2);
  } finally {
    sqlite.close();
  }
}
