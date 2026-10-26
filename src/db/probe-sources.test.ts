import { afterEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "./sqlite";
import { applyDrizzleMigrations } from "./migrate";
import { ensureProbeSourcesSchema, probeSourcesPending, probeSourcesPublished } from "./probe-sources";

const opened: Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(true); });
const open = () => { const db = new Database(":memory:"); opened.push(db); return db; };
const objects = (db: Database) => (db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'probe_source%' ORDER BY name")
  .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>)
  .map(row => ({ ...row, sql: row.sql.replace(/\s+/g, " ").replace(/ IF NOT EXISTS/g, "").trim() }));

test("migration 0058 and the fixture schema define the same evidence tables, indexes and triggers; no derived keys remain", () => {
  const migrated = open();
  applyDrizzleMigrations(drizzle(migrated));
  const bare = open();
  bare.exec(`CREATE TABLE probe_windows(id INTEGER PRIMARY KEY, provider TEXT, ts TEXT);
    CREATE TABLE probe_fact_legacy_map(id TEXT PRIMARY KEY, namespace TEXT, legacy_id INTEGER)`);
  ensureProbeSourcesSchema(bare);
  expect(objects(migrated)).toEqual(objects(bare));
  expect(objects(migrated).filter(row => row.type === "table").map(row => row.name))
    .toEqual(["probe_source_dirty", "probe_source_tuples", "probe_sources"]);
  expect(migrated.query("SELECT name FROM sqlite_master WHERE name='current_probe_keys' OR sql LIKE '%current_probe_keys%'").all()).toEqual([]);
});

test("every new, corrected, deleted or newly linked reading queues its evidence; existing readings queue once on creation", () => {
  const db = open();
  db.exec(`CREATE TABLE probe_windows(id INTEGER PRIMARY KEY, provider TEXT, ts TEXT);
    CREATE TABLE probe_fact_legacy_map(id TEXT PRIMARY KEY, namespace TEXT, legacy_id INTEGER);
    INSERT INTO probe_windows VALUES(1,'codex','2026-09-01T00:00:00Z'),(2,'codex','2026-09-02T00:00:00Z')`);
  ensureProbeSourcesSchema(db);
  const queued = () => (db.query("SELECT probe_id FROM probe_source_dirty ORDER BY probe_id").all() as Array<{ probe_id: number }>)
    .map(row => row.probe_id);
  expect(queued()).toEqual([1, 2]);
  expect(probeSourcesPublished(db)).toBe(false);
  db.exec("DELETE FROM probe_source_dirty");
  expect(probeSourcesPending(db)).toBe(false);
  db.exec("INSERT INTO probe_windows VALUES(3,'codex','2026-09-03T00:00:00Z')");
  db.exec("UPDATE probe_windows SET ts='2026-09-01T01:00:00Z' WHERE id=1");
  db.exec("DELETE FROM probe_windows WHERE id=2");
  expect(queued()).toEqual([1, 2, 3]);
  db.exec("DELETE FROM probe_source_dirty");
  db.exec("INSERT INTO probe_fact_legacy_map VALUES('f','local',3)");
  expect(queued()).toEqual([3]);
  // A repeated call adds nothing and requeues nothing.
  ensureProbeSourcesSchema(db);
  expect(queued()).toEqual([3]);
});

test("a changed evidence rule queues only the readings it affects, once", () => {
  const db = open();
  db.exec(`CREATE TABLE probe_windows(id INTEGER PRIMARY KEY, provider TEXT, ts TEXT, extra TEXT)`);
  ensureProbeSourcesSchema(db);
  db.exec("DELETE FROM probe_source_dirty; DELETE FROM meta WHERE key='probe_sources_rules'");
  db.exec(`DROP TRIGGER probe_sources_after_insert;
    INSERT INTO probe_windows VALUES(1,'gemini','2026-09-09T15:48:11Z','{"home":"pool:agy08"}'),
      (2,'gemini','2026-09-09T15:48:11Z','{"home":"C:\\Users\\sample_a\\.gemini"}'),(3,'codex','2026-09-09T15:48:11Z','{"home":"pool:x"}')`);
  ensureProbeSourcesSchema(db);
  const queued = () => (db.query("SELECT probe_id FROM probe_source_dirty ORDER BY probe_id").all() as Array<{ probe_id: number }>).map(row => row.probe_id);
  expect(queued()).toEqual([1]);
  db.exec("DELETE FROM probe_source_dirty");
  ensureProbeSourcesSchema(db);
  expect(queued()).toEqual([]);
});
