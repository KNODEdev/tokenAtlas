import { describe, expect, it } from "bun:test";
import type { ClaudeCodeCapacitySummary } from "../../shared/claude-code-capacity";
import type { CodexComparisonWindow as Window } from "../../server/codex-window-comparison";
import { assessWindowQuality } from "../../shared/subscription-quality";
import { capacityScaleMaximum, capacityEstimate, capacityFull, capacityIsLowerBound, capacityLocalLowerBound, capacityMeasurement, capacityMedianSample, capacityMissingReason, capacityPeriodLabel, capacityPerPoint, compareCapacity, defaultCapacityPair, dimensionComparison, filterCapacityWindows, normalizeCapacityMinObservedPercent, promotionImpact, usageTokenTypes } from "./codex-capacity";

function window(id: string, start: string, overrides: Partial<Window> = {}): Window {
  return { id, account: "codex1", plan: "pro", start: `${start}T00:00:00Z`, end: `${start}T12:00:00Z`, reset: `${start}T23:00:00Z`,
    start_percent: 0, end_percent: 50, observed_pp: 50, probes: 10, max_gap_hours: 1,
    usage: { events: 100, unpriced_events: 0, tokens: 100000000, input: 90000000, cached: 80000000, output: 10000000,
      fast_tokens: 0, unknown_tokens: 0, priced_tokens: 100000000, api_standard: 1000, credits_low: 25000, credits_high: 50000 },
    sources: [], models: [], ...overrides };
}

function claudeSummary(overrides: Partial<ClaudeCodeCapacitySummary> = {}): ClaudeCodeCapacitySummary {
  return {
    algorithm: 3, window_id: "claude", api_value_basis: "standard", rule: "claude-code-cli-entrypoint@2", account: "codex1", basis: "interval",
    source_from: "2026-09-02T00:00:00Z", source_through: "2026-09-07T12:00:00Z", as_of: "2026-09-07T12:00:00Z",
    reset_at: "2026-09-08T00:00:00Z", window_started_at: "2026-09-01T00:00:00Z", share_percent: 12, utilization_percent: 24,
    conditional: true, reason: null,
    weekly_capacity_tokens: { value: 4166666.666666667, absent: null },
    weekly_capacity_api_usd: { value: 416.6666666666667, absent: null },
    account_total_tokens: { value: 1000000, absent: null }, account_total_api_usd: { value: 100, absent: null },
    observed_code_tokens: 120000, observed_code_api_usd: 12,
    coverage: { product_rule: "claude-code-cli-entrypoint@2", code_events: 1, other_product_events: 0, unknown_events: 1,
      conflicting_product_events: 0, duplicate_copies: 0, conflicting_usage_identities: 0, cross_machine: "unconfirmed",
      complete_from_window_start: false, assumptions: [] },
    ...overrides,
  };
}

function claudeWindow(overrides: Partial<Window> = {}): Window {
  return window("claude", "2026-09-01", {
    start: "2026-09-02T00:00:00Z", end: "2026-09-07T12:00:00Z", reset: "2026-09-08T00:00:00Z", window_minutes: 10080,
    cycle_start: "2026-09-01T00:00:00Z", end_percent: 24, observed_pp: 24, claude_code_capacity: claudeSummary(), ...overrides,
  });
}
describe("capacity comparison", () => {
  it("keeps a saturated Claude cycle's bar and quotes only its frozen measurement", () => {
    const w = claudeWindow({ end_percent: 100, observed_pp: 91, claude_code_capacity: claudeSummary({
      utilization_percent: 100, sample_meter: { start_percent: 20, end_percent: 100, observed_pp: 80 },
    }) });
    expect(capacityFull(w, "api_standard")).toBeCloseTo(416.6666666666667, 9);
    expect(capacityMissingReason(w, "observed")).toBeNull();
    expect(capacityEstimate(w, "api_standard")).toMatchObject({ total: 12, remaining: 0 });
    expect(capacityEstimate(w, "tokens").total).toBe(120000);
    expect(capacityEstimate(w, "fresh").total).toBeNull();
    expect(capacityMeasurement(w)).toMatchObject({ start_percent: 20, end_percent: 100, observed_pp: 80,
      start: w.claude_code_capacity!.source_from, end: w.claude_code_capacity!.source_through });
    expect(w.usage.api_standard).toBe(1000);
    expect(w.usage.tokens).toBe(100000000);
  });
  it("uses only a matching conditional Claude weekly summary and keeps actual totals separate", () => {
    const w = claudeWindow(), original = structuredClone(w.usage);
    expect(capacityPerPoint(w, "tokens")).toBeCloseTo(4166666.666666667 / 100, 12);
    expect(capacityPerPoint(w, "api_standard")).toBeCloseTo(416.6666666666667 / 100, 12);
    expect(capacityPerPoint({ ...w, promotion: { status: "configured", factor: 2, regime_ids: [], notes: [], sources: [] } }, "tokens", "regular"))
      .toBeCloseTo(4166666.666666667 / 200, 12);
    expect(capacityEstimate(w, "tokens")).toMatchObject({ total: w.usage.tokens, full: 4166666.666666667 });
    expect(capacityEstimate(w, "api_standard").total).toBe(w.usage.api_standard);
    expect(w.usage).toEqual(original);
    for (const metric of ["credits_low", "credits_high", "fresh", "cached", "output"] as const) expect(capacityPerPoint(w, metric)).toBeNull();
    const cumulative = claudeWindow({ start: "2026-09-01T00:00:00Z", claude_code_capacity: claudeSummary({ basis: "cumulative", source_from: "2026-09-01T00:00:00Z" }) });
    expect(capacityPerPoint(cumulative, "tokens")).toBeCloseTo(4166666.666666667 / 100, 12);
  });

  it("marks a partial sample as a lower bound and keeps it out of exact medians", () => {
    const w = claudeWindow({ end_percent: 100, observed_pp: 100, claude_code_capacity: claudeSummary({
      utilization_percent: 100, sample_meter: { start_percent: 20, end_percent: 100, observed_pp: 80 },
      weekly_capacity_api_usd: { value: 2000, absent: null, relation: "≥" },
      observed_code_api_usd: null, observed_code_api_usd_subtotal: 1600,
    }) });
    expect(capacityFull(w, "api_standard")).toBe(2000);
    expect(capacityEstimate(w, "api_standard").total).toBe(1600);
    expect(capacityIsLowerBound(w, "api_standard")).toBe(true);
    expect(capacityIsLowerBound(w, "tokens")).toBe(false);
    expect(capacityMedianSample(w, "api_standard")).toMatchObject({ confidence: "low", samplePp: 80 });
    expect(capacityMedianSample(w, "tokens").samplePp).toBe(80);
  });

  it("rejects a null, invalid, mismatched or non-weekly Claude marker without legacy fallback", () => {
    const w = claudeWindow();
    for (const summary of [null, { ...claudeSummary(), api_value_basis: "other" as never }, { ...claudeSummary(), account: "other" },
      { ...claudeSummary(), window_id: "another-window" }, { ...claudeSummary(), conditional: false as never }]) {
      expect(capacityPerPoint({ ...w, claude_code_capacity: summary as Window["claude_code_capacity"] }, "tokens")).toBeNull();
    }
    expect(capacityPerPoint({ ...w, window_minutes: 300 }, "tokens")).toBeNull();
    expect(capacityPerPoint({ ...w, end: "2026-09-07T11:59:00Z" }, "tokens")).not.toBeNull();
    expect(capacityEstimate({ ...w, claude_code_capacity: null }, "api_standard").total).toBe(w.usage.api_standard);
  });

  it("accepts a Claude estimate measured from an in-window plan change, where the cycle starts", () => {
    // Max 5x → Max 20x: the vendor keeps the week's start, the meter restarts at the first reading after the drop.
    const drop = "2026-09-04T09:55:57.164Z";
    const summary = claudeSummary({ basis: "cumulative", source_from: "2026-09-04T09:55:57.165Z",
      counter_reset: { reset_at: "2026-09-08T00:00:00Z", last_before: { at: "2026-09-03T16:26:51Z", percent: 88 }, first_after: { at: drop, percent: 0 } } });
    const w = claudeWindow({ start: drop, cycle_start: drop, claude_code_capacity: summary });
    expect(capacityPerPoint(w, "api_standard")).toBeCloseTo(416.6666666666667 / 100, 12);
    // The register identity is decisive even if a reading's reset metadata differs.
    expect(capacityPerPoint({ ...w, claude_code_capacity: { ...summary, counter_reset: null } }, "api_standard")).not.toBeNull();
    expect(capacityPerPoint({ ...w, id: "different-window" }, "api_standard")).toBeNull();
  });

  it("measures a window the vendor sent no share for from local traffic, and keeps other gaps as a lower bound", () => {
    const w = claudeWindow({ claude_code_capacity: claudeSummary({ share_percent: null, reason: "share_absent" }) });
    expect(capacityPerPoint(w, "api_standard")).toBeCloseTo(1000 / 24, 9);
    expect(capacityMissingReason(w, "observed")).toBeNull();
    expect(capacityLocalLowerBound(w, "api_standard")).toBeNull();
    expect(assessWindowQuality(w).reasons).toContain("share_never_reported");
    expect(assessWindowQuality(w).status).toBe("partial");
    // Only this window's own summary qualifies.
    expect(capacityPerPoint({ ...w, id: "different-window" }, "api_standard")).toBeNull();
    const saturated = claudeWindow({ claude_code_capacity: claudeSummary({ share_percent: null, reason: "utilization_saturated" }) });
    expect(capacityPerPoint(saturated, "api_standard")).toBeNull();
    expect(capacityLocalLowerBound(saturated, "api_standard")).toBeCloseTo(1000 / 24 * 100, 9);
    expect(capacityLocalLowerBound(w, "credits_low")).toBeNull();
    expect(capacityLocalLowerBound(claudeWindow(), "api_standard")).toBeNull();
    expect(capacityLocalLowerBound(window("codex", "2026-09-01"), "api_standard")).toBeNull();
  });

  it("does not give an account-wide Claude estimate to source rows, and marks it conditional", () => {
    const w = claudeWindow({ sources: [{ ...claudeWindow().usage, name: "cli" }] });
    expect(dimensionComparison(w, w, "sources")).toEqual([{ name: "cli", before: null, after: null, beforeShare: 100, afterShare: 100 }]);
    expect(assessWindowQuality(w).status).toBe("partial");
    expect(assessWindowQuality(w).reasons).toContain("conditional_code_estimate");
    expect(assessWindowQuality({ ...w, claude_code_capacity: null }).status).toBe("insufficient");
  });

  it("uses normalized Fast burden for capacity, scales and comparisons without changing recorded Standard work", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01", { usage: { ...before.usage, api_standard: 500, api_normalized: 1000 } });
    expect(capacityEstimate(after, "api_standard").full).toBe(2000);
    expect(capacityPerPoint(after, "api_standard")).toBe(20);
    expect(capacityScaleMaximum([after], "api_standard")).toBe(20);
    expect(compareCapacity(before, after).change("api_standard")).toBe(0);
    expect(after.usage.api_standard).toBe(500);
    expect(capacityPerPoint({ ...after, promotion: { status: "configured", factor: 2, regime_ids: [], notes: [], sources: [] } }, "api_standard", "regular")).toBe(10);
  });
  it("filters observed meter consumption inclusively and keeps the valid range bounded", () => {
    const rows = [
      window("nine", "2026-06-01", { observed_pp: 9 }),
      window("ten", "2026-06-02", { observed_pp: 10 }),
      window("ninety", "2026-06-03", { observed_pp: 90 }),
      window("ninety-two", "2026-06-04", { observed_pp: 92 }),
    ];
    expect(filterCapacityWindows(rows, 10).map(row => row.id)).toEqual(["ten", "ninety", "ninety-two"]);
    expect(filterCapacityWindows(rows, 92).map(row => row.id)).toEqual(["ninety-two"]);
    expect(normalizeCapacityMinObservedPercent(-1)).toBe(0);
    expect(normalizeCapacityMinObservedPercent(101)).toBe(100);
    expect(normalizeCapacityMinObservedPercent("invalid")).toBe(10);
  });

  it("shows 70% at 2x as 140% of the regular limit, including 40% exceed, without inventing unknown terms", () => {
    const w = window("boost", "2026-09-01", { end_percent: 70, promotion: { status: "configured", factor: 2, regime_ids: [], notes: [], sources: [] } });
    expect(promotionImpact(w)).toEqual({ factor: 2, bonusPercent: 100, regularUsedPercent: 140, excessPercent: 40 });
    expect(promotionImpact({ ...w, end_percent: 20 })?.excessPercent).toBe(0);
    expect(promotionImpact({ ...w, promotion: { ...w.promotion!, factor: 1 } })?.regularUsedPercent).toBe(70);
    expect(promotionImpact({ ...w, promotion: { ...w.promotion!, status: "mixed" } })).toBeNull();
    expect(promotionImpact({ ...w, promotion: undefined })).toBeNull();
    expect(promotionImpact({ ...w, promotion: { ...w.promotion!, factor: NaN } })).toBeNull();
    expect(w.end_percent).toBe(70);
  });
  it("removes a confirmed quota boost from estimates, never from recorded amounts or percentages", () => {
    const w = window("boost", "2026-09-01", { promotion: { status: "configured", factor: 2, regime_ids: [], notes: [], sources: [] } });
    const original = structuredClone(w);
    expect(capacityEstimate(w, "api_standard", "regular")).toEqual({ total: 1000, perPoint: 10, full: 1000, remaining: null });
    expect(capacityPerPoint(w, "credits_low", "regular")).toBe(250);
    expect(capacityPerPoint(w, "tokens", "regular")).toBe(1000000);
    expect(w).toEqual(original);
    const before = window("before", "2026-08-01", { promotion: { ...w.promotion!, factor: 1 }, usage: { ...w.usage, api_standard: 500 } });
    expect(compareCapacity(before, w).change("api_standard")).toBe(100);
    expect(compareCapacity(before, w, "regular").change("api_standard")).toBe(0);
    for (const status of ["unknown", "mixed", "uncertain", "invalid"] as const) {
      expect(capacityPerPoint({ ...w, promotion: { ...w.promotion!, status } }, "api_standard", "regular")).toBeNull();
    }
  });
  it("labels the whole reset cycle rather than the last observed day", () => {
    const w = window("cycle", "2026-09-08", { cycle_start: "2026-09-07T00:00:00Z", cycle_end: "2026-09-14T00:00:00Z" });
    expect(capacityPeriodLabel(w, "en-US")).toBe("Sep 7 – 14, 2026");
  });
  it("estimates a full allowance from cumulative usage at 70%, independent of optional comparison", () => {
    const w = window("cycle", "2026-09-01", { end_percent: 70, observed_pp: 70 });
    w.usage = { ...w.usage, api_standard: 1400, credits_low: 35000 };
    expect(capacityEstimate(w, "api_standard")).toEqual({ total: 1400, perPoint: 20, full: 2000, remaining: 600 });
    expect(capacityEstimate(w, "credits_low")).toEqual({ total: 35000, perPoint: 500, full: 50000, remaining: 15000 });
  });
  it("compares measured work per meter point, not raw totals or duration", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01", { observed_pp: 25 });
    after.usage = { ...before.usage, api_standard: 500 };
    expect(compareCapacity(before, after).change("api_standard")).toBe(0);
    expect(capacityPerPoint(after, "fresh")).toBe(400000);
  });
  it("keeps overlapping unknown-mode scenarios distinct from an observed reduction", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01");
    after.usage = { ...before.usage, api_standard: 650, credits_low: 18000, credits_high: 27000 };
    const result = compareCapacity(before, after);
    expect(result.change("api_standard")).toBeCloseTo(-35);
    expect(result.low).toBeCloseTo(-64);
    expect(result.high).toBeCloseTo(8);
    expect(result.scenario).toBe("overlap");
  });
  it("requires even current high to fall below reference low for robust scenario reduction", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01");
    after.usage = { ...before.usage, credits_low: 12000, credits_high: 20000 };
    expect(compareCapacity(before, after).scenario).toBe("lower");
    after.usage.credits_high = before.usage.credits_low;
    expect(compareCapacity(before, after).scenario).toBe("overlap");
  });
  it("does not compare different accounts, unknown/changed plans, same resets or overlapping observations", () => {
    const before = window("before", "2026-08-01");
    for (const overrides of [{ account: "codex2" }, { plan: "plus" }, { plan: null }, { reset: before.reset }, { start: before.start }]) {
      const result = compareCapacity(before, window("after", "2026-09-01", overrides));
      expect(result.compatible).toBe(false);
      expect(result.change("api_standard")).toBeNull();
      expect(result.scenario).toBe("unavailable");
    }
  });
  it("does not infer zero work from a meter observation with no indexed events", () => {
    const empty = window("empty", "2026-09-01");
    empty.usage = { ...empty.usage, events: 0, tokens: 0, input: 0, cached: 0, output: 0 };
    for (const metric of ["tokens", "fresh", "cached", "output", "api_standard"] as const) {
      expect(capacityPerPoint(empty, metric)).toBeNull();
    }
  });
  it("orders scenario values when custom Fast pricing is cheaper than Standard", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01");
    before.usage.credits_high = before.usage.credits_low / 2;
    after.usage = { ...before.usage };
    const result = compareCapacity(before, after);
    expect(result.low).toBe(-50);
    expect(result.high).toBe(100);
    expect(result.scenario).toBe("overlap");
  });
  it("does not turn missing prices, zero meter changes or zero references into numbers", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01");
    after.usage.unpriced_events = after.usage.events;
    expect(capacityPerPoint(after, "api_standard")).toBeNull();
    expect(compareCapacity(before, after).scenario).toBe("unavailable");
    after.observed_pp = 0;
    expect(capacityPerPoint(after, "tokens")).toBeNull();
    before.usage.api_standard = 0;
    expect(compareCapacity(before, after).change("api_standard")).toBeNull();
  });
  it("treats reset timestamp jitter as the same reset and compares actual instants", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01", { reset: "2026-08-01T23:01:00Z" });
    expect(compareCapacity(before, after).compatible).toBe(false);
    after.reset = "2026-09-01T23:00:00Z";
    before.end = "2026-09-01T03:00:00+02:00";
    after.start = "2026-09-01T02:00:00Z";
    expect(compareCapacity(before, after).compatible).toBe(true);
    after.start = "invalid";
    expect(compareCapacity(before, after).compatible).toBe(false);
  });
  it("chooses a stable earlier reference on the current plan, and never silently skips the latest sample", () => {
    const small = window("small", "2026-07-01", { observed_pp: 3 });
    const oldPlan = window("old-plan", "2026-06-01", { plan: "plus" });
    const reference = window("reference", "2026-08-01");
    const current = window("current", "2026-09-01", { observed_pp: 2 });
    expect(defaultCapacityPair([current, small, oldPlan, reference])).toEqual({ baseline: reference, current });
    expect(defaultCapacityPair([oldPlan, current]).baseline).toBeUndefined();
  });
  it("keeps absent source contributions missing rather than claiming zero or a separate quota", () => {
    const before = window("before", "2026-08-01");
    const after = window("after", "2026-09-01");
    before.sources = [{ ...before.usage, name: "main" }];
    after.sources = [{ ...after.usage, name: "laptop" }];
    expect(dimensionComparison(before, after, "sources")).toEqual([
      { name: "main", before: 20, after: null, beforeShare: 100, afterShare: null },
      { name: "laptop", before: null, after: 20, beforeShare: null, afterShare: 100 },
    ]);
  });
});


it("does not compare the same raw plan across distinct resolved tiers or a mixed cycle", () => {
  const before = window("before", "2026-08-01", { plan_detail: { label: "Pro", multiplier: 5, status: "resolved" } });
  const after = window("after", "2026-09-01", { plan_detail: { label: "Pro", multiplier: 20, status: "resolved" } });
  expect(compareCapacity(before, after).compatible).toBe(false);
  expect(compareCapacity({ ...before, plan_detail: { ...before.plan_detail!, multiplier: 20 } }, after).compatible).toBe(true);
  expect(compareCapacity({ ...before, plan_detail: { ...before.plan_detail!, status: "mixed" } }, after).compatible).toBe(false);
  const unknownTier = { label: "Max", multiplier: null, status: "unknown" as const };
  expect(compareCapacity({ ...before, plan: "max", plan_detail: unknownTier }, { ...after, plan: "max", plan_detail: unknownTier }).compatible).toBe(false);
  expect(compareCapacity({ ...before, window_minutes: 300 }, { ...after, window_minutes: 10080 }).compatible).toBe(false);
});

it("short-cycle labels retain times so several 5h cycles on one date are distinguishable", () => {
  const short = window("short", "2026-09-01", { window_minutes: 300, cycle_start: "2026-09-01T01:00:00Z", cycle_end: "2026-09-01T06:00:00Z" });
  expect(capacityPeriodLabel(short, "en-GB")).toContain("01:00");
  expect(capacityPeriodLabel(short, "en-GB")).toContain("06:00");
});


it("scales comparable full-capacity bars from substantial samples without losing outlier values", () => {
  const stable = window("stable", "2026-08-01");
  const small = window("small", "2026-08-03", { observed_pp: 1 });
  expect(capacityScaleMaximum([stable, small], "api_standard")).toBe(20);
  expect(capacityEstimate(small, "api_standard").full).toBe(100000);
  expect(capacityScaleMaximum([small], "api_standard")).toBe(1000);
  expect(capacityScaleMaximum([], "api_standard")).toBe(0);
  expect(capacityScaleMaximum([stable], "api_standard", "regular")).toBe(0);
});

describe("usageTokenTypes", () => {
  const usage = window("types", "2026-08-01").usage;
  it("splits input into fresh, cache read and cache write that add up to the tokens", () => {
    const types = usageTokenTypes({ ...usage, cache_write_5m: 3_000_000, cache_write_unknown: 1_000_000 })!;
    expect(types).toEqual({ fresh: 6_000_000, cached: 80_000_000, cache_write: 4_000_000, output: 10_000_000 });
    expect(types.fresh + types.cached + types.cache_write! + types.output).toBe(usage.tokens);
  });
  it("keeps an unreported cache write unknown rather than zero", () => {
    expect(usageTokenTypes(usage)).toEqual({ fresh: 10_000_000, cached: 80_000_000, cache_write: null, output: 10_000_000 });
  });
  it("gives no breakdown for inconsistent counters", () => {
    expect(usageTokenTypes({ ...usage, cached: usage.input + 1 })).toBeNull();
    expect(usageTokenTypes({ ...usage, output: Number.NaN })).toBeNull();
  });
});
