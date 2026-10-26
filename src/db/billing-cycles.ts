import type { Database } from "bun:sqlite";

/** The tables drizzle/0073_billing_cycles.sql creates (its plan_periods columns aside); tests compare them. */
export const BILLING_CYCLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS billing_cycles (
  provider TEXT NOT NULL, account TEXT NOT NULL, start_ts TEXT NOT NULL, end_ts TEXT NOT NULL,
  plan TEXT NOT NULL, basis TEXT NOT NULL CHECK(basis IN ('declared','observed','inferred')),
  anchor_uncertain INTEGER NOT NULL, cycle_months INTEGER NOT NULL,
  amount_minor INTEGER, currency TEXT, price_source TEXT NOT NULL, catalog_usd REAL,
  counter TEXT, windows_share REAL NOT NULL, idle_share REAL NOT NULL, windows_touched INTEGER NOT NULL,
  observed_share REAL, used_pp REAL, api_usd REAL, capacity_usd REAL,
  is_current INTEGER NOT NULL, flags TEXT NOT NULL, detail TEXT NOT NULL, inputs_rev TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY(provider, account, start_ts)
) STRICT;
CREATE TABLE IF NOT EXISTS billing_cycle_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account)
) STRICT;`;

/** Every account of a provider. */
export const BILLING_ALL_ACCOUNTS = "*";
/** Earlier than any cycle: an entry from here recomputes all of an account's cycles. */
export const BILLING_BEGINNING = -8_640_000_000_000_000;

const present = new WeakSet<Database>();
export function hasBillingCycles(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_cycle_dirty'").get();
  if (found) present.add(db);
  return found;
}

/**
 * Called by a writer that changed an input of the billing cycles of `account` (or `*`), inside its own transaction: the
 * cycles overlapping `[fromMs, untilMs)` are recomputed by the background producer. Entries of one account merge into
 * their hull. Databases without the schema (older tests) have nothing to invalidate.
 */
export function markBillingCyclesDirty(db: Database, provider: string, account: string, fromMs: number, untilMs: number | null = null): void {
  if (!hasBillingCycles(db) || Number.isNaN(fromMs)) return;
  const from = Math.max(BILLING_BEGINNING, Math.floor(Number.isFinite(fromMs) ? fromMs : BILLING_BEGINNING));
  const until = untilMs === null || !Number.isFinite(untilMs) ? null : Math.ceil(untilMs);
  db.query(`INSERT INTO billing_cycle_dirty(provider,account,from_ms,until_ms) VALUES(?,?,?,?)
    ON CONFLICT(provider,account) DO UPDATE SET from_ms=MIN(from_ms,excluded.from_ms),
      until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END,
      sequence=sequence+1`)
    .run(provider.toLowerCase(), account === BILLING_ALL_ACCOUNTS ? account : account.toLowerCase(), from, until);
}

/** A stored cycle's price as plan costs read it; `usd` absent (undefined) on a row stored before rules 13. */
export interface StoredCyclePrice {
  provider: string; account: string; start_ts: string; end_ts: string; plan: string; basis: string; price_source: string;
  amount_minor: number | null; currency: string | null; usd: number | null | undefined; fx: string | null;
}
/** Every stored cycle's price: one read, a row per account and month (docs/plan-price-from-cycles-2026-10-18.md). */
export function readCyclePrices(db: Database): StoredCyclePrice[] {
  if (!hasBillingCycles(db)) return [];
  // json_type is NULL for a missing key (a row from before rules 13) and 'null' for an unknown price.
  return (db.query(`SELECT provider, account, start_ts, end_ts, plan, basis, price_source, amount_minor, currency,
      json_type(detail, '$.price_usd') AS usd_type, json_extract(detail, '$.price_usd') AS usd, json_extract(detail, '$.fx') AS fx
    FROM billing_cycles ORDER BY provider, account, start_ts`).all() as Array<Omit<StoredCyclePrice, "usd"> & { usd_type: string | null; usd: number | null }>)
    .map(({ usd_type, usd, ...row }) => ({ ...row, usd: usd_type === null ? undefined : usd }));
}
