-- Second register level: sums per physical copy, time bucket and dimension.
--
-- `usage_price_copy_days` answers whole days. A counter interval starts and ends at an arbitrary
-- instant, so the days it cuts were read and valued one event at a time, once per interval. A cut
-- day is now summed from these buckets and only the cut bucket itself is read per event.
--
-- Buckets are plain time slots, never counter windows: window boundaries come from percentage
-- readings and get corrected, and a reading must not revalue history. `bucket` is the slot's
-- start in whole `usage_price_bucket_state.width` minutes since the epoch, or -1 for a
-- contribution whose timestamp does not fall inside its own `day`; a day holding such a row is
-- read per event. Rows are per copy because Codex mirror selection depends on the report range.
CREATE TABLE IF NOT EXISTS usage_price_copy_buckets (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  copy TEXT NOT NULL,
  dim TEXT NOT NULL,
  calls INTEGER NOT NULL,
  tokens_reported TEXT NOT NULL,
  counts TEXT NOT NULL,
  PRIMARY KEY (scope, day, bucket, copy, dim)
) WITHOUT ROWID;
--> statement-breakpoint
-- Durable progress of building the buckets from contributions that already exist. `cursor` is
-- the last copy whose contributions are all in; deltas are applied only to copies at or before
-- it, and later copies are summed whole when the build reaches them, so nothing counts twice.
CREATE TABLE IF NOT EXISTS usage_price_bucket_state (
  scope TEXT PRIMARY KEY,
  width INTEGER NOT NULL,
  cursor TEXT NOT NULL,
  complete INTEGER NOT NULL
) WITHOUT ROWID;
