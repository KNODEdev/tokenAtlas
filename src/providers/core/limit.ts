export const HOUR_MS = 3_600_000;
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
export interface LimitWindowTiming {
  windowStartMs: number | null;
  resetMs: number;
  windowStart: string | null;
  resetAt: string;
  elapsedHours: number | null;
  remainingHours: number;
  elapsedPercent: number | null;
}
export function windowElapsedPercent(startMs: number, windowHours: number, nowMs: number): number {
  return Math.min(100, Math.max(0, ((nowMs - startMs) / (windowHours * HOUR_MS)) * 100));
}
export function windowFromReset(
  resetIso: string | null,
  windowHours: number | null,
  nowMs: number
): LimitWindowTiming | null {
  if (!resetIso) return null;
  const resetMs = Date.parse(resetIso);
  if (!Number.isFinite(resetMs)) return null;
  const windowStartMs = windowHours != null
    ? resetMs - windowHours * HOUR_MS
    : null;
  return {
    windowStartMs,
    resetMs,
    windowStart: windowStartMs == null ? null : new Date(windowStartMs).toISOString(),
    resetAt: new Date(resetMs).toISOString(),
    elapsedHours: windowStartMs == null ? null : Math.max(0, (nowMs - windowStartMs) / HOUR_MS),
    remainingHours: (resetMs - nowMs) / HOUR_MS,
    elapsedPercent: windowStartMs == null || windowHours == null
      ? null
      : windowElapsedPercent(windowStartMs, windowHours, nowMs),
  };
}
export function alignedWindowFromReset(
  anchorResetIso: string,
  windowHours: number,
  nowMs: number
): LimitWindowTiming | null {
  const anchor = Date.parse(anchorResetIso);
  if (!Number.isFinite(anchor) || windowHours <= 0) return null;
  const period = windowHours * HOUR_MS;
  const windowStartMs = anchor + Math.floor((nowMs - anchor) / period) * period;
  return windowFromReset(new Date(windowStartMs + period).toISOString(), windowHours, nowMs);
}
export interface RollingWindow {
  windowStartMs: number;
  windowEndMs: number;
  windowStart: string;
  windowEnd: string;
}
export function rollingWindow(windowHours: number, nowMs: number): RollingWindow {
  const windowStartMs = nowMs - windowHours * HOUR_MS;
  return {
    windowStartMs,
    windowEndMs: nowMs,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(nowMs).toISOString(),
  };
}
export interface LimitPace {
  ppAhead: number | null;
  paceRatio: number | null;
  projectedEndPercent: number | null;
  eta100Iso: string | null;
}
export function limitPace(
  percent: number | null,
  timing: LimitWindowTiming | null,
  minimumElapsedPercent = 0
): LimitPace {
  if (percent == null || timing == null || timing.elapsedPercent == null) {
    return { ppAhead: null, paceRatio: null, projectedEndPercent: null, eta100Iso: null };
  }
  const ppAhead = percent - timing.elapsedPercent;
  if (timing.elapsedPercent <= minimumElapsedPercent) {
    return { ppAhead, paceRatio: null, projectedEndPercent: null, eta100Iso: null };
  }
  const paceRatio = percent / timing.elapsedPercent;
  const projectedEndPercent = paceRatio * 100;
  let eta100Iso: string | null = null;
  if (percent > 0 && timing.elapsedHours != null && timing.windowStartMs != null) {
    const hoursTo100 = (100 / percent) * timing.elapsedHours;
    if (Number.isFinite(hoursTo100)) {
      eta100Iso = new Date(timing.windowStartMs + hoursTo100 * HOUR_MS).toISOString();
    }
  }
  return { ppAhead, paceRatio, projectedEndPercent, eta100Iso };
}
export function measuredAgeMinutes(measuredIso: string | null, nowMs: number, digits = 0): number | null {
  return measuredIso == null ? null : round((nowMs - Date.parse(measuredIso)) / 60_000, digits);
}
