import type { BillingCycle, BillingCycleResetBonus, BillingCycleUnits, BillingCyclesAccount } from "../../shared/billing-cycles";

/**
 * The "Subscription month" scope of the Capacity screen (docs/reset-capacity-plan-2026-10-11.md, step 4, approved
 * 11.10): each billing cycle's capacity split into its base and the bonuses of early resets by kind, read from the stored
 * cycles (`/api/billing-cycles`). Only adds, subtracts and divides stored numbers.
 */
export type MonthUnit = "api" | "credits" | "tokens" | "pp";
export type ResetKind = "automatic" | "unidentified" | "banked" | "single";
/** The switchable kinds and the stored end causes each covers; scheduled ends are always in, not-a-reset never adds. */
export const RESET_KINDS: ReadonlyArray<{ id: ResetKind; causes: ReadonlyArray<keyof NonNullable<BillingCycle["resets"]>> }> = [
  { id: "automatic", causes: ["provider", "provider_probable"] },
  { id: "unidentified", causes: ["unknown"] },
  { id: "banked", causes: ["banked"] },
  { id: "single", causes: ["single"] },
];

/** A value in the chosen unit; credits keep their low–high range (the value is its middle). */
export interface MonthAmount { value: number | null; range?: { low: number; high: number } }
const NONE: MonthAmount = { value: null };

type UnitValues = { api_usd: number | null; tokens: BillingCycleUnits["tokens"] | null; credits: BillingCycleUnits["credits"] };
function unitsAmount(units: UnitValues, unit: Exclude<MonthUnit, "pp">): MonthAmount {
  if (unit === "api") return { value: units.api_usd };
  if (unit === "tokens") return { value: units.tokens?.total ?? null };
  return units.credits ? { value: (units.credits.low + units.credits.high) / 2, range: units.credits } : NONE;
}

/** The cycle's capacity; in points also without a calibration (its windows and idle time). */
export function capacityAmount(cycle: BillingCycle, unit: MonthUnit): MonthAmount {
  if (unit === "pp") return { value: cycle.capacity?.pp ?? (cycle.windows.touched ? (cycle.windows.share + cycle.windows.idle) * 100 : null) };
  return cycle.capacity ? unitsAmount(cycle.capacity, unit) : NONE;
}
/** Flags meaning some window's usage is not stored (missing sums, or traffic this machine did not see): unknown, never 0. */
export const USAGE_UNKNOWN_FLAGS = ["window_sums_missing", "window_traffic_unseen"] as const;
export function usedAmount(cycle: BillingCycle, unit: MonthUnit): MonthAmount {
  if (unit === "pp") return { value: cycle.used_pp };
  if (USAGE_UNKNOWN_FLAGS.some((flag) => cycle.flags.includes(flag))) return NONE;
  return cycle.used_units ? unitsAmount(cycle.used_units, unit) : NONE;
}
function bonusAmount(entry: BillingCycleResetBonus, unit: MonthUnit): MonthAmount {
  return unit === "pp" ? { value: entry.pp } : unitsAmount(entry, unit);
}

export interface KindBonus {
  /** Resets ending inside the cycle, and earlier ones whose bonus time reaches into it. */
  count: number; carried: number;
  value: number | null; range?: { low: number; high: number };
}
/** The resets of one kind in a cycle: how many and their bonus in the unit (null when the unit has no value). */
export function kindBonus(cycle: BillingCycle, kind: ResetKind, unit: MonthUnit): KindBonus {
  const causes = RESET_KINDS.find((entry) => entry.id === kind)!.causes;
  let count = 0, carried = 0, value: number | null = 0, low = 0, high = 0, any = false;
  for (const cause of causes) {
    const entry = cycle.resets?.[cause];
    if (!entry) continue;
    any = true;
    count += entry.count; carried += entry.carried ?? 0;
    const amount = bonusAmount(entry, unit);
    if (amount.value === null) value = null; else if (value !== null) value += amount.value;
    if (amount.range) { low += amount.range.low; high += amount.range.high; }
  }
  return { count, carried, value: any ? value : 0, ...(unit === "credits" && any && value !== null ? { range: { low, high } } : {}) };
}

/**
 * The token split (input / cached / output) of a cycle's capacity under the switched-on kinds: the base (capacity less
 * every kind's bonus) plus the enabled kinds' bonuses, as in the table's total. Null without a capacity.
 */
export function tokenSplit(cycle: BillingCycle, enabled: ReadonlySet<ResetKind>): { input: number; cached: number; output: number } | null {
  if (!cycle.capacity) return null;
  const split = { input: cycle.capacity.tokens.input, cached: cycle.capacity.tokens.cached, output: cycle.capacity.tokens.output };
  for (const { id, causes } of RESET_KINDS) {
    if (enabled.has(id)) continue;
    for (const cause of causes) {
      const tokens = cycle.resets?.[cause]?.tokens;
      if (!tokens) continue;
      split.input -= tokens.input; split.cached -= tokens.cached; split.output -= tokens.output;
    }
  }
  return split;
}

export interface MonthRow {
  cycle: BillingCycle;
  capacity: MonthAmount;
  /** Capacity without any early-reset bonus. */
  base: number | null;
  bonuses: Record<ResetKind, KindBonus>;
  /** Base plus the bonuses of the enabled kinds. */
  total: number | null;
  used: MonthAmount;
  /** Used as a percentage of the total. */
  usedPct: number | null;
}
export function monthRow(cycle: BillingCycle, unit: MonthUnit, enabled: ReadonlySet<ResetKind>): MonthRow {
  const capacity = capacityAmount(cycle, unit), used = usedAmount(cycle, unit);
  const bonuses = Object.fromEntries(RESET_KINDS.map(({ id }) => [id, kindBonus(cycle, id, unit)])) as Record<ResetKind, KindBonus>;
  const all = Object.values(bonuses);
  const base = capacity.value === null || all.some((bonus) => bonus.value === null) ? null
    : capacity.value - all.reduce((sum, bonus) => sum + bonus.value!, 0);
  const total = base === null ? null : base + RESET_KINDS.filter(({ id }) => enabled.has(id)).reduce((sum, { id }) => sum + bonuses[id].value!, 0);
  const usedPct = total === null || used.value === null || !(total > 0) ? null : used.value / total * 100;
  return { cycle, capacity, base, bonuses, total, used, usedPct };
}

/** How many resets of each kind the shown cycles hold. */
export function kindCounts(cycles: readonly BillingCycle[]): Record<ResetKind, number> {
  return Object.fromEntries(RESET_KINDS.map(({ id }) => [id, cycles.reduce((sum, cycle) => sum + kindBonus(cycle, id, "pp").count, 0)])) as Record<ResetKind, number>;
}

/* ---- Capacity vs usage over a period (approved 11.10): sums of the table's own Total and Used. ---- */
export type MonthPeriod = "current" | "previous" | "all";
const PERIODS: readonly MonthPeriod[] = ["current", "previous", "all"];
/** A subscription without a current cycle still has a previous one when its last cycle ended this recently. */
const PREVIOUS_WITHIN_MS = 35 * 86_400_000;

/**
 * The cycles of a period. Current: the cycle that is current now (none for an ended subscription). Previous: the one
 * before the current cycle, else the last cycle that ended within the past 35 days. All: every cycle.
 */
export function periodCycles(cycles: readonly BillingCycle[], period: MonthPeriod, now = Date.now()): BillingCycle[] {
  const ordered = [...cycles].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  if (period === "all") return ordered;
  const current = ordered.findIndex((cycle) => cycle.current);
  if (period === "current") return current >= 0 ? [ordered[current]!] : [];
  if (current >= 0) return ordered[current + 1] ? [ordered[current + 1]!] : [];
  const recent = ordered.find((cycle) => Date.parse(cycle.end) <= now && now - Date.parse(cycle.end) <= PREVIOUS_WITHIN_MS);
  return recent ? [recent] : [];
}

/** What a cycle cost, per currency and kind of price, as written; `MonthSummary.paidUsd` is their sum in USD. */
export interface PaidAmount { currency: string; amount: number; catalog: boolean }
export interface MonthSummary {
  cycles: BillingCycle[];
  /** Span of the cycles. */
  from: string | null; until: string | null;
  /** Σ Total and Σ Used of the cycles with a capacity and a used amount in the unit; null without any. */
  capacity: number | null; used: number | null;
  /** Of the capacity: Σ base (without any early-reset bonus) and Σ bonus of each kind (switched-off kinds too). */
  base: number | null; bonuses: Record<ResetKind, number>;
  /** capacity − used (negative: over capacity) and used ÷ capacity. */
  unused: number | null; utilisation: number | null;
  /** Cycles left out of both sums: without a capacity (no calibration), or with it but no used amount in the unit. */
  uncalibrated: number; usageUnknown: number;
  paid: PaidAmount[];
  /** Σ of the priced cycles in USD (NBP rate of each payment day); null when none, or when one's rate is not stored yet. */
  paidUsd: number | null;
  /** Priced cycles whose USD equivalent is not known yet (a missing rate). */
  paidUsdMissing: number;
  /** Cycles whose price is unknown. */
  unpriced: number;
  /** Points used and windows of the cycles with % readings: their ratio is the average use of one window before its end. */
  pointsUsed: number; pointWindows: number;
}
const noBonuses = () => Object.fromEntries(RESET_KINDS.map(({ id }) => [id, 0])) as Record<ResetKind, number>;
const sortPaid = (paid: Iterable<PaidAmount>) => [...paid].sort((a, b) => a.currency.localeCompare(b.currency) || Number(a.catalog) - Number(b.catalog));

export function summarize(cycles: readonly BillingCycle[], unit: MonthUnit, enabled: ReadonlySet<ResetKind>): MonthSummary {
  let capacity = 0, used = 0, base = 0, counted = 0, uncalibrated = 0, usageUnknown = 0, unpriced = 0, pointsUsed = 0, pointWindows = 0;
  let paidUsd = 0, paidUsdMissing = 0;
  const bonuses = noBonuses(), paid = new Map<string, PaidAmount>();
  for (const cycle of cycles) {
    const row = monthRow(cycle, unit, enabled);
    // Like for like: a cycle without a capacity, or without its usage, is left out of both sums.
    if (row.total === null) uncalibrated++;
    else if (row.used.value === null) usageUnknown++;
    else {
      capacity += row.total; used += row.used.value; base += row.base!; counted++;
      for (const { id } of RESET_KINDS) bonuses[id] += row.bonuses[id].value ?? 0;
    }
    if (cycle.used_pp !== null) { pointsUsed += cycle.used_pp; pointWindows += cycle.windows.share; }
    if (cycle.price.amount === null || !cycle.price.currency) { unpriced++; continue; }
    // A repeated payment is the same receipt again, not a catalog price.
    const catalog = cycle.price.source !== "declared" && cycle.price.source !== "repeated", key = `${cycle.price.currency}|${catalog}`;
    const entry = paid.get(key) ?? { currency: cycle.price.currency, amount: 0, catalog };
    entry.amount += cycle.price.amount;
    paid.set(key, entry);
    const usd = cycle.price.usd ?? (cycle.price.currency === "USD" ? cycle.price.amount : null);
    if (usd === null) paidUsdMissing++; else paidUsd += usd;
  }
  const starts = cycles.map((cycle) => cycle.start).sort(), ends = cycles.map((cycle) => cycle.end).sort();
  return { cycles: [...cycles], from: starts[0] ?? null, until: ends.at(-1) ?? null,
    capacity: counted ? capacity : null, used: counted ? used : null, base: counted ? base : null, bonuses,
    unused: counted ? capacity - used : null, utilisation: counted && capacity > 0 ? used / capacity * 100 : null,
    uncalibrated, usageUnknown, paid: sortPaid(paid.values()), paidUsd: paid.size && !paidUsdMissing ? paidUsd : null, paidUsdMissing,
    unpriced, pointsUsed, pointWindows };
}

/** Several subscriptions' summaries as one: sums (the unit must be summable across them), paid kept per currency. */
export function combineSummaries(summaries: readonly MonthSummary[]): MonthSummary {
  const counted = summaries.filter((summary) => summary.capacity !== null);
  const sum = (list: readonly MonthSummary[], value: (summary: MonthSummary) => number) => list.reduce((total, summary) => total + value(summary), 0);
  const capacity = sum(counted, (summary) => summary.capacity!), used = sum(counted, (summary) => summary.used!);
  const bonuses = noBonuses();
  for (const summary of counted) for (const { id } of RESET_KINDS) bonuses[id] += summary.bonuses[id];
  const paid = new Map<string, PaidAmount>();
  for (const summary of summaries) for (const entry of summary.paid) {
    const key = `${entry.currency}|${entry.catalog}`, total = paid.get(key) ?? { ...entry, amount: 0 };
    total.amount += entry.amount;
    paid.set(key, total);
  }
  const starts = summaries.flatMap((summary) => summary.from ? [summary.from] : []).sort(), ends = summaries.flatMap((summary) => summary.until ? [summary.until] : []).sort();
  return { cycles: summaries.flatMap((summary) => summary.cycles), from: starts[0] ?? null, until: ends.at(-1) ?? null,
    capacity: counted.length ? capacity : null, used: counted.length ? used : null, base: counted.length ? sum(counted, (summary) => summary.base!) : null, bonuses,
    unused: counted.length ? capacity - used : null, utilisation: counted.length && capacity > 0 ? used / capacity * 100 : null,
    uncalibrated: sum(summaries, (summary) => summary.uncalibrated), usageUnknown: sum(summaries, (summary) => summary.usageUnknown),
    paid: sortPaid(paid.values()), unpriced: sum(summaries, (summary) => summary.unpriced),
    paidUsdMissing: sum(summaries, (summary) => summary.paidUsdMissing),
    paidUsd: summaries.some((summary) => summary.paid.length) && summaries.every((summary) => !summary.paid.length || summary.paidUsd !== null)
      ? sum(summaries, (summary) => summary.paidUsd ?? 0) : null,
    pointsUsed: sum(summaries, (summary) => summary.pointsUsed), pointWindows: sum(summaries, (summary) => summary.pointWindows) };
}

/**
 * When no cycle of a period has its usage in the unit but some have a capacity (their traffic runs on another machine),
 * those cycles in window points instead: shown as points, never summed with the unit. Null otherwise.
 */
export function pointsFallback(cycles: readonly BillingCycle[], unit: MonthUnit, enabled: ReadonlySet<ResetKind>): MonthSummary | null {
  if (unit === "pp" || summarize(cycles, unit, enabled).capacity !== null) return null;
  const unknown = cycles.filter((cycle) => { const row = monthRow(cycle, unit, enabled); return row.total !== null && row.used.value === null; });
  if (!unknown.length) return null;
  const points = summarize(unknown, "pp", enabled);
  return points.capacity === null ? null : points;
}

/** Average % of one window used before its end: points used ÷ windows; null without % readings. */
export const perWindowPct = (summary: MonthSummary) => summary.pointWindows > 0 ? summary.pointsUsed / summary.pointWindows : null;

/** A cycle's price in USD: the stored NBP conversion, or the amount itself in USD; null while unknown. */
export function cycleUsdPaid(cycle: BillingCycle): number | null {
  if (cycle.price.amount === null) return null;
  return cycle.price.usd ?? (cycle.price.currency === "USD" ? cycle.price.amount : null);
}
/**
 * What one paid dollar bought (user decision 21.10): Σ used ÷ Σ USD paid ("return") and Σ capacity ÷ Σ USD paid
 * ("potential"), each over the cycles where both of its amounts are known and the price is above zero.
 */
export interface PerDollar {
  used: number | null; capacity: number | null;
  /** The sums behind each ratio and how many cycles they cover, for the tooltips. */
  usedSum: number; usedPaid: number; usedCycles: number;
  capacitySum: number; capacityPaid: number; capacityCycles: number;
}
export function perDollar(cycles: readonly BillingCycle[], unit: MonthUnit, enabled: ReadonlySet<ResetKind>): PerDollar {
  let usedSum = 0, usedPaid = 0, usedCycles = 0, capacitySum = 0, capacityPaid = 0, capacityCycles = 0;
  for (const cycle of cycles) {
    const usd = cycleUsdPaid(cycle);
    if (usd === null || !(usd > 0)) continue;
    // Usage is what the cycle bought whether or not its capacity is calibrated.
    const row = monthRow(cycle, unit, enabled);
    if (row.used.value !== null) { usedSum += row.used.value; usedPaid += usd; usedCycles++; }
    if (row.total !== null) { capacitySum += row.total; capacityPaid += usd; capacityCycles++; }
  }
  return { used: usedCycles ? usedSum / usedPaid : null, capacity: capacityCycles ? capacitySum / capacityPaid : null,
    usedSum, usedPaid, usedCycles, capacitySum, capacityPaid, capacityCycles };
}

/** Units that add up across subscriptions: API $ and tokens everywhere, credits over Codex only; window points never. */
export type AllUnit = Exclude<MonthUnit, "pp">;
export interface SubscriptionPeriod { provider: string; account: string; cycles: BillingCycle[]; summary: MonthSummary }
/**
 * Every subscription's own cycles of the period (its current, previous or all cycles) and their sum; subscriptions without
 * a cycle in the period (ended ones, for the current cycle) are listed apart. Business credit accounts have no subscription
 * capacity and are left out; credits are summed over Codex subscriptions only.
 */
export function allSubscriptions(accounts: readonly BillingCyclesAccount[], period: MonthPeriod, unit: AllUnit, enabled: ReadonlySet<ResetKind>, now = Date.now()):
  { rows: SubscriptionPeriod[]; empty: Array<{ provider: string; account: string }>; total: MonthSummary } {
  const all = accounts.filter((entry) => !entry.account.endsWith("::business") && (unit !== "credits" || entry.provider === "codex"))
    .map((entry) => { const cycles = periodCycles(entry.cycles, period, now); return { provider: entry.provider, account: entry.account, cycles, summary: summarize(cycles, unit, enabled) }; })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.account.localeCompare(b.account));
  const rows = all.filter((row) => row.cycles.length > 0);
  return { rows, empty: all.filter((row) => !row.cycles.length).map(({ provider, account }) => ({ provider, account })), total: combineSummaries(rows.map((row) => row.summary)) };
}

/** The billing provider and account of the screen's subscription (stored lower-case, provider as the server names it). */
export function billingAccountOf(vendor: string, account: string): { provider: string; account: string } {
  const provider = vendor === "openai" ? "codex" : vendor === "anthropic" ? "claude" : vendor;
  return { provider: provider.toLowerCase(), account: account.toLowerCase() };
}

/* ---- The viewer's remembered unit and switched-off kinds (a convenience; never shared). ---- */
export const MONTH_STATE_KEY = "tokenatlas.subscription-month.v1";
export interface MonthState { unit: MonthUnit; off: ResetKind[]; period: MonthPeriod }
const UNITS: readonly MonthUnit[] = ["api", "credits", "tokens", "pp"];
const browserStorage = (): Storage | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
export function readMonthState(storage: Storage | null = browserStorage()): MonthState {
  try {
    const value = JSON.parse(storage?.getItem(MONTH_STATE_KEY) ?? "null") as Partial<MonthState> | null;
    return { unit: UNITS.includes(value?.unit as MonthUnit) ? value!.unit! : "api",
      off: Array.isArray(value?.off) ? value!.off!.filter((kind): kind is ResetKind => RESET_KINDS.some((entry) => entry.id === kind)) : [],
      period: PERIODS.includes(value?.period as MonthPeriod) ? value!.period! : "current" };
  } catch { return { unit: "api", off: [], period: "current" }; }
}
export function writeMonthState(state: MonthState, storage: Storage | null = browserStorage()): void {
  try { storage?.setItem(MONTH_STATE_KEY, JSON.stringify(state)); } catch { /* The choice still applies for this visit. */ }
}
