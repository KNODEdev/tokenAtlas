import type { RailSublimit, RailWindow } from "./windows";

export const TYPICAL_WINDOW_LIMIT = 10;
export const MIN_TYPICAL_WINDOWS = 2;

export type WindowRisk = "neutral" | "warning" | "critical";
export type CurveSampleBasis = "measured" | "activity-interpolated";

export interface CurveSample {
  value: number;
  basis: CurveSampleBasis;
}

export interface WindowCounterObservation {
  activity?: import("../../shared/window-activity").WindowActivity;
  counterKey: string;
  label: string;
  parentLabel: string | null;
  isSublimit: boolean;
  windowKey: string;
  dateLabel: string;
  isCurrent: boolean;
  usedPercent: number | null;
  percentBasis: RailWindow["percentBasis"];
  elapsedPercent: number | null;
  windowHours: number | null;
  startIso: string | null;
  resetIso: string | null;
  shape: RailWindow["shape"];
  activityShape: RailWindow["activityShape"];
  regimeKey: string;
  sampledAtIso: string | null;
  sampleMachine: string | null;
  /** The account's plan period over the window, from the rail. */
  plan: string | null;
  trafficByMachine: NonNullable<RailWindow["trafficByMachine"]>;
  /** Account-wide estimate of the window; sublimits have none of their own. */
  accountSplit?: RailWindow["accountSplit"];
}

export interface WindowInsight {
  counterKey: string;
  label: string;
  parentLabel: string | null;
  isSublimit: boolean;
  current: WindowCounterObservation;
  comparableClosedCount: number;
  /** Closed windows of the same regime behind the typical course, newest first. */
  comparableWindows: WindowCounterObservation[];
  baselineCount: number;
  typicalAtElapsed: number | null;
  typicalEndPercent: number | null;
  deviationPp: number | null;
  forecastPercent: number | null;
  forecastEstimated: boolean;
  risk: WindowRisk;
  buildingHistory: boolean;
  fresh: boolean;
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Samples outside the measured span are never extrapolated. */
export function sampleCurveAt(
  shape: RailWindow["shape"],
  elapsedPercent: number,
  activityShape: RailWindow["activityShape"] = null
): CurveSample | null {
  if (!shape || shape.length === 0 || !Number.isFinite(elapsedPercent)) return null;
  const points = shape
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.pct))
    .sort((a, b) => a.t - b.t);
  const exact = points.find((point) => Math.abs(point.t - elapsedPercent) < 0.001);
  if (exact) return { value: exact.pct, basis: "measured" };
  const hiIndex = points.findIndex((point) => point.t > elapsedPercent);
  if (hiIndex <= 0) return null;
  const lo = points[hiIndex - 1];
  const hi = points[hiIndex];
  if (!lo || !hi || hi.t <= lo.t) return null;
  const activityAt = (t: number): number | null => {
    if (!activityShape || activityShape.length === 0) return null;
    const eligible = activityShape
      .filter((point) => point.t <= t && Number.isFinite(point.t) && Number.isFinite(point.amount))
      .sort((a, b) => b.t - a.t)[0];
    return eligible?.amount ?? null;
  };
  const loActivity = activityAt(lo.t);
  const atActivity = activityAt(elapsedPercent);
  const hiActivity = activityAt(hi.t);
  const hasActivity = finite(loActivity) && finite(atActivity) && finite(hiActivity) && hiActivity > loActivity;
  if (!hasActivity) return null;
  const ratio = Math.max(0, Math.min(1, (atActivity - loActivity) / (hiActivity - loActivity)));
  return {
    value: lo.pct + (hi.pct - lo.pct) * ratio,
    basis: "activity-interpolated",
  };
}

export function measuredEndPercent(observation: WindowCounterObservation): number | null {
  if (observation.percentBasis !== "measured" || !finite(observation.usedPercent)) return null;
  if (observation.usedPercent >= 99.5) return observation.usedPercent;
  const last = [...(observation.shape ?? [])]
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.pct))
    .sort((a, b) => b.t - a.t)[0];
  // A near-end reading is acceptable only inside the final 0.5% of elapsed
  // time. Earlier observations remain history, but never become the endpoint
  // used by the baseline or forecast.
  return last && last.t >= 99.5 ? last.pct : null;
}

export function windowCounterKey(window: RailWindow): string {
  if (window.counterKey) return window.counterKey;
  if (window.source === "cycle") return `cycle:${window.windowHours ?? "unknown"}h`;
  return `window:${window.label}`;
}

export function windowRegimeKey(window: RailWindow, key = windowCounterKey(window)): string {
  // Missing provenance is not evidence that two windows had the same plan or
  // capacity. Keep such windows visible, but isolate them from baselines.
  if (!window.regimeKey) return `${key}:${window.windowHours ?? "unknown"}h:unknown@${window.key}`;
  if (/(^|:)unknown-(plan|allowance)(?=:|$)/.test(window.regimeKey)) {
    return `${window.regimeKey}:unknown@${window.key}`;
  }
  return window.regimeKey;
}

function subObservation(window: RailWindow, sub: RailSublimit): WindowCounterObservation {
  const hostKey = windowCounterKey(window);
  const key = sub.counterKey ?? `${hostKey}:scope:${sub.label}`;
  return {
    counterKey: key,
    label: sub.label,
    parentLabel: window.counterLabel ?? window.label,
    isSublimit: true,
    windowKey: window.key,
    dateLabel: window.dateLabel,
    isCurrent: window.isCurrent,
    usedPercent: sub.usedPercent,
    percentBasis: sub.percentBasis,
    elapsedPercent: window.elapsedPercent,
    windowHours: window.windowHours,
    startIso: window.startIso,
    resetIso: window.resetIso,
    shape: sub.shape ?? null,
    activityShape: sub.activityShape ?? window.activityShape ?? null,
    regimeKey: sub.regimeKey ?? windowRegimeKey(window, key),
    sampledAtIso: sub.sampledAtIso ?? window.sampledAtIso ?? null,
    sampleMachine: sub.sampleMachine ?? window.sampleMachine ?? null,
    plan: window.plan ?? null,
    trafficByMachine: sub.trafficByMachine ?? window.trafficByMachine ?? [],
  };
}

export function flattenWindowCounters(windows: RailWindow[]): WindowCounterObservation[] {
  const out: WindowCounterObservation[] = [];
  for (const window of windows) {
    const key = windowCounterKey(window);
    out.push({
      counterKey: key,
      label: window.counterLabel ?? window.label,
      parentLabel: null,
      isSublimit: false,
      windowKey: window.key,
      dateLabel: window.dateLabel,
      isCurrent: window.isCurrent,
      ...(window.activity ? { activity: window.activity } : {}),
      usedPercent: window.usedPercent,
      percentBasis: window.percentBasis,
      elapsedPercent: window.elapsedPercent,
      windowHours: window.windowHours,
      startIso: window.startIso,
      resetIso: window.resetIso,
      shape: window.shape,
      activityShape: window.activityShape ?? null,
      regimeKey: windowRegimeKey(window, key),
      sampledAtIso: window.sampledAtIso ?? null,
      sampleMachine: window.sampleMachine ?? null,
      plan: window.plan ?? null,
      trafficByMachine: window.trafficByMachine ?? [],
      accountSplit: window.accountSplit ?? null,
    });
    for (const sub of window.sublimits) out.push(subObservation(window, sub));
  }
  return out;
}

function observationTime(observation: WindowCounterObservation): number {
  const value = observation.resetIso ?? observation.startIso ?? observation.sampledAtIso;
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function railWindowTime(window: RailWindow): number {
  const value = window.resetIso ?? window.startIso ?? window.sampledAtIso;
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export function readingIsFresh(current: WindowCounterObservation, nowMs = Date.now()): boolean {
  if (!current.sampledAtIso) return false;
  const sampledMs = Date.parse(current.sampledAtIso);
  if (!Number.isFinite(sampledMs)) return false;
  const windowHours = current.windowHours ?? 168;
  const maxAgeHours = Math.min(6, Math.max(0.5, windowHours * 0.05));
  return nowMs - sampledMs <= maxAgeHours * 3_600_000;
}

function analyzeCounter(
  observations: WindowCounterObservation[],
  nowMs: number,
  selectedWindowKey?: string,
): WindowInsight | null {
  const ordered = [...observations].sort((a, b) => observationTime(b) - observationTime(a));
  const selected = selectedWindowKey
    ? ordered.find((item) => item.windowKey === selectedWindowKey) ?? null
    : null;
  const current = selected ?? ordered.find((item) => item.isCurrent) ?? null;
  if (!current) return null;
  const historicalSelection = selected != null && !selected.isCurrent;
  const selectedTime = historicalSelection ? observationTime(selected) : 0;
  const measuredCurrent = current.percentBasis === "measured";
  const comparable = ordered
    .filter(
      (item) =>
        !item.isCurrent &&
        item.windowKey !== current.windowKey &&
        item.regimeKey === current.regimeKey &&
        (!historicalSelection || (selectedTime > 0 && observationTime(item) > 0 && observationTime(item) < selectedTime)) &&
        measuredEndPercent(item) != null
    )
    .slice(0, TYPICAL_WINDOW_LIMIT);
  const elapsed = current.elapsedPercent;
  const sampled = measuredCurrent && finite(elapsed)
    ? comparable
        .map((item) => {
          const atElapsed = sampleCurveAt(item.shape, elapsed, item.activityShape);
          const endPercent = measuredEndPercent(item);
          return atElapsed && finite(endPercent)
            ? { atElapsed, endPercent }
            : null;
        })
        .filter((item): item is { atElapsed: CurveSample; endPercent: number } => item != null)
    : [];
  const ready = sampled.length >= MIN_TYPICAL_WINDOWS;
  const typicalAtElapsed = ready ? median(sampled.map((item) => item.atElapsed.value)) : null;
  const typicalEndPercent = ready ? median(sampled.map((item) => item.endPercent)) : null;
  const deviationPp = finite(current.usedPercent) && finite(typicalAtElapsed)
    ? round2(current.usedPercent - typicalAtElapsed)
    : null;
  const forecastPercent = !historicalSelection && finite(current.usedPercent) && finite(typicalAtElapsed) && finite(typicalEndPercent)
    ? round2(Math.max(0, current.usedPercent + typicalEndPercent - typicalAtElapsed))
    : null;
  const fresh = readingIsFresh(current, nowMs);
  const risk: WindowRisk = historicalSelection || !measuredCurrent
    ? "neutral"
    : (current.usedPercent ?? 0) >= 100 || (fresh && (forecastPercent ?? 0) >= 100)
      ? "critical"
      : fresh && (forecastPercent ?? 0) >= 90
        ? "warning"
        : "neutral";
  return {
    counterKey: current.counterKey,
    label: current.label,
    parentLabel: current.parentLabel,
    isSublimit: current.isSublimit,
    current,
    comparableClosedCount: measuredCurrent ? comparable.length : 0,
    comparableWindows: measuredCurrent ? comparable : [],
    baselineCount: sampled.length,
    typicalAtElapsed: typicalAtElapsed == null ? null : round2(typicalAtElapsed),
    typicalEndPercent: typicalEndPercent == null ? null : round2(typicalEndPercent),
    deviationPp,
    forecastPercent,
    forecastEstimated: !historicalSelection && sampled.some((item) => item.atElapsed.basis !== "measured"),
    risk,
    buildingHistory: !ready,
    fresh,
  };
}

export function buildWindowInsights(windows: RailWindow[], nowMs = Date.now(), selectedWindowKey?: string | null): WindowInsight[] {
  const selected = selectedWindowKey ? windows.find((window) => window.key === selectedWindowKey) ?? null : null;
  const selectedHistorical = selected != null && !selected.isCurrent;
  const scopedWindows = selectedHistorical
    ? windows.filter((window) => window.key === selectedWindowKey || (
        railWindowTime(window) > 0 && railWindowTime(selected) > 0 && railWindowTime(window) < railWindowTime(selected)
      ))
    : windows;
  const groups = new Map<string, WindowCounterObservation[]>();
  for (const observation of flattenWindowCounters(scopedWindows)) {
    const bucket = groups.get(observation.counterKey);
    if (bucket) bucket.push(observation);
    else groups.set(observation.counterKey, [observation]);
  }
  return [...groups.values()]
    .map((group) => analyzeCounter(group, nowMs, selectedHistorical ? selectedWindowKey ?? undefined : undefined))
    .filter((insight): insight is WindowInsight => insight != null)
    .sort((a, b) => {
      const hours = (a.current.windowHours ?? 0) - (b.current.windowHours ?? 0);
      if (hours !== 0) return hours;
      const group = (a.parentLabel ?? a.label).localeCompare(b.parentLabel ?? b.label);
      if (group !== 0) return group;
      if (a.parentLabel == null && b.parentLabel != null) return -1;
      if (a.parentLabel != null && b.parentLabel == null) return 1;
      return a.label.localeCompare(b.label);
    });
}
