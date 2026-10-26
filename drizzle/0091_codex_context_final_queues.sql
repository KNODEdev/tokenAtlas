-- Independent calculator readiness: source window queues remain owned by the ordinary producer.
CREATE TABLE codex_context_final_window_usage_dirty (
 provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, from_ms INTEGER NOT NULL,
 until_ms INTEGER, sequence INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(provider,account,counter,from_ms)
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_context_final_window_usage_pending (
 provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
 PRIMARY KEY(provider,account,counter,window_id)
) STRICT;
