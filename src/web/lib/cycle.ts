import type { ApiCycle, ApiPoint, UsageSeries } from "./api";
import { getLocale, translate } from "./i18n";
export type Health = "comfortable" | "on-pace" | "elevated" | "high-risk" | "exhausted";
export type Confidence = "high" | "medium" | "low" | "none";
export type Basis = "gauge" | "declared" | "inferred";
export interface Calibration {
  tokensPerPercent: number | null;
  allowanceTokens: number | null;
  confidence: Confidence;
  spanPercent: number;
  lagFraction: number;
  distinctSteps: number;
  reason: string;
}
export interface CycleView {
  raw: ApiCycle;
  index: number;
  number: number;
  label: string;
  dateLabel: string;
  isActive: boolean;
  isShadow: boolean;
  usedPercent: number;
  live: (LiveReading & { indexPercent: number }) | null;
  elapsedPercent: number;
  ppAhead: number;
  paceRatio: number | null;
  health: Health;
  healthLabel: string;
  windowHours: number;
  elapsedHours: number;
  remainingHours: number | null;
  startIso: string;
  endIso: string;
  resetIso: string | null;
  tokensTotal: number;
  tokensFresh: number;
  calls: number;
  usd: number;
  topModel: string | null;
  burnPerDay: number | null;
  sustainablePerDay: number | null;
  projectedEndPercent: number | null;
  etaExhaustionIso: string | null;
  exhaustionGapHours: number | null;
  remainingTokens: number | null;
  remainingPercent: number;
  calibration: Calibration;
  basis: Basis;
  color: string;
  resultLabel: string;
}
const DAY_H = 24;
function localizedNumber(value: number, fractionDigits = 0): string {
  return value
    .toLocaleString(getLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
    .replace(/\u00a0/g, " ");
}
function localizedDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(getLocale(), {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
export function calibrate(cycle: ApiCycle, _points: ApiPoint[]): Calibration {
  const span = Math.max(0, cycle.peak_percent - cycle.first_percent);
  const rawSamples = cycle.sample_count;
  const hasQuality = Number.isFinite(cycle.lag_fraction) && Number.isFinite(cycle.distinct_steps);
  const lagFraction = hasQuality ? cycle.lag_fraction : 0;
  const distinctSteps = hasQuality ? cycle.distinct_steps : 0;
  const density = span > 0 ? rawSamples / span : 0;
  const tokensPerPercent = span > 0 ? cycle.tokens.total / span : null;
  let confidence: Confidence;
  let reason: string;
  if (!hasQuality) {
    confidence = rawSamples < 50 || span < 20 ? "none" : "low";
    reason = translate(
      "The server does not return gauge quality (lag_fraction / distinct_steps) - restart the API to enable full calibration. Span {0} pp, {1} samples.",
      `Serwer nie zwraca jakości gauge (lag_fraction / distinct_steps) — zrestartuj API, żeby włączyć pełną kalibrację. Zakres ${localizedNumber(span)} pp, ${localizedNumber(rawSamples)} próbek.`, [localizedNumber(span), localizedNumber(rawSamples)],
    );
  } else if (rawSamples < 50 || span < 20) {
    confidence = "none";
    reason = translate(
      "Too little signal ({0} samples, span {1} pp)",
      `Za mało sygnału (${localizedNumber(rawSamples)} próbek, zakres ${localizedNumber(span)} pp)`, [localizedNumber(rawSamples), localizedNumber(span)],
    );
  } else if (span >= 80 && distinctSteps >= 60 && lagFraction < 0.05) {
    confidence = "high";
    reason = translate(
      "Full run {0} pp, {1} steps, {2} samples/pp, lag {3}%",
      `Pełny przebieg ${localizedNumber(span)} pp, ${localizedNumber(distinctSteps)} stopni, ${localizedNumber(density)} próbek/pp, opóźnienie ${localizedNumber(lagFraction * 100, 1)}%`, [localizedNumber(span), localizedNumber(distinctSteps), localizedNumber(density), localizedNumber(lagFraction * 100, 1)],
    );
  } else if (span >= 50 && distinctSteps >= 30 && lagFraction < 0.18) {
    confidence = "medium";
    reason = translate(
      "Span {0} pp, {1} steps, lag {2}%",
      `Zakres ${localizedNumber(span)} pp, ${localizedNumber(distinctSteps)} stopni, opóźnienie ${localizedNumber(lagFraction * 100, 1)}%`, [localizedNumber(span), localizedNumber(distinctSteps), localizedNumber(lagFraction * 100, 1)],
    );
  } else {
    confidence = "low";
    reason = translate(
      "Span {0} pp, {1} steps, lag {2}%; gauge is lagging",
      `Zakres ${localizedNumber(span)} pp, ${localizedNumber(distinctSteps)} stopni, opóźnienie ${localizedNumber(lagFraction * 100, 1)}% — gauge się opóźnia`, [localizedNumber(span), localizedNumber(distinctSteps), localizedNumber(lagFraction * 100, 1)],
    );
  }
  return {
    tokensPerPercent,
    allowanceTokens: tokensPerPercent != null && confidence !== "none" ? tokensPerPercent * 100 : null,
    confidence,
    spanPercent: span,
    lagFraction,
    distinctSteps,
    reason,
  };
}
export function healthOf(
  usedPercent: number,
  elapsedPercent: number,
  projected: number | null
): { health: Health; label: string } {
  if (usedPercent >= 100) return { health: "exhausted", label: translate("Limit exhausted", "Limit wyczerpany") };
  const pp = usedPercent - elapsedPercent;
  const proj = projected ?? usedPercent;
  if (proj >= 100 && pp > 8)
    return { health: "high-risk", label: translate("Exhaustion before reset", "Wyczerpanie przed resetem") };
  if (pp > 8) return { health: "elevated", label: translate("Above sustainable pace", "Powyżej zrównoważonego tempa") };
  if (pp < -8) return { health: "comfortable", label: translate("Below sustainable pace", "Poniżej zrównoważonego tempa") };
  return { health: "on-pace", label: translate("On pace", "W tempie") };
}
export function healthColor(h: Health): string {
  switch (h) {
    case "exhausted":
    case "high-risk":
      return "var(--crit)";
    case "elevated":
      return "var(--warn)";
    default:
      // Comfortable and on-pace read as the live accent; colour is kept for warnings.
      return "var(--accent)";
  }
}
export function resultOf(peakPercent: number): { label: string; color: string } {
  if (peakPercent >= 100) return { label: translate("exhausted", "wyczerpane"), color: "var(--crit)" };
  if (peakPercent >= 90) return { label: translate("near limit", "blisko limitu"), color: "var(--warn)" };
  if (peakPercent >= 70) return { label: translate("normal", "normalne"), color: "var(--text)" };
  return { label: translate("unused capacity", "niewykorzystana pojemność"), color: "var(--muted)" };
}
export interface LiveReading {
  used_percent: number;
  ts: string;
  age_minutes: number;
  window_minutes?: number | null;
  resets_at?: number | null;
  resets_at_iso?: string | null;
  rate_limit_reached?: boolean;
}
const RESET_MATCH_TOLERANCE_MS = 5 * 60_000;
function resetMs(live: LiveReading): number {
  if (live.resets_at_iso) return Date.parse(live.resets_at_iso);
  return live.resets_at != null ? live.resets_at * 1000 : NaN;
}
export function sameCodexWindow(live: LiveReading, cycle: ApiCycle | CycleView): boolean {
  const liveResetMs = resetMs(live);
  const cycleResetMs = "resetIso" in cycle ? Date.parse(cycle.resetIso ?? "") : Date.parse(cycle.resets_at_iso ?? "");
  const hours = "windowHours" in cycle ? cycle.windowHours : cycle.window_hours;
  return (
    (live.window_minutes == null || live.window_minutes === hours * 60) &&
    Number.isFinite(liveResetMs) &&
    Number.isFinite(cycleResetMs) &&
    Math.abs(liveResetMs - cycleResetMs) <= RESET_MATCH_TOLERANCE_MS
  );
}
function liveTiming(live: LiveReading): {
  resetMs: number;
  resetIso: string;
  startMs: number;
  startIso: string;
  windowHours: number;
  elapsedHours: number;
  remainingHours: number;
} | null {
  const nextResetMs = resetMs(live);
  const windowMinutes = live.window_minutes;
  if (!Number.isFinite(nextResetMs) || windowMinutes == null || windowMinutes <= 0) return null;
  const startMs = nextResetMs - windowMinutes * 60_000;
  const nowMs = Date.now();
  const windowHours = windowMinutes / 60;
  const elapsedHours = clamp((nowMs - startMs) / 3_600_000, 0, windowHours);
  return {
    resetMs: nextResetMs,
    resetIso: new Date(nextResetMs).toISOString(),
    startMs,
    startIso: new Date(startMs).toISOString(),
    windowHours,
    elapsedHours,
    remainingHours: Math.max(0, (nextResetMs - nowMs) / 3_600_000),
  };
}
function closeReplacedCycle(cycle: ApiCycle, replacementStartMs: number): ApiCycle {
  if (!cycle.is_active) return cycle;
  const startMs = Date.parse(cycle.work_from_ts);
  const elapsedHours = Number.isFinite(startMs)
    ? Math.max(0, (replacementStartMs - startMs) / 3_600_000)
    : cycle.elapsed_hours;
  const endIso = new Date(replacementStartMs).toISOString();
  return {
    ...cycle,
    is_active: false,
    status: cycle.hit_100 ? "exhausted" : "reset",
    end_ts: endIso,
    work_to_ts: endIso,
    elapsed_hours: elapsedHours,
    remaining_hours: null,
  };
}
function liveOnlyCycle(series: UsageSeries, live: LiveReading, timing: NonNullable<ReturnType<typeof liveTiming>>): ApiCycle {
  const used = clamp(live.used_percent, 0, 100);
  const elapsedPercent = timing.windowHours > 0 ? (timing.elapsedHours / timing.windowHours) * 100 : 0;
  const projected = elapsedPercent > 1 ? Math.round((used / elapsedPercent) * 10_000) / 100 : null;
  const index = Math.max(0, ...series.cycles.map((cycle) => cycle.index)) + 1;
  return {
    index,
    label: timing.startIso.slice(0, 10),
    anchor: timing.resetMs / 1000,
    resets_at_iso: timing.resetIso,
    window_start_iso: timing.startIso,
    is_active: true,
    shadow: false,
    status: live.rate_limit_reached ? "exhausted" : "live",
    start_ts: timing.startIso,
    end_ts: live.ts,
    work_from_ts: timing.startIso,
    work_to_ts: timing.resetIso,
    sample_count: 0,
    lag_fraction: 0,
    distinct_steps: 0,
    first_percent: used,
    peak_percent: used,
    end_percent: used,
    hit_100: live.rate_limit_reached === true || used >= 100,
    window_hours: timing.windowHours,
    elapsed_hours: timing.elapsedHours,
    observed_hours: 0,
    remaining_hours: timing.remainingHours,
    pace_percent_per_day: timing.elapsedHours > 0 ? used / (timing.elapsedHours / DAY_H) : 0,
    projected_end_percent: projected,
    eta_100_iso: null,
    calls: 0,
    usd: 0,
    usd_per_percent: null,
    usd_at_100_percent: null,
    tokens: { in: 0, cached_in: 0, cache_write: 0, out: 0, reasoning: 0, total: 0 },
    top_model: null,
    source_models: [],
    model_usage: [],
    surface_usage: [],
    plan_types: [],
    limit_names: [],
    delta_peak_percent: null,
    delta_usd: null,
    delta_calls: null,
    pct_of_prev_peak: null,
    pct_of_prev_usd: null,
  };
}
function reconcileLiveWindow(series: UsageSeries, live?: LiveReading | null): UsageSeries {
  if (!live) return series;
  const timing = liveTiming(live);
  if (!timing) return series;
  const active = series.cycles.find((cycle) => cycle.is_active && !cycle.shadow) ?? null;
  if (active && sameCodexWindow(live, active)) return series;
  const liveTsMs = Date.parse(live.ts);
  const activeTsMs = active ? Date.parse(active.end_ts) : NaN;
  if (
    active &&
    (!Number.isFinite(liveTsMs) || (Number.isFinite(activeTsMs) && liveTsMs < activeTsMs))
  ) {
    return series;
  }
  // Reset anchors can move backwards after an account/plan change. The reading
  // timestamp decides freshness; a later reset is not evidence of a newer sample.
  const matching = series.cycles.filter(cycle => !cycle.shadow && sameCodexWindow(live, cycle))
    .sort((a, b) => Date.parse(b.end_ts) - Date.parse(a.end_ts))[0];
  const cycles = series.cycles.map(cycle => {
    if (cycle === matching) return { ...cycle, is_active: true, status: live.rate_limit_reached ? "exhausted" : "live" };
    if (cycle.shadow || !cycle.is_active) return cycle;
    if (timing.startMs < Date.parse(cycle.work_from_ts)) {
      // This is a correction of the current window, not a chronological reset.
      return { ...cycle, is_active: false, status: cycle.hit_100 ? "exhausted" : "reset", remaining_hours: null };
    }
    return closeReplacedCycle(cycle, timing.startMs);
  });
  if (!matching) cycles.push(liveOnlyCycle(series, live, timing));
  return {
    ...series,
    cycles,
    stats: {
      ...series.stats,
      cycle_count: cycles.length,
      shadow_cycle_count: cycles.filter((cycle) => cycle.shadow).length,
      closed_cycle_count: cycles.filter((cycle) => !cycle.is_active && !cycle.shadow).length,
      spent_cycle_count: cycles.filter((cycle) => cycle.hit_100 && !cycle.shadow).length,
    },
  };
}
export function buildCycleView(
  cycle: ApiCycle,
  points: ApiPoint[],
  number = 0,
  live?: LiveReading | null
): CycleView {
  const liveApplies = live != null && cycle.is_active && sameCodexWindow(live, cycle);
  const timing = liveApplies ? liveTiming(live) : null;
  const windowHours = timing?.windowHours ?? (cycle.window_hours > 0 ? cycle.window_hours : cycle.elapsed_hours || 1);
  const elapsedHours = timing?.elapsedHours ?? cycle.elapsed_hours;
  const elapsedPercent = clamp((elapsedHours / windowHours) * 100, 0, 100);
  const indexPercent = cycle.peak_percent;
  const usedPercent = liveApplies ? live.used_percent : indexPercent;
  const ppAhead = usedPercent - elapsedPercent;
  const paceRatio = elapsedPercent > 1 ? usedPercent / elapsedPercent : null;
  let projectedEndPercent = cycle.projected_end_percent;
  const remainingHours = timing?.remainingHours ?? cycle.remaining_hours;
  if (liveApplies && remainingHours != null && elapsedHours > 0) {
    const pacePerDay = usedPercent / Math.max(elapsedHours / DAY_H, 1 / 24);
    projectedEndPercent = Math.round((usedPercent + pacePerDay * (remainingHours / DAY_H)) * 100) / 100;
  }
  const { health, label: healthLabel } = healthOf(usedPercent, elapsedPercent, projectedEndPercent);
  const calibration = calibrate(cycle, points);
  const elapsedDays = elapsedHours / DAY_H;
  const burnPerDay = elapsedDays > 0.1 ? cycle.tokens.total / elapsedDays : null;
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const remainingTokens =
    calibration.allowanceTokens != null && calibration.confidence !== "none"
      ? calibration.allowanceTokens * remainingPercent / 100 : null;
  const remainingDays = remainingHours != null ? remainingHours / DAY_H : null;
  const sustainablePerDay =
    remainingTokens != null && remainingDays != null && remainingDays > 0.05
      ? remainingTokens / remainingDays
      : null;
  let exhaustionGapHours: number | null = null;
  if (cycle.eta_100_iso && cycle.resets_at_iso) {
    const eta = new Date(cycle.eta_100_iso).getTime();
    const reset = new Date(cycle.resets_at_iso).getTime();
    if (Number.isFinite(eta) && Number.isFinite(reset)) {
      exhaustionGapHours = (reset - eta) / 3_600_000;
    }
  }
  const result = resultOf(usedPercent);
  return {
    raw: cycle,
    index: cycle.index,
    number,
    label: number > 0 ? translate("Cycle #{0}", `Cykl #${localizedNumber(number)}`, [localizedNumber(number)]) : localizedDate(cycle.label),
    dateLabel: localizedDate(cycle.label),
    isActive: cycle.is_active,
    isShadow: cycle.shadow,
    usedPercent,
    elapsedPercent,
    ppAhead,
    paceRatio,
    health,
    healthLabel,
    windowHours,
    elapsedHours,
    remainingHours,
    startIso: timing?.startIso ?? cycle.work_from_ts,
    endIso: liveApplies ? live.ts : cycle.is_active ? cycle.end_ts : cycle.work_to_ts,
    resetIso: timing?.resetIso ?? cycle.resets_at_iso,
    tokensTotal: cycle.tokens.total,
    tokensFresh: Math.max(0, cycle.tokens.in - cycle.tokens.cached_in) + cycle.tokens.out,
    calls: cycle.calls,
    usd: cycle.usd,
    topModel: cycle.top_model,
    burnPerDay,
    sustainablePerDay,
    projectedEndPercent,
    live: liveApplies ? { ...live!, indexPercent } : null,
    etaExhaustionIso: cycle.eta_100_iso,
    exhaustionGapHours,
    remainingTokens,
    remainingPercent,
    calibration,
    basis: "gauge",
    color: result.color,
    resultLabel: result.label,
  };
}
export interface AtlasModel {
  series: UsageSeries;
  cycles: CycleView[];
  current: CycleView | null;
  closed: CycleView[];
  typical: CycleView[];
  median: {
    peakPercent: number | null;
    tokens: number | null;
    burnPerDay: number | null;
    usd: number | null;
    allowanceTokens: number | null;
    usdAt100: number | null;
  };
  bestCalibration: Calibration | null;
}
function medianOf(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid] ?? null;
  const lo = v[mid - 1];
  const hi = v[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}
const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1, none: 0 };
export const TYPICAL_WINDOW = 10;
export function buildModel(series: UsageSeries, live?: LiveReading | null): AtlasModel {
  const resolvedSeries = reconcileLiveWindow(series, live);
  const ascending = resolvedSeries.cycles.filter((c) => !c.shadow).sort((a, b) => a.index - b.index);
  const views = ascending
    .map((c, i) => buildCycleView(c, resolvedSeries.points, i + 1, live))
    .sort((a, b) => b.index - a.index);
  const current = views.find((v) => v.isActive) ?? null;
  const closed = views.filter((v) => !v.isActive);
  const typical = closed.slice(0, TYPICAL_WINDOW);
  const best = views
    .map((v) => v.calibration)
    .filter((c) => c.tokensPerPercent != null)
    .sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || b.spanPercent - a.spanPercent)[0];
  return {
    series: resolvedSeries,
    cycles: views,
    current,
    closed,
    typical,
    median: {
      peakPercent: medianOf(typical.map((c) => c.usedPercent)),
      tokens: medianOf(typical.map((c) => c.tokensTotal)),
      burnPerDay: medianOf(typical.map((c) => c.burnPerDay ?? NaN)),
      usd: medianOf(typical.map((c) => c.usd)),
      allowanceTokens: medianOf(typical.map((c) => c.calibration.allowanceTokens ?? NaN)),
      usdAt100: medianOf(typical.map((c) => c.raw.usd_at_100_percent ?? NaN)),
    },
    bestCalibration: best ?? null,
  };
}
export function emptySeries(account: string, windowMinutes: number, cycles: ApiCycle[] = []): UsageSeries {
  return {
    account,
    window_minutes: windowMinutes,
    limit_id: "codex",
    sample_count: 0,
    bucket_minutes: 0,
    first_ts: "",
    last_ts: "",
    points: [],
    activity: [],
    traffic: [],
    cycles,
    ownership: { unowned_samples: 0, reasons: [] },
    latest: { ts: "", percent: 0, cycle: null, resets_at_iso: null, age_hours: 0 },
    stats: {
      cycle_count: cycles.length,
      shadow_cycle_count: cycles.filter((c) => c.shadow).length,
      closed_cycle_count: cycles.filter((c) => !c.is_active).length,
      spent_cycle_count: 0,
      median_closed_peak_percent: null,
      avg_closed_peak_percent: null,
      avg_closed_usd: null,
      total_usd: 0,
      total_calls: 0,
      span_usd: 0,
      span_calls: 0,
      unattributed_usd: 0,
      unattributed_calls: 0,
    },
  };
}
export function emptyModel(account: string, windowMinutes: number): AtlasModel {
  return buildModel(emptySeries(account, windowMinutes));
}
export function normalizedCurve(cycleIndex: number, points: ApiPoint[]): { t: number; v: number }[] {
  return points
    .filter((p) => p.cycle === cycleIndex && p.cycle_progress != null)
    .map((p) => ({ t: p.cycle_progress as number, v: p.percent }))
    .sort((a, b) => a.t - b.t);
}
export function milestones(
  cycle: CycleView,
  points: ApiPoint[],
  marks: number[] = [25, 50, 75, 90, 100]
): { mark: number; hours: number | null }[] {
  const mine = points
    .filter((p) => p.cycle === cycle.index)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const startMs = new Date(cycle.startIso).getTime();
  return marks.map((mark) => {
    const hit = mine.find((p) => p.percent >= mark);
    return {
      mark,
      hours: hit ? (new Date(hit.ts).getTime() - startMs) / 3_600_000 : null,
    };
  });
}
