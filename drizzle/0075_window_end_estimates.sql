-- End estimates of closed limit windows (user decision 2026-10-10): per window, its own percent-per-usage
-- calibration and the estimate of its end when meter readings stopped before it with usage after them.
-- Written by the window-usage producer from stored rows (server/window-end-estimate.ts); readers never compute.
CREATE TABLE IF NOT EXISTS window_end_estimates (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  rule TEXT NOT NULL, calibration TEXT, estimate TEXT,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
