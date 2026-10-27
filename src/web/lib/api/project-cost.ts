import type { ContextPreviewResponse } from "../../../shared/context-preview";
import type { BillingUnavailableReason, PlanPriceGap } from "../../../shared/plan-price-coverage";

export type CapacityBasis = "measured" | "single" | "none";
export type PriceBasis = "rate-card" | "none";
export type CadenceBasis = "declared" | "probe" | "default" | "none";
export type CoverageKind = "full" | "partial" | "none";
export interface Provenance {
  capacity: CapacityBasis;
  price: PriceBasis;
  cadence: CadenceBasis;
  calibration_covers_period: boolean;
  coverage: CoverageKind;
  measured_share: number;
}
export const PROVENANCE_PUBLISHED_KEYS = [
  "capacity",
  "price",
  "cadence",
  "calibration_covers_period",
  "coverage",
  "measured_share",
] as const satisfies readonly (keyof Provenance)[];
type _ProvenanceKeyGap = Exclude<keyof Provenance, (typeof PROVENANCE_PUBLISHED_KEYS)[number]>;
const _provenanceKeysExhaustive: [_ProvenanceKeyGap] extends [never] ? true : never = true;
void _provenanceKeysExhaustive;
export const EQUIVALENT_ABSENT_REASONS = [
  "no_capacity",
  "period_uncovered",
  "cadence_uncalibrated",
  "invalid_usage",
] as const;
export type EquivalentAbsentReason = (typeof EQUIVALENT_ABSENT_REASONS)[number];
export type Equivalent =
  | { value: number; absent: null }
  | { value: null; absent: EquivalentAbsentReason };
export const EQUIVALENT_PUBLISHED_KEYS = ["value", "absent"] as const satisfies readonly (keyof Equivalent)[];
type _EquivalentKeyGap = Exclude<keyof Equivalent, (typeof EQUIVALENT_PUBLISHED_KEYS)[number]>;
const _equivalentKeysExhaustive: [_EquivalentKeyGap] extends [never] ? true : never = true;
void _equivalentKeysExhaustive;
export interface CapacityEquivalents {
  full_5h_sessions: Equivalent;
  weekly_cycles: Equivalent;
  monthly_subscriptions: Equivalent;
}
export interface SeatTime {
  months: number;
  weeks: number;
}
export interface TokenTypeBreakdown {
  in_uncached: number;
  cache_read: number;
  cache_write: number;
  out: number;
}
export interface SubjectSubscriptionSlice {
  tokens: number;
  api_usd: number;
  tokens_by_type: TokenTypeBreakdown;
  usd_by_type: TokenTypeBreakdown | null;
  billed_usd: number | null;
  billed_complete?: boolean;
  plan_periods?: import("../../../shared/project-plan-periods").ProjectPlanPeriod[];
  billing_unavailable_reasons?: BillingUnavailableReason[];
  share: number;
  calls: number;
  seat_time: SeatTime | null;
  equivalents: CapacityEquivalents;
  cost_at_full_use_usd: number | null;
  provenance: Provenance;
}
export interface SubjectCost {
  subject: string;
  kind: "project" | "repo";
  id: string;
  tokens: number;
  api_usd: number;
  billed_usd: number | null;
  billed_complete: boolean;
  share_of_priced_spend_pct: number | null;
  priced_spend_usd: number;
  calls: number;
  by_sub: Record<string, number>;
  /** Priced traffic by model name; the slices add up to the subject's tokens and api_usd. */
  models?: Record<string, { tokens: number; calls: number; api_usd: number }>;
  subscriptions: Record<string, SubjectSubscriptionSlice>;
}
export interface PlanPeriod {
  plan: string | null;
  usd_per_month: number | null;
  from: string;
  until: string;
  days: number;
  usd: number | null;
  source: "declared" | "observed" | "inferred" | "rate-card";
  /** The stored billing cycle the stretch is priced from (its whole price spread over its time); absent: catalog or rate card. */
  cycle?: import("../../../shared/plan-price-coverage").PlanPriceCycle;
}
export interface SubscriptionSpend {
  id: string;
  vendor: string;
  plan: string | null;
  usd_per_month: number | null;
  usd_per_month_declared: number | null;
  plan_periods: PlanPeriod[];
  price_gaps?: PlanPriceGap[];
  api_usd: number;
  /** False for a known Claude gap; other vendors retain their existing coverage semantics. */
  api_complete?: boolean;
  attributed_usd: number;
  first_day: string | null;
  last_day: string | null;
  days: number;
  paid_usd: number | null;
  basis: "rate-card" | "vendor";
  seat_time?: SeatTime | null;
  capacity?: {
    usd_per_point: number | null;
    weekly_window_value_usd: number | null;
    session_window_value_usd: number | null;
    window_hours: number | null;
    session_hours: number | null;
  };
  provenance?: Provenance;
}
export interface CoverageItem {
  tokens: number;
  calls: number;
  api_usd: number | null;
  billed_usd: number | null;
  note?: string;
}
export interface ProjectCostCoverage {
  tmp_bucket: CoverageItem;
  unassigned: CoverageItem;
  unpriced: CoverageItem & { models: Record<string, number> };
  unattributable: CoverageItem & { vendor: string };
  /** Diagnostic subset of unassigned traffic; do not add it to totals again. */
  unverified_account?: CoverageItem & {
    vendor: string;
    reasons: Array<
      "unverified_account" | "source_without_identity" | "unmapped_account" | "ambiguous_account"
    >;
  };
  /** Account/range evidence, excluded from numeric totals; conflicting copies may disagree on project. */
  conflicting_usage?: {
    vendor: string;
    identities: number;
    accounts: Array<{ provider?: string; account: string; identities: number }>;
    tokens: null;
    api_usd: null;
    billed_usd: null;
    note: string;
  };
  totals: {
    tokens: number;
    calls: number;
    api_usd: number | null;
    billed_usd: number | null;
  };
}
export interface ProjectCostResponse extends ContextPreviewResponse<ProjectCostResponse> {
  since: string | null;
  until: string | null;
  subscriptions: SubscriptionSpend[];
  subjects: SubjectCost[];
  totals: {
    tokens: number;
    calls: number;
    api_usd: number;
    /** False for a gap identified in coverage; the amount remains the known subtotal. */
    api_complete?: boolean;
    paid_usd: number;
    billed_usd: number;
    unassigned_billed_usd: number;
    unassigned_api_usd: number;
    non_tmp_tokens: number;
  };
  unpriced: { tokens: number; models: Record<string, number> };
  coverage: ProjectCostCoverage;
  notes: string[];
}
