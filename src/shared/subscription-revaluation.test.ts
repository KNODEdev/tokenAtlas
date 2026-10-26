import { expect, test } from "bun:test";
import { compareReferenceValuations, referenceValuationPer100 } from "./subscription-revaluation";
import type { CodexComparisonWindow } from "./codex-accounting";

const before: CodexComparisonWindow = {
  id: "before", account: "a", plan: "pro", window_minutes: 10080, reset: "2026-08-08T00:00:00Z", start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z",
  start_percent: 0, end_percent: 50, observed_pp: 50, probes: 2, max_gap_hours: 24, models: [], sources: [],
  plan_detail: { status: "resolved", label: "Pro", multiplier: 1 },
  usage: { events: 2, tokens: 200, input: 200, cached: 0, output: 0, fast_tokens: 0, unknown_tokens: 0, priced_tokens: 100, unpriced_events: 1,
    api_standard: 30, credits_low: 0, credits_high: 0, paired_historical_api: 10, paired_reference_api: 5, revaluation_tokens: 100, revaluation_events: 1 },
};
const after = { ...before, id: "after", start: "2026-08-08T00:00:00Z", end: "2026-08-09T00:00:00Z", reset: "2026-08-15T00:00:00Z", usage: { ...before.usage, paired_historical_api: 5, paired_reference_api: 5 } };

test("identical work with price-only reduction leaves zero fixed-price work difference", () => {
  expect(referenceValuationPer100(before)).toEqual({ historical: 20, reference: 10 });
  expect(compareReferenceValuations(before, after)).toEqual({ historical_change: -10, price_effect: -10, fixed_price_work_difference: 0 });
});
test("price decomposition is exactly additive on the common cohort with independent meter denominators", () => {
  const result = compareReferenceValuations(before, { ...after, observed_pp: 25 })!;
  expect(result.historical_change).toBe(result.price_effect + result.fixed_price_work_difference);
  expect(result.fixed_price_work_difference).toBe(10);
});
test("unknown plans, different accounts or counters, insufficient meter change and absent paired data cannot compare", () => {
  for (const patch of [{ account: "b" }, { plan_detail: undefined }, { window_minutes: 300 }, { observed_pp: 1 }, { usage: { ...after.usage, revaluation_events: 0 } }]) {
    expect(compareReferenceValuations(before, { ...after, ...patch })).toBeNull();
  }
});

test("unknown details, different multipliers, overlapping samples and the same reset cannot compare", () => {
  expect(compareReferenceValuations(before, { ...after, plan_detail: { status: "unknown", label: "pro", multiplier: null } })).toBeNull();
  expect(compareReferenceValuations({ ...before, plan_detail: { status: "resolved", label: "Pro", multiplier: 5 } }, { ...after, plan_detail: { status: "resolved", label: "Pro", multiplier: 20 } })).toBeNull();
  expect(compareReferenceValuations(before, { ...after, start: before.start })).toBeNull();
  expect(compareReferenceValuations(before, { ...after, reset: before.reset })).toBeNull();
});
