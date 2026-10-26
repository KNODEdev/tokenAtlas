import type { ContextPreviewResponse } from "../../../shared/context-preview";
import type { ClaudeCapacityModelResult as ClaudeModelCost } from "../../../shared/claude-capacity-result";
import type { ClaudeCodeCapacitySummary, ClaudeCounterReset } from "../../../shared/claude-code-capacity";
import type { CreditWindowBasis } from "../../../shared/credit-funded";
import type { CreditPoolsOfRange } from "../../../shared/credit-pools";
import type { UnpricedModel } from "../../../shared/missing-rate";
import type { ClaudeRosterMeters } from "../../../shared/roster-meters";
import type { ApiCycle } from "./usage";


// Keep browser contracts local so the declaration build never pulls Bun/server modules into its rootDir.
export type VendorId = "codex" | "claude" | "opencode" | "grok" | "gemini" | "gauges";
// Transcript vendors only: rollups and the bootstrap snapshot never count `gauges`.
export type UsageVendorId = Exclude<VendorId, "gauges">;
export interface AccountCapabilities {
  hasGaugeSeries: boolean | null;
  hasTokenDetail: boolean | null;
  hasCalibration: boolean | null;
  hasSecondWindow: boolean | null;
  reportsSide: "used" | "remaining" | null;
  unit: "token" | "credit" | "tick" | null;
}
export interface ApiAccount {
  id: string;
  label?: string;
  vendor: string | null;
  plan: string | null;
  login: string | null;
  machine: string | null;
  note: string | null;
  declared_account?: string | null;
  homes: string[];
  ratelimit_rows: number;
  event_rows: number;
  windows: unknown[];
  limit_ids: string[];
  first_event_ts: string | null;
  last_event_ts: string | null;
  has_gauge: boolean;
  has_events: boolean;
}
export interface AccountsResponse {
  count: number;
  subscriptions: ApiAccount[];
}
export interface ClaudeSpend {
  calls: number;
  usd: number;
  gross: number;
  fresh: number;
  /** Calls with tokens but no catalog rate; absent in reports cached before the field existed. */
  unpriced_calls?: number;
}
export interface ClaudeLimitObservation {
  ts: string;
  reset_ts: string;
  window_start_ts: string;
  measured_through: string;
  window_elapsed_percent: number;
  percent_all: number | null;
  percent_fable: number | null;
  boost_factor: number;
  fable_points: number | null;
  rest_points: number | null;
  spend: ClaudeSpend;
  fable_spend: ClaudeSpend;
  rest_spend: ClaudeSpend;
  usd_per_point: number | null;
  usd_per_point_fable: number | null;
  usd_per_point_rest: number | null;
  agreement_ratio: number | null;
  basis: "manual" | "probe";
  source?: string;
  note?: string;
  days_without_events: number;
}
export type { ClaudeCapacityModelResult as ClaudeModelCost } from "../../../shared/claude-capacity-result";
export interface ClaudeLimitCalibration {
  source_ts: string;
  usd_per_point: number;
  usd_per_point_fable: number | null;
  usd_per_point_rest: number | null;
  agreement_ratio: number | null;
  newest_reading_usd_per_point: number | null;
  drift_vs_newest_reading: number | null;
  source_percent_all: number | null;
  quantisation_percent: number | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
  boost_factor: number;
  usd_per_point_unboosted: number;
  window_value_usd: number;
  fable_window_value_usd: number | null;
  boost_ends: string | null;
}
export interface ClaudeSurfaceBreakdownRow {
  key: string;
  percent: number;
  display_name: string | null;
}
/** The account's own split of this window's USED bar across its surfaces. */
export interface ClaudeSurfaceBreakdown {
  schema: 1;
  as_of: string;
  window_started_at: string;
  rows: ClaudeSurfaceBreakdownRow[];
}
export interface ClaudeCurrentWindow {
  window_start: string;
  reset_at: string;
  elapsed_hours: number;
  remaining_hours: number;
  elapsed_percent: number;
  spend: ClaudeSpend;
  fable_spend: ClaudeSpend;
  percent_all_measured: number | null;
  percent_fable_measured: number | null;
  measured_at: string | null;
  measured_age_minutes: number | null;
  percent_all_est: number | null;
  percent_fable_est: number | null;
  pp_ahead: number | null;
  projected_end_percent: number | null;
  eta_100_iso: string | null;
  remaining_usd: number | null;
  surface_breakdown: ClaudeSurfaceBreakdown | null;
  /** The meter dropped inside this server window; start, elapsed and pace describe the segment after it. */
  counter_reset?: ClaudeCounterReset | null;
  /** Models none of whose calls in this window has a price; absent when there are none. */
  unpriced_models?: UnpricedModel[];
  /** Tokens per local day with traffic; null or absent while the stored sums predate them. */
  days?: Array<{ date: string; tokens: number }> | null;
  /** Hourly tokens and actual-mode dollars for the chart's units; null or absent while the stored sums predate them. */
  hours?: Array<{ start_ts: string; end_ts: string; tokens: number; usd: number; usd_partial?: true }> | null;
  /** Calls billed from a promotional grant instead of the plan, by hour; absent without any. */
  credit_funded?: import("../../../shared/credit-funded").CreditFundedSums;
}
export interface ClaudeSessionWindow {
  window_start: string;
  reset_at: string;
  remaining_hours: number;
  elapsed_percent: number;
  percent_measured: number | null;
  measured_at: string | null;
  measured_age_minutes: number | null;
  spend: ClaudeSpend;
  pp_ahead: number | null;
}
export interface ClaudeProbeState {
  ok: boolean;
  ts: string | null;
  age_minutes: number | null;
  weekly_percent: number | null;
  weekly_fable_percent: number | null;
  weekly_resets_at: string | null;
  session_percent: number | null;
  session_resets_at: string | null;
  samples: number;
}
export interface ClaudeLimitResponse {
  claude_capacity?: import("../../../shared/claude-capacity-result").ClaudeCapacityResult;
  configured: boolean;
  plan: string | null;
  window_hours: number;
  fable_share_of_all: number | null;
  observations: ClaudeLimitObservation[];
  calibration: ClaudeLimitCalibration | null;
  models: ClaudeModelCost[];
  current: ClaudeCurrentWindow | null;
  session: ClaudeSessionWindow | null;
  probe: ClaudeProbeState;
  /** The one shared Claude Code estimate of the current weekly window, when the server supplied it. */
  claude_code_capacity?: ClaudeCodeCapacitySummary | null;
  caveats: string[];
}
export interface AccountHistorySlice {
  tokens: number;
  calls: number;
  usd: number | null;
  priced_usd?: number;
  api_quality?: { complete: false; conflicts: number; unpriced_events: number };
}
export interface AccountHistoryPoint extends AccountHistorySlice {
  bucket: string;
  split: Record<string, AccountHistorySlice>;
}
export interface AccountHistoryAccount extends AccountHistorySlice {
  id: string;
  vendor: string;
  first_ts: string | null;
  last_ts: string | null;
}
export interface AccountHistoryResponse extends ContextPreviewResponse<AccountHistoryResponse> {
  group: string;
  since: string | null;
  until: string | null;
  accounts: AccountHistoryAccount[];
  points: AccountHistoryPoint[];
  totals: AccountHistorySlice;
  unpriced: { tokens: number; models: Record<string, number> };
  notes: string[];
}
export interface RosterShadow {
  index: number;
  percent: number;
  sample_count: number;
  top_model: string | null;
  resets_at_iso: string | null;
}
export interface RosterClaude {
  window_hours: number;
  current: ClaudeCurrentWindow | null;
  session: ClaudeSessionWindow | null;
  confidence: "high" | "medium" | "low" | "none";
  calibration_reason: string | null;
  usd_per_point: number | null;
  window_value_usd: number | null;
  caveat_count: number;
  /** Credit pools of the current weekly window; absent when it has none. */
  credit_pools?: CreditPoolsOfRange;
}
export interface AccountStateRow {
  account: string;
  limit_id: string;
  limit_name: string | null;
  plan_type: string | null;
  slot: string;
  window_minutes: number | null;
  used_percent: number;
  resets_at: number | null;
  resets_at_iso: string | null;
  rate_limit_reached: boolean;
  reset_credits: number;
  ts: string;
  age_minutes: number;
  // PC that took the newest sample; null for rows older than the cross-machine journal.
  machine: string | null;
}
export interface AccountStateResponse {
  probeable: string[];
  rows: AccountStateRow[];
  /** Every probed (provider, subject) with its cross-machine reading state. */
  probes: RosterProbe[];
}
export interface GeminiWindow {
  limit_group: string;
  kind: string;
  remaining_percent: number;
  used_percent: number;
  resets_at: string | null;
}
export interface GeminiModelRow {
  model: string;
  generations: number;
  tokens: number;
  fresh: number;
  usd: number;
}
export interface GeminiSpend {
  anchored: boolean;
  since_ts: string;
  until_ts: string;
  resolution: "conversation";
  generations: number;
  conversations: number;
  gross: number;
  fresh_in: number;
  cached_in: number;
  out_total: number;
  out_thinking: number;
  usd: number;
  usd_basis: "api-eq";
  models: GeminiModelRow[];
  first_ts: string | null;
  last_ts: string | null;
  all_time_gross: number;
  all_time_usd: number;
  unpriced_models?: UnpricedModel[];
}
export interface RosterGemini {
  profile: string | null;
  ts: string;
  age_minutes: number;
  ok: boolean;
  error: string | null;
  windows: GeminiWindow[];
  fingerprint: string | null;
  fingerprint_shared_with: string[];
  google: string | null;
  /** Worker port from the pool file; null when the pool is not on this machine. */
  port: number | null;
  spend: GeminiSpend | null;
}
export type ProbeReadingState = "fresh" | "stale" | "none";
export interface ProbeReading {
  ts: string;
  age_minutes: number;
  machine: string | null;
}
export interface ProbeMachineStatus {
  machine: string | null;
  last_ok_ts: string | null;
  last_error_ts: string | null;
  last_error: string | null;
}
/** Newest good sample across every machine plus the per-machine success/error trail. */
export interface RosterProbe {
  provider: string;
  subject: string;
  state: ProbeReadingState;
  fresh_minutes: number;
  reading: ProbeReading | null;
  machines: ProbeMachineStatus[];
}
export interface GrokModelRow {
  model: string;
  turns: number;
  calls: number;
  tokens: number;
  fresh: number;
  usd: number;
}
export interface GrokLimitSpend {
  turns: number;
  calls: number;
  gross: number;
  fresh: number;
  usd: number;
}
export interface GrokLimitObservation {
  ts: string;
  percent: number;
  visible_share: number;
  window_start: string;
  spend: GrokLimitSpend;
  usd_per_point: number | null;
  source: string | null;
  note: string | null;
}
export interface GrokLimitCalibration {
  source_ts: string;
  usd_per_point: number;
  window_value_usd: number;
  visible_share: number;
  confidence: "medium" | "low" | "none";
  reason: string;
}
export interface GrokLimit {
  configured: boolean;
  plan: string | null;
  window_hours: number;
  observations: GrokLimitObservation[];
  calibration: GrokLimitCalibration | null;
  current: {
    window_start: string;
    window_end: string;
    anchored: boolean;
    anchor_ts: string | null;
    reset_in_hours: number | null;
    spend: GrokLimitSpend;
    percent_measured: number | null;
    measured_at: string | null;
    measurement_age_minutes: number | null;
    measurement_source: "grok_billing" | null;
    percent_est: number | null;
    remaining_usd: number | null;
    idle_hours: number | null;
  } | null;
  caveats: string[];
}
export interface RosterGrok {
  window_hours: number;
  anchored: false;
  since_ts: string;
  until_ts: string;
  spend: {
    turns: number;
    calls: number;
    gross: number;
    fresh: number;
    cached: number;
    out: number;
    reasoning: number;
    usd: number;
  };
  models: GrokModelRow[];
  first_ts: string | null;
  last_ts: string | null;
  age_hours: number | null;
  usd_basis: "vendor";
  ticks_per_usd: number;
  limit: GrokLimit | null;
}
export interface GlmModelRow {
  model: string;
  calls: number;
  in_tok: number;
  cache_read: number;
  out_tok: number;
  reasoning: number;
  usd: number;
}
export interface GlmSpend {
  since_ts: string;
  until_ts: string;
  calls: number;
  sessions: number;
  gross: number;
  fresh: number;
  in_tok: number;
  cache_read: number;
  out_tok: number;
  reasoning: number;
  usd: number;
  usd_basis: "api-eq";
  models: GlmModelRow[];
  unpriced_tokens: number;
  unpriced_models?: UnpricedModel[];
}
export interface GlmWindow {
  kind: string;
  label: string;
  window_hours: number | null;
  allowance: number | null;
  used: number;
  remaining: number | null;
  percent: number;
  vendor_percent: number | null;
  measured_at: string;
  measured_age_minutes: number;
  reset_at: string | null;
  remaining_hours: number | null;
  window_start: string | null;
  elapsed_percent: number | null;
  pp_ahead: number | null;
  spend: GlmSpend | null;
  credits_per_mtok: number | null;
  note: string | null;
}
export interface RosterGlm {
  subscription: string;
  level: string | null;
  measured_at: string;
  headline_kind: string;
  windows: GlmWindow[];
  caveats: string[];
}
export interface RosterAccount {
  account_sources?: string[];
  id: string;
  vendor: string;
  plan: string | null;
  label: string;
  capabilities: AccountCapabilities;
  has_gauge: boolean;
  /** False once every era of this subscription is closed — server-side, never inferred here. */
  active: boolean;
  /** Vendor account (billing e-mail/fingerprint): declared era first, latest probe observation otherwise. */
  vendor_account: string | null;
  vendor_account_source: "declared" | "observed" | null;
  first_seen: string | null;
  last_seen: string | null;
  cycle_count: number;
  probe: RosterProbe | null;
  live: AccountStateRow | null;
  live_other: AccountStateRow[];
  basis: "gauge" | "declared" | "quota" | "spend";
  note: string | null;
  gauge_age_hours: number | null;
  empty_reason: string | null;
  cycles: ApiCycle[];
  /** Codex with credit pools: the window "1 window ≈ N credits" converts by; absent without one. */
  credit_basis?: CreditWindowBasis;
  shadow: RosterShadow | null;
  claude: RosterClaude | null;
  claude_meters?: ClaudeRosterMeters;
  gemini: RosterGemini | null;
  grok: RosterGrok | null;
  glm: RosterGlm | null;
}
export interface RosterResponse {
  window_minutes: number;
  count: number;
  accounts: RosterAccount[];
}
