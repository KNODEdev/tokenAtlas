-- The cause of each limit window's end (docs/reset-capacity-plan-2026-10-11.md, step 2): planned reset, not a reset,
-- a banked reset credit, a provider reset (sure or probable), a single early reset or unknown, with the elapsed fraction,
-- the reset bonus and the evidence. Written by a background step (server/window-end-causes.ts); readers never compute.
CREATE TABLE IF NOT EXISTS window_end_causes (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  planned_reset TEXT NOT NULL, f REAL, bonus REAL NOT NULL,
  cause TEXT NOT NULL CHECK(cause IN ('open','scheduled','plan_change','not_reset','banked','provider','provider_probable','single','unknown')),
  banked_origin TEXT CHECK(banked_origin IN ('all_accounts','unknown')), evidence TEXT NOT NULL,
  inputs_rev TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_start)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS window_end_cause_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, account)
) STRICT;
--> statement-breakpoint
-- The neighbouring-window reads (a provider's counter by end time) and the ordered page reads of both window steps.
CREATE INDEX IF NOT EXISTS limit_windows_counter_end ON limit_windows(provider, counter, end_ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS limit_windows_order ON limit_windows(start_ts, provider, account, counter);
