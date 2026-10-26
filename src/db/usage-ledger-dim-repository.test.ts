/**
 * Migration 0068 (repository and group in the usage ledger's dimension key): on a ledger built without them it relabels
 * every dimension in place - same ids; with 0069 after it, the key the producer now writes - and it refuses, before any
 * change, a ledger where one dimension's facts carry two repositories (that needs the full M2 regrouping of step 7).
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { installAnalysisTracking } from "./analysis";
import { installFactDayRevisions } from "./fact-day-revisions";
import { ensureDerivedColumns } from "./derived-columns";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as migrateDrizzle } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "./sqlite";
import { createTestDatabase } from "../sync/test-support";
import { RATES } from "../server/claude-code-capacity.fixture";
import { fillUsageLedger } from "../server/usage-ledger.fixture";

const MIGRATIONS = path.resolve(import.meta.dir, "../../drizzle");

function ledger() {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  ensureDerivedColumns(db);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  const insert = db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,
    project_id,repo,repo_group) VALUES ('primary',?,?,?,?,'claude-sonnet-fixture','standard','a','cli','2.1.0',1000,100,?,?,?)`);
  const calls: Array<[string, string, string | null, string | null, string | null]> = [
    ["c1", "2026-09-10T10:00:00.000Z", "alpha", "repo-a", "group-1"], ["c2", "2026-09-10T10:05:00.000Z", "alpha", "repo-a", "group-1"],
    ["c3", "2026-09-11T10:00:00.000Z", null, "repo-b", null], ["c4", "2026-09-11T11:00:00.000Z", null, null, null]];
  for (const [id, ts, project, repo, group] of calls) insert.run(id, "s", `${ARCHIVE_LOGICAL_ROOT}/claude/a/s.jsonl`, ts, project, repo, group);
  fillUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
  const dims = () => db.query("SELECT id, key, repo, repo_group FROM usage_ledger_dims WHERE provider='claude' ORDER BY id").all();
  /** The ledger as 0067 left it: ten-element keys with subject and project id, no repository or shift columns. */
  const before0068 = () => db.exec(`UPDATE usage_ledger_dims AS d SET subject=f.subject, project_id=f.project
      FROM (SELECT DISTINCT dim_id, subject, project FROM usage_ledger_facts) f WHERE f.dim_id=d.id;
    UPDATE usage_ledger_dims SET key=json_array(source, identity, model, speed, subject, vendor, home, project_id, project, cwd);
    ALTER TABLE usage_ledger_dims DROP COLUMN shift; ALTER TABLE usage_ledger_dims DROP COLUMN repo_group; ALTER TABLE usage_ledger_dims DROP COLUMN repo;`);
  /** The real migrator, with 0068 and 0069 not yet applied. */
  const migrate = () => {
    // 0070 runs again after them and re-adds its column.
    db.exec("DELETE FROM __drizzle_migrations WHERE created_at>=1789776000036; ALTER TABLE usage_ledger_days DROP COLUMN act_key;"
      + " ALTER TABLE plan_periods DROP COLUMN anchor_ts; ALTER TABLE plan_periods DROP COLUMN cycle_months");
    for(const family of ['subscription_capacity','subscription_hours','project_plan']){
      const tables=family==='subscription_capacity'?['windows','dirty','state']:family==='subscription_hours'?['dirty','state']:['days','dirty','state'];
      for(const suffix of tables)db.exec(`DROP TABLE ${family}_${suffix}`);
    }
    db.exec('DROP TABLE subscription_window_hours');
    migrateDrizzle(drizzle(db), { migrationsFolder: MIGRATIONS });
  };
  return { db, dims, before0068, migrate, close() { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

test("0068 relabels every dimension in place; with 0069, with the key the producer writes", () => {
  const f = ledger();
  try {
    const built = f.dims() as Array<{ id: number; key: string; repo: string | null; repo_group: string | null }>;
    expect(built.map(row => [row.repo, row.repo_group])).toEqual([["repo-a", "group-1"], ["repo-b", null], [null, null]]);
    expect(JSON.parse(built[0]!.key).slice(-3)).toEqual(["repo-a", "group-1", 0]);
    const days = f.db.query("SELECT * FROM usage_ledger_days ORDER BY day, dim_id").all();
    f.before0068();
    f.migrate();
    expect(f.dims()).toEqual(built);
    expect(f.db.query("SELECT * FROM usage_ledger_days ORDER BY day, dim_id").all()).toEqual(days);
    // A rebuild finds the same dimensions: nothing new is registered.
    f.db.exec("DELETE FROM usage_ledger_dirty; INSERT INTO usage_ledger_dirty(provider,kind,value) SELECT DISTINCT 'claude','identity',identity FROM usage_ledger_facts");
    fillUsageLedger(f.db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    expect(f.dims()).toEqual(built);
  } finally { f.close(); }
});

test("0068 refuses a dimension whose facts carry two repositories, before changing anything", () => {
  const f = ledger();
  try {
    f.before0068();
    f.db.exec("UPDATE usage_ledger_facts SET repo='repo-z' WHERE row_id=(SELECT MIN(row_id) FROM usage_ledger_facts WHERE repo='repo-a')");
    const keys = f.db.query("SELECT id, key FROM usage_ledger_dims ORDER BY id").all();
    expect(() => f.migrate()).toThrow("migration_0068_guard");
    expect(f.db.query("SELECT COUNT(*) n FROM __drizzle_migrations WHERE created_at=1789776000036").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT id, key FROM usage_ledger_dims ORDER BY id").all()).toEqual(keys);
    expect((f.db.query("PRAGMA table_info(usage_ledger_dims)").all() as Array<{ name: string }>).map(column => column.name)).not.toContain("repo");
  } finally { f.close(); }
});
