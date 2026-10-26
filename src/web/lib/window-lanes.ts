import type { RosterCard } from "./roster";

/**
 * Limits → Limit windows → List for all subscriptions: each subscription's current window on one
 * time axis, projected forward at its present pace. Percentages of different subscriptions are never
 * added; each lane only answers "is this one usable at hour h, and how much of it is lost at reset".
 */
export type LaneCard = Pick<RosterCard, "id" | "plan" | "spent" | "usedPercent" | "elapsedPercent" | "remainingHours" | "projectedEndPercent">;

export interface Lane {
  id: string;
  /** Hours from now until the current window resets. */
  resetHours: number;
  windowHours: number;
  usedPercent: number;
  /** Percent of the window per hour; the card's own projection when it has one. */
  ratePerHour: number;
  spent: boolean;
  /** Free and no-plan subscriptions are drawn but never suggested. */
  paid: boolean;
}

export interface LaneSegment { from: number; to: number; state: "open" | "spent" }

export function laneOf(card: LaneCard, fallbackWindowHours: number): Lane | null {
  const used = card.usedPercent;
  const resetHours = card.remainingHours;
  if (used == null || resetHours == null || !Number.isFinite(used) || !Number.isFinite(resetHours)) return null;
  const elapsed = card.elapsedPercent;
  const windowHours = elapsed != null && elapsed < 100 && resetHours > 0 ? resetHours / (1 - elapsed / 100) : fallbackWindowHours;
  const elapsedHours = elapsed != null ? windowHours * elapsed / 100 : windowHours - resetHours;
  const ratePerHour = card.projectedEndPercent != null && resetHours > 0
    ? Math.max(0, (card.projectedEndPercent - used) / resetHours)
    : elapsedHours > 0 ? used / elapsedHours : 0;
  const plan = (card.plan ?? "none").toLowerCase();
  return {
    id: card.id,
    resetHours,
    windowHours: windowHours > 0 ? windowHours : fallbackWindowHours,
    usedPercent: used,
    ratePerHour,
    spent: card.spent || used >= 100,
    paid: plan !== "free" && plan !== "none",
  };
}

/** Projected percent of the window that contains hour `h`; later windows assume the same pace. */
export function percentAt(lane: Lane, h: number): number {
  if (h < lane.resetHours) return lane.spent ? 100 : Math.min(100, lane.usedPercent + lane.ratePerHour * h);
  return Math.min(100, lane.ratePerHour * ((h - lane.resetHours) % lane.windowHours));
}

export function hoursToReset(lane: Lane, h: number): number {
  if (h < lane.resetHours) return lane.resetHours - h;
  return lane.windowHours - ((h - lane.resetHours) % lane.windowHours);
}

/** Projected percent at the end of the window that contains hour `h`. */
export function endPercentAt(lane: Lane, h: number): number {
  if (h < lane.resetHours) return lane.spent ? 100 : Math.min(100, lane.usedPercent + lane.ratePerHour * lane.resetHours);
  return Math.min(100, lane.ratePerHour * lane.windowHours);
}

/** Hours from `h` until the window runs out before its reset, or null when it lasts. */
export function exhaustionIn(lane: Lane, h: number): number | null {
  const now = percentAt(lane, h);
  if (now >= 100) return 0;
  if (endPercentAt(lane, h) < 100 || lane.ratePerHour <= 0) return null;
  return (100 - now) / lane.ratePerHour;
}

/** Open and spent stretches of [0, horizon]; window boundaries are the resets. */
export function laneSegments(lane: Lane, horizon: number): { segments: LaneSegment[]; resets: number[] } {
  const resets: number[] = [];
  for (let r = lane.resetHours; r < horizon; r += lane.windowHours) resets.push(r);
  const bounds = [0, ...resets, horizon];
  const segments: LaneSegment[] = [];
  const push = (from: number, to: number, state: LaneSegment["state"]) => {
    if (to <= from) return;
    const last = segments[segments.length - 1];
    if (last && last.state === state && last.to === from) last.to = to;
    else segments.push({ from, to, state });
  };
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    const left = exhaustionIn(lane, from);
    const out = left == null ? to : Math.min(to, from + left);
    push(from, out, "open");
    push(out, to, "spent");
  }
  return { segments, resets };
}

export interface Suggestion { id: string; lostPercent: number; resetHours: number }

/**
 * The paid subscription whose unused window is lost soonest: open at `h`, lasting until its reset,
 * ranked by the percent left at reset per hour remaining.
 */
export function suggestLane(lanes: Lane[], h: number): Suggestion | null {
  let best: (Suggestion & { score: number }) | null = null;
  for (const lane of lanes) {
    if (!lane.paid || percentAt(lane, h) >= 100) continue;
    const end = endPercentAt(lane, h);
    if (end >= 100) continue;
    const resetHours = hoursToReset(lane, h);
    const lostPercent = 100 - end;
    const score = lostPercent / Math.max(resetHours, 0.25);
    if (!best || score > best.score) best = { id: lane.id, lostPercent, resetHours, score };
  }
  return best && { id: best.id, lostPercent: best.lostPercent, resetHours: best.resetHours };
}
