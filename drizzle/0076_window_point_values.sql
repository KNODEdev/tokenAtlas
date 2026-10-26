-- The value of one point of each limit window (docs/reset-capacity-plan-2026-10-11.md, step 1): per window its plan,
-- capacity regime factor, measured points and the paired traffic behind them, with the reason a window cannot calibrate.
-- Written by a background step from stored rows (server/window-point-values.ts); billing cycles read it, never compute it.
CREATE TABLE IF NOT EXISTS window_point_values (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  plan TEXT, regime_factor REAL, pp REAL, basis TEXT NOT NULL CHECK(basis IN ('final','at_limit')),
  events INTEGER, tokens_input INTEGER, tokens_cached INTEGER, tokens_output INTEGER,
  api_standard REAL, api_normalized REAL, credits_low REAL, credits_high REAL, unpriced_events INTEGER,
  status TEXT NOT NULL CHECK(status IN ('eligible','open','no_percent','small_span','sums_missing','unpriced','regime_mixed')),
  scope TEXT, inputs_rev TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_start)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS window_point_values_plan ON window_point_values(provider, account, counter, plan);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS window_point_value_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account)
) STRICT;
