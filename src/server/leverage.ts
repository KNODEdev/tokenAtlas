import type { Database } from "bun:sqlite";
import { readRegisterDays } from "../db/usage-price-read-account";
import { decodeCounts, decodeQuality, decodeTokens } from "../db/usage-price-measures";
import { codexUsagePriceReadiness, subscriptionUsagePriceReadiness, usagePriceCardSupported,
  registerDayBounds, usagePriceSourcesStamp, type UsagePriceReadiness } from "../db/usage-price-read-subscription";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { addDecimalAmounts } from "../shared/decimal-amount";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { planPeriodIndex, type DatedPeriod } from "./account-periods";
import type { AccountResolver } from "./account-resolver";
import { codexSourceHomes } from "./capacity-equivalents";
import { codexLedgerSettings } from "./codex-ledger-settings";
import { effectiveMonthlyOf, planCostOf, planPricePeriods } from "./plans";
import type { PlansCatalog } from "./plans-catalog";
import type { RateCard } from "./pricing";
import type { SourceDeclaration } from "./archive-source";
import { TOKEN_BUCKETS } from "./subscription-accounting-adapters";
import { SubscriptionUsageUnavailable } from "./subscription-usage";
import { usdEquivalent, type FxLookup } from "../shared/billing-cycles";
import { storedFxLookup } from "../db/fx-rates";

type Provider = "codex" | "claude";
interface KnownAccount { id: string; vendor?: string }
export interface LeverageContext {
  sqlite: Database;
  resolver: AccountResolver;
  accounts: readonly KnownAccount[];
  declarations: readonly SourceDeclaration[];
  homeToSubId: Map<string, string>;
  rateCards: RateCard;
  plansCatalog: PlansCatalog;
}
interface AccountSpend {
  id: string;
  provider: Provider;
  first: string | null;
  last: string | null;
  usd: string;
  unpriced: boolean;
  conflicts: number;
  unpricedEvents: number;
  reasons: Record<string, number>;
}
interface LeverageRow {
  id: string; vendor: Provider; plan: string | null; api_usd: number | null;
  days: number; min_date: string | null; max_date: string | null;
  usd_per_month: number | null; paid_usd: number | null; leverage_ratio: number | null;
  paid_basis: "receipt-usd" | "plan-estimate" | "unknown";
  api_quality?: { conflicts: number; unpriced_events: number; reasons: Record<string, number> };
}
const tableExists = (db: Database, name: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const daysBetween = (first: string, last: string): number =>
  Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
/** One receipt covering exactly the span is the paid amount, in USD directly or at the stored NBP rate of its day. */
function receiptForSpan(periods: readonly DatedPeriod[], first: string, last: string, fx: FxLookup):
  { amount: number | null; present: boolean } {
  const start = Date.parse(`${first}T00:00:00.000Z`), end = Date.parse(nextDay(last));
  const receipts = periods.filter(p => p.origin === "declared" && (p.amountMinor != null || p.currency != null)
    && Date.parse(p.from) < end && (p.until === null || Date.parse(p.until) > start));
  if (!receipts.length) return { amount: null, present: false };
  const exact = receipts.length === 1 && Date.parse(receipts[0]!.from) === start &&
    receipts[0]!.until !== null && Date.parse(receipts[0]!.until!) === end;
  const receipt = receipts[0]!;
  const valid = exact && receipt.amountMinor != null && Number.isSafeInteger(receipt.amountMinor) && receipt.amountMinor >= 0;
  return { present: true, amount: valid ? usdEquivalent(receipt.amountMinor!, receipt.currency ?? null, first, fx).usd : null };
}

function readyScope(ctx: LeverageContext, provider: Provider): string {
  const { sqlite: db, rateCards } = ctx;
  if (provider === "claude" && !usagePriceCardSupported(rateCards))
    throw new SubscriptionUsageUnavailable([{ provider, reason: "usage-price-unsupported-currency-or-unit" }]);
  const readiness: UsagePriceReadiness = provider === "codex"
    ? codexUsagePriceReadiness(db, {
        rulesRevision: codexLedgerSettings(rateCards).semantic_revision,
        sourcesStamp: usagePriceSourcesStamp(codexSourceHomes(ctx.homeToSubId), ctx.declarations, ARCHIVE_LOGICAL_ROOT),
      })
    : subscriptionUsagePriceReadiness(db, provider, rateCards);
  if (readiness.state === "ready") return readiness.head.scope;
  if ((readiness.state === "pending" && readiness.reason === "usage-price-inputs-unavailable")
    || (readiness.state === "absent" && !["fact_day_revisions", provider === "codex" ? "events" : "claude_events"]
    .every(table => tableExists(db, table))))
    throw new SubscriptionUsageUnavailable([{ provider, reason: "usage-price-inputs-unavailable" }]);
  throw new SubscriptionFactsPending(`${provider} usage prices are awaiting background preparation (${readiness.reason})`, provider);
}

/** Only stored register days are read. Account periods are joined by readRegisterDays. */
export function buildLeverage(ctx: LeverageContext, range: { since?: string; until?: string }) {
  const scopes = new Map<Provider, string>();
  for (const provider of ["codex", "claude"] as const) scopes.set(provider, readyScope(ctx, provider));
  const spend = new Map<string, AccountSpend>();
  const known = new Map<string, { id: string; provider: Provider }>();
  for (const account of ctx.accounts) {
    const provider = account.vendor === "claude" || account.vendor === "anthropic" ? "claude"
      : account.vendor === "codex" || !account.vendor ? "codex" : null;
    if (!provider || provider === "claude" && account.id.toLowerCase() === "claude") continue;
    known.set(`${provider}\0${account.id.toLowerCase()}`, { id: account.id, provider });
  }
  for (const provider of ["codex", "claude"] as const) {
    for (const id of ctx.resolver.accounts(provider)) {
      if (provider === "claude" && id.toLowerCase() === "claude") continue;
      const key = `${provider}\0${id.toLowerCase()}`;
      if (!known.has(key)) known.set(key, { id, provider });
    }
  }
  const unpriced = { tokens: 0, models: {} as Record<string, number> };
  for (const [provider, scope] of scopes) {
    const span = registerDayBounds(ctx.sqlite, provider, scope), bounds = { first: span.since, last: span.until };
    if (!bounds.first || !bounds.last) continue;
    const since = range.since && range.since > bounds.first ? range.since : bounds.first;
    const until = range.until && range.until < bounds.last ? range.until : bounds.last;
    if (since > until) continue;
    for (const row of readRegisterDays(ctx.sqlite, scope, provider, ctx.resolver, { since, until })) {
      if (row.vendor !== null || !row.account || provider === "claude" && row.account.toLowerCase() === "claude") continue;
      const conflicts = Number(decodeQuality(row.quality).conflicts ?? "0");
      const key = `${provider}\0${row.account.toLowerCase()}`;
      const current = spend.get(key) ?? { id: row.account, provider, first: null, last: null, usd: "0",
        unpriced: false, conflicts: 0, unpricedEvents: 0, reasons: {} as Record<string, number> };
      current.conflicts += conflicts;
      if (row.first_ts && (!current.first || row.first_ts < current.first)) current.first = row.first_ts;
      if (row.last_ts && (!current.last || row.last_ts > current.last)) current.last = row.last_ts;
      const amount = decodeCounts(row.counts)[provider === "codex" ? "api_standard" : "api_actual"];
      if (amount) current.usd = addDecimalAmounts(current.usd, amount.pricedSubtotal);
      const missing = amount ? Number(amount.unpricedEvents) : row.calls - conflicts;
      current.unpricedEvents += Math.max(0, missing);
      if (amount) for (const [reason, count] of Object.entries(amount.reasons))
        current.reasons[reason] = (current.reasons[reason] ?? 0) + Number(count.events);
      if (conflicts > 0) current.reasons.conflicts = (current.reasons.conflicts ?? 0) + conflicts;
      if (missing > 0) {
        current.unpriced = true;
        const buckets = decodeTokens(row.tokens);
        const allTokens = provider === "codex" ? Number(row.tokens_reported)
          : TOKEN_BUCKETS.reduce((sum, name) => sum + Number(buckets[name] ?? "0"), 0);
        const tokens = amount ? Number(amount.unpricedTokens) : allTokens;
        const model = row.model ?? "?";
        unpriced.tokens += tokens;
        unpriced.models[model] = (unpriced.models[model] ?? 0) + tokens;
      }
      spend.set(key, current);
      if (!known.has(key)) known.set(key, { id: row.account, provider });
    }
  }
  const planIndex = planPeriodIndex(loadPeriods(ctx.sqlite, PLAN_PERIODS));
  const today = new Date().toISOString().slice(0, 10);
  const fx = storedFxLookup(ctx.sqlite);
  const subscriptions: LeverageRow[] = [];
  for (const [key, account] of known) {
    const usage = spend.get(key);
    const first = usage?.first?.slice(0, 10) ?? null;
    const last = usage?.last?.slice(0, 10) ?? null;
    const days = first && last ? daysBetween(first, last) : 0;
    // The estimate needs a plan with a catalog price through the whole span: a stretch without a
    // plan period, or whose plan has no catalog price, leaves the paid amount unknown, never 0.
    const periods = first && last
      ? planPricePeriods(planIndex, ctx.plansCatalog, { provider: account.provider, subject: account.id }, { first, last }, { usd_per_month: null })
      : [];
    const planHistory = planIndex?.periodsOf(account.provider, account.id) ?? [];
    const priceComplete = periods.length > 0 && periods.every(period => period.source !== "rate-card" && period.usd !== null);
    const receipt = first && last ? receiptForSpan(planHistory, first, last, fx) : { amount: null, present: false };
    const paid = receipt.present ? receipt.amount : priceComplete ? planCostOf(periods) : null;
    const monthly = receipt.present ? null : priceComplete ? effectiveMonthlyOf(periods) : null;
    const paidBasis = receipt.present ? receipt.amount === null ? "unknown" : "receipt-usd"
      : paid === null ? "unknown" : "plan-estimate";
    const planAt = `${range.until ?? last ?? today}T23:59:59.999Z`;
    const plan = planHistory.length > 0 ? planIndex!.resolve(account.provider, account.id, planAt).value : null;
    const apiUsd = usage && !usage.unpriced && usage.conflicts === 0 ? round2(Number(usage.usd)) : usage ? null : 0;
    subscriptions.push({ id: account.id, vendor: account.provider, plan, api_usd: apiUsd,
      days, min_date: first, max_date: last, usd_per_month: monthly, paid_usd: paid, paid_basis: paidBasis,
      ...(usage && (usage.conflicts > 0 || usage.unpricedEvents > 0)
        ? { api_quality: { conflicts: usage.conflicts, unpriced_events: usage.unpricedEvents, reasons: usage.reasons } } : {}),
      leverage_ratio: apiUsd !== null && paid !== null && paid > 0 ? round2(apiUsd / paid) : null });
  }
  return { subscriptions, unpriced };
}
