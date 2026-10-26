import type { ProjectUsage } from "./stored-project-usage";
import { daySelected } from "./project-cost-values";
import type { PeriodIndex, IndexedPeriod, DatedPeriod } from "./account-periods";
import type { PlansCatalog } from "./plans-catalog";
import type { GrokGaugeConfig } from "./grok-limit";
import type { Database } from "../db/sqlite";
import { loadGrokGauge } from "./grok-limit";
import { planPeriodIndex } from "./account-periods";
import type { CyclePriceIndex, PlanPriceStretch, ResolvedPlanPeriod } from "./plans";
import type { RateCard } from "./pricing";
import { rateCardMonthlyOf } from "./capacity-equivalents";
import { planPriceStretches, resolvedPlanPeriod, planCostOf, effectiveMonthlyOf, cyclePriceIndex } from "./plans";
import { withReadSnapshot } from "../db/analysis";
import { loadAccountResolver, type AccountResolver } from "./account-resolver";
import { storedProjectUsage } from "./stored-project-usage";
import { ownedRegisterRows } from "./stored-history-usage";
import { assertCodexProjectReady, readProjectCodexRows, codexPlanRow } from "./project-cost-codex";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { hasBillingCycles, readCyclePrices } from "../db/billing-cycles";
import { planPriceGaps } from "./plan-price-gaps";
import type { PlanPriceGap } from "../shared/plan-price-coverage";

/** First and last selected traffic day of each subscription: Codex days from the ledger, the others from stored usage. */
export function subscriptionSpans(codexDays: ReadonlyMap<string, Iterable<string>>, usages: readonly ProjectUsage[],
  opts: { since?: string; until?: string }): Map<string, { first: string; last: string }> {
  const span = new Map<string, { first: string; last: string }>();
  for (const [subId, days] of codexDays) {
    let first: string | null = null;
    let last: string | null = null;
    for (const day of days) {
      if (!daySelected(day, opts)) continue;
      if (!first || day < first) first = day;
      if (!last || day > last) last = day;
    }
    if (first && last) span.set(subId, { first, last });
  }
  for (const [account, days] of usages.flatMap((usage) => usage.days_by_account)) {
    const selected = days.filter((day) => daySelected(day, opts)).sort();
    const first = selected[0];
    const last = selected[selected.length - 1];
    if (first && last) span.set(account, { first, last });
  }
  return span;
}

/** What every subscription's plan cost is read against: plan periods, stored cycle prices, the Plans catalog and the Grok gauge's account. */
export interface PlanPricingInputs { planIndex: PeriodIndex<IndexedPeriod> | null; cycles: CyclePriceIndex; catalog: PlansCatalog; grokGauge: GrokGaugeConfig | null }

/**
 * Plan periods and, below them, the billing cycles inferred from readings after a declared end
 * (docs/billing-cycles-design-2026-10-08.md §3): declared > observed > inferred. Both the project report and the plan
 * price coverage read prices through this one index.
 */
export function planPricingInputs(sqlite: Database, catalog: PlansCatalog | undefined): PlanPricingInputs {
  return { planIndex: pricedPlanIndex(sqlite), cycles: pricedCycleIndex(sqlite), catalog: catalog ?? { provider_groups: [] }, grokGauge: loadGrokGauge() };
}

/** The stored billing cycles' prices every bill is read against (docs/plan-price-from-cycles-2026-10-18.md): one read. */
export function pricedCycleIndex(sqlite: Database): CyclePriceIndex {
  return cyclePriceIndex(readCyclePrices(sqlite));
}

/** The plan index every bill is read against (project cost, plan price coverage, project history): periods, then inferred cycles. */
export function pricedPlanIndex(sqlite: Database): PeriodIndex<IndexedPeriod> | null {
  return planPeriodIndex<IndexedPeriod>([...readPlanPeriods(sqlite), ...readInferredCycles(sqlite)]);
}

export interface SubscriptionPlanPricing {
  /** The rate-card price: it fills uncovered stretches only for an account with no plan period (rule D). */
  declared: number | null;
  stretches: PlanPriceStretch[];
  periods: ResolvedPlanPeriod[];
  gaps: PlanPriceGap[];
  /** Null when any stretch has no price: unknown, never 0. */
  paid: number | null;
  monthly: number | null;
}

/**
 * One subscription's plan cost over its traffic span. The project report and the plan price coverage both read it
 * here, so the two can never disagree about which days lack a price.
 */
export function subscriptionPlanPricing(sqlite: Database, rateCards: RateCard, inputs: PlanPricingInputs,
  subject: { id: string; vendor: string }, span: { first: string; last: string } | null, resolver?: AccountResolver): SubscriptionPlanPricing {
  const declared = rateCardMonthlyOf(sqlite, rateCards, subject.id, { grokGauge: inputs.grokGauge });
  const stretches = span
    ? planPriceStretches(inputs.planIndex, inputs.catalog, { provider: subject.vendor, subject: subject.id }, span, { usd_per_month: declared },
      inputs.cycles, { firstCallOn: subscriptionFirstCallOn(sqlite, rateCards, subject, resolver) })
    : [];
  const periods = stretches.map(resolvedPlanPeriod);
  // A stretch without a price (no plan period and no rate-card price, or a plan the catalog does
  // not price) leaves the bill and the monthly price unknown. The rate-card price fills breaks only
  // for an account with no plan period (rule D); it never stands in for a missing catalog price.
  const paid = planCostOf(periods);
  const monthly = periods.length === 0 ? declared : paid === null ? null : effectiveMonthlyOf(periods);
  return { declared, stretches, periods, gaps: planPriceGaps(stretches), paid, monthly };
}

/**
 * The first call of one subscription on a UTC day, from the stored sums its traffic span was read from (Codex ledger groups,
 * the shared ledger's day rows for the others), never an event scan. Null when that day holds no counted call of it.
 */
export function subscriptionFirstCallOn(sqlite: Database, rateCards: RateCard, subject: { id: string; vendor: string }, resolver?: AccountResolver): (day: string) => number | null {
  return (day) => {
    let first = Infinity;
    if (subject.vendor === "codex") {
      for (const { group, account } of readProjectCodexRows(sqlite, rateCards, { since: day, until: day })?.rows ?? []) {
        const planned = codexPlanRow(group, account);
        if (planned?.subId === subject.id && planned.day === day) first = Math.min(first, Date.parse(group.stored.first_ts));
      }
    } else if (subject.vendor === "claude" || subject.vendor === "grok" || subject.vendor === "glm") {
      for (const { row, account } of ownedRegisterRows(sqlite, subject.vendor, rateCards, { since: day, until: day, resolver }).rows) {
        if (account === subject.id && row.day === day) first = Math.min(first, Date.parse(row.first_ts));
      }
    }
    return Number.isFinite(first) ? first : null;
  };
}

/** A subscription the project report prices, with the vendor its plan periods are kept under and its traffic span. */
export interface PlanPricedSubscription { id: string; vendor: string; span: { first: string; last: string } | null }

/**
 * The subscriptions the project report lists and their traffic spans, from the same stored rows and the same
 * membership rules, without valuing any project: Codex owners with priced selected traffic, Claude accounts with
 * priced groups, every Grok/GLM account the stored usage discovers.
 */
export function projectPlanSubscriptions(sqlite: Database, rateCards: RateCard,
  opts: { since?: string; until?: string; declarations?: readonly import("./account-resolver").IdentityDeclaration[]; resolver?: AccountResolver } = {}): PlanPricedSubscription[] {
  assertCodexProjectReady(sqlite, rateCards, opts);
  return withReadSnapshot(sqlite, () => {
    const range = { since: opts.since, until: opts.until };
    const codexDays = new Map<string, Set<string>>();
    const vendors = new Map<string, string>();
    for (const { group, account } of readProjectCodexRows(sqlite, rateCards, range)?.rows ?? []) {
      const planned = codexPlanRow(group, account);
      if (!planned) continue;
      (codexDays.get(planned.subId) ?? codexDays.set(planned.subId, new Set()).get(planned.subId)!).add(planned.day);
      if (planned.value !== null && daySelected(planned.day, opts) && !vendors.has(planned.subId)) vendors.set(planned.subId, "codex");
    }
    const resolver = opts.resolver ?? loadAccountResolver(sqlite, opts.declarations ?? []);
    const claude = storedProjectUsage(sqlite, "claude", rateCards, { since: opts.since, until: opts.until, resolver });
    const providerUsage: ProjectUsage[] = (["grok", "glm"] as const).map((provider) =>
      storedProjectUsage(sqlite, provider, rateCards, { since: opts.since, until: opts.until, resolver }));
    for (const group of claude.groups) if (!vendors.has(group.account)) vendors.set(group.account, "claude");
    for (const usage of providerUsage) for (const account of usage.accounts) if (!vendors.has(account)) vendors.set(account, usage.provider);
    const spans = subscriptionSpans(codexDays, [claude, ...providerUsage], opts);
    return [...vendors].map(([id, vendor]) => ({ id, vendor, span: spans.get(id) ?? null }));
  });
}

/** A database without the plan periods table has no plan history: every day takes the rate-card price. */
function readPlanPeriods(sqlite: Database): DatedPeriod[] {
  try { return loadPeriods(sqlite, PLAN_PERIODS); } catch { return []; }
}

/** Stored cycles inferred from readings, as in-memory periods of their own origin; none without the billing tables. */
function readInferredCycles(sqlite: Database): IndexedPeriod[] {
  if (!hasBillingCycles(sqlite)) return [];
  return (sqlite.query("SELECT provider, account, start_ts, end_ts, plan FROM billing_cycles WHERE basis='inferred' ORDER BY provider, account, start_ts")
    .all() as Array<{ provider: string; account: string; start_ts: string; end_ts: string; plan: string }>)
    .map((row) => ({ provider: row.provider, subject: row.account, from: row.start_ts, until: row.end_ts, value: row.plan, origin: "inferred" as const,
      firstSeen: null, lastSeen: null, readings: 0, evidence: "inferred-cycle" }));
}
