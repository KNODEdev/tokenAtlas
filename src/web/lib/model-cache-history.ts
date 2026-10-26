import type { CodexWindowCacheTimeline } from "../../shared/codex-window-detail";
import { usageBucket, type UsageGrouping } from "./global-usage";

const HOUR = 3_600_000, DAY = 24 * HOUR;

interface CachePeriod {
  from: number;
  until: number;
  input: number;
  cached: number;
  calls: number;
  percent: number | null;
}

export function modelCacheGrain(timeline: CodexWindowCacheTimeline): "hour" | UsageGrouping {
  const days = (Date.parse(timeline.until) - Date.parse(timeline.from)) / DAY;
  return days <= 1 && timeline.grain !== "day" ? "hour" : days <= 60 ? "day" : days <= 180 ? "week" : "month";
}

export interface CacheTotals { input: number; cached: number }

/** Range totals per model; the unnamed model ("?") is keyed as null like the Models rows. */
export function cacheTotalsByModel(hours: CodexWindowCacheTimeline["hours"]): Map<string | null, CacheTotals> {
  const totals = new Map<string | null, CacheTotals>();
  for (const hour of hours) {
    const key = hour.model === "?" ? null : hour.model, total = totals.get(key) ?? { input: 0, cached: 0 };
    total.input += hour.input; total.cached += hour.cached;
    totals.set(key, total);
  }
  return totals;
}

const AXIS_STEPS =[0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25];

/** Fit the share axis to the observed spread so small swings near 100% stay visible; at least 1 pp is shown. */
export function cacheShareAxis(values: number[]): { min: number; max: number; step: number; ticks: number[] } {
  if (!values.length) return { min: 0, max: 100, step: 25, ticks: [0, 25, 50, 75, 100] };
  const low = Math.min(...values), high = Math.max(...values), span = Math.max(high - low, 1);
  const step = AXIS_STEPS.find(candidate => span / candidate <= 4) ?? 25;
  const snap = (value: number) => Number(value.toFixed(1));
  let min = Math.max(0, snap(Math.floor(low / step) * step)), max = Math.min(100, snap(Math.ceil(high / step) * step));
  if (max - min < 2 * step) { if (max + step <= 100) max = snap(max + step); else min = Math.max(0, snap(min - step)); }
  const ticks: number[] = [];
  for (let index = 0; snap(min + index * step) <= max; index++) ticks.push(snap(min + index * step));
  return { min, max, step, ticks };
}

/** Group the published counters before dividing; a period without input has no percentage. */
export function modelCachePeriods(timeline: CodexWindowCacheTimeline, model: string): CachePeriod[] {
  const from = Date.parse(timeline.from), until = Date.parse(timeline.until);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return [];
  const grain = modelCacheGrain(timeline);
  const bucketOf = (at: number) => grain === "hour" ? Math.floor(at / HOUR) * HOUR
    : Date.parse(usageBucket(new Date(at).toISOString().slice(0, 10), grain));
  const nextBucket = (at: number) => grain === "month" ? Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1)
    : at + (grain === "hour" ? HOUR : grain === "week" ? 7 * DAY : DAY);
  const buckets = new Map<number, CachePeriod>();
  for (let at = bucketOf(from); at < until; at = nextBucket(at)) {
    buckets.set(at, { from: Math.max(from, at), until: Math.min(until, nextBucket(at)), input: 0, cached: 0, calls: 0, percent: null });
  }
  for (const hour of timeline.hours) {
    if (hour.model !== model) continue;
    const at = Date.parse(hour.hour), bucket = buckets.get(bucketOf(at));
    if (!bucket) continue;
    bucket.input += hour.input; bucket.cached += hour.cached; bucket.calls += hour.calls;
  }
  return [...buckets.values()].map(bucket => ({ ...bucket, percent: bucket.input > 0 ? 100 * bucket.cached / bucket.input : null }));
}
