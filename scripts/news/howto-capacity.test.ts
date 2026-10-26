import { expect, test } from "bun:test";
import { changeEvents, levelShifts, publicBillingCycle, resetUse, type WeeklySubscription } from "./howto-capacity";
import type { BillingCycle } from "../../src/shared/billing-cycles";
import type { PlansCatalog } from "../../src/shared/plan-catalog";

const day = 86_400_000, t0 = Date.parse("2026-08-01T00:00:00Z");
const cycle = (index: number, value: number, extra: Partial<WeeklySubscription["cycles"][number]> = {}) => ({
  start: new Date(t0 + index * 7 * day).toISOString(), end: new Date(t0 + (index * 7 + 6) * day).toISOString(), plan: "Pro · ×20", observedPp: 60, capacityUsd: value, lowerBound: false, promotionFactor: null, ...extra });
const sub = (values: number[], label = "A", extra = {}): WeeklySubscription => ({ provider: "codex", label, cycles: values.map((value, index) => cycle(index, value, extra)) });

test("a step of at least 15% that holds on both sides is one event; noise and small moves are not", () => {
  const step = changeEvents([sub([2000, 2100, 1950, 2050, 1000, 1050, 990, 1020])]).filter(event => event.kind === "level_shift");
  expect(step).toHaveLength(1);
  expect(step[0]).toMatchObject({ plan: "Pro · ×20", before: { median: 2025, n: 4 }, after: { median: 1010, n: 4 } });
  expect(step[0]!.changePct!).toBeCloseTo(-0.5, 1);
  expect(changeEvents([sub([2000, 2100, 1950, 2050, 1900, 2000, 2050, 1980])]).filter(event => event.kind === "level_shift")).toEqual([]);
  // One outlier cycle does not make a step: the two nearest cycles on each side must already lie on their side.
  expect(levelShifts(sub([2000, 2000, 2000, 900, 2000, 2000, 2000, 2000]).cycles.map((c, i) => ({ end: Date.parse(c.end), endIso: c.end, value: c.capacityUsd!, lowerBound: false, label: "A" })))
    .events).toEqual([]);
});

test("promotion edges and plan changes are their own event kinds, and a step at a promotion edge is not a level shift", () => {
  const promoted = [...[1200, 1250, 1180].map((value, index) => cycle(index, value, { promotionFactor: 2 })), ...[600, 560, 580, 590].map((value, index) => cycle(index + 3, value))];
  const events = changeEvents([{ provider: "codex", label: "A", cycles: promoted }]);
  expect(events.map(event => event.kind)).toEqual(["promotion_end"]);
  expect(events[0]).toMatchObject({ before: { median: 1200 }, after: { median: 585 } });
  const changed = changeEvents([{ provider: "codex", label: "A", cycles: [cycle(0, 100, { plan: "Plus · ×1" }), cycle(1, 110, { plan: "Plus · ×1" }), cycle(2, 1000), cycle(3, 1010)] }]);
  expect(changed.filter(event => event.kind === "plan_change")).toHaveLength(1);
  expect(changed.some(event => event.kind === "level_shift")).toBe(false);
});

const catalog: PlansCatalog = { provider_groups: [{ id: "codex", label: "Codex", aliases: ["codex"], plans: [{ plan_id: "codex-pro", label: "Pro", aliases: ["pro"], versions: [{ from: null, usd_per_month: 200, limits: { credits_multiplier: 20 } }] }] }] };
const billing = (patch: Partial<BillingCycle> = {}): BillingCycle => ({
  start: "2026-09-09T00:00:00Z", end: "2026-10-09T00:00:00Z", plan: "pro", basis: "declared", anchor_uncertain: false, cycle_months: 1, shortened: false, current: false,
  price: { amount: 200, currency: "USD", source: "catalog", usd: 200 }, catalog_usd: 200, windows: { share: 7.6, idle: 0.07, touched: 8, observed_share: 1 },
  used_pp: 650, used_pct: 84.7, api_usd: 8668, capacity_usd: 10438, capacity: null, used_units: null,
  resets: { provider: { count: 4, windows: 2.03, pp: 203, api_usd: 2764, tokens: null, credits: null }, banked: { count: 2, windows: 1.05, pp: 105, api_usd: 1430, tokens: null, credits: null },
    scheduled: { count: 1, windows: 0, pp: 0, api_usd: 0, tokens: null, credits: null } },
  main_windows: [
    { start: "a", end: "b", cause: "provider", used_pp: 57, share: 1, capacity_share: 0.1 }, { start: "b", end: "c", cause: "banked", used_pp: 100, share: 1, capacity_share: 0.1 },
    { start: "c", end: "d", cause: "scheduled", used_pp: 100, share: 1, capacity_share: 0.1 }],
  to_date: null, projection: null, per_window_point: null, unmetered: null, others: [], flags: [], run: { from: "", anchor: "", until: null }, declared_from: null, ...patch });

test("a billing cycle splits its stored capacity by cause, keeps the reset counts, and gives the used % at each early reset", () => {
  const record = publicBillingCycle(billing(), catalog, "codex", false);
  expect(record.plan).toBe("Pro · ×20");
  expect(record.windows).toMatchObject({ total: 7.67, automatic: { count: 4, windows: 2.03 }, banked: { count: 2, windows: 1.05 } });
  expect(record.windows.scheduled).toBeCloseTo(4.59, 2);
  expect(record.capacityUsd).toEqual({ total: 10438, base: 6244, automatic: 2764, banked: 1430, other: 0 });
  expect(record.perWindowUsd).toMatchObject({ min: 1044, median: 1044, max: 1044, n: 3 });
  expect(record.usedPctWithoutBanked).toBeCloseTo(98.3, 0);
  expect(record.earlyResets.automatic.usedPct).toEqual([57]);
  expect(record.earlyResets.banked.usedPct).toEqual([100]);
  const use = resetUse([{ id: "codex-A", provider: "codex", label: "A", cycles: [record] }]);
  expect(use.automatic).toMatchObject({ resets: 1, medianUsedPct: 57 });
  expect(use.banked.medianUsedPct).toBe(100);
});

test("an uncalibrated cycle has no capacity and says why, never zero", () => {
  const record = publicBillingCycle(billing({ capacity_usd: null, flags: ["capacity_uncalibrated"], main_windows: [] }), catalog, "codex", false);
  expect(record.capacityUsd).toBeNull();
  expect(record.capacityReason).toBe("uncalibrated");
  expect(record.perWindowUsd).toBeNull();
});
