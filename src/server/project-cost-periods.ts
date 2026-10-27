import type { Database } from "../db/sqlite";
import { readRegisterDays } from "../db/usage-price-read-account";
import { decodeCounts, decodeQuality } from "../db/usage-price-measures";
import { usageLedgerScope } from "../db/usage-ledger-read";
import { DecimalSum } from "../shared/decimal-amount";
import type { ProjectPlanPeriod } from "../shared/project-plan-periods";
import { planGapReason, type BillingUnavailableReason } from "../shared/plan-price-coverage";
import type { AccountResolver } from "./account-resolver";
import { readProjectCodexRows, codexPlanRow, codexPlanAllocationEligible } from "./project-cost-codex";
import type { RateCard } from "./pricing";
import { allocatePaidAcrossSubjects, round2 } from "./pricing";
import type { PlanPriceStretch } from "./plans";
import { planCostOf, resolvedPlanPeriod } from "./plans";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { add as addRational, rational, type Rational } from "../db/price-ledger-exact";

export interface PeriodTraffic { tokens: number; calls: number; api_usd: number }
export interface PlanPeriodUsage { groups: Map<string, PeriodTraffic>; incomplete: boolean }
export interface PeriodUsageRow {
  subject: string; day: string; tokens: number; calls: number; amount: string | Rational; incomplete: boolean;
}

/** Shared published sums; only days/hours cut by a plan edge need bounded stored contributions. */
function readPlanPeriodRows(db: Database, rates: RateCard, resolver: AccountResolver,
  account: { id: string; vendor: string }, stretch: Pick<PlanPriceStretch, "fromMs" | "untilMs">): PeriodUsageRow[] {
  const from = new Date(stretch.fromMs).toISOString(), until = new Date(stretch.untilMs).toISOString();
  const result: PeriodUsageRow[] = [];
  if (account.vendor === "codex") {
    const rows = readProjectCodexRows(db, rates, { since: from.slice(0, 10),
      until: new Date(stretch.untilMs - 1).toISOString().slice(0, 10), fromMs: stretch.fromMs, toMs: stretch.untilMs });
    for (const { group, account: owner } of rows?.rows ?? []) {
      const planned = codexPlanRow(group, owner);
      if (!planned || planned.subId !== account.id || !codexPlanAllocationEligible(group.stored.model)) continue;
      result.push({ subject: group.stored.subject ?? "", day: group.stored.day,
        tokens: planned.value === null ? 0 : Number(group.tokensReported), calls: planned.value === null ? 0 : Number(group.calls),
        amount: planned.value ?? rational(0n), incomplete: planned.value === null });
    }
  } else {
    // Stored source days can use an offset spelling; clip the adjacent lexical days at the exact UTC instants.
    const rows = readRegisterDays(db, usageLedgerScope(account.vendor), account.vendor, resolver, {
      since: new Date(stretch.fromMs - 86_400_000).toISOString().slice(0, 10),
      until: new Date(stretch.untilMs + 86_400_000 - 1).toISOString().slice(0, 10),
      within: { from: stretch.fromMs, until: stretch.untilMs }, account: account.id.toLowerCase(),
    });
    for (const row of rows) {
      if (row.vendor !== null) continue;
      const amount = decodeCounts(row.counts).api_actual;
      result.push({ subject: row.subject ?? "", day: row.day,
        tokens: Number(amount?.pricedTokens ?? 0), calls: Number(amount?.pricedEvents ?? 0), amount: amount?.pricedSubtotal ?? "0",
        incomplete: Number(amount?.unpricedEvents ?? 0) > 0 || Number(decodeQuality(row.quality).conflicts ?? 0) > 0 });
    }
  }
  return result;
}

function sumPeriodRows(rows: readonly PeriodUsageRow[]): PlanPeriodUsage {
  const groups = new Map<string, PeriodTraffic>(), money = new Map<string, DecimalSum>(), codexMoney = new Map<string, Rational>();
  let incomplete = false;
  for (const row of rows) {
    incomplete ||= row.incomplete;
    if (!row.calls) continue;
    const group = groups.get(row.subject) ?? { tokens: 0, calls: 0, api_usd: 0 };
    group.tokens += row.tokens; group.calls += row.calls; groups.set(row.subject, group);
    if (typeof row.amount === "string") {
      const sum = money.get(row.subject) ?? new DecimalSum(); sum.add(row.amount); money.set(row.subject, sum);
    } else codexMoney.set(row.subject, addRational(codexMoney.get(row.subject) ?? rational(0n), row.amount));
  }
  for (const [key, value] of groups) value.api_usd = codexMoney.has(key)
    ? ledgerPresentationNumber(codexMoney.get(key)!) : Number(money.get(key)!.toString());
  return { groups, incomplete };
}

export function readPlanPeriodUsage(db: Database, rates: RateCard, resolver: AccountResolver,
  account: { id: string; vendor: string }, stretch: PlanPriceStretch): PlanPeriodUsage {
  return sumPeriodRows(readPlanPeriodRows(db, rates, resolver, account, stretch));
}

/** Read the account once; refine only source days whose stored row straddles a plan boundary. */
export function readPlanPeriodsUsage(db: Database, rates: RateCard, resolver: AccountResolver,
  account: { id: string; vendor: string }, stretches: readonly PlanPriceStretch[], sourceRows?: readonly PeriodUsageRow[]): PlanPeriodUsage[] {
  if (!stretches.length) return [];
  const rows = sourceRows ?? readPlanPeriodRows(db, rates, resolver, account, { fromMs: stretches[0]!.fromMs, untilMs: stretches.at(-1)!.untilMs });
  const day = 86_400_000;
  // Lexical MIN/MAX timestamps do not bound chronology when source offsets differ.
  // A source/pricing day can touch either adjacent UTC day; only its proven envelope is safe whole.
  const dated = rows.map(row => {
    const from = Date.parse(row.day) - day, until = from + 3 * day;
    if (!Number.isFinite(from)) throw new Error("Invalid stored project day");
    return { row, key: JSON.stringify([row.day, row.subject]), from, until,
      period: stretches.findIndex(piece => piece.fromMs <= from && until <= piece.untilMs) };
  });
  const refine = new Set(dated.filter(entry => entry.period < 0).map(entry => entry.key));
  const envelopes = new Map(dated.filter(entry => refine.has(entry.key)).map(entry => [entry.key, { from: entry.from, until: entry.until }]));
  return stretches.map((piece, index) => {
    const selected = dated.filter(entry => entry.period === index && !refine.has(entry.key)).map(entry => entry.row);
    const ranges: Array<{ fromMs: number; untilMs: number }> = [];
    for (const envelope of [...envelopes.values()].sort((a, b) => a.from - b.from)) {
      const fromMs = Math.max(envelope.from, piece.fromMs), untilMs = Math.min(envelope.until, piece.untilMs);
      if (fromMs >= untilMs) continue;
      const last = ranges.at(-1);
      if (last && fromMs <= last.untilMs) last.untilMs = Math.max(last.untilMs, untilMs);
      else ranges.push({ fromMs, untilMs });
    }
    for (const range of ranges) selected.push(...readPlanPeriodRows(db, rates, resolver, account, range)
      .filter(row => refine.has(JSON.stringify([row.day, row.subject]))));
    return sumPeriodRows(selected);
  });
}

/** Allocate each period before summing: a project's share in a cheap plan never prices its later expensive traffic. */
export function allocatePlanPeriods(stretches: readonly PlanPriceStretch[], subjects: readonly string[],
  usageOf: (stretch: PlanPriceStretch, index: number) => PlanPeriodUsage): Map<string, ProjectPlanPeriod[]> {
  const result = new Map(subjects.map(subject => [subject, [] as ProjectPlanPeriod[]]));
  const periods = stretches.map(resolvedPlanPeriod);
  const known = periods.filter(period => period.usd_per_month !== null);
  const knownCost = planCostOf(known) ?? 0;
  // Round the account fee once, then conserve its cents across periods and projects.
  const fees = allocatePaidAcrossSubjects(periods.map((period, index) => [String(index),
    period.usd_per_month === null ? 0 : period.usd_per_month * period.days / 30.44]), knownCost);
  stretches.forEach((stretch, index) => {
    const usage = usageOf(stretch, index), period = periods[index]!;
    const fee = period.usd_per_month === null ? null : fees.get(String(index)) ?? 0;
    const total = [...usage.groups.values()].reduce((sum, value) => sum + value.api_usd, 0);
    const reasons: BillingUnavailableReason[] = [];
    if (fee === null) reasons.push(planGapReason({ from: period.from, until: period.until, days: period.days,
      from_ts: new Date(stretch.fromMs).toISOString(), until_ts: new Date(stretch.untilMs).toISOString(),
      plans: stretch.plan ? [stretch.plan] : [], ...(stretch.cycle?.usd === null && stretch.cycle.amount !== null ? { rate_pending: true } : {}) }));
    if (usage.incomplete && fee !== 0) reasons.push("usage_incomplete");
    const weights: Array<[string, number]> = [...usage.groups].map(([subject, value]) => [subject, value.api_usd]);
    const allocated = fee !== null && !reasons.length
      ? allocatePaidAcrossSubjects(total > 0 ? weights : [["", 1]], fee) : new Map<string, number>();
    for (const subject of subjects) {
      const traffic = usage.groups.get(subject) ?? { tokens: 0, calls: 0, api_usd: 0 };
      const billed = fee === 0 ? 0 : reasons.length ? (traffic.calls === 0 && !usage.incomplete ? 0 : null) : allocated.get(subject) ?? 0;
      result.get(subject)!.push({ from_ts: new Date(stretch.fromMs).toISOString(), until_ts: new Date(stretch.untilMs).toISOString(),
        plan: stretch.plan, subscription_cost_usd: fee, ...traffic, api_usd: round2(traffic.api_usd),
        share: total > 0 ? traffic.api_usd / total : 0, billed_usd: billed,
        billing_unavailable_reasons: billed === null ? reasons : [] });
    }
  });
  return result;
}
