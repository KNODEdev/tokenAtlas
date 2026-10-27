import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { normEraKey, normEraVendor } from "./eras";
import { PLAN_PERIODS, loadPeriods } from "../db/period-store";
import { BILLING_ALL_ACCOUNTS, BILLING_BEGINNING, hasBillingCycles, markBillingCyclesDirty } from "../db/billing-cycles";
import { ANSWER_SCOPE_ALL, ANSWER_SCOPE_NONE } from "../db/window-answers";
import { cycleIdentity, deriveBillingCycles, type BillingCycleBankedGrants, type BillingCycleCapacity, type BillingCycleResets, type BillingCycleWindow, type CatalogCyclePrice, type CyclePlanRow,
  type CycleFx, type DerivedCycle, type FxLookup } from "../shared/billing-cycles";
import { storedFxLookup } from "../db/fx-rates";
import { readWindowEndCauses, type WindowEndCauseRow } from "../db/window-end-causes";
import { windowEndCausesStale } from "./window-end-causes";
import { aggregateCycleUnits, aggregateCycleUsage, pairedRunning, type CycleUnitAmounts, type CycleUnits, type CycleUnitsWindow, type CycleUsage,
  type CycleUsageWindow } from "./billing-cycle-usage";
import { readWindowPointValues, type WindowPointValueRow } from "../db/window-point-values";
import { cyclePointCalibration, cycleRegimeFactors, planKeyOf, windowPointValuesStale, type PointCalibration } from "./window-point-values";
import type { WindowUsage } from "../shared/codex-accounting";
import { resolvePlanFacts, type PlansCatalog } from "../shared/plan-catalog";

/**
 * The billing-cycle producer (docs/billing-cycles-design-2026-10-08.md §5): a step of the one background writer, after
 * the window sums. It reads only plan periods (with the declarations they hold), `limit_windows` and `window_usage`, and
 * writes `billing_cycles`; a screen reads those rows and never waits for this.
 *
 * What it recomputes, per account:
 * - a plan period change marks the account from its earliest changed start (period-store.ts, in the writer's transaction);
 * - new % readings and window sums: the marks of `window_answer_marks` (written with every limit-window and window-sum
 *   publication) are followed by a cursor and become entries of the accounts they name;
 * - the derivation (cheap: plan rows and window starts) runs again for every account once a minute, so a cycle that has
 *   rolled over or new continuation evidence (a moved `last_seen`) is caught; only cycles whose identity changed are
 *   aggregated again, and the current cycle every few minutes (its to-date part moves with the clock);
 * - a catalog change moves `catalog_usd` and the catalog prices, which are part of a cycle's identity;
 * - a changed window point value (window-point-values.ts) marks every cycle of its account: the capacity of a cycle is
 *   calibrated from its account's stored point values, borrowing the nearest windows when its own are too few;
 * - a changed end cause (window-end-causes.ts) marks the cycles holding the window's end (its reset bonus);
 * - a stored exchange rate (fx-rates.ts) changes the USD equivalent, part of a cycle's identity, of the cycles paid that day.
 * Restart, a changed tab or a cleared cache recompute nothing.
 */
/**
 * 13: later cycles of a full-cycle payment repeat it, and payments carry their USD equivalent (user decision 18.10).
 * 14: a payment right after a mid-cycle plan change is a prorated surcharge, never repeated; later cycles take the last full
 * payment of the same plan on the account (user decision 18.10).
 * 15: repeated full payments must match the billing interval; zero-cost rows do not make a paid upgrade a surcharge.
 * 16: each cycle reads the main counter of its plan (Free or paid), not the account's longest counter; calibration matches
 * plans by catalog plan id, so "prolite" windows calibrate "pro-5x" cycles (user decisions 21.10).
 * 17: global plan facts price Free at zero while retaining its capacity cycles.
 * 18: Codex cycles store the banked resets granted in them, from the reset-credit readings (banked-grants.ts).
 */
export const BILLING_CYCLES_VERSION = 18;
const RULES_KEY = "billing_cycles_rules";
const MARKS_KEY = "billing_cycles_marks";
/** How often every account's cycles are derived again to catch the clock and moved evidence. */
const DERIVE_EVERY_MS = 60_000;
/** The current cycle's to-date part and projection move with the clock: refreshed at least this often. */
const CURRENT_REFRESH_MS = 10 * 60_000;

export interface BillingCycleOptions {
  catalog: PlansCatalog;
  /** Stored exchange rates; read from the database when absent. */
  fx?: FxLookup;
  now?: number;
  budgetMs?: number;
  canWrite?: () => boolean;
  /** Derive every account again now (tests; the producer otherwise does it once a minute). */
  derive?: boolean;
}

export interface StoredCycleRow {
  provider: string; account: string; start_ts: string; end_ts: string; plan: string; basis: string; anchor_uncertain: number;
  cycle_months: number; amount_minor: number | null; currency: string | null; price_source: string; catalog_usd: number | null;
  counter: string | null; windows_share: number; idle_share: number; windows_touched: number; observed_share: number | null;
  used_pp: number | null; api_usd: number | null; capacity_usd: number | null; is_current: number; flags: string; detail: string;
  inputs_rev: string; computed_at: string;
}
export interface CycleDetail {
  nominal: [string, string];
  shortened: boolean;
  run: { from: string; anchor: string; until: string | null };
  declared_from: string | null;
  early_resets: number;
  /** Current cycle: windows to date and the minimal projection, both as of `computed_at`. */
  to_date: number | null;
  projection: number | null;
  others: Array<{ counter: string; windows: number; used_pp: number | null; idle: number }>;
  unmetered: { windows: number; api_usd: number | null } | null;
  /**
   * Capacity of the cycle on the main counter: its windows and idle time in points times the stored value of one point
   * (docs/reset-capacity-plan-2026-10-11.md step 1), with the calibration behind it; null without one (never 0).
   */
  capacity?: CycleCapacity | null;
  /** What the cycle used in the same units (the touched windows' parts inside it); null when a window has no sums. */
  used_units?: CycleUnits | null;
  /** Main-counter windows ending inside the cycle by cause, with their reset bonuses (reset-capacity plan step 3). */
  resets?: BillingCycleResets | null;
  /** The cycle's main-counter windows with their end causes, points used and capacity parts (served to one account only). */
  main_windows?: BillingCycleWindow[] | null;
  /** Banked resets granted in the cycle (Codex); null without reset-credit readings inside it. */
  banked_granted?: BillingCycleBankedGrants | null;
  /** The price in USD and the conversion behind it (rule 13). */
  price_usd?: number | null;
  fx?: CycleFx | null;
}
export type CycleCapacity = BillingCycleCapacity;

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);

// ---------------------------------------------------------------- inputs

/** The catalog price of one nominal cycle: the monthly price, or for an annual cycle the annual price times twelve. */
export function catalogCyclePrice(catalog: PlansCatalog, provider: string): CatalogCyclePrice {
  return (plan, onDay, months) => {
    const facts = resolvePlanFacts(catalog, provider, plan, onDay);
    if (months !== 12) return facts.usd_per_month;
    const perMonth = facts.usd_per_month_annual ?? facts.usd_per_month;
    return perMonth === null ? null : perMonth * 12;
  };
}

import { countersOf, isFreePlan, mainCounterFor, mainCounterOf, mainCountersOf, type Counter } from "./main-counter";
import { pairingBounds } from "./subscription-window-comparison";
import { bankedGrants, creditReadings } from "./banked-grants";
import type { ProbeLimitWindow } from "./probe-limit-windows";
export { mainCounterOf };

interface AccountKey { provider: string; account: string }
const keyOf = (k: AccountKey) => `${k.provider}|${k.account}`;

function planRowsOf(all: ReturnType<typeof loadPeriods>, account: AccountKey): CyclePlanRow[] {
  return all.filter((p) => normEraVendor(p.provider) === account.provider && normEraKey(p.subject) === account.account)
    .map((p) => ({ origin: p.origin, plan: p.value, from: p.from, until: p.until, lastSeen: p.lastSeen, amountMinor: p.amountMinor ?? null,
      currency: p.currency ?? null, anchor: p.anchor ?? null, cycleMonths: p.cycleMonths ?? null }));
}

/** The accounts with plan rows, and those that still have stored cycles (their rows go when the plan rows went). */
function knownAccounts(db: Database, plans: ReturnType<typeof loadPeriods>): AccountKey[] {
  const keys = new Map<string, AccountKey>();
  for (const p of plans) { const k = { provider: normEraVendor(p.provider), account: normEraKey(p.subject) }; keys.set(keyOf(k), k); }
  for (const row of db.query("SELECT DISTINCT provider, account FROM billing_cycles").all() as AccountKey[]) keys.set(keyOf(row), row);
  return [...keys.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

interface WindowRow { counter: string; start_ts: string; end_ts: string; cycle_end_basis: string; window_minutes: number; plan: string | null;
  final_percent: number | null; first_percent: number | null; api_usd: number | null; has_usage: number; window_id: string; usage: string | null;
  has_drop: number; activity: string | null; reset_ts: string }
type AccountWindow = CycleUsageWindow & CycleUnitsWindow & { plan: string | null; firstPercent: number | null; events: number | null };

/** One account's derivation inputs and its windows, read once for all of its cycles. */
class AccountInputs {
  readonly counters: Counter[];
  /** A plan's identity for calibration (its catalog plan id). */
  readonly planKey: (plan: string) => string;
  private windows = new Map<string, AccountWindow[]>();
  private points = new Map<string, WindowPointValueRow[]>();
  private causes = new Map<string, WindowEndCauseRow[]>();
  constructor(private db: Database, readonly key: AccountKey, catalog: PlansCatalog) {
    this.counters = countersOf(db, key.provider, key.account);
    this.planKey = planKeyOf(catalog, key.provider);
  }
  /** The main counter a cycle reads: the one of its Free or paid plan (main-counter.ts). */
  mainFor(cycle: { plan: string }): Counter | null { return mainCounterFor(this.counters, isFreePlan(cycle.plan)); }
  /** Windows of one counter, sorted, with the last % and the API value from `json_extract`; readings parsed on demand. */
  windowsOf(counter: string): AccountWindow[] {
    const cached = this.windows.get(counter);
    if (cached) return cached;
    const rows = this.db.query(`SELECT l.counter, l.start_ts, l.end_ts, l.cycle_end_basis, l.window_minutes, l.plan, l.window_id,l.activity,l.reset_ts,
        json_extract(l.readings, '$[#-1].percent') AS final_percent, json_extract(u.cycle, '$.usage.api_standard') AS api_usd,
        u.window_id IS NOT NULL AS has_usage, json_extract(u.cycle, '$.usage') AS usage,
        json_extract(l.readings, '$[0].percent') AS first_percent, l.start_drop IS NOT NULL AS has_drop
      FROM limit_windows l LEFT JOIN window_usage u ON u.provider=l.provider AND u.account=l.account AND u.counter=l.counter AND u.window_id=l.window_id
      WHERE l.provider=? AND l.account=? AND l.counter=? ORDER BY l.start_ts`).all(this.key.provider, this.key.account, counter) as WindowRow[];
    const db = this.db, key = this.key;
    const list = rows.map((row): AccountWindow => {
      let detail: ReturnType<CycleUsageWindow["detail"]> | null = null;
      let units: Array<readonly [number, CycleUnitAmounts]> = [];
      const usage = row.usage ? JSON.parse(row.usage) as Partial<WindowUsage> : null;
      const activity = row.activity ? JSON.parse(row.activity) as ProbeLimitWindow["activity"] : undefined;
      return {
        start: Date.parse(row.start_ts), end: Date.parse(row.end_ts), basis: row.cycle_end_basis, plan: row.plan,
        finalPercent: typeof row.final_percent === "number" ? row.final_percent : null,
        firstPercent: typeof row.first_percent === "number" ? row.first_percent : null,
        ...(activity?.start_basis === "partial" && row.first_percent !== null ? { meterStart: row.first_percent } : {}),
        events: row.has_usage && typeof usage?.events === "number" ? usage.events : null,
        apiUsd: row.has_usage ? (typeof row.api_usd === "number" ? row.api_usd : 0) : null,
        usage: row.has_usage ? { tokens: usage?.tokens ?? 0, input: usage?.input ?? 0, cached: usage?.cached ?? 0, output: usage?.output ?? 0,
          api_standard: usage?.api_standard ?? 0, credits_low: usage?.credits_low ?? 0, credits_high: usage?.credits_high ?? 0 } : null,
        // Credits exist for Codex only, and not for calls from before it billed subscriptions in credits.
        credits: key.provider === "codex" && !((usage?.credits_unavailable_events ?? 0) > 0),
        running() { this.detail(); return units; },
        detail() {
          if (detail) return detail;
          const stored = db.query(`SELECT l.readings AS lr, u.readings AS ur FROM limit_windows l LEFT JOIN window_usage u
              ON u.provider=l.provider AND u.account=l.account AND u.counter=l.counter AND u.window_id=l.window_id
            WHERE l.provider=? AND l.account=? AND l.counter=? AND l.window_id=?`).get(key.provider, key.account, row.counter, row.window_id) as { lr: string; ur: string | null } | null;
          const readings = stored ? JSON.parse(stored.lr) as ProbeLimitWindow["readings"] : [];
          const percents = readings.map((r) => [Date.parse(r.ts), r.percent] as const);
          const sums = (stored?.ur ? JSON.parse(stored.ur) as Array<{ ts: string; usage: Partial<CycleUnitAmounts> }> : [])
            .map((r) => [Date.parse(r.ts), r.usage] as const).sort((a, b) => a[0] - b[0]);
          // The running sums on the window's paired interval, the same traffic as its usage (pairingBounds).
          const pairing = readings.length ? pairingBounds({ start: row.start_ts, readings: [...readings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
            startDrop: row.has_drop ? { before: 0, after: 0 } : null, reset: row.reset_ts, window_minutes: row.window_minutes,
            ...(activity ? { activity } : {}) }) : null;
          const bounds = pairing ? { fromReset: pairing.fromReset, start: Date.parse(pairing.start), end: Date.parse(pairing.last.ts) }
            : { fromReset: true, start: Date.parse(row.start_ts), end: Infinity };
          const running = pairedRunning(sums.map(([t, u]) => [t, u.api_standard ?? 0] as const), bounds, (value, base) => value - base);
          units = pairedRunning(sums.map(([t, u]) => [t, { tokens: u.tokens ?? 0, api_standard: u.api_standard ?? 0, credits_low: u.credits_low ?? 0,
            credits_high: u.credits_high ?? 0 }] as const), bounds, (value, base) => ({ tokens: value.tokens - base.tokens,
            api_standard: value.api_standard - base.api_standard, credits_low: value.credits_low - base.credits_low, credits_high: value.credits_high - base.credits_high }));
          detail = { percents: percents.sort((a, b) => a[0] - b[0]), running };
          return detail;
        },
      };
    });
    // Windows joined by ends that were not resets (stored end causes) are one allowance: each fragment counts by its part of it.
    const causes = this.endCausesOf(counter);
    const notReset = new Set(causes.filter((row) => row.cause === "not_reset").map((row) => Date.parse(row.window_start)));
    // A plan change starts a new allowance: never joined, and its end is no early reset either.
    const planChange = new Set(causes.filter((row) => row.cause === "plan_change").map((row) => Date.parse(row.window_start)));
    for (const window of list) if (planChange.has(window.start)) window.notReset = true;
    for (let first = 0; first < list.length;) {
      let last = first;
      while (last + 1 < list.length && notReset.has(list[last]!.start) && list[last + 1]!.start - list[last]!.end <= 2 * 60_000) last++;
      if (last > first) {
        const allowance = list[last]!.end - list[first]!.start;
        for (let i = first; i <= last; i++) {
          const window = list[i]!, previous = list[i - 1];
          window.allowanceMs = allowance;
          // A chain's last fragment may itself end in a plan change: still no early reset.
          window.notReset = i < last || planChange.has(window.start);
          if (i > first && previous?.finalPercent != null && window.meterStart === undefined)
            window.meterStart = window.firstPercent === null ? previous.finalPercent : Math.min(previous.finalPercent, window.firstPercent);
        }
      }
      first = last + 1;
    }
    this.windows.set(counter, list);
    return list;
  }
  /** The stored end causes of one counter's windows (window-end-causes.ts); read once per account. */
  endCausesOf(counter: string): WindowEndCauseRow[] {
    const cached = this.causes.get(counter);
    if (cached) return cached;
    const rows = readWindowEndCauses(this.db, this.key.provider, this.key.account, counter);
    this.causes.set(counter, rows);
    return rows;
  }
  /** The stored point values of one counter's windows (window-point-values.ts); read once per account. */
  pointValuesOf(counter: string): WindowPointValueRow[] {
    const cached = this.points.get(counter);
    if (cached) return cached;
    const rows = readWindowPointValues(this.db, this.key.provider, this.key.account, counter);
    this.points.set(counter, rows);
    return rows;
  }
  /** Banked resets granted in [start, end) (Codex only); readings from a day before anchor the count. */
  bankedGrants(start: number, end: number): BillingCycleBankedGrants | null {
    if (this.key.provider !== "codex" || !(start < end)) return null;
    return bankedGrants(creditReadings(this.db, this.key.account, start - 86_400_000, end), start, end);
  }
  /** Windows without % of the account (Claude's declared schedule): `declared:<kind>` rows of window usage. */
  unmetered(kind: string, start: number, end: number): CycleDetail["unmetered"] {
    const rows = this.db.query(`SELECT start_ts, end_ts, json_extract(cycle, '$.usage.api_standard') AS api_usd FROM window_usage
      WHERE provider=? AND account=? AND counter=? AND end_ts > ? AND start_ts < ?`)
      .all(this.key.provider, this.key.account, `declared:${kind}`, iso(start), iso(end)) as Array<{ start_ts: string; end_ts: string; api_usd: number | null }>;
    if (!rows.length) return null;
    let windows = 0, apiUsd: number | null = 0;
    for (const row of rows) {
      const s = Date.parse(row.start_ts), e = Date.parse(row.end_ts), part = (Math.min(e, end) - Math.max(s, start)) / (e - s);
      windows += part;
      // Without readings a cut window's value is split by time.
      if (apiUsd !== null) apiUsd = typeof row.api_usd === "number" ? apiUsd + row.api_usd * part : null;
    }
    return { windows, api_usd: apiUsd };
  }
}

// ---------------------------------------------------------------- one account

export function deriveAccountCycles(plans: ReturnType<typeof loadPeriods>, inputs: AccountInputs, catalog: PlansCatalog, now: number, fx?: FxLookup): DerivedCycle[] {
  const rows = planRowsOf(plans, inputs.key);
  if (!rows.length) return [];
  // The windows of the Free and the paid main counter: a run's payment day is the first window carrying its plan (§12.2).
  const windows = mainCountersOf(inputs.counters).flatMap((counter) => inputs.windowsOf(counter.id).map((w) => ({ start: w.start, end: w.end, plan: w.plan })));
  return deriveBillingCycles(rows, windows, { now, price: catalogCyclePrice(catalog, inputs.key.provider), ...(fx ? { fx } : {}) });
}


/**
 * The cycle's identity, its main counter and its plan's calibration identity: a window carrying another plan can change
 * which counter it reads, a catalog alias which windows calibrate it.
 */
const inputsRev = (inputs: AccountInputs, cycle: DerivedCycle) => createHash("sha256")
  .update(`${cycleIdentity(cycle)}|${inputs.mainFor(cycle)?.id ?? ""}|${inputs.planKey(cycle.plan)}`).digest("hex").slice(0, 16);

/**
 * The cycle's capacity from the stored point values of its main counter (step 1 of the reset-capacity plan): each window's
 * share of the cycle and each idle gap in points, at the regime factor of that window (an idle gap at the factor of the
 * window before it), × the value of one point of the cycle's plan at factor 1. Null with the reason as a flag when there
 * is no calibration, no window, or a window of the cycle has no factor. `factor` is the effective (weighted) factor.
 */
function capacityOf(inputs: AccountInputs, cycle: DerivedCycle, usage: CycleUsage | null): { capacity: CycleCapacity | null; flags: string[];
  perPoint: PointCalibration["per_point"] | null } {
  const main = inputs.mainFor(cycle);
  if (!main || !usage || usage.share + usage.idle <= 0) return { capacity: null, flags: [], perPoint: null };
  const rows = inputs.pointValuesOf(main.id);
  const calibration = cyclePointCalibration(rows, cycle, inputs.planKey);
  if (!calibration) return { capacity: null, flags: [], perPoint: null };
  const regime = cycleRegimeFactors(rows, usage.parts ?? [], usage.idleParts ?? []);
  if (regime.factor === null) return { capacity: null, flags: ["capacity_regime_mixed"], perPoint: calibration.per_point };
  const factor = regime.factor;
  const pp = (usage.share + usage.idle) * 100, scale = pp * factor, per = calibration.per_point;
  const tokens = { input: Math.round(per.tokens_input * scale), cached: Math.round(per.tokens_cached * scale), output: Math.round(per.tokens_output * scale), total: 0 };
  tokens.total = tokens.input + tokens.output;
  const flags: string[] = [];
  if (calibration.inside < calibration.windows) flags.push("capacity_borrowed_windows");
  if (calibration.pp < 100) flags.push("capacity_calibration_below_100pp");
  if (calibration.outliers.count) flags.push("capacity_outliers_excluded");
  if (regime.weighted) flags.push("capacity_regime_weighted");
  return { flags, perPoint: per, capacity: { pp, factor, tokens, api_usd: per.api_standard * scale,
    credits: per.credits_low === null || per.credits_high === null ? null : { low: per.credits_low * scale, high: per.credits_high * scale },
    calibration: { counter: main.id, plan: cycle.plan, windows: calibration.windows, inside: calibration.inside, pp: calibration.pp,
      from: calibration.from, until: calibration.until, scope: calibration.scope, outliers: calibration.outliers } } };
}

/**
 * The early resets of the main counter's windows by cause, as far as they fall in the cycle. Boundary contract: a reset's
 * bonus (1 − f windows) is the forward shift of the windows after it, so it belongs to the time between the reset and the
 * window's planned reset; each cycle gets the part of the bonus whose time lies inside it, the same proration as the
 * capacity's windows. `count` is the resets ending inside the cycle, `carried` those ending before it whose bonus time
 * reaches into it. Units: points × the value of one point at factor 1 × the regime factor of the window whose end it is.
 * When the bonuses still exceed the cycle's capacity (time without readings, or bonuses at other regime factors than the
 * cycle's windows), they are scaled down to it (`capped`): both in plain windows (the points) and in factor-weighted
 * windows (the measure the units scale by), with the stricter of the two scales, so the base stays ≥ 0 in points,
 * dollars, tokens and credits alike.
 * Units are null without a capacity.
 */
export function cycleResets(rows: readonly WindowEndCauseRow[], cycle: { start: number; end: number }, perPoint: PointCalibration["per_point"] | null,
  factorOf: (windowStart: string) => number | null = () => 1, capacityWeighted: number | null = null, capacityWindows: number | null = null):
  { resets: BillingCycleResets | null; capped: boolean } {
  if (!rows.length) return { resets: null, capped: false };
  const resets: BillingCycleResets = {};
  const scaled = new Map<string, number>();
  for (const row of rows) {
    const end = Date.parse(row.window_end), planned = Date.parse(row.planned_reset);
    const inside = end >= cycle.start && end < cycle.end;
    const share = planned > end ? Math.max(0, Math.min(planned, cycle.end) - Math.max(end, cycle.start)) / (planned - end) : inside ? 1 : 0;
    if (!inside && !(share > 0 && row.bonus > 0)) continue;
    const entry = resets[row.cause] ??= { count: 0, windows: 0, pp: 0, api_usd: null, tokens: null, credits: null };
    if (inside) entry.count++; else entry.carried = (entry.carried ?? 0) + 1;
    entry.windows += row.bonus * share;
    // The bonus points at the factor of their own window.
    scaled.set(row.cause, (scaled.get(row.cause) ?? 0) + row.bonus * share * 100 * (factorOf(row.window_start) ?? 1));
    if (row.cause === "banked") {
      entry.origins ??= { all_accounts: 0, unknown: 0 };
      if (inside) entry.origins[row.banked_origin === "all_accounts" ? "all_accounts" : "unknown"]++;
    }
  }
  // Bonus windows against the cycle's capacity windows: plain (points) and at the factors of their own windows (units).
  const plain = Object.values(resets).reduce((sum, entry) => sum + entry.windows, 0);
  const weighted = [...scaled.values()].reduce((sum, pp) => sum + pp, 0) / 100;
  const scale = Math.min(1, capacityWindows !== null && plain > capacityWindows + 1e-9 ? capacityWindows / plain : 1,
    capacityWeighted !== null && weighted > capacityWeighted + 1e-9 ? capacityWeighted / weighted : 1);
  const capped = scale < 1;
  for (const [cause, entry] of Object.entries(resets) as Array<[keyof BillingCycleResets, NonNullable<BillingCycleResets[keyof BillingCycleResets]>]>) {
    entry.windows *= scale;
    entry.pp = entry.windows * 100;
    if (!perPoint) continue;
    const pp = (scaled.get(cause) ?? 0) * scale;
    entry.api_usd = pp * perPoint.api_standard;
    const tokens = { input: Math.round(pp * perPoint.tokens_input), cached: Math.round(pp * perPoint.tokens_cached), output: Math.round(pp * perPoint.tokens_output), total: 0 };
    tokens.total = tokens.input + tokens.output;
    entry.tokens = tokens;
    entry.credits = perPoint.credits_low === null || perPoint.credits_high === null ? null : { low: pp * perPoint.credits_low, high: pp * perPoint.credits_high };
  }
  return { resets, capped };
}

/** Unseen traffic needs a visible rise: at least this many points between readings, and under this part of its value. */
const UNSEEN_MIN_PP = 5, UNSEEN_SHARE = 0.1;
/**
 * Windows whose meter rose while this machine stored (almost) none of the traffic behind it were used where it does not
 * see: their usage is unknown, like missing sums, never 0. Only ended windows (an open one's calls may still be on their
 * way): a rise between readings with no stored call, or a rise of at least 5 points whose stored API value is under a
 * tenth of what the cycle's calibrated value of one point (at the window's regime factor) makes of it.
 */
export function withUnseenTraffic<W extends CycleUsageWindow & { usage: unknown; events: number | null; firstPercent: number | null }>(
  windows: readonly W[], perPointUsd: number | null, factorOf: (start: number) => number, now: number): W[] {
  return windows.map((window) => {
    if (window.end > now || window.finalPercent === null || window.apiUsd === null) return window;
    const rise = window.finalPercent - Math.max(window.meterStart ?? 0, window.firstPercent ?? 0);
    const none = window.events === 0 && rise >= 1;
    const tiny = perPointUsd !== null && rise >= UNSEEN_MIN_PP && window.apiUsd < UNSEEN_SHARE * rise * perPointUsd * factorOf(window.start);
    return none || tiny ? { ...window, apiUsd: null, usage: null, trafficUnseen: true } : window;
  });
}

function aggregate(inputs: AccountInputs, cycle: DerivedCycle, now: number): { usage: CycleUsage | null; detail: CycleDetail; capacityFlags: string[] } {
  const flagged: string[] = [];
  const span = { start: cycle.start, end: cycle.end };
  const neighbours = (list: CycleUsageWindow[], nominal: number) =>
    list.filter((w) => w.end > cycle.start - 2 * nominal && w.start < cycle.end + 2 * nominal);
  let usage: CycleUsage | null = null, units: CycleUnits | null = null;
  const main = inputs.mainFor(cycle);
  if (main) {
    const nominal = main.minutes * 60_000;
    const points = inputs.pointValuesOf(main.id), calibration = cyclePointCalibration(points, cycle, inputs.planKey);
    const factorAt = new Map(points.map((row) => [Date.parse(row.window_start), row.regime_factor ?? 1]));
    // Claude's limit also covers traffic this machine never sees (observed_partial_traffic): its cycles stay counted as
    // a lower bound, so the unseen-traffic rule does not apply to it (lead decision 11.10).
    const partial = calibration?.scope === "observed_partial_traffic" || points.some((row) => row.scope === "observed_partial_traffic");
    const neighbouring = neighbours(inputs.windowsOf(main.id), nominal) as AccountWindow[];
    const windows = partial ? neighbouring
      : withUnseenTraffic(neighbouring, calibration?.per_point.api_standard ?? null, (start) => factorAt.get(start) ?? 1, now);
    usage = aggregateCycleUsage(span, windows, nominal, now);
    units = aggregateCycleUnits(span, windows);
  }
  const others = inputs.counters.filter((c) => c.id !== main?.id).flatMap((counter) => {
    const nominal = counter.minutes * 60_000;
    const other = aggregateCycleUsage(span, neighbours(inputs.windowsOf(counter.id), nominal), nominal, now);
    return other.touched ? [{ counter: counter.id, windows: other.share, used_pp: other.usedPp, idle: other.idle }] : [];
  });
  const touched = usage?.touched ?? 0;
  const { capacity, flags: capacityFlags, perPoint } = capacityOf(inputs, cycle, usage);
  const factors = main ? new Map(inputs.pointValuesOf(main.id).map((row) => [row.window_start, row.regime_factor])) : new Map<string, number | null>();
  const resets = main ? cycleResets(inputs.endCausesOf(main.id), cycle, capacity ? perPoint : null,
    (start) => factors.get(start) ?? 1, usage ? (usage.share + usage.idle) * (capacity?.factor ?? 1) : null, usage ? usage.share + usage.idle : null)
    : { resets: null, capped: false };
  if (resets.capped) flagged.push("reset_bonus_capped");
  // Each window's part of the capacity: at its own regime factor against the cycle's weighted windows when there is one.
  const causeOf = main ? new Map(inputs.endCausesOf(main.id).map((row) => [Date.parse(row.window_start), row.cause])) : new Map<number, string>();
  const factorAt = new Map([...factors].map(([start, factor]) => [Date.parse(start), factor]));
  const whole = usage ? (usage.share + usage.idle) * (capacity?.factor ?? 1) : 0;
  const mainWindows: BillingCycleWindow[] | null = usage?.parts ? usage.parts.map((part) => ({
    start: iso(part.start), end: iso(part.end ?? part.start), cause: (causeOf.get(part.start) ?? null) as BillingCycleWindow["cause"],
    used_pp: part.rise ?? null, share: part.share,
    capacity_share: whole > 0 ? part.share * (capacity ? factorAt.get(part.start) ?? 1 : 1) / whole : null })) : null;
  return { usage, capacityFlags: [...capacityFlags, ...flagged], detail: {
    nominal: [iso(cycle.nominalStart), iso(cycle.nominalEnd)], shortened: cycle.shortened,
    run: { from: iso(cycle.run.from), anchor: iso(cycle.run.anchor), until: cycle.run.until === null ? null : iso(cycle.run.until) },
    declared_from: cycle.declaredFrom, early_resets: usage?.earlyResets ?? 0,
    to_date: usage?.toDate ?? null, projection: usage?.projection ?? null, others,
    // Claude's declared weekly schedule before % readings existed: counted and valued, never a %.
    unmetered: touched === 0 && inputs.key.provider === "claude" ? inputs.unmetered("weekly_all", cycle.start, cycle.end) : null,
    capacity, used_units: units,
    // Units of the bonuses only with a capacity: the calibration alone is no capacity (a window without a factor).
    resets: resets.resets,
    banked_granted: inputs.bankedGrants(cycle.start, Math.min(cycle.end, now)),
    main_windows: mainWindows,
    price_usd: cycle.amountUsd, fx: cycle.fx,
  } };
}

/** The stored row of one cycle; without a calibrated capacity `capacity_usd` is null and flagged `capacity_uncalibrated`. */
export function cycleRow(inputs: AccountInputs, cycle: DerivedCycle, now: number): StoredCycleRow {
  const { usage, detail, capacityFlags } = aggregate(inputs, cycle, now);
  const flags = new Set([...(usage?.flags ?? ["no_windows"]), ...capacityFlags]);
  if (cycle.anchorUncertain) flags.add("anchor_uncertain");
  if (cycle.basis === "inferred") flags.add("inferred_from_readings");
  if (cycle.amountMinor === null) flags.add("price_unknown");
  // A payment in another currency whose NBP rate is not stored yet: the rate job fetches it (fx-rates.ts). Without a
  // currency there is nothing to fetch: its own flag, so it never waits for a rate.
  else if (cycle.amountUsd === null) flags.add(cycle.fx ? "fx_rate_missing" : "currency_unknown");
  if (detail.unmetered) flags.add("unmetered_windows");
  if (!detail.capacity) flags.add("capacity_uncalibrated");
  return {
    provider: inputs.key.provider, account: inputs.key.account, start_ts: iso(cycle.start), end_ts: iso(cycle.end), plan: cycle.plan,
    basis: cycle.basis, anchor_uncertain: cycle.anchorUncertain ? 1 : 0, cycle_months: cycle.cycleMonths, amount_minor: cycle.amountMinor,
    currency: cycle.currency, price_source: cycle.priceSource, catalog_usd: cycle.catalogUsd, counter: inputs.mainFor(cycle)?.id ?? null,
    windows_share: usage?.share ?? 0, idle_share: usage?.idle ?? 0, windows_touched: usage?.touched ?? 0, observed_share: usage?.observedShare ?? null,
    used_pp: usage?.usedPp ?? null, api_usd: usage?.apiUsd ?? null, capacity_usd: detail.capacity?.api_usd ?? null, is_current: cycle.current ? 1 : 0,
    flags: JSON.stringify([...flags].sort()), detail: JSON.stringify(detail), inputs_rev: inputsRev(inputs, cycle), computed_at: iso(now),
  };
}

const COLUMNS = ["provider", "account", "start_ts", "end_ts", "plan", "basis", "anchor_uncertain", "cycle_months", "amount_minor", "currency",
  "price_source", "catalog_usd", "counter", "windows_share", "idle_share", "windows_touched", "observed_share", "used_pp", "api_usd",
  "capacity_usd", "is_current", "flags", "detail", "inputs_rev", "computed_at"] as const;

/** Every account's cycles computed from scratch, without writing: the reference the incremental producer must equal. */
export function computeBillingCyclesFull(db: Database, options: { catalog: PlansCatalog; now: number; fx?: FxLookup }): StoredCycleRow[] {
  const plans = loadPeriods(db, PLAN_PERIODS);
  const fx = options.fx ?? storedFxLookup(db);
  return knownAccounts(db, plans).flatMap((key) => {
    const inputs = new AccountInputs(db, key, options.catalog);
    return deriveAccountCycles(plans, inputs, options.catalog, options.now, fx).map((cycle) => cycleRow(inputs, cycle, options.now));
  });
}

// ---------------------------------------------------------------- the producer

interface DirtyEntry { provider: string; account: string; from_ms: number; until_ms: number | null; sequence: number }
let lastDerive = -Infinity;

export interface BillingCycleTurn { progressed: boolean; pending: boolean; accounts: number; cycles: number }

/** One maintenance turn; null on a database without the billing tables. */
export function advanceBillingCycles(db: Database, options: BillingCycleOptions): BillingCycleTurn | null {
  if (!hasBillingCycles(db)) return null;
  const now = options.now ?? Date.now(), started = performance.now(), budget = options.budgetMs ?? 1000;
  const canWrite = options.canWrite ?? (() => true);
  const plans = loadPeriods(db, PLAN_PERIODS);
  const accounts = knownAccounts(db, plans);
  const fx = options.fx ?? storedFxLookup(db);
  const turn: BillingCycleTurn = { progressed: false, pending: false, accounts: 0, cycles: 0 };
  if (!canWrite()) return { ...turn, pending: true };
  queueChanges(db, accounts, now, options.derive === true, plans, options.catalog, fx);
  const entries = db.query("SELECT provider, account, from_ms, until_ms, sequence FROM billing_cycle_dirty ORDER BY provider, account").all() as DirtyEntry[];
  for (const entry of entries) {
    if (performance.now() - started > budget || !canWrite()) { turn.pending = true; break; }
    const targets = entry.account === BILLING_ALL_ACCOUNTS ? accounts.filter((a) => a.provider === entry.provider) : [{ provider: entry.provider, account: entry.account }];
    const writes = targets.map((key) => recompute(db, plans, key, entry, options.catalog, now, fx));
    if (!canWrite()) { turn.pending = true; break; }
    db.transaction(() => {
      for (const write of writes) {
        const remove = db.query("DELETE FROM billing_cycles WHERE provider=? AND account=? AND start_ts=?");
        for (const start of write.removed) remove.run(write.key.provider, write.key.account, start);
        const put = db.query(`INSERT OR REPLACE INTO billing_cycles(${COLUMNS.join(",")}) VALUES(${COLUMNS.map(() => "?").join(",")})`);
        for (const row of write.rows) put.run(...COLUMNS.map((column) => row[column]));
        turn.cycles += write.rows.length;
      }
      db.query("DELETE FROM billing_cycle_dirty WHERE provider=? AND account=? AND sequence=?").run(entry.provider, entry.account, entry.sequence);
    }).immediate();
    turn.accounts += targets.length;
    turn.progressed = true;
  }
  if (!turn.pending) turn.pending = !!db.query("SELECT 1 FROM billing_cycle_dirty LIMIT 1").get();
  return turn;
}

/** The cycles of one account that a dirty entry or a changed derivation names, recomputed; rows of vanished cycles removed. */
function recompute(db: Database, plans: ReturnType<typeof loadPeriods>, key: AccountKey, entry: DirtyEntry, catalog: PlansCatalog, now: number, fx: FxLookup) {
  const inputs = new AccountInputs(db, key, catalog);
  const derived = deriveAccountCycles(plans, inputs, catalog, now, fx);
  const stored = new Map((db.query("SELECT start_ts, inputs_rev FROM billing_cycles WHERE provider=? AND account=?").all(key.provider, key.account) as
    Array<{ start_ts: string; inputs_rev: string }>).map((row) => [row.start_ts, row.inputs_rev]));
  const until = entry.until_ms ?? Infinity;
  const rows = derived.filter((cycle) => stored.get(iso(cycle.start)) !== inputsRev(inputs, cycle) || (cycle.start < until && cycle.end > entry.from_ms))
    .map((cycle) => cycleRow(inputs, cycle, now));
  const kept = new Set(derived.map((cycle) => iso(cycle.start)));
  return { key, rows, removed: [...stored.keys()].filter((start) => !kept.has(start)) };
}

/**
 * Turns what changed since the last turn into dirty entries, in one short transaction: a new rule version (everything),
 * the window marks after the cursor (their accounts and ranges) and, once a minute, every account whose derived cycles
 * differ from the stored ones or whose current cycle is due for a refresh.
 */
function queueChanges(db: Database, accounts: readonly AccountKey[], now: number, force: boolean, plans: ReturnType<typeof loadPeriods>, catalog: PlansCatalog,
  fx: FxLookup): void {
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const meta = (key: string) => (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
  const setMeta = (key: string, value: string) => db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  const hasMarks = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_answer_marks'").get();
  const cursor = Number(meta(MARKS_KEY) ?? 0);
  const marks = hasMarks ? db.query("SELECT seq, provider, account, from_ms, until_ms FROM window_answer_marks WHERE seq > ? ORDER BY seq LIMIT 5000")
    .all(cursor) as Array<{ seq: number; provider: string; account: string; from_ms: number; until_ms: number | null }> : [];
  const folded = hasMarks ? (db.query("SELECT folded FROM window_answer_state WHERE id=1").get() as { folded: number } | null)?.folded ?? 0 : 0;
  const rules = meta(RULES_KEY) !== String(BILLING_CYCLES_VERSION);
  // Marks folded away before this producer saw them: their accounts are unknown, so every account is looked at again.
  const missed = hasMarks && folded > cursor;
  const derive = force || rules || missed || now - lastDerive >= DERIVE_EVERY_MS;
  const changed: Array<[AccountKey, number, number | null]> = [];
  if (derive) {
    lastDerive = now;
    for (const key of accounts) {
      const inputs = new AccountInputs(db, key, catalog);
      const derived = deriveAccountCycles(plans, inputs, catalog, now, fx);
      const stored = db.query("SELECT start_ts, inputs_rev, is_current, computed_at FROM billing_cycles WHERE provider=? AND account=?")
        .all(key.provider, key.account) as Array<{ start_ts: string; inputs_rev: string; is_current: number; computed_at: string }>;
      const byStart = new Map(stored.map((row) => [row.start_ts, row]));
      const differs = derived.filter((cycle) => byStart.get(iso(cycle.start))?.inputs_rev !== inputsRev(inputs, cycle)).map((cycle) => cycle.start);
      const gone = stored.filter((row) => !derived.some((cycle) => iso(cycle.start) === row.start_ts)).map((row) => Date.parse(row.start_ts));
      const due = stored.filter((row) => row.is_current === 1 && now - Date.parse(row.computed_at) >= CURRENT_REFRESH_MS).map((row) => Date.parse(row.start_ts));
      const from = Math.min(...differs, ...gone, ...due);
      if (rules || missed) changed.push([key, BILLING_BEGINNING, null]);
      else if (Number.isFinite(from)) changed.push([key, from, null]);
    }
  }
  if (!marks.length && !changed.length && !rules) return;
  const known = new Set(accounts.map(keyOf));
  db.transaction(() => {
    for (const mark of marks) {
      if (mark.account === ANSWER_SCOPE_NONE) continue;
      for (const key of accounts) {
        if (mark.provider !== "*" && mark.provider !== key.provider) continue;
        if (mark.account !== ANSWER_SCOPE_ALL && mark.account !== key.account) continue;
        if (known.has(keyOf(key))) markBillingCyclesDirty(db, key.provider, key.account, mark.from_ms, mark.until_ms);
      }
    }
    for (const [key, from, until] of changed) markBillingCyclesDirty(db, key.provider, key.account, from, until);
    if (marks.length) setMeta(MARKS_KEY, String(marks.at(-1)!.seq));
    else if (hasMarks && folded > cursor) setMeta(MARKS_KEY, String(folded));
    if (rules) setMeta(RULES_KEY, String(BILLING_CYCLES_VERSION));
  }).immediate();
}

/** Billing producer state the screen read reports as `stale` (never computed there). */
export function billingCyclesStale(db: Database, key: AccountKey, now: number): boolean {
  if (!hasBillingCycles(db)) return true;
  const meta = (name: string) => (db.query("SELECT value FROM meta WHERE key=?").get(name) as { value: string } | null)?.value ?? null;
  if (meta(RULES_KEY) !== String(BILLING_CYCLES_VERSION)) return true;
  if (db.query("SELECT 1 FROM billing_cycle_dirty WHERE provider=? AND account IN (?, '*') LIMIT 1").get(key.provider, key.account)) return true;
  if (db.query("SELECT 1 FROM billing_cycles WHERE provider=? AND account=? AND is_current=1 AND end_ts <= ? LIMIT 1").get(key.provider, key.account, iso(now))) return true;
  const hasMarks = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_answer_marks'").get();
  if (hasMarks && db.query(`SELECT 1 FROM window_answer_marks WHERE seq > ? AND (provider=? OR provider='*') AND (account=? OR account='*') LIMIT 1`)
    .get(Number(meta(MARKS_KEY) ?? 0), key.provider, key.account)) return true;
  // The capacity follows the account's stored point values, the reset bonuses its stored end causes.
  return windowPointValuesStale(db, key.provider, key.account, now) || windowEndCausesStale(db, key.provider, key.account, now);
}

/** Test hook: the next turn derives every account again. */
export function resetBillingCycleClock(): void { lastDerive = -Infinity; }
export { AccountInputs, day as billingDay };
