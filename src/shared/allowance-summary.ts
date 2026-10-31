import type { CodexComparisonWindow as Window } from "./codex-accounting";
import { claudeShareNeverReported } from "./claude-code-capacity";
import { claudeCodeCapacityForWindow } from "./claude-capacity-result";
import { BEFORE_AFTER_MIN_PP, WEEKLY_MINUTES, capacityFull, capacityIsLowerBound, median } from "./capacity-value";

/**
 * What one allowance buys, month by month and by dominant model (UR-014, REQ-059). Pure: it reads stored capacity
 * cycles of one (account, counter) and the instant `asOf`, and computes nothing the Capacity screen would compute
 * differently: every value is `capacityFull(window, unit, "observed")`.
 */

export type AllowanceUnit = "api_standard" | "tokens";
export const ALLOWANCE_UNITS: readonly AllowanceUnit[] = ["api_standard", "tokens"];
/** A model carrying at least this share of a cycle's API Standard value is its dominant model (UR-014 D5). */
export const DOMINANT_SHARE = 0.7;

export interface AllowanceStats {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
  /** A counted value is a lower bound (some traffic unpriced); never set for tokens. */
  lower_bound: boolean;
}
export interface AllowanceMonth {
  /** UTC calendar month of the cycle start, YYYY-MM. */
  month: string;
  api_standard: AllowanceStats;
  tokens: AllowanceStats;
  /** Distinct plan labels of the counted cycles in time order; more than one means the plan changed. */
  plans: string[];
  /** Ids of the counted cycles, so a reader can check parity against another view. */
  cycles: string[];
}
export interface AllowancePartial {
  id: string;
  cycle_start: string;
  observed_pp: number;
  api_standard: number | null;
  tokens: number | null;
  lower_bound: boolean;
}
export interface AllowanceModelGroup {
  model: string;
  n: number;
  cycles: string[];
  api_standard: AllowanceStats;
  tokens: AllowanceStats;
  /** Σ sample API Standard ÷ Σ sample priced tokens × 1e6 over the group's cycles; null without priced tokens. */
  usd_per_million: number | null;
  lower_bound: boolean;
  thin: boolean;
}
export type CapacityExclusion = "not_weekly" | "below_min_pp" | "mixed_plan" | "plan_meter_mismatch" | "no_value";
export type DominanceExclusion = "below_threshold" | "unpriced" | "share_sample" | "no_api_value";
export interface AllowanceSummary {
  months: AllowanceMonth[];
  partial: AllowancePartial | null;
  models: AllowanceModelGroup[];
  /** Closed cycles starting in range. */
  closed: number;
  /** Capacity ledger: eligible + Σ excluded = closed. */
  eligible: number;
  excluded: Partial<Record<CapacityExclusion, number>>;
  /** Dominance ledger: Σ group n + Σ dominance_excluded = eligible. */
  dominance_excluded: Partial<Record<DominanceExclusion, number>>;
  /** Eligible cycles that stay counted but deserve a disclosure. */
  notes: { uncertain_end: number; manual: number };
}
export interface AllowanceRatio { month: string; ratio: number | null; min_n: number; approximate: boolean; a: number | null; b: number | null }

const DAY_MS = 86_400_000;
const startOf = (window: Window) => window.cycle_start ?? window.start;
const endOf = (window: Window) => window.cycle_end ?? window.reset;
const planOf = (window: Window) => window.plan_detail?.label || window.plan || "?";
const count = <K extends string>(ledger: Partial<Record<K, number>>, key: K) => { ledger[key] = (ledger[key] ?? 0) + 1; };

function stats(values: readonly number[], lowerBound = false): AllowanceStats {
  return values.length ? { n: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values), lower_bound: lowerBound }
    : { n: 0, median: null, min: null, max: null, lower_bound: false };
}

interface Valued { window: Window; usd: number | null; tokens: number | null; lowerBound: boolean }
function statsOf(cycles: readonly Valued[], unit: AllowanceUnit): AllowanceStats {
  const counted = cycles.filter(cycle => (unit === "tokens" ? cycle.tokens : cycle.usd) !== null);
  return stats(counted.map(cycle => (unit === "tokens" ? cycle.tokens : cycle.usd)!), unit === "api_standard" && counted.some(cycle => cycle.lowerBound));
}

interface Sample { models: Array<{ name: string; api: number }>; api: number; pricedTokens: number; unpriced: boolean }
/** The traffic the cycle's value was computed on, or why its model mix cannot be told. */
function sampleOf(window: Window): Sample | DominanceExclusion {
  const prepared = window.claude_capacity;
  if (prepared && prepared.account === window.account.toLowerCase() && prepared.window_id === window.id
    && prepared.window_minutes === (window.window_minutes ?? WEEKLY_MINUTES)) {
    if (prepared.api_value_basis !== "standard") return "share_sample";
    const models = prepared.models.map(model => ({ name: model.model, api: model.window.usd }));
    return { models, api: models.reduce((sum, model) => sum + model.api, 0),
      pricedTokens: prepared.models.reduce((sum, model) => sum + model.window.gross, 0),
      unpriced: prepared.models.some(model => model.window.unpriced_calls > 0) };
  }
  // The legacy Claude Code share has its own sample; using it for the model mix is deferred (UR-014), so stay out.
  if (claudeCodeCapacityForWindow(window) !== undefined && !claudeShareNeverReported(window)) return "share_sample";
  const models = window.models.map(model => ({ name: model.name, api: model.api_standard }));
  return { models, api: models.reduce((sum, model) => sum + model.api, 0), pricedTokens: window.usage.priced_tokens,
    unpriced: window.usage.unpriced_events > 0 };
}

/**
 * One subscription counter's allowance summary. `since`/`until` (YYYY-MM-DD, inclusive) select cycles by their start;
 * the open cycle is reported only when the range holds the day of `asOf`.
 */
export function summarizeAllowance(windows: readonly Window[], options: { asOf: string; since?: string; until?: string }): AllowanceSummary {
  const asOf = Date.parse(options.asOf);
  const from = options.since ? Date.parse(`${options.since}T00:00:00Z`) : -Infinity;
  const to = options.until ? Date.parse(`${options.until}T00:00:00Z`) + DAY_MS : Infinity;
  const inRange = (ms: number) => ms >= from && ms < to;
  const unique = [...new Map(windows.map(window => [window.id, window])).values()]
    .filter(window => Number.isFinite(Date.parse(startOf(window))))
    .sort((a, b) => Date.parse(startOf(a)) - Date.parse(startOf(b)));

  const excluded: AllowanceSummary["excluded"] = {}, dominanceExcluded: AllowanceSummary["dominance_excluded"] = {};
  const notes = { uncertain_end: 0, manual: 0 };
  const eligible: Valued[] = [];
  let closed = 0, partial: AllowancePartial | null = null;
  for (const window of unique) {
    const start = Date.parse(startOf(window)), end = Date.parse(endOf(window));
    const weekly = (window.window_minutes ?? WEEKLY_MINUTES) === WEEKLY_MINUTES;
    if (Number.isFinite(end) && end > asOf) {
      // The open cycle: never in a median or a ratio.
      const day = Date.parse(`${options.asOf.slice(0, 10)}T00:00:00Z`);
      if (weekly && start <= asOf && inRange(day) && window.observed_pp > 1 && (!partial || start > Date.parse(partial.cycle_start)))
        partial = { id: window.id, cycle_start: startOf(window), observed_pp: window.observed_pp,
          api_standard: capacityFull(window, "api_standard"), tokens: capacityFull(window, "tokens"),
          lower_bound: capacityIsLowerBound(window, "api_standard") };
      continue;
    }
    if (!inRange(start)) continue;
    closed++;
    if (!weekly) { count(excluded, "not_weekly"); continue; }
    if (!(window.observed_pp >= BEFORE_AFTER_MIN_PP)) { count(excluded, "below_min_pp"); continue; }
    if (window.plan_detail?.status === "mixed") { count(excluded, "mixed_plan"); continue; }
    if (window.declared_plan_meter_mismatch) { count(excluded, "plan_meter_mismatch"); continue; }
    const usd = capacityFull(window, "api_standard"), tokens = capacityFull(window, "tokens");
    if (usd === null && tokens === null) { count(excluded, "no_value"); continue; }
    if (window.cycle_end_basis === "uncertain") notes.uncertain_end++;
    if (window.manual_measurement || window.manual_measurements?.length) notes.manual++;
    eligible.push({ window, usd, tokens, lowerBound: usd !== null && capacityIsLowerBound(window, "api_standard") });
  }

  const byMonth = new Map<string, Valued[]>();
  for (const cycle of eligible) {
    const month = new Date(Date.parse(startOf(cycle.window))).toISOString().slice(0, 7);
    byMonth.set(month, [...byMonth.get(month) ?? [], cycle]);
  }
  const months = [...byMonth].map(([month, cycles]): AllowanceMonth => ({ month,
    api_standard: statsOf(cycles, "api_standard"), tokens: statsOf(cycles, "tokens"),
    plans: [...new Set(cycles.map(cycle => planOf(cycle.window)))], cycles: cycles.map(cycle => cycle.window.id) }));

  const groups = new Map<string, Array<Valued & { sample: Sample }>>();
  for (const cycle of eligible) {
    const sample = sampleOf(cycle.window);
    if (typeof sample === "string") { count(dominanceExcluded, sample); continue; }
    if (!(sample.api > 0)) { count(dominanceExcluded, "no_api_value"); continue; }
    if (sample.unpriced) { count(dominanceExcluded, "unpriced"); continue; }
    const top = sample.models.reduce<Sample["models"][number] | null>((best, model) => !best || model.api > best.api ? model : best, null);
    if (!top || top.api / sample.api < DOMINANT_SHARE) { count(dominanceExcluded, "below_threshold"); continue; }
    groups.set(top.name, [...groups.get(top.name) ?? [], { ...cycle, sample }]);
  }
  const models = [...groups].map(([model, cycles]): AllowanceModelGroup => {
    const priced = cycles.reduce((sum, cycle) => sum + cycle.sample.pricedTokens, 0);
    const api = cycles.reduce((sum, cycle) => sum + cycle.sample.api, 0);
    const usd = statsOf(cycles, "api_standard");
    return { model, n: cycles.length, cycles: cycles.map(cycle => cycle.window.id), api_standard: usd, tokens: statsOf(cycles, "tokens"),
      usd_per_million: priced > 0 ? api / priced * 1e6 : null, lower_bound: usd.lower_bound, thin: cycles.length < 2 };
  }).sort((a, b) => (b.tokens.median ?? -1) - (a.tokens.median ?? -1) || a.model.localeCompare(b.model));

  return { months, partial, models, closed, eligible: eligible.length, excluded, dominance_excluded: dominanceExcluded, notes };
}

/** B ÷ A per month present on both sides in one unit; a non-positive A or a missing side gives no ratio. */
export function allowanceRatios(a: AllowanceSummary, b: AllowanceSummary, unit: AllowanceUnit): AllowanceRatio[] {
  const other = new Map(b.months.map(month => [month.month, month[unit]]));
  return a.months.flatMap(month => {
    const left = month[unit], right = other.get(month.month);
    if (!right) return [];
    const ratio = left.median !== null && right.median !== null && left.median > 0 ? right.median / left.median : null;
    // A quotient of two lower bounds has no bound direction, so it is only approximate.
    return [{ month: month.month, ratio, min_n: Math.min(left.n, right.n), approximate: left.lower_bound || right.lower_bound,
      a: left.median, b: right.median }];
  });
}

/** The latest month whose ratio rests on at least two cycles on each side and no lower bound. */
export function allowanceHeadline(ratios: readonly AllowanceRatio[]): AllowanceRatio | null {
  return [...ratios].reverse().find(ratio => ratio.ratio !== null && ratio.min_n >= 2 && !ratio.approximate) ?? null;
}
