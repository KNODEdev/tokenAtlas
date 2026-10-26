import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations, ensureRawSyncIndexes } from "../db/migrate";
import { installAnalysisTracking } from "../db/analysis";
import { ensureCodexSchema } from "./codex";

/**
 * `events.resp_ms` (Codex parser 7) reaches an existing database without moving the analysis revision of `events`, and
 * the change tracking covers it afterwards: the tracking triggers are handed over as migration 0065 does it for
 * `claude_events`, both on the startup schema step and on the Codex import's own schema step.
 */
function existing(): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  // Everything a started database already has (the derived columns too), then the state before Codex parser 7.
  ensureRawSyncIndexes(db);
  // A database from before Codex parser 7: no resp_ms, its tracking installed for the columns it had.
  for (const operation of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER analysis_events_${operation}`);
  db.exec("ALTER TABLE events DROP COLUMN resp_ms");
  installAnalysisTracking(db);
  db.exec("INSERT INTO events(home,path,ts,in_tok,out_tok) VALUES('h','p','2026-08-01T10:00:00.000Z',10,5)");
  return db;
}
const revisions = (db: Database) => db.query("SELECT bucket,revision FROM analysis_source_revisions WHERE source='events' ORDER BY bucket").all();

for (const [name, upgrade] of [
  ["the startup schema step", (db: Database) => ensureRawSyncIndexes(db)],
  ["the Codex import's schema step", (db: Database) => ensureCodexSchema(db)],
] as const) {
  test(`${name} adds events.resp_ms without moving the events revision, and tracks it`, () => {
    const db = existing();
    try {
      const before = revisions(db);
      upgrade(db);
      expect((db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).some(column => column.name === "resp_ms")).toBe(true);
      expect(revisions(db)).toEqual(before);
      expect(db.query("SELECT name FROM sqlite_master WHERE name='analysis_tracking_handoff'").get()).toBeNull();
      // A later change of the time alone is a tracked change.
      db.exec("UPDATE events SET resp_ms=1234");
      expect(revisions(db)).not.toEqual(before);
    } finally { db.close(); }
  });
}
