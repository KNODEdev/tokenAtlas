import fs from "fs";
import path from "path";
import { atomicArchiveWrite } from "../sync/archive-publication";
import { configFile, configWriteTarget } from "../config/paths";
import { periodInstant, type IndexedPeriod, type PeriodIndex } from "./account-periods";
import { resolveProviderGroup, type PlansCatalog } from "./plans-catalog";
import type { CycleFx, CyclePriceSource } from "../shared/billing-cycles";
import type { PlanPriceCycle } from "../shared/plan-price-coverage";
import type { StoredCyclePrice } from "../db/billing-cycles";
import { resolvePlanFacts } from "../shared/plan-catalog";
export const DAYS_PER_MONTH = 30.44;
const FILE = "plans.json";
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export type CapacityRegimeSource = "vendor" | "promotion" | "user" | "inferred";
/**
 * A dated, subscription-scoped capacity multiplier. Missing dates deliberately
 * mean the ordinary 1x entitlement; rows record only known exceptions such as
 * a temporary promotion or an account-specific allowance.
 */
export interface CapacityRegime {
  id: string;
  subscription: string;
  factor: number;
  from?: string | null;
  until?: string | null;
  plan_id?: string | null;
  window_kind?: string | null;
  source?: CapacityRegimeSource;
  source_url?: string | null;
  confirmed?: boolean;
  enabled?: boolean;
  note?: string | null;
}
export interface PlansConfig {
  _comment?: string[];
  /**
   * Retired plan stages (user decision 27.09): plan history lives in account periods and the
   * price in the Plans catalog. Kept verbatim so an old file still loads and a capacity-period
   * save writes the stored stages back unchanged; nothing reads them.
   */
  segments?: unknown[];
  capacity_regimes?: CapacityRegime[];
}
export interface ResolvedCapacityRegime {
  id: string | null;
  factor: number;
  source: CapacityRegimeSource | "default";
  from: string | null;
  until: string | null;
  note: string | null;
}
/**
 * One stretch of an account's plan cost inside a usage span: the plan the account's plan periods
 * give (declared over observed) at the Plans catalog price of that day, or the rate-card fallback
 * where no period names a plan. `from`/`until` are the inclusive UTC days the stretch touches;
 * `days` is its exact length, fractional when a period edge falls inside a day.
 */
export interface ResolvedPlanPeriod {
  plan: string | null;
  usd_per_month: number | null;
  from: string;
  until: string;
  days: number;
  usd: number | null;
  /** `inferred`: a billing cycle continued from readings after a declared end, priced from the catalog. */
  source: "declared" | "observed" | "inferred" | "rate-card";
  /** The stored billing cycle the stretch is priced from; absent where the catalog or the rate card prices it. */
  cycle?: PlanPriceCycle;
}
export function plansPath(rootDir?: string): string {
  return rootDir ? path.join(rootDir, FILE) : configFile(FILE);
}
export function plansWritePath(rootDir?: string): string {
  return rootDir ? path.join(rootDir, FILE) : configWriteTarget(FILE);
}
export function loadPlans(rootDir?: string): PlansConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(plansPath(rootDir), "utf-8")) as PlansConfig;
    // The loaded shape stays as before the stages were retired: it is part of every prepared
    // view's configuration stamp, so changing it would invalidate them all at once.
    return {
      ...parsed,
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      capacity_regimes: Array.isArray(parsed.capacity_regimes) ? parsed.capacity_regimes : [],
    };
  } catch {
    return { segments: [], capacity_regimes: [] };
  }
}
export function savePlans(rootDir: string | undefined, cfg: PlansConfig): void {
  atomicArchiveWrite(plansWritePath(rootDir), JSON.stringify(cfg, null, 2) + "\n");
}
function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}
function toDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function isDay(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value) && Number.isFinite(dayMs(value)) && toDay(dayMs(value)) === value;
}
export function capacityRegimeFingerprint(regimes: CapacityRegime[]): string {
  return JSON.stringify(regimes.map(r => [r.id, r.subscription, r.factor, r.from ?? null, r.until ?? null,
    r.plan_id ?? null, r.window_kind ?? null, r.source ?? null, r.note ?? null,
    r.source_url ?? null, r.confirmed ?? true, r.enabled ?? true]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
export function capacityRegimesFor(
  cfg: PlansConfig | null | undefined,
  subscription: string,
): CapacityRegime[] {
  const want = subscription.toLowerCase();
  return (cfg?.capacity_regimes ?? [])
    .filter((regime) => (regime.subscription || "").toLowerCase() === want)
    .sort((left, right) => (left.from ?? "").localeCompare(right.from ?? ""));
}

function capacitySelectorKey(regime: CapacityRegime): string {
  return [
    regime.subscription.trim().toLowerCase(),
    regime.plan_id?.trim().toLowerCase() ?? "",
    regime.window_kind?.trim().toLowerCase() ?? "",
  ].join("\u0000");
}

function capacitySpecificity(regime: CapacityRegime): number {
  return (regime.plan_id?.trim() ? 2 : 0) + (regime.window_kind?.trim() ? 1 : 0);
}

export function resolveCapacityRegime(
  cfg: PlansConfig | null | undefined,
  input: { subscription: string; day: string; plan_id?: string | null; window_kind?: string | null },
): ResolvedCapacityRegime {
  const plan = input.plan_id?.trim().toLowerCase() ?? "";
  const kind = input.window_kind?.trim().toLowerCase() ?? "";
  const matches = capacityRegimesFor(cfg, input.subscription).filter((regime) => {
    if (regime.enabled === false || regime.confirmed === false) return false;
    if (isDay(regime.from) && regime.from > input.day) return false;
    if (isDay(regime.until) && regime.until < input.day) return false;
    if (regime.plan_id?.trim() && regime.plan_id.trim().toLowerCase() !== plan) return false;
    if (regime.window_kind?.trim() && regime.window_kind.trim().toLowerCase() !== kind) return false;
    return true;
  });
  matches.sort((left, right) => {
    const specificity = capacitySpecificity(right) - capacitySpecificity(left);
    if (specificity !== 0) return specificity;
    return (right.from ?? "").localeCompare(left.from ?? "");
  });
  const regime = matches[0];
  if (!regime) {
    return { id: null, factor: 1, source: "default", from: null, until: null, note: null };
  }
  return {
    id: regime.id,
    factor: regime.factor,
    source: regime.source ?? "user",
    from: regime.from ?? null,
    until: regime.until ?? null,
    note: regime.note ?? null,
  };
}

export function validatePlans(cfg: PlansConfig): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const regimesBySelector = new Map<string, Array<{ from: number; until: number; label: string }>>();
  for (const regime of cfg.capacity_regimes ?? []) {
    const id = regime.id?.trim();
    const sub = regime.subscription?.trim();
    const label = `reżim '${id || "?"}' (${sub || "?"})`;
    if (!id) errors.push("każdy reżim pojemności potrzebuje `id`");
    else if (ids.has(id.toLowerCase())) errors.push(`id reżimu pojemności '${id}' powtarza się`);
    else ids.add(id.toLowerCase());
    if (!sub) {
      errors.push(`${label}: potrzebne 'subscription'`);
      continue;
    }
    if (!(Number.isFinite(regime.factor) && regime.factor > 0 && regime.factor <= 100)) {
      errors.push(`${label}: 'factor' musi być liczbą z zakresu (0, 100]`);
      continue;
    }
    if (regime.from != null && regime.from !== "" && !isDay(regime.from)) {
      errors.push(`${label}: 'from' musi być datą YYYY-MM-DD`);
      continue;
    }
    if (regime.until != null && regime.until !== "" && !isDay(regime.until)) {
      errors.push(`${label}: 'until' musi być datą YYYY-MM-DD`);
      continue;
    }
    if (isDay(regime.from) && isDay(regime.until) && dayMs(regime.from) > dayMs(regime.until)) {
      errors.push(`${label}: 'from' jest późniejsze niż 'until'`);
      continue;
    }
    if (regime.source != null && !["vendor", "promotion", "user", "inferred"].includes(regime.source)) {
      errors.push(`${label}: nieznane 'source'`);
    }
    for (const key of ["enabled", "confirmed"] as const) {
      if (regime[key] != null && typeof regime[key] !== "boolean") errors.push(`${label}: '${key}' musi być boolean`);
    }
    if (regime.source_url) {
      try { if (new URL(regime.source_url).protocol !== "https:") throw new Error(); }
      catch { errors.push(`${label}: źródło musi być adresem HTTPS`); }
    }
    if (regime.enabled === false || regime.confirmed === false) continue;
    const key = capacitySelectorKey(regime);
    const list = regimesBySelector.get(key) ?? [];
    list.push({
      from: isDay(regime.from) ? dayMs(regime.from) : Number.NEGATIVE_INFINITY,
      until: isDay(regime.until) ? dayMs(regime.until) : Number.POSITIVE_INFINITY,
      label,
    });
    regimesBySelector.set(key, list);
  }
  for (const list of regimesBySelector.values()) {
    const sorted = [...list].sort((left, right) => left.from - right.from);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const current = sorted[index]!;
      if (current.from <= previous.until) {
        errors.push(`reżimy pojemności zachodzą na siebie - „${previous.label}" i „${current.label}"`);
      }
    }
  }
  return errors;
}
export function replaceCapacityRegimes(
  cfg: PlansConfig,
  subscription: string,
  regimes: CapacityRegime[],
): PlansConfig {
  const want = subscription.toLowerCase();
  const rest = (cfg.capacity_regimes ?? []).filter(
    (regime) => (regime.subscription || "").toLowerCase() !== want,
  );
  const clean = regimes.map((regime): CapacityRegime => ({
    id: String(regime.id ?? "").trim(),
    subscription,
    factor: regime.factor,
    ...(regime.from ? { from: regime.from } : {}),
    ...(regime.until ? { until: regime.until } : {}),
    ...(regime.plan_id?.trim() ? { plan_id: regime.plan_id.trim() } : {}),
    ...(regime.window_kind?.trim() ? { window_kind: regime.window_kind.trim() } : {}),
    ...(regime.source ? { source: regime.source } : {}),
    ...(regime.source_url ? { source_url: regime.source_url } : {}),
    ...(regime.confirmed != null ? { confirmed: regime.confirmed } : {}),
    ...(regime.enabled != null ? { enabled: regime.enabled } : {}),
    ...(regime.note?.trim() ? { note: regime.note.trim() } : {}),
  }));
  return { ...cfg, capacity_regimes: [...rest, ...clean] };
}
export interface CatalogPlanPrice {
  plan_id: string;
  label: string;
  /** Null when the catalog has no version for the day or the version carries no price: unknown, never 0. */
  usd_per_month: number | null;
}
/**
 * The catalog plan a plan-period value names and its monthly price on `day`, by the rule the
 * Account periods tab uses (catalog aliases after the shared plan-name normalization).
 */
export function catalogPlanPrice(catalog: PlansCatalog, provider: string, plan: string, day: string): CatalogPlanPrice | null {
  const facts = resolvePlanFacts(catalog, provider, plan, day);
  return facts.plan_id === null ? null : { plan_id: facts.plan_id, label: facts.label, usd_per_month: facts.usd_per_month };
}
/** A stored billing cycle with a price (rules 13), as stretches are cut and priced by it. */
export interface PricedCycle extends PlanPriceCycle {
  startMs: number;
  endMs: number;
  plan: string;
  basis: "declared" | "observed" | "inferred";
}
/** The stored cycles of every account, by provider and account (both lower-case, as the producer stores them). */
export interface CyclePriceIndex { of(provider: string, account: string): readonly PricedCycle[] }
const CYCLE_PRICE_SOURCES: readonly CyclePriceSource[] = ["declared", "repeated", "catalog", "inferred"];
/**
 * The stored cycles that price plan costs (docs/plan-price-from-cycles-2026-10-18.md). A row stored before rules 13 has no
 * USD equivalent yet and is left out, so its days keep the catalog price until the producer stores it again.
 */
export function cyclePriceIndex(rows: readonly StoredCyclePrice[]): CyclePriceIndex {
  const byAccount = new Map<string, PricedCycle[]>();
  for (const row of rows) {
    if (row.usd === undefined) continue;
    const startMs = Date.parse(row.start_ts), endMs = Date.parse(row.end_ts);
    if (!(endMs > startMs)) continue;
    let fx: CycleFx | null = null;
    try { fx = row.fx ? JSON.parse(row.fx) as CycleFx : null; } catch { fx = null; }
    const key = `${row.provider.toLowerCase()}\0${row.account.toLowerCase()}`;
    const list = byAccount.get(key) ?? byAccount.set(key, []).get(key)!;
    list.push({ start: row.start_ts, end: row.end_ts, startMs, endMs, plan: row.plan,
      basis: row.basis === "declared" || row.basis === "inferred" ? row.basis : "observed",
      source: CYCLE_PRICE_SOURCES.includes(row.price_source as CyclePriceSource) ? row.price_source as CyclePriceSource : "catalog",
      amount: row.amount_minor === null ? null : row.amount_minor / 100, currency: row.currency, usd: row.usd, fx });
  }
  for (const list of byAccount.values()) list.sort((a, b) => a.startMs - b.startMs);
  return { of: (provider, account) => byAccount.get(`${provider.toLowerCase()}\0${account.toLowerCase()}`) ?? [] };
}
/**
 * The plan cost of one account over the inclusive UTC days of a span. Each stretch takes the plan
 * the account's plan periods give (declared over observed) at its catalog version price; a stretch
 * no period covers falls back to the account's rate-card price. The span is cut at every period
 * edge and catalog version day inside it, so a plan change inside a day is priced exactly there.
 */
export function planPricePeriods(
  index: PeriodIndex<IndexedPeriod> | null,
  catalog: PlansCatalog,
  account: { provider: string; subject: string },
  span: { first: string; last: string },
  fallback: { usd_per_month: number | null },
  cycles: CyclePriceIndex | null = null,
  opts: PlanPriceOptions = {},
): ResolvedPlanPeriod[] {
  return planPriceStretches(index, catalog, account, span, fallback, cycles, opts).map(resolvedPlanPeriod);
}
export interface PlanPriceOptions {
  /**
   * The account's first call on a UTC day as epoch ms, read from stored day/hour sums (never an event scan); null when
   * unknown. Asked only for the span's first day, and only when the account's first plan period starts inside it.
   */
  firstCallOn?: (day: string) => number | null;
}
/** One stretch of `planPricePeriods` with its exact instants (`fromMs` inclusive, `untilMs` exclusive). */
export interface PlanPriceStretch {
  fromMs: number;
  untilMs: number;
  plan: string | null;
  monthly: number | null;
  source: ResolvedPlanPeriod["source"];
  /** The stored cycle that prices the stretch: `monthly` is then its price per 30.44 days of the cycle's own length. */
  cycle?: PricedCycle;
}
/** The published form of a stretch: inclusive UTC days, exact length and its prorated price. */
export function resolvedPlanPeriod(piece: PlanPriceStretch): ResolvedPlanPeriod {
  const days = (piece.untilMs - piece.fromMs) / DAY_MS;
  return {
    plan: piece.plan,
    usd_per_month: piece.monthly,
    from: toDay(piece.fromMs),
    until: toDay(piece.untilMs - 1),
    days,
    usd: piece.monthly != null ? Math.round(piece.monthly * (days / DAYS_PER_MONTH) * 100) / 100 : null,
    source: piece.source,
    ...(piece.cycle ? { cycle: { start: piece.cycle.start, end: piece.cycle.end, source: piece.cycle.source, amount: piece.cycle.amount,
      currency: piece.cycle.currency, usd: piece.cycle.usd, fx: piece.cycle.fx } } : {}),
  };
}
/**
 * The stretches behind `planPricePeriods`, with exact instants so an editor can be opened on one of them. Inside a stored
 * billing cycle the stretch costs the cycle's USD price times its share of the cycle's time, so a whole cycle costs what
 * was paid (user decision 18.10); a cycle whose payment has no stored rate leaves it unknown. Elsewhere the catalog price of
 * the plan prices it by days / 30.44. A stretch with neither a period nor a cycle takes the rate card only when the account has
 * no plan period at all; otherwise it is an unknown gap (docs/plan-breaks-pricing-2026-10-18.md, rule D). On the span's
 * first day the time before both the account's first period and its first call is not billed (fix E).
 */
export function planPriceStretches(
  index: PeriodIndex<IndexedPeriod> | null,
  catalog: PlansCatalog,
  account: { provider: string; subject: string },
  span: { first: string; last: string },
  fallback: { usd_per_month: number | null },
  cycles: CyclePriceIndex | null = null,
  opts: PlanPriceOptions = {},
): PlanPriceStretch[] {
  const dayStartMs = dayMs(span.first);
  const endMs = dayMs(span.last) + DAY_MS;
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(endMs) || endMs <= dayStartMs) return [];
  const periods = index?.periodsOf(account.provider, account.subject) ?? [];
  const own = cycles?.of(account.provider, account.subject) ?? [];
  // Rule D: the rate card is an undated "today" price, so it fills breaks only for an account with no dated plan history.
  const undated = periods.length === 0 && own.length === 0;
  // Fix E: the span starts at 00:00 of its first traffic day while the first period starts at the first call; the stretch
  // between them is a range artifact, not a break. Calls before the first period that day still leave a gap.
  const firstCovered = Math.min(...periods.map((period) => periodInstant(period.from, "plan period start")), ...own.map((c) => c.startMs));
  let startMs = dayStartMs;
  if (firstCovered > dayStartMs && firstCovered < Math.min(dayStartMs + DAY_MS, endMs)) {
    const firstCall = opts.firstCallOn?.(span.first) ?? null;
    if (firstCall !== null && Number.isFinite(firstCall)) startMs = Math.max(dayStartMs, Math.min(firstCall, firstCovered));
  }
  const cuts = new Set<number>([startMs, endMs]);
  const add = (at: number) => { if (at > startMs && at < endMs) cuts.add(at); };
  for (const period of periods) {
    add(periodInstant(period.from, "plan period start"));
    if (period.until !== null) add(periodInstant(period.until, "plan period end"));
  }
  for (const cycle of own) { add(cycle.startMs); add(cycle.endMs); }
  const group = resolveProviderGroup(catalog, account.provider);
  for (const plan of group.kind === "ok" ? group.group.plans : []) {
    for (const version of plan.versions) if (isDay(version.from)) add(dayMs(version.from));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const pieces: PlanPriceStretch[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!, until = points[i + 1]!;
    const resolved = index?.resolve(account.provider, account.subject, new Date(from).toISOString());
    // Cycles are sorted by start: should two ever overlap, the later one owns the time after its start.
    const cycle = own.findLast((c) => c.startMs <= from && from < c.endMs);
    const basis = (value: string | null | undefined) => value === "declared" || value === "inferred" ? value : "observed" as const;
    const piece: Omit<PlanPriceStretch, "fromMs" | "untilMs"> = cycle
      ? { plan: resolved?.value ?? cycle.plan, source: resolved?.value ? basis(resolved.basis) : cycle.basis, cycle,
          monthly: cycle.usd === null ? null : cycle.usd * DAYS_PER_MONTH * DAY_MS / (cycle.endMs - cycle.startMs) }
      : resolved?.value
      ? { plan: resolved.value, source: basis(resolved.basis),
          monthly: catalogPlanPrice(catalog, account.provider, resolved.value, toDay(from))?.usd_per_month ?? null }
      : { plan: null, source: "rate-card" as const, monthly: undated ? fallback.usd_per_month : null };
    const last = pieces.at(-1);
    if (last && last.untilMs === from && last.plan === piece.plan && last.monthly === piece.monthly && last.source === piece.source
      && last.cycle === piece.cycle) {
      last.untilMs = until;
    } else pieces.push({ fromMs: from, untilMs: until, ...piece });
  }
  return pieces;
}
/**
 * The span's plan cost, summed before rounding so splitting a span never moves the total. One
 * stretch without a price leaves the whole cost unknown (null): a partial sum would understate it.
 */
export function planCostOf(periods: ResolvedPlanPeriod[]): number | null {
  if (periods.length === 0 || periods.some((p) => p.usd_per_month == null)) return null;
  const sum = periods.reduce((total, p) => total + p.usd_per_month! * (p.days / DAYS_PER_MONTH), 0);
  return Math.round(sum * 100) / 100;
}
/**
 * The bill of one account over the days it was used in a range, as every split of that bill reads it
 * (project cost, project history): its plan stretches, their cost and the effective monthly price.
 * No span means no priced day, so the bill is unknown rather than zero.
 */
export function accountPlanCost(
  index: PeriodIndex<IndexedPeriod> | null,
  catalog: PlansCatalog,
  account: { provider: string; subject: string },
  span: { first: string | null; last: string | null },
  declaredMonthly: number | null,
  cycles: CyclePriceIndex | null = null,
  opts: PlanPriceOptions = {},
): { periods: ResolvedPlanPeriod[]; paid: number | null; monthly: number | null } {
  const periods = span.first && span.last
    ? planPricePeriods(index, catalog, account, { first: span.first, last: span.last }, { usd_per_month: declaredMonthly }, cycles, opts)
    : [];
  // A stretch without a price (no plan period and no rate-card price, or a plan the catalog does
  // not price) leaves the bill and the monthly price unknown. The rate-card price fills breaks only
  // for an account with no plan period (rule D); it never stands in for a missing catalog price.
  const paid = planCostOf(periods);
  const monthly = periods.length === 0 ? declaredMonthly : paid === null ? null : effectiveMonthlyOf(periods);
  return { periods, paid, monthly };
}
export function effectiveMonthlyOf(periods: ResolvedPlanPeriod[]): number | null {
  let weighted = 0;
  let days = 0;
  for (const p of periods) {
    if (p.usd_per_month == null) continue;
    weighted += p.usd_per_month * p.days;
    days += p.days;
  }
  if (days <= 0) return null;
  return Math.round((weighted / days) * 100) / 100;
}
export function planLabelOf(periods: ResolvedPlanPeriod[]): string | null {
  const names: string[] = [];
  for (const p of periods) {
    const name = p.plan?.trim();
    if (!name) continue;
    if (names[names.length - 1] === name) continue;
    names.push(name);
  }
  return names.length > 0 ? names.join(" → ") : null;
}
