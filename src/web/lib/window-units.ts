import type { CreditFundedSums, WindowAtLimit } from "../../shared/credit-funded";
import type { CoursePoint } from "./window-status";
import type { CreditPoolsOfRange } from "../../shared/credit-pools";
import { codexPoolEvidence, poolUsage, type FundedPoolEvidence } from "../../shared/pool-usage";

/**
 * The Overview window chart in other units (decision 10.10, docs/credit-pools-2026-10-09.md): "%" is the vendor's
 * meter; tokens, API dollars and credits are the account's counted calls from this machine set's logs, cumulative
 * over the window's stored blocks. Nothing is converted: the limit line in a unit is the window's own value when the
 * meter first reached the limit (`at_limit`), or, for a window that has not, value so far ÷ meter percent × 100
 * (an estimate, drawn dashed). Additional pool usage starts at zero in the same plot; cross-unit equivalents use
 * this window's measured mix and remain separate from call funding and native account debits.
 *
 * Points are drawn in the chart's percent space: a unit's limit sits on the 100% line.
 */
export type ChartUnit = "pct" | "tokens" | "usd" | "credits";
export const CHART_UNITS: readonly ChartUnit[] = ["pct", "tokens", "usd", "credits"];

/** One stored block of the window (cycle-breakdown `sessions`): its span and counted sums. */
export interface UnitBlock { start_ts: string; end_ts: string; tokens: number; usd: number; usd_partial?: boolean; credits?: number; credits_partial?: boolean }

export interface UnitSeries {
  unit: ChartUnit;
  /** The counted course in percent space; null in "%" mode (the meter's readings are the course). */
  course: CoursePoint[] | null;
  /** The limit in the unit, whether it is an estimate, and when the meter reached it (percent of the window's span). */
  limit: { value: number; estimate: boolean; t: number | null } | null;
  /** The unit value drawn at 100%. */
  scale: number | null;
  /** Some counted calls had no price in the unit: the line is a lower bound. */
  partial: boolean;
}

export interface UnitInput {
  pools?: CreditPoolsOfRange | null;
  /** Opt-in exact API buckets from the detail companion; absent in the unchanged stored presentation. */
  dailyUsd?: ReadonlyMap<string, { usd: number; usd_partial?: boolean }>;
  startMs: number; spanMs: number;
  /** The window's stored blocks in time order; null while its breakdown loads. */
  blocks: readonly UnitBlock[] | null;
  /** The meter's newest percent of the window (the estimate's divisor). */
  usedPercent: number | null;
  atLimit: WindowAtLimit | null | undefined;
  creditFunded: CreditFundedSums | null | undefined;
  /** Funded calls of another pool (a Claude grant); replaces the Codex reading of `creditFunded` when present. */
  fundedPool?: FundedPoolEvidence | null;
  /** The window's counted tokens (the "%" mode continuation's divisor without `atLimit`). */
  windowTokens: number | null;
  /** Already counted window totals, usable for a conversion while detailed blocks are unavailable. */
  counted?: Omit<UnitBlock, "start_ts" | "end_ts">;
  nowMs?: number;
}

const clampT = (value: number) => Math.max(0, Math.min(100, value));

/** The funded calls the window's chart draws: a stated pool, otherwise Codex credits. */
export const unitPoolEvidence = (input: UnitInput | null | undefined) =>
  input?.fundedPool !== undefined ? input.fundedPool : codexPoolEvidence(input?.creditFunded);

function blockValue(block: UnitBlock, unit: Exclude<ChartUnit, "pct">): { value: number; partial: boolean } {
  if (unit === "tokens") return { value: block.tokens, partial: false };
  if (unit === "usd") return { value: block.usd, partial: !!block.usd_partial };
  return { value: block.credits ?? 0, partial: block.credits === undefined && block.tokens > 0 || !!block.credits_partial };
}
const limitValue = (limit: WindowAtLimit, unit: Exclude<ChartUnit, "pct">) =>
  unit === "tokens" ? limit.tokens : unit === "usd" ? limit.api_standard : limit.credits;
const hourValue = (hour: CreditFundedSums["hours"][number], unit: Exclude<ChartUnit, "pct">) =>
  unit === "tokens" ? hour[2] : unit === "usd" ? hour[4] : hour[3];

export function windowUnitSeries(unit: ChartUnit, input: UnitInput): UnitSeries | null {
  const at = (ms: number) => (ms - input.startMs) / input.spanMs * 100;
  const now = input.nowMs ?? Date.now();
  if (unit === "pct") {
    return { unit, course: null, limit: null, scale: null, partial: false };
  }
  if (!input.blocks) return null;
  let total = 0, partial = false;
  const values: Array<{ t: number; value: number }> = [{ t: 0, value: 0 }];
  for (const block of input.blocks) {
    const start = Date.parse(block.start_ts);
    if (!(start < now)) break;
    const { value, partial: missing } = blockValue(block, unit);
    total += value; partial ||= missing;
    values.push({ t: clampT(at(Math.min(Date.parse(block.end_ts), now))), value: total });
  }
  let limit: UnitSeries["limit"] = null;
  if (input.atLimit) limit = { value: limitValue(input.atLimit, unit), estimate: false, t: clampT(at(Date.parse(input.atLimit.ts))) };
  else if (input.usedPercent != null && input.usedPercent >= 1 && total > 0)
    limit = { value: total / input.usedPercent * 100, estimate: true, t: null };
  if (limit && !(limit.value > 0)) limit = null;
  const scale = limit?.value ?? (total > 0 ? total : null);
  if (scale == null) return { unit, course: values.map(point => ({ t: point.t, pct: 0 })), limit: null, scale: null, partial };
  const course = values.map(point => ({ t: point.t, pct: point.value / scale * 100 }));
  return { unit, course, limit, scale, partial };
}

/** One day of the window chart's bars in the selected unit: counted value and the part paid from credits. */
export interface DayValue { value: number | null; credit: number; partial: boolean }

/**
 * The chart's daily bars in one unit. "%" is the meter's rise over the day (its readings, interpolated);
 * tokens the counted tokens per day; dollars and credits the stored blocks shared by their overlap with the day.
 * The credit part continues above the limit as on the course; null value: no data for that day yet.
 */
export function dailyUnitValues(unit: ChartUnit, days: ReadonlyArray<{ key: string; startMs: number; endMs: number }>,
  input: UnitInput | null, meter: readonly CoursePoint[], tokensByDay: ReadonlyMap<string, number> | null): Map<string, DayValue> {
  const out = new Map<string, DayValue>();
  const evidence = unitPoolEvidence(input);
  const hours = poolUsage(input?.pools, evidence).flatMap(pool => pool.funded?.buckets ?? [])
    .map(bucket => [bucket.from, bucket.calls, bucket.tokens, bucket.native, bucket.apiUsd] as CreditFundedSums["hours"][number]);
  const basis = evidence && input ? fundedPercentBasis(evidence.unit, input) : null;
  const creditOf = (hour: CreditFundedSums["hours"][number]) => unit === "pct"
    ? basis ? (basis.unit === "usd" ? hour[4] : hour[2]) / basis.divisor * 100 : 0 : hourValue(hour, unit);
  const at = (ms: number) => input ? (ms - input.startMs) / input.spanMs * 100 : 0;
  const lastT = meter.at(-1)?.t ?? 0;
  const meterAt = (t: number) => {
    let previous = meter[0] ?? { t: 0, pct: 0 };
    for (const point of meter) {
      if (point.t >= t) return point.t === previous.t ? point.pct : previous.pct + (point.pct - previous.pct) * (t - previous.t) / (point.t - previous.t);
      previous = point;
    }
    return previous.pct;
  };
  const now = input?.nowMs ?? Date.now();
  for (const day of days) {
    const credit = hours.filter(hour => { const ms = Date.parse(hour[0]); return ms >= day.startMs && ms < day.endMs; })
      .reduce((sum, hour) => sum + creditOf(hour), 0);
    let value: number | null = null, partial = false;
    if (unit === "tokens") value = tokensByDay?.get(day.key) ?? null;
    else if (unit === "pct") {
      const from = at(day.startMs), to = Math.min(at(day.endMs), lastT);
      value = input && meter.length > 1 && to > from ? Math.max(0, meterAt(to) - meterAt(Math.max(0, from))) : null;
    } else if (unit === "usd" && input?.dailyUsd) {
      const bucket=input.dailyUsd.get(day.key);
      value=bucket?.usd??null;partial=!!bucket?.usd_partial;
    } else if (input?.blocks) {
      let sum = 0, any = false;
      for (const block of input.blocks) {
        const start = Date.parse(block.start_ts), end = Math.min(Date.parse(block.end_ts), now);
        const overlap = Math.min(end, day.endMs) - Math.max(start, day.startMs);
        if (!(overlap > 0) || !(end > start)) continue;
        const { value: blockTotal, partial: missing } = blockValue(block, unit);
        sum += blockTotal * overlap / (end - start); any = true; partial ||= missing;
      }
      value = any ? sum : null;
    }
    out.set(day.key, { value, credit, partial });
  }
  return out;
}

/** The window's capacity at 100% in one unit, the same value the chart draws on its 100% line. */
export interface UnitCapacity {
  value: number;
  /** Value so far ÷ meter percent × 100; false: counted when the meter first reached the limit. */
  estimate: boolean;
  /** Some counted calls had no price: the value is a lower bound. */
  partial: boolean;
  /** The estimate when the meter reading is off by 1 pp either way; null for a measured limit. */
  range: { low: number; high: number } | null;
}
export function windowCapacity(unit: Exclude<ChartUnit, "pct">, input: UnitInput): UnitCapacity | null {
  const series = windowUnitSeries(unit, input);
  const limit = series?.limit;
  if (!series || !limit) return null;
  if (!limit.estimate) {
    const unpriced = unit === "usd" ? input.atLimit!.api_unpriced : unit === "credits" ? input.atLimit!.credits_unpriced : 0;
    return { value: limit.value, estimate: false, partial: unpriced > 0, range: null };
  }
  // As on the capacity screen: a rise of 2 pp or less gives no estimate, since one rounded pp moves it by half or more.
  const percent = input.usedPercent!;
  if (!(percent > 2)) return null;
  const counted = limit.value * percent / 100;
  return { value: limit.value, estimate: true, partial: series.partial,
    range: { low: counted / (percent + 1) * 100, high: counted / (percent - 1) * 100 } };
}

/** Capacity at 100%, or the counted value ÷ the meter's percent while the stored blocks are unavailable. */
export function capacityOrCounted(unit: Exclude<ChartUnit, "pct">, input: UnitInput): { value: number; partial: boolean } | null {
  const prepared = windowCapacity(unit, input.atLimit ? { ...input, blocks: input.blocks ?? [] } : input);
  if (prepared || !input.counted || !(input.usedPercent != null && input.usedPercent > 2)) return prepared;
  const value = unit === "tokens" ? input.counted.tokens : unit === "usd" ? input.counted.usd : input.counted.credits;
  if (!(value != null && value > 0 && Number.isFinite(value))) return null;
  return { value: value / input.usedPercent * 100,
    partial: unit === "usd" ? !!input.counted.usd_partial : unit === "credits" ? !!input.counted.credits_partial : false };
}

/**
 * The "%" equivalent of funded calls: Codex credits keep the approved token denominator; a dollar pool (a Claude grant)
 * takes the window's API dollars at 100%, the unit its meter is calibrated in, or its tokens at 100% when unpriced calls
 * leave the dollars a lower bound (which cannot establish a rate). Null: no basis.
 */
export function fundedPercentBasis(unit: "credits" | "usd", input: UnitInput): { unit: "tokens" | "usd"; divisor: number } | null {
  if (unit === "usd") {
    const dollars = capacityOrCounted("usd", input);
    if (dollars && !dollars.partial && dollars.value > 0 && Number.isFinite(dollars.value)) return { unit, divisor: dollars.value };
    const tokens = capacityOrCounted("tokens", input);
    return tokens && tokens.value > 0 && Number.isFinite(tokens.value) ? { unit: "tokens", divisor: tokens.value } : null;
  }
  const divisor = input.atLimit?.tokens ?? input.windowTokens;
  return divisor != null && divisor > 0 && Number.isFinite(divisor) ? { unit: "tokens", divisor } : null;
}

/** The unit switch's choice, remembered per viewer; any storage failure falls back to "%". */
const UNIT_KEY = "tokenatlas.window-chart-unit";
export function readChartUnit(): ChartUnit {
  try {
    const stored = globalThis.localStorage?.getItem(UNIT_KEY);
    return CHART_UNITS.includes(stored as ChartUnit) ? stored as ChartUnit : "pct";
  } catch { return "pct"; }
}
export function writeChartUnit(unit: ChartUnit): void {
  try { globalThis.localStorage?.setItem(UNIT_KEY, unit); } catch { /* A private window keeps the choice for this page only. */ }
}
