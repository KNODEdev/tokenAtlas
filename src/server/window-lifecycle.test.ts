import { expect, test } from "bun:test";
import { buildProbeLimitWindows, type ProbeLimitReading } from "./probe-limit-windows";
import { registerWindowShell, emptyWindowUsage } from "./subscription-window-comparison";
import { computeWindowSums } from "./window-usage-compute";
import { fixtureTraffic } from "./window-usage.fixture";
import { planPeriodIndex, type DatedPeriod } from "./account-periods";
import { planReconstructionSpans } from "./window-plan-periods";
import { usageProviderIds, registerSubscriptionAccountingAdapter, subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { ownEnd, joinsPrevious } from "./window-end-causes";

const account = "account", counter = '["weekly","all",10080]', reset = "2026-10-25T00:00:00.000Z";
const at = (day: number, hour = 0) => `2026-10-${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const reading = (ts: string, used_percent: number, plan = "pro", allowance?: number): ProbeLimitReading =>
  ({ ts, used_percent, plan, resets_at: reset, window_minutes: 10080, source: "probe", allowance,
    ...(allowance === undefined ? {} : { used: used_percent * allowance / 100 }) });
const period = (provider: string, from: string, until: string | null, value = "pro"): DatedPeriod =>
  ({ provider, subject: account, from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });

for (const provider of usageProviderIds()) {
  const build = (readings: ProbeLimitReading[], periods: DatedPeriod[] = []) =>
    buildProbeLimitWindows({ provider, account, counter, readings, periods });

  test(`${provider}: a name change alone does not create a zero or another meter`, () => {
    const windows = build([reading(at(18, 1), 40, "offer-a"), reading(at(20), 60, "offer-b")]);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.readings.map(row => row.percent)).toEqual([40, 60]);
    expect(windows[0]!.start).toBe(at(18));
  });

  test(`${provider}: changing a reported allowance opens a partial comparison, not a fresh zero`, () => {
    const windows = build([reading(at(18, 1), 80, "pro", 100), reading(at(20), 41, "pro", 200), reading(at(21), 45, "pro", 200)]);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ end: at(20), reset, cycle_end_basis: "capacity_change", endDrop: null });
    expect(windows[1]).toMatchObject({ start: at(20), reset, startDrop: null,
      activity: { start_basis: "partial", capacity_change: { before: 100, after: 200 } } });
    expect(registerWindowShell(windows[1]!, 10080)).toMatchObject({ start_basis: "partial", start_percent: 41, observed_pp: 4 });
    const traffic = fixtureTraffic({ windowMinutes: 10080, include: () => true,
      usage: () => ({ ...emptyWindowUsage(), events: 1, tokens: 10, priced_tokens: 10, api_standard: 1 }) });
    const events = [at(19), at(20), at(21)].map(ts => ({ ts, account, model: "m" }));
    const sums = windows.map((window, i) => computeWindowSums(window, windows.slice(0, i), events, traffic, true));
    expect(sums.map(row => row.sums.cycle.cycle_usage.events)).toEqual([1, 2]);
    expect(sums[1]!.comparison.usage.events).toBe(1);
  });

  test(`${provider}: expiry closes the unobserved tail while a real later reading remains evidence`, () => {
    const periods = [period(provider, at(18), at(21))];
    expect(build([reading(at(19), 20)], periods)[0]).toMatchObject({ end: at(21), reset, cycle_end_basis: "plan_change" });
    const later = build([reading(at(19), 20), reading(at(22), 25)], periods)[0]!;
    expect(later.end).toBe(reset);
    expect(later.readings.at(-1)?.percent).toBe(25);
  });

  test(`${provider}: unpaid activity is excluded and resuming a continuous meter does not reset it`, () => {
    const rows = [reading(at(19), 20), reading(at(23), 30)];
    const original = build(rows)[0]!;
    const window = build(rows, [period(provider, at(20), at(22), "none")])[0]!;
    expect(window.id).toBe(original.id);
    expect(window.activity?.spans).toEqual([{ start: at(18), end: at(20) }, { start: at(22), end: reset }]);
    expect(window.readings.map(row => row.percent)).toEqual([20, 30]);
  });

  test(`${provider}: synthetic coverage respects gaps and preserves intrinsic Free limits`, () => {
    const index = planPeriodIndex([period(provider, at(18), at(20)), period(provider, at(22), null, "free")]);
    expect(planReconstructionSpans(index, provider, account)).toEqual([
      { from: Date.parse(at(18)), until: Date.parse(at(20)) }, { from: Date.parse(at(22)), until: Infinity }]);
    expect(planReconstructionSpans(null, provider, account)).toBeNull();
  });
}

test("a registered provider supplies independent-meter evidence without any branch in the lifecycle engine", () => {
  const provider = "lifecycle-fixture";
  const remove = registerSubscriptionAccountingAdapter({ ...subscriptionAccountingAdapter("glm"), id: provider, aliases: [provider],
    windowMeterPlan: plan => plan === "low" || plan === "high" ? plan : null });
  try {
    const windows = buildProbeLimitWindows({ provider, account, counter,
      readings: [reading(at(18, 1), 80, "high"), reading(at(20, 1), 3, "low"), reading(at(20, 2), 14, "low"), reading(at(20, 3), 82, "high")],
      periods: [period(provider, at(20), null, "low")] });
    expect(windows).toHaveLength(2);
    expect(windows[0]!.readings.map(row => row.percent)).toEqual([80, 82]);
    expect(windows[1]).toMatchObject({ start: at(20), end: at(20, 3), reset, activity: { plan: "low", start_basis: "activation" } });
    expect(registerWindowShell(windows[1]!, 10080)).toMatchObject({ start_percent: 0, observed_pp: 14 });
  } finally { remove(); }
});

test("reported lifecycle ends cannot be mistaken for bonus resets or borrowed point baselines", () => {
  const end = { provider: "glm", account, counter, seq: 0, start: Date.parse(at(18)), end: Date.parse(at(20)), reset: Date.parse(reset),
    plan: "pro", first: 20, last: 80 };
  expect(ownEnd({ ...end, endBasis: "plan_change" }, null, null, Infinity).kind).toBe("plan_change");
  expect(ownEnd({ ...end, endBasis: "capacity_change" }, null, null, Infinity)).toEqual({ kind: "not_reset", notReset: "capacity_change" });
  const previous = { start_ts: at(18), end_ts: at(20), reset_ts: reset, plan: "pro", plan_detail: null, first: 20, last: 80,
    cycle_end_basis: "capacity_change" };
  expect(joinsPrevious(previous, { ...previous, start_ts: at(20), end_ts: reset, first: 79.5, last: 90, cycle_end_basis: "scheduled" })).toBe(false);
});
