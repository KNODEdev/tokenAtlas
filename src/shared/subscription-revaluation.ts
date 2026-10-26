import type { CodexComparisonWindow } from "./codex-accounting";

function planKey(window: CodexComparisonWindow): string | null {
  if (!window.plan_detail || window.plan_detail.status !== "resolved") return null;
  return window.plan_detail.label;
}

/** Only the common priced cohort contributes to either side of the identity. */
export function referenceValuationPer100(window: CodexComparisonWindow) {
  const usage = window.usage;
  if (!(window.observed_pp > 2) || !Number.isFinite(window.observed_pp)
    || !(usage.revaluation_events! > 0) || !Number.isFinite(usage.paired_historical_api)
    || !Number.isFinite(usage.paired_reference_api)) return null;
  const scale = 100 / window.observed_pp;
  return { historical: usage.paired_historical_api! * scale, reference: usage.paired_reference_api! * scale };
}

export type ReferenceComparisonIssue = "same_cycle" | "different_account" | "different_duration" | "unresolved_plan" | "different_plan" | "different_multiplier" | "invalid_dates" | "overlapping_cycles" | "same_reset" | "small_sample" | "missing_prices";
export function referenceComparisonIssue(before: CodexComparisonWindow, after: CodexComparisonWindow): ReferenceComparisonIssue | null {
  if (before.id === after.id) return "same_cycle";
  if (before.account !== after.account) return "different_account";
  if (before.window_minutes !== after.window_minutes) return "different_duration";
  if (planKey(before) === null || planKey(after) === null) return "unresolved_plan";
  if (planKey(before) !== planKey(after)) return "different_plan";
  if (before.plan_detail?.multiplier !== after.plan_detail?.multiplier) return "different_multiplier";
  const dates = [before.start, before.end, after.start, after.end, before.reset, after.reset].map(Date.parse);
  if (!dates.every(Number.isFinite) || dates[0]! >= dates[1]! || dates[2]! >= dates[3]!) return "invalid_dates";
  if (Math.abs(dates[4]! - dates[5]!) <= 120000) return "same_reset";
  if (dates[1]! > dates[2]!) return "overlapping_cycles";
  if (![before.observed_pp, after.observed_pp].every(pp => Number.isFinite(pp) && pp > 2)) return "small_sample";
  if (!referenceValuationPer100(before) || !referenceValuationPer100(after)) return "missing_prices";
  return null;
}

/** Counter identity is the enclosing report's selected counter; callers must not merge reports. */
export function compareReferenceValuations(before: CodexComparisonWindow, after: CodexComparisonWindow) {
  if (referenceComparisonIssue(before, after)) return null;
  const first = referenceValuationPer100(before), second = referenceValuationPer100(after);
  if (!first || !second) return null;
  return {
    historical_change: second.historical - first.historical,
    price_effect: (second.historical - second.reference) - (first.historical - first.reference),
    fixed_price_work_difference: second.reference - first.reference,
  };
}
