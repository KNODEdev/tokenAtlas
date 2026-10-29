import type { CodexComparisonWindow as Window, TimelineMarker } from "../../shared/codex-accounting";
import { CODEX_PROMOTIONS, type CapacityBasis } from "../../shared/codex-promotions";
import { capacityMarkerType } from "./capacity-marker-visibility";
import { capacityFull, capacityIsLowerBound, type CapacityUnit } from "./codex-capacity";

/**
 * Before / after: what one full 7-day allowance buys in the cycles around chosen events. The values are the Cycles
 * table's own `capacityFull`; this module only picks cycles and places markers, it computes no new capacity.
 */
export const WEEKLY_MINUTES = 10080;
/** Samples below this meter increase extrapolate too far to compare one week with another. */
export const BEFORE_AFTER_MIN_PP = 40;
export const BEFORE_AFTER_MAX_EVENTS = 4;
/** Cycles drawn on each side of an event, and in the closing "now" run. */
export const BEFORE_AFTER_SIDE = 2;
/** The projection asks "if the allowance were halved", e.g. 20× → 10×. */
export const PROJECTION_FRACTION = 0.5;

export interface BeforeAfterCycle { window: Window; value: number; start: number; end: number; lowerBound: boolean }
export type EventTone = "warn" | "crit";
/** Events whose dates fall between the same two cycles share one marker. */
export interface BeforeAfterEvent { markers: TimelineMarker[]; day: string; tone: EventTone; split: number }
export type BarRole = "before" | "after" | "now";
export interface BeforeAfterBar { cycle: BeforeAfterCycle; role: BarRole; index: number }
/** One group of consecutive cycles; `markers.get(i)` stands before `bars[i]` (an event between bar i−1 and bar i). */
export interface BeforeAfterRun { bars: BeforeAfterBar[]; markers: Map<number, BeforeAfterEvent> }
export interface BeforeAfterHeadline { after: number | null; now: number | null; change: number | null; event: BeforeAfterEvent | null }
export interface BeforeAfterLayout { runs: BeforeAfterRun[]; events: BeforeAfterEvent[]; headline: BeforeAfterHeadline }

const startOf = (window: Window) => Date.parse(window.cycle_start ?? window.start);
const endOf = (window: Window) => Date.parse(window.cycle_end ?? window.reset);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

export const isWeeklyWindow = (window: Window) => (window.window_minutes ?? WEEKLY_MINUTES) === WEEKLY_MINUTES;

/** Weekly cycles with an estimate from at least `minPp` of the meter, oldest first. */
export function eligibleCycles(windows: readonly Window[], unit: CapacityUnit, basis: CapacityBasis = "observed", minPp = BEFORE_AFTER_MIN_PP): BeforeAfterCycle[] {
  return windows.flatMap(window => {
    if (!isWeeklyWindow(window) || !(window.observed_pp >= minPp)) return [];
    const value = capacityFull(window, unit, basis), start = startOf(window);
    return value === null || !Number.isFinite(start) ? [] : [{ window, value, start, end: endOf(window), lowerBound: capacityIsLowerBound(window, unit) }];
  }).sort((a, b) => a.start - b.start);
}

/** A cycle is "before" an event when it starts before the event's day (UTC). */
export function eventSplit(cycles: readonly BeforeAfterCycle[], marker: TimelineMarker): number {
  const time = dayStart(marker.day);
  return cycles.filter(cycle => cycle.start < time).length;
}

const promotionKind = (marker: TimelineMarker) => marker.id.startsWith("promotion:")
  ? CODEX_PROMOTIONS.find(promotion => marker.id.startsWith(`promotion:${promotion.id}:`))?.kind ?? null : null;

/** Plan changes are drawn in brick, price and API changes (and everything else) in ochre. */
export function isPlanChange(marker: TimelineMarker): boolean {
  return promotionKind(marker) === "policy";
}
export function markerTone(marker: TimelineMarker): EventTone {
  return isPlanChange(marker) || marker.color === "crit" ? "crit" : "warn";
}

/** Which events the chart offers first: plan changes, price changes, promotions, the user's own, resets, models. */
export function markerPriority(marker: TimelineMarker): number {
  if (isPlanChange(marker)) return 0;
  const type = capacityMarkerType(marker);
  return type === "price" ? 1 : type === "promotion" ? 2 : type === "event" ? 3 : type === "reset" ? 4 : 5;
}

/** An event can be drawn only with at least one eligible cycle on each side. */
export function drawableMarkers(markers: readonly TimelineMarker[], cycles: readonly BeforeAfterCycle[]): TimelineMarker[] {
  return markers.filter(marker => { const split = eventSplit(cycles, marker); return split > 0 && split < cycles.length; });
}

/** Up to `max` events by priority, at most one per position between cycles, so each default marker shows a change. */
export function defaultEventIds(markers: readonly TimelineMarker[], cycles: readonly BeforeAfterCycle[], max = BEFORE_AFTER_MAX_EVENTS): string[] {
  const ranked = drawableMarkers(markers, cycles)
    .sort((a, b) => markerPriority(a) - markerPriority(b) || dayStart(a.day) - dayStart(b.day));
  const splits = new Set<number>(), chosen: string[] = [];
  for (const marker of ranked) {
    if (chosen.length >= max) break;
    const split = eventSplit(cycles, marker);
    if (splits.has(split)) continue;
    splits.add(split); chosen.push(marker.id);
  }
  return chosen;
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export const relativeChange = (before: number | null, after: number | null) =>
  before === null || after === null || before <= 0 ? null : (after / before - 1) * 100;

/**
 * The chart's cycles: for each event the cycles on each side, then the latest cycles ("now"). A cycle is drawn once;
 * events sharing a position merge, and overlapping neighbourhoods join into one run with each marker at its true place.
 */
export function beforeAfterLayout(cycles: readonly BeforeAfterCycle[], selected: readonly TimelineMarker[], side = BEFORE_AFTER_SIDE): BeforeAfterLayout {
  const bySplit = new Map<number, TimelineMarker[]>();
  for (const marker of drawableMarkers(selected, cycles)) {
    const split = eventSplit(cycles, marker);
    bySplit.set(split, [...bySplit.get(split) ?? [], marker]);
  }
  const events = [...bySplit.entries()].sort(([a], [b]) => a - b).map(([split, markers]): BeforeAfterEvent => {
    const ordered = [...markers].sort((a, b) => markerPriority(a) - markerPriority(b) || dayStart(a.day) - dayStart(b.day));
    return { markers: ordered, day: ordered[0]!.day, tone: ordered.some(marker => markerTone(marker) === "crit") ? "crit" : "warn", split };
  });
  // Each event gets its own group, even when its cycles directly follow the previous group's. An event whose split
  // falls inside the previous group (its "before" cycle is already drawn) extends that group instead.
  const groups: { from: number; to: number; events: BeforeAfterEvent[] }[] = [];
  for (const event of events) {
    const last = groups.at(-1), to = Math.min(cycles.length, event.split + side) - 1;
    if (last && event.split - 1 <= last.to) { last.to = Math.max(last.to, to); last.events.push(event); continue; }
    groups.push({ from: Math.max(last ? last.to + 1 : 0, event.split - side), to, events: [event] });
  }
  const claimed = groups.at(-1)?.to ?? -1;
  const nowFrom = Math.max(claimed + 1, cycles.length - side);
  if (nowFrom < cycles.length) groups.push({ from: nowFrom, to: cycles.length - 1, events: [] });
  const runs = groups.map((group): BeforeAfterRun => {
    const markers = new Map(group.events.map(event => [event.split - group.from, event]));
    const firstSplit = group.events[0]?.split;
    return { markers, bars: Array.from({ length: group.to - group.from + 1 }, (_, offset) => {
      const index = group.from + offset;
      // A group without an event is the latest cycles: "now", in the subscription's colour.
      return { cycle: cycles[index]!, index, role: firstSplit === undefined ? "now" : index < firstSplit ? "before" : "after" };
    }) };
  });
  const first = events[0] ?? null;
  const after = first ? median(cycles.slice(first.split, first.split + side).map(cycle => cycle.value)) : null;
  const now = median(cycles.slice(-side).map(cycle => cycle.value));
  return { runs, events, headline: { after, now, change: relativeChange(after, now), event: first } };
}

/** The projection bar: a fraction of the latest cycle, never a measurement. */
export function projectionValue(cycles: readonly BeforeAfterCycle[], fraction = PROJECTION_FRACTION): number | null {
  const latest = cycles.at(-1);
  return latest ? latest.value * fraction : null;
}

/** Another subscription's typical week: the median of its eligible weekly cycles that started in the last 31 days. */
export function recentMedian(windows: readonly Window[], unit: CapacityUnit, until: string, basis: CapacityBasis = "observed", days = 31) {
  const from = dayStart(until) + 86_400_000 - days * 86_400_000;
  const recent = eligibleCycles(windows, unit, basis).filter(cycle => cycle.start >= from);
  return { value: median(recent.map(cycle => cycle.value)), count: recent.length, lowerBound: recent.some(cycle => cycle.lowerBound), cycles: recent };
}
