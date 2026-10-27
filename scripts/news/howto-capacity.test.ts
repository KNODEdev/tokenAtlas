import { expect, test } from "bun:test";
import { changeEvents, levelShifts, publicBillingCycle, resetUse, windowStarts, type WeeklySubscription } from "./howto-capacity";
import type { BillingCycle, BillingCycleWindow } from "../../src/shared/billing-cycles";
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
const win = (start: string, end: string, cause: BillingCycleWindow["cause"], used: number, share: number): BillingCycleWindow =>
  ({ start: `${start}:00Z`, end: `${end}:00Z`, cause, used_pp: used, share, capacity_share: share / 7.67 });
const billing = (patch: Partial<BillingCycle> = {}): BillingCycle => ({
  start: "2026-09-09T00:00:00Z", end: "2026-10-09T00:00:00Z", plan: "pro", basis: "declared", anchor_uncertain: false, cycle_months: 1, shortened: false, current: false,
  price: { amount: 200, currency: "USD", source: "catalog", usd: 200 }, catalog_usd: 200, windows: { share: 7.6, idle: 0.07, touched: 8, observed_share: 1 },
  used_pp: 650, used_pct: 84.7, api_usd: 8668, capacity_usd: 10438, capacity: null, used_units: null,
  resets: { provider: { count: 4, windows: 2.03, pp: 203, api_usd: 2764, tokens: null, credits: null }, banked: { count: 2, windows: 1.05, pp: 105, api_usd: 1430, tokens: null, credits: null },
    scheduled: { count: 1, windows: 0, pp: 0, api_usd: 0, tokens: null, credits: null } },
  // Subscription D, 9 Sep - 9 Oct: eight main windows. The first starts from the plan change (the plan's first window); each later one starts the way the
  // one before it ended. The last window runs into October (share 0.6), and its end belongs to the next cycle.
  main_windows: [
    win("2026-09-09T10:00", "2026-09-12T08:00", "scheduled", 91, 1), win("2026-09-12T09:00", "2026-09-14T20:00", "provider", 57, 1),
    win("2026-09-14T21:00", "2026-09-18T06:00", "provider", 79, 1), win("2026-09-18T07:00", "2026-09-21T09:00", "provider", 100, 1),
    win("2026-09-21T10:00", "2026-09-24T09:00", "banked", 100, 1), win("2026-09-24T10:00", "2026-09-27T09:00", "banked", 100, 1),
    win("2026-09-27T10:00", "2026-09-30T19:00", "provider", 82, 1), win("2026-09-30T20:00", "2026-10-12T08:00", "provider", 82, 0.6)],
  to_date: null, projection: null, per_window_point: null, unmetered: null, others: [], flags: [], run: { from: "", anchor: "", until: null }, declared_from: null, ...patch });

test("a billing cycle splits its windows by how each started, weights the last by its share, keeps idle apart, and lists only resets that ended inside it", () => {
  const record = publicBillingCycle(billing(), catalog, "codex", false);
  expect(record.plan).toBe("Pro · ×20");
  const { starts } = record.windows;
  expect(starts.scheduled).toEqual({ count: 1, windows: 1 });
  expect(starts.plan_change).toEqual({ count: 1, windows: 1 });
  // Four windows started by an automatic reset; the last runs into October, so it weighs 0.6.
  expect(starts.automatic).toEqual({ count: 4, windows: 3.6 });
  expect(starts.banked).toEqual({ count: 2, windows: 2 });
  expect(starts.other.count).toBe(0);
  expect(record.windows.idle).toBe(0.07);
  expect(record.windows.total).toBe(7.67);
  // The parts add up to the total, idle included.
  expect(Object.values(starts).reduce((sum, item) => sum + item.windows, 0) + record.windows.idle).toBeCloseTo(record.windows.total, 3);
  // The reset gain is its own figure: Σ(1 − f), not window counts.
  expect(record.windows.gain).toMatchObject({ automatic: { count: 4, windows: 2.03 }, banked: { count: 2, windows: 1.05 } });
  expect(record.capacityUsd).toMatchObject({ total: 10438, gain: { automatic: 2764, banked: 1430, other: 0 } });
  const parts = record.capacityUsd!;
  expect(parts.scheduled + parts.plan_change + parts.automatic + parts.banked + parts.other + parts.idle).toBe(parts.total);
  expect(parts.idle).toBeGreaterThan(0);
  expect(record.perWindowUsd).toMatchObject({ min: 1361, median: 1361, max: 1361 });
  expect(record.usedPctWithoutBanked).toBeCloseTo(98.3, 0);
  // The old window's used % lists only resets that ended inside the cycle: the last window's end (82) is in October.
  expect(record.earlyResets.automatic.usedPct).toEqual([57, 79, 100, 82]);
  expect(record.earlyResets.automatic.n).toBe(4);
  expect(record.earlyResets.banked.usedPct).toEqual([100, 100]);
  expect(record.bankedGranted).toBeNull();
  const granted = publicBillingCycle(billing({ banked_granted: { count: 3, from: "2026-09-08T23:00:00.000Z", complete: true } }), catalog, "codex", false);
  expect(granted.bankedGranted).toEqual({ count: 3, complete: true });
  const use = resetUse([{ id: "codex-A", provider: "codex", label: "A", cycles: [record] }]);
  expect(use.automatic).toMatchObject({ resets: 4, withReading: 4, medianUsedPct: 81 });
  expect(use.banked.medianUsedPct).toBe(100);
});

test("a short neighbouring cycle does not list a reset that ended outside it, and a split of one allowance continues the start", () => {
  const short = billing({ start: "2026-09-08T00:00:00Z", end: "2026-09-09T00:00:00Z" });
  expect(publicBillingCycle(short, catalog, "codex", false).earlyResets.automatic.usedPct).toEqual([]);
  const starts = windowStarts([win("2026-09-01T00:00", "2026-09-02T00:00", "provider", 10, 1), win("2026-09-02T01:00", "2026-09-03T00:00", "not_reset", 20, 1), win("2026-09-03T01:00", "2026-09-04T00:00", "scheduled", 30, 1)]);
  expect([...starts.values()]).toEqual(["plan_change", "automatic", "automatic"]);
});

test("an uncalibrated cycle has no capacity and says why, never zero", () => {
  const record = publicBillingCycle(billing({ capacity_usd: null, flags: ["capacity_uncalibrated"], main_windows: [] }), catalog, "codex", false);
  expect(record.capacityUsd).toBeNull();
  expect(record.capacityReason).toBe("uncalibrated");
  expect(record.perWindowUsd).toBeNull();
});

import { planTrends } from "./howto-capacity";
test("trend series: a rolling median of the last four eligible cycles, promo cycles marked and kept out of the line, Free without a per-dollar series", () => {
  const weekly: WeeklySubscription[] = [{ provider: "codex", label: "A", cycles: [
    cycle(0, 1200, { promotionFactor: 2 }), cycle(1, 1000), cycle(2, 1100), cycle(3, 900), cycle(4, 400), cycle(5, 420), cycle(6, 5, { observedPp: 4 }),
    ...[0, 1].map(index => cycle(index + 8, 12, { plan: "Free" }))] }];
  const trends = planTrends(weekly, { "codex|Pro · ×20": 200, "codex|Free": 0 }, [], 4.3482);
  const pro = trends.find(item => item.plan === "Pro · ×20")!;
  expect(pro.cycles.filter(item => item.promo)).toHaveLength(1);
  expect(pro.capacity.map(point => point.n)).toEqual([1, 2, 3, 4, 4]);
  expect(pro.capacity.at(-1)).toMatchObject({ value: 660, min: 400, max: 1100, n: 4 });
  expect(pro.perDollar!.at(-1)!.value).toBeCloseTo(660 * 4.3482 / 200, 1);
  expect(pro.capacity.some(point => point.value === 1200)).toBe(false);
  const free = trends.find(item => item.plan === "Free")!;
  expect(free.perDollar).toBeNull();
  expect(free.perDollarReason).toBe("free_plan");
  expect(free.capacity.at(-1)!.value).toBe(12);
  expect(pro.takeaway.peak).toMatchObject({ value: 1000 });
});

import { markPlanChange } from "./howto-capacity";
test("a short low fragment at a plan change is excluded and shown; a full reading at a change and a long cycle stay", () => {
  const h = 3_600_000, at = (hours: number) => new Date(t0 + hours * h).toISOString();
  const mk = (from: number, to: number, plan: string, pp: number, value: number) => ({ start: at(from), end: at(to), plan, observedPp: pp, capacityUsd: value, lowerBound: false, promotionFactor: null });
  const cycles = markPlanChange([mk(0, 140, "Pro · ×1", 21, 240), mk(141, 163, "Max · ×5", 13, 56), mk(164, 300, "Max · ×5", 64, 1408), mk(301, 340, "Max · ×5", 100, 1050), mk(341, 380, "Max · ×20", 100, 2241)]);
  expect(cycles.map(item => item.excluded ?? null)).toEqual([null, "plan_change", null, null, null]);
  const trend = planTrends([{ provider: "claude", label: "B", cycles }], { "claude|Max · ×5": 100 }, [], 4.3482).find(item => item.plan === "Max · ×5")!;
  expect(trend.cycles.map(item => item.value)).toEqual([1408, 1050]);
  expect(trend.excluded).toEqual([{ date: at(163).slice(0, 10), value: 56, pp: 13, reason: "plan_change" }]);
  expect(trend.cycles[0]!.pp).toBe(64);
});

test("an open window never enters trends, medians, events or the latest cycle", () => {
  const cycles = [...[1000, 1010, 990, 1020].map((value, index) => cycle(index, value)), { ...cycle(5, 300), open: true }];
  const trend = planTrends([{ provider: "codex", label: "A", cycles }], { "codex|Pro · ×20": 200 }, [], 4.3482)[0]!;
  expect(trend.cycles).toHaveLength(4);
  expect(trend.capacity.at(-1)).toMatchObject({ value: 1005, n: 4 });
  expect(trend.takeaway.latest).toMatchObject({ value: 1020 });
  expect(changeEvents([{ provider: "codex", label: "A", cycles }]).filter(event => event.kind === "level_shift")).toHaveLength(0);
});
