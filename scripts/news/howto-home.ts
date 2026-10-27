import type { WindowsResponse } from "../../src/web/lib/api/usage";
import { buildWindowInsights, sampleCurveAt } from "../../src/web/lib/window-insights";
import { comparedWindows, medianCourse, windowCounters, windowEndHours, windowHoursCourse, windowPlanKey, windowPlanLabel, type HoursPoint } from "../../src/web/lib/window-archive";
import type { RailWindow } from "../../src/web/lib/windows";
import { typicalBand, shapeAt } from "../../src/web/lib/window-status";
import { COMPLETED_PROVIDER_RESETS } from "../../src/shared/completed-provider-resets";
import { CODEX_PROMOTIONS } from "../../src/shared/codex-promotions";

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

const planOf = (window: RailWindow) => windowPlanLabel(window.counterKey?.split(":")[0] ?? "", windowPlanKey(window), window.startIso?.slice(0, 10));
const course = (points: readonly HoursPoint[]) => points.map(([hours, percent]) => [round(hours, 3), round(percent, 2)] as const);

/**
 * The app's WindowCompare screen for the weekly counter, read the way the screen reads it: the current window, the newest closed
 * windows, the typical course of windows with the same plan and cadence, and each window at the current moment. Times and percentages
 * only; machines, traffic and identities stay out. Null when the account has no weekly window with readings.
 */
export function publicWindowCompare(windows: WindowsResponse, now: number, subscription: string | null) {
  const counter = windowCounters(windows.windows, "shortest").find(item => !item.isSublimit && item.windowHours === 168
    && item.rows.some(row => row.isCurrent || (row.percentBasis === "measured" && row.shape)));
  if (!counter) return null;
  const current = counter.rows.find(row => row.isCurrent && row.usedPercent != null) ?? null;
  const reference = current ?? counter.rows.find(row => row.percentBasis === "measured" && row.shape) ?? null;
  const insight = current ? buildWindowInsights(counter.rows, now).find(item => !item.isSublimit && item.current.windowKey === current.key) ?? null : null;
  const hours = reference?.windowHours ?? counter.windowHours ?? 168;
  const nowHours = current ? windowEndHours(current) : null;
  const elapsed = current?.elapsedPercent ?? null;
  const typicalWindows = insight && !insight.buildingHistory
    ? insight.comparableWindows.flatMap(item => counter.rows.find(row => row.key === item.windowKey) ?? []) : [];
  const median = medianCourse(typicalWindows.map(windowHoursCourse), hours / 48);
  const typicalEnd = insight?.typicalEndPercent ?? null;
  return {
    subscription, plan: reference ? planOf(reference) : null, hours: round(hours, 3),
    nowHours: nowHours === null ? null : round(nowHours, 3), elapsed: elapsed === null ? null : round(elapsed, 2),
    current: current && nowHours !== null ? {
      startIso: current.startIso, resetIso: current.resetIso, usedPercent: round(current.usedPercent!, 2), exact: current.percentBasis === "measured",
      course: course(windowHoursCourse(current)), forecast: insight?.forecastPercent ?? null,
    } : null,
    closed: comparedWindows(counter.rows, reference).map(({ window, comparable }) => {
      const points = windowHoursCourse(window), last = points.at(-1);
      const sample = elapsed === null ? null : sampleCurveAt(window.shape, elapsed, window.activityShape);
      return {
        startIso: window.startIso, resetIso: window.resetIso, usedPercent: window.usedPercent === null ? null : round(window.usedPercent, 2), comparable,
        // Grey windows say why: another plan (named) or another cadence.
        other: comparable ? null : reference && windowPlanKey(window) !== windowPlanKey(reference) ? { kind: "plan" as const, plan: planOf(window) } : { kind: "cadence" as const },
        course: course(points),
        end: last ? { hours: round(last[0], 3), percent: round(last[1], 2), mark: last[1] >= 100 ? "exhausted" as const : "ended" as const } : null,
        at: sample ? { value: round(sample.value, 2), exact: sample.basis === "measured" } : null,
      };
    }),
    typical: typicalEnd !== null && insight ? {
      end: typicalEnd, at: insight.typicalAtElapsed, count: insight.baselineCount, course: median.length > 1 ? course(median) : [],
    } : null,
    building: insight?.buildingHistory ? Math.min(insight.baselineCount, 2) : null,
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

/**
 * The public dated events the app's Capacity screen draws over the cycles (CapacityAnnotations): completed global resets and Codex
 * plan and promotion announcements, from the catalogs shipped with the app. Each keeps the app's caveat kind: an announcement
 * is not an account transition and a reset confirmation is not proof of receipt.
 */
export function publicCapacityEvents(now: number) {
  const resets = COMPLETED_PROVIDER_RESETS.filter(reset => Date.parse(reset.at) <= now).map(reset => ({
    id: `reset:${reset.id}`, provider: reset.provider, at: reset.at, kind: "reset" as const, title: null, plans: [] as string[], source: reset.source,
  }));
  const announcements = CODEX_PROMOTIONS.filter(promotion => ["allowance", "discount", "window", "policy"].includes(promotion.kind)).flatMap(promotion => {
    const dates: Array<{ suffix: string; at: string; kind: "policy" | "promotion" | "promotion_end" }> = [{ suffix: "announcement", at: promotion.announced_at ?? `${promotion.announced}T00:00:00Z`, kind: promotion.kind === "policy" ? "policy" : "promotion" }];
    if (promotion.until) dates.push({ suffix: "end", at: new Date(Date.parse(promotion.until) + 86_400_000).toISOString(), kind: "promotion_end" });
    return dates.filter(date => Date.parse(date.at) <= now).map(date => ({
      id: `promotion:${promotion.id}:${date.suffix}`, provider: "codex" as const, at: date.at, kind: date.kind,
      title: { en: promotion.title.en, pl: promotion.title.pl }, plans: [...promotion.plans], source: promotion.source,
    }));
  });
  return [...resets, ...announcements].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
