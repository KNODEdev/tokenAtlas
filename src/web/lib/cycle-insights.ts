/**
 * Analytics and Patterns read one account's cycles (docs/ui-audit-2026-09-26.md, Analytics and Patterns
 * findings, decisions 6 and 8): the canonical allowance median, the typical window course with the
 * number of windows behind each point, findings with their sample sizes, and anomalies ordered by risk.
 */
import { milestones, normalizedCurve, type AtlasModel, type CycleView } from "./cycle";
import { canonicalMedian, isCanonicalMedianSample, type CanonicalMedian, type MedianSample } from "./canonical-median";
import { cyclePlanLabel } from "./codex-window-stats";

export function medianOf(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The smallest 1, 2, 2.5 or 5 × 10^n at or above `value`: a readable axis maximum. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((f) => value <= f * power * (1 + 1e-9))!;
  return step * power;
}

/** One cycle as an input of the canonical median: its calibrated allowance at 100%. */
export function cycleMedianSample(cycle: CycleView): MedianSample {
  return { value: cycle.calibration.allowanceTokens, plan: cyclePlanLabel(cycle), samplePp: cycle.calibration.spanPercent,
    confidence: cycle.calibration.confidence };
}

/** The newest confirmed plan among the cycles (newest first): the plan the median is taken for. */
export function cycleReferencePlan(cycles: CycleView[]): string | null {
  return cycles.map(cyclePlanLabel).find((plan) => plan !== null) ?? null;
}

export interface AllowanceSummary {
  median: CanonicalMedian;
  /** Middle half of the median's values; null below four values. */
  quartiles: { q1: number; q3: number } | null;
  /** The newest closed cycle that counts towards the median. */
  latest: CycleView | null;
  /** Closed cycles without a calibrated allowance, and those with only low confidence. */
  uncalibrated: number;
  lowConfidence: number;
}

/** Linear-interpolated quantile of values sorted ascending. */
function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Full allowance of the closed cycles against the canonical median (decision 6). */
export function allowanceSummary(model: AtlasModel): AllowanceSummary {
  const plan = cycleReferencePlan(model.cycles);
  const median = canonicalMedian(model.closed.map(cycleMedianSample), plan);
  const values = median.value !== null ? median.values : [];
  return {
    median,
    quartiles: values.length >= 4 ? { q1: quantile(values, 0.25), q3: quantile(values, 0.75) } : null,
    latest: plan === null ? null : model.closed.find((cycle) => isCanonicalMedianSample(cycleMedianSample(cycle), plan)) ?? null,
    uncalibrated: model.closed.filter((cycle) => cycle.calibration.allowanceTokens === null).length,
    lowConfidence: model.closed.filter((cycle) => cycle.calibration.allowanceTokens !== null && cycle.calibration.confidence === "low").length,
  };
}

function valueAtProgress(curve: { t: number; v: number }[], target: number): number | null {
  const first = curve[0], last = curve.at(-1);
  if (!first || !last) return null;
  // A window read slightly after its start or before its end still counts at the edge.
  if (target < first.t) return target >= first.t - 5 ? first.v : null;
  if (target > last.t) return target <= last.t + 5 ? last.v : null;
  const hi = curve.findIndex((point) => point.t >= target);
  const b = curve[hi]!, a = curve[Math.max(0, hi - 1)]!;
  return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (target - a.t)) / (b.t - a.t);
}

export interface CoursePoint { t: number; v: number; windows: number }

/** Average usage of the closed windows every 5% of window time, with the number of windows behind each point. */
export function typicalCourse(model: AtlasModel): CoursePoint[] {
  const curves = model.closed.map((cycle) => normalizedCurve(cycle.index, model.series.points));
  const course: CoursePoint[] = [];
  for (let t = 0; t <= 100; t += 5) {
    const values = curves.map((curve) => valueAtProgress(curve, t)).filter((v): v is number => v !== null);
    if (values.length > 0) course.push({ t, v: values.reduce((sum, v) => sum + v, 0) / values.length, windows: values.length });
  }
  return course.length >= 2 ? course : [];
}

/** A statement about the closed windows, always with the number of windows it rests on. */
export interface PatternFindings {
  /** Up to ten newest closed windows, newest first. */
  lastClosed: CycleView[];
  headroom: { median: number; under70: number; windows: number } | null;
  /** Median daily pace of the newer half against the older half of up to 12 windows. */
  pace: { recent: number; older: number; change: number; windows: number } | null;
  halfLimit: { hours: number; share: number; windows: number } | null;
  quarter: { value: number; above: number; windows: number } | null;
}

const PACE_WINDOWS = 12;

export function patternFindings(model: AtlasModel): PatternFindings {
  const closed = model.closed;
  const headroom = closed.length >= 2 ? {
    median: medianOf(closed.map((c) => Math.max(0, 100 - c.usedPercent)))!,
    under70: closed.filter((c) => c.usedPercent < 70).length, windows: closed.length,
  } : null;
  const burning = closed.filter((c) => c.burnPerDay != null && c.burnPerDay > 0).slice(0, PACE_WINDOWS);
  const half = burning.length >> 1;
  const recent = medianOf(burning.slice(0, half).map((c) => c.burnPerDay!)), older = medianOf(burning.slice(half, half * 2).map((c) => c.burnPerDay!));
  const pace = half >= 3 && recent !== null && older !== null && older > 0
    ? { recent, older, change: (recent / older - 1) * 100, windows: half * 2 } : null;
  const hit50 = closed.map((c) => milestones(c, model.series.points, [50])[0]?.hours ?? null).filter((h): h is number => h !== null && h > 0);
  const halfHours = medianOf(hit50), windowHours = medianOf(model.typical.map((c) => c.windowHours));
  const halfLimit = hit50.length >= 2 && halfHours !== null && windowHours !== null && windowHours > 0
    ? { hours: halfHours, share: (halfHours / windowHours) * 100, windows: hit50.length } : null;
  const at25 = closed.map((c) => valueAtProgress(normalizedCurve(c.index, model.series.points), 25)).filter((v): v is number => v !== null);
  const quarter = at25.length >= 2
    ? { value: at25.reduce((sum, v) => sum + v, 0) / at25.length, above: at25.filter((v) => v > 25).length, windows: at25.length } : null;
  return { lastClosed: closed.slice(0, 10), headroom, pace, halfLimit, quarter };
}

export type AnomalyKind = "exhausted" | "near" | "tokens" | "pace" | "allowance" | "lag";
export type AnomalySeverity = "risk" | "noteworthy" | "informational";
/** Lane order of the anomaly map: risks on top. */
export const ANOMALY_KINDS: readonly AnomalyKind[] = ["exhausted", "near", "tokens", "pace", "allowance", "lag"];
export const ANOMALY_SEVERITY: Record<AnomalyKind, AnomalySeverity> = {
  exhausted: "risk", near: "risk", tokens: "noteworthy", pace: "noteworthy", allowance: "noteworthy", lag: "informational",
};
const SEVERITY_RANK: Record<AnomalySeverity, number> = { risk: 0, noteworthy: 1, informational: 2 };

export interface Anomaly {
  kind: AnomalyKind;
  cycle: CycleView;
  /** Ratio to the typical value (tokens, pace), deviation in % (allowance) or share of delayed readings (lag). */
  ratio: number | null;
  score: number;
}

function meanAndDeviation(values: number[]): { mean: number; deviation: number } | null {
  if (values.length < 3) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { mean, deviation: Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length) };
}

/**
 * Every anomaly of every cycle. An allowance counts as changed only when a reliable sample of the
 * median's plan falls outside the usual range (1.5 × the middle half beyond it): comparing every
 * estimate with a median marked most windows as anomalies.
 */
export function findAnomalies(model: AtlasModel, allowance: AllowanceSummary): Anomaly[] {
  const base = model.closed.length >= 3 ? model.closed : model.cycles;
  const tokens = meanAndDeviation(base.map((c) => c.tokensTotal));
  const typicalTokens = model.median.tokens, typicalBurn = model.median.burnPerDay;
  const { median, quartiles } = allowance;
  const fence = quartiles ? 1.5 * (quartiles.q3 - quartiles.q1) : null;
  const out: Anomaly[] = [];
  for (const cycle of model.cycles) {
    if (cycle.usedPercent >= 100) out.push({ kind: "exhausted", cycle, ratio: null, score: 5 + (cycle.elapsedPercent < 90 ? 2 : 0) });
    else if (cycle.usedPercent >= 95) out.push({ kind: "near", cycle, ratio: null, score: 4 });
    if (tokens && tokens.deviation > 0) {
      const z = (cycle.tokensTotal - tokens.mean) / tokens.deviation;
      const ratio = typicalTokens != null && typicalTokens > 0 ? cycle.tokensTotal / typicalTokens : null;
      if (z >= 1.8 || (ratio !== null && ratio >= 1.8)) out.push({ kind: "tokens", cycle, ratio, score: 2.5 + Math.max(0, z) });
    }
    if (cycle.burnPerDay != null && typicalBurn != null && typicalBurn > 0 && cycle.tokensTotal > 50_000) {
      const ratio = cycle.burnPerDay / typicalBurn;
      if (ratio >= 1.75) out.push({ kind: "pace", cycle, ratio, score: 2.2 + ratio });
    }
    const value = cycle.calibration.allowanceTokens;
    if (median.value !== null && quartiles && fence !== null && value !== null && !cycle.isActive
      && isCanonicalMedianSample(cycleMedianSample(cycle), median.plan) && (value < quartiles.q1 - fence || value > quartiles.q3 + fence)) {
      const change = (value / median.value - 1) * 100;
      out.push({ kind: "allowance", cycle, ratio: change, score: 2 + Math.abs(change) / 50 });
    }
    if (cycle.calibration.lagFraction >= 0.35 && cycle.raw.sample_count >= 20) {
      out.push({ kind: "lag", cycle, ratio: cycle.calibration.lagFraction, score: 1.5 });
    }
  }
  return out;
}

/** Exhaustions, then near-exhaustions, each newest first; the rest by score. The list and its folded tail share it. */
export function orderAnomalies(anomalies: Anomaly[]): Anomaly[] {
  return [...anomalies].sort((a, b) => {
    const severity = SEVERITY_RANK[ANOMALY_SEVERITY[a.kind]] - SEVERITY_RANK[ANOMALY_SEVERITY[b.kind]];
    if (severity !== 0) return severity;
    if (ANOMALY_SEVERITY[a.kind] === "risk") return ANOMALY_KINDS.indexOf(a.kind) - ANOMALY_KINDS.indexOf(b.kind) || b.cycle.index - a.cycle.index;
    return b.score - a.score || b.cycle.index - a.cycle.index;
  });
}

/** One lane per kind that occurs, in lane order, with the cycle indices it marks. */
export function anomalyLanes(anomalies: Anomaly[]): Array<{ kind: AnomalyKind; indices: number[] }> {
  return ANOMALY_KINDS.map((kind) => ({ kind, indices: anomalies.filter((a) => a.kind === kind).map((a) => a.cycle.index) }))
    .filter((lane) => lane.indices.length > 0);
}

/** Five steps, each holding a fifth of the active cells; the edges are the step boundaries. */
export function heatScale(values: number[]): { edges: number[]; level: (value: number) => number } {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (active.length === 0) return { edges: [], level: () => -1 };
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => active[Math.floor(q * (active.length - 1))]!);
  return {
    edges: [active[0]!, ...cuts, active.at(-1)!],
    level: (value) => (value > 0 ? cuts.filter((cut) => value > cut).length : -1),
  };
}
