-- Billing cycles (docs/billing-cycles-design-2026-10-08.md §5): the stored cycles of every plan run of an account, with
-- what each used of its limit windows, maintained incrementally by the background writer. Additive only.
--
-- plan_periods.anchor_ts: the renewal instant a declared run's cycles are counted from (NULL: its from_ts);
-- plan_periods.cycle_months: 1 (monthly, also NULL) or 12 (annual). Both come from the owner's declarations file.
ALTER TABLE plan_periods ADD COLUMN anchor_ts TEXT;
--> statement-breakpoint
ALTER TABLE plan_periods ADD COLUMN cycle_months INTEGER;
--> statement-breakpoint
-- One row per cycle. Times are ISO instants, start inclusive and end exclusive. NULL means unknown, never 0: used_pp
-- without % readings, api_usd without stored window sums, amount_minor without a price, capacity_usd until a stored
-- calibration exists. flags (JSON list) say why; detail (JSON) holds the run, the current cycle's to-date and projection,
-- the counters shown beside the main one and the windows without %. inputs_rev names the derived cycle the row was
-- computed for; a row whose derivation changed is recomputed.
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
--> statement-breakpoint
-- Instant ranges of an account whose cycles must be recomputed, written by the writer that changed an input (a plan
-- period, the producer itself for new window sums) in its own transaction. account '*' is every account of the provider.
CREATE TABLE IF NOT EXISTS billing_cycle_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account)
) STRICT;
