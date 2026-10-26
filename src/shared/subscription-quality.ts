import type { CodexComparisonWindow } from "./codex-accounting";
import { claudeShareNeverReported } from "./claude-code-capacity";

export interface WindowEvidence {
  archive_completeness: "unconfirmed";
  mode_relevant: boolean;
  meter_gaps: Array<{ from: string; to: string; minutes: number }>;
  sources: Array<{ name: string; first: string; last: string; events: number; tokens: number; paired_events: number; paired_tokens: number }>;
  declared_sources: Array<{ name: string; observed: boolean | null; from?: string; until?: string }>;
  excluded_events: { counter: number; plan: number; reset: number; imprecise_time?: number; funding?: number };
  imports?: {
    stored_runs: number; inspected_runs: number; unreadable_runs: number; truncated: boolean;
    related_count: number;
    related: Array<{ id: string; started: string; status: string; has_error: boolean; warnings: number; relation: "changed_range" | "run_time" }>;
  };
}

export type WindowQuality = "comparable" | "partial" | "insufficient";
export type QualityReason = "no_traffic" | "small_meter_change" | "no_prices" | "unknown_plan" | "inferred_zero"
  | "uncertain_reset" | "meter_gap" | "partial_prices" | "unknown_mode" | "source_without_traffic" | "source_identity_unresolved" | "conditional_code_estimate" | "imprecise_time" | "mismatched_counter" | "evidence_unavailable" | "manual_measurement" | "approximate_time"
  | "share_never_reported";

/** Eligibility for descriptive comparisons, never a certificate of archive completeness. */
export function assessWindowQuality(w: CodexComparisonWindow): { status: WindowQuality; reasons: QualityReason[]; rounding: { lower_pp: number; upper_pp: number } } {
  const reasons: QualityReason[] = [];
  const add = (reason: QualityReason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const shared = w.claude_code_capacity;
  const hasSharedEstimate = (estimate: unknown) => {
    if (!estimate || typeof estimate !== "object") return false;
    const value = estimate as { value?: unknown; absent?: unknown };
    return value.absent === null && typeof value.value === "number" && Number.isFinite(value.value) && value.value > 0;
  };
  if (w.manual_measurement) add("manual_measurement");
  if (w.manual_measurement?.approximate_time) add("approximate_time");
  if (!w.usage.events || !w.usage.tokens) add("no_traffic");
  if (!Number.isFinite(w.observed_pp) || w.observed_pp <= 2) add("small_meter_change");
  if (w.usage.events > 0 && w.usage.unpriced_events >= w.usage.events) add("no_prices");
  if (!w.plan || !w.plan_detail || w.plan_detail.status !== "resolved") add("unknown_plan");
  if (!w.evidence) add("evidence_unavailable");
  if (w.start_basis === "reset" && (w.first_probe?.percent ?? 0) > 0) add("inferred_zero");
  if (w.cycle_end_basis === "uncertain") add("uncertain_reset");
  // This is an explicit comparison policy, not a provider refresh guarantee.
  if (w.max_gap_hours > 0.5) add("meter_gap");
  if (w.usage.unpriced_events > 0 && !reasons.includes("no_prices")) add("partial_prices");
  if (w.evidence?.mode_relevant !== false && w.usage.unknown_tokens > 0) add("unknown_mode");
  if (w.evidence?.declared_sources.some(s => s.observed === false)) add("source_without_traffic");
  if (w.evidence?.declared_sources.some(s => s.observed === null)) add("source_identity_unresolved");
  if (w.evidence?.excluded_events.imprecise_time) add("imprecise_time");
  if (w.evidence && (w.evidence.excluded_events.plan > 0 || w.evidence.excluded_events.reset > 0)) add("mismatched_counter");
  // Claude's shared result is a conditional account equivalent. Keep valid
  // results visibly partial because cross-machine coverage is unconfirmed;
  // an explicit unavailable marker is insufficient and must not fall back to
  // local meter arithmetic.
  // A window the vendor sent no share for is measured from local traffic instead (claudeShareNeverReported).
  const shareNeverReported = claudeShareNeverReported(w);
  const sharedUnavailable = shared !== undefined && !shareNeverReported && (!shared || shared.conditional !== true
    || (!hasSharedEstimate(shared.weekly_capacity_tokens) && !hasSharedEstimate(shared.weekly_capacity_api_usd)));
  if (sharedUnavailable) add("evidence_unavailable");
  else if (shareNeverReported) add("share_never_reported");
  else if (shared !== undefined) add("conditional_code_estimate");
  if (w.observed_pp > 2 && w.observed_pp < 10) add("small_meter_change");
  const insufficient = sharedUnavailable || reasons.some(r => r === "no_traffic" || r === "no_prices")
    || !Number.isFinite(w.observed_pp) || w.observed_pp <= 2;
  // Sensitivity scenario: each of two readings can differ by one pp. Not a confidence interval.
  const pp = Number.isFinite(w.observed_pp) ? w.observed_pp : 0;
  return { status: insufficient ? "insufficient" : reasons.length ? "partial" : "comparable", reasons,
    rounding: { lower_pp: Math.max(0, pp - 2), upper_pp: Math.min(100, pp + 2) } };
}

export function filterWindowQuality(windows: CodexComparisonWindow[], quality: "all" | WindowQuality) {
  return quality === "all" ? windows : windows.filter(w => assessWindowQuality(w).status === quality);
}
