import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./sqlite";
import { ensureRawSyncIndexes, snapshotBeforePendingMigrations } from "./migrate";
import { CODEX_SOURCE_EVIDENCE_SCHEMA_SQL } from "./codex-source-evidence";
import { CODEX_PRICE_LEDGER_SCHEMA_SQL } from "./codex-price-ledger";
import { ensureCodexSchema } from "../ingest/codex";

const migrations = path.resolve(import.meta.dir, "../../drizzle");
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ledger-migration-")), old = path.join(directory, "old-migrations");
  fs.mkdirSync(path.join(old, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 44);
  fs.writeFileSync(path.join(old, "meta", "_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) fs.copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(old, `${entry.tag}.sql`));
  const file = path.join(directory, "copy.sqlite"), db = new Database(file);
  migrate(drizzle(db), { migrationsFolder: old });
  return { directory, db, file, close: () => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const ledgerTables = (db: Database) => db.query("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'codex_ledger_%' OR name LIKE 'codex_price_ledger_%') ORDER BY name").all();
test("migration0045 creates source proof, identity, valuation and producer schema without modifying existing source facts", () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TABLE synthetic_existing_fact(id INTEGER PRIMARY KEY, counter INTEGER NOT NULL)");
    f.db.query("INSERT INTO synthetic_existing_fact VALUES(?,?)").run(1, 9_007_199_254_740_993n);
    const before = f.db.query("SELECT id,CAST(counter AS TEXT) AS counter FROM synthetic_existing_fact").all();
    migrate(drizzle(f.db), { migrationsFolder: migrations });
    expect(f.db.query("SELECT id,CAST(counter AS TEXT) AS counter FROM synthetic_existing_fact").all()).toEqual(before);
    const expected = new Database(":memory:");
    try {
      expected.exec(CODEX_SOURCE_EVIDENCE_SCHEMA_SQL + CODEX_PRICE_LEDGER_SCHEMA_SQL);
      const schema = (db: Database) => db.query("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
        name: string; type: string; sql: string }[];
      const actual = new Map(schema(f.db).map(entry => [entry.name, entry]));
      const normalize = (sql: string) => sql.replace(/IF NOT EXISTS\s+/gi, "").replace(/\s+/g, " ").trim();
      for (const entry of schema(expected)) {
        expect(actual.get(entry.name)?.type).toBe(entry.type);
        expect(normalize(actual.get(entry.name)!.sql)).toBe(normalize(entry.sql));
      }
    } finally { expected.close(); }
    // Copies, dimensions, bands, calls, sums and per-file evidence; the state and queue are on the shared ledger tables.
    expect(ledgerTables(f.db).length).toBe(6);
    const count = f.db.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get();
    migrate(drizzle(f.db), { migrationsFolder: migrations });
    expect(f.db.query("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual(count);
  } finally { f.close(); }
});
test("raw source schema initialization creates source evidence but never valuation or producer schemas", () => {
  const db = new Database(":memory:");
  try {
    ensureRawSyncIndexes(db);
    expect(ledgerTables(db)).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codex_file_evidence','codex_event_evidence') ORDER BY name").all())
      .toEqual([{ name: "codex_file_evidence" }]);
  } finally { db.close(); }
});
test("the new migration retains the existing pre-migration snapshot gate", () => {
  const f = fixture();
  try {
    let calls = 0;
    expect(() => snapshotBeforePendingMigrations(f.file, { publish: () => { calls++; throw new Error("synthetic snapshot required"); } }))
      .toThrow("synthetic snapshot required");
    expect(calls).toBe(1);
    expect(ledgerTables(f.db)).toEqual([]);
  } finally { f.close(); }
});

test("source import and migration initialization install the complete nonunique locator without changing original rows", () => {
  for (const initialize of [ensureCodexSchema, ensureRawSyncIndexes]) {
    const db = new Database(":memory:");
    try {
      ensureCodexSchema(db);
      db.exec("DROP INDEX events_source_locator");
      const put = db.query("INSERT INTO events(home,path,source_offset,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES('h','p',?,'2026-09-01','m',?,0,0,0)");
      put.run(1, 9_007_199_254_740_993n); put.run(1, 7); put.run(2, 3);
      const rows = () => db.query("SELECT home,path,source_offset,CAST(in_tok AS TEXT) in_tok FROM events ORDER BY rowid").all();
      const before = rows();
      initialize(db); initialize(db);
      expect(rows()).toEqual(before);
      const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM events WHERE home IS ? AND path IS ? AND source_offset=?").all('h','p',1) as { detail: string }[];
      expect(plan.some(row => row.detail.includes("events_source_locator") && row.detail.includes("source_offset=?"))).toBe(true);
      expect(db.query("SELECT COUNT(*) n FROM events WHERE home='h' AND path='p' AND source_offset=1").get()).toEqual({ n: 2 });
    } finally { db.close(true); }
  }
});

test("migration 0062 moves the Codex ledger's state, queue and bands onto the shared ledger tables", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ledger-0062-")), old = path.join(directory, "old-migrations");
  fs.mkdirSync(path.join(old, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(migrations, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 60);
  fs.writeFileSync(path.join(old, "meta", "_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) fs.copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(old, `${entry.tag}.sql`));
  const db = new Database(path.join(directory, "copy.sqlite"));
  try {
    migrate(drizzle(db), { migrationsFolder: old });
    db.exec(`INSERT INTO codex_price_ledger_state(singleton,status,algorithm,facts_revision,rules_revision,last_event_id,policy_json)
        VALUES(1,'ready','codex-two-base-exact-v1','7','rules-r','42','{"version":1}');
      INSERT INTO codex_ledger_work(work_key,kind,home,path) VALUES('copy:a','copy','h','a.jsonl');
      INSERT INTO codex_ledger_work(work_key,kind,home,path,status,error) VALUES('copy:b','copy',NULL,'b.jsonl','blocked','no binding');
      INSERT INTO codex_ledger_work(work_key,kind,model,basis,from_day,until_day,input_above,cursor)
        VALUES('rules:x','rules','m','api_equivalent_usd','2026-01-01',NULL,272000,17);
      INSERT INTO codex_ledger_dirty VALUES('conversation','src|a.jsonl'),('day','2026-04-01');
      INSERT INTO codex_ledger_base_policy VALUES('["api","normal"]','rev','{"id":"api"}');
      INSERT INTO codex_ledger_policy_target VALUES(1,'rules-r','base');
      INSERT INTO usage_ledger_dirty VALUES('claude','identity','i'),('claude','day','2026-04-02')`);
    migrate(drizzle(db), { migrationsFolder: migrations });
    expect(db.query("SELECT * FROM usage_ledger_state WHERE provider='codex'").get()).toEqual({ provider: "codex", version: 1, phase: "reconcile",
      status: "ready", covered: 7, bookmark: "", rules_digest: "rules-r", revision: 42, published_revision: 42, rules_json: '{"version":1}',
      activity_published: 0 });
    expect(db.query("SELECT provider,kind,value FROM usage_ledger_dirty ORDER BY provider,kind,value").all()).toEqual([
      { provider: "claude", kind: "day", value: "2026-04-02" }, { provider: "claude", kind: "identity", value: "i" },
      { provider: "codex", kind: "blocked", value: JSON.stringify([null, "b.jsonl"]) },
      { provider: "codex", kind: "copy", value: JSON.stringify(["h", "a.jsonl"]) },
      { provider: "codex", kind: "day", value: "2026-04-01" }, { provider: "codex", kind: "identity", value: "src|a.jsonl" },
      { provider: "codex", kind: "rules", value: JSON.stringify({ model: "m", basis: "api_equivalent_usd", fromDay: "2026-01-01", untilDay: null,
        inputAbove: 272000, inputUntil: null, after: 17 }) },
    ]);
    expect(db.query("SELECT provider,key,rates FROM usage_ledger_keys").all()).toEqual([{ provider: "codex", key: '["api","normal"]', rates: '{"id":"api"}' }]);
    expect(db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codex_price_ledger_state','codex_ledger_work','codex_ledger_dirty',
      'codex_ledger_base_policy','codex_ledger_policy_target','codex_ledger_reference_requests','codex_ledger_reference_values')`).all()).toEqual([]);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
