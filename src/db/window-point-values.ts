import type { Database } from "bun:sqlite";
import { asSchemaWriter } from "./schema-writer";

/**
 * The stored value of one point of each limit window (docs/reset-capacity-plan-2026-10-11.md, step 1), written by
 * the background step in server/window-point-values.ts from stored rows only, and its work queue. A missing row or
 * a queued range is work for that step; readers (billing cycles) never compute.
 * Kept identical to drizzle/0076_window_point_values.sql; tests compare them.
 */
export const WINDOW_POINT_VALUES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS window_point_values (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  plan TEXT, regime_factor REAL, pp REAL, basis TEXT NOT NULL CHECK(basis IN ('final','at_limit')),
  events INTEGER, tokens_input INTEGER, tokens_cached INTEGER, tokens_output INTEGER,
  api_standard REAL, api_normalized REAL, credits_low REAL, credits_high REAL, unpriced_events INTEGER,
  status TEXT NOT NULL CHECK(status IN ('eligible','open','no_percent','small_span','sums_missing','unpriced','regime_mixed')),
  scope TEXT, inputs_rev TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_start)
) STRICT;
CREATE INDEX IF NOT EXISTS window_point_values_plan ON window_point_values(provider, account, counter, plan);
CREATE TABLE IF NOT EXISTS window_point_value_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account)
) STRICT;`;

export type PointValueStatus = "eligible" | "open" | "no_percent" | "small_span" | "sums_missing" | "unpriced" | "regime_mixed";

export interface WindowPointValueRow {
  provider: string; account: string; counter: string; window_start: string; window_end: string;
  plan: string | null; regime_factor: number | null; pp: number | null; basis: "final" | "at_limit";
  events: number | null; tokens_input: number | null; tokens_cached: number | null; tokens_output: number | null;
  api_standard: number | null; api_normalized: number | null; credits_low: number | null; credits_high: number | null;
  unpriced_events: number | null; status: PointValueStatus; scope: string | null; inputs_rev: string; computed_at: string;
}

export const WINDOW_POINT_VALUE_COLUMNS = ["provider", "account", "counter", "window_start", "window_end", "plan", "regime_factor", "pp",
  "basis", "events", "tokens_input", "tokens_cached", "tokens_output", "api_standard", "api_normalized", "credits_low", "credits_high",
  "unpriced_events", "status", "scope", "inputs_rev", "computed_at"] as const satisfies ReadonlyArray<keyof WindowPointValueRow>;

/** Every provider or account (`*`). */
export const POINT_VALUES_ALL = "*";
/** Earlier than any window: an entry from here covers the whole history. */
export const POINT_VALUES_BEGINNING = -8_640_000_000_000_000;

export function ensureWindowPointValueSchema(db: Database): void {
  asSchemaWriter(db, () => { db.exec(WINDOW_POINT_VALUES_SCHEMA_SQL); });
}

const present = new WeakSet<Database>();
export function hasWindowPointValues(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_point_value_dirty'").get();
  if (found) present.add(db);
  return found;
}

/**
 * Inside the caller's transaction: the point values of `account` (or `*`) whose windows overlap `[fromMs, untilMs)`
 * are work again. Entries of one account merge into their hull, like the billing-cycle queue.
 */
export function markWindowPointValuesDirty(db: Database, provider: string, account: string, fromMs: number, untilMs: number | null = null): void {
  if (!hasWindowPointValues(db) || Number.isNaN(fromMs)) return;
  const from = Math.max(POINT_VALUES_BEGINNING, Math.floor(Number.isFinite(fromMs) ? fromMs : POINT_VALUES_BEGINNING));
  const until = untilMs === null || !Number.isFinite(untilMs) ? null : Math.ceil(untilMs);
  db.query(`INSERT INTO window_point_value_dirty(provider,account,from_ms,until_ms) VALUES(?,?,?,?)
    ON CONFLICT(provider,account) DO UPDATE SET from_ms=MIN(from_ms,excluded.from_ms),
      until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END,
      sequence=sequence+1`)
    .run(provider === POINT_VALUES_ALL ? provider : provider.toLowerCase(), account === POINT_VALUES_ALL ? account : account.toLowerCase(), from, until);
}

/** The stored rows of one account's counter, in window order. Never computes; a database without the table has none. */
export function readWindowPointValues(db: Database, provider: string, account: string, counter: string): WindowPointValueRow[] {
  if (!hasWindowPointValues(db)) return [];
  return db.query("SELECT * FROM window_point_values WHERE provider=? AND account=? AND counter=? ORDER BY window_start")
    .all(provider, account, counter) as WindowPointValueRow[];
}
