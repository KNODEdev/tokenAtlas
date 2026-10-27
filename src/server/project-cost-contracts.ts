import type { ContextPreviewResponse } from "../shared/context-preview";
import type { SeatTime, CapacityEquivalents, Provenance } from "./capacity-equivalents";
import type { ResolvedPlanPeriod } from "./plans";
import type { ClaudeProjectEvidenceReason } from "./claude-project-usage";
import type { ProviderProjectEvidenceReason } from "./provider-project-usage";
import type { BillingUnavailableReason, PlanPriceGap } from "../shared/plan-price-coverage";

export interface TokenTypeBreakdown {
  in_uncached: number;
  cache_read: number;
  cache_write: number;
  out: number;
}

/** Priced traffic of one model; a subject's model slices add up to its tokens, calls and api_usd. */
export interface ModelSlice {
  tokens: number;
  calls: number;
  api_usd: number;
}

export interface SubjectSubscriptionSlice {
  tokens: number;
  api_usd: number;
  tokens_by_type: TokenTypeBreakdown;
  usd_by_type: TokenTypeBreakdown | null;
  billed_usd: number | null;
  /** False when the amount is a known subtotal across dated plan periods. */
  billed_complete?: boolean;
  plan_periods?: import("../shared/project-plan-periods").ProjectPlanPeriod[];
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
  /** Priced traffic by model name (unpriced calls stay in `unpriced`). */
  models?: Record<string, ModelSlice>;
  subscriptions: Record<string, SubjectSubscriptionSlice>;
}

export interface SubscriptionSpend {
  id: string;
  vendor: string;
  plan: string | null;
  usd_per_month: number | null;
  usd_per_month_declared: number | null;
  plan_periods: ResolvedPlanPeriod[];
  price_gaps?: PlanPriceGap[];
  api_usd: number;
  attributed_usd: number;
  first_day: string | null;
  last_day: string | null;
  days: number;
  paid_usd: number | null;
  basis: "rate-card" | "vendor";
  /**
   * False when this account's own traffic in the selected range holds a known API-value gap:
   * traffic with no actual-mode price, or canonical calls excluded because their copies
   * contradict each other. `api_usd` above stays the known subtotal, it does not become null.
   * Absent for a vendor whose per-account price coverage this report does not assess - today
   * only Claude is assessed, so absent means unknown, never "complete".
   */
  api_complete?: boolean;
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
  /**
   * Observed rows that no verified account owns: unknown or conflicting ownership,
   * or a source without the ownership and identity columns at all. Present only when
   * such rows exist. Tokens and calls are source evidence, the money is missing.
   * A named subset of `unassigned`, which already counts these rows once; consumers
   * that only read the established fields therefore still see them.
   */
  unverified_account?: CoverageItem & {
    vendor: string;
    reasons: Array<ClaudeProjectEvidenceReason | ProviderProjectEvidenceReason>;
  };
  /**
   * Canonical Claude calls excluded from every sum above because their live copies contradict
   * each other. Present only when such calls exist in the selected range.
   *
   * This counts IDENTITIES (distinct calls), not accepted calls, and it is not a token or
   * money bucket: `tokens`, `api_usd` and `billed_usd` are null because those quantities are
   * genuinely unknown - not zero, not "missing price" traffic, and not a copy we picked. The
   * scope is the ACCOUNT and the whole selected UTC range: the copies may disagree about the
   * project, so the excluded traffic cannot be attributed to any subject of this report, and
   * `identities` must never be added to `totals.tokens` or `totals.calls`.
   */
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
    paid_usd: number;
    billed_usd: number;
    unassigned_billed_usd: number;
    unassigned_api_usd: number;
    non_tmp_tokens: number;
    /**
     * False when the selected range holds any traffic whose API value this report publishes as
     * unknown: an unpriced model, a vendor it cannot attribute, rows without a verified account
     * or Claude calls excluded as conflicting copies. `api_usd` stays the known subtotal.
     * Conservative on purpose: it never claims completeness over a gap named in `coverage`.
     */
    api_complete?: boolean;
  };
  unpriced: { tokens: number; models: Record<string, number> };
  coverage: ProjectCostCoverage;
  notes: string[];
}

export interface Bucket {
  api_usd: number;
  calls: number;
  tokens: number;
  tt: TokenTypeBreakdown;
  tu: TokenTypeBreakdown | null;
  models?: Record<string, ModelSlice>;
}

export interface DailyBucket extends Bucket {
  day: string;
  subId: string;
  subject: string;
  vendor: string;
  basis: "rate-card" | "vendor";
}

export interface DailyTokenCalls {
  day: string;
  tokens: number;
  calls: number;
}

export interface DailyUnpriced extends DailyTokenCalls {
  model: string;
}

export interface ProjectCostDailyAggregate {
  incompleteSubscriptions?: Set<string>;
  periodRows?: Map<string, import("./project-cost-periods").PeriodUsageRow[]>;
  buckets: Map<string, Map<string, Map<string, DailyBucket>>>;
  bucketOrder: DailyBucket[];
  unpriced: Map<string, Map<string, DailyUnpriced>>;
  unpricedOrder: DailyUnpriced[];
  geminiByDay: Map<string, DailyTokenCalls>;
  tmpByDay: Map<string, DailyTokenCalls>;
  unassignedByDay: Map<string, DailyTokenCalls>;
  daysBySub: Map<string, Set<string>>;
}
