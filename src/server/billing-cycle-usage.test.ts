import { expect, test } from "bun:test";
import { aggregateCycleUnits, aggregateCycleUsage, pairedRunning, type CycleUnitAmounts, type CycleUnitsWindow, type CycleUsageWindow } from "./billing-cycle-usage";

const H = 3_600_000, D = 24 * H, WEEK = 7 * D;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const loaded = new Set<CycleUsageWindow>();
/** A window with linear readings every 6 h: % grows from 0 to `final`, the running API sum from 0 to `usd`. */
function window(startDay: number, lengthDays: number, final: number | null, usd: number | null, basis = "reset"): CycleUsageWindow {
  const start = T0 + startDay * D, end = start + lengthDays * D;
  const steps = Math.max(1, Math.round((end - start) / (6 * H)));
  const percents: Array<[number, number]> = [], running: Array<[number, number]> = [];
  for (let i = 1; i <= steps; i++) {
    const t = start + (i * (end - start)) / steps - 1;
    if (final !== null) percents.push([t, Math.round((final * i) / steps)]);
    if (usd !== null) running.push([t, (usd * i) / steps]);
  }
  const w: CycleUsageWindow = { start, end, basis, finalPercent: final, apiUsd: usd,
    detail: () => { loaded.add(w); return { percents, running }; } };
  return w;
}

test("whole windows count one each; a window cut by the cycle counts by its time inside and its % at the boundary", () => {
  const windows = [window(-3, 7, 70, 700), window(4, 7, 50, 500), window(11, 7, 80, 800)];
  const usage = aggregateCycleUsage({ start: T0, end: T0 + 14 * D }, windows, WEEK, T0 + 60 * D);
  expect(usage.touched).toBe(3);
  expect(usage.share).toBeCloseTo(4 / 7 + 1 + 3 / 7, 9);
  // First window: 70 % at its end minus its % at the cycle start (3 of 7 days: 30 %); last: its % after 3 of 7 days.
  expect(usage.usedPp).toBe(70 - 30 + 50 + 34);
  expect(usage.apiUsd).toBeCloseTo(700 - 300 + 500 + 800 * 12 / 28, 6);
  expect(usage.idle).toBe(0);
  expect(usage.observedShare).toBe(1);
  expect(usage.flags).toEqual([]);
  // Readings are parsed only for the windows a boundary cuts.
  expect(windows.map((w) => loaded.has(w))).toEqual([true, false, true]);
});

test("gaps between windows are idle capacity; an early reset still counts one window", () => {
  const windows = [window(0, 3, 40, 400), window(3.5, 7, 60, 600), window(10.5, 7, 10, 100)];
  const usage = aggregateCycleUsage({ start: T0, end: T0 + 10.5 * D }, windows, WEEK, T0 + 60 * D);
  expect(usage.share).toBeCloseTo(2, 9);
  expect(usage.earlyResets).toBe(1);
  expect(usage.idle).toBeCloseTo(0.5 / 7, 9);
  expect(usage.observedShare).toBe(1);
  expect(usage.flags).toEqual(["idle_gaps"]);
  expect(usage.usedPp).toBe(100);
});

test("time without readings lowers the coverage and is never filled; a window without % leaves the points unknown", () => {
  const silent = aggregateCycleUsage({ start: T0, end: T0 + 30 * D }, [window(20, 7, 50, 500)], WEEK, T0 + 60 * D);
  expect(silent.observedShare).toBeCloseTo(7 / 30, 9);
  expect(silent.flags).toContain("partial_coverage");
  expect(silent.usedPp).toBe(50);
  const unmetered = aggregateCycleUsage({ start: T0, end: T0 + 14 * D }, [window(0, 7, 30, 300), window(7, 7, null, 200)], WEEK, T0 + 60 * D);
  expect(unmetered.usedPp).toBeNull();
  expect(unmetered.apiUsd).toBe(500);
  expect(unmetered.flags).toContain("windows_without_percent");
  const noSums = aggregateCycleUsage({ start: T0, end: T0 + 7 * D }, [window(0, 7, 30, null)], WEEK, T0 + 60 * D);
  expect(noSums.apiUsd).toBeNull();
  const none = aggregateCycleUsage({ start: T0, end: T0 + 7 * D }, [], WEEK, T0 + 60 * D);
  expect([none.usedPp, none.apiUsd, none.touched]).toEqual([null, null, 0]);
});

test("the current cycle: the elapsed part to date and the minimal projection to its end", () => {
  const windows = [window(0, 7, 60, 600), window(7.5, 7, 20, 200, "scheduled")];
  const now = T0 + 9 * D;
  const usage = aggregateCycleUsage({ start: T0, end: T0 + 30 * D }, windows, WEEK, now);
  // Readings up to now only exist in the store; the fixture has the whole window, so the points are its final 20 %.
  expect(usage.share).toBeCloseTo(2, 9);
  expect(usage.idle).toBeCloseTo(0.5 / 7, 9);
  expect(usage.toDate).toBeCloseTo(1 + 0.5 / 7 + 1.5 / 7, 9);
  expect(usage.projection).toBeCloseTo(1 + 0.5 / 7 + 1.5 / 7 + 21 / 7, 9);
  expect(usage.observedShare).toBe(1);
});

/** A window whose running sums grow linearly over its days: `tokens` (90 % input, 60 % cached, 10 % output), $1 and 20–25 credits per 1000 tokens. */
function unitsWindow(startDay: number, lengthDays: number, tokens: number | null, credits = true): CycleUnitsWindow {
  const start = T0 + startDay * D, end = start + lengthDays * D;
  const amounts = (t: number) => ({ tokens: t, api_standard: t / 1000, credits_low: t / 50, credits_high: t / 40 });
  return { start, end, credits,
    usage: tokens === null ? null : { ...amounts(tokens), input: tokens * 0.9, cached: tokens * 0.6, output: tokens * 0.1 },
    running: () => Array.from({ length: lengthDays }, (_, i) => [start + (i + 1) * D, amounts((tokens ?? 0) * (i + 1) / lengthDays)] as const) };
}

test("used units: whole windows by their usage, a cut window by its running sums at the boundary, categories split like its usage", () => {
  const cycle = { start: T0 + 3 * D, end: T0 + 17 * D };
  // Days 0–7 cut at day 3 (4/7 inside), days 7–14 whole, days 14–21 cut at day 17 (3/7 inside).
  const units = aggregateCycleUnits(cycle, [unitsWindow(0, 7, 70_000), unitsWindow(7, 7, 140_000), unitsWindow(14, 7, 70_000), unitsWindow(28, 7, 1)])!;
  const tokens = 40_000 + 140_000 + 30_000;
  expect(units.tokens).toEqual({ input: tokens * 0.9, cached: tokens * 0.6, output: tokens * 0.1, total: tokens });
  expect(units.api_usd).toBeCloseTo(tokens / 1000, 9);
  expect(units.credits!.low).toBeCloseTo(tokens / 50, 9);
  // One window without credits makes the cycle's credits unknown; one without sums makes everything unknown, never 0.
  expect(aggregateCycleUnits(cycle, [unitsWindow(7, 7, 140_000), unitsWindow(14, 7, 70_000, false)])!.credits).toBeNull();
  expect(aggregateCycleUnits(cycle, [unitsWindow(7, 7, 140_000), unitsWindow(14, 7, null)])).toBeNull();
  expect(aggregateCycleUnits(cycle, [unitsWindow(28, 7, 1)])).toBeNull();
});

test("a 7-day allowance split without a reset at day 2 counts as one window, its points summed", () => {
  const a = { ...window(0, 2, 10, 100, "uncertain"), allowanceMs: WEEK, notReset: true };
  const b = { ...window(2, 5, 60, 600), allowanceMs: WEEK };
  const usage = aggregateCycleUsage({ start: T0, end: T0 + 14 * D }, [a, b, window(7, 7, 50, 500)], WEEK, T0 + 60 * D);
  expect(usage.share).toBeCloseTo(2, 9);
  expect(usage.usedPp).toBe(10 + 60 + 50);
  // The fragment's end is not an early reset.
  expect(usage.earlyResets).toBe(0);
  // Without the allowance the split counted two windows.
  expect(aggregateCycleUsage({ start: T0, end: T0 + 14 * D }, [window(0, 2, 10, 100), window(2, 5, 60, 600), window(7, 7, 50, 500)], WEEK, T0 + 60 * D).share).toBeCloseTo(3, 9);
});

test("a cut window's used units are paired traffic only: running sums start at the pairing", () => {
  // 30 units before the first reading (unpaired), 50 paired after it; 50 counted by the cycle's start, so 20 paired before it.
  const amounts = (tokens: number): CycleUnitAmounts => ({ tokens, api_standard: tokens / 10, credits_low: tokens, credits_high: tokens });
  const start = T0 - 3 * D, firstReading = T0 - 2 * D;
  const stored = [[firstReading, amounts(30)], [T0, amounts(50)], [T0 + 3 * D, amounts(80)]] as Array<readonly [number, CycleUnitAmounts]>;
  const running = pairedRunning(stored, { fromReset: false, start: firstReading, end: T0 + 3 * D }, minusUnits);
  const cut: CycleUnitsWindow = { start, end: T0 + 4 * D, credits: true, running: () => running,
    usage: { ...amounts(50), input: 40, cached: 20, output: 10 } };
  const units = aggregateCycleUnits({ start: T0, end: T0 + 14 * D }, [cut])!;
  expect(units.tokens.total).toBe(30);
  expect(units.api_usd).toBeCloseTo(3, 9);
  // From a confirmed reset the running sums are the paired ones already.
  expect(pairedRunning(stored, { fromReset: true, start, end: T0 + 3 * D }, (value) => value)).toEqual(stored);
});

const minusUnits = (value: CycleUnitAmounts, base: CycleUnitAmounts): CycleUnitAmounts => ({ tokens: value.tokens - base.tokens,
  api_standard: value.api_standard - base.api_standard, credits_low: value.credits_low - base.credits_low, credits_high: value.credits_high - base.credits_high });

test("a manual interval pairs only its own span: nothing before its first manual reading, its whole traffic after its last", () => {
  // A window from day 0 to 7 with probes, and a manual measurement from day 3 to day 4 holding 10 units.
  const amounts = (tokens: number): CycleUnitAmounts => ({ tokens, api_standard: tokens, credits_low: tokens, credits_high: tokens });
  const stored = [[T0 + 1 * D, amounts(5)], [T0 + 2 * D, amounts(8)], [T0 + 3 * D, amounts(12)], [T0 + 4 * D, amounts(22)], [T0 + 6 * D, amounts(40)]] as
    Array<readonly [number, CycleUnitAmounts]>;
  const running = pairedRunning(stored, { fromReset: false, start: T0 + 3 * D, end: T0 + 4 * D }, minusUnits);
  const window: CycleUnitsWindow = { start: T0, end: T0 + 7 * D, credits: true, running: () => running, usage: { ...amounts(10), input: 10, cached: 0, output: 0 } };
  // A cycle ending on day 2, before the measurement: no paired traffic.
  expect(aggregateCycleUnits({ start: T0 - 10 * D, end: T0 + 2 * D }, [window])!.api_usd).toBe(0);
  // Days 3–7: the measurement's 10 units.
  expect(aggregateCycleUnits({ start: T0 + 3 * D, end: T0 + 10 * D }, [window])!.api_usd).toBe(10);
  // A cut after the first reading at 100 % holds what that reading held.
  const limit = pairedRunning(stored, { fromReset: true, start: T0, end: T0 + 2 * D }, minusUnits);
  expect(limit.map(([, value]) => value.tokens)).toEqual([5, 8, 8, 8, 8]);
});

test("on one allowance the meter continues: a later fragment's points rise from where the previous one left it", () => {
  // No drop: 0 → 40, then 40 → 80 on the same allowance: 80 points used, not 120.
  const a = { ...window(0, 3, 40, 300, "uncertain"), allowanceMs: WEEK, notReset: true };
  const b = { ...window(3, 4, 80, 400), allowanceMs: WEEK, meterStart: 40 };
  expect(aggregateCycleUsage({ start: T0, end: T0 + 14 * D }, [a, b], WEEK, T0 + 60 * D).usedPp).toBe(80);
  // A cycle starting inside the second fragment counts from the meter's reading at the boundary (40 % in this fixture).
  expect(aggregateCycleUsage({ start: T0 + 5 * D, end: T0 + 14 * D }, [a, b], WEEK, T0 + 60 * D).usedPp).toBe(80 - 40);
  // Without a reading before the boundary the split by running sums starts from the meter at the fragment's start.
  const sparse = { ...b, detail: () => ({ percents: [[T0 + 6 * D, 70]] as Array<[number, number]>, running: [[T0 + 4 * D, 100], [T0 + 7 * D - 1, 400]] as Array<[number, number]> }) };
  expect(aggregateCycleUsage({ start: T0 + 5 * D, end: T0 + 14 * D }, [a, sparse], WEEK, T0 + 60 * D).usedPp).toBeCloseTo(80 - (40 + 40 * 100 / 400), 9);
});
