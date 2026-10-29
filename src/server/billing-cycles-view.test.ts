import { afterEach, expect, setSystemTime, test } from "bun:test";
import { DATA_VIEWS } from "./data-views";
import { handleBillingCycles, type AppContext } from "./api";
import { advanceBillingCycles, resetBillingCycleClock } from "./billing-cycle-producer";
import { advanceWindowPointValues } from "./window-point-values";
import { advanceWindowEndCauses } from "./window-end-causes";
import { buildBillingCyclesView } from "./billing-cycles-view";
import { CATALOG, MAIN, NOW, database, seed } from "./billing-cycles.fixture";
import { markWindowAnswersDirty } from "../db/window-answers";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import type { BillingCycle, BillingCyclesAccount, BillingCyclesView } from "../shared/billing-cycles";

afterEach(() => setSystemTime());

test("the route is a stored-row view: built off the HTTP thread, never kept or queued", () => {
  expect(DATA_VIEWS["/api/billing-cycles"]?.direct).toBe(true);
  expect(DATA_VIEWS["/api/billing-cycles"]?.clock).toBe(false);
});

test("billing endpoint adds paired splits to already published rows, preserving used and capacity amounts", async () => {
  setSystemTime(NOW);
  const db = database();
  try {
    seed(db);
    const windows = db.query("SELECT rowid id,cycle,readings FROM window_usage").all() as Array<{ id: number; cycle: string; readings: string }>;
    for (const row of windows) {
      const cycle = JSON.parse(row.cycle), readings = JSON.parse(row.readings);
      const split = (usage: any) => ({ ...usage, events: 1, tokens: 100, priced_tokens: 100, unpriced_events: 0,
        context_priced_tokens: 100, context_api_base: usage.api_standard, context_api_extra: usage.api_standard * 0.25 });
      cycle.usage = split(cycle.usage);
      // Whole-window traffic deliberately has a different ratio and is not billing's paired scope.
      cycle.cycle_usage = { ...split(cycle.usage), context_api_extra: cycle.usage.api_standard * 0.8 };
      db.query("UPDATE window_usage SET cycle=?,readings=? WHERE rowid=?").run(JSON.stringify(cycle),
        JSON.stringify(readings.map((reading: any) => ({ ...reading, usage: split(reading.usage) }))), row.id);
    }
    resetBillingCycleClock();
    advanceWindowPointValues(db, { plans: { capacity_regimes: [] }, catalog: CATALOG, now: NOW, budgetMs: 10_000 });
    advanceWindowEndCauses(db, { now: NOW, budgetMs: 10_000 });
    advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
    const stored = db.query("SELECT * FROM billing_cycles ORDER BY provider,account,start_ts").all() as Array<{ api_usd: number | null }>;
    const changes = db.query("SELECT total_changes() n").get();
    const result = await handleBillingCycles({ sqlite: db } as AppContext, new URL("http://x/api/billing-cycles")).json() as BillingCyclesView;
    const cycles = result.accounts.flatMap(account => account.cycles);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.map(cycle => cycle.api_usd)).toEqual(stored.map(row => row.api_usd === null ? null : Math.round(row.api_usd * 100) / 100));
    for (const cycle of cycles.filter(cycle => cycle.api_usd !== null)) {
      expect(cycle.context_price).toBeDefined();
      expect(cycle.context_price!.extra).toBeCloseTo(cycle.context_price!.stored * 0.25, 9);
      expect(cycle.context_price!.stored).toBeCloseTo(cycle.used_units!.api_usd, 9);
    }
    expect(db.query("SELECT * FROM billing_cycles ORDER BY provider,account,start_ts").all()).toEqual(stored);
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    db.query("UPDATE window_usage SET cycle=json_set(cycle,'$.usage.context_priced_tokens',99)").run();
    expect(buildBillingCyclesView(db).accounts.flatMap(account => account.cycles).every(cycle => !cycle.context_price)).toBe(true);
  } finally { db.close(); }
});

test("one read of the stored rows answers §6: prices, shares, percentages, unknown capacity; within a second", async () => {
  setSystemTime(NOW);
  const db = database();
  seed(db);
  // Before the producer has run, an account's answer is empty and stale, never computed here.
  expect(buildBillingCyclesView(db, { provider: "codex", account: "codex1" }, NOW).accounts).toEqual([
    { provider: "codex", account: "codex1", counter: null, stale: true, pending: { reason: "rules", from: null }, cycles: [] }]);
  resetBillingCycleClock();
  advanceWindowPointValues(db, { plans: { capacity_regimes: [] }, catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  advanceWindowEndCauses(db, { now: NOW, budgetMs: 10_000 });
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  const started = performance.now();
  const one = await handleBillingCycles({ sqlite: db } as unknown as AppContext, new URL("http://x/api/billing-cycles?provider=codex&account=codex1")).json() as BillingCyclesAccount;
  const all = await handleBillingCycles({ sqlite: db } as unknown as AppContext, new URL("http://x/api/billing-cycles")).json() as BillingCyclesView;
  expect(performance.now() - started).toBeLessThan(1000);
  expect(all.accounts.map((account) => account.account)).toEqual(["codex1", "codex2"]);
  expect(one.counter).toBe(MAIN);
  expect(one.stale).toBe(false);
  const current = one.cycles.find((cycle) => cycle.current)!;
  expect(current.price).toEqual({ amount: 200, currency: "USD", source: "catalog", usd: 200, fx: null });
  expect(current.capacity_usd).toBeNull();
  expect(current.flags).toContain("capacity_uncalibrated");
  expect(current.used_pct).toBeCloseTo(current.used_pp! / (current.windows.share + current.windows.idle), 1);
  expect(current.to_date!.windows).toBeLessThan(current.projection!.windows_min);
  expect(current.per_window_point).toBeCloseTo(200 / ((current.windows.share + current.windows.idle) * 100), 4);
  const closed = one.cycles.find((cycle) => !cycle.current) as BillingCycle;
  expect([closed.to_date, closed.projection]).toEqual([null, null]);
  expect(closed.anchor_uncertain).toBe(true);
  // A new reading of codex1 makes its answer stale until the producer's next turn, without computing anything.
  markWindowAnswersDirty(db, { provider: "codex", account: "codex1", fromMs: NOW - 1000, untilMs: NOW });
  expect(buildBillingCyclesView(db, { provider: "codex", account: "codex1" }, NOW).accounts[0]!.stale).toBe(true);
  expect(buildBillingCyclesView(db, { provider: "codex", account: "codex2" }, NOW).accounts[0]!.stale).toBe(false);
});

test("pending says why: a plan period edit names where dates may change, readings only refresh figures", () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  advanceWindowPointValues(db, { plans: { capacity_regimes: [] }, catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  advanceWindowEndCauses(db, { now: NOW, budgetMs: 10_000 });
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  const pendingOf = (account: string) => buildBillingCyclesView(db, { provider: "codex", account }, NOW).accounts[0]!.pending;
  expect(pendingOf("codex1")).toBeNull();
  markWindowAnswersDirty(db, { provider: "codex", account: "codex1", fromMs: NOW - 1000, untilMs: NOW });
  expect(pendingOf("codex1")).toEqual({ reason: "figures", from: null });
  replaceDeclaredPeriods(db, PLAN_PERIODS, [{ provider: "codex", subject: "codex1", from: "2026-09-16T00:00:00.000Z", until: "2026-10-16T00:00:00.000Z",
    value: "pro", origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "invoice", amountMinor: 81300, currency: "PLN" }]);
  // The edit outranks the readings and names its earliest start; another account is untouched.
  expect(pendingOf("codex1")).toEqual({ reason: "periods", from: "2026-09-16T00:00:00.000Z" });
  expect(pendingOf("codex2")).toBeNull();
  // The producer's turn consumes the edit; the re-resolved windows may still refresh figures, never dates.
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  expect([null, "figures"]).toContain(pendingOf("codex1")?.reason ?? null);
  db.close();
});

test("one account's view lists each cycle's main-counter windows from stored rows; the unfiltered view leaves them out", async () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  advanceWindowPointValues(db, { plans: { capacity_regimes: [] }, catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  advanceWindowEndCauses(db, { now: NOW, budgetMs: 10_000 });
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  const one = await handleBillingCycles({ sqlite: db } as unknown as AppContext, new URL("http://x/api/billing-cycles?provider=codex&account=codex1")).json() as BillingCyclesAccount;
  const all = await handleBillingCycles({ sqlite: db } as unknown as AppContext, new URL("http://x/api/billing-cycles")).json() as BillingCyclesView;
  expect(all.accounts.flatMap((account) => account.cycles).some((cycle) => "main_windows" in cycle)).toBe(false);
  const stored = new Map((db.query("SELECT window_start, cause FROM window_end_causes WHERE provider='codex' AND account='codex1' AND counter=?").all(MAIN) as
    Array<{ window_start: string; cause: string }>).map((row) => [Date.parse(row.window_start), row.cause]));
  for (const cycle of one.cycles) {
    const windows = cycle.main_windows!;
    expect(windows.length).toBe(cycle.windows.touched);
    expect(windows.reduce((sum, window) => sum + window.share, 0)).toBeCloseTo(cycle.windows.share, 3);
    // Without a capacity each window's part is its share of the cycle's windows and idle time.
    const parts = windows.reduce((sum, window) => sum + window.capacity_share!, 0) + cycle.windows.idle / (cycle.windows.share + cycle.windows.idle);
    expect(parts).toBeCloseTo(1, 3);
    for (const window of windows) {
      expect(window.cause).toBe((stored.get(Date.parse(window.start)) ?? null) as never);
      expect(window.used_pp === null || window.used_pp >= 0).toBe(true);
    }
    // The windows wholly inside the cycle used what the cycle counts for them.
    if (windows.every((window) => Date.parse(window.start) >= Date.parse(cycle.start) && Date.parse(window.end) <= Date.parse(cycle.end)) && cycle.used_pp !== null)
      expect(windows.reduce((sum, window) => sum + window.used_pp!, 0)).toBeCloseTo(cycle.used_pp, 1);
  }
  expect(one.cycles.flatMap((cycle) => cycle.main_windows!).some((window) => window.cause !== null)).toBe(true);
});
