import { MIN_TYPICAL_WINDOWS } from "./window-insights";
import type { RailWindow } from "./windows";

/** Chart coordinates: `t` is elapsed window time in percent, `pct` the limit used. */
export interface CoursePoint {
  t: number;
  pct: number;
}
export interface BandPoint {
  t: number;
  low: number;
  mid: number;
  high: number;
}

type Shape = NonNullable<RailWindow["shape"]>;

/** Straight reading between measured samples; nothing outside the measured span. */
export function shapeAt(shape: Shape, t: number): number | null {
  const points = shape.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.pct)).sort((a, b) => a.t - b.t);
  const first = points[0], last = points.at(-1);
  if (!first || !last || t < first.t || t > last.t) return null;
  const hi = points.findIndex((p) => p.t >= t);
  const b = points[hi]!;
  if (b.t === t || hi === 0) return b.pct;
  const a = points[hi - 1]!;
  return a.pct + ((b.pct - a.pct) * (t - a.t)) / (b.t - a.t);
}

function quantile(sorted: number[], p: number): number {
  const x = (sorted.length - 1) * p, i = Math.floor(x);
  return sorted[i]! + (sorted[Math.ceil(x)]! - sorted[i]!) * (x - i);
}

/**
 * Interquartile band and median of earlier windows' courses. Drawn only where at least
 * MIN_TYPICAL_WINDOWS windows were measured, like the typical forecast itself.
 */
export function typicalBand(shapes: (Shape | null)[], steps = 50): BandPoint[] {
  const usable = shapes.filter((s): s is Shape => s != null && s.length > 0);
  if (usable.length < MIN_TYPICAL_WINDOWS) return [];
  const out: BandPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 100;
    const values = usable.map((s) => shapeAt(s, t)).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (values.length < MIN_TYPICAL_WINDOWS) continue;
    out.push({ t, low: quantile(values, 0.25), mid: quantile(values, 0.5), high: quantile(values, 0.75) });
  }
  return out;
}

/**
 * The typical forecast drawn from the reading to the reset: the median course's shape,
 * scaled so it ends exactly at the forecast value the insight computed.
 */
export function typicalForecastPath(band: BandPoint[], from: CoursePoint, endPct: number): CoursePoint[] {
  const ahead = band.filter((p) => p.t > from.t);
  const startMid = interpolateMid(band, from.t);
  const endMid = band.at(-1)?.mid ?? null;
  if (ahead.length === 0 || startMid == null || endMid == null || endMid - startMid <= 0) {
    return [from, { t: 100, pct: endPct }];
  }
  const scale = (endPct - from.pct) / (endMid - startMid);
  const path = [from, ...ahead.map((p) => ({ t: p.t, pct: from.pct + (p.mid - startMid) * scale }))];
  if (path.at(-1)!.t < 100) path.push({ t: 100, pct: endPct });
  return path;
}

function interpolateMid(band: BandPoint[], t: number): number | null {
  const hi = band.findIndex((p) => p.t >= t);
  if (hi < 0) return null;
  const b = band[hi]!;
  if (b.t === t) return b.mid;
  if (hi === 0) return null;
  const a = band[hi - 1]!;
  return a.mid + ((b.mid - a.mid) * (t - a.t)) / (b.t - a.t);
}

/** Cuts a course where it first crosses 100%; `crossing` is where the limit runs out. */
export function clipAtLimit(path: CoursePoint[]): { path: CoursePoint[]; crossing: CoursePoint | null } {
  const out: CoursePoint[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    if (p.pct <= 100) { out.push(p); continue; }
    const prev = path[i - 1];
    if (!prev) return { path: out, crossing: null };
    const crossing = { t: prev.t + ((100 - prev.pct) * (p.t - prev.t)) / (p.pct - prev.pct), pct: 100 };
    out.push(crossing);
    return { path: out, crossing };
  }
  return { path: out, crossing: null };
}

export interface WindowDay {
  key: string;
  startMs: number;
  endMs: number;
}

/** Local calendar days clipped to the window, including days still ahead. */
export function windowDays(startMs: number, endMs: number): WindowDay[] {
  const days: WindowDay[] = [];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return days;
  let from = startMs;
  while (from < endMs && days.length < 64) {
    const d = new Date(from);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({ key, startMs: from, endMs: Math.min(next, endMs) });
    from = next;
  }
  return days;
}
