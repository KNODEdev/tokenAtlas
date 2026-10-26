import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database as SqliteDatabase, type Database } from "../db/sqlite";
import { markWindowUsageDirty, markWindowUsageRangesDirty, WINDOW_USAGE_INTERVALS_SCHEMA_SQL, WINDOW_USAGE_SCHEMA_SQL } from "../db/window-usage";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { fixtureCodexRateCard } from "./codex-ledger.fixture";
import { rebuildCodexLedgerDay, rebuildCodexLedgerPartitions } from "../db/codex-price-ledger";
import {
  advanceWindowUsage, claudeHourBlocks, computeWindowUsageFull, intervalSums, readWindowSums, referenceFingerprint, windowEventReader, windowSumsFromLedgers,
  tokensByLocalDay, windowUsageProgress, WindowUsagePreparing, type WindowSums,
} from "./window-usage";
import { loadAccountResolver } from "./account-resolver";
import { limitWindowFromRow, type LimitWindowRow } from "../db/limit-windows";
import { addEvent, card, COUNTER, database, opened, publishLedger, READINGS, settle, storeWindows } from "./window-usage-codex.fixture";

const HOUR = 3_600_000;
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function table(db: Database): Map<string, WindowSums> {
  return new Map((db.query("SELECT * FROM window_usage ORDER BY window_id").all() as Array<Record<string, string>>).map(row => [
    JSON.stringify([row.provider, row.account, row.counter, row.window_id]),
    { cycle: JSON.parse(row.cycle!), rail: JSON.parse(row.rail!), readings: JSON.parse(row.readings!), slices: JSON.parse(row.slices!) }]));
}
/** Incremental result = every window computed from the ledgers at once. */
function expectTableIsFull(db: Database, rates = card): Map<string, WindowSums> {
  const full = computeWindowUsageFull(db, { rateCards: rates });
  expect(table(db)).toEqual(full);
  return full;
}
const windowsOf = (db: Database) => db.query("SELECT window_id id,start_ts start,end_ts end FROM limit_windows ORDER BY seq").all() as
  Array<{ id: string; start: string; end: string }>;

test("the migrations create the schema the producer ensures", () => {
  // 0051 created the window tables, 0052 the interval table; 0055 rebuilt it with more kinds and 0056 added the
  // reference variant: the migrated tables are the ensured ones.
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim()
    .replace(/^CREATE TABLE (IF NOT EXISTS )?"?(window_usage\w*?)(_next)?"? /, "CREATE TABLE $2 ");
  const migrated = new SqliteDatabase(":memory:"), ensured = new SqliteDatabase(":memory:");
  try {
    for (const file of ["0051_window_usage.sql", "0052_window_usage_intervals.sql", "0055_window_usage_interval_kinds.sql",
      "0056_window_usage_reference.sql"])
      for (const statement of fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle", file), "utf8").split("--> statement-breakpoint"))
        migrated.exec(statement);
    ensured.exec(WINDOW_USAGE_SCHEMA_SQL);
    ensured.exec(WINDOW_USAGE_INTERVALS_SCHEMA_SQL);
    const shape = (db: SqliteDatabase) => ["window_usage", "window_usage_pending", "window_usage_dirty", "window_usage_intervals"].map(table => ({
      table, columns: db.query(`PRAGMA table_xinfo(${table})`).all(), keys: db.query(`PRAGMA index_list(${table})`).all() }));
    expect(shape(migrated)).toEqual(shape(ensured));
    // The interval kinds the producer writes are the ones the migrated CHECK admits.
    const check = (db: SqliteDatabase) => normalize((db.query("SELECT sql FROM sqlite_master WHERE name='window_usage_intervals'").get() as
      { sql: string }).sql).match(/CHECK\(kind IN \([^)]*\)\)/)?.[0];
    expect(check(migrated)).toBe(check(ensured));
  } finally { migrated.close(); ensured.close(); }
});

test("every window gets canonical full-cycle and paired sums, exclusions, rail fields and running sums", () => {
  const db = database();
  expect(() => readWindowSums(db, "codex", "codex1", COUNTER, windowsOf(db), ["cycle"])).toThrow(WindowUsagePreparing);
  settle(db);
  const full = expectTableIsFull(db);
  expect(full.size).toBe(3);
  expect(windowUsageProgress(db)).toEqual({ done: 3, total: 3 });
  const [first, second, open] = windowsOf(db);
  const sums = readWindowSums(db, "codex", "codex1", COUNTER, [first!, second!, open!], ["cycle", "rail", "readings", "slices"]);
  const week = sums.get(second!.id)!;
  // Two allowance calls count; Spark, reserve, credits and the other reset are explicit exclusions, never dropped.
  expect(week.cycle.cycle_usage.events).toBe(2);
  expect(week.cycle.evidence.excluded_events).toMatchObject({ counter: 1, funding: 2, reset: 1 });
  expect(week.cycle.excluded.map(bucket => [bucket.reason, bucket.model, bucket.usage.events])).toEqual([
    ["counter", "gpt-5.3-codex-spark", 1], ["funding", "gpt-6-astra", 1], ["funding", "gpt-reserve", 1], ["reset", "gpt-6-astra", 1]]);
  expect(week.cycle.sources.map(source => source.name).sort()).toEqual(["/archive", "/laptop"]);
  expect(week.rail.tokens).toBe(220_000);
  expect(week.rail.api_standard).toBeGreaterThan(0);
  expect(week.rail.activity.at(-1)).toEqual({ t: 100, amount: 220_000 });
  // Hourly sums hold the same counted tokens; local days are their regrouping.
  expect(week.rail.hours!.reduce((total, [, tokens]) => total + tokens, 0)).toBe(220_000);
  expect(tokensByLocalDay(week.rail)!.reduce((total, day) => total + day.tokens, 0)).toBe(220_000);
  // Running sums at each reading: the reading at 40% has the call before it, the one at 80% both.
  expect(week.readings.map(reading => reading.usage.events)).toEqual([0, 1, 2]);
  expect(intervalSums(week, week.readings[1]!.ts, week.readings[2]!.ts)).toMatchObject({ usage: { events: 1 }, homes: ["/laptop"] });
  expect(week.slices.reduce((total, slice) => total + slice.tokens.out_total, 0)).toBe(20_000);
  expect(sums.get(open!.id)!.cycle.cycle_usage.events).toBe(1);
});

test("a new or late event recomputes only the windows covering its instant", () => {
  const db = database();
  settle(db);
  // The ledger producer marks the hours it republished; a late call in the first week touches only that week.
  addEvent(db, { ts: "2026-09-04T00:00:00.000Z" });
  publishLedger(db, card);
  db.query("DELETE FROM window_usage_dirty").run();
  markWindowUsageRangesDirty(db, "codex", [[Date.parse("2026-09-04T00:00:00.000Z"), Date.parse("2026-09-04T01:00:00.000Z")]]);
  const stats = settle(db);
  expect(stats.windows).toBe(1);
  const full = expectTableIsFull(db);
  expect(full.get(JSON.stringify(["codex", "codex1", COUNTER, windowsOf(db)[0]!.id]))!.cycle.cycle_usage.events).toBe(3);
  // A new call in the open window, through the ledger's own publication hook.
  addEvent(db, { ts: "2026-09-16T06:00:00.000Z" });
  publishLedger(db, card);
  settle(db);
  expectTableIsFull(db);
});

test("a new reading republishes the open window and its running sums", () => {
  const db = database();
  settle(db);
  storeWindows(db, [...READINGS, ["2026-09-17T00:00:00.000Z", 25, "2026-09-22T00:00:00.000Z"]]);
  settle(db);
  const full = expectTableIsFull(db);
  const open = full.get(JSON.stringify(["codex", "codex1", COUNTER, windowsOf(db)[2]!.id]))!;
  expect(open.readings.map(reading => reading.ts).at(-1)).toBe("2026-09-17T00:00:00.000Z");
  expect(open.cycle.usage.events).toBe(1);
});

for (const operation of ["change", "remove"] as const) test(`bounded ${operation} of an earlier overlapping window refreshes its dependent sums only`, () => {
  const db = database();
  // The later window overlaps the first; the third has no dependency on either.
  db.query("UPDATE limit_windows SET start_ts='2026-09-07T00:00:00.000Z' WHERE seq=1").run();
  addEvent(db, { ts: "2026-09-07T12:00:00.000Z" });
  publishLedger(db, card);
  settle(db);
  const before = expectTableIsFull(db), [earlier, later, unrelated] = windowsOf(db);
  const unrelatedKey = JSON.stringify(["codex", "codex1", COUNTER, unrelated!.id]);
  if (operation === "remove") db.query("DELETE FROM limit_windows WHERE seq=0").run();
  else db.query("UPDATE limit_windows SET end_ts='2026-09-07T14:00:00.000Z' WHERE seq=0").run();
  // The producer marks old and new bounds. The old bounds cover this shrinking change.
  markWindowUsageDirty(db, { provider: "codex", account: "codex1", counter: COUNTER,
    fromMs: Date.parse(earlier!.start), untilMs: Date.parse(earlier!.end) });
  const stats = settle(db);
  expect(stats.windows).toBe(operation === "remove" ? 1 : 2);
  const full = expectTableIsFull(db);
  expect(full.has(JSON.stringify(["codex", "codex1", COUNTER, later!.id]))).toBe(true);
  expect(full.get(unrelatedKey)).toEqual(before.get(unrelatedKey));
});

test("a changed account period moves traffic between the two accounts' windows without repricing", () => {
  const db = database();
  settle(db);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [
    { provider: "codex", subject: "codex/fixture", from: "2000-01-01", until: "2026-09-11", value: "codex1",
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" },
    { provider: "codex", subject: "codex/fixture", from: "2026-09-11", until: null, value: "codex2",
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
  expect(db.query("SELECT account FROM window_usage_dirty ORDER BY account").all()).toEqual([{ account: "codex1" }, { account: "codex2" }]);
  const stats = settle(db);
  expect(stats.windows).toBe(2);
  const full = expectTableIsFull(db);
  expect(full.get(JSON.stringify(["codex", "codex1", COUNTER, windowsOf(db)[1]!.id]))!.cycle.cycle_usage.events).toBe(1);
});

test("a price change recomputes the windows of the repriced calls", () => {
  const db = database();
  settle(db);
  const before = table(db);
  const cheaper = fixtureCodexRateCard({ ...card, codex_accounting: undefined, vendors: { openai: { models: {
    "gpt-6-astra": { in_uncached: 1.5, in_cache_read: 0.15, out_total: 7.5 },
    "gpt-5.3-codex-spark": { in_uncached: 1, in_cache_read: 0.1, out_total: 5 },
    "gpt-reserve": { in_uncached: 1, in_cache_read: 0.1, out_total: 5 },
  } } } });
  publishLedger(db, cheaper);
  settle(db, cheaper);
  const after = expectTableIsFull(db, cheaper);
  for (const [key, sums] of after) if (sums.rail.tokens) expect(sums.rail.api_standard).toBeLessThan(before.get(key)!.rail.api_standard);
});

test("ledger publications mark the instants whose sums changed", () => {
  const db = database();
  settle(db);
  const hour = Date.parse("2026-09-12T00:00:00.000Z") / HOUR;
  db.transaction(() => {
    rebuildCodexLedgerPartitions(db, [{ day: "2026-09-12", dimId: 1, hour }, { day: "2026-09-12", dimId: 1, hour: hour + 1 },
      { day: "2026-09-12", dimId: 2, hour: null }]);
    rebuildCodexLedgerDay(db, "2026-09-02");
  })();
  expect(db.query("SELECT provider,account,counter,from_ms,until_ms FROM window_usage_dirty ORDER BY from_ms").all()).toEqual([
    { provider: "codex", account: "*", counter: "*", from_ms: Date.parse("2026-09-01T00:00:00.000Z"), until_ms: Date.parse("2026-09-04T00:00:00.000Z") },
    { provider: "codex", account: "*", counter: "*", from_ms: hour * HOUR, until_ms: (hour + 2) * HOUR }]);
  // Hours of the second week only: its window is recomputed, the first week's by the day entry.
  expect(settle(db).windows).toBe(2);
});

test("a vanished window loses its row; readers never read the ledger", () => {
  const db = database();
  settle(db);
  storeWindows(db, READINGS.slice(0, 6));
  settle(db);
  expectTableIsFull(db);
  expect(windowUsageProgress(db)).toEqual({ done: 2, total: 2 });
  // Reading sums is a row lookup: without the ledger tables it still answers.
  db.exec("DROP TABLE codex_price_ledger_aggregates; DROP TABLE codex_price_ledger_events");
  expect(readWindowSums(db, "codex", "codex1", COUNTER, windowsOf(db), ["rail"]).size).toBe(2);
});

test("a first fill in turns of one window stores the rows of one long turn and of the reference", () => {
  const short = database(), long = database();
  for (let turn = 0; turn < 100; turn++) {
    if (!advanceWindowUsage(short, { rateCards: card, budgetMs: 0 }).pending) break;
  }
  settle(long);
  expect(table(short)).toEqual(table(long));
  expectTableIsFull(short);
});

test("Codex rows carry the reference-day variant, the calls valued at that day's coefficients when read", () => {
  const db = database();
  const produce = (referenceDay: string) => {
    for (let turn = 0; turn < 1000; turn++) {
      const result = advanceWindowUsage(db, { rateCards: card, budgetMs: 1e9, referenceDay });
      if (!result.pending || !result.progressed) return;
    }
  };
  const references = () => (db.query("SELECT window_id,reference FROM window_usage ORDER BY window_id").all() as Array<{ window_id: string; reference: string | null }>)
    .map(row => [row.window_id, row.reference === null ? null : (JSON.parse(row.reference) as { day: string }).day]);
  produce("2026-09-20");
  expect(references().every(([, day]) => day === "2026-09-20")).toBe(true);
  // The stored variant is the bounded valuation of the same window at that day; the ordinary cycle is unchanged.
  const rows = db.query("SELECT * FROM limit_windows ORDER BY seq").all() as LimitWindowRow[];
  const windows = rows.map(limitWindowFromRow), last = windows.at(-1)!;
  const stored = readWindowSums(db, "codex", "codex1", COUNTER, [last], ["cycle", "reference"]).get(last.id)!;
  const bounded = windowSumsFromLedgers(windowEventReader(db, card, loadAccountResolver(db), "2026-09-20"), card, "codex", last,
    windows.slice(0, -1), { referenceDay: "2026-09-20" }).sums;
  expect(stored.reference).toEqual({ day: "2026-09-20", fingerprint: referenceFingerprint(card, "codex", "2026-09-20"), cycle: bounded.cycle });
  expect(stored.reference!.cycle.cycle_usage.reference_api_standard).toBeGreaterThan(0);
  expect(stored.cycle.cycle_usage.reference_api_standard).toBeUndefined();
  expect(stored.cycle).toEqual(computeWindowUsageFull(db, { rateCards: card }).get(JSON.stringify(["codex", "codex1", COUNTER, last.id]))!.cycle);
  // A new day with the same coefficients keeps every row: the variant answers both days.
  const before = db.query("SELECT window_id,cycle,reference FROM window_usage ORDER BY window_id").all();
  produce("2026-09-21");
  expect(db.query("SELECT window_id,cycle,reference FROM window_usage ORDER BY window_id").all()).toEqual(before);
  expect(referenceFingerprint(card, "codex", "2026-09-21")).toBe(referenceFingerprint(card, "codex", "2026-09-20"));
});

test("Claude hour blocks value each hour at its reading interval's stored dollars per token", () => {
  const spend = (tokens: number, actual: number, unpriced = 0) => ({ model: "claude-opus", events: 1, tokens, fresh: 0,
    standard: actual, standard_unpriced: unpriced, actual, actual_unpriced: unpriced });
  const reading = (ts: string, tokens: number, actual: number) => ({ ts, usage: {} as WindowSums["readings"][number]["usage"],
    homes: [], models: [], spend: [spend(tokens, actual)] });
  const hours: Array<[string, number]> = [["2026-10-11T10:00:00.000Z", 100], ["2026-10-11T11:00:00.000Z", 100], ["2026-10-11T13:00:00.000Z", 50]];
  // 200 tokens for $2 before the 12:00 reading; the 50 after it carry the rest of the cycle: $3.
  const blocks = claudeHourBlocks({ hours }, [reading("2026-10-11T12:00:00.000Z", 200, 2)], [spend(250, 5, 1)])!;
  expect(blocks.map(block => [block.start_ts.slice(11, 13), block.end_ts.slice(11, 13), block.tokens, block.usd, block.usd_partial ?? false]))
    .toEqual([["10", "11", 100, 1, false], ["11", "12", 100, 1, false], ["13", "14", 50, 3, true]]);
  expect(claudeHourBlocks({}, [], [])).toBeNull();
});
