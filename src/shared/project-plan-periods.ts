import type { BillingUnavailableReason } from "./plan-price-coverage";

/** One dated plan stretch, with this project's traffic and its share of that stretch's fee. */
export interface ProjectPlanPeriod {
  from_ts: string;
  until_ts: string;
  plan: string | null;
  subscription_cost_usd: number | null;
  tokens: number;
  calls: number;
  api_usd: number;
  share: number;
  billed_usd: number | null;
  billing_unavailable_reasons: BillingUnavailableReason[];
}
