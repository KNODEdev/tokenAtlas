import type { Database } from "bun:sqlite";
import type { AccountResolver } from "./account-resolver";
import type { RateCard } from "./pricing";
import { readRegisterDayMeasures } from "../db/usage-price-read-account";
import { registerDayBounds, subscriptionUsagePriceReadiness, usagePriceCardSupported } from "../db/usage-price-read-subscription";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { SubscriptionUsageUnavailable } from "./subscription-usage";

export interface ClaudeHistoryDay {
  bucket: string; account: string; model: string | null; tokens: number; calls: number;
  pricedUsd: number; unpricedTokens: number; unpricedEvents: number; conflicts: number;
  first: string | null; last: string | null;
}

/** The account-history bucket of a UTC day: the day, its month, or the Monday that starts its week. */
export function accountHistoryBucket(day: string, group: string): string {
  if (group === "day") return day;
  if (group === "month") return day.slice(0, 7);
  const at = Date.parse(`${day}T00:00:00Z`);
  const weekday = new Date(at).getUTCDay();
  return new Date(at - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/** A projection of durable price days; period corrections change the account join only. */
export function readClaudeAccountHistory(db: Database, resolver: AccountResolver, rates: RateCard,
  range: { since?: string; until?: string }, group: string, knownClaudeAccount = false): ClaudeHistoryDay[] {
  if (!usagePriceCardSupported(rates))
    throw new SubscriptionUsageUnavailable([{ provider: "claude", reason: "usage-price-unsupported-currency-or-unit" }]);
  const readiness = subscriptionUsagePriceReadiness(db, "claude", rates);
  if (readiness.state !== "ready") {
    if (readiness.state === "absent" && !db.query("SELECT 1 FROM sqlite_master WHERE name='claude_events'").get()) {
      if (!knownClaudeAccount && !resolver.accounts("claude").length && !resolver.declaredIdentities("claude").length) return [];
      throw new SubscriptionUsageUnavailable([{ provider: "claude", reason: "usage-price-inputs-unavailable" }]);
    }
    throw new SubscriptionFactsPending(`claude usage prices are awaiting background preparation (${readiness.reason})`, "claude");
  }
  const span = registerDayBounds(db, "claude", readiness.head.scope), bounds = { first: span.since, last: span.until };
  if (!bounds.first || !bounds.last) return [];
  const since = range.since && range.since > bounds.first ? range.since : bounds.first;
  const until = range.until && range.until < bounds.last ? range.until : bounds.last;
  if (since > until) return [];
  return readRegisterDayMeasures(db, "claude", resolver, { since, until })
    .filter(row => row.vendor === null)
    .map(row => ({ bucket: accountHistoryBucket(row.day, group),
      account: row.account && row.account.toLowerCase() !== "claude" ? row.account : "unassigned",
      model: row.model, calls: row.calls, tokens: row.tokens,
      pricedUsd: Number(row.actual.pricedSubtotal), unpricedTokens: row.actual.unpricedTokens, unpricedEvents: row.actual.unpricedEvents,
      conflicts: row.conflicts, first: row.first_ts || null, last: row.last_ts || null }));
}
