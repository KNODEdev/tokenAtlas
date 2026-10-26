import { expect, test } from "bun:test";
import { buildProbeLimitWindows, type ProbeLimitReading } from "./probe-limit-windows";
import { computeWindowSums } from "./window-usage-compute";
import { emptyWindowUsage, registerWindowShell } from "./subscription-window-comparison";
import { fixtureTraffic } from "./window-usage.fixture";
import { windowActiveAt } from "../shared/window-activity";
import type { DatedPeriod } from "./account-periods";

const reset = "2026-10-25T11:00:00.000Z", account = "claude-a", counter = '["weekly_all","weekly",10080]';
const point = (ts: string, used: number, plan: string): ProbeLimitReading => ({ ts, used_percent: used, plan,
  resets_at: reset, window_minutes: 10080, source: "probe" });
const readings = [point("2026-10-18T11:01:00Z", 0, "max-20x"), point("2026-10-24T09:53:00Z", 94, "max-20x"),
  point("2026-10-24T12:55:00Z", 3, "max"), point("2026-10-24T13:16:00Z", 7, "pro"),
  point("2026-10-24T14:06:00Z", 14, "pro"), point("2026-10-24T14:16:00Z", 94, "max-20x"),
  point("2026-10-24T16:05:00Z", 99, "max-20x")];
const period = (from: string, until: string | null, value: string): DatedPeriod => ({ provider: "claude", subject: account,
  from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "test" });
const periods = [period("2026-09-24T09:55:00Z", "2026-10-24T09:58:00Z", "max-20x"),
  period("2026-10-24T09:58:00Z", "2026-10-24T12:47:00Z", "none"), period("2026-10-24T12:47:00Z", null, "pro")];
const windows = (rows = readings) => buildProbeLimitWindows({ provider: "claude", account, counter, readings: rows, periods });

test("Max resumes its original weekly identity; Pro keeps its own final 14% and the unpaid gap", () => {
  const before = windows(readings.slice(0, 2))[0]!;
  const [max, pro] = windows();
  expect(windows()).toHaveLength(2);
  expect(max!.id).toBe(before.id);
  expect(max!.readings.map(row => row.percent)).toEqual([0, 94, 94, 99]);
  expect(pro!.readings.map(row => row.percent)).toEqual([3, 7, 14]);
  expect(max!.end).toBe(reset); expect(pro!.end).toBe(reset);
  expect(max!.plan).toBe("max-20x"); expect(pro!.plan).toBe("pro");
  expect(max!.activity?.spans).toEqual([
    { start: "2026-10-18T11:00:00.000Z", end: "2026-10-24T09:58:00.000Z" },
    { start: "2026-10-24T14:16:00.000Z", end: reset },
  ]);
  expect(pro!.activity?.spans).toEqual([{ start: "2026-10-24T12:47:00.000Z", end: "2026-10-24T14:16:00.000Z" }]);
  expect(registerWindowShell(pro!, 10080)).toMatchObject({ start_basis: "partial", start_percent: 3, observed_pp: 11 });
  expect(windowActiveAt(max!, Date.parse("2026-10-24T15:00Z"))).toBe(true);
  expect(windowActiveAt(pro!, Date.parse("2026-10-24T15:00Z"))).toBe(false);
});

test("canonical placement counts each boundary once and excludes Pro and unpaid traffic from Max", () => {
  const register = windows();
  const events = ["2026-10-18T11:02:00Z", "2026-10-24T09:57:59.999Z", "2026-10-24T09:58:00Z",
    "2026-10-24T12:46:59.999Z", "2026-10-24T12:47:00Z", "2026-10-24T14:15:59.999Z",
    "2026-10-24T14:16:00Z", "2026-10-24T16:00:00Z"].map(ts => ({ ts, account, model: "model" }));
  const traffic = fixtureTraffic({ windowMinutes: 10080, include: () => true,
    usage: () => ({ ...emptyWindowUsage(), events: 1, tokens: 10, priced_tokens: 10, api_standard: 1 }) });
  const result = register.map((window, i) => computeWindowSums(window, register.slice(0, i), events, traffic, true));
  expect(result.map(row => row.sums.cycle.cycle_usage.events)).toEqual([4, 2]);
  expect(result.map(row => row.sums.cycle.cycle_usage.tokens)).toEqual([40, 20]);
  expect(result.map(row => row.sums.cycle.cycle_usage.api_standard)).toEqual([4, 2]);
  expect(result[0]!.comparison.observed_pp).toBe(99);
  expect(result[1]!.comparison.observed_pp).toBe(11);
  expect(result[0]!.sums.readings.map(row => row.usage.events)).toEqual([0, 1, 3, 4]);
});

test("a second switch resumes Pro too, while the real weekly reset opens another Max window", () => {
  const extra = [...readings, point("2026-10-24T17:00:00Z", 14, "pro"), point("2026-10-24T17:20:00Z", 18, "pro"),
    { ...point("2026-10-25T11:02:00Z", 1, "max-20x"), resets_at: "2026-11-01T11:00:00Z" }];
  const result = windows(extra);
  expect(result).toHaveLength(3);
  expect(result[1]!.readings.map(row => row.percent)).toEqual([3, 7, 14, 14, 18]);
  expect(result[2]!.start).toBe(reset);
  expect(result[2]!.readings.map(row => row.percent)).toEqual([1]);
});

test("a drop without plan evidence remains a separate uncertain segment", () => {
  const result = buildProbeLimitWindows({ provider: "claude", account, counter, periods: [],
    readings: readings.map(row => ({ ...row, plan: null })) });
  expect(result).toHaveLength(2);
  expect(result.every(window => !window.activity)).toBe(true);
  expect(result[0]!.endDrop).toEqual({ before: 94, after: 3 });
});

test("a plan-less refusal belongs to the selected Pro meter despite an older Max declaration", () => {
  const rows = [point("2026-10-24T09:53:00Z", 94, "max-20x"), point("2026-10-24T12:55:00Z", 3, "pro"),
    { ...point("2026-10-24T13:00:00Z", 100, ""), plan: null, source: "limit_hit" as const, limit_hit: { call_id: "pro-refusal" } },
    point("2026-10-24T14:16:00Z", 99, "max-20x")];
  const result = buildProbeLimitWindows({ provider: "claude", account, counter, readings: rows,
    periods: [period("2026-09-24T00:00Z", null, "max-20x")] });
  expect(result.map(window => window.readings.map(row => row.percent))).toEqual([[94, 99], [3, 100]]);
});

test("returning stale readings cannot resurrect the prior reset", () => {
  const result = windows([...readings,
    { ...point("2026-10-25T11:02:00Z", 2, "max-20x"), resets_at: "2026-11-01T11:00:00Z" },
    point("2026-10-25T13:00:00Z", 18, "pro")]);
  expect(result).toHaveLength(3);
  expect(result[1]!.readings.map(row => row.percent)).toEqual([3, 7, 14]);
});

test("a manual Pro measurement cannot become the paused Max meter's pairing", () => {
  const result = buildProbeLimitWindows({ provider: "claude", account, counter, readings, periods, measurements: [{
    id: "pro-manual", account, counter, start: "2026-10-24T13:00:00Z", end: "2026-10-24T14:00:00Z",
    start_percent: 4, end_percent: 13, approximate_time: false, note: "Pro", updated_at: "2026-10-24T14:00:00Z",
  }] });
  expect(result[0]!.manual_measurement).toBeUndefined();
  expect(result[1]!.manual_measurement?.id).toBe("pro-manual");
});

test("a resumed meter preserves an uncertain origin instead of inventing a reset baseline", () => {
  const rows = [{ ...point("2026-10-18T11:30:00Z", 70, "max-20x"), resets_at: "2026-10-18T12:00:00Z" },
    point("2026-10-19T12:00:00Z", 94, "max-20x"), point("2026-10-24T13:00:00Z", 3, "pro"),
    point("2026-10-24T15:00:00Z", 99, "max-20x")];
  const prior = buildProbeLimitWindows({ provider: "claude", account, counter, readings: rows.slice(0, 2), periods: [] })[1]!;
  const resumed = buildProbeLimitWindows({ provider: "claude", account, counter, readings: rows, periods: [] })[1]!;
  expect(resumed.id).toBe(prior.id);
  expect(resumed.start).toBe("2026-10-19T12:00:00.000Z");
  expect(registerWindowShell(resumed, 10080)).toMatchObject({ start_percent: 94, start_basis: "partial", observed_pp: 5 });
});

test("an explicit unpaid gap is excluded even when the same Max meter is selected afterwards", () => {
  const result = windows([readings[0]!, readings[1]!, readings.at(-1)!]);
  expect(result).toHaveLength(1);
  expect(windowActiveAt(result[0]!, Date.parse("2026-10-24T11:00:00Z"))).toBe(false);
});

test("a silent secondary meter follows the account's observed temporary Pro activation", () => {
  const observed = [period("2026-10-18T11:00:00Z", "2026-10-24T09:53:01Z", "max-20x"),
    period("2026-10-24T12:55:00Z", "2026-10-24T14:06:01Z", "pro"), period("2026-10-24T14:16:00Z", null, "max-20x")]
    .map(row => ({ ...row, origin: "observed" as const, lastSeen: row.until ?? row.from }));
  const result = buildProbeLimitWindows({ provider: "claude", account, counter: '["weekly_scoped","weekly",10080]',
    readings: [readings[0]!, readings[1]!, readings.at(-1)!].map(row => ({ ...row, used_percent: 0 })), periods: [...periods, ...observed] });
  expect(windowActiveAt(result[0]!, Date.parse("2026-10-24T13:00:00Z"))).toBe(false);
  expect(windowActiveAt(result[0]!, Date.parse("2026-10-24T15:00:00Z"))).toBe(true);
});

test("declared unpaid time also excludes legacy readings without a source plan", () => {
  const rows = [readings[0]!, readings.at(-1)!].map(row => ({ ...row, plan: null }));
  const result = buildProbeLimitWindows({ provider: "claude", account, counter, readings: rows,
    periods: [periods[0]!, periods[1]!, period("2026-10-24T12:47:00Z", null, "max-20x")] });
  expect(windowActiveAt(result[0]!, Date.parse("2026-10-24T11:00:00Z"))).toBe(false);
});

test("accepted source evidence resumes a meter despite a lagging observed period", () => {
  const result = buildProbeLimitWindows({ provider: "claude", account, counter,
    readings: [point("2026-10-24T01:00Z", 94, "max-20x"), point("2026-10-24T05:00Z", 99, "max-20x")],
    periods: [{ ...period("2026-10-24T02:00Z", null, "pro"), origin: "observed" }] });
  expect(windowActiveAt(result[0]!, Date.parse("2026-10-24T03:00Z"))).toBe(false);
  expect(windowActiveAt(result[0]!, Date.parse("2026-10-24T05:00Z"))).toBe(true);
});

test("one exhausted Pro session reading cannot invent a zero baseline before its activation", () => {
  const result = buildProbeLimitWindows({ provider: "claude", account, counter: '["session","session",300]',
    readings: [{ ...point("2026-10-24T12:55Z", 100, "pro"), resets_at: "2026-10-24T15:55Z", window_minutes: 300 }],
    periods: [periods[1]!, ...[period("2026-10-24T09:53Z", null, "max-20x"), period("2026-10-24T12:47Z", null, "pro"),
      period("2026-10-24T14:16Z", null, "max-20x")].map(row => ({ ...row, origin: "observed" as const }))] });
  expect(registerWindowShell(result[0]!, 300)).toMatchObject({ start_basis: "partial", start_percent: 100, observed_pp: 0 });
});
