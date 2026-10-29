import { canonicalPeriodPlan, isFreePlan, isNoPlan } from "./period-end";
import type { ContextPrice } from "./context-price";

/**
 * Billing cycles (docs/billing-cycles-design-2026-10-08.md §2-§3, user decisions of 08.10 in §12): every run of one
 * plan of one account is cut into cycles `start_k = anchor + k·cycle_months` (same UTC day and time; the 31st falls to
 * the last day of a shorter month). The derivation is pure and cheap: it reads only plan periods and the starts of the
 * account's limit windows, so the producer can run it for an account whenever anything it depends on may have moved.
 */
export type CycleBasis = "declared" | "observed" | "inferred";
/** `repeated`: a later cycle of a run with a full-cycle payment takes that payment again (user decision 18.10, replacing §12.4). */
export type CyclePriceSource = "declared" | "repeated" | "catalog" | "inferred";

/** One plan period of one account, as the derivation reads it (declared or observed origin). */
export interface CyclePlanRow {
  origin: "declared" | "observed";
  plan: string;
  /** Inclusive ISO instant (or YYYY-MM-DD = UTC midnight). */
  from: string;
  /** Exclusive; null while the period continues. */
  until: string | null;
  /** Observed rows: the last reading behind the row (continuation evidence ends there). */
  lastSeen?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  /** Declared rows: the renewal instant the cycles are counted from (default `from`). */
  anchor?: string | null;
  /** 1 (monthly, default) or 12 (annual). */
  cycleMonths?: number | null;
}
/** A window of the account's main counter: where an observed run's payment date is guessed from (§12.2). */
export interface CycleWindowStart { start: number; end: number; plan: string | null }

/**
 * Price of one nominal cycle of `plan` in USD from the catalog on `day` (annual: the annual price times twelve), null when
 * the catalog does not price it; 0 means a free plan, which has no cycles.
 */
export type CatalogCyclePrice = (plan: string, day: string, cycleMonths: number) => number | null;

/** PLN per unit of `currency` for a payment made on `day` (NBP table A, last business day before it); null: not stored yet. */
export type FxLookup = (currency: string, day: string) => { plnPerUnit: number; effectiveDay: string; tableNo: string | null } | null;
/** How a non-USD payment became dollars: amount × `rate` / `usd_rate` (PLN per unit), both of `effective_day`; rates null while missing. */
export interface CycleFx {
  currency: string;
  /** The payment day the rate applies to. */
  day: string;
  rate: number | null;
  usd_rate: number | null;
  effective_day: string | null;
  table: string | null;
}

export interface DerivedCycle {
  start: number;
  end: number;
  /** The scheduled cycle the stretch belongs to; differs from start/end when a plan change or the run's edge cuts it. */
  nominalStart: number;
  nominalEnd: number;
  plan: string;
  basis: CycleBasis;
  /** The payment day is a guess (a run known only from readings). */
  anchorUncertain: boolean;
  cycleMonths: number;
  shortened: boolean;
  current: boolean;
  /**
   * What was paid: the declared amount of the row's first cycle, that full-cycle payment again for the run's later cycles,
   * else the catalog price (prorated when shortened); null: unknown.
   */
  amountMinor: number | null;
  currency: string | null;
  priceSource: CyclePriceSource;
  /** The amount in USD (cents rounded); null when unknown or its rate is not stored yet, never 0 by default. */
  amountUsd: number | null;
  /** The conversion behind `amountUsd`; null for USD amounts and unknown ones. */
  fx: CycleFx | null;
  /** The catalog price of the whole nominal cycle in USD, null when the catalog does not price the plan. */
  catalogUsd: number | null;
  /** The run the cycle belongs to: where it starts, the instant its cycles are counted from and its end (null: open). */
  run: { from: number; anchor: number; until: number | null };
  /** The declared row behind a declared cycle (its `from` as written), for the editor. */
  declaredFrom: string | null;
}

const DAY_MS = 86_400_000;
/** Evidence right after a renewal may still be the old cycle's (late readings, a failed payment): 24 h of tolerance. */
export const CONTINUATION_GRACE_MS = DAY_MS;
/** Windows further apart than this do not belong to one run when an observed run's anchor is walked back. */
const WINDOW_RUN_GAP_MS = 7 * DAY_MS;

export function instantOf(value: string): number {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(ms)) throw new Error(`billing cycles: invalid instant '${value}'`);
  return ms;
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `anchor` plus `months` calendar months, same UTC day and time; a day the month lacks falls to its last day. */
export function addMonthsUtc(anchor: number, months: number): number {
  const d = new Date(anchor);
  const month = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), month, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(),
    d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** The index k of the scheduled cycle that holds `at`: start_k <= at < start_{k+1}. */
function cycleIndexAt(anchor: number, months: number, at: number): number {
  let k = Math.floor((at - anchor) / (30.44 * DAY_MS * months));
  while (addMonthsUtc(anchor, k * months) > at) k--;
  while (addMonthsUtc(anchor, (k + 1) * months) <= at) k++;
  return k;
}

interface Range { from: number; until: number }
const overlaps = (a: Range, b: Range) => a.from < b.until && b.from < a.until;
/** `ranges` minus `cut`, both lists of half-open ranges. */
function subtract<T extends Range>(ranges: readonly T[], cut: readonly Range[]): T[] {
  let parts = [...ranges];
  for (const hole of cut) {
    parts = parts.flatMap((part) => {
      if (!overlaps(part, hole)) return [part];
      const kept: T[] = [];
      if (part.from < hole.from) kept.push({ ...part, until: hole.from });
      if (part.until > hole.until) kept.push({ ...part, from: hole.until });
      return kept;
    });
  }
  return parts;
}

interface Run {
  plan: string; basis: CycleBasis; from: number; until: number; anchor: number; months: number; anchorUncertain: boolean;
  amountMinor: number | null; currency: string | null; declaredFrom: string | null;
  /** A full-cycle payment the run's later cycles (all of an inferred run's) take again; null: catalog. */
  repeat: { amountMinor: number; currency: string | null } | null;
}

export interface DeriveCyclesOptions {
  now: number;
  price: CatalogCyclePrice;
  /** Stored exchange rates; without it non-USD amounts have no USD equivalent. */
  fx?: FxLookup;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
/**
 * The USD equivalent of a payment of `amountMinor` `currency` made on `day`: PLN directly, other currencies across PLN with
 * both rates of the same NBP table. Unknown amount, currency or rate gives null (with the needed conversion), never 0.
 */
export function usdEquivalent(amountMinor: number | null, currency: string | null, day: string, fx?: FxLookup): { usd: number | null; fx: CycleFx | null } {
  const code = currency?.trim().toUpperCase() ?? "";
  // No amount, or no ISO currency to ask a rate for: unknown, with nothing to fetch.
  if (amountMinor === null || !/^[A-Z]{3}$/.test(code)) return { usd: null, fx: null };
  if (amountMinor === 0) return { usd: 0, fx: null };
  if (code === "USD") return { usd: round2(amountMinor / 100), fx: null };
  const usd = fx?.("USD", day) ?? null;
  const own = code === "PLN" ? { plnPerUnit: 1 } : fx?.(code, day) ?? null;
  const ready = usd !== null && own !== null && usd.plnPerUnit > 0;
  return { usd: ready ? round2(amountMinor / 100 * own.plnPerUnit / usd.plnPerUnit) : null,
    fx: { currency: code, day, rate: own?.plnPerUnit ?? null, usd_rate: usd?.plnPerUnit ?? null, effective_day: ready ? usd.effectiveDay : null,
      table: ready ? usd.tableNo : null } };
}

/** A positive declared payment that covers a whole scheduled cycle (not a prorated surcharge) is taken again by later cycles. */
function repeatable(row: CyclePlanRow, from: number, anchor: number, months: number): Run["repeat"] {
  if (row.amountMinor == null || row.amountMinor <= 0) return null;
  if (addMonthsUtc(anchor, cycleIndexAt(anchor, months, from) * months) !== from) return null;
  return { amountMinor: row.amountMinor, currency: row.currency ?? null };
}

/**
 * The billing cycles of one account (§2-§3, §12):
 *
 * - each declared row is a run; its cycles count from `anchor` (default `from`), every `cycle_months` (1 or 12); the
 *   declared amount belongs to the row's first cycle; when it paid a whole scheduled cycle, the later cycles and the inferred
 *   continuation take it again (`repeated`, user decision 18.10), otherwise the catalog price in USD; a payment right after a
 *   plan change inside the previous plan's cycle is a prorated surcharge: its later cycles repeat the last full payment of
 *   the same plan on the account instead, else the catalog (user decision 18.10, rules 14);
 * - after a declared `until` that no other declaration covers, a cycle is inferred while an observed row of the same plan
 *   outside every declaration has a reading in `[start_k + 24 h, end_k)`; the first cycle without one ends the chain, and
 *   a `none` row (or any declaration) blocks it (§3, §12.1);
 * - what remains of observed rows (cut at the declared end of the same plan, outside declarations and inferred cycles) is
 *   a run whose payment day is the first limit window carrying that plan (§12.2), flagged uncertain;
 * - a plan change starts a new run, so the cycle before it ends early (decision 2); `none` and plans the catalog prices at
 *   0 have no cycles; only cycles that have started by `now` are listed.
 */
export function deriveBillingCycles(rows: readonly CyclePlanRow[], windows: readonly CycleWindowStart[], options: DeriveCyclesOptions): DerivedCycle[] {
  const { now } = options;
  const plan = (value: string) => canonicalPeriodPlan(value);
  const declared = rows.filter((row) => row.origin === "declared").map((row) => ({
    row, plan: plan(row.plan), from: instantOf(row.from), until: row.until === null ? Infinity : instantOf(row.until),
  })).sort((a, b) => a.from - b.from);
  const covered: Range[] = declared.map(({ from, until }) => ({ from, until }));
  const isCovered = (at: number) => declared.some((d) => d.from <= at && at < d.until);
  const observed = rows.filter((row) => row.origin === "observed").map((row) => {
    const from = instantOf(row.from), until = row.until === null ? Infinity : instantOf(row.until);
    // A reading proves the plan only where it was taken: an open row is evidence up to its last reading.
    const seen = row.lastSeen ? instantOf(row.lastSeen) + 1 : until === Infinity ? from + 1 : until;
    return { plan: plan(row.plan), from, until, seen: Math.min(until, seen) };
  });
  // Strong evidence: observed rows outside every declaration (§3), up to their last reading.
  const evidence = subtract(observed.map((o) => ({ plan: o.plan, from: o.from, until: o.seen })), covered);
  // Effective observed stretches: a declared end of the same plan closes them (22.09 rule), declarations cover them.
  const effective = subtract(observed.map((o) => {
    let until = o.until;
    for (const d of declared) {
      if (d.plan !== o.plan || d.until === Infinity || o.from >= d.until || d.from >= o.until) continue;
      until = Math.min(until, d.until);
    }
    return { plan: o.plan, from: o.from, until };
  }).filter((o) => o.until > o.from), covered);

  const runs: Run[] = [];
  const chains: Range[] = [];
  const scheduleOf = (d: typeof declared[number]) => ({ months: d.row.cycleMonths === 12 ? 12 : 1, anchor: d.row.anchor ? instantOf(d.row.anchor) : d.from });
  // A payment right after a change of plan inside the previous plan's cycle is a prorated surcharge (user decision 18.10):
  // it is never repeated; later cycles take the last full payment of the same plan on the account, else the catalog.
  const surcharge = (d: typeof declared[number]) => declared.some((p) => {
    if (p === d || p.plan === d.plan || p.from >= d.from || p.until < d.from) return false;
    const { months, anchor } = scheduleOf(p);
    if (!hasCycles(p.plan, p.from, months, options) || options.price(p.plan, day(p.from), months) === 0) return false;
    return addMonthsUtc(anchor, cycleIndexAt(anchor, months, d.from) * months) !== d.from;
  });
  const fullPayment = (d: typeof declared[number]) => {
    const { months, anchor } = scheduleOf(d);
    return surcharge(d) ? null : repeatable(d.row, d.from, anchor, months);
  };
  for (const d of declared) {
    const { months, anchor } = scheduleOf(d);
    const earlier = declared.filter((e) => e.plan === d.plan && e.from < d.from && scheduleOf(e).months === months).map(fullPayment).filter((p) => p !== null);
    const repeat = surcharge(d) ? earlier.at(-1) ?? null : repeatable(d.row, d.from, anchor, months);
    runs.push({ plan: d.plan, basis: "declared", from: d.from, until: d.until, anchor, months, anchorUncertain: false,
      amountMinor: d.row.amountMinor ?? null, currency: d.row.currency ?? null, declaredFrom: d.row.from, repeat });
    if (d.until === Infinity || isCovered(d.until) || !hasCycles(d.plan, d.until, months, options)) continue;
    // Continuation (§3): the declared schedule goes on while each next cycle has strong evidence of the same plan.
    const next = Math.min(Infinity, ...declared.filter((other) => other.from >= d.until).map((other) => other.from));
    let k = cycleIndexAt(anchor, months, d.until);
    if (addMonthsUtc(anchor, k * months) < d.until) k++;
    for (; ; k++) {
      const start = addMonthsUtc(anchor, k * months);
      if (start >= next || start > now) break;
      // Readings of another plan own their stretch (observed before inferred).
      if (effective.some((o) => o.plan !== d.plan && o.from <= start && start < o.until)) break;
      const other = Math.min(Infinity, ...effective.filter((o) => o.plan !== d.plan && o.from > start).map((o) => o.from));
      const end = Math.min(addMonthsUtc(anchor, (k + 1) * months), next, other);
      // Within its first day a cycle cannot have evidence past the tolerance yet: a reading since its start keeps the chain
      // provisionally (otherwise the run would flip to "from readings" for a day every month); a day later the strict rule holds.
      const since = start + CONTINUATION_GRACE_MS <= now ? start + CONTINUATION_GRACE_MS : start;
      const proven = evidence.some((e) => e.plan === d.plan && e.from < end && e.until > since);
      if (!proven) break;
      runs.push({ plan: d.plan, basis: "inferred", from: start, until: end, anchor, months, anchorUncertain: false,
        amountMinor: null, currency: null, declaredFrom: null, repeat });
      chains.push({ from: start, until: end });
      if (end < addMonthsUtc(anchor, (k + 1) * months)) break;
    }
  }
  // Observed runs: what readings show outside declarations and inferred cycles.
  const pieces = subtract(effective, chains).sort((a, b) => a.from - b.from);
  const taken = [...covered, ...chains];
  for (const piece of pieces) {
    // Nothing earlier may be reached back over: a declaration, an inferred cycle or another observed stretch.
    const floor = Math.max(-Infinity, ...[...taken, ...pieces.filter((other) => other !== piece)]
      .filter((range) => range.until <= piece.from).map((range) => range.until));
    const anchor = firstWindowOfRun(windows, piece.plan, piece.from, floor);
    runs.push({ plan: piece.plan, basis: "observed", from: anchor, until: piece.until, anchor, months: 1, anchorUncertain: true,
      amountMinor: null, currency: null, declaredFrom: null, repeat: null });
  }
  return runs.flatMap((run) => cyclesOfRun(run, options)).sort((a, b) => a.start - b.start);
}

/** Free retains capacity cycles; no subscription and other zero-cost offers do not create bills. */
function hasCycles(plan: string, at: number, months: number, options: DeriveCyclesOptions): boolean {
  return !isNoPlan(plan) && (isFreePlan(plan) || options.price(plan, day(at), months) !== 0);
}

/**
 * The start of the first limit window of an unbroken stretch of windows carrying `plan` that reaches `from` (§12.2); never
 * before `floor`. Without such a window the run starts at its first reading.
 */
function firstWindowOfRun(windows: readonly CycleWindowStart[], plan: string, from: number, floor: number): number {
  const ordered = [...windows].sort((a, b) => a.start - b.start);
  let index = -1;
  for (let i = 0; i < ordered.length; i++) if (ordered[i]!.start <= from) index = i;
  const holds = (w: CycleWindowStart | undefined) => !!w && w.plan !== null && canonicalPeriodPlan(w.plan) === plan && w.start >= floor;
  if (!holds(ordered[index]) || ordered[index]!.end < from - WINDOW_RUN_GAP_MS) return from;
  let first = ordered[index]!;
  for (let i = index - 1; i >= 0; i--) {
    const w = ordered[i]!;
    if (!holds(w) || first.start - w.end > WINDOW_RUN_GAP_MS) break;
    first = w;
  }
  return Math.min(from, first.start);
}

function cyclesOfRun(run: Run, options: DeriveCyclesOptions): DerivedCycle[] {
  if (!hasCycles(run.plan, run.from, run.months, options)) return [];
  const cycles: DerivedCycle[] = [];
  for (let k = cycleIndexAt(run.anchor, run.months, run.from); ; k++) {
    const nominalStart = addMonthsUtc(run.anchor, k * run.months), nominalEnd = addMonthsUtc(run.anchor, (k + 1) * run.months);
    if (nominalStart >= run.until) break;
    const start = Math.max(nominalStart, run.from), end = Math.min(nominalEnd, run.until);
    if (start > options.now) break;
    const shortened = start !== nominalStart || end !== nominalEnd;
    const catalogUsd = options.price(run.plan, day(start), run.months);
    const first = cycles.length === 0;
    const declaredAmount = run.basis === "declared" && first && run.amountMinor !== null;
    // A renewal charges the whole cycle again, also one a later change cuts short: the repeated payment is not prorated.
    const repeated = !declaredAmount && run.repeat !== null && (run.basis === "inferred" || !first);
    // A paid amount is what the receipt says; a catalog price covers the part of the cycle the stretch holds.
    const amountMinor = declaredAmount ? run.amountMinor : repeated ? run.repeat!.amountMinor
      : catalogUsd === null ? null : Math.round(catalogUsd * 100 * (shortened ? (end - start) / (nominalEnd - nominalStart) : 1));
    const currency = declaredAmount ? run.currency ?? null : repeated ? run.repeat!.currency : amountMinor === null ? null : "USD";
    const converted = usdEquivalent(amountMinor, currency, day(start), options.fx);
    cycles.push({
      start, end, nominalStart, nominalEnd, plan: run.plan, basis: run.basis, anchorUncertain: run.anchorUncertain,
      cycleMonths: run.months, shortened, current: start <= options.now && options.now < end,
      amountMinor, currency,
      priceSource: declaredAmount ? "declared" : repeated ? "repeated" : run.basis === "inferred" ? "inferred" : "catalog",
      amountUsd: converted.usd, fx: converted.fx,
      catalogUsd, run: { from: run.from, anchor: run.anchor, until: run.until === Infinity ? null : run.until },
      declaredFrom: run.declaredFrom,
    });
  }
  return cycles;
}

/** Everything that defines a derived cycle; a stored row whose identity differs is recomputed. */
export function cycleIdentity(cycle: DerivedCycle): string {
  return JSON.stringify([cycle.start, cycle.end, cycle.nominalStart, cycle.nominalEnd, cycle.plan, cycle.basis, cycle.anchorUncertain,
    cycle.cycleMonths, cycle.amountMinor, cycle.currency, cycle.priceSource, cycle.catalogUsd, cycle.run.from, cycle.run.anchor,
    cycle.run.until, cycle.declaredFrom, cycle.current, cycle.amountUsd, cycle.fx]);
}

// ---------------------------------------------------------------- the API contract (`GET /api/billing-cycles`)

export interface BillingCyclePrice {
  /** In the currency's major unit (113.78 EUR); null: unknown, never 0 by default. */
  amount: number | null;
  currency: string | null;
  source: CyclePriceSource;
  /** The amount in USD at the NBP rate of the payment day; null or absent while unknown. */
  usd?: number | null;
  /** The conversion behind `usd` (non-USD amounts). */
  fx?: CycleFx | null;
}
/** Amounts of a cycle in every unit: tokens (cached within input, total = input + output), API Standard dollars, credits. */
export interface BillingCycleUnits {
  tokens: { input: number; cached: number; output: number; total: number };
  api_usd: number;
  /** Null when credits do not exist for the traffic (not Codex, or calls from before credit billing). */
  credits: { low: number; high: number } | null;
}
/**
 * Capacity of a cycle on its main counter: (windows + idle) × 100 points times the stored value of one point of the
 * cycle's plan (docs/reset-capacity-plan-2026-10-11.md step 1), with the calibration behind it.
 */
export interface BillingCycleCapacity extends BillingCycleUnits {
  /** Separate API calibration of the opt-in projection; the stored calibration below remains unchanged. */
  context_api_calibration?: BillingCycleCapacity["calibration"];
  /** (windows + idle) × 100. */
  pp: number;
  /** Capacity regime factor of the cycle's windows; the calibration's per-point values are at factor 1. */
  factor: number;
  calibration: {
    counter: string; plan: string;
    /** Calibration windows, of them inside the cycle (the rest are the nearest of the same account, counter and plan), and their points. */
    windows: number; inside: number; pp: number;
    from: string; until: string;
    /** `observed_partial_traffic` for Claude: its limit also covers traffic this machine does not see. */
    scope: string | null;
    /** Windows left out as outliers (value per point under 1/2 or over 2x the account's median), with their starts. */
    outliers: { count: number; starts: string[] };
  };
}
/**
 * The early resets of a cycle's main-counter windows that ended inside it, by cause (docs/reset-capacity-plan-2026-10-11.md
 * step 3): how many windows ended so, and their bonus Σ(1 − f) in windows, points and the cycle's calibrated units.
 */
export interface BillingCycleResetBonus {
  /** Resets ending inside the cycle. */
  count: number;
  /** Resets ending before the cycle whose bonus time (between the reset and the planned one) reaches into it. */
  carried?: number;
  windows: number;
  pp: number;
  /** Null when the cycle has no calibrated capacity. */
  api_usd: number | null;
  tokens: { input: number; cached: number; output: number; total: number } | null;
  credits: { low: number; high: number } | null;
  /** Banked only: how many credits came to all accounts and how many from an unknown origin. */
  origins?: { all_accounts: number; unknown: number };
}
export type BillingCycleResets = Partial<Record<"open" | "scheduled" | "plan_change" | "not_reset" | "banked" | "provider" | "provider_probable" | "single" | "unknown",
  BillingCycleResetBonus>>;
/**
 * Banked resets the account was granted in the cycle (Codex, from its reset-credit readings, recorded from 02.09): `count` grants
 * seen from `from` (the reading counting starts at) to the cycle's end or now. `complete` requires a reading at most a day before the
 * cycle and dated credit-list evidence throughout; observation-only grants are a lower bound.
 */
export interface BillingCycleBankedGrants { count: number; from: string; complete: boolean }
/**
 * One main-counter window of a cycle, reset to reset (approved 11.10): how it ended (the stored end cause; null before it
 * is stored), the points it used before its end and its part of the cycle's capacity.
 */
export interface BillingCycleWindow {
  start: string;
  end: string;
  cause: keyof BillingCycleResets | null;
  /** Its rise on the allowance meter (a fragment of a chain rises from where the previous one left it); null without %. */
  used_pp: number | null;
  /** Its own time inside the cycle as a part of its allowance (1 for a whole window, also one cut short by a reset). */
  share: number;
  /** Its part of the cycle's capacity (windows and idle time, at the regime factors when the cycle has a capacity). */
  capacity_share: number | null;
}
export interface BillingCycleOtherCounter {
  /** A counter shown beside the main one (5 h, a scoped sub-limit): never summed into it. */
  counter: string;
  windows: number;
  used_pp: number | null;
  used_pct: number | null;
}
export interface BillingCycle {
  /** Read-time split of the same paired window parts as api_usd and used_units.api_usd. */
  context_price?: ContextPrice;
  start: string;
  end: string;
  plan: string;
  basis: CycleBasis;
  anchor_uncertain: boolean;
  cycle_months: number;
  shortened: boolean;
  current: boolean;
  price: BillingCyclePrice;
  catalog_usd: number | null;
  windows: {
    /** Σ of each touched window's share of its own time inside the cycle (an early-reset window still counts whole). */
    share: number;
    /** Time between windows (a window opens only at first use), in nominal windows: unused capacity. */
    idle: number;
    touched: number;
    /** Part of the cycle's elapsed time covered by windows or known idle time; the rest has no readings (unknown). */
    observed_share: number | null;
  };
  /** Points used on the main counter; null when a touched window reported no %. */
  used_pp: number | null;
  /** used_pp / (windows + idle); null when unknown. */
  used_pct: number | null;
  /** API Standard value of the counted traffic of the touched windows' parts; null when a window's sums are missing. */
  api_usd: number | null;
  /** `capacity.api_usd`, the basis of `api_usd`; null without a calibration, with the flag `capacity_uncalibrated`. */
  capacity_usd: number | null;
  /** Capacity in points, tokens, API Standard dollars and credits, with its calibration; null when uncalibrated. */
  capacity: BillingCycleCapacity | null;
  /** What the cycle used in the same units; null when a touched window has no sums. */
  used_units: BillingCycleUnits | null;
  /** The ends of its main-counter windows by cause, with the reset bonuses; null before the causes are stored. */
  resets: BillingCycleResets | null;
  /** Banked resets granted in the cycle; null without reset-credit readings inside it (other providers, or before 02.09). */
  banked_granted?: BillingCycleBankedGrants | null;
  /** Its main-counter windows; only in the view of one account (`?provider=&account=`), absent from the unfiltered one. */
  main_windows?: BillingCycleWindow[] | null;
  /** Current cycle only: the elapsed part of its windows and the minimal projection to its end. */
  to_date: { windows: number; used_pct: number | null } | null;
  projection: { windows_min: number; used_pct: number | null } | null;
  /** Price per point of capacity: price / ((windows + idle) · 100), in the price's currency. */
  per_window_point: number | null;
  /** Windows without % (Claude's declared schedule before percentage readings): counted and valued, % unknown. */
  unmetered: { windows: number; api_usd: number | null } | null;
  others: BillingCycleOtherCounter[];
  /** Why something is unknown or approximate. */
  flags: string[];
  /** The run of the cycle and the declared row behind it: what the editor opens. */
  run: { from: string; anchor: string; until: string | null };
  declared_from: string | null;
}
export interface BillingCyclesAccount {
  provider: string;
  account: string;
  /** The main counter the cycles' capacity is read from; null without limit windows. */
  counter: string | null;
  /** The stored rows wait for the background producer (new readings, an edit, a cycle that has just rolled over). */
  stale: boolean;
  /** Why the rows are stale and from when; null when current. Absent from servers before it was added. */
  pending?: BillingCyclesPending | null;
  cycles: BillingCycle[];
}
/**
 * - `rules`: new calculation rules, every cycle is recomputed (dates and prices may change);
 * - `periods`: a plan period changed (an edit or a reading of another plan): dates and prices may change from `from`;
 * - `rollover`: the current cycle ended at `from`, the next one is being added;
 * - `figures`: new readings, sums, point values, rates: the figures refresh, the dates stay.
 */
export interface BillingCyclesPending { reason: "rules" | "periods" | "rollover" | "figures"; from: string | null }
export interface BillingCyclesView { accounts: BillingCyclesAccount[] }
