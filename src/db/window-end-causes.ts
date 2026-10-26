import type { Database } from "bun:sqlite";
import { asSchemaWriter } from "./schema-writer";

/**
 * The stored cause of each limit window's end (docs/reset-capacity-plan-2026-10-11.md, step 2), written by the background
 * step in server/window-end-causes.ts from stored rows only, and its work queue. Readers (billing cycles) never compute.
 * Kept identical to drizzle/0077_window_end_causes.sql (with its two limit_windows indexes); tests compare them.
 */
export const WINDOW_END_CAUSES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS window_end_causes (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  planned_reset TEXT NOT NULL, f REAL, bonus REAL NOT NULL,
  cause TEXT NOT NULL CHECK(cause IN ('open','scheduled','plan_change','not_reset','banked','provider','provider_probable','single','unknown')),
  banked_origin TEXT CHECK(banked_origin IN ('all_accounts','unknown')), evidence TEXT NOT NULL,
  inputs_rev TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_start)
) STRICT;
CREATE TABLE IF NOT EXISTS window_end_cause_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account)
) STRICT;
CREATE INDEX IF NOT EXISTS limit_windows_counter_end ON limit_windows(provider, counter, end_ts);
CREATE INDEX IF NOT EXISTS limit_windows_order ON limit_windows(start_ts, provider, account, counter);`;

export type WindowEndCause = "open" | "scheduled" | "plan_change" | "not_reset" | "banked" | "provider" | "provider_probable" | "single" | "unknown";
export type BankedOrigin = "all_accounts" | "unknown";

export interface WindowEndCauseRow {
  provider: string; account: string; counter: string; window_start: string; window_end: string; planned_reset: string;
  f: number | null; bonus: number; cause: WindowEndCause; banked_origin: BankedOrigin | null; evidence: string;
  inputs_rev: string; computed_at: string;
}

export const WINDOW_END_CAUSE_COLUMNS = ["provider", "account", "counter", "window_start", "window_end", "planned_reset", "f", "bonus", "cause",
  "banked_origin", "evidence", "inputs_rev", "computed_at"] as const satisfies ReadonlyArray<keyof WindowEndCauseRow>;

/** Every provider or account (`*`). */
export const END_CAUSES_ALL = "*";
/** Earlier than any window: an entry from here covers the whole history. */
export const END_CAUSES_BEGINNING = -8_640_000_000_000_000;

export function ensureWindowEndCauseSchema(db: Database): void {
  asSchemaWriter(db, () => { db.exec(WINDOW_END_CAUSES_SCHEMA_SQL); });
}

const present = new WeakSet<Database>();
export function hasWindowEndCauses(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_end_cause_dirty'").get();
  if (found) present.add(db);
  return found;
}

/** Inside the caller's transaction: the end causes of windows of `provider`/`account` overlapping `[fromMs, untilMs)` are work again. */
export function markWindowEndCausesDirty(db: Database, provider: string, account: string, fromMs: number, untilMs: number | null = null): void {
  if (!hasWindowEndCauses(db) || Number.isNaN(fromMs)) return;
  const from = Math.max(END_CAUSES_BEGINNING, Math.floor(Number.isFinite(fromMs) ? fromMs : END_CAUSES_BEGINNING));
  const until = untilMs === null || !Number.isFinite(untilMs) ? null : Math.ceil(untilMs);
  db.query(`INSERT INTO window_end_cause_dirty(provider,account,from_ms,until_ms) VALUES(?,?,?,?)
    ON CONFLICT(provider,account) DO UPDATE SET from_ms=MIN(from_ms,excluded.from_ms),
      until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END,
      sequence=sequence+1`)
    .run(provider === END_CAUSES_ALL ? provider : provider.toLowerCase(), account === END_CAUSES_ALL ? account : account.toLowerCase(), from, until);
}

/** The stored end causes of one account's counter, in window order. Never computes. */
export function readWindowEndCauses(db: Database, provider: string, account: string, counter: string): WindowEndCauseRow[] {
  if (!hasWindowEndCauses(db)) return [];
  return db.query("SELECT * FROM window_end_causes WHERE provider=? AND account=? AND counter=? ORDER BY window_start")
    .all(provider, account, counter) as WindowEndCauseRow[];
}
