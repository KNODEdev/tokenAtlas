import { afterEach, expect, test } from "bun:test";
import type { Database } from "../db/sqlite";
import { ACCOUNT_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { markWindowUsageRangesDirty } from "../db/window-usage";
import { fixtureCodexRateCard } from "./codex-ledger.fixture";
import { advanceWindowUsage, computeWindowUsageFull, CODEX_WINDOW_UNITS_RULE, emptyWindowUsageStats, readWindowSums, type WindowSums } from "./window-usage";
import { addEvent, card, COUNTER, database, opened, publishLedger, READINGS, settle, storeWindows } from "./window-usage-codex.fixture";

// The Codex rail's unit sums (docs/credit-pools-2026-10-09.md, "Kredyty w oknach"): credits of the counted calls, the
// counted sums at the first reading at the limit and the credit-funded calls, kept beside the window sums.
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function table(db: Database): Map<string, WindowSums> {
  return new Map((db.query("SELECT * FROM window_usage ORDER BY window_id").all() as Array<Record<string, string>>).map(row => [
    JSON.stringify([row.provider, row.account, row.counter, row.window_id]),
    { cycle: JSON.parse(row.cycle!), rail: JSON.parse(row.rail!), readings: JSON.parse(row.readings!), slices: JSON.parse(row.slices!) }]));
}
function expectTableIsFull(db: Database, rates = card): Map<string, WindowSums> {
  const full = computeWindowUsageFull(db, { rateCards: rates });
  expect(table(db)).toEqual(full);
  return full;
}
const windowIds = (db: Database) => (db.query("SELECT window_id FROM limit_windows ORDER BY seq").all() as Array<{ window_id: string }>)
  .map(row => row.window_id);
const rail = (db: Database, index: number) => readWindowSums(db, "codex", "codex1", COUNTER, [{ id: windowIds(db)[index]! }], ["rail"])
  .get(windowIds(db)[index]!)!.rail;
/** The second week reaches 100% after two counted calls; the credit-funded call follows. */
const AT_LIMIT: typeof READINGS = [...READINGS.slice(0, 5), ["2026-09-12T02:30:00.000Z", 100, "2026-09-15T00:00:00.000Z"], ...READINGS.slice(5)];

test("a window keeps its credit-funded calls, valued like its counted ones, beside the counted traffic", () => {
  const db = database();
  settle(db);
  expectTableIsFull(db);
  const week = rail(db, 1);
  // One credits call (2026-09-12T03:00): 100k input + 10k output, by the hour; the reserve call stays out of it.
  expect(week.credit_funded).toMatchObject({ calls: 1, tokens: 110_000, credits_unpriced: 0, api_unpriced: 0,
    first: "2026-09-12T03:00:00.000Z", last: "2026-09-12T03:00:00.000Z" });
  expect(week.credit_funded!.credits).toBeGreaterThan(0);
  expect(week.credit_funded!.hours).toEqual([["2026-09-12T03:00:00.000Z", 1, 110_000, week.credit_funded!.credits, week.credit_funded!.api_standard]]);
  // Counted credits: two calls of the same model and size, so twice the credit-funded call's price.
  expect(week.credits!.unpriced_calls).toBe(0);
  expect(week.credits!.standard).toBeCloseTo(2 * week.credit_funded!.credits, 9);
  // No reading reached the limit; the other windows had no credit-funded call.
  expect(week.at_limit).toBeNull();
  expect(rail(db, 0).credit_funded).toBeNull();
  expect(rail(db, 2).credit_funded).toBeNull();
});

test("the sums at the limit are the counted calls up to the first reading at 100%", () => {
  const db = database();
  storeWindows(db, AT_LIMIT);
  settle(db);
  expectTableIsFull(db);
  const week = rail(db, 1);
  expect(week.at_limit).toMatchObject({ ts: "2026-09-12T02:30:00.000Z", percent: 100, events: 2, tokens: 220_000, api_unpriced: 0, credits_unpriced: 0 });
  expect(week.at_limit!.credits).toBeCloseTo(week.credits!.standard, 9);
  expect(week.at_limit!.api_standard).toBeCloseTo(week.api_standard, 9);
  expect([week.at_limit!.joint_api_standard, week.at_limit!.joint_credits]).toEqual([week.at_limit!.api_standard, week.at_limit!.credits]);
});

test("a credit-funded call added later recomputes only its window, equal to the full reference", () => {
  const db = database();
  storeWindows(db, AT_LIMIT);
  settle(db);
  const before = table(db);
  addEvent(db, { ts: "2026-09-13T05:00:00.000Z", billing: "credits", input: 50_000 });
  publishLedger(db, card);
  db.query("DELETE FROM window_usage_dirty").run();
  markWindowUsageRangesDirty(db, "codex", [[Date.parse("2026-09-13T05:00:00.000Z"), Date.parse("2026-09-13T06:00:00.000Z")]]);
  expect(settle(db).windows).toBe(1);
  const after = expectTableIsFull(db);
  const changed = [...after].filter(([key, sums]) => JSON.stringify(sums) !== JSON.stringify(before.get(key)));
  expect(changed.map(([key]) => JSON.parse(key)[3])).toEqual([windowIds(db)[1]]);
  expect(rail(db, 1).credit_funded).toMatchObject({ calls: 2, tokens: 170_000, last: "2026-09-13T05:00:00.000Z" });
  expect(rail(db, 1).credit_funded!.hours.map(hour => hour[0])).toEqual(["2026-09-12T03:00:00.000Z", "2026-09-13T05:00:00.000Z"]);
  // The counted traffic and its sums at the limit do not move.
  expect(rail(db, 1).at_limit).toEqual(JSON.parse(JSON.stringify(before.get(JSON.stringify(["codex", "codex1", COUNTER, windowIds(db)[1]])))).rail.at_limit);
});

test("a restart does no work; a new units rule queues Codex windows only", () => {
  const db = database();
  settle(db);
  const stats = emptyWindowUsageStats();
  expect(advanceWindowUsage(db, { rateCards: card, budgetMs: 1e9, stats })).toEqual({ progressed: false, pending: false });
  expect(stats.windows).toBe(0);
  expect(db.query("SELECT value FROM meta WHERE key='window_usage_codex_units'").get()).toEqual({ value: CODEX_WINDOW_UNITS_RULE });
  // Rows stored under an earlier rule: the next turn queues every Codex window and nothing of another provider.
  db.query("UPDATE meta SET value='older' WHERE key='window_usage_codex_units'").run();
  advanceWindowUsage(db, { rateCards: card, budgetMs: 0, canWrite: () => true });
  const queued = db.query("SELECT DISTINCT provider FROM window_usage_pending UNION SELECT DISTINCT provider FROM window_usage_dirty").all();
  expect(queued).toEqual([{ provider: "codex" }]);
  settle(db);
  expectTableIsFull(db);
});

test("a period correction moves credit-funded calls with the account; a price change revalues them", () => {
  const db = database();
  settle(db);
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, [
    { provider: "codex", subject: "codex/fixture", from: "2000-01-01", until: "2026-09-12", value: "codex1",
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" },
    { provider: "codex", subject: "codex/fixture", from: "2026-09-12", until: null, value: "codex2",
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
  expect(db.query("SELECT DISTINCT account FROM window_usage_dirty ORDER BY account").all()).toEqual([{ account: "codex1" }, { account: "codex2" }]);
  settle(db);
  expectTableIsFull(db);
  expect(rail(db, 1).credit_funded).toBeNull();
  const priced = rail(db, 1).credits!.standard;
  const dearer = fixtureCodexRateCard({ ...card, codex_accounting: undefined, vendors: { openai: { models: {
    "gpt-6-astra": { in_uncached: 6, in_cache_read: 0.6, out_total: 30 },
    "gpt-5.3-codex-spark": { in_uncached: 1, in_cache_read: 0.1, out_total: 5 },
    "gpt-reserve": { in_uncached: 1, in_cache_read: 0.1, out_total: 5 },
  } } } });
  publishLedger(db, dearer);
  settle(db, dearer);
  expectTableIsFull(db, dearer);
  // Credits follow the credit rate card, not API dollars: the API value doubles, the credit price stays.
  expect(rail(db, 1).credits!.standard).toBeCloseTo(priced, 9);
});
