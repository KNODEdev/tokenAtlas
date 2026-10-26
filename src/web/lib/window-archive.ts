/**
 * History and Compare read every window of an account as one archive (docs/ui-audit-2026-09-26.md,
 * History and Compare findings, decisions 12 and 13): one counter per meter, results that tell an
 * unused window from an early reset, and usage courses in hours since the window started.
 */
import type { RailSublimit, RailWindow } from "./windows";
import { windowCounterKey } from "./window-insights";
import { subscriptionPlan } from "./subscription-plan";
import { translate } from "./i18n";

export type WindowResult = "current" | "exhausted" | "near" | "normal" | "unused" | "early";
export const WINDOW_RESULTS: readonly Exclude<WindowResult, "current">[] = ["exhausted", "near", "normal", "unused", "early"];
/** A closed window shorter than this share of its length was reset before its end. */
export const EARLY_RESET_SHARE = 0.98;

/** One threshold set for the tile, the filter, the chart and the table: exhausted means >= 100%. */
export function windowResult(usedPercent: number, isCurrent: boolean, elapsedHours: number | null, windowHours: number | null): WindowResult {
  if (isCurrent) return "current";
  if (usedPercent >= 100) return "exhausted";
  if (usedPercent >= 90) return "near";
  if (usedPercent >= 70) return "normal";
  return elapsedHours != null && windowHours != null && windowHours > 0 && elapsedHours < windowHours * EARLY_RESET_SHARE
    ? "early" : "unused";
}

export function windowResultLabel(result: WindowResult): string {
  switch (result) {
    case "current": return translate("in progress", "trwa");
    case "exhausted": return translate("exhausted", "wyczerpane");
    case "near": return translate("near limit", "blisko limitu");
    case "normal": return translate("normal", "normalne");
    case "unused": return translate("unused", "niewykorzystane");
    case "early": return translate("reset early", "reset wcześniej");
  }
}

export function windowResultColor(result: WindowResult): string {
  switch (result) {
    case "current": return "var(--accent)";
    case "normal": return "var(--pencil)";
    case "exhausted": return "var(--crit)";
    case "near": return "var(--warn)";
    case "unused": return "var(--line2)";
    case "early": return "var(--muted)";
  }
}

/** A usage course: [hours since the window started, percent], ascending in time. */
export type HoursPoint = readonly [hours: number, percent: number];

/**
 * The window's readings on an hour axis. A cycle's end percent is its measured peak at the reset,
 * so its course runs to the end; other windows stop at their last reading.
 */
export function windowHoursCourse(window: RailWindow): HoursPoint[] {
  const hours = window.windowHours;
  if (hours == null || hours <= 0) return [];
  const points: HoursPoint[] = (window.shape ?? [])
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.pct))
    .map((point): HoursPoint => [(Math.max(0, point.t) / 100) * hours, point.pct])
    .sort((a, b) => a[0] - b[0]);
  const end = windowEndHours(window);
  if (window.source === "cycle" && window.usedPercent != null && end != null && (points.at(-1)?.[0] ?? -1) < end) {
    points.push([end, window.usedPercent]);
  }
  return points;
}

/** Hours from the window's start to its reset, or to now for the current window. */
export function windowEndHours(window: RailWindow): number | null {
  if (window.windowHours == null || window.elapsedPercent == null) return null;
  return (Math.min(100, Math.max(0, window.elapsedPercent)) / 100) * window.windowHours;
}

/** The value at `hours`, only on or between two readings; nothing before the first or after the last. */
export function courseAt(course: readonly HoursPoint[], hours: number): { value: number; exact: boolean } | null {
  if (!Number.isFinite(hours)) return null;
  const exact = course.find(([h]) => Math.abs(h - hours) < 1e-6);
  if (exact) return { value: exact[1], exact: true };
  const hi = course.findIndex(([h]) => h > hours);
  if (hi <= 0) return null;
  const [h0, v0] = course[hi - 1]!, [h1, v1] = course[hi]!;
  return { value: v0 + ((v1 - v0) * (hours - h0)) / (h1 - h0), exact: false };
}

/**
 * Median course of finished windows: each keeps its final value after it ended, so the course ends
 * at the median of their end percentages. Points every `step` hours up to the latest end.
 */
export function medianCourse(courses: readonly HoursPoint[][], step: number): HoursPoint[] {
  const usable = courses.filter((course) => course.length > 0);
  if (usable.length === 0 || !(step > 0)) return [];
  const last = Math.max(...usable.map((course) => course.at(-1)![0]));
  const out: HoursPoint[] = [];
  for (let h = 0; h <= last + 1e-9; h += step) out.push([h, median(usable.map((course) => carriedAt(course, h)))]);
  if (out.at(-1)![0] < last) out.push([last, median(usable.map((course) => carriedAt(course, last)))]);
  return out;
}

function carriedAt(course: readonly HoursPoint[], hours: number): number {
  if (hours <= course[0]![0]) return course[0]![1];
  if (hours >= course.at(-1)![0]) return course.at(-1)![1];
  return courseAt(course, hours)!.value;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The plan part of a window's regime key (`<counterKey>:<plan>[@instance]:...`), e.g. "max-20x",
 * "unknown-plan" or "mixed-plan". The server does not send the plan as its own field.
 */
export function windowPlanKey(window: Pick<RailWindow, "counterKey" | "regimeKey">): string | null {
  const { counterKey, regimeKey } = window;
  if (!counterKey || !regimeKey?.startsWith(`${counterKey}:`)) return null;
  const token = regimeKey.slice(counterKey.length + 1).split(":")[0]!.split("@")[0]!;
  return token || null;
}

export function windowPlanLabel(provider: string, planKey: string | null, day?: string): string {
  if (planKey == null || planKey === "unknown-plan") return translate("plan ?", "plan ?");
  if (planKey === "mixed-plan") return translate("plan change", "zmiana planu");
  return subscriptionPlan(provider, planKey, day) ?? planKey;
}

export interface WindowCounter {
  key: string;
  label: string;
  /** The host meter's own label, e.g. "7d"; a sublimit names its host. */
  hostLabel: string;
  windowHours: number | null;
  isSublimit: boolean;
  /** Windows of this counter, newest first; a sublimit's rows carry the sublimit's values. */
  rows: RailWindow[];
}

/** A sublimit as a window of its own: the host's time frame with the sublimit's reading. */
export function sublimitWindow(host: RailWindow, sub: RailSublimit): RailWindow {
  return {
    ...host,
    counterKey: sub.counterKey ?? `${windowCounterKey(host)}:scope:${sub.label}`,
    counterLabel: sub.label,
    label: sub.label,
    usedPercent: sub.usedPercent,
    percentBasis: sub.percentBasis,
    shape: sub.shape ?? null,
    activityShape: sub.activityShape ?? host.activityShape ?? null,
    regimeKey: sub.regimeKey ?? host.regimeKey ?? null,
    sampledAtIso: sub.sampledAtIso ?? host.sampledAtIso ?? null,
    sampleMachine: sub.sampleMachine ?? host.sampleMachine ?? null,
    trafficByMachine: sub.trafficByMachine ?? host.trafficByMachine ?? [],
    tokensTotal: sub.tokensTotal,
    usd: sub.usd,
    note: sub.note,
    scope: sub.label,
    sublimits: [],
  };
}

function counterName(label: string, hours: number | null): string {
  if (hours === 168) return translate("Week {0}", `Tydzień ${label}`, [label]);
  if (hours === 5) return translate("Session {0}", `Sesja ${label}`, [label]);
  return label;
}

const time = (window: RailWindow) => Date.parse(window.resetIso ?? window.startIso ?? "") || 0;

/**
 * One counter per meter the user sees. Windows read from the account and windows reconstructed from
 * the cadence carry different counter keys but are the same meter, so they share a counter; a
 * sublimit follows its host. `order` puts the longest or the shortest meter first.
 */
export function windowCounters(windows: RailWindow[], order: "longest" | "shortest"): WindowCounter[] {
  const counters = new Map<string, WindowCounter>();
  const add = (key: string, label: string, hostLabel: string, isSublimit: boolean, row: RailWindow) => {
    const counter = counters.get(key);
    if (counter) {
      if (!counter.rows.some((other) => other.key === row.key)) counter.rows.push(row);
      return;
    }
    counters.set(key, { key, label, hostLabel, windowHours: row.windowHours, isSublimit, rows: [row] });
  };
  for (const window of windows) {
    const hostLabel = window.counterLabel ?? window.label;
    // A sublimit window the server could not attach to a host still belongs to the sublimit's counter.
    if (window.scope != null) add(`sub:${hostLabel}:${window.scope}`, `↳ ${window.scope} ${hostLabel}`, hostLabel, true, window);
    else add(`host:${hostLabel}`, counterName(hostLabel, window.windowHours), hostLabel, false, window);
    for (const sub of window.sublimits) {
      add(`sub:${hostLabel}:${sub.label}`, `↳ ${sub.label} ${hostLabel}`, hostLabel, true, sublimitWindow(window, sub));
    }
  }
  const sign = order === "longest" ? -1 : 1;
  return [...counters.values()]
    .map((counter) => ({ ...counter, rows: [...counter.rows].sort((a, b) => time(b) - time(a)) }))
    .sort((a, b) => {
      const hours = sign * ((a.windowHours ?? 0) - (b.windowHours ?? 0));
      if (hours !== 0) return hours;
      if (a.hostLabel !== b.hostLabel) return a.hostLabel.localeCompare(b.hostLabel);
      return Number(a.isSublimit) - Number(b.isSublimit) || a.label.localeCompare(b.label);
    });
}

/** Compare keeps the current window plus up to four others; toggling never drops the last one. */
export const COMPARE_LIMIT = 5;

/**
 * The closed cycles compared with the current one: the user's choice, or the three newest.
 * `cycles` are newest first; the current cycle is always shown and never part of the choice.
 */
export function comparedCycles(cycles: ReadonlyArray<{ index: number; isActive: boolean }>, chosen: number[]): number[] {
  const closed = cycles.filter((cycle) => !cycle.isActive);
  const valid = chosen.filter((index) => closed.some((cycle) => cycle.index === index)).slice(0, COMPARE_LIMIT - 1);
  return valid.length > 0 ? valid : closed.slice(0, 3).map((cycle) => cycle.index);
}

export function toggleCompared(selected: number[], index: number): number[] {
  if (selected.includes(index)) return selected.length > 1 ? selected.filter((other) => other !== index) : selected;
  return selected.length < COMPARE_LIMIT - 1 ? [...selected, index] : selected;
}
