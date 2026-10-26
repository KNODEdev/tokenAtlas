
CREATE TABLE IF NOT EXISTS capacity_cycle_results (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, window_minutes INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 1, body TEXT, error TEXT, preparing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider,account,counter,window_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS capacity_cycle_results_range ON capacity_cycle_results(window_minutes,end_ts,start_ts);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS capacity_cycle_result_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1, phase TEXT NOT NULL DEFAULT 'windows', cursor TEXT,
  PRIMARY KEY(provider,account,from_ms)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS capacity_cycle_result_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;