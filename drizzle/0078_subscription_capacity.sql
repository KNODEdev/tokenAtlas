CREATE TABLE IF NOT EXISTS subscription_capacity_windows (
provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, scope_start TEXT NOT NULL,
signature TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, computed_at TEXT NOT NULL,
PRIMARY KEY(provider,account,counter,window_id)) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS subscription_capacity_range ON subscription_capacity_windows(provider,account,end_ts);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS subscription_capacity_dirty (
provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
sequence INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(provider,account,from_ms)) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS subscription_capacity_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
