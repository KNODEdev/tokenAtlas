import type { SubscriptionCapacity } from "./subscription-capacity";
import type { CodexComparisonWindow } from "./codex-accounting";
import { compareReferenceValuations } from "./subscription-revaluation";
import type { ContextPrice } from "./context-price";

export const WEEKS_PER_MONTH = 365.25 / 12 / 7;
export interface RateWindow {
  /** Read-time whole-window split for api_usd only; calibration and reference prices have separate scopes. */
  context_price?: ContextPrice;
  id: string; provider: "claude" | "codex"; account: string;
  start: string; end: string; closed: boolean;
  plan: string | null; plan_id: string | null; plan_version: string | null;
  price_usd: number | null; price_date: string;
  rule_from: string; cycles: number; preliminary: boolean;
  capacity: SubscriptionCapacity | null;
  value_100_usd: number | null; rate: number | null; absent: string | null;
  used_pp: number | null; api_usd: number | null;
  fixed_api_usd: number | null; fixed_date: string | null;
  common_historical_usd: number | null; common_fixed_usd: number | null;
  comparison: CodexComparisonWindow | null;
  active_hours:number|null; hours_per_100:number|null; hours_absent:string|null;
  mix: Array<{ model: string; share: number }>;
  scope: string | null; computed_at: string;
}
export interface SubscriptionRateResponse {
  windows: RateWindow[]; preparing: boolean; hours_preparing:boolean; stale: boolean;
  annotations: Array<{ provider: string; at: string; label: string; source: string }>;
}
export interface RateChange {
  historical: number; price_effect: number; remainder: number; price_date: string;
}
/** Matched historical/reference amounts of the same calls, never rounded before the identity. */
export function rateChange(a: RateWindow, b: RateWindow): RateChange | null {
  if (!a.closed || !b.closed || a.provider !== b.provider || a.account !== b.account
    || !a.fixed_date || a.fixed_date !== b.fixed_date || !a.comparison || !b.comparison) return null;
  const result = compareReferenceValuations(a.comparison, b.comparison);
  return result ? {historical:result.historical_change,price_effect:result.price_effect,
    remainder:result.fixed_price_work_difference,price_date:a.fixed_date} : null;
}
export function subscriptionRate(value: number | null, price: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 && price !== null && Number.isFinite(price) && price > 0
    ? value * WEEKS_PER_MONTH / price : null;
}
