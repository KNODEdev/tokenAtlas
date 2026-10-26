import { tiboBounds, tiboDate, tiboMidnight } from "./tibo-challenge";
export interface TiboHour {
  at: number; account: string; model: string | null; mode: string | null; plan: string | null; funding: string | null;
  calls: number; input: number; cached: number; timed: number; output: number; ms: number;
  longCalls: number; longOutput: number; longMs: number;
}
export const tiboCohortKey = (row: TiboHour) => JSON.stringify([row.account, row.model, row.mode, row.plan, row.funding]);
export function tiboSpeedScope(row: TiboHour | undefined): "applicable" | "outside" | "unknown" {
  if (!row?.model || !row.mode) return "unknown";
  return /^gpt-(?:6-astra|6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(row.model)
    && ["default", "standard"].includes(row.mode) ? "applicable" : "outside";
}
export interface TiboSample {
  from: number; until: number; calls: number; timed: number; output: number; ms: number;
  longCalls: number; longOutput: number; longMs: number; input: number; cached: number;
  speed: number | null; cache: number | null; coverage: number | null;
}
export function tiboSample(hours: readonly TiboHour[], from: number, until: number): TiboSample {
  const sample: TiboSample = { from, until, calls: 0, timed: 0, output: 0, ms: 0, longCalls: 0, longOutput: 0,
    longMs: 0, input: 0, cached: 0, speed: null, cache: null, coverage: null };
  for (const row of hours) {
    if (row.at < from || row.at + 3_600_000 > until) continue;
    for (const field of ["calls", "timed", "output", "ms", "longCalls", "longOutput", "longMs", "input", "cached"] as const) {
      sample[field] += row[field];
      if (!Number.isSafeInteger(sample[field])) throw new Error("Challenge totals exceed the safe integer range");
    }
  }
  sample.speed = sample.longMs > 0 ? sample.longOutput * 1000 / sample.longMs : null;
  sample.cache = sample.input > 0 ? sample.cached * 100 / sample.input : null;
  sample.coverage = sample.calls > 0 ? sample.timed / sample.calls : null;
  return sample;
}
/** Seven Pacific calendar days per side; omit rollout day and the unfinished current hour. */
export function tiboComparison(hours: readonly TiboHour[], day: number, nowMs: number) {
  const beforeFrom = tiboMidnight(tiboDate(day - 7)), beforeUntil = tiboBounds(day).from;
  const afterFrom = tiboBounds(day).until, fullUntil = tiboMidnight(tiboDate(day + 8));
  const until = Math.max(afterFrom, Math.min(fullUntil, Math.floor(nowMs / 3_600_000) * 3_600_000));
  const before = tiboSample(hours, beforeFrom, Math.min(beforeUntil, Math.max(beforeFrom, Math.floor(nowMs / 3_600_000) * 3_600_000)));
  const after = tiboSample(hours, afterFrom, until);
  const speedChange = before.speed !== null && before.speed > 0 && after.speed !== null ? (after.speed / before.speed - 1) * 100 : null;
  const cacheChange = before.cache !== null && after.cache !== null ? after.cache - before.cache : null;
  return { before, after, speedChange, cacheChange, complete: until === fullUntil,
    speedEnough: before.longCalls >= 30 && after.longCalls >= 30 && (before.coverage ?? 0) >= .8 && (after.coverage ?? 0) >= .8,
    cacheEnough: before.calls >= 30 && after.calls >= 30 };
}
