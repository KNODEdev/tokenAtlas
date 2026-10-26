import { afterEach, expect, test } from "bun:test";
import { Database } from "../../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../../src/db/migrate";
import {
  ATLAS_SNAPSHOT_BARRIER_SUFFIX,
  publishAtlasSnapshot,
  discoverAtlasSnapshotCandidates,
} from "../../src/db/snapshot";
import { runRetention, SyncInProgressError } from "./db-retention";
import { CODEX_CANONICAL_COPY_POLICY as CODEX_MIRROR_POLICY_VERSION } from "../../src/db/codex-ledger-canonical";

const dirs: string[] = [];
const dbs: Database[] = [];

/** The raw source tables live outside the drizzle migrations. */
const CORE_TABLES = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE files (home TEXT, path TEXT, size INTEGER, mtime REAL, events INTEGER, PRIMARY KEY (home, path));
  CREATE TABLE events (home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT, model TEXT, effort TEXT,
    project TEXT, in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
    reasoning_out INTEGER, cwd TEXT, project_id TEXT);
  CREATE TABLE ratelimit (home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, used_percent REAL,
    resets_at INTEGER, plan_type TEXT, limit_id TEXT, limit_name TEXT);`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-retention-script-"));
  dirs.push(root);
  const dbPath = path.join(root, "atlas.sqlite");
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(CORE_TABLES);
  applyDrizzleMigrations(drizzle(db));
  dbs.push(db);
  return { root, dbPath, db };
}
function storeRun(db: Database, runId: string, status: string, finishedAt: string | null): void {
  const result = { runId, trigger: "auto", scope: { kind: "all" }, mode: "incremental", status,
    startedAt: "2026-09-19T10:00:00.000Z", finishedAt, vendors: [],
    beforeRevisions: { data: 1, config: 1 }, afterRevisions: { data: 1, config: 1 } };
  db.query(`INSERT INTO sync_runs (run_id, trigger, scope, mode, status, started_at, finished_at,
      before_data_revision, after_data_revision, before_config_revision, after_config_revision, result_json)
    VALUES (?, 'auto', 'all', 'incremental', ?, ?, ?, 1, 1, 1, 1, ?)`)
    .run(runId, status, result.startedAt, finishedAt, JSON.stringify(result));
}
function stage(root: string, runId: string, vendor = "claude"): string {
  const dir = path.join(root, "sync-staging");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}-${vendor}.sqlite`);
  fs.writeFileSync(file, "stage");
  return file;
}

afterEach(() => {
  dbs.splice(0).forEach((db) => { try { db.close(true); } catch { /* already closed */ } });
  Bun.gc(true);
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

test("the dry run reports what could be reclaimed and changes nothing", () => {
  const f = fixture();
  const finished = "11111111-1111-4111-8111-111111111111";
  storeRun(f.db, finished, "failure", "2026-09-19T10:05:00.000Z");
  const stageFile = stage(f.root, finished);

  const report = runRetention(f.db, f.dbPath);
  expect(report.applied).toBe(false);
  expect(report.stages).toMatchObject({ files: 1, disposableFiles: 1, removed: 0 });
  expect(fs.existsSync(stageFile)).toBe(true);
});

test("applying removes stages of finished runs only", () => {
  const f = fixture();
  const failed = "11111111-1111-4111-8111-111111111111";
  const partial = "22222222-2222-4222-8222-222222222222";
  const running = "33333333-3333-4333-8333-333333333333";
  storeRun(f.db, failed, "failure", "2026-09-19T10:05:00.000Z");
  storeRun(f.db, partial, "partial_success", "2026-09-19T10:06:00.000Z");
  storeRun(f.db, running, "running", null);
  const files = { failed: stage(f.root, failed), partial: stage(f.root, partial), running: stage(f.root, running) };
  const orphanRecent = stage(f.root, "44444444-4444-4444-8444-444444444444");
  const orphanOld = stage(f.root, "55555555-5555-4555-8555-555555555555");
  const aged = new Date(Date.now() - 26 * 60 * 60 * 1000);
  fs.utimesSync(orphanOld, aged, aged);

  // A run recorded as running blocks retention entirely.
  expect(() => runRetention(f.db, f.dbPath, { apply: true })).toThrow(SyncInProgressError);
  f.db.query("UPDATE sync_runs SET status='failure', finished_at=? WHERE run_id=?")
    .run("2026-09-19T10:07:00.000Z", running);
  f.db.query("UPDATE sync_runs SET result_json=json_set(result_json,'$.status','failure','$.finishedAt',?) WHERE run_id=?")
    .run("2026-09-19T10:07:00.000Z", running);

  const report = runRetention(f.db, f.dbPath, { apply: true });
  expect(report.stages.removed).toBe(4);
  expect(fs.existsSync(files.failed)).toBe(false);
  expect(fs.existsSync(files.partial)).toBe(false);
  expect(fs.existsSync(files.running)).toBe(false);
  expect(fs.existsSync(orphanOld)).toBe(false);
  // An orphan that could still belong to an unrecorded attempt is kept.
  expect(fs.existsSync(orphanRecent)).toBe(true);
});

test("a stage of a run still marked running is kept while every other stage goes", () => {
  const f = fixture();
  const running = "33333333-3333-4333-8333-333333333333";
  const finished = "11111111-1111-4111-8111-111111111111";
  storeRun(f.db, running, "running", null);
  storeRun(f.db, finished, "success", "2026-09-19T10:05:00.000Z");
  const kept = stage(f.root, running);
  const removed = stage(f.root, finished);
  // The refusal only covers `sync_runs.status`; clear it and keep the run record itself.
  f.db.query("UPDATE sync_runs SET status='queued' WHERE run_id=?").run(running);

  const report = runRetention(f.db, f.dbPath, { apply: true });
  expect(report.stages.removed).toBe(1);
  expect(fs.existsSync(kept)).toBe(true);
  expect(fs.existsSync(removed)).toBe(false);
});

test("surplus validated snapshots are removed and the newest one is kept", () => {
  const f = fixture();
  const poolPath = path.join(f.root, "atlas-index-snapshots");
  const archiveRoot = path.join(f.root, "archive");
  fs.mkdirSync(archiveRoot, { recursive: true });
  f.db.query("UPDATE sync_revisions SET data_revision=1 WHERE id=1").run();
  f.db.close(true);
  dbs.length = 0;

  const first = publishAtlasSnapshot({ dbPath: f.dbPath, archiveRoot, poolPath, mode: "manual",
    now: new Date("2026-09-18T10:00:00Z") });
  expect(first.status).toBe("created");
  // Publication retention already keeps one; put the older copy back to prove the
  // script removes a surplus the pool acquired some other way.
  const aside = path.join(f.root, "aside");
  fs.mkdirSync(aside, { recursive: true });
  const firstFiles = [first.databasePath!, first.manifestPath!,
    path.join(poolPath, `${first.snapshotId}${ATLAS_SNAPSHOT_BARRIER_SUFFIX}`)];
  for (const file of firstFiles) fs.copyFileSync(file, path.join(aside, path.basename(file)));

  const writable = new Database(f.dbPath);
  dbs.push(writable);
  writable.query("UPDATE sync_revisions SET data_revision=2 WHERE id=1").run();
  writable.close(true);
  dbs.length = 0;
  const second = publishAtlasSnapshot({ dbPath: f.dbPath, archiveRoot, poolPath, mode: "manual",
    now: new Date("2026-09-19T10:00:00Z") });
  expect(second.status).toBe("created");
  for (const file of firstFiles) fs.copyFileSync(path.join(aside, path.basename(file)), file);
  expect(discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid)).toHaveLength(2);

  const db = new Database(f.dbPath);
  dbs.push(db);
  const dry = runRetention(db, f.dbPath);
  expect(dry.snapshots).toMatchObject({ validated: 2, surplus: 1, removed: 0 });
  expect(dry.snapshots.surplusBytes).toBeGreaterThan(0);

  const applied = runRetention(db, f.dbPath, { apply: true });
  expect(applied.snapshots).toMatchObject({ validated: 2, surplus: 1, removed: 1 });
  const remaining = discoverAtlasSnapshotCandidates(poolPath).filter((candidate) => candidate.valid);
  expect(remaining.map((candidate) => candidate.snapshotId)).toEqual([second.snapshotId!]);
  expect(fs.existsSync(first.databasePath!)).toBe(false);
});
