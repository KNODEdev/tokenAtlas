import type { Database } from "bun:sqlite";
import type { AccountResolver } from "./account-resolver";
import type { RateCard } from "./pricing";
import { readRegisterDays } from "../db/usage-price-read-account";
import { decodeCounts, decodeTokens } from "../db/usage-price-measures";
import { registerDayBounds, subscriptionUsagePriceReadiness, usagePriceCardSupported } from "../db/usage-price-read-subscription";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { TOKEN_BUCKETS } from "./subscription-accounting-adapters";

/** The whole recorded traffic of one account of a usage-ledger provider. */
export interface AccountUsageSpan {
  /** First and newest canonical call the account owns. */
  first_ts: string; last_ts: string;
  calls: number; tokens: number;
  /** API Standard value of the priced calls (unpriced calls add nothing; see `unpriced_calls`). */
  api_standard: number; unpriced_calls: number;
}

/**
 * The account's whole traffic from the usage ledger's stored days (golden rules §10: a sum of ready day
 * rows, never a scan of calls). Null when the account owns no call or the card is not one the register
 * prices with; throws `SubscriptionFactsPending` while the ledger is not current for the card.
 */
export function accountUsageSpan(db: Database, provider: string, account: string, resolver: AccountResolver,
  rateCards: RateCard): AccountUsageSpan | null {
  // A card the register cannot price with never makes it ready: there is no recorded traffic to read.
  if (!usagePriceCardSupported(rateCards)) return null;
  const readiness = subscriptionUsagePriceReadiness(db, provider, rateCards);
  if (readiness.state === "absent") return null;
  if (readiness.state !== "ready")
    throw new SubscriptionFactsPending(`${provider} usage prices are awaiting background preparation (${readiness.reason})`, provider);
  const bounds = registerDayBounds(db, provider, readiness.head.scope);
  if (!bounds.since || !bounds.until) return null;
  let span: AccountUsageSpan | null = null;
  // Rows with a vendor are traffic the provider's own track does not own.
  for (const row of readRegisterDays(db, readiness.head.scope, provider, resolver,
    { since: bounds.since, until: bounds.until, account: account.toLowerCase() })) {
    if (row.vendor !== null || row.account?.toLowerCase() !== account.toLowerCase()) continue;
    const tokens = decodeTokens(row.tokens), standard = decodeCounts(row.counts).api_standard;
    span ??= { first_ts: row.first_ts, last_ts: row.last_ts, calls: 0, tokens: 0, api_standard: 0, unpriced_calls: 0 };
    if (row.first_ts < span.first_ts) span.first_ts = row.first_ts;
    if (row.last_ts > span.last_ts) span.last_ts = row.last_ts;
    span.calls += row.calls;
    span.tokens += TOKEN_BUCKETS.reduce((sum, bucket) => sum + Number(tokens[bucket] ?? "0"), 0);
    span.api_standard += Number(standard?.pricedSubtotal ?? "0");
    span.unpriced_calls += Number(standard?.unpricedEvents ?? "0");
  }
  return span;
}
