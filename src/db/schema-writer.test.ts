import { expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "./sqlite";
import { ensureRawSyncIndexes } from "./migrate";
import { ensureGaugeBookmarkSchema } from "../ingest/gauges";
import { ensureCodexSchema } from "../ingest/codex";
import { createTestDatabase } from "../sync/test-support";

/**
 * Two processes starting together (the server and a sync child, two syncs) run the same runtime schema
 * steps. The other process is played here by a second connection that runs its step at the worst moment:
 * right after the first one read the schema and before it adds what was missing.
 */
function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}
/** Runs `ensure` on `first`; when it first reads `table`'s columns, `second` runs `ensure` too. */
type Competitor = "not-run" | "completed" | "waited";
function interleave(first: Database, second: Database, table: string, ensure: (db: Database) => void): Competitor {
  const query = first.query.bind(first);
  let competitor = "not-run" as Competitor;
  first.query = ((sql: string) => {
    if (competitor === "not-run" && sql.replace(/\s+/g, " ").includes(`PRAGMA table_info(${table})`)) {
      try { ensure(second); competitor = "completed"; }
      catch (error) { if (!/database is locked|SQLITE_BUSY/i.test(String(error))) throw error; competitor = "waited"; }
    }
    return query(sql);
  }) as typeof first.query;
  try { ensure(first); } finally { first.query = query; }
  return competitor;
}

for (const [name, table, column, ensure] of [
  ["the gauge bookmark column", "gauge_files", "prefix_sha256", ensureGaugeBookmarkSchema],
  ["the Codex import columns", "events", "provider_ids_observed", ensureCodexSchema],
  ["the raw sync step a sync start runs", "gauge_files", "prefix_sha256", ensureRawSyncIndexes],
] as const) {
  test(`${name}: added once when two connections ensure the schema at the same time`, () => {
    const { directory, dbPath } = createTestDatabase();
    const first = new Database(dbPath), second = new Database(dbPath);
    try {
      first.exec("PRAGMA journal_mode=WAL");
      ensureRawSyncIndexes(first);
      // An older schema without the column (its change triggers name every column, so they go first).
      for (const { name: trigger } of first.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as Array<{ name: string }>)
        first.exec(`DROP TRIGGER "${trigger}"`);
      first.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      // The other process does not wait: it either finishes before or is refused while the first one writes.
      second.exec("PRAGMA busy_timeout=0");
      const competitor = interleave(first, second, table, ensure);
      expect(competitor).toBe("waited");
      expect(columns(first, table).filter(name => name === column)).toEqual([column]);
      // The later start then finds the schema in place.
      ensure(second);
      expect(columns(second, table).filter(name => name === column)).toEqual([column]);
    } finally { first.close(); second.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
}
