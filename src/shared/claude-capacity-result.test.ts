import { expect, test } from "bun:test";
import { claudeCapacityResult, claudeCapacityResultFromSummary, claudeCapacityPerPoint, manualClaudeCapacityResult } from "./claude-capacity-result";
import { emptyWindowUsage } from "../server/subscription-window-comparison";
import { capacityPerPoint, compareCapacity, dimensionComparison } from "../web/lib/codex-capacity";
import { analyseCycleSelection } from "../web/lib/capacity-cycle";
import type { CodexComparisonWindow } from "./codex-accounting";
import type { ClaudeCodeCapacitySummary } from "./claude-code-capacity";
import type { DetailedCapacityCycle } from "../web/lib/capacity-cycle";

const from = "2026-09-01T00:00:00.000Z", through = "2026-09-03T00:00:00.000Z";
const coverage = { product_rule: "fixture", code_events: 200, other_product_events: 0, unknown_events: 0,
  conflicting_product_events: 0, duplicate_copies: 0, conflicting_usage_identities: 0,
  cross_machine: "unconfirmed" as const, complete_from_window_start: false, assumptions: ["fixture"] };
function summary(): ClaudeCodeCapacitySummary {
  return { algorithm: 11, rule: "fixture", account: "a", window_id: "w", api_value_basis: "standard", basis: "interval",
    source_from: from, source_through: through, sample_meter: { start_percent: 20, end_percent: 40, observed_pp: 20 },
    as_of: through, reset_at: "2026-09-08T00:00:00.000Z", window_started_at: from, share_percent: 50, utilization_percent: 40,
    conditional: true, reason: null, weekly_capacity_tokens: { value: 30_000_000, absent: null }, weekly_capacity_api_usd: { value: 300, absent: null },
    account_total_tokens: { value: null, absent: "not_cumulative" }, account_total_api_usd: { value: null, absent: "not_cumulative" },
    observed_code_tokens: 3_000_000, observed_code_api_usd: 30, coverage,
    observed_models: [
      { model: "claude-opus-fixture", events: 100, tokens: 1_000_000, fresh: 100_000, api_standard: 20, unpriced_events: 0 },
      { model: "claude-haiku-fixture", events: 100, tokens: 2_000_000, fresh: 500_000, api_standard: 10, unpriced_events: 0 },
    ] };
}
function window(): CodexComparisonWindow {
  return { id: "w", account: "a", plan: "max", window_minutes: 10080, start: from, end: through, reset: "2026-09-08T00:00:00.000Z",
    start_percent: 20, end_percent: 40, observed_pp: 20, probes: 2, max_gap_hours: 48,
    usage: { ...emptyWindowUsage(), events: 200, tokens: 3_000_000, input: 2_000_000, cached: 1_000_000, output: 1_000_000, api_standard: 30 },
    models: [], sources: [], claude_code_capacity: summary() };
}

test("model equivalents quote the same unrounded API point, with an explicit cache-mix reference and source interval", () => {
  const result = claudeCapacityResult(window()), opus = result.models.find(row => row.model === "claude-opus-fixture"),
    haiku = result.models.find(row => row.model === "claude-haiku-fixture");
  expect(claudeCapacityPerPoint(result, "api_standard")).toBe(3);
  expect(opus!.gross_tokens_per_point).toBe(150_000);
  expect(haiku!.gross_tokens_per_point).toBe(600_000);
  expect(opus!.fresh_tokens_per_point).toBe(15_000);
  expect(haiku!.price_index).toBe(0.25);
  expect(result.price_reference_model).toBe("claude-opus-fixture");
  expect(opus!.points_used! + haiku!.points_used!).toBe(10);
  expect(opus!.share_of_points! + haiku!.share_of_points!).toBe(50);
  expect(result.coverage).toEqual(coverage);
  expect(result.sample).toMatchObject({ from, through, start_inclusive: false, end_inclusive: true });
});

test("zero-token turns and partly priced models never acquire exact effective prices or token equivalents", () => {
  const input = summary();
  input.observed_models!.push({ model: "synthetic", events: 3, tokens: 0, fresh: 0, api_standard: 0, unpriced_events: 0 });
  input.observed_models![0]!.unpriced_events = 1;
  input.weekly_capacity_api_usd = { value: 300, absent: null, relation: "≥" };
  const result = claudeCapacityResultFromSummary(input);
  expect(result.capacity_tokens.value).toBe(30_000_000);
  expect(result.models.find(row => row.model === "claude-opus-fixture")!.usd_per_1m_gross).toBeNull();
  expect(result.models.every(row => row.gross_tokens_per_point === null)).toBe(true);
});

test("foreign accounts, windows and non-weekly automatic meters cannot donate a shared result", () => {
  const original = window();
  for (const other of [{ ...original, account: "b" }, { ...original, id: "different" }, { ...original, window_minutes: 300 }]) {
    const result = claudeCapacityResult(other);
    expect(result.capacity_api_usd.value).toBeNull();
    expect(result.capacity_tokens.value).toBeNull();
  }
});

test("manual dimensions cannot repeat the whole-account result for every model or source", () => {
  const w = window();
  delete w.claude_code_capacity;
  w.manual_measurement = { id: "m", approximate_time: false, note: "fixture" };
  w.models = [{ ...w.usage, name: "first" }, { ...w.usage, name: "second" }];
  w.sources = [{ ...w.usage, name: "machine" }];
  w.claude_capacity = claudeCapacityResult(w);
  expect(capacityPerPoint(w, "api_standard")).toBe(1.5);
  expect(capacityPerPoint(w, "fresh")).toBe(50_000);
  for (const dim of ["models", "sources"] as const)
    expect(dimensionComparison(w, w, dim).every(row => row.before === null && row.after === null)).toBe(true);
});

test("detail selections consume only the exact prepared source interval, including historical share-less cycles", () => {
  const w = window();
  w.claude_code_capacity = { ...summary(), reason: "share_absent", share_percent: null };
  w.claude_capacity = claudeCapacityResult(w);
  const usage = { ts: Date.parse(through), events: 200, tokens: 3_000_000, api_standard: 30, credits_low: 0, credits_high: 0, unpriced_events: 0, unknown_tokens: 0 };
  const cycle = { ...w, timeline: { readings: [{ ts: Date.parse(from), percent: 20, source: "probe" }, { ts: Date.parse(through), percent: 40, source: "probe" }], usage: [usage] } } as DetailedCapacityCycle;
  const selected = analyseCycleSelection(cycle, { from: Date.parse(from), to: Date.parse(through) }, "api_standard");
  expect(selected.perPoint).toBe(capacityPerPoint(w, "api_standard"));
  expect(selected.conditional).toBe(true);
  cycle.claude_capacity!.sample!.from = "2026-09-01T01:00:00.000Z";
  expect(analyseCycleSelection(cycle, { from: Date.parse(from), to: Date.parse(through) }, "api_standard").perPoint).toBeNull();
});

test("gauge calibration retains Actual valuation and its exclusive cutoff rather than borrowing Standard", () => {
  const result = manualClaudeCapacityResult({ account: "a", window_id: "gauge:g", from, through, percent: 20,
    models: [{ model: "opus", events: 100, tokens: 1000, fresh: 200, api_standard: 6, unpriced_events: 0 }] });
  expect(result.api_value_basis).toBe("actual");
  expect(result.sample!.end_inclusive).toBe(false);
  expect(claudeCapacityPerPoint(result, "api_standard")).toBe(0.3);
});

test("comparisons use the result's capacity and price quality rather than whole-cycle totals", () => {
  const before = window(), after = { ...window(), id: "next", start: "2026-09-08T00:00:00.000Z",
    end: "2026-09-10T00:00:00.000Z", reset: "2026-09-15T00:00:00.000Z" };
  before.claude_capacity = claudeCapacityResult(before);
  after.claude_code_capacity = { ...summary(), window_id: "next", source_from: after.start, source_through: after.end,
    weekly_capacity_api_usd: { value: 450, absent: null }, weekly_capacity_tokens: { value: 60_000_000, absent: null } };
  after.claude_capacity = claudeCapacityResult(after);
  const comparison = compareCapacity(before, after);
  expect(comparison.change("api_standard")).toBe(50);
  expect(comparison.change("tokens")).toBe(100);
  after.claude_capacity.capacity_api_usd = { value: 450, absent: null, relation: "≥" };
  expect(compareCapacity(before, after).change("api_standard")).toBeNull();
  expect(compareCapacity(before, after).change("tokens")).toBe(100);
});
