import type { Database } from "bun:sqlite";
import { readLimitWindowHeaders, readLimitWindowsWhere } from "../db/limit-windows";
import type { ClaudeRosterMeters, RosterMeter } from "../shared/roster-meters";

/** Reads at most two current published windows; no history, sums or metadata preparation. */
export function readClaudeRosterMeters(db: Database, account: string, nowMs: number): ClaudeRosterMeters {
  const current = readLimitWindowHeaders(db, "claude", account)
    .filter(row => Date.parse(row.start) <= nowMs && nowMs < Date.parse(row.end));
  const ids: string[] = [];
  for (const kind of ["weekly_all", "session"]) {
    const newest = current.filter(row => JSON.parse(row.counter)[0] === kind)
      .sort((a, b) => a.start.localeCompare(b.start)).at(-1);
    if (newest) ids.push(newest.id);
  }
  const result: ClaudeRosterMeters = { weekly: null, session: null };
  if (!ids.length) return result;
  for (const window of readLimitWindowsWhere(db, "claude", account, () => true, ids)) {
    const reading = window.readings.filter(row => Date.parse(row.ts) <= nowMs).at(-1);
    if (!reading || !Number.isFinite(reading.percent)) continue;
    const start = Date.parse(window.start), end = Date.parse(window.end);
    const meter: RosterMeter = {
      window_id: window.id, counter: window.counter, window_start: window.start, reset_at: window.end,
      measured_at: reading.ts, percent: reading.percent, baseline_percent: window.startDrop?.after
        ?? (start === Date.parse(window.reset) - window.window_minutes * 60_000 ? 0 : null),
      elapsed_percent: Math.max(0, Math.min(100, (nowMs - start) / (end - start) * 100)),
      remaining_hours: Math.max(0, (end - nowMs) / 3_600_000),
    };
    if (JSON.parse(window.counter)[0] === "weekly_all") result.weekly = meter;
    else result.session = meter;
  }
  return result;
}
