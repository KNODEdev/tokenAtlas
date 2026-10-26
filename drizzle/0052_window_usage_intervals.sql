-- Window usage intervals (plan U1.4): measured spans that are not limit windows and whose sums window_usage
-- also holds: standalone manual measurements, Claude gauge observations and Claude windows reconstructed from
-- the cadence. The maintenance worker publishes them from its configuration inputs; readers list them here.
-- spec: the interval's own definition (the measurement, or the reconstructed window and its scope models).
CREATE TABLE IF NOT EXISTS window_usage_intervals (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('manual','gauge','declared')), start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, spec TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
