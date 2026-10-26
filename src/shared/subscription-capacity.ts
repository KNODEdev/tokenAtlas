import type { ClaudeCapacityResult } from "./claude-capacity-result";

export type CapacityBasis = "measured" | "single" | "none";
export type PriceBasis = "rate-card" | "none";
export type CadenceBasis = "declared" | "probe" | "default" | "none";

export interface SubscriptionCapacity {
  claude_capacity?: ClaudeCapacityResult;
  value_basis?: "standard_normalized";
  sub_id: string;
  vendor: string;
  plan: string | null;
  usd_per_month: number | null;
  usd_per_point: number | null;
  weekly_window_value_usd: number | null;
  session_window_value_usd: number | null;
  window_hours: number | null;
  session_hours: number | null;
  capacity_basis: CapacityBasis;
  price_basis: PriceBasis;
  cadence: CadenceBasis;
  calibration_start_ts: string | null;
  calibration_end_ts: string | null;
  note?: string | null;
  /**
   * What the capacity figure covers. `code_calibrated_account_equivalent` comes from the
   * one shared Claude Code estimate; `observed_partial_traffic` is the older calibration
   * over locally observed traffic only and must not be read as a full account capacity.
   */
  capacity_scope?: "code_calibrated_account_equivalent" | "observed_partial_traffic";
  capacity_conditional?: boolean;
  capacity_reason?: string | null;
}
