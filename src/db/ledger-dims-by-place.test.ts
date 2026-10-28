/**
 * Migration 0069 (M2 of docs/stored-activity-plan-2026-10-07.md): ledgers built with dimensions split by project are
 * re-keyed by place in place. Dimensions that then share a key merge, and their day, hour, reason, cohort and per-file
 * rows equal what the producers build from the same facts with place-keyed dimensions. The old -> new map must be a
 * function: a dimension whose calls carry two shifts stops the migration before any change.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as migrateDrizzle } from "drizzle-orm/bun-sqlite/migrator";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { installAnalysisTracking } from "./analysis";
import { installFactDayRevisions } from "./fact-day-revisions";
import { ensureDerivedColumns } from "./derived-columns";
import { Database } from "./sqlite";
import { createTestDatabase } from "../sync/test-support";
import { RATES } from "../server/claude-code-capacity.fixture";
import { fillUsageLedger } from "../server/usage-ledger.fixture";
import { prepareCodexLedgerFixture } from "../server/codex-ledger.fixture";
import { card } from "../server/codex-window-calls.fixture";
import { rebuildCodexLedgerDay } from "./codex-price-ledger";
import { ensureRawSyncIndexes } from "./migrate";
import { overrideProjectRules } from "../projects/resolve";
import { replayFixtureMigrations } from "./migration-range.fixture";

const MIGRATIONS = path.resolve(import.meta.dir, "../../drizzle");
const M0069 = 1789776000037;

function database() {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  ensureDerivedColumns(db);
  installAnalysisTracking(db);
  installFactDayRevisions(db);
  // The raw project ids here describe the old dimension split only; the ledgers are keyed by place whatever the rules.
  overrideProjectRules(db, { projects: [] });
  const migrate = () => {
    db.exec("ALTER TABLE usage_ledger_days DROP COLUMN act_key");
    replayFixtureMigrations(db, directory, "0069_dims_by_place", "0070_usage_ledger_day_act_key");
  };
  return { db, migrate, close() { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

/** Claude calls of one place whose raw project ids differ (the old key split them), and of another place. */
function claudeLedger(db: Database) {
  const insert = db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total,
    cwd,project,project_id,repo,repo_group) VALUES ('primary',?,?,?,?,'claude-sonnet-fixture','standard','a','cli','2.1.0',?,100,?,?,?,?,NULL)`);
  const calls: Array<[string, string, number, string, string | null, string | null]> = [
    ["c1", "2026-09-10T10:00:00.000Z", 1000, "C:/w/alpha", "alpha", "alpha-old"], ["c2", "2026-09-10T10:04:00.000Z", 2000, "C:/w/alpha", "alpha", null],
    ["c3", "2026-09-10T10:20:00.000Z", 3000, "C:/w/alpha", "alpha", "alpha-old"], ["c4", "2026-09-11T09:00:00.000Z", 4000, "C:/w/alpha", "alpha", null],
    ["c5", "2026-09-11T09:02:00.000Z", 5000, "C:/w/beta", "beta", "beta"]];
  for (const [id, ts, tokens, cwd, project, projectId] of calls)
    insert.run(id, "s", `${ARCHIVE_LOGICAL_ROOT}/claude/a/s.jsonl`, ts, tokens, cwd, project, projectId, cwd.split("/").pop()!);
  fillUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
}
const usageRows = (db: Database, shift = true) => ({
  dims: db.query(`SELECT id, key, ${shift ? "shift, " : ""}subject, project_id FROM usage_ledger_dims ORDER BY id`).all(),
  days: db.query("SELECT * FROM usage_ledger_days ORDER BY provider, day, dim_id").all(),
  hours: db.query("SELECT * FROM usage_ledger_hours ORDER BY provider, day, hour, dim_id").all(),
  reasons: db.query("SELECT * FROM usage_ledger_day_reasons ORDER BY provider, day, dim_id, variant, reason").all(),
  facts: db.query("SELECT row_id, dim_id FROM usage_ledger_facts ORDER BY row_id").all(),
});
/**
 * The ledger as 0068 left it: the calls of a raw project id under their own dimension (subject and project id in the
 * key), its day rows rebuilt from the facts by the producer, and no shift column.
 */
function usageBefore0069(db: Database) {
  db.exec(`INSERT INTO usage_ledger_dims(provider,key,source,identity,model,speed,vendor,home,project,cwd,repo,repo_group)
    SELECT provider, 'split:'||id, source, identity, model, speed, vendor, home, project, cwd, repo, repo_group FROM usage_ledger_dims
    WHERE id IN (SELECT dim_id FROM usage_ledger_facts WHERE project IS NOT NULL)`);
  db.exec(`UPDATE usage_ledger_facts AS f SET dim_id=(SELECT d.id FROM usage_ledger_dims d WHERE d.key='split:'||f.dim_id) WHERE f.project IS NOT NULL`);
  db.exec(`UPDATE usage_ledger_dims AS d SET subject=f.subject, project_id=f.project FROM (SELECT DISTINCT dim_id, subject, project FROM usage_ledger_facts) f
    WHERE f.dim_id=d.id`);
  db.exec(`UPDATE usage_ledger_dims SET key=json_array(source, identity, model, speed, subject, vendor, home, project_id, project, cwd, repo, repo_group)`);
  db.exec("ALTER TABLE usage_ledger_dims DROP COLUMN shift");
  db.exec("DELETE FROM usage_ledger_dirty; INSERT INTO usage_ledger_dirty(provider,kind,value) SELECT DISTINCT 'claude','day',day FROM usage_ledger_facts");
  fillUsageLedger(db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
}

test("0069 merges the usage-ledger dimensions of one place into the rows the producer builds from the facts", () => {
  const f = database();
  try {
    claudeLedger(f.db);
    const built = usageRows(f.db);
    expect(built.dims.map(row => JSON.parse((row as { key: string }).key).slice(-5))).toEqual([["alpha", "C:/w/alpha", "alpha", null, 0],
      ["beta", "C:/w/beta", "beta", null, 0]]);
    usageBefore0069(f.db);
    const split = usageRows(f.db, false);
    expect(split.dims).toHaveLength(4);
    expect(split.days).not.toEqual(built.days);
    f.migrate();
    expect(usageRows(f.db)).toEqual(built);
    // A rebuild finds the same dimensions and day rows: nothing new is registered.
    f.db.exec("DELETE FROM usage_ledger_dirty; INSERT INTO usage_ledger_dirty(provider,kind,value) SELECT DISTINCT 'claude','identity',identity FROM usage_ledger_facts");
    fillUsageLedger(f.db, "claude", RATES, ARCHIVE_LOGICAL_ROOT);
    expect(usageRows(f.db)).toEqual(built);
  } finally { f.close(); }
});

test("0069 refuses a dimension whose calls carry two shifts, before changing anything", () => {
  const f = database();
  try {
    claudeLedger(f.db);
    usageBefore0069(f.db);
    f.db.exec("UPDATE usage_ledger_facts SET src_day='2026-09-09' WHERE row_id=(SELECT MIN(row_id) FROM usage_ledger_facts WHERE day='2026-09-10')");
    const keys = f.db.query("SELECT id, key FROM usage_ledger_dims ORDER BY id").all();
    expect(() => f.migrate()).toThrow("migration_0069_guard");
    expect(f.db.query(`SELECT COUNT(*) n FROM __drizzle_migrations WHERE created_at=${M0069}`).get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT id, key FROM usage_ledger_dims ORDER BY id").all()).toEqual(keys);
    expect((f.db.query("PRAGMA table_info(usage_ledger_dims)").all() as Array<{ name: string }>).map(column => column.name)).not.toContain("shift");
  } finally { f.close(); }
});

const codexRows = (db: Database) => ({
  dims: db.query("SELECT id, key, subject, project_id FROM codex_price_ledger_dims ORDER BY id").all(),
  aggregates: db.query("SELECT * FROM codex_price_ledger_aggregates ORDER BY grain, day, hour, dim_id, api_band, credit_band, api_reason, credit_reason, copy_state").all(),
  files: db.query("SELECT * FROM codex_price_ledger_file_models ORDER BY day, hour, dim_id, copy_id").all(),
  events: db.query("SELECT id, dim_id FROM codex_price_ledger_events ORDER BY id").all(),
});

test("0069 merges Codex dimensions that differed by project into the cohorts the producer builds from the calls", () => {
  const f = database();
  try {
    ensureRawSyncIndexes(f.db);
    const insert = f.db.query(`INSERT INTO events (home,path,ts,model,in_tok,cached_in,cache_write,out_tok,reasoning_out,speed,billing_mode,plan_type,
      cwd,project,project_id,repo,source_offset) VALUES ('c:/own',?,?,'gpt-6-astra',?,10,0,50,5,'standard','allowance','pro','C:/w/alpha','alpha',?,'alpha',?)`);
    const calls: Array<[string, string, number, string | null]> = [["a", "2026-09-11T10:00:00.000Z", 1000, "alpha-old"], ["a", "2026-09-11T10:03:00.000Z", 2000, "alpha-old"],
      ["b", "2026-09-11T10:05:00.000Z", 3000, null], ["b", "2026-09-11T11:30:00.000Z", 4000, null], ["a", "2026-09-12T08:00:00.000Z", 5000, "alpha-old"]];
    calls.forEach(([file, ts, tokens, project], index) => insert.run(`c:/own/${file}.jsonl`, ts, tokens, project, index * 10));
    prepareCodexLedgerFixture(f.db, card);
    const built = codexRows(f.db);
    expect(built.dims).toHaveLength(1);
    // The ledger as 0068 left it: the calls of file a under a dimension of their own project (old key with subject and id).
    const [dim] = built.dims as Array<{ id: number }>;
    f.db.transaction(() => {
      f.db.exec(`INSERT INTO codex_price_ledger_dims(key,source,home,model,service_tier,speed,subject,billing_mode,surface,nested,plan_type,meter_reset,repo,project_id,project,cwd)
        SELECT 'split',source,home,model,service_tier,speed,'p:alpha-old',billing_mode,surface,nested,plan_type,meter_reset,repo,'alpha-old',project,cwd
        FROM codex_price_ledger_dims WHERE id=${dim!.id}`);
      f.db.exec(`UPDATE codex_price_ledger_events SET dim_id=(SELECT id FROM codex_price_ledger_dims WHERE key='split')
        WHERE copy_id IN (SELECT id FROM codex_price_ledger_copies WHERE path LIKE '%/a.jsonl')`);
      f.db.exec(`UPDATE codex_price_ledger_dims SET subject='r:'||repo WHERE subject IS NULL`);
      f.db.exec(`UPDATE codex_price_ledger_dims SET key=json_array(source,home,model,service_tier,speed,subject,billing_mode,surface,nested,plan_type,
        meter_reset,repo,project_id,project,cwd)`);
      for (const { day } of f.db.query("SELECT DISTINCT day FROM codex_price_ledger_events").all() as Array<{ day: string }>) rebuildCodexLedgerDay(f.db, day);
    })();
    const split = codexRows(f.db);
    expect(split.dims).toHaveLength(2);
    expect(split.aggregates).not.toEqual(built.aggregates);
    // Usage-ledger dimensions must be in their 0068 state too (the migration adds their shift column).
    f.db.exec("ALTER TABLE usage_ledger_dims DROP COLUMN shift");
    f.migrate();
    expect(codexRows(f.db)).toEqual({ ...built, dims: (built.dims as Array<Record<string, unknown>>).map(row => ({ ...row, subject: null, project_id: null })) });
  } finally { f.close(); }
});
