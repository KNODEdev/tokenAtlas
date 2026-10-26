import type { CapacityBasis, PriceBasis } from "./project-cost";

export interface CycleSettingRow {
  subscription: string;
  vendor: string;
  kind: string;
  label: string;
  period_hours: number | null;
  period_source: string;
  anchor_ts: string | null;
  anchor_source: string;
  history_windows: number;
  history_source: string;
  window_start: string | null;
  next_reset: string | null;
  history_available: number;
  editable: { period: boolean; anchor: boolean; history: boolean };
  declaration_editable: boolean;
  effect: string;
  declared: boolean;
  note: string | null;
  segments: CadenceSegmentRow[];
}
export interface CadenceSegmentRow {
  from: string | null;
  period_hours: number;
  period_source: string;
  anchor_ts: string | null;
  anchor_source: string;
  history_windows?: number | null;
  note?: string | null;
  source: string;
  declaration: boolean;
}
export interface CyclesResponse {
  path: string;
  default_history_windows: number;
  min_history_period_hours: number;
  rows: CycleSettingRow[];
}
export interface CycleSaveRequest {
  subscription: string;
  kind: string;
  period_hours?: number | null;
  anchor_ts?: string | null;
  history_windows?: number | null;
  segments?: Array<{
    from?: string | null;
    period_hours: number;
    anchor_ts?: string | null;
    history_windows?: number | null;
    note?: string | null;
  }>;
  clear?: boolean;
}
export interface CycleSaveResponse {
  ok: true;
  rows: CycleSettingRow[];
}
/** The plan an account's plan periods give on the requested day (declared over observed). */
export interface PlanOnDay {
  plan: string | null;
  plan_id: string | null;
  /** `gap`: between two plan periods; `uncovered`: before the first or after the last; `none`: no plan periods. */
  basis: "declared" | "observed" | "gap" | "uncovered" | "none";
  from: string | null;
  until: string | null;
}
export interface CapacityRegime {
  id: string;
  subscription: string;
  factor: number;
  from?: string | null;
  until?: string | null;
  plan_id?: string | null;
  window_kind?: string | null;
  source?: "vendor" | "promotion" | "user" | "inferred";
  source_url?: string | null;
  confirmed?: boolean;
  enabled?: boolean;
  note?: string | null;
}
export interface PlanSettingRow {
  subscription: string;
  vendor: string;
  account?: string | null;
  fallback_usd_per_month: number | null;
  plan_on_day: PlanOnDay;
  capacity_regimes?: CapacityRegime[];
}
export interface PlansResponse {
  path: string;
  rows: PlanSettingRow[];
}
export interface PlanSaveRequest {
  subscription: string;
  capacity_regimes?: Array<Omit<CapacityRegime, "subscription">>;
  expected_capacity_regimes?: CapacityRegime[];
}
export interface HistoryCoverageRow {
  subscription: string;
  vendor: string;
  usage: { first_day: string | null; last_day: string | null; active_days: number; calls: number; tokens: number };
  gauge: {
    basis: "vendor-history" | "probe-history" | "none";
    first_at: string | null;
    last_at: string | null;
    samples: number;
    reset_samples: number;
    plan_samples: number;
    actual_fill_available_from: string | null;
    history_before_first_gauge: "unknown" | "none" | "not-applicable";
    gap_days: number;
    utilization_semantics: "observed-lower-bound" | "unavailable";
  };
  plan_history: { status: "covered" | "partial" | "missing" | "not-applicable"; plan_periods: number; uncovered_usage_days: number; uncovered_ranges?: Array<{ since: string; until: string; days: number }> };
  capacity_history: { declared_regimes: number; status: "explicit" | "ordinary-1x-assumed"; assumption: string | null };
  normalized_trend: { available: boolean; reason: "no-gauge" | "reset-history-missing" | "plan-history-missing" | null };
  actions: Array<"declare-plan-history" | "review-observed-plan-history" | "confirm-capacity-regimes" | "collect-reset-anchors" | "start-gauge-collection">;
}
export interface HistoryCoverageResponse {
  generated_at: string;
  subscriptions: HistoryCoverageRow[];
}
export { TOKEN_TYPES as PLAN_TOKEN_TYPES } from "../../../shared/plan-catalog";
import type { PlansCatalog, TokenType as PlanTokenType, TokenVector as PlanTokenVector, PlanLimits, DefaultReference as CatalogDefaultReference, PlanVersion as CatalogPlanVersion, CatalogPlan, ProviderGroup as CatalogProviderGroup } from "../../../shared/plan-catalog";
export type { PlansCatalog, PlanTokenType, PlanTokenVector, PlanLimits, CatalogDefaultReference, CatalogPlanVersion, CatalogPlan, CatalogProviderGroup };
export interface PlansCatalogResponse {
  path: string;
  catalog: PlansCatalog;
}
export type CalibrationStatus = "none" | "working" | "reliable";
export type PrimarySource = "local_calibration" | "default_reference" | "none";
export const PLAN_CAPACITY_ABSENT_REASONS = [
  "no_accepted_windows",
  "insufficient_windows",
  "cadence_span_short",
  "inconsistent_gt_10pct",
  "missing_counter",
  "missing_rate",
  "no_reference",
  "cross_version_unattributable",
  "duplicate_window",
  "first_gate_rejected",
  "unknown_provider",
  "unknown_plan",
  "no_version_for_day",
  "current_usage_unknown",
  "missing_price",
  "zero_tokens",
  "mixed_cadence",
] as const;
export type PlanCapacityAbsentReason = (typeof PLAN_CAPACITY_ABSENT_REASONS)[number];
export type PlanQuantity =
  | { value: number; absent: null }
  | { value: null; absent: PlanCapacityAbsentReason };
export type PlanTokenQuantities = Record<PlanTokenType, PlanQuantity>;
export interface PlanSampleDiagnostic {
  window_id: string;
  accepted: boolean;
  reason: string;
  quality: { level: string; reason: string } | null;
  start_ts: string;
  end_ts: string;
}
export interface PlanCohortIdentity {
  provider_group: string;
  plan_id: string;
  plan_version: string;
  version_from: string | null;
  window_kind: string;
}
export interface PlanLocalCalibration {
  tokens: {
    status: CalibrationStatus;
    reason: string;
    vector: PlanTokenQuantities;
    spread: number | null;
    consistent: boolean;
  };
  api: {
    status: CalibrationStatus;
    reason: string;
    usd_per_1pct: PlanQuantity;
    by_type: PlanTokenQuantities;
  };
  samples: {
    accepted: number;
    rejected: number;
    independent_windows: number;
    span_hours: number | null;
    cadence_hours: number | null;
    diagnostics: PlanSampleDiagnostic[];
  };
  explanation: string;
}
export interface PlanDefaultReferenceView {
  present: boolean;
  tokens_per_1pct: PlanTokenVector | null;
  source: string | null;
  reason: string | null;
  version_id: string | null;
  version_from: string | null;
}
export interface PlanPrimaryEstimate {
  source: PrimarySource;
  tokens_per_1pct: PlanTokenQuantities;
  api_usd_per_1pct: PlanQuantity;
  token_profile: PlanTokenQuantities;
  provenance: {
    capacity: CapacityBasis;
    price: PriceBasis;
    source: PrimarySource;
  };
}
export interface PlanDerivedMetrics {
  usd_per_1pct: PlanQuantity;
  usd_per_1m: PlanQuantity;
  tokens_at_100pct: PlanTokenQuantities;
  utilisation_pct: PlanQuantity;
  headroom_pct: PlanQuantity;
  leverage: PlanQuantity;
}
export interface PlanCapacityResult {
  normalization?: "standard";
  cohort: PlanCohortIdentity | null;
  as_of: string;
  local_calibration: PlanLocalCalibration;
  default_reference: PlanDefaultReferenceView;
  primary: PlanPrimaryEstimate;
  deviation: {
    local_vs_reference: number | null;
    reason: string | null;
  };
  derived: PlanDerivedMetrics;
}
export interface RateVariant {
  kind: "period" | "mode";
  label: string;
  from: string | null;
  until: string | null;
  rates: Record<string, number>;
}
export interface RateModel {
  codex_speed?: { credit_multiplier: number | null; api_multiplier: number | null; editable: boolean; api_editable?: boolean; valid_from: string | null; confidence: string | null };
  model: string;
  note: string | null;
  confidence: string | null;
  proxy_for: string | null;
  priced: boolean;
  variants: RateVariant[];
}
export interface RateVendor {
  vendor: string;
  verified: boolean;
  source: string | null;
  notes: string[];
  day_scoped: boolean;
  /** Present for a vendor with long-context tiers outside Codex: whether its API values apply them. */
  long_context_premium?: boolean;
  model_count: number;
  models: RateModel[];
}
export interface RateSubscription {
  id: string;
  plan: string | null;
  usd_per_month: number | null;
  confidence: string | null;
  vendor: string | null;
  rate_vendor: string | null;
  declared_in_accounts: boolean;
  home_count: number;
  note: string | null;
}
export interface RateCardsResponse {
  version: number;
  currency: string;
  unit: string;
  subscriptions: RateSubscription[];
  monthly_total_usd: number;
  vendors: RateVendor[];
}
export interface GrokResetAnchor {
  ts: string;
  precision?: "exact" | "day";
  last_refusal_ts?: string;
  first_success_ts?: string;
  source?: string;
  note?: string;
}
export interface GrokAnchorWindow {
  window_start: string;
  window_end: string;
  anchored: boolean;
  anchor_ts: string | null;
  reset_in_hours: number | null;
  spend: { turns: number; calls: number; gross: number; fresh: number; usd: number };
  percent_est: number | null;
  remaining_usd: number | null;
  idle_hours: number | null;
}
export interface GrokAnchorResponse {
  file: string;
  window_hours: number;
  anchor: GrokResetAnchor | null;
  limit: GrokAnchorWindow | null;
}
export interface GrokAnchorSaveRequest {
  ts?: string | null;
  precision?: "exact" | "day";
  last_refusal_ts?: string | null;
  first_success_ts?: string | null;
  source?: string | null;
  note?: string | null;
  clear?: boolean;
}
