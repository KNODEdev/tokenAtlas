import type { ProbeLimitWindow } from "./probe-limit-windows";
import { preparedPointBasis, type CurrentPointBasis } from "../shared/current-point-basis";
import { comparisonWindow, unpricedModels } from "./window-usage-presentation";
import { type WindowSums } from "./window-usage-contracts";
import type { UnpricedModel } from "../shared/missing-rate";
import { usageCycleClock } from "./data-clock";
import { CODEX_RESERVE_MODEL } from "./codex-window-comparison";
import type { CreditPoolsOfRange } from "../shared/credit-pools";
import { matchingContextPrice, storedContextPrice, type ContextPrice } from "../shared/context-price";
import { type CreditFundedSums, type WindowAtLimit,
  type WindowCreditSums } from "../shared/credit-funded";

/**
 * The Codex cycles of Overview and the account cards (/api/usage-series, /api/roster), composed from
 * stored rows: the windows of `limit_windows` and their sums in `window_usage`. A cycle is a stored
 * window with its whole-cycle sums, whatever range a screen shows; nothing here reads events.
 */
export interface CycleTokens { in: number; cached_in: number; cache_write: number; out: number; reasoning: number; total: number }
export interface CycleUsageRow { name: string; calls: number; tokens: number; fresh: number; usd: number }
export interface UsageCycleReserve {
  peak_percent: number | null; first_ts: string | null; peak_ts: string | null; resets_at_iso: string | null;
  calls: number; usd: number; tokens: CycleTokens;
}
export interface UsageCycleOut {
  point_basis: CurrentPointBasis | null;
  /** Whole-cycle jointly priced split; rail dollars and their estimates use its ratio (API-only calls may differ). */
  context_price?: ContextPrice;
  /** Running split at exactly at_limit.ts. */
  at_limit_context_price?: ContextPrice;
  index: number; limit_id: string | null; label: string; anchor: number | null; resets_at_iso: string | null;
  window_start_iso: string | null; is_active: boolean; shadow: boolean; status: string; start_ts: string; end_ts: string;
  work_from_ts: string; work_to_ts: string; sample_count: number; lag_fraction: number; distinct_steps: number;
  first_percent: number; peak_percent: number; end_percent: number; hit_100: boolean; window_hours: number;
  elapsed_hours: number; observed_hours: number; remaining_hours: number | null; pace_percent_per_day: number;
  projected_end_percent: number | null; eta_100_iso: string | null; calls: number; usd: number;
  usd_per_percent: number | null; usd_at_100_percent: number | null; tokens: CycleTokens; top_model: string | null;
  source_models: Array<{ model: string; calls: number }>; model_usage: CycleUsageRow[]; surface_usage: CycleUsageRow[];
  plan_types: string[]; limit_names: string[]; delta_peak_percent: number | null; delta_usd: number | null;
  delta_calls: number | null; pct_of_prev_peak: number | null; pct_of_prev_usd: number | null;
  /** Present only for a window with reserve use, so other windows keep their response unchanged. */
  reserve?: UsageCycleReserve;
  /** Counted tokens without an API price, per model; present only when some exist (same reason as `reserve`). */
  unpriced_models?: UnpricedModel[];
  /** Credit pools at the window's newest pool reading and their movement in it; present only for a window that has them. */
  credit_pools?: CreditPoolsOfRange;
  /** Standard credits of the counted calls; absent in rows stored before the Codex units rule. */
  credits?: WindowCreditSums;
  /** Counted sums at the first reading at the limit (the window's capacity in each unit); absent below the limit. */
  at_limit?: WindowAtLimit;
  /** Calls paid from credits in this window; present only when there are some. */
  credit_funded?: CreditFundedSums;
}
/** Readings of the reserve pool under one reset anchor (seconds). */
export interface ReservePool { anchor: number | null; start_ts: string; peak_ts: string; peak_percent: number }
export type StoredCycleSums = Pick<WindowSums, "cycle" | "rail"> & Partial<Pick<WindowSums, "readings">>;

const HOUR = 3_600_000;
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const emptyTokens = (): CycleTokens => ({ in: 0, cached_in: 0, cache_write: 0, out: 0, reasoning: 0, total: 0 });

/** Whole cents of the rows add up to the rounded total (largest remainders first); at most 30 rows. */
function centRows(rows: CycleUsageRow[], total: number): CycleUsageRow[] {
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  const exact = sorted.map(row => row.usd * 100), cents = exact.map(value => Math.floor(value));
  let rest = Math.round(total * 100) - cents.reduce((sum, value) => sum + value, 0);
  for (const { index } of exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction)) {
    if (rest <= 0) break;
    cents[index]! += 1; rest--;
  }
  return sorted.map((row, index) => ({ ...row, usd: cents[index]! / 100 })).slice(0, 30);
}

/** Calls, tokens and API Standard of the given model rows. */
function workOf(rows: StoredCycleSums["rail"]["by_model"]) {
  const tokens = emptyTokens();
  let calls = 0, usd = 0;
  for (const row of rows) {
    calls += row.calls; usd += row.api_standard;
    tokens.in += row.input; tokens.cached_in += row.cached; tokens.cache_write += row.cache_write;
    tokens.out += row.output; tokens.reasoning += row.reasoning;
  }
  tokens.total = tokens.in + tokens.out;
  return { calls, usd, tokens };
}

/** Readings in time order with the meter quality the gauge calibration uses. */
function readingFacts(window: ProbeLimitWindow) {
  const readings = [...window.readings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  let max = -Infinity, lagged = 0;
  const steps = new Set<number>();
  for (const reading of readings) {
    if (reading.percent < max) lagged++; else max = reading.percent;
    steps.add(Math.round(reading.percent));
  }
  return { readings, lag_fraction: readings.length ? round2(lagged / readings.length) : 0, distinct_steps: steps.size };
}

/**
 * The cycles of the given stored windows (chronological), with their stored sums. A reserve pool joins
 * the latest window opened before its first reading; pools that reset inside one window add up.
 */
export function codexCycles(windows: readonly ProbeLimitWindow[], sums: ReadonlyMap<string, StoredCycleSums>, nowMs: number,
  reservePools: readonly ReservePool[] = [], creditPools: ReadonlyMap<string, CreditPoolsOfRange> = new Map()): UsageCycleOut[] {
  const openReset = Math.max(-Infinity, ...windows.map(window => Date.parse(window.reset)).filter(reset => reset > nowMs));
  const reserves = new Map<number, ReservePool>();
  for (const pool of reservePools.filter(pool => pool.peak_percent > 0)) {
    let owner = -1;
    windows.forEach((window, index) => { if (window.start <= pool.start_ts) owner = index; });
    if (owner < 0) continue;
    const joined = reserves.get(owner);
    reserves.set(owner, joined ? { anchor: pool.anchor, start_ts: joined.start_ts, peak_ts: pool.peak_ts,
      peak_percent: joined.peak_percent + pool.peak_percent } : pool);
  }
  const out: UsageCycleOut[] = [];
  windows.forEach((window, index) => {
    const stored = sums.get(window.id)!;
    const { readings, lag_fraction, distinct_steps } = readingFacts(window);
    const first = readings[0]!, last = readings.at(-1)!;
    const peak = Math.max(...readings.map(reading => reading.percent));
    const anchor = Math.floor(Date.parse(window.reset) / 1000);
    const counted = stored.rail.by_model.filter(row => row.excluded === null);
    const work = workOf(counted);
    const models = counted.map(row => ({ name: row.model ?? "?", calls: row.calls, tokens: row.input + row.output,
      fresh: row.input + row.output - row.cached, usd: row.api_standard }));
    const top = [...counted].filter(row => row.model !== null).sort((a, b) => b.calls - a.calls || a.model!.localeCompare(b.model!))[0];
    const base = { window_start_iso: window.start, start_ts: first.ts, work_to_ts: window.end, anchor, peak_percent: peak,
      hit_100: readings.some(reading => reading.percent >= 99.5) };
    const isActive = Math.abs(Date.parse(window.reset) - openReset) <= 5 * 60_000;
    const pool = reserves.get(index);
    const reserveRows = stored.rail.by_model.filter(row => row.excluded === "funding" && row.model === CODEX_RESERVE_MODEL);
    const reserveWork = workOf(reserveRows);
    const unpriced = unpricedModels(stored.rail.by_model);
    const row: UsageCycleOut = {
      point_basis: preparedPointBasis(comparisonWindow(window, stored.cycle)),
      context_price: stored.cycle.cycle_usage && storedContextPrice(stored.cycle.cycle_usage),
      at_limit_context_price: stored.rail.at_limit && (() => {
        const usage = stored.readings?.find(reading => reading.ts === stored.rail.at_limit!.ts)?.usage;
        return usage && matchingContextPrice(storedContextPrice(usage), stored.rail.at_limit.api_standard);
      })() || undefined,
      index, limit_id: "codex", label: window.start.slice(0, 10), anchor, resets_at_iso: new Date(anchor * 1000).toISOString(),
      window_start_iso: window.start, ...usageCycleClock(base, isActive, nowMs), shadow: false,
      start_ts: first.ts, end_ts: last.ts, work_from_ts: window.start, work_to_ts: window.end,
      sample_count: readings.length, lag_fraction, distinct_steps,
      first_percent: round2(first.percent), peak_percent: round2(peak), end_percent: round2(last.percent), hit_100: base.hit_100,
      window_hours: round2(window.window_minutes / 60), observed_hours: round2((Date.parse(last.ts) - Date.parse(first.ts)) / HOUR),
      calls: work.calls, usd: round2(work.usd),
      usd_per_percent: peak > 0 ? round2(work.usd / peak) : null, usd_at_100_percent: peak >= 20 ? round2(work.usd / peak * 100) : null,
      tokens: work.tokens, top_model: top?.model ?? null,
      source_models: [...counted].filter(model => model.model !== null).sort((a, b) => b.calls - a.calls || a.model!.localeCompare(b.model!))
        .slice(0, 3).map(model => ({ model: model.model!, calls: model.calls })),
      model_usage: centRows(models, work.usd),
      surface_usage: centRows(stored.rail.by_surface.map(surface => ({ name: surface.surface ?? "?", calls: surface.calls,
        tokens: surface.tokens, fresh: surface.fresh, usd: surface.api_standard })), work.usd),
      plan_types: window.plan ? [window.plan] : [], limit_names: [],
      delta_peak_percent: null, delta_usd: null, delta_calls: null, pct_of_prev_peak: null, pct_of_prev_usd: null,
      ...(pool || reserveWork.calls ? { reserve: { peak_percent: pool ? round2(pool.peak_percent) : null, first_ts: pool?.start_ts ?? null,
        peak_ts: pool?.peak_ts ?? null, resets_at_iso: pool?.anchor != null ? new Date(pool.anchor * 1000).toISOString() : null,
        calls: reserveWork.calls, usd: round2(reserveWork.usd), tokens: reserveWork.tokens } } : {}),
      ...(unpriced.length ? { unpriced_models: unpriced } : {}),
      ...(creditPools.has(window.id) ? { credit_pools: creditPools.get(window.id)! } : {}),
      ...(stored.rail.credits ? { credits: stored.rail.credits } : {}),
      ...(stored.rail.at_limit ? { at_limit: stored.rail.at_limit } : {}),
      ...(stored.rail.credit_funded ? { credit_funded: stored.rail.credit_funded } : {}),
    };
    const previous = out.at(-1);
    if (previous) {
      row.delta_peak_percent = round2(row.peak_percent - previous.peak_percent);
      row.delta_usd = round2(row.usd - previous.usd);
      row.delta_calls = row.calls - previous.calls;
      row.pct_of_prev_peak = previous.peak_percent > 0 ? round2(row.peak_percent / previous.peak_percent * 100) : null;
      row.pct_of_prev_usd = previous.usd > 0 ? round2(row.usd / previous.usd * 100) : null;
    }
    out.push(row);
  });
  return out;
}

/**
 * The chart parts of the cycles: meter points bucketed over the whole span (cycles shorter than three
 * buckets get their own finer buckets), the stored activity curves and traffic per machine.
 */
export function codexCycleCharts(windows: readonly ProbeLimitWindow[], sums: ReadonlyMap<string, StoredCycleSums>, maxPoints: number,
  machineOf: (home: string, ts: string) => string | null) {
  const readings = windows.flatMap((window, cycle) => window.readings.map(reading => ({ ...reading, cycle })))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const firstMs = Date.parse(readings[0]!.ts), lastMs = Date.parse(readings.at(-1)!.ts);
  const bucketMs = Math.max(60_000, Math.ceil(Math.max(60_000, lastMs - firstMs) / maxPoints / 60_000) * 60_000);
  const buckets = new Map<string, { cycle: number; startMs: number; ts_last: string; percent: number; percent_min: number; percent_last: number; samples: number }>();
  const local = windows.map(window => {
    const ordered = [...window.readings].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const start = Date.parse(ordered[0]!.ts), observed = Date.parse(ordered.at(-1)!.ts) - start;
    return observed < bucketMs * 3 ? { start, size: Math.min(bucketMs, Math.max(1, Math.ceil(observed / 32))) } : null;
  });
  for (const reading of readings) {
    const ms = Date.parse(reading.ts), refined = local[reading.cycle];
    const startMs = refined ? refined.start + Math.floor((ms - refined.start) / refined.size) * refined.size : Math.floor(ms / bucketMs) * bucketMs;
    const key = `${reading.cycle}:${startMs}`;
    const bucket = buckets.get(key) ?? { cycle: reading.cycle, startMs, ts_last: reading.ts, percent: reading.percent,
      percent_min: reading.percent, percent_last: reading.percent, samples: 0 };
    bucket.samples++;
    bucket.percent = Math.max(bucket.percent, reading.percent); bucket.percent_min = Math.min(bucket.percent_min, reading.percent);
    if (reading.ts >= bucket.ts_last) { bucket.ts_last = reading.ts; bucket.percent_last = reading.percent; }
    buckets.set(key, bucket);
  }
  const points = [...buckets.values()].sort((a, b) => a.startMs - b.startMs || a.cycle - b.cycle).map(bucket => {
    const window = windows[bucket.cycle]!, start = Date.parse(window.start), span = window.window_minutes * 60_000;
    return { ts: new Date(bucket.startMs).toISOString(), ts_last: bucket.ts_last, cycle: bucket.cycle, percent: round2(bucket.percent),
      percent_min: round2(bucket.percent_min), percent_last: round2(bucket.percent_last), samples: bucket.samples,
      cycle_progress: round2(Math.max(0, Math.min(100, (bucket.startMs - start) / span * 100))) };
  });
  const activity = windows.flatMap((window, cycle) => sums.get(window.id)!.rail.activity.map(point => ({ cycle, t: point.t, amount: point.amount })));
  const traffic = windows.flatMap((window, cycle) => {
    const machines = new Map<string, { cycle: number; machine: string | null; amount: number }>();
    for (const source of sums.get(window.id)!.cycle.evidence.sources) {
      const machine = machineOf(source.name, source.first), key = machine?.toLowerCase() ?? "";
      const row = machines.get(key) ?? { cycle, machine, amount: 0 };
      row.amount += source.tokens; machines.set(key, row);
    }
    return [...machines.values()].filter(row => row.amount > 0).sort((a, b) => b.amount - a.amount);
  });
  return { readings, bucket_minutes: Math.round(bucketMs / 60_000), points, activity, traffic };
}

/** Summary of the cycles; the span is all traffic of the listed cycles, the unattributed part what they left out. */
export function codexCycleStats(cycles: readonly UsageCycleOut[], windows: readonly ProbeLimitWindow[], sums: ReadonlyMap<string, StoredCycleSums>) {
  const closed = cycles.filter(cycle => !cycle.is_active), peaks = closed.map(cycle => cycle.peak_percent).sort((a, b) => a - b);
  const mid = Math.floor(peaks.length / 2);
  const rows = windows.flatMap(window => sums.get(window.id)!.rail.by_model);
  const span = workOf(rows), left = workOf(rows.filter(row => row.excluded !== null));
  const unpriced: { tokens: number; models: Record<string, number> } = { tokens: 0, models: {} };
  for (const row of rows) if (row.unpriced_tokens && (row.excluded === null || row.model === CODEX_RESERVE_MODEL)) {
    unpriced.tokens += row.unpriced_tokens; unpriced.models[row.model ?? "?"] = (unpriced.models[row.model ?? "?"] ?? 0) + row.unpriced_tokens;
  }
  return { stats: {
    raw_cycle_count: cycles.length, cycle_count: cycles.length, shadow_cycle_count: 0, closed_cycle_count: closed.length,
    spent_cycle_count: cycles.filter(cycle => cycle.hit_100).length,
    median_closed_peak_percent: peaks.length ? peaks.length % 2 ? peaks[mid]! : round2((peaks[mid - 1]! + peaks[mid]!) / 2) : null,
    avg_closed_peak_percent: closed.length ? round2(closed.reduce((sum, cycle) => sum + cycle.peak_percent, 0) / closed.length) : null,
    avg_closed_usd: closed.length ? round2(closed.reduce((sum, cycle) => sum + cycle.usd, 0) / closed.length) : null,
    total_usd: round2(cycles.reduce((sum, cycle) => sum + cycle.usd, 0)), total_calls: cycles.reduce((sum, cycle) => sum + cycle.calls, 0),
    span_usd: round2(span.usd), span_calls: span.calls, unattributed_usd: round2(left.usd), unattributed_calls: left.calls,
  }, unpriced };
}
