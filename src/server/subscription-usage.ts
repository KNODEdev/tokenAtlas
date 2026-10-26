import { analysisHash, withReadSnapshot } from "../db/analysis";
import { Database } from "../db/sqlite";
import { GROK_TICKS_PER_USD } from "../ingest/grok";
import { codexSourceHomes } from "./capacity-equivalents";
import type { RateCard } from "./pricing";
import { loadAccountResolver, type AccountResolver, type IdentityDeclaration } from "./account-resolver";
import type { SourceDeclaration } from "./archive-source";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { readRegisterDays } from "../db/usage-price-read-account";
import { codexUsagePriceReadiness, subscriptionUsagePriceReadiness, usagePriceCardSupported,
  registerDayBounds, usagePriceSourcesStamp } from "../db/usage-price-read-subscription";
import { decodeCounts, decodeQuality, decodeTokens } from "../db/usage-price-measures";
import { subscriptionAccountingAdapter, TOKEN_BUCKETS, usageProviderIds } from "./subscription-accounting-adapters";
import { codexLedgerSettings } from "./codex-ledger-settings";

export interface SubscriptionUsageContext {
  sqlite: Database;
  rateCards: RateCard;
  /** Claude and Codex rows are attributed at read time from these account periods. */
  resolver?: AccountResolver;
  accounts?: { subscriptions?: readonly IdentityDeclaration[]; sources?: readonly SourceDeclaration[] };
  /** The server's home mapping: the mirror policy's source homes and declarations. */
  homeToSubId?: Map<string, string>;
}

function normPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export interface DayUsage {
  day: string;
  source: string | null;
  tokens: number;
  usd: number;
  calls: number;
  unpriced_calls: number;
  unpriced_tokens: number;
}
type UsageRow = Record<string, string | number | null>;
const num = (v: string | number | null | undefined): number => Number(v || 0);

/** Collects `(subscription, day, source)` rows; the map key is the lower-cased subscription. */
function usageCollector() {
  const out = new Map<string, Map<string, DayUsage>>();
  const add = (
    id: string,
    day: string,
    source: string | null,
    tokens: number,
    usd: number | null,
    calls: number
  ): void => {
    const key = String(id ?? "").toLowerCase();
    if (!key || !day) return;
    const byDay = out.get(key) ?? new Map<string, DayUsage>();
    const sourceKey = normPath(source ?? "");
    const rowKey = `${day}\u0000${sourceKey}`;
    const cur = byDay.get(rowKey) ?? {
      day,
      source,
      tokens: 0,
      usd: 0,
      calls: 0,
      unpriced_calls: 0,
      unpriced_tokens: 0,
    };
    cur.tokens += tokens;
    if (usd == null) {
      cur.unpriced_calls += calls;
      cur.unpriced_tokens += tokens;
    } else {
      cur.usd += usd;
    }
    cur.calls += calls;
    byDay.set(rowKey, cur);
    out.set(key, byDay);
  };
  /** Adds already summed measures, priced and unpriced together. */
  const merge = (id: string, day: string, source: string | null, row: Omit<DayUsage, "day" | "source">): void => {
    const unpricedCalls = row.unpriced_calls, pricedCalls = row.calls - unpricedCalls;
    if (pricedCalls > 0) add(id, day, source, row.tokens - row.unpriced_tokens, row.usd, pricedCalls);
    if (unpricedCalls > 0) add(id, day, source, row.unpriced_tokens, null, unpricedCalls);
  };
  const unavailable: UsageUnavailable[] = [];
  const result = (): Map<string, DayUsage[]> => new Map([...out].map(([key, rows]) => [key, [...rows.values()]]));
  return { add, merge, result, unavailable };
}

/** A provider whose usage cannot be read: its register can never be prepared on this database. */
export interface UsageUnavailable { provider: UsageProvider; reason: string }
/**
 * Usage a register that can never be prepared here cannot answer. It is raised, never shown as zero:
 * the views answer with their unavailable state until a visible partial-data state is approved.
 */
export class SubscriptionUsageUnavailable extends Error {
  constructor(readonly providers: readonly UsageUnavailable[]) {
    super(`Usage is unavailable: ${providers.map((item) => `${item.provider} (${item.reason})`).join(", ")}`);
  }
}
/** The failed-view state the screens already render: 503 with the reason, and which providers. */
export function subscriptionUsageUnavailableResponse(error: SubscriptionUsageUnavailable): Response {
  return Response.json({ error: error.message, usage_unavailable: error.providers }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
const available = (usage: Map<string, DayUsage[]>, unavailable: readonly UsageUnavailable[]): Map<string, DayUsage[]> => {
  if (unavailable.length) throw new SubscriptionUsageUnavailable(unavailable);
  return usage;
};

/** `codex` or a shared-ledger provider's id. */
export type UsageProvider = string;
export const isUsageProvider = (value: string): value is UsageProvider => usageProviderIds().includes(value);
/** The fact table a provider's register is prepared from. */
const registerInput = (provider: UsageProvider) => provider === "codex" ? "events" : subscriptionAccountingAdapter(provider).table;
type UsageOptions = { price?: boolean; within?: { from: number; until: number }; only?: { provider: UsageProvider; account: string } };
// Quantities carry no price: a register behind only on its price rules still counts calls and tokens,
// and a read of quantities needs no rate card (a supported, empty one only names the unit).
const PRICE_ONLY_PENDING = new Set(["usage-price-rules-pending"]);
const QUANTITIES_CARD: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: {} };

/**
 * Claude and Codex usage per account and day from the shared price register (register v8,
 * docs/register-v8-design-2026-09-22.md §3): prepared source-day sums with the whole-history mirror
 * selection, the account joined from the account periods at read time. A day a period boundary
 * cuts reads the contributions of that source and day only; nothing here reads, prices or
 * deduplicates events. A register behind this configuration raises `SubscriptionFactsPending`
 * (the view answers with its preparation state); one whose inputs do not exist raises
 * `SubscriptionUsageUnavailable`. Neither is ever an empty answer.
 */
function registerDailyUsage(ctx: SubscriptionUsageContext, provider: UsageProvider, options: UsageOptions,
  collector: ReturnType<typeof usageCollector>): void {
  const db = ctx.sqlite, priced = options.price !== false;
  const declarations = ctx.accounts?.subscriptions ?? [];
  const sources = ctx.accounts?.sources ?? [];
  // The Claude register never prices with a card in another currency or unit, so it is never prepared.
  const unsupported = () => provider !== "codex" && !usagePriceCardSupported(ctx.rateCards);
  if (priced && unsupported()) {
    collector.unavailable.push({ provider, reason: "usage-price-unsupported-currency-or-unit" });
    return;
  }
  const readiness = provider === "codex"
    ? codexUsagePriceReadiness(db, {
      ...(priced ? { rulesRevision: codexLedgerSettings(ctx.rateCards).semantic_revision } : {}),
      ...(ctx.homeToSubId ? { sourcesStamp: usagePriceSourcesStamp(codexSourceHomes(ctx.homeToSubId), sources, ARCHIVE_LOGICAL_ROOT) } : {}) })
    : subscriptionUsagePriceReadiness(db, provider, priced ? ctx.rateCards : QUANTITIES_CARD);
  if ((readiness.state === "pending" && readiness.reason === "usage-price-inputs-unavailable")
    || (readiness.state === "absent" && !["fact_day_revisions", registerInput(provider)]
    .every(table => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)))) {
    collector.unavailable.push({ provider, reason: "usage-price-inputs-unavailable" });
    return;
  }
  // A quantity read asks the card only when the register was never prepared, which the card can explain.
  if (readiness.state === "absent" && unsupported()) {
    collector.unavailable.push({ provider, reason: "usage-price-unsupported-currency-or-unit" });
    return;
  }
  const head = readiness.state === "ready" || (!priced && readiness.state === "pending" && PRICE_ONLY_PENDING.has(readiness.reason))
    ? readiness.head : null;
  if (!head) throw new SubscriptionFactsPending(`${provider} usage prices are awaiting background preparation (${readiness.reason})`, provider);
  const span = (provider === "codex"
    ? db.query("SELECT MIN(day) since, MAX(day) until FROM codex_price_ledger_aggregates WHERE grain='day'").get()
    : registerDayBounds(db, provider, head.scope)) as { since: string | null; until: string | null };
  if (!span.since || !span.until) return;
  const resolver = ctx.resolver ?? loadAccountResolver(db, declarations);
  // Codex reports the standard API equivalent, as its rate card did; Claude the price of the speed used.
  const variant = provider === "codex" ? "api_standard" : "api_actual";
  let since = span.since, until = span.until;
  // Offset timestamps may be stored on the adjacent lexical day. Limit the SQL read too.
  if (options.within && Number.isFinite(options.within.from))
    since = [since, new Date(options.within.from - 86_400_000).toISOString().slice(0, 10)].sort().at(-1)!;
  if (options.within && Number.isFinite(options.within.until))
    until = [until, new Date(options.within.until + 86_400_000).toISOString().slice(0, 10)].sort()[0]!;
  if (since > until) return;
  for (const row of readRegisterDays(db, head.scope, provider, resolver,
    { since, until, within: options.within, ...(options.only ? { account: options.only.account.toLowerCase() } : {}) })) {
    // Global-only rows (a `vendor` dimension) belong to global usage, and traffic no period owns to nobody.
    if (row.account === null || row.vendor !== null) continue;
    // A conflicting identity is a marker row: one call, no tokens, never traffic.
    const calls = row.calls - Number(decodeQuality(row.quality).conflicts ?? "0");
    const buckets = decodeTokens(row.tokens);
    const tokens = provider === "codex" ? Number(row.tokens_reported) : TOKEN_BUCKETS.reduce((n, key) => n + Number(buckets[key] ?? "0"), 0);
    const amount = decodeCounts(row.counts)[variant];
    collector.merge(row.account, row.day, row.source ? `${ARCHIVE_LOGICAL_ROOT}/${row.source}` : null, priced && amount
      ? { calls, tokens, usd: Number(amount.pricedSubtotal), unpriced_calls: Number(amount.unpricedEvents), unpriced_tokens: Number(amount.unpricedTokens) }
      : { calls, tokens, usd: 0, unpriced_calls: calls, unpriced_tokens: tokens });
  }
}

/**
 * Per subscription and day, from the price registers of every provider. `only` reads one account
 * of one provider: an exact interval then rebuilds only the boundary days that account can own.
 */
export function subscriptionDailyUsage(ctx:SubscriptionUsageContext,options:UsageOptions={}):Map<string,DayUsage[]> {
  return withReadSnapshot(ctx.sqlite,()=> {
    const collector=usageCollector();
    for(const provider of options.only ? [options.only.provider] : usageProviderIds())
      registerDailyUsage(ctx,provider,options,collector);
    return available(collector.result(),collector.unavailable);
  });
}
