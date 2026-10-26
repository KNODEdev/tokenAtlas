-- Claude Code writes the vendor's refusal when an account limit is reached ("You've hit your weekly
-- limit"): an assistant line with `quotaLimits` {status:"rejected", rateLimitType, resetsAt} and
-- error "rate_limit". Each is a dated 100% reading of that counter, derived from the archived
-- transcript like claude_events and published with the same (store, path) source identity.
CREATE TABLE IF NOT EXISTS claude_limit_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  store TEXT NOT NULL,
  call_id TEXT NOT NULL,
  session_id TEXT,
  ts TEXT NOT NULL,
  limit_type TEXT NOT NULL,
  status TEXT NOT NULL,
  resets_at TEXT,
  path TEXT NOT NULL,
  subscription_id TEXT,
  account_key TEXT,
  subscription_conflict INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS claude_limit_hits_store_call_id_unique ON claude_limit_hits(store, call_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claude_limit_hits_store_path_idx ON claude_limit_hits(store, path);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claude_limit_hits_ts_idx ON claude_limit_hits(ts);
