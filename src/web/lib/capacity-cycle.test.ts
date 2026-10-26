import { describe, expect, test } from "bun:test";
import type { ClaudeCodeCapacitySummary } from "../../shared/claude-code-capacity";
import { analyseCycleSelection, bucketCycleUsage, emptyCycleUsage, parseUtcDateTimeInput, sumCycleUsage, utcDateTimeInput, type DetailedCapacityCycle } from "./capacity-cycle";

const at = (minute: number) => Date.parse("2026-09-08T10:00:00Z") + minute * 60000;
const point = (minute: number, tokens = 100, unpriced = false) => ({ ...emptyCycleUsage(), ts: at(minute), events: 1, tokens,
  api_standard: unpriced ? 0 : tokens / 100, credits_low: unpriced ? 0 : tokens / 10, credits_high: unpriced ? 0 : tokens / 5, unpriced_events: unpriced ? 1 : 0 });
function cycle(): DetailedCapacityCycle {
  return { id: "sample", account: "claude1", plan: "pro", reset: new Date(at(300)).toISOString(), start: new Date(at(0)).toISOString(), end: new Date(at(180)).toISOString(),
    start_percent: 0, end_percent: 50, observed_pp: 50, probes: 3, max_gap_hours: 1, usage: { ...emptyCycleUsage(), input: 0, cached: 0, output: 0, fast_tokens: 0, priced_tokens: 0 }, sources: [], models: [],
    timeline: { usage: [point(0), point(30), point(60), point(90), point(120), point(150), point(180)],
      readings: [{ ts: at(10), percent: 20, source: "probe" }, { ts: at(60), percent: 30, source: "probe" }, { ts: at(170), percent: 40, source: "probe" }] } };
}

function claudeSummary(): ClaudeCodeCapacitySummary {
  return {
    algorithm: 3, window_id: "sample", api_value_basis: "standard", rule: "claude-code-cli-entrypoint@2", account: "claude1", basis: "interval",
    source_from: new Date(at(10)).toISOString(), source_through: new Date(at(170)).toISOString(), as_of: new Date(at(170)).toISOString(),
    reset_at: new Date(at(10080)).toISOString(), window_started_at: new Date(at(0)).toISOString(), share_percent: 12, utilization_percent: 40,
    conditional: true, reason: null,
    weekly_capacity_tokens: { value: 4166666.666666667, absent: null }, weekly_capacity_api_usd: { value: 416.6666666666667, absent: null },
    account_total_tokens: { value: 1, absent: null }, account_total_api_usd: { value: 1, absent: null },
    observed_code_tokens: 120000, observed_code_api_usd: 12,
    coverage: { product_rule: "claude-code-cli-entrypoint@2", code_events: 1, other_product_events: 0, unknown_events: 0,
      conflicting_product_events: 0, duplicate_copies: 0, conflicting_usage_identities: 0, cross_machine: "unconfirmed",
      complete_from_window_start: false, assumptions: [] },
  };
}

describe("manual capacity samples", () => {
  test("uses a shared Claude result only for its exact source interval and keeps arbitrary selections unavailable", () => {
    const c = { ...cycle(), start: new Date(at(10)).toISOString(), end: new Date(at(170)).toISOString(), end_percent: 40,
      reset: new Date(at(10080)).toISOString(), window_minutes: 10080, cycle_start: new Date(at(0)).toISOString(), cycle_end: new Date(at(10080)).toISOString(), claude_code_capacity: claudeSummary() };
    const exact = analyseCycleSelection(c, { from: at(0), to: at(180) }, "tokens");
    expect(exact.matched).toMatchObject({ from: at(10), to: at(170), pp: 20 });
    expect(exact.selected.tokens).toBe(600);
    expect(exact.matchedUsage.tokens).toBe(500);
    expect(exact.perPoint).toBeCloseTo(4166666.666666667 / 100, 12);
    expect(exact.full).toBeCloseTo(4166666.666666667, 8);
    expect(exact.conditional).toBe(true);
    expect(exact.partial).toBe(false);
    const arbitrary = analyseCycleSelection(c, { from: at(0), to: at(120) }, "tokens");
    expect(arbitrary.selected.tokens).toBe(400);
    expect(arbitrary.matchedUsage.tokens).toBe(200);
    expect(arbitrary.perPoint).toBeNull();
    expect(arbitrary.full).toBeNull();
  });

  test("normalizes Fast capacity within exact selected meter bounds while retaining raw work", () => {
    const c = cycle();
    c.timeline.usage = [point(30), { ...point(60), api_normalized: 2 }];
    const result = analyseCycleSelection(c, { from: at(0), to: at(180) }, "api_standard");
    expect(result.matchedUsage.api_standard).toBe(2);
    expect(result.matchedUsage.api_normalized).toBe(3);
    expect(result.perPoint).toBe(0.15);
    expect(result.full).toBe(15);
    expect(bucketCycleUsage(c.timeline.usage, { from: at(0), to: at(180) }, 120)[0]!.usage.api_normalized).toBe(3);
  });
  test("uses exact events between inward meter bounds, independently of chart resolution", () => {
    const c = cycle(), range = { from: at(7), to: at(173) };
    const result = analyseCycleSelection(c, range, "tokens");
    expect(result.matched).toMatchObject({ from: at(10), to: at(170), pp: 20 });
    expect(result.selected.tokens).toBe(500);
    expect(result.matchedUsage.tokens).toBe(500);
    expect(result.perPoint).toBe(25); expect(result.full).toBe(2500);
    for (const minutes of [30, 60, 120]) {
      const bars = bucketCycleUsage(c.timeline.usage, range, minutes);
      expect(bars.reduce((total, bar) => total + bar.usage.tokens, 0)).toBe(result.selected.tokens);
      expect(bars[0]!.from).toBe(range.from); expect(bars.at(-1)!.to).toBe(range.to);
    }
  });
  test("chart boundaries are half open and cumulative meter boundaries are left exclusive", () => {
    const points = [point(30), point(60), point(90)];
    expect(sumCycleUsage(points, { from: at(30), to: at(90) }).tokens).toBe(200);
    expect(sumCycleUsage(points, { from: at(30), to: at(90) }, true).tokens).toBe(200);
    expect(sumCycleUsage([point(30)], { from: at(30), to: at(90) }, true).events).toBe(0);
    expect(sumCycleUsage([point(90)], { from: at(30), to: at(90) }, true).events).toBe(1);
  });
  test("does not use a scheduled zero, meter readings outside the range or a one-point sample", () => {
    const c = cycle();
    c.start_basis = "reset";
    expect(analyseCycleSelection(c, { from: at(0), to: at(59) }, "tokens").reason).toBe("missing_readings");
    c.timeline.readings = [{ ts: at(10), percent: 20, source: "probe" }, { ts: at(170), percent: 21, source: "probe" }];
    expect(analyseCycleSelection(c, { from: at(0), to: at(180) }, "tokens").full).toBeNull();
  });
  test("a real decline, absent traffic and saturation cannot inflate capacity", () => {
    const c = cycle(), range = { from: at(0), to: at(180) };
    c.timeline.readings[1]!.percent = 19;
    expect(analyseCycleSelection(c, range, "tokens").reason).toBe("decreased");
    c.timeline.readings[1]!.percent = 100; c.timeline.readings[2]!.percent = 100;
    const result = analyseCycleSelection(c, range, "tokens");
    expect(result.matched!.to).toBe(at(60)); expect(result.matchedUsage.events).toBe(2);
    expect(analyseCycleSelection(c, { from: at(60), to: at(180) }, "tokens").full).toBeNull();
    c.timeline.usage = [];
    expect(analyseCycleSelection(c, range, "tokens").reason).toBe("no_traffic");
  });
  test("keeps missing prices as missing and partial amounts as lower bounds", () => {
    const c = cycle(), range = { from: at(0), to: at(180) };
    c.timeline.usage = [point(30, 100, true)];
    expect(analyseCycleSelection(c, range, "tokens").full).toBe(500);
    expect(analyseCycleSelection(c, range, "api_standard").reason).toBe("unpriced");
    c.timeline.usage.push(point(60));
    expect(analyseCycleSelection(c, range, "api_standard")).toMatchObject({ partial: true, full: 5 });
    expect(analyseCycleSelection(c, range, "credits_low").full).toBe(50);
    expect(analyseCycleSelection(c, range, "credits_high").full).toBe(100);
  });
  test("preserves seconds, UTC and day boundaries without rounding event totals", () => {
    const time = Date.parse("2026-09-08T23:59:37Z");
    expect(parseUtcDateTimeInput(utcDateTimeInput(time))).toBe(time);
    expect(parseUtcDateTimeInput(utcDateTimeInput(time + 417))).toBe(time + 417);
    expect(Number.isNaN(parseUtcDateTimeInput(""))).toBe(true);
    const bars = bucketCycleUsage([{ ...point(0), ts: time }], { from: time - 1000, to: time + 60000 }, 30);
    expect(bars).toHaveLength(2); expect(bars[0]!.usage.events).toBe(1); expect(bars[1]!.usage.events).toBe(0);
  });
});
