import type { ContextPreviewResponse } from "../../../shared/context-preview";
import type { CreditFundedSums, WindowAtLimit, WindowCreditSums } from "../../../shared/credit-funded";
import type { CreditPoolsOfRange } from "../../../shared/credit-pools";
import type { UnpricedModel } from "../../../shared/missing-rate";
import type { RailWindow } from "../windows";
import type { AccountStateRow } from "./accounts";
import type { ContextPrice } from "../../../shared/context-price";

export interface CycleTokens {
  in: number;
  cached_in: number;
  cache_write: number;
  out: number;
  reasoning: number;
  total: number;
}
export interface SourceModel {
  model: string;
  calls: number;
}
export interface CycleUsageRow {
  usd_partial?: boolean;
  name: string;
  calls: number;
  tokens: number;
  fresh: number;
  usd: number;
}
export interface ApiCycle {
  point_basis?: import("../../../shared/current-point-basis").CurrentPointBasis | null;
  context_price?: ContextPrice;
  at_limit_context_price?: ContextPrice;
  index: number;
  limit_id?: string | null;
  label: string;
  anchor: number | null;
  resets_at_iso: string | null;
  window_start_iso: string | null;
  is_active: boolean;
  shadow: boolean;
  status: string;
  start_ts: string;
  end_ts: string;
  work_from_ts: string;
  work_to_ts: string;
  sample_count: number;
  lag_fraction: number;
  distinct_steps: number;
  first_percent: number;
  peak_percent: number;
  end_percent: number;
  hit_100: boolean;
  window_hours: number;
  elapsed_hours: number;
  observed_hours: number;
  remaining_hours: number | null;
  pace_percent_per_day: number;
  projected_end_percent: number | null;
  eta_100_iso: string | null;
  calls: number;
  usd: number;
  usd_per_percent: number | null;
  usd_at_100_percent: number | null;
  tokens: CycleTokens;
  top_model: string | null;
  source_models: SourceModel[];
  model_usage: CycleUsageRow[];
  surface_usage: CycleUsageRow[];
  plan_types: string[];
  limit_names: string[];
  delta_peak_percent: number | null;
  delta_usd: number | null;
  delta_calls: number | null;
  pct_of_prev_peak: number | null;
  pct_of_prev_usd: number | null;
  /** Reserve pool use after the weekly allowance was spent; absent for other windows. */
  reserve?: ApiCycleReserve;
  /** Counted tokens without an API price, per model; absent when every counted call is priced. */
  unpriced_models?: UnpricedModel[];
  /** Credit pools at the window's newest pool reading and their movement in it; absent when it has none. */
  credit_pools?: CreditPoolsOfRange;
  /** Standard credits of the counted calls (the window's credit-equivalent basis). */
  credits?: WindowCreditSums;
  /** Counted sums at the first reading at the limit: the window's capacity in tokens, API USD and credits. */
  at_limit?: WindowAtLimit;
  /** Calls paid from credits in this window; absent without any. */
  credit_funded?: CreditFundedSums;
}
export interface ApiCycleReserve {
  peak_percent: number | null;
  first_ts: string | null;
  peak_ts: string | null;
  resets_at_iso: string | null;
  calls: number;
  usd: number;
  tokens: CycleTokens;
}
export interface ApiPoint {
  ts: string;
  ts_last: string;
  cycle: number;
  percent: number;
  percent_min: number;
  percent_last: number;
  samples: number;
  cycle_progress: number | null;
}
export interface ApiActivityPoint {
  cycle: number;
  t: number;
  amount: number;
}
export interface ApiMachineTraffic {
  cycle: number;
  machine: string | null;
  amount: number;
}
export interface UsageSeries {
  account: string;
  window_minutes: number;
  limit_id: string;
  sample_count: number;
  bucket_minutes: number;
  first_ts: string;
  last_ts: string;
  points: ApiPoint[];
  activity?: ApiActivityPoint[];
  traffic?: ApiMachineTraffic[];
  cycles: ApiCycle[];
  ownership: {
    unowned_samples: number;
    reasons: Array<{ reason: string; samples: number }>;
  };
  latest: {
    ts: string;
    percent: number;
    cycle: number | null;
    resets_at_iso: string | null;
    age_hours: number;
  };
  stats: {
    cycle_count: number;
    shadow_cycle_count: number;
    closed_cycle_count: number;
    spent_cycle_count: number;
    median_closed_peak_percent: number | null;
    avg_closed_peak_percent: number | null;
    avg_closed_usd: number | null;
    total_usd: number;
    total_calls: number;
    span_usd: number;
    span_calls: number;
    unattributed_usd: number;
    unattributed_calls: number;
  };
}
export interface WindowsResponse {
  account: string;
  provider: string;
  source: RailWindow["source"] | "probe+declared";
  windows: RailWindow[];
}
export interface BreakdownRow {
  name: string;
  vendor: string;
  calls: number;
  usd: number;
  tokens: number;
  token_details?: Record<string, number | undefined>;
  [k: string]: unknown;
}
export interface ActivityCell {
  dow: number;
  hour: number;
  calls: number;
  tokens: number;
  tokens_fresh: number;
}
export interface ActivityBucket {
  calls: number;
  tokens: number;
  tokens_fresh: number;
}
export interface BurnWindow {
  label: string;
  hours: number;
  calls: number;
  tokens: number;
  tokens_fresh: number;
  tokens_per_hour: number;
  fresh_per_hour: number;
}
export interface ActivityResponse {
  vendor: string;
  since: string | null;
  until: string | null;
  bucketing: string;
  dow_origin: string;
  cells: ActivityCell[];
  by_hour: (ActivityBucket & { hour: number })[];
  by_dow: (ActivityBucket & { dow: number })[];
  totals: ActivityBucket;
  peak: {
    cell: ActivityCell | null;
    hour: ActivityBucket & { hour: number };
    dow: ActivityBucket & { dow: number };
  };
  burn: {
    anchor_ts: string | null;
    windows: BurnWindow[];
  };
}
export interface CycleDay {
  usd_partial?: boolean;
  /** Standard credits of the counted calls; `credits_partial` when some had no credit price. */
  credits?: number;
  credits_partial?: boolean;
  date: string;
  dow: number;
  from_ts: string;
  to_ts: string;
  hours: number;
  calls: number;
  tokens: number;
  tokens_fresh: number;
  usd: number;
  top_model: string | null;
  gauge_end: number | null;
  gauge_delta: number | null;
  gauge_samples: number;
  is_today: boolean;
}
export interface CycleSession {
  usd_partial?: boolean;
  credits?: number;
  credits_partial?: boolean;
  index: number;
  start_ts: string;
  end_ts: string;
  active: boolean;
  calls: number;
  tokens: number;
  tokens_fresh: number;
  usd: number;
  top_model: string | null;
  reported_percent: number | null;
  reported_samples: number;
  reported_reset_ts: string | null;
}
export interface ShortCounterState {
  reported: boolean;
  last_reported_ts: string | null;
  live: AccountStateRow | null;
  other: AccountStateRow[];
}
export interface CycleBreakdownResponse extends ContextPreviewResponse<CycleBreakdownResponse> {
  credit_funded?: import("../../../shared/credit-funded").CreditFundedSums | null;
  model_detail?: import("../../../shared/codex-window-detail").CodexWindowDetail;
  credit_equivalent?: { value: number | null; priced_credits: number; unpriced_calls: number; basis: string; source?: string; verified_at?: string };
  account: string;
  since_ts: string;
  until_ts: string;
  limit_id: string;
  session_window_minutes: number;
  bucketing: string;
  dow_origin: string;
  days: CycleDay[];
  sessions: CycleSession[];
  short_counter: ShortCounterState;
  burn_windows: { label: string; hours: number; calls: number; tokens: number; tokens_fresh: number }[];
  totals: { calls: number; tokens: number; tokens_fresh: number; usd: number; context_price?: ContextPrice };
  unpriced: { tokens: number; models: Record<string, number> };
  note: string | null;
}
export interface UsageEvent {
  conversation?: import("../../../shared/conversation-course").ConversationRef;
  context_price?: import("../../../shared/context-price").ContextPrice;
  ledger_event_id?: number;
  ts: string;
  vendor: string;
  /** Codex and Claude: the subscription the account periods give the call at read time; null otherwise. */
  account: string | null;
  model: string | null;
  surface: string | null;
  project: string | null;
  tokens: number;
  tokens_fresh: number;
  in_uncached: number;
  in_cached: number;
  cache_write: number;
  out: number;
  reasoning: number;
  usd: number;
}
export interface EventsResponse extends ContextPreviewResponse<EventsResponse> {
  vendor: string;
  account: string | null;
  order: string;
  since: string | null;
  until: string | null;
  limit: number;
  offset: number;
  returned: number;
  has_more: boolean;
  rows: UsageEvent[];
  unpriced: { tokens: number; models: Record<string, number> };
}
