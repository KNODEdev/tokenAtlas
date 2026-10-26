import type { PoolUsage, PoolUnit } from "../../shared/pool-usage";
import { capacityOrCounted, fundedPercentBasis, windowUnitSeries, type ChartUnit, type UnitInput } from "./window-units";

export interface PoolSeriesPoint { at: string; value: number; since: string }
export interface PoolSeries {
  key: string;
  pool: PoolUsage;
  unit: PoolUnit;
  basis: "observed" | "funded";
  partial: boolean;
  points: PoolSeriesPoint[];
}

export interface WindowPoolSeries extends Omit<PoolSeries, "points"> {
  points: Array<PoolSeriesPoint & { pct: number }>;
  nativeValue: number | null;
  value: number | null;
  estimate: boolean;
  unavailable: "history" | "conversion" | null;
}

/** Presentation equivalence at this window's measured mix; never an attribution of calls to a pool. */
export function windowPoolSeries(pools: readonly PoolUsage[], mode: ChartUnit, input: UnitInput): WindowPoolSeries[] {
  const source = poolSeries(pools, input.startMs);
  for (const pool of pools) {
    if (!source.some(row => row.pool.key === pool.key && row.basis === "observed"))
      source.push({ key: `${pool.key}:observed`, pool, unit: pool.unit, basis: "observed", partial: true, points: [] });
  }
  const target = mode === "pct" ? null : windowUnitSeries(mode, input);
  const scale = mode === "pct" ? 100 : target?.scale ?? null;
  const capacity = (unit: Exclude<ChartUnit, "pct">) => capacityOrCounted(unit, input);
  return source.map(row => {
    const result: WindowPoolSeries = { ...row, points: [], value: null,
      nativeValue: row.points.at(-1)?.value ?? row.pool.observedSpend, estimate: false, unavailable: "history" };
    if (!row.points.length) return result;
    result.unavailable = "conversion";
    if (!(scale != null && scale > 0 && Number.isFinite(scale))) return result;
    if (row.basis === "funded") {
      const funded = row.pool.funded!;
      // The same "%" basis as the daily bars: Codex tokens, a dollar grant's API dollars.
      const basis = mode === "pct" ? fundedPercentBasis(row.unit, input) : null;
      const divisor = mode === "pct" ? basis?.divisor : scale;
      if (!(divisor != null && divisor > 0 && Number.isFinite(divisor))) return result;
      const valueOf = (bucket: typeof funded.buckets[number]) => mode === "pct" ? basis!.unit === "usd" ? bucket.apiUsd : bucket.tokens
        : mode === "tokens" ? bucket.tokens : mode === "usd" ? bucket.apiUsd : bucket.native;
      let value = 0;
      result.points = [{ ...row.points[0]!, value, pct: 0 }];
      for (const bucket of funded.buckets) {
        const before = mode === "pct" ? value / divisor * 100 : value;
        result.points.push({ at: bucket.from, since: bucket.from, value: before, pct: before / scale * 100 });
        value += valueOf(bucket);
        const after = mode === "pct" ? value / divisor * 100 : value;
        result.points.push({ at: bucket.until, since: bucket.from, value: after, pct: after / scale * 100 });
      }
      result.estimate = mode === "pct";
      result.partial = mode === "usd" ? funded.apiUnpriced > 0 : mode === "credits" ? funded.nativeUnpriced > 0
        : mode === "pct" && basis!.unit === "usd" ? funded.apiUnpriced > 0 : false;
    } else {
      const native = capacity(row.unit);
      const direct = mode === row.unit;
      // A lower-bound denominator cannot establish a conversion rate.
      if (!direct && (!native || native.partial || !(native.value > 0))) return result;
      const factor = direct ? 1 : scale / native!.value;
      result.estimate = !direct;
      result.partial ||= !!target?.partial;
      result.points = row.points.map(point => ({ ...point, value: point.value * factor, pct: point.value * factor / scale * 100 }));
    }
    result.value = result.points.at(-1)?.value ?? null;
    result.unavailable = null;
    return result;
  });
}

/** Explicit grant/purchase debits, assigned to their later observation. Balance-only pools keep ledger-backed bars. */
export function observedPoolDays(rows: readonly WindowPoolSeries[], days: readonly { key: string; startMs: number; endMs: number }[]) {
  const out = new Map<string, { value: number; estimate: boolean; partial: boolean }>();
  for (const day of days) {
    let value = 0, estimate = false, partial = false;
    for (const row of rows) {
      if (row.basis !== "observed" || row.pool.funded || !["grant", "purchase"].includes(row.pool.kind ?? "")) continue;
      for (let i = 1; i < row.points.length; i++) {
        const point = row.points[i]!, delta = point.value - row.points[i - 1]!.value;
        const time = Date.parse(point.at);
        if (time >= day.startMs && time < day.endMs && delta > 0) {
          value += delta; estimate ||= row.estimate; partial ||= row.partial;
        }
      }
    }
    if (value > 0) out.set(day.key, { value, estimate, partial });
  }
  return out;
}

/** Native pool units only. Valued funded traffic never fills a missing account reading. */
export function poolSeries(pools: readonly PoolUsage[], startMs: number): PoolSeries[] {
  const out: PoolSeries[] = [];
  for (const pool of pools) {
    const timeline = pool.timeline;
    if (timeline) {
      let value = 0;
      const baseline = new Date(Math.max(startMs, Date.parse(timeline.baseline_at))).toISOString();
      const points: PoolSeriesPoint[] = [{ at: baseline, value, since: timeline.baseline_at }];
      for (const movement of timeline.movements) {
        if (!(movement.spent > 0)) continue;
        points.push({ at: movement.observed_at, value, since: movement.since });
        value += movement.spent;
        points.push({ at: movement.observed_at, value: Math.round(value * 1e9) / 1e9, since: movement.since });
      }
      if (timeline.through !== points.at(-1)!.at)
        points.push({ at: timeline.through, value: Math.round(value * 1e9) / 1e9, since: points.at(-1)!.at });
      out.push({ key: `${pool.key}:observed`, pool, unit: pool.unit, basis: "observed", partial: !timeline.opening_known || !timeline.complete, points });
    }
    const funded = pool.funded;
    if (funded?.buckets.length) {
      let value = 0;
      const points: PoolSeriesPoint[] = [{ at: new Date(startMs).toISOString(), value, since: new Date(startMs).toISOString() }];
      for (const bucket of funded.buckets) {
        points.push({ at: bucket.from, value, since: bucket.from });
        value += bucket.native;
        points.push({ at: bucket.until, value, since: bucket.from });
      }
      out.push({ key: `${pool.key}:funded`, pool, unit: funded.unit, basis: "funded", partial: funded.nativeUnpriced > 0, points });
    }
  }
  return out;
}
