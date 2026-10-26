import type { TokenType, TokenVector, PlansCatalog } from "./plans-catalog";
import type { GaugeQuality, CapacityBasis, PriceBasis } from "./capacity-equivalents";
import type { RateCard } from "./pricing";
import type { AccountResolver } from "./account-resolver";
import type { Database } from "bun:sqlite";
import type { DatedPeriod } from "./account-periods";
import type { CyclesConfig } from "./cycles";

export const CONSISTENCY_RELATIVE_MAX = 0.1;

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

export type Quantity =
  | { value: number; absent: null }
  | { value: null; absent: PlanCapacityAbsentReason };

export type TokenQuantities = Record<TokenType, Quantity>;

export type TokenRates = Record<TokenType, number | null>;

export interface ObservationSlice {
  context_classified?: boolean;
  rates?: TokenRates;
  model: string | null;
  speed: string | null;
  day: string;
  tokens: Partial<TokenVector>;
}

export interface ObservationPart {
  start_ts: string;
  end_ts: string;
  first_percent: number;
  peak_percent: number;
  sample_count: number;
  lag_fraction?: number | null;
  distinct_steps?: number | null;
  tokens: Partial<TokenVector>;
  slices?: ObservationSlice[];
}

export interface PlanWindowObservation {
  window_id: string;
  subscription_id?: string;
  provider_alias: string;
  plan_id: string;
  window_kind: string;
  start_ts: string;
  end_ts: string;
  first_percent: number;
  peak_percent: number;
  sample_count: number;
  lag_fraction?: number | null;
  distinct_steps?: number | null;
  tokens: Partial<TokenVector>;
  slices?: ObservationSlice[];
  cadence_hours: number;
  parts?: ObservationPart[];
  rates?: TokenRates;
  /** Capacity multiplier in force for this whole window (for example a 2x promotion). */
  capacity_factor?: number;
  capacity_regime_id?: string | null;
  exclusion_reason?: string;
  /**
   * Vendor-reported share of this counter used by the locally indexed product (Claude Code
   * on the weekly account meter). `null` is an unknown share, kept so the window can be
   * estimated later; absent means the idea does not apply to this counter.
   */
  local_share_percent?: number | null;
}

export interface SampleDiagnostic {
  window_id: string;
  accepted: boolean;
  reason: string;
  quality: GaugeQuality | null;
  start_ts: string;
  end_ts: string;
  local_share_percent?: number | null;
}

export interface CohortIdentity {
  provider_group: string;
  plan_id: string;
  plan_version: string;
  version_from: string | null;
  window_kind: string;
}

export interface LocalTokens {
  status: CalibrationStatus;
  reason: string;
  vector: TokenQuantities;
  spread: number | null;
  consistent: boolean;
}

export interface LocalApi {
  status: CalibrationStatus;
  reason: string;
  usd_per_1pct: Quantity;
  by_type: TokenQuantities;
}

export interface LocalCalibration {
  tokens: LocalTokens;
  api: LocalApi;
  samples: {
    accepted: number;
    rejected: number;
    independent_windows: number;
    span_hours: number | null;
    cadence_hours: number | null;
    diagnostics: SampleDiagnostic[];
  };
  explanation: string;
}

export interface DefaultReferenceView {
  present: boolean;
  tokens_per_1pct: TokenVector | null;
  source: string | null;
  reason: string | null;
  version_id: string | null;
  version_from: string | null;
}

export interface PrimaryEstimate {
  source: PrimarySource;
  tokens_per_1pct: TokenQuantities;
  api_usd_per_1pct: Quantity;
  token_profile: TokenQuantities;
  provenance: {
    capacity: CapacityBasis;
    price: PriceBasis;
    source: PrimarySource;
  };
}

export interface DerivedPlanMetrics {
  usd_per_1pct: Quantity;
  usd_per_1m: Quantity;
  tokens_at_100pct: TokenQuantities;
  utilisation_pct: Quantity;
  headroom_pct: Quantity;
  leverage: Quantity;
}

export interface PlanCapacityResult {
  normalization?: "standard";
  cohort: CohortIdentity | null;
  as_of: string;
  local_calibration: LocalCalibration;
  default_reference: DefaultReferenceView;
  primary: PrimaryEstimate;
  deviation: {
    local_vs_reference: number | null;
    reason: string | null;
  };
  derived: DerivedPlanMetrics;
}

export interface BuildPlanCapacityInput {
  catalog: PlansCatalog;
  rateCard: RateCard;
  observations: PlanWindowObservation[];
  provider: string;
  plan_id: string;
  window_kind: string;
  as_of: string;
  current_used_percent?: number | null;
}

export interface AdmittedSample {
  window_id: string;
  start_ts: string;
  end_ts: string;
  cadence_hours: number;
  tokens_per_1pct: TokenQuantities;
  api_usd_per_1pct: Quantity;
  api_by_type: TokenQuantities;
  quality: GaugeQuality;
  span_percent: number;
}

export const HOUR_MS = 3_600_000;

export interface PlanCapacityCollectContext {
  /** Claude and Codex events carry no account; the account periods resolve it at read time. */
  resolver?: AccountResolver;
  rateCards?: RateCard;
  sqlite: Database;
  plansCatalog: PlansCatalog;
  /** Plan periods of every account: the only plan history a window is attributed by. */
  planPeriods?: readonly DatedPeriod[];
  cycles?: CyclesConfig;
  accounts?: {
    subscriptions?: Array<{
      id: string;
      vendor?: string | null;
      account_key?: string;
    }>;
    sources?: import("./archive-source").SourceDeclaration[];
  };
  homeToSubId?: Map<string, string>;
  subIdToHomes?: Map<string, string[]>;
  claudeGauge?: { subscription?: string | null };
}
