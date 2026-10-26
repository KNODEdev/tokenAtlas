import type { Database } from "bun:sqlite";
import { readRegisterDays } from "../db/usage-price-read-account";
import { decodeTokens } from "../db/usage-price-measures";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { registerDayBounds, subscriptionUsagePriceReadiness } from "../db/usage-price-read-subscription";
import type { RateCard } from "./pricing";
import type { AccountResolver } from "./account-resolver";
import { TOKEN_BUCKETS } from "./subscription-accounting-adapters";

/** Account discovery shares the register's day/boundary resolution with accounting. */
export function subscriptionAccountDiscovery(db: Database, provider: string, resolver: AccountResolver,
  range: { since: string; until: string }, rates: RateCard) {
  const readiness = subscriptionUsagePriceReadiness(db, provider, rates);
  if (readiness.state !== "ready")
    throw new SubscriptionFactsPending(`Subscription usage prices are awaiting background preparation (${readiness.reason})`, provider);
  const head = readiness.head;
  const accountDays = new Map<string, Set<string>>();
  const unverified = { tokens: 0, calls: 0 };
  const evidence = new Map<"source_without_identity" | "unmapped_account", {tokens:number;calls:number}>();
  const stored = registerDayBounds(db, provider, head.scope);
  const since = stored.since && stored.since > range.since ? stored.since : range.since;
  const until = stored.until && stored.until < range.until ? stored.until : range.until;
  const rows = stored.since && since <= until ? readRegisterDays(db, head.scope, provider, resolver, {since,until}) : [];
  for (const row of rows) {
    if (!row.calls) continue;
    if (row.account && row.vendor === null) {
      const days = accountDays.get(row.account) ?? new Set<string>();
      days.add(row.day); accountDays.set(row.account, days);
    } else {
      const tokens = decodeTokens(row.tokens);
      const count = TOKEN_BUCKETS.reduce((sum, key) => sum + Number(tokens[key] ?? 0), 0);
      unverified.tokens += count;
      unverified.calls += row.calls;
      const reason = row.vendor !== null ? "source_without_identity" : "unmapped_account";
      const prior = evidence.get(reason) ?? {tokens:0,calls:0};
      prior.tokens += count; prior.calls += row.calls; evidence.set(reason,prior);
    }
  }
  // The rows themselves go back too: a report that also sums them reads the register once.
  return { accountDays, unverified, evidence, rows };
}
