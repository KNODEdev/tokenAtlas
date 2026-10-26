/**
 * Credit-funded window traffic (docs/credit-pools-2026-10-09.md, "Kredyty w oknach"). Codex records a call paid
 * from the account's credits once a window slot is used up (`events.billing_mode = 'credits'`). Windows leave such
 * calls out of their counted traffic; the window sums keep them beside it (`window_usage.rail.credit_funded`),
 * valued by the same ledger as the window's own credit equivalent (Standard credits) and API Standard.
 */

/** Standard credits of the priced counted calls and how many calls the ledger left without a credit price. */
export interface WindowCreditSums { standard: number; unpriced_calls: number }

/**
 * The counted traffic of a cycle up to and including its first reading at or above `LIMIT_PERCENT`: what the
 * window held when the vendor's meter reached the limit, in tokens, API Standard dollars and Standard credits.
 */
export interface WindowAtLimit {
  ts: string; percent: number; events: number; tokens: number;
  api_standard: number; api_unpriced: number; credits: number; credits_unpriced: number;
  /** API Standard and credits of the calls priced in both: the window's dollars per credit. */
  joint_api_standard: number; joint_credits: number;
}

/** One UTC hour of credit-funded calls: hour start, calls, tokens, Standard credits, API Standard USD. */
export type CreditFundedHour = [string, number, number, number, number];

/** Credit-funded calls of one window: totals, first and last instants and the hours they fell in. */
export interface CreditFundedSums {
  calls: number; tokens: number; credits: number; credits_unpriced: number; api_standard: number; api_unpriced: number;
  first: string; last: string; hours: CreditFundedHour[];
}

/** The meter percent from which a window counts as used up (the screens' `hit_100`). */
/** A cycle's calls billed from a promotional credit instead of the plan (Claude cloud), as the cycle list shows them. */
export interface CycleCreditFunded { calls: number; tokens: number; api_standard: number; api_unpriced: number; first: string; last: string }

export const LIMIT_PERCENT = 99.5;

/**
 * "1 window ≈ N credits": the current prepared meter sample, scaled to 100%, with the API value of the same calls.
 */
export interface CreditWindowBasis {
  /** Current paired sample; absent only in older saved responses. */
  sample?: { start: string; end: string; percent: number };
  contextUnavailable?: boolean;
  start: string; end: string;
  credits: number;
  /** API value of the same jointly priced sample, including the selected context preview. */
  usd: number | null;
  tokens: number;
  /** Incomplete pricing or mode evidence; capacity is a lower bound. */
  partial: boolean;
}

/** The local day (`YYYY-MM-DD`, the process's zone) of an instant, the key the Overview's day bars use. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Credit-funded calls regrouped by local day: hours are whole, so every hour falls in one day. */
export function creditFundedByLocalDay(sums: Pick<CreditFundedSums, "hours"> | null | undefined):
  Map<string, { calls: number; tokens: number; credits: number; usd: number }> {
  const days = new Map<string, { calls: number; tokens: number; credits: number; usd: number }>();
  for (const [hour, calls, tokens, credits, usd] of sums?.hours ?? []) {
    const key = localDayKey(Date.parse(hour));
    const day = days.get(key) ?? { calls: 0, tokens: 0, credits: 0, usd: 0 };
    day.calls += calls; day.tokens += tokens; day.credits += credits; day.usd += usd;
    days.set(key, day);
  }
  return days;
}
