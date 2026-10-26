import { expect, test } from "bun:test";
import { tiboSample, tiboComparison, tiboCohortKey, tiboSpeedScope, type TiboHour } from "./tibo-measurements";
const hour = (at: string, overrides: Partial<TiboHour> = {}): TiboHour => ({ at: Date.parse(at), account: "a", model: "gpt-6.1-sol",
  mode: "default", plan: "pro", funding: "allowance", calls: 40, input: 1000, cached: 500, timed: 40, output: 1000, ms: 10000,
  longCalls: 40, longOutput: 1000, longMs: 10000, ...overrides });

test("speed and cache are ratios of sums; missing and unfinished hours remain absent", () => {
  const rows = [hour("2026-10-06T08:00Z"), hour("2026-10-06T09:00Z", { input: 9000, cached: 8100, longMs: 90000 }),
    hour("2026-10-06T10:00Z", { cached: 0 })];
  const sample = tiboSample(rows, Date.parse("2026-10-06T07:00Z"), Date.parse("2026-10-06T10:30Z"));
  expect(sample.cache).toBe(86); expect(sample.speed).toBe(20); expect(sample.calls).toBe(80);
  expect(tiboSample([], 0, 10).speed).toBeNull(); expect(tiboSample([], 0, 10).cache).toBeNull();
  expect(() => tiboSample([hour("2026-10-06T08:00Z", { input: Number.MAX_SAFE_INTEGER }), hour("2026-10-06T09:00Z")], 0, Date.parse("2027-01-01"))).toThrow("safe integer");
});

test("before/after excludes rollout day and preserves preliminary evidence", () => {
  const rows = [hour("2026-10-04T08:00Z"), hour("2026-10-05T08:00Z", { longOutput: 1_000_000 }),
    hour("2026-10-06T08:00Z", { longMs: 5000 })];
  const comparison = tiboComparison(rows, 1, Date.parse("2026-10-17T12:00Z"));
  expect(comparison.before.calls).toBe(40); expect(comparison.after.calls).toBe(40);
  expect(comparison.speedChange).toBe(100); expect(comparison.speedEnough).toBe(true); expect(comparison.complete).toBe(true);
  expect(tiboComparison(rows, 12, Date.parse("2026-10-17T07:20Z")).after.cache).toBeNull();
  expect(tiboComparison(rows, 12, Date.parse("2026-10-17T07:20Z")).complete).toBe(false);
  for (const overrides of [{ account: "b" }, { model: "x" }, { mode: null }, { plan: "plus" }, { funding: "credits" }])
    expect(tiboCohortKey(hour("2026-10-06T08:00Z", overrides))).not.toBe(tiboCohortKey(rows[0]!));
});

test("the speed promise only applies to Astra/Sol at default speed, with unknown distinct from outside", () => {
  expect(tiboSpeedScope(hour("2026-10-06T08:00Z"))).toBe("applicable");
  expect(tiboSpeedScope(hour("2026-10-06T08:00Z", { model: "gpt-6-astra-2026-09-03" }))).toBe("applicable");
  expect(tiboSpeedScope(hour("2026-10-06T08:00Z", { model: "gpt-6-luna" }))).toBe("outside");
  expect(tiboSpeedScope(hour("2026-10-06T08:00Z", { mode: "priority" }))).toBe("outside");
  expect(tiboSpeedScope(hour("2026-10-06T08:00Z", { mode: null }))).toBe("unknown");
});
