import type { WindowsResponse } from "../../src/web/lib/api/usage";
import { buildWindowInsights } from "../../src/web/lib/window-insights";
import { typicalBand, shapeAt } from "../../src/web/lib/window-status";

/**
 * Parts of the snapshot that feed the landing's home-page instruments. Same rules as the rest of the export: existing reads, nothing
 * repriced, a whitelist of anonymous fields (projects become ranks, never names), missing stays null.
 */
const round = (value: number, digits = 2) => { const f = 10 ** digits; return Math.round(value * f) / f; };
/** The instrument draws 15 evenly spaced points of the window (0, 100/14, ... 100). */
export const COMPARE_POINTS = 15;

/** The current weekly window against the interquartile band and median course of earlier windows of the same counter, at the same moment. */
export function publicCompare(windows: WindowsResponse, now: number, subscription: string | null) {
  const insight = buildWindowInsights(windows.windows, now).find(item => item.current.isCurrent && !item.isSublimit && item.current.windowHours === 168);
  if (!insight || insight.current.usedPercent == null || insight.current.elapsedPercent == null) return null;
  // The page says "last 8 windows": the 8 newest closed windows of the same counter and plan regime (comparableWindows is newest first).
  const baseline = insight.comparableWindows.slice(0, 8);
  const shapes = baseline.map(item => item.shape);
  const band = typicalBand(shapes, 50);
  if (band.length < 2) return { subscription, baselineWindows: insight.baselineCount, reason: "too_few_windows" as const };
  // The band covers 2..98 % of the window; the start is 0 by definition and the end holds the last measured level.
  const points = [{ t: 0, low: 0, mid: 0, high: 0 }, ...band, { ...band.at(-1)!, t: 100 }];
  const at = (t: number, key: "low" | "mid" | "high") => {
    const hi = points.findIndex(point => point.t >= t), b = points[hi]!, a = points[Math.max(0, hi - 1)]!;
    return b.t === a.t ? b[key] : a[key] + (b[key] - a[key]) * (t - a.t) / (b.t - a.t);
  };
  const grid = Array.from({ length: COMPARE_POINTS }, (_, index) => index * 100 / (COMPARE_POINTS - 1));
  const now100 = insight.current.elapsedPercent;
  const shape = insight.current.shape ?? [];
  return {
    subscription, plan: insight.current.plan, baselineWindows: baseline.length, reason: null,
    median: grid.map(t => round(at(t, "mid"), 1)), low: grid.map(t => round(at(t, "low"), 1)), high: grid.map(t => round(at(t, "high"), 1)),
    // Measured course up to the moment of the data: the grid points before it, then the reading itself.
    current: grid.filter(t => t < now100).map(t => t === 0 ? 0 : round(shapeAt(shape, t) ?? 0, 1)),
    now: round(now100, 1), nowValue: round(insight.current.usedPercent, 1),
  };
}

export interface ProjectSubject { kind: string; api_usd: number }
/**
 * The three largest projects of the last 30 days, ranked, with their value in the last 7 and 30 days. Names, paths and ids are never read
 * into the output; a project absent from the short period is 0 API-eq there because the cost read lists it as a project with no spend.
 */
export function publicProjects(cost7: { subjects: Array<ProjectSubject & { subject: string }> }, cost30: { subjects: Array<ProjectSubject & { subject: string }> }) {
  const projects = (subjects: Array<ProjectSubject & { subject: string }>) => subjects.filter(item => item.kind === "project" && Number.isFinite(item.api_usd));
  const week = new Map(projects(cost7.subjects).map(item => [item.subject, item.api_usd]));
  const ranked = projects(cost30.subjects).sort((a, b) => b.api_usd - a.api_usd);
  const total = ranked.reduce((sum, item) => sum + item.api_usd, 0);
  const top = ranked.slice(0, 3);
  return {
    top: top.map((item, index) => ({ rank: index + 1, week: round(week.get(item.subject) ?? 0, 2), month: round(item.api_usd, 2) })),
    projectCount: ranked.length,
    // How much of all project spend the three shown cover, so the instrument never implies they are everything.
    topShareOfMonth: total > 0 ? round(top.reduce((sum, item) => sum + item.api_usd, 0) / total * 100, 1) : null,
  };
}
