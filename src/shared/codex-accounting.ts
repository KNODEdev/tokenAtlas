import type { ContextPreviewResponse } from "./context-preview";
// Serializable contracts shared by the browser and accounting handlers.
import type { CyclePromotion } from "./codex-promotions";
import type { WindowEvidence } from "./subscription-quality";
import type { SubscriptionAnalysisExtensions } from "./subscription-accounting";

export type CodexBillingBasis = "chatgpt_credits" | "api_equivalent_usd";
export type CodexSpeed = "standard" | "fast";

export interface CodexTokenRates {
  in_uncached: number;
  in_cache_read: number;
  /** API only. Missing means no confirmed cache-write price, not a zero rate. */
  in_cache_write?: number | null;
  out_total: number;
}

export interface CodexAccountingRule {
  id: string;
  model: string;
  billing_basis: CodexBillingBasis;
  speed: CodexSpeed;
  valid_from: string;
  valid_until?: string;
  verified_at: string;
  sources: string[];
  confidence: "official" | "user";
  rates: CodexTokenRates;
  multiplier: number;
  included_usage?: "proportional" | "unchanged" | "unknown";
  note?: string;
  long_context?: { above_input_tokens: number; rates: CodexTokenRates };
}

export interface CalibrationInterval {
  account: string; kind: string; plan: string | null; window_minutes: number;
  start_ts: string; end_ts: string; reset: string | null; observed_pp: number;
  credits: number; normalized_usd: number; events: number; unpriced_events: number; source_homes: string[];
  accepted: boolean; reason: string; role: "excluded" | "training" | "validation";
  predicted_pp: number | null; error_pp: number | null;
}

export interface CodexComparisonWindow {
  activity?: import("./window-activity").WindowActivity;
  /** Calls the provider billed from a promotional credit instead of the plan (Claude cloud); outside the cycle's sums. */
  credit_funded?: import("./credit-funded").CycleCreditFunded;
  claude_capacity?: import("./claude-capacity-result").ClaudeCapacityResult;
  /** Hit-only historical weekly window: indexed local traffic is a lower bound on capacity. */
  limit_refusal_capacity?: { relation: "≥"; tokens: number; api_usd: number | null; provenance: "limit refusal"; partial: true };
  /** Present on automatic Claude windows; null forbids legacy local-traffic calibration. */
  claude_code_capacity?: import("./claude-code-capacity").ClaudeCodeCapacitySummary | null;
  manual_measurement?: { id: string; approximate_time: boolean; note: string };
  manual_measurements?: Array<{ id: string; approximate_time: boolean; note: string }>;
  /** A declared plan changed within one uninterrupted meter segment. */
  declared_plan_meter_mismatch?: boolean;
  timeline?: import("./capacity-cycle").CapacityCycleTimeline;
  evidence?: WindowEvidence;
  window_minutes?: number;
  id: string; account: string; plan: string | null; reset: string; start: string; end: string;
  start_percent: number; end_percent: number; observed_pp: number; probes: number; max_gap_hours: number;
  start_basis?: "reset" | "zero_reading" | "partial";
  first_probe?: { ts: string; percent: number };
  cycle_start?: string | null;
  cycle_end?: string;
  cycle_end_basis?: "scheduled" | "reset" | "uncertain" | "plan_change" | "capacity_change";
  cycle_usage?: WindowUsage;
  unpaired_events?: number;
  meter_sources?: Array<"session" | "probe" | "manual" | "limit_hit">;
  promotion?: CyclePromotion;
  plan_detail?: { label: string; multiplier: number | null; status: "resolved" | "mixed" | "unknown" };
  promotion_periods?: Array<{ start: string; end: string; factor: number }>;
  /** With a project filter: that project's part of the whole cycle (`cycle_usage`), the meter staying the account's. */
  project_usage?: { project: string; events: number; tokens: number; api_standard: number; api_normalized: number;
    priced_tokens: number; unpriced_events: number };
  usage: WindowUsage; sources: Array<WindowUsage & { name: string }>; models: Array<WindowUsage & { name: string }>;
}

export interface CodexTrafficPeriod {
  account: string;
  start: string;
  end: string;
  start_reset: boolean;
  end_reset: boolean;
  events: number;
  tokens: number;
  fast_tokens: number;
  unknown_tokens: number;
  api: number;
  credits: number;
  priced_tokens: number;
  priced_events: number;
  models: Record<string, number>;
}

export interface TimelinePriceTransition {
  model: string;
  basis: CodexBillingBasis;
  speed: CodexSpeed;
  before: CodexAccountingRule | null;
  after: CodexAccountingRule | null;
}
export interface TimelineMarker { id: string; day: string; observed_at?: string; label: string; note: string; color: "accent" | "violet" | "warn" | "ok" | "crit"; visible: boolean; pricing?: TimelinePriceTransition[]; reset_boundary?: { cycle_id: string; at: string } | null }

export interface TimelineMarkerStore { revision: string; markers: TimelineMarker[] }

export interface TimelineMarkersResponse extends TimelineMarkerStore { automatic: TimelineMarker[] }

export interface CodexAccountingOptions {
  detail_cycle?: string;
  reference_day?: string;
  window_minutes?: 300 | 10080 | 43200;
  since: string;
  until: string;
  account?: string;
  project?: string;
}

export interface AmountCoverage {
  value: number | null;
  priced_subtotal: number;
  status: "empty" | "complete" | "partial" | "unpriced";
  priced_events: number;
  unpriced_events: number;
  priced_tokens: number;
  unpriced_tokens: number;
  reasons: Record<string, { events: number; tokens: number }>;
}

export const CONTEXT_USAGE_KEYS = ["context_known_tokens", "context_long_tokens", "context_long_events",
    "context_api_base", "context_api_extra", "context_priced_tokens"] as const;
export interface WindowUsage {
    /** Producer-stored context split of the same meter sample; absence means not prepared/supported. */
    context_known_tokens?: number;
    context_long_tokens?: number;
    context_long_events?: number;
    context_api_base?: number;
    context_api_extra?: number;
    context_priced_tokens?: number;
    reference_api_standard?: number;
    reference_priced_tokens?: number;
    reference_unpriced_events?: number;
    paired_historical_api?: number;
    paired_reference_api?: number;
    revaluation_events?: number;
    revaluation_tokens?: number;
    events: number;
    tokens: number;
    input: number;
    cached: number;
    output: number;
    fast_tokens: number;
    unknown_tokens: number;
    priced_tokens: number;
    unpriced_events: number;
    /**
     * Events from before Codex billed subscriptions in credits. Their API value is a fact and
     * their credit value is not missing but nonexistent, so credit columns must read as "not
     * applicable" rather than as zero.
     */
    credits_unavailable_events?: number;
    api_standard: number;
    /** Standard API value weighted by the configured credit burden of each request. */
    api_normalized?: number;
    credits_low: number;
    credits_high: number;
    cache_write_5m?: number;
    cache_write_1h?: number;
    cache_write_unknown?: number;
}

export interface CodexNormalization { standard_api_usd: AmountCoverage; normalized_usd: AmountCoverage; standard_credits: AmountCoverage; extra_credits: AmountCoverage; }

export interface CodexAccountingReport extends SubscriptionAnalysisExtensions, ContextPreviewResponse<CodexAccountingReport> {
    funding?: Array<{ mode: string; events: number; tokens: number; first: string; last: string }>;
    schema_version: number;
    scope: CodexAccountingOptions;
    quantity_basis: string;
    tier_evidence: string;
    quota_verified: boolean;
    source: string;
    account_attribution: string;
    deduplication: string;
    rule_source: string;
    events: number;
    tokens: number;
    known_speed_events: number;
    known_speed_tokens: number;
    unknown_speed_events: number;
    unknown_speed_tokens: number;
    excluded_mirror_events: number;
    unattributed_events: number;
    source_home_count: number;
    amounts: Record<CodexBillingBasis, AmountCoverage>;
    normalization: CodexNormalization;
    breakdown: {
        day: string;
        model: string | null;
        speed: string;
        account: string | null;
        home: string | null;
        events: number;
        tokens: number;
        amounts: Record<CodexBillingBasis, AmountCoverage>;
        normalization: CodexNormalization;
    }[];
    windows: CodexComparisonWindow[] | null;
    meter_history?: { session_first: string | null; periodic_first: string | null; conflicting_readings?: number };
    traffic_periods?: CodexTrafficPeriod[];
    calibration: {
        basis: string;
        quota_verified: boolean;
        machine_coverage: string;
        excluded_separate_counter_events: number;
        tolerance: string;
        models: {
            key: string;
            account: string;
            window_minutes: number;
            plan: string | null;
            status: string;
            credits_per_1pct: number | null;
            standard_normalized_usd_per_1pct: number | null;
            training_intervals: number;
            training_windows: number;
            validation_intervals: number;
            validation_mae_pp: number | null;
            start_ts: string;
            end_ts: string;
            reason: string;
        }[];
        intervals: CalibrationInterval[];
        excluded_intervals: number;
        limitations: string[];
    } | null;
    applied_rules: (Omit<CodexAccountingRule, "speed"> & { speed: string })[];
    subjects: {
        account: string | null;
        subject: string | null;
        normalized_usd: AmountCoverage;
    }[];
    limitations: string[];
}
