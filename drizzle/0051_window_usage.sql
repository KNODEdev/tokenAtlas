-- Window usage (plan U1.2): the sums of every limit window, maintained by the analysis maintenance worker
-- from the ledgers. One row per window of limit_windows; the columns hold separate parts so a screen reads
-- only what it shows. cycle: canonical paired and full-cycle sums, dimensions and exclusions; rail: rail
-- fields; readings: running sums at each percentage reading; slices: paired token vectors per model and day.
CREATE TABLE IF NOT EXISTS window_usage (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL,
  cycle TEXT NOT NULL, rail TEXT NOT NULL, readings TEXT NOT NULL, slices TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
--> statement-breakpoint
-- window_usage_pending: windows whose sums are being recomputed; their previous row stays readable.
CREATE TABLE IF NOT EXISTS window_usage_pending (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
--> statement-breakpoint
-- window_usage_dirty: instant ranges a writer changed, in its own transaction. account and counter may be
-- '*' (all); a null bound is open. The producer turns each entry into the pending windows that overlap it.
CREATE TABLE IF NOT EXISTS window_usage_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, from_ms INTEGER NOT NULL,
  until_ms INTEGER, sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account, counter, from_ms)
) STRICT;
