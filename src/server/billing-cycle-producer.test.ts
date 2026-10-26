import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { markWindowAnswersDirty } from "../db/window-answers";
import type { DatedPeriod } from "./account-periods";
import { CATALOG, D, H, MAIN, FIVE, MONTH, NOW, addWindow, iso, database, seed } from "./billing-cycles.fixture";
import { BILLING_CYCLES_VERSION, advanceBillingCycles, billingCyclesStale, computeBillingCyclesFull, resetBillingCycleClock, withUnseenTraffic, type StoredCycleRow } from "./billing-cycle-producer";
import { advanceWindowPointValues } from "./window-point-values";
import { advanceWindowEndCauses } from "./window-end-causes";

const declared = (account: string, plan: string, from: string, until: string | null, extra: Partial<DatedPeriod> = {}): DatedPeriod => ({
  provider: "codex", subject: account, from, until, value: plan, origin: "declared", firstSeen: null, lastSeen: null, readings: 0,
  evidence: "payment", ...extra });
const stored = (db: Database) => db.query("SELECT * FROM billing_cycles ORDER BY provider, account, start_ts").all() as StoredCycleRow[];
const withoutClock = (rows: StoredCycleRow[]) => rows.map(({ computed_at: _computed, ...row }) => row);
/**
 * The full derivation each stored row must equal: computed at the row's own instant, since a current cycle's to-date part
 * is stored as of its computation (an untouched account keeps the one it had).
 */
const reference = (db: Database, rows: StoredCycleRow[]) => withoutClock(rows.map((row) =>
  computeBillingCyclesFull(db, { catalog: CATALOG, now: Date.parse(row.computed_at) }).find((full) => full.account === row.account && full.start_ts === row.start_ts)!));
function settle(db: Database, now = NOW) {
  for (let i = 0; i < 20; i++) {
    // The point values run before the cycles in the background turn (background-jobs.ts).
    advanceWindowPointValues(db, { plans: { capacity_regimes: [] }, catalog: CATALOG, now, budgetMs: 10_000 });
    advanceWindowEndCauses(db, { now, budgetMs: 10_000, overrides: [] });
    const turn = advanceBillingCycles(db, { catalog: CATALOG, now, budgetMs: 10_000 });
    if (!turn?.pending) return;
  }
  throw new Error("producer did not settle");
}

test("the first turn fills every account; the stored rows equal the full derivation", () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  settle(db);
  const rows = stored(db);
  expect(rows.map((row) => [row.account, row.start_ts.slice(0, 16), row.end_ts.slice(0, 16), row.basis, row.is_current])).toEqual([
    ["codex1", "2026-08-31T06:00", "2026-09-30T06:00", "observed", 0],
    ["codex1", "2026-09-30T06:00", "2026-10-31T06:00", "observed", 1],
    ["codex2", "2026-08-31T06:00", "2026-09-30T06:00", "observed", 0],
    ["codex2", "2026-09-30T06:00", "2026-10-31T06:00", "observed", 1],
  ]);
  expect(withoutClock(rows)).toEqual(withoutClock(computeBillingCyclesFull(db, { catalog: CATALOG, now: NOW })));
  const first = rows[0]!;
  expect(first.counter).toBe(MAIN);
  expect(first.amount_minor).toBe(20000);
  expect(first.capacity_usd).toBeNull();
  expect(JSON.parse(first.flags)).toContain("anchor_uncertain");
  // The 5 h counter is shown beside the main one, never summed into it.
  expect(JSON.parse(first.detail).others.map((o: { counter: string }) => o.counter)).toEqual([FIVE]);
  expect(billingCyclesStale(db, { provider: "codex", account: "codex1" }, NOW)).toBe(false);
});

test("a resized allowance keeps one capacity period and uses the new meter's own baseline", () => {
  const db = database();
  try {
    const start = Date.parse("2026-09-01T00:00:00Z"), change = start + D, end = start + 7 * D;
    replaceDeclaredPeriods(db, PLAN_PERIODS, [declared("resized", "pro", iso(start), iso(end))]);
    addWindow(db, "resized", MAIN, start, change, 20, 20);
    addWindow(db, "resized", MAIN, change, end, 90, 10);
    db.query("UPDATE limit_windows SET reset_ts=?,cycle_end_basis='capacity_change' WHERE account='resized' AND start_ts=?")
      .run(iso(end), iso(start));
    db.query("UPDATE limit_windows SET activity=?,readings=? WHERE account='resized' AND start_ts=?").run(
      JSON.stringify({ plan: "pro", spans: [{ start: iso(change), end: iso(end) }], start_basis: "partial",
        capacity_change: { before: 400, after: 100 } }),
      JSON.stringify([{ ts: iso(change), percent: 80, source: "probe" }, { ts: iso(end - H), percent: 90, source: "probe" }]), iso(change));
    settle(db);
    const cycle = stored(db).find(row => row.account === "resized")!;
    expect(cycle.used_pp).toBe(30); // 20 old points and 10 new points, not a spurious 70-point rise.
    expect(cycle.windows_share).toBe(1);
    expect(JSON.parse(cycle.detail).early_resets).toBe(0);
    expect(withoutClock([cycle])).toEqual(reference(db, [cycle]));
  } finally { db.close(); }
});

test("a new % reading recomputes only the account and cycle it falls in; the result equals the full derivation", () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  settle(db);
  const before = stored(db);
  // The current window of codex2 gets a reading: its writers mark the window screens of codex2 for that range.
  const window = db.query("SELECT window_id, readings FROM limit_windows WHERE account='codex2' AND counter=? ORDER BY start_ts DESC LIMIT 1").get(MAIN) as { window_id: string; readings: string };
  const readings = [...JSON.parse(window.readings), { ts: iso(NOW - H), percent: 99, source: "probe" }];
  db.transaction(() => {
    db.query("UPDATE limit_windows SET readings=? WHERE account='codex2' AND window_id=?").run(JSON.stringify(readings), window.window_id);
    markWindowAnswersDirty(db, { provider: "codex", account: "codex2", fromMs: NOW - 2 * H, untilMs: NOW });
  })();
  expect(billingCyclesStale(db, { provider: "codex", account: "codex2" }, NOW)).toBe(true);
  expect(billingCyclesStale(db, { provider: "codex", account: "codex1" }, NOW)).toBe(false);
  const later = NOW + 60_000;
  settle(db, later);
  const after = stored(db);
  const changed = after.filter((row, i) => row.computed_at !== before[i]!.computed_at).map((row) => [row.account, row.start_ts.slice(0, 10)]);
  expect(changed).toEqual([["codex2", "2026-09-30"]]);
  expect(after.find((row) => row.account === "codex2" && row.is_current)!.used_pp).toBeGreaterThan(before.find((row) => row.account === "codex2" && row.is_current)!.used_pp!);
  expect(withoutClock(after)).toEqual(reference(db, after));
  expect(after.length).toBe(computeBillingCyclesFull(db, { catalog: CATALOG, now: later }).length);
});

test("a declared anchor of one account recomputes only that account's cycles; the other keeps its rows", () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  settle(db);
  const before = stored(db);
  replaceDeclaredPeriods(db, PLAN_PERIODS, [declared("codex1", "pro", "2026-08-31T06:00:00.000Z", null, { anchor: "2026-09-12T00:00:00.000Z", amountMinor: 18000, currency: "EUR" })]);
  expect(db.query("SELECT provider, account FROM billing_cycle_dirty").all()).toEqual([{ provider: "codex", account: "codex1" }]);
  const later = NOW + 30_000;
  settle(db, later);
  const after = stored(db);
  expect(after.filter((row) => row.account === "codex2")).toEqual(before.filter((row) => row.account === "codex2"));
  expect(after.filter((row) => row.account === "codex1").map((row) => [row.start_ts.slice(0, 10), row.end_ts.slice(0, 10), row.basis, row.amount_minor, row.currency]))
    .toEqual([["2026-08-31", "2026-09-12", "declared", 18000, "EUR"], ["2026-09-12", "2026-10-12", "declared", 20000, "USD"]]);
  expect(withoutClock(after)).toEqual(reference(db, after));
  expect(after.length).toBe(computeBillingCyclesFull(db, { catalog: CATALOG, now: later }).length);
});

test("a paid cycle reads the weekly counter and a Free cycle the 30-day one, though the Free meter's window is longer", () => {
  const db = database();
  seed(db);
  // codex1 was on Free before: two 30-day windows carrying "free", one of them running into the first paid cycle.
  addWindow(db, "codex1", MONTH, Date.parse("2026-07-20T06:00:00Z"), Date.parse("2026-08-19T06:00:00Z"), 60, 0, "free");
  addWindow(db, "codex1", MONTH, Date.parse("2026-08-19T06:00:00Z"), Date.parse("2026-09-18T06:00:00Z"), 10, 0, "free");
  replaceDeclaredPeriods(db, PLAN_PERIODS, [declared("codex1", "free", "2026-07-20T06:00:00.000Z", "2026-08-31T06:00:00.000Z"),
    declared("codex1", "pro", "2026-08-31T06:00:00.000Z", null, { amountMinor: 20000, currency: "USD" })]);
  resetBillingCycleClock();
  settle(db);
  const rows = stored(db).filter((row) => row.account === "codex1");
  expect(rows.map((row) => [row.start_ts.slice(0, 10), row.plan, row.counter])).toEqual([
    ["2026-07-20", "free", MONTH], ["2026-08-20", "free", MONTH], ["2026-08-31", "pro", MAIN], ["2026-09-30", "pro", MAIN]]);
  const paid = rows.find((row) => row.start_ts.startsWith("2026-08-31"))!;
  expect(paid.windows_touched).toBeGreaterThan(0);
  expect(paid.used_pp).not.toBeNull();
  expect(JSON.parse(paid.flags)).not.toContain("no_windows");
  // The 30-day counter is listed beside the weekly one, never summed into it.
  expect(JSON.parse(paid.detail).others.map((o: { counter: string }) => o.counter).sort()).toEqual([MONTH, FIVE].sort());
  expect(rows.find((row) => row.start_ts.startsWith("2026-07-20"))!.windows_touched).toBeGreaterThan(0);
  for (const row of rows.filter(row => row.plan === "free")) {
    expect(row.amount_minor).toBe(0);
    expect(JSON.parse(row.detail).price_usd).toBe(0);
  }
  // The other account never had the Free meter: unchanged.
  expect(stored(db).filter((row) => row.account === "codex2").every((row) => row.counter === MAIN)).toBe(true);
  expect(withoutClock(stored(db))).toEqual(withoutClock(computeBillingCyclesFull(db, { catalog: CATALOG, now: NOW })));
  const beforeRestart = stored(db), changes = db.query("SELECT total_changes() AS n").get();
  resetBillingCycleClock();
  settle(db);
  expect(stored(db)).toEqual(beforeRestart);
  expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
});

test("a restart, a repeated turn and an unchanged clock minute write nothing", () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  settle(db);
  const before = stored(db);
  resetBillingCycleClock();
  const turn = advanceBillingCycles(db, { catalog: CATALOG, now: NOW + 5_000, budgetMs: 10_000 });
  expect(turn).toEqual({ progressed: false, pending: false, accounts: 0, cycles: 0 });
  expect(stored(db)).toEqual(before);
});

test("the clock rolls the current cycle over: the next turn stores the new cycle without any new reading", () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  settle(db);
  const next = Date.parse("2026-10-31T07:00:00Z");
  expect(billingCyclesStale(db, { provider: "codex", account: "codex1" }, next)).toBe(true);
  resetBillingCycleClock();
  settle(db, next);
  expect(stored(db).filter((row) => row.account === "codex1").map((row) => [row.start_ts.slice(0, 10), row.is_current]))
    .toEqual([["2026-08-31", 0], ["2026-09-30", 0], ["2026-10-31", 1]]);
});

test("an ended window whose % rose with no stored call leaves the cycle's usage unknown, never 0; an open one waits", () => {
  const db = database();
  seed(db);
  const noCalls = (account: string, start: string) => db.query(`UPDATE window_usage SET cycle=json_set(cycle, '$.usage.events', 0, '$.usage.api_standard', 0)
    WHERE account=? AND counter=? AND start_ts=?`).run(account, MAIN, start);
  // codex2: its ended window of the current cycle counts no call (used where this machine does not see).
  noCalls("codex2", "2026-09-30T06:00:00.000Z");
  // codex1: only its open window counts no call yet (its calls may still be on their way).
  db.query(`UPDATE window_usage SET cycle=json_set(cycle, '$.usage.events', 7) WHERE account='codex1'`).run();
  noCalls("codex1", "2026-10-07T18:00:00.000Z");
  resetBillingCycleClock();
  settle(db);
  const rows = stored(db), current = (account: string) => rows.find((row) => row.account === account && row.is_current === 1)!;
  expect(JSON.parse(current("codex2").flags)).toContain("window_traffic_unseen");
  expect(current("codex2").api_usd).toBeNull();
  expect(JSON.parse(current("codex2").detail).used_units).toBeNull();
  expect(current("codex2").used_pp).not.toBeNull();
  expect(JSON.parse(current("codex1").flags)).not.toContain("window_traffic_unseen");
  expect(current("codex1").api_usd).not.toBeNull();
  expect(withoutClock(rows)).toEqual(reference(db, rows));
});

test("partial-traffic accounts (Claude's scope) keep their usage as a lower bound: the unseen-traffic rule does not apply", () => {
  const db = database();
  seed(db);
  db.query(`UPDATE window_usage SET cycle=json_set(cycle, '$.usage.events', 0, '$.usage.api_standard', 0)
    WHERE account='codex2' AND counter=? AND start_ts='2026-09-30T06:00:00.000Z'`).run(MAIN);
  advanceWindowPointValues(db, { plans: { capacity_regimes: [] }, catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  db.query("UPDATE window_point_values SET scope='observed_partial_traffic' WHERE account='codex2'").run();
  resetBillingCycleClock();
  settle(db);
  const row = stored(db).find((entry) => entry.account === "codex2" && entry.is_current === 1)!;
  expect(JSON.parse(row.flags)).not.toContain("window_traffic_unseen");
  expect(row.api_usd).not.toBeNull();
});

test("a rise of at least 5 points under a tenth of its calibrated value is traffic this machine did not see", () => {
  const window = (start: number, final: number, apiUsd: number, events = 10) => ({ start, end: start + 7 * D, basis: "reset", finalPercent: final, apiUsd,
    detail: () => ({ percents: [], running: [] }), usage: {}, events, firstPercent: 0, trafficUnseen: undefined as boolean | undefined });
  const [low, fair, small, open] = withUnseenTraffic([window(0, 50, 0.09), window(7 * D, 50, 20), window(14 * D, 4, 0.01), window(NOW, 50, 0)],
    0.5, () => 1, NOW);
  expect(low!.trafficUnseen).toBe(true);
  expect(low!.apiUsd as number | null).toBeNull();
  expect(fair!.trafficUnseen).toBeUndefined();
  expect(small!.trafficUnseen).toBeUndefined();
  expect(open!.trafficUnseen).toBeUndefined();
  // Without a calibration only a rise with no stored call counts.
  expect(withUnseenTraffic([window(0, 50, 0.09)], null, () => 1, NOW)[0]!.trafficUnseen).toBeUndefined();
  expect(withUnseenTraffic([window(0, 50, 0, 0)], null, () => 1, NOW)[0]!.trafficUnseen).toBe(true);
});


test("prior pricing rules become stale and the background producer replaces their stored prices", () => {
  const db = database();
  try {
    seed(db);
    resetBillingCycleClock();
    settle(db);
    const expected = withoutClock(stored(db));
    db.exec("UPDATE meta SET value='14' WHERE key='billing_cycles_rules'; UPDATE billing_cycles SET amount_minor=120000");
    expect(billingCyclesStale(db, { provider: "codex", account: "codex1" }, NOW)).toBe(true);
    expect(stored(db).every(row => row.amount_minor === 120000)).toBe(true);
    settle(db);
    expect(withoutClock(stored(db))).toEqual(expected);
    expect(db.query("SELECT value FROM meta WHERE key='billing_cycles_rules'").get()).toEqual({ value: String(BILLING_CYCLES_VERSION) });
    expect(billingCyclesStale(db, { provider: "codex", account: "codex1" }, NOW)).toBe(false);
    resetBillingCycleClock();
    expect(advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 }))
      .toEqual({ progressed: false, pending: false, accounts: 0, cycles: 0 });
  } finally { db.close(); }
});


test("a manual end correction moves only the holding cycle's reset kind and equals a full derivation", () => {
  const db = database(); seed(db);
  // A real early reset in September, with a bonus wholly inside that billing cycle.
  db.query("UPDATE limit_windows SET reset_ts=? WHERE account='codex1' AND counter=? AND seq=1")
    .run("2026-09-17T18:00:00.000Z", MAIN);
  resetBillingCycleClock(); settle(db);
  const before = stored(db);
  const end = db.query("SELECT window_start, cause, bonus FROM window_end_causes WHERE account='codex1' AND counter=? AND window_end='2026-09-14T18:00:00.000Z'")
    .get(MAIN) as { window_start: string; cause: string; bonus: number };
  expect(end.bonus).toBeGreaterThan(0);
  const cause = end.cause === "banked" ? "provider" : "banked";
  const chosen = [{ provider: "codex", account: "codex1", counter: MAIN, window_start: end.window_start, cause, updated_at: iso(NOW) }] as const;
  const later = NOW + 1000;
  expect(advanceWindowEndCauses(db, { now: later, budgetMs: 10_000, overrides: chosen })!.written).toBe(1);
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: later, budgetMs: 10_000 })?.pending; i++);
  const after = stored(db);
  expect(after.filter((row, i) => row.computed_at !== before[i]!.computed_at).map((row) => [row.account, row.start_ts]))
    .toEqual([["codex1", "2026-08-31T06:00:00.000Z"]]);
  expect(after.filter((row) => row.account !== "codex1" || row.is_current)).toEqual(before.filter((row) => row.account !== "codex1" || row.is_current));
  expect(JSON.parse(after[0]!.detail).resets[cause].windows).toBeGreaterThan(0);
  expect(after[0]!.windows_share).toBe(before[0]!.windows_share);
  expect(after[0]!.used_pp).toBe(before[0]!.used_pp);
  expect(withoutClock(after)).toEqual(reference(db, after));
  resetBillingCycleClock();
  expect(advanceWindowEndCauses(db, { now: later, budgetMs: 10_000, overrides: chosen })!.written).toBe(0);
  expect(advanceBillingCycles(db, { catalog: CATALOG, now: later, budgetMs: 10_000 })!.cycles).toBe(0);
  db.close();
}, 30_000);


test("a correction spanning billing boundaries refreshes both window details and preserves other accounts", () => {
  const db = database(); seed(db);
  replaceDeclaredPeriods(db, PLAN_PERIODS, [declared("codex1", "pro", "2026-08-31T06:00:00.000Z", null, {
    anchor: "2026-09-12T00:00:00.000Z", amountMinor: 20000, currency: "USD",
  })]);
  db.query("UPDATE limit_windows SET reset_ts=? WHERE account='codex1' AND counter=? AND seq=1")
    .run("2026-09-17T18:00:00.000Z", MAIN);
  resetBillingCycleClock(); settle(db);
  const before = stored(db);
  const chosen = [{ provider: "codex", account: "codex1", counter: MAIN, window_start: "2026-09-07T18:00:00.000Z",
    cause: "banked", updated_at: iso(NOW) }] as const;
  const later = NOW + 1000;
  expect(advanceWindowEndCauses(db, { now: later, budgetMs: 10_000, overrides: chosen })!.written).toBe(1);
  for (let i = 0; i < 20 && advanceBillingCycles(db, { catalog: CATALOG, now: later, budgetMs: 10_000 })?.pending; i++);
  const after = stored(db);
  expect(after.filter((row) => row.account === "codex2")).toEqual(before.filter((row) => row.account === "codex2"));
  const holding = after.filter((row) => row.account === "codex1" && JSON.parse(row.detail).main_windows.some((w: { start: string }) => w.start === chosen[0]!.window_start));
  expect(holding.length).toBe(2);
  for (const row of holding) {
    expect(row.computed_at).toBe(iso(later));
    expect(JSON.parse(row.detail).main_windows.find((w: { start: string }) => w.start === chosen[0]!.window_start).cause).toBe("banked");
  }
  expect(withoutClock(after)).toEqual(reference(db, after));
  db.close();
}, 30_000);
