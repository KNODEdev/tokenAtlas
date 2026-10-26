import type { Database } from "bun:sqlite";
import type { FxLookup } from "../shared/billing-cycles";

/** The table drizzle/0083_fx_rates.sql creates; tests compare them. */
export const FX_RATES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL, for_day TEXT NOT NULL, pln_per_unit REAL NOT NULL, effective_day TEXT NOT NULL,
  source TEXT NOT NULL, table_no TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY(currency, for_day)
) STRICT;`;

/**
 * One stored rate: PLN per unit of `currency` that applies to a payment made on `forDay` (YYYY-MM-DD, UTC), i.e. the NBP
 * table A mid rate of the last business day before it (`effectiveDay`). Stored per payment day, so a lookup never picks a
 * neighbouring day's rate by accident and a later fetch of other days changes nothing already published.
 */
export interface FxRate { currency: string; forDay: string; plnPerUnit: number; effectiveDay: string; source: string; tableNo: string | null }

const present = new WeakSet<Database>();
export function hasFxRates(db: Database): boolean {
  if (present.has(db)) return true;
  const found = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fx_rates'").get();
  if (found) present.add(db);
  return found;
}

/** Every stored rate keyed `CUR|day`: small (one row per currency and payment day), read once per producer turn. */
export function readFxRates(db: Database): Map<string, FxRate> {
  if (!hasFxRates(db)) return new Map();
  const rows = db.query("SELECT currency, for_day, pln_per_unit, effective_day, source, table_no FROM fx_rates").all() as Array<{
    currency: string; for_day: string; pln_per_unit: number; effective_day: string; source: string; table_no: string | null }>;
  return new Map(rows.map((row) => [`${row.currency}|${row.for_day}`, { currency: row.currency, forDay: row.for_day, plnPerUnit: row.pln_per_unit,
    effectiveDay: row.effective_day, source: row.source, tableNo: row.table_no }]));
}

/** The stored rates as the cycle derivation and the receipts read them (one small table, read once per use). */
export function storedFxLookup(db: Database): FxLookup {
  const rates = readFxRates(db);
  return (currency, onDay) => rates.get(`${currency.toUpperCase()}|${onDay}`) ?? null;
}

/** Stores fetched rates (inside the caller's transaction); an existing rate of the same payment day is kept as published. */
export function storeFxRates(db: Database, rates: readonly FxRate[], now = Date.now()): FxRate[] {
  if (!hasFxRates(db)) return [];
  const put = db.query(`INSERT INTO fx_rates(currency, for_day, pln_per_unit, effective_day, source, table_no, fetched_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(currency, for_day) DO NOTHING`);
  return rates.filter((rate) => put.run(rate.currency, rate.forDay, rate.plnPerUnit, rate.effectiveDay, rate.source, rate.tableNo,
    new Date(now).toISOString()).changes > 0);
}
