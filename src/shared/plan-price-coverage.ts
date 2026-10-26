import type { CycleFx, CyclePriceSource } from "./billing-cycles";

export type BillingUnavailableReason = "plan_history_gap" | "plan_price_missing" | "fx_rate_pending" | "usage_incomplete" | "no_pricing_span";

/** A missing historical entitlement is distinct from a missing global offer price. */
export function planGapReason(gap: PlanPriceGap): BillingUnavailableReason {
  return gap.rate_pending ? "fx_rate_pending" : gap.plans.length ? "plan_price_missing" : "plan_history_gap";
}

/**
 * The stored billing cycle that prices a stretch (docs/plan-price-from-cycles-2026-10-18.md): its whole price is spread
 * over its own time, so the stretches of one cycle add up to what was paid for it.
 */
export interface PlanPriceCycle {
  /** The cycle's instants (start inclusive, end exclusive). */
  start: string;
  end: string;
  source: CyclePriceSource;
  /** The whole cycle's price in the currency's major unit; null: unknown. */
  amount: number | null;
  currency: string | null;
  /** The whole cycle's price in USD at the NBP rate of its payment day; null: unknown (no price, or the rate is not stored yet). */
  usd: number | null;
  fx: CycleFx | null;
}
/**
 * Contract of `/api/plan-price-coverage`: for every subscription the project report prices, the stretches of its
 * traffic span with and without a plan price. One stretch without a price leaves the whole plan cost unknown
 * (`usd: null`). Consumers retain the reason; this does not mean the global offer price is missing.
 */
export interface PlanPricePiece {
  /** The plan the account's plan periods give (declared over observed); null where none does. */
  plan: string | null;
  /** Monthly price of the stretch: the Plans catalog price of its plan, else the rate-card fallback; null when unknown. */
  usd_per_month: number | null;
  /** Inclusive UTC days the stretch touches. */
  from: string;
  until: string;
  /** Exact length, fractional when a period edge falls inside a day. */
  days: number;
  usd: number | null;
  /** `inferred`: a billing cycle continued from readings after a declared end (catalog price). */
  source: "declared" | "observed" | "inferred" | "rate-card";
  /** The stored cycle the stretch's price comes from; absent where the catalog or the rate card prices it. */
  cycle?: PlanPriceCycle;
}
/** Consecutive stretches without a price, with exact instants so a plan period can be declared over them. */
export interface PlanPriceGap {
  from: string;
  until: string;
  days: number;
  /** Inclusive start and exclusive end (ISO instants). */
  from_ts: string;
  until_ts: string;
  /** Plans named in the gap whose catalog has no price; empty when no plan period covers it. */
  plans: string[];
  /** A payment whose NBP rate is not stored yet: the background job fetches it, there is no plan period to fill. */
  rate_pending?: true;
}
export interface PlanPriceCoverageSubject {
  /** The subscription id the project report uses (`codex1::business` for a billing variant). */
  id: string;
  /** The account the plan periods are kept under: `id` without its billing variant. */
  account: string;
  provider: string;
  /** E-mail declared for the account in accounts.json, when any. */
  label: string | null;
  /** First and last day with traffic; null when the selected range holds none. */
  first: string | null;
  last: string | null;
  pieces: PlanPricePiece[];
  gaps: PlanPriceGap[];
  /** Plan cost over the span; null when any stretch has no price (never 0). */
  usd: number | null;
  /** Billed by usage (a business credits pool): no flat monthly price exists to fill a gap with. */
  usage_based?: true;
  /** Traffic no account period owns (`codex?`): there is no account to declare a plan for. */
  unattributed?: true;
}
export interface PlanPriceCoverage {
  since: string | null;
  until: string | null;
  subjects: PlanPriceCoverageSubject[];
}
