CREATE TABLE codex_context_window_ranges(account TEXT PRIMARY KEY,from_ms INTEGER NOT NULL,until_ms INTEGER) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_context_window_overlap ON limit_windows(provider,account,counter,start_ts,end_ts,window_id);
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_usage_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_usage_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_usage_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_window_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_window_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_window_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_period_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_period_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_context_model_period_delete;
