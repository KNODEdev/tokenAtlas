import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { markWindowUsageDirty, markWindowUsageRangesDirty } from "../db/window-usage";
import {
  ensureWindowAnswersSchema, readWindowAnswer, storeWindowAnswers, windowAnswerIsCurrent, windowAnswerMarkSeq, WINDOW_ANSWERS_SCHEMA_SQL,
} from "../db/window-answers";
import { addEvent, card, COUNTER, database, opened, publishLedger, settle, storeWindows, READINGS } from "./window-usage-codex.fixture";

/**
 * The writers of window inputs and the stored window screens (db/window-answers.ts): a screen stored for
 * each window of the Codex fixture stays current exactly as long as nothing the producers republish
 * touches its window.
 */
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const windowsOf = (db: Database) => db.query("SELECT window_id id,start_ts start,end_ts end FROM limit_windows ORDER BY seq").all() as
  Array<{ id: string; start: string; end: string }>;
function storeScreens(db: Database) {
  const windows = windowsOf(db), checked = windowAnswerMarkSeq(db);
  storeWindowAnswers(db, windows.map(window => ({ route: "/api/cycle-breakdown", key: window.id, family: window.id,
    scope: { provider: "codex", account: "codex1", fromMs: Date.parse(window.start), untilMs: Date.parse(window.end) },
    configuration: "c", checked, builtAt: Date.now(), expiresAt: null, status: 200, version: "v", headers: [], body: "{}" })));
  return windows;
}
const currentScreens = (db: Database) => windowsOf(db).map(window => {
  const answer = readWindowAnswer(db, "/api/cycle-breakdown", window.id);
  return answer !== null && windowAnswerIsCurrent(db, answer, "c");
});
/** The ledger republishes what changed; the fixture refills it whole, so its marks are replaced by the hour the ledger marks. */
function publishHour(db: Database, ts: string) {
  const before = windowAnswerMarkSeq(db);
  publishLedger(db, card);
  db.query("DELETE FROM window_answer_marks WHERE seq > ?").run(before);
  db.query("DELETE FROM window_usage_dirty").run();
  const hour = Math.floor(Date.parse(ts) / 3_600_000) * 3_600_000;
  markWindowUsageRangesDirty(db, "codex", [[hour, hour + 3_600_000]]);
}

test("the migration creates the schema the readers ensure", () => {
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim().replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE")
    .replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX");
  const migrated = new Database(":memory:"), ensured = new Database(":memory:");
  try {
    migrated.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0063_window_answers.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
    ensureWindowAnswersSchema(ensured);
    const schema = (db: Database) => (db.query("SELECT sql FROM sqlite_master WHERE name LIKE 'window_answer%' ORDER BY name").all() as Array<{ sql: string }>)
      .map(row => normalize(row.sql));
    expect(schema(migrated)).toEqual(schema(ensured));
    expect(schema(ensured).length).toBe(WINDOW_ANSWERS_SCHEMA_SQL.match(/CREATE (TABLE|INDEX)/g)!.length);
  } finally { migrated.close(); ensured.close(); }
});

test("a late call makes only its window's stored screen stale; the open window follows new calls", () => {
  const db = database();
  ensureWindowAnswersSchema(db);
  settle(db);
  const windows = storeScreens(db);
  expect(windows.length).toBeGreaterThan(2);
  expect(currentScreens(db).every(Boolean)).toBe(true);
  // A late call in the first week: the ledger marks its hour, the window-sum producer republishes that week.
  addEvent(db, { ts: "2026-09-04T00:00:00.000Z" });
  publishHour(db, "2026-09-04T00:00:00.000Z");
  settle(db);
  expect(currentScreens(db)).toEqual(windows.map((_, index) => index !== 0));
  // Recomputed (a new snapshot), the first week is current again; a call in the open window touches only it.
  storeScreens(db);
  addEvent(db, { ts: "2026-09-16T06:00:00.000Z" });
  publishHour(db, "2026-09-16T06:00:00.000Z");
  settle(db);
  expect(currentScreens(db)).toEqual(windows.map((_, index) => index !== windows.length - 1));
});

test("another account's or provider's change leaves the stored screens current; a new reading follows the producer's range", () => {
  const db = database();
  ensureWindowAnswersSchema(db);
  settle(db);
  const windows = storeScreens(db);
  markWindowUsageDirty(db, { provider: "codex", account: "codex2", fromMs: Date.parse(windows[0]!.start) });
  markWindowUsageRangesDirty(db, "claude", [[Date.parse(windows[0]!.start), Date.parse(windows.at(-1)!.end)]]);
  settle(db);
  expect(currentScreens(db).every(Boolean)).toBe(true);
  // The fixture's window publication marks the account from its first window on, as a full segmentation does.
  storeWindows(db, [...READINGS, ["2026-09-17T00:00:00.000Z", 25, "2026-09-22T00:00:00.000Z"]]);
  settle(db);
  expect(currentScreens(db).some(Boolean)).toBe(false);
});

test("with the owners known, a ledger change marks only the answers of the accounts owning its source", async () => {
  const { setLedgerAnswerOwners } = await import("../db/window-answers");
  const { ledgerOwnersOf } = await import("./ledger-answer-owners");
  const { rebuildCodexLedgerDay } = await import("../db/codex-price-ledger");
  const db = database();
  ensureWindowAnswersSchema(db);
  settle(db);
  setLedgerAnswerOwners(db, ledgerOwnersOf(db, []));
  const windows = storeScreens(db), first = Date.parse(windows[0]!.start), last = Date.parse(windows.at(-1)!.end);
  // A source no account's period covers: no account's answer is touched.
  markWindowUsageRangesDirty(db, "codex", [[first, last]], [{ source: "codex/elsewhere", identity: null }]);
  expect(currentScreens(db).every(Boolean)).toBe(true);
  // The account's own source: only the windows of the changed instants.
  const hour = Date.parse("2026-09-04T00:00:00.000Z");
  markWindowUsageRangesDirty(db, "codex", [[hour, hour + 3_600_000]], [{ source: "codex/fixture", identity: null }]);
  expect(currentScreens(db)).toEqual(windows.map((_, index) => index !== 0));
  storeScreens(db);
  // A republished pricing day names its sources itself (its instants reach a day to each side: both later weeks).
  db.transaction(() => rebuildCodexLedgerDay(db, "2026-09-15"))();
  expect(currentScreens(db)).toEqual(windows.map((_, index) => index === 0));
  storeScreens(db);
  // A place without a source cannot be told apart: every account's answers over those instants.
  markWindowUsageRangesDirty(db, "codex", [[hour, hour + 3_600_000]], [{ source: null, identity: null }]);
  expect(currentScreens(db)).toEqual(windows.map((_, index) => index !== 0));
  // A Claude session identity names its account wherever the call was recorded.
  const owners = ledgerOwnersOf(db, [{ id: "claude-x", vendor: "claude", account_key: "claude:org:user" }]);
  expect(owners("claude", [{ source: null, identity: "claude:org:user" }], first, last)).toEqual(["claude-x"]);
  expect(owners("codex", [{ source: "codex/fixture", identity: null }, { source: "codex/elsewhere", identity: null }], first, last)).toEqual(["codex1"]);
  setLedgerAnswerOwners(db, null);
});
