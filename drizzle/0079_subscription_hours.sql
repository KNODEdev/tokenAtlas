CREATE TABLE subscription_window_hours (
 provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
 start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, active_ms REAL NOT NULL,
 hours_per_100 REAL, absent TEXT, signature TEXT NOT NULL, checked INTEGER NOT NULL,
 computed_at TEXT NOT NULL, PRIMARY KEY(provider,account,counter,window_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE subscription_hours_dirty (
 provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
 sequence INTEGER NOT NULL, PRIMARY KEY(provider,account,from_ms)
) STRICT;
--> statement-breakpoint
CREATE TABLE subscription_hours_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
