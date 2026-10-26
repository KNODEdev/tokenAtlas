import type { CodexTrafficPeriod } from "../shared/codex-accounting";
export type { CodexTrafficPeriod } from "../shared/codex-accounting";
import type { CodexProbe } from "./codex-calibration";
import type { Database } from "bun:sqlite";
import { queryRows } from "./data-groups";
import { codexReadingEvidenceSql } from "../db/codex-ledger-canonical";
import { sortByInstant } from "./instant-order";

/**
 * Session counters preserve historical anchors before periodic probing was enabled. `owner` is the
 * account of a home at an instant (`CodexAccountSelector.accountAt`): a home whose reset spans an
 * ownership change, or a gap, cannot certify one account's cycle.
 */
export function historicalTrafficProbes(db: Database, owner: (home: string, ts: string) => string | null, windowMinutes = 10080,
  range?:{from:string;until:string}): CodexProbe[] {
  const cols = new Set((db.query("PRAGMA table_info(ratelimit)").all() as Array<{ name: string }>).map(c => c.name));
  if (!["home", "ts", "resets_at", "window_minutes", "limit_id"].every(c => cols.has(c))) return [];
  const rows = queryRows<Record<string,unknown>>(db, `SELECT r.home, r.resets_at, MIN(r.ts) AS first, MAX(r.ts) AS last FROM ratelimit r
    WHERE r.window_minutes=? AND r.limit_id='codex' AND r.resets_at IS NOT NULL AND ${codexReadingEvidenceSql(db, "r")}
    ${range?"AND r.ts>=? AND r.ts<?":""}
    GROUP BY r.home,r.resets_at`, [windowMinutes,...(range?[range.from,range.until]:[])]) as Array<{ home: string; resets_at: number; first: string; last: string }>;
  const anchors = new Map<string, { account: string; reset: string; first: string; last: string }>();
  for (const row of rows) {
    if (!Number.isFinite(row.resets_at) || row.resets_at <= 0) continue;
    const account = owner(row.home, row.first);
    if (!account || owner(row.home, row.last) !== account) continue;
    const reset = new Date(row.resets_at * 1000).toISOString();
    const key = JSON.stringify([account, reset]);
    const anchor = anchors.get(key) ?? { account, reset, first: row.first, last: row.last };
    if (row.first < anchor.first) anchor.first = row.first;
    if (row.last > anchor.last) anchor.last = row.last;
    anchors.set(key, anchor);
  }
  return [...anchors.values()].flatMap(a => [a.first, a.last].map(ts => ({ subject: a.account, ts,
    kind: "historical-anchor", plan: null, used_percent: 0, resets_at: a.reset, window_minutes: windowMinutes })));
}

/** Scheduled reset timestamps are boundaries only when the next cycle confirms them.
 * Early resets are bracketed by probes: traffic in that uncertain gap stays unassigned. */
export function codexTrafficPeriods(probes: CodexProbe[], since: string, untilExclusive: string, windowMinutes = 10080): CodexTrafficPeriod[] {
  const streams = new Map<string, CodexProbe[]>();
  for (const p of probes) {
    if (p.window_minutes !== windowMinutes || !Number.isFinite(Date.parse(p.ts)) || !p.resets_at || !Number.isFinite(Date.parse(p.resets_at))) continue;
    const stream = streams.get(p.subject) ?? [];
    stream.push(p); streams.set(p.subject, stream);
  }
  const periods: CodexTrafficPeriod[] = [];
  const lower = Date.parse(since), upper = Date.parse(untilExclusive);
  for (const [account, stream] of streams) {
    sortByInstant(stream, p => p.ts);
    let first = stream[0]!, previous = first, start = Date.parse(first.ts), startReset = false;
    const seenAnchors = [Date.parse(first.resets_at!)];
    const append = (end: number, endReset: boolean) => {
      const clippedStart = Math.max(lower, start), clippedEnd = Math.min(upper, end);
      if (clippedEnd <= clippedStart) return;
      periods.push({ account, start: new Date(clippedStart).toISOString(), end: new Date(clippedEnd).toISOString(),
        start_reset: startReset && clippedStart === start, end_reset: endReset && clippedEnd === end,
        events: 0, tokens: 0, fast_tokens: 0, unknown_tokens: 0, api: 0, credits: 0,
        priced_tokens: 0, priced_events: 0, models: Object.create(null) });
    };
    for (const p of stream.slice(1)) {
      const time = Date.parse(p.ts), previousTime = Date.parse(previous.ts);
      if (time <= previousTime) continue;
      const changed = Math.abs(Date.parse(p.resets_at!) - Date.parse(first.resets_at!)) > 120000;
      if (changed && seenAnchors.some(anchor => Math.abs(anchor - Date.parse(p.resets_at!)) <= 120000)) continue;
      const dropped = p.kind !== "historical-anchor" && previous.kind !== "historical-anchor" && p.used_percent < previous.used_percent - 1;
      const planChanged = p.plan !== null && previous.plan !== null && p.plan !== previous.plan;
      if (changed || dropped || planChanged) {
        const reset = Date.parse(previous.resets_at!);
        const scheduled = changed && reset > previousTime && reset <= time && !planChanged;
        append(scheduled ? reset : previousTime, scheduled);
        start = scheduled ? reset : time;
        startReset = scheduled;
        first = p;
        if (changed) seenAnchors.push(Date.parse(p.resets_at!));
      }
      previous = p;
    }
    append(Date.parse(previous.ts), false);
  }
  return periods.sort((a, b) => a.start.localeCompare(b.start) || a.account.localeCompare(b.account));
}
