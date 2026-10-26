import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { factDaysTracked, factTableRevision, installFactDayRevisions, isFactDayRevisionTrigger } from "./fact-day-revisions";
import { publishFirstFill } from "../sync/first-fill";

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE claude_events(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, in_uncached INTEGER)");
  installFactDayRevisions(db);
  return db;
}
const days = (db: Database) => Object.fromEntries((db.query("SELECT day, revision FROM fact_day_revisions WHERE source='claude_events'")
  .all() as Array<{ day: string; revision: number }>).map(row => [row.day, row.revision]));

test("every write records the source days it changed in the writing transaction, a correction both days", () => {
  const db = fixture();
  try {
    expect(factDaysTracked(db, "claude_events")).toBe(true);
    expect(factTableRevision(db, "claude_events")).toBe(0);
    db.query("INSERT INTO claude_events(ts,in_uncached) VALUES('2026-09-01T10:00:00Z',1),('2026-09-02T10:00:00Z',2)").run();
    expect(days(db)).toEqual({ "2026-09-01": 1, "2026-09-02": 1, "*": 2 });
    // A correction that moves a row changes its old and its new day.
    db.query("UPDATE claude_events SET ts='2026-09-03T10:00:00Z' WHERE in_uncached=1").run();
    expect(days(db)).toEqual({ "2026-09-01": 2, "2026-09-02": 1, "2026-09-03": 1, "*": 3 });
    // A write that changes nothing records nothing; a deletion records the row's day.
    db.query("UPDATE claude_events SET in_uncached=in_uncached WHERE in_uncached=2").run();
    db.query("DELETE FROM claude_events WHERE in_uncached=2").run();
    expect(days(db)).toEqual({ "2026-09-01": 2, "2026-09-02": 2, "2026-09-03": 1, "*": 4 });
    // A rolled-back write leaves no dirty range.
    expect(() => db.transaction(() => { db.query("INSERT INTO claude_events(ts,in_uncached) VALUES('2026-09-05T00:00:00Z',5)").run(); throw new Error("rollback"); }).immediate())
      .toThrow("rollback");
    expect(days(db)["2026-09-05"]).toBeUndefined();
  } finally { db.close(); }
});

test("a first fill without the triggers records the days of the rows it published", () => {
  const db = fixture();
  try {
    db.transaction(() => publishFirstFill(db, ["claude_events"], () => {
      // The triggers are gone while the rows move.
      expect(factDaysTracked(db, "claude_events")).toBe(false);
      db.query("INSERT INTO claude_events(ts,in_uncached) VALUES('2026-09-01T01:00:00Z',1),('2026-09-01T02:00:00Z',2),('2026-09-04T00:00:00Z',3)").run();
    })).immediate();
    expect(factDaysTracked(db, "claude_events")).toBe(true);
    expect(days(db)).toEqual({ "2026-09-01": 2, "2026-09-04": 1, "*": 3 });
    const trigger = db.query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND name='fact_day_revision_claude_events_insert'")
      .get() as { name: string; tbl_name: string; sql: string };
    expect(isFactDayRevisionTrigger(db, trigger.name, trigger.tbl_name, trigger.sql)).toBe(true);
  } finally { db.close(); }
});
