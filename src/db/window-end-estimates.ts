import type { Database } from "bun:sqlite";
import { asSchemaWriter } from "./schema-writer";

/**
 * Stored end estimates of closed limit windows (user decision 2026-10-10, "rób szacunek z tokenów"), written by
 * the window-usage producer (server/window-end-estimate.ts) from stored rows only:
 * - `calibration`: the window's own percent-per-usage from its readings (JSON), or NULL; later windows of the
 *   same counter fall back to it;
 * - `estimate`: the window's end estimate (JSON) when readings stopped before its end with usage after them, else NULL.
 * A missing row (or another `rule`) is work for the producer; readers never compute.
 * Kept identical to drizzle/0075_window_end_estimates.sql; tests compare them.
 */
export const WINDOW_END_ESTIMATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS window_end_estimates (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  rule TEXT NOT NULL, calibration TEXT, estimate TEXT,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;`;

export function ensureWindowEndEstimateSchema(db: Database): void {
  asSchemaWriter(db, () => { db.exec(WINDOW_END_ESTIMATE_SCHEMA_SQL); });
}

const present = new WeakSet<Database>();
export function hasWindowEndEstimates(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_end_estimates'").get();
  if (found) present.add(db);
  return found;
}

/** Inside the writer's transaction: the inputs of a window changed, so its stored estimate is work again. */
export function dropWindowEndEstimate(db: Database, provider: string, account: string, counter: string, windowId: string): void {
  if (!hasWindowEndEstimates(db)) return;
  db.query("DELETE FROM window_end_estimates WHERE provider=? AND account=? AND counter=? AND window_id=?")
    .run(provider, account, counter, windowId);
}
