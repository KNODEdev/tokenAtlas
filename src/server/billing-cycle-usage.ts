import type { BillingCycleUnits } from "../shared/billing-cycles";

/**
 * What one billing cycle used of its limit windows (docs/billing-cycles-design-2026-10-08.md §2), from stored rows only:
 * `limit_windows` (the % readings) and `window_usage` (the running sums at each reading). Pure: the producer loads the
 * windows, and the readings of a window only when a cycle boundary cuts it.
 *
 * - Capacity counts every real window as one (100 points), also one shortened by an early reset; a window cut by the
 *   cycle counts by the part of its own time inside the cycle.
 * - Time between two windows (a window opens only at first use after a reset) is unused capacity: idle, in nominal
 *   windows, flagged (§12.5). A longer silence, and time before the first or after the last window, has no readings:
 *   it lowers `observed_share` and is never filled with nominal windows.
 * - Points used are the % increases of the windows' parts inside the cycle; at a boundary without a reading the window's
 *   % is split by its running API sums. A touched window without any % reading leaves the points unknown, never 0.
 */
export interface CycleUsageWindow {
  start: number;
  end: number;
  /** `reset` | `scheduled` | `uncertain`: how the window ended. */
  basis: string;
  /** The window's last % reading; null without readings. */
  finalPercent: number | null;
  /** API Standard value of the window's counted traffic; null when its sums are not stored. */
  apiUsd: number | null;
  /** Its % readings and running API sums, read only for a window a cycle boundary cuts. */
  detail(): { percents: ReadonlyArray<readonly [number, number]>; running: ReadonlyArray<readonly [number, number]> };
  /**
   * The length of the allowance the window belongs to when it is a fragment of one (windows joined by ends that were not
   * resets: a split at a plan change or a moved schedule); the window's own length otherwise.
   */
  allowanceMs?: number;
  /** Its end was not a reset (a fragment before the next one) or was a plan change: never an early reset. */
  notReset?: boolean;
  /**
   * A fragment after the first of an allowance: the meter's value at its start (the previous fragment's last reading,
   * or its own first one if lower: the meter may have restarted), the base its used points rise from.
   */
  meterStart?: number;
  /** Its % rose while no traffic of it is stored (used elsewhere): its sums are unknown, never 0. */
  trafficUnseen?: boolean;
}

export interface CycleUsage {
  share: number;
  idle: number;
  touched: number;
  /** Windows cut short by an early reset (counted whole). */
  earlyResets: number;
  /** Part of the elapsed cycle covered by windows and known idle time; null before the cycle has started. */
  observedShare: number | null;
  usedPp: number | null;
  apiUsd: number | null;
  /** Current cycle: the elapsed part of its windows (with idle time) and that plus the rest of the cycle in nominal windows. */
  toDate: number | null;
  projection: number | null;
  flags: string[];
  /**
   * Each touched window's share of the cycle (by its start) with its end and its whole rise on the allowance meter (null
   * without %), and each idle gap with the start of the window before it.
   */
  parts?: Array<{ start: number; share: number; end?: number; rise?: number | null }>;
  idleParts?: Array<{ after: number | null; idle: number }>;
}

/** A silence between windows longer than this is time without readings, not an unused window. */
const IDLE_LIMIT = 2;

/** The value of the last reading at or before `at`; null when none is that early. */
function lastAt(points: ReadonlyArray<readonly [number, number]>, at: number): number | null {
  let value: number | null = null;
  for (const [t, v] of points) { if (t <= at) value = v; else break; }
  return value;
}

/**
 * The window's % at instant `at` inside it: the last reading at or before it, else the final % split by the running API
 * sums (flagged), else 0 when the window has no sums either (flagged as well).
 */
function percentAt(window: CycleUsageWindow, at: number, flags: Set<string>): number {
  const { percents, running } = window.detail();
  const read = lastAt(percents, at);
  if (read !== null) return read;
  flags.add("boundary_prorated");
  const base = window.meterStart ?? 0, total = window.apiUsd, before = lastAt(running, at);
  if (window.finalPercent === null || !total || before === null) return base;
  return base + (window.finalPercent - base) * Math.min(1, before / total);
}
function apiAt(window: CycleUsageWindow, at: number): number {
  return lastAt(window.detail().running, at) ?? 0;
}

/**
 * Aggregates one counter's windows (sorted by start; include the neighbours just outside the cycle, so the gaps at its
 * edges are known) over the cycle `[start, end)`. `now` bounds the elapsed part; `nominalMs` is the counter's window length.
 */
export function aggregateCycleUsage(cycle: { start: number; end: number }, windows: readonly CycleUsageWindow[], nominalMs: number, now: number): CycleUsage {
  const flags = new Set<string>();
  const elapsedEnd = Math.min(cycle.end, now);
  let share = 0, idle = 0, touched = 0, earlyResets = 0, known = 0, toDate = 0;
  let usedPp: number | null = 0, apiUsd: number | null = 0;
  const parts: NonNullable<CycleUsage["parts"]> = [], idleParts: Array<{ after: number | null; idle: number }> = [];
  for (const window of windows) {
    const from = Math.max(window.start, cycle.start), until = Math.min(window.end, cycle.end);
    if (until <= from) continue;
    // A fragment counts by its part of the whole allowance, so a split without a reset is still one window.
    const length = window.allowanceMs ?? window.end - window.start;
    touched++;
    share += (until - from) / length;
    parts.push({ start: window.start, share: (until - from) / length, end: window.end,
      rise: window.finalPercent === null ? null : Math.max(0, window.finalPercent - (window.meterStart ?? 0)) });
    if (window.basis === "reset" && !window.notReset && length < 0.9 * nominalMs) earlyResets++;
    if (window.basis === "uncertain") flags.add("window_end_uncertain");
    known += Math.max(0, Math.min(until, elapsedEnd) - from);
    toDate += Math.max(0, Math.min(until, now) - from) / length;
    if (window.finalPercent === null) { usedPp = null; flags.add("windows_without_percent"); }
    else if (usedPp !== null) {
      // On one allowance the meter continues: a later fragment's points rise from where the previous one left it.
      const high = window.end <= cycle.end ? window.finalPercent : percentAt(window, cycle.end, flags);
      const low = window.start < cycle.start ? percentAt(window, cycle.start, flags) : window.meterStart ?? 0;
      usedPp += Math.max(0, high - low);
    }
    if (window.apiUsd === null) { apiUsd = null; flags.add(window.trafficUnseen ? "window_traffic_unseen" : "window_sums_missing"); }
    else if (apiUsd !== null) {
      const high = window.end <= cycle.end ? window.apiUsd : apiAt(window, cycle.end);
      const low = window.start < cycle.start ? apiAt(window, cycle.start) : 0;
      apiUsd += Math.max(0, high - low);
    }
  }
  // Gaps between consecutive windows, as far as they fall in the elapsed cycle.
  for (let i = 1; i < windows.length; i++) {
    const gapFrom = Math.max(windows[i - 1]!.end, cycle.start), gapUntil = Math.min(windows[i]!.start, elapsedEnd);
    const gap = windows[i]!.start - windows[i - 1]!.end;
    if (gapUntil <= gapFrom || gap <= 0) continue;
    if (gap < IDLE_LIMIT * nominalMs) {
      idle += (gapUntil - gapFrom) / nominalMs; known += gapUntil - gapFrom; flags.add("idle_gaps");
      idleParts.push({ after: windows[i - 1]!.start, idle: (gapUntil - gapFrom) / nominalMs });
    }
  }
  // After the last window, up to now: the next window opens only at first use.
  const last = windows.at(-1);
  if (last && last.end < elapsedEnd && elapsedEnd - last.end < nominalMs && now <= cycle.end) {
    const from = Math.max(last.end, cycle.start);
    idle += (elapsedEnd - from) / nominalMs; known += elapsedEnd - from; flags.add("idle_gaps");
    idleParts.push({ after: last.start, idle: (elapsedEnd - from) / nominalMs });
  }
  if (touched === 0) { usedPp = null; apiUsd = null; flags.add("no_windows"); }
  const elapsed = elapsedEnd - cycle.start;
  const observedShare = elapsed > 0 ? Math.min(1, known / elapsed) : null;
  if (observedShare !== null && observedShare < 0.999) flags.add("partial_coverage");
  const current = cycle.start <= now && now < cycle.end;
  return {
    share, idle, touched, earlyResets, observedShare, usedPp, apiUsd,
    toDate: current ? toDate + idle : null,
    projection: current ? toDate + idle + (cycle.end - now) / nominalMs : null,
    flags: [...flags].sort(), parts, idleParts,
  };
}

/**
 * Running sums on the window's paired interval (`pairingBounds`): the stored running sums count the window's traffic from
 * its start to its last reading, while its paired usage runs from its start after a confirmed reset (else from its first,
 * or first manual, reading) to its last manual reading or first reading at 100 %. Before the pairing start a point holds
 * nothing paired; after the pairing end it holds what the pairing end held. So cutting the window at a cycle boundary
 * counts paired traffic only, the same traffic as its usage.
 */
export function pairedRunning<T>(running: ReadonlyArray<readonly [number, T]>, bounds: { fromReset: boolean; start: number; end: number },
  minus: (value: T, base: T) => T): Array<readonly [number, T]> {
  if (!running.length) return [];
  const at = (instant: number) => { let value: T | null = null; for (const [t, v] of running) { if (t <= instant) value = v; else break; } return value; };
  const base = bounds.fromReset ? null : at(bounds.start), end = at(bounds.end);
  return running.map(([t, value]) => {
    const held = t > bounds.end && end !== null ? end : value;
    if (base === null) return [t, held] as const;
    return [t, t <= bounds.start ? minus(base, base) : minus(held, base)] as const;
  });
}

/** Amounts of a window's traffic in every unit a cycle reports. */
export interface CycleUnitAmounts { tokens: number; api_standard: number; credits_low: number; credits_high: number }
export interface CycleUnitsWindow {
  start: number;
  end: number;
  /** The window's paired usage with its token categories (cached within input); null when its sums are not stored. */
  usage: (CycleUnitAmounts & { input: number; cached: number; output: number }) | null;
  /** Whether the window's credits exist (Codex, all calls billed in credits). */
  credits: boolean;
  /** Running sums at its readings, read only for a window a cycle boundary cuts. */
  running(): ReadonlyArray<readonly [number, CycleUnitAmounts]>;
}
/** Null credits when a touched window has none (not Codex, or calls from before credit billing). */
export type CycleUnits = BillingCycleUnits;

/**
 * What the cycle used in tokens, API Standard dollars and credits: the same parts of the touched windows as the API value
 * of `aggregateCycleUsage` (a cut window by its running sums at the boundary). Running sums have no token categories:
 * a cut part is split like its window's usage. Null without touched windows or when one has no sums (never 0).
 */
export function aggregateCycleUnits(cycle: { start: number; end: number }, windows: readonly CycleUnitsWindow[]): CycleUnits | null {
  let input = 0, cached = 0, output = 0, api = 0, low = 0, high = 0, touched = 0, credits = true;
  const zero: CycleUnitAmounts = { tokens: 0, api_standard: 0, credits_low: 0, credits_high: 0 };
  for (const window of windows) {
    if (Math.min(window.end, cycle.end) <= Math.max(window.start, cycle.start)) continue;
    touched++;
    const usage = window.usage;
    if (!usage) return null;
    credits &&= window.credits;
    if (window.start >= cycle.start && window.end <= cycle.end) {
      input += usage.input; cached += usage.cached; output += usage.output;
      api += usage.api_standard; low += usage.credits_low; high += usage.credits_high;
      continue;
    }
    const at = (instant: number): CycleUnitAmounts => {
      let value = zero;
      for (const [t, amounts] of window.running()) { if (t <= instant) value = amounts; else break; }
      return value;
    };
    const top = window.end <= cycle.end ? usage : at(cycle.end), bottom = window.start < cycle.start ? at(cycle.start) : zero;
    const tokens = Math.max(0, top.tokens - bottom.tokens);
    const share = usage.tokens > 0 ? tokens / usage.tokens : 0;
    input += usage.input * share; cached += usage.cached * share; output += usage.output * share;
    api += Math.max(0, top.api_standard - bottom.api_standard);
    low += Math.max(0, top.credits_low - bottom.credits_low); high += Math.max(0, top.credits_high - bottom.credits_high);
  }
  if (!touched) return null;
  const tokens = { input: Math.round(input), cached: Math.round(cached), output: Math.round(output), total: 0 };
  tokens.total = tokens.input + tokens.output;
  return { tokens, api_usd: api, credits: credits ? { low, high } : null };
}
