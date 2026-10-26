import type { Database } from "bun:sqlite";

/**
 * The resume point of a per-account dirty-queue entry worked through in chunks (window-point-values.ts,
 * window-end-causes.ts): the last window done, on the full order key (start, provider, account, counter). It is kept in
 * `meta` apart from the entry's invalidation interval, so many windows overlapping one instant cannot make a chunk repeat,
 * and it applies only to the entry's `sequence` it was written for: a merged newer mark restarts the entry from the top.
 */
export type PageKey = readonly [string, string, string, string];
export const FIRST_PAGE: PageKey = ["", "", "", ""];
export interface PagedEntry { provider: string; account: string; sequence: number }

const keyOf = (prefix: string, entry: PagedEntry) => `${prefix}:${entry.provider}|${entry.account}`;

export function readPage(db: Database, prefix: string, entry: PagedEntry): PageKey {
  try {
    const value = (db.query("SELECT value FROM meta WHERE key=?").get(keyOf(prefix, entry)) as { value: string } | null)?.value;
    const page = value ? JSON.parse(value) as { sequence: number; after: PageKey } : null;
    return page && page.sequence === entry.sequence && Array.isArray(page.after) && page.after.length === 4 ? page.after : FIRST_PAGE;
  } catch { return FIRST_PAGE; }
}
/** Inside the chunk's write transaction. */
export function writePage(db: Database, prefix: string, entry: PagedEntry, after: PageKey): void {
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(keyOf(prefix, entry), JSON.stringify({ sequence: entry.sequence, after }));
}
export function clearPage(db: Database, prefix: string, entry: PagedEntry): void {
  db.query("DELETE FROM meta WHERE key=?").run(keyOf(prefix, entry));
}
/**
 * How far before an instant a limit window overlapping it can start: the longest stored window (by its nominal length and
 * by its stored bounds; Grok's billing-period windows last about a month), plus a day. Read once per turn.
 */
export function longestWindowMs(db: Database): number {
  const row = db.query(`SELECT MAX(window_minutes) AS minutes, MAX(julianday(end_ts) - julianday(start_ts)) AS days FROM limit_windows`).get() as
    { minutes: number | null; days: number | null } | null;
  return Math.max((row?.minutes ?? 0) * 60_000, (row?.days ?? 0) * 86_400_000) + 86_400_000;
}

/**
 * Whether queued work for `[fromMs, untilMs)` is already held by an entry: the entry covers the range and, when it is
 * being worked page by page, its cursor has not yet passed the window the work is about (`window`, its order key), or
 * without one any window that can overlap the range (such a window starts after `fromMs − longest`). Work behind the
 * cursor is not covered: queuing it restarts the entry.
 */
export function coveredByEntry(db: Database, table: string, prefix: string, provider: string, account: string, fromMs: number, untilMs: number,
  longest: number, window?: PageKey): boolean {
  const entry = db.query(`SELECT provider, account, sequence FROM ${table} WHERE provider IN (?, '*') AND account IN (?, '*') AND from_ms<=?
    AND (until_ms IS NULL OR until_ms>=?) LIMIT 1`).get(provider, account, Math.floor(fromMs), Math.ceil(untilMs)) as PagedEntry | null;
  if (!entry) return false;
  const page = readPage(db, prefix, entry);
  if (page[0] === "") return true;
  if (window) return pageOrder(window, page) > 0;
  return page[0] < new Date(Math.max(fromMs - longest, -8.64e15)).toISOString();
}
/** The order of two page keys, as SQLite compares the row values (text by binary order). */
function pageOrder(a: PageKey, b: PageKey): number {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** The SQL condition (alias l, limit_windows) and its parameters for the windows after a page key. */
export const AFTER_PAGE = "(l.start_ts, l.provider, l.account, l.counter) > (?6, ?7, ?8, ?9)";
