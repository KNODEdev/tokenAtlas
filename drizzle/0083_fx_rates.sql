CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL, for_day TEXT NOT NULL, pln_per_unit REAL NOT NULL, effective_day TEXT NOT NULL,
  source TEXT NOT NULL, table_no TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY(currency, for_day)
) STRICT;
