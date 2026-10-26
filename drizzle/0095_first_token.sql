CREATE TABLE response_time_state (provider TEXT PRIMARY KEY, version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE response_time_queue (
  provider TEXT NOT NULL, owner TEXT NOT NULL, path TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT,
  priority REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(provider,owner,path)
);
--> statement-breakpoint
CREATE INDEX response_time_queue_priority ON response_time_queue(retry_at,priority DESC);
--> statement-breakpoint
CREATE TABLE response_time_copies (
  provider TEXT NOT NULL, owner TEXT NOT NULL, path TEXT NOT NULL, turn_id TEXT NOT NULL,
  source TEXT NOT NULL, model TEXT, ts TEXT NOT NULL, ms INTEGER, billing TEXT NOT NULL, reason TEXT,
  PRIMARY KEY(provider,owner,path,turn_id)
);
--> statement-breakpoint
CREATE INDEX response_time_copies_turn ON response_time_copies(provider,turn_id);
--> statement-breakpoint
CREATE TABLE response_time_turns (
  provider TEXT NOT NULL, turn_id TEXT NOT NULL, source TEXT, model TEXT, ts TEXT NOT NULL,
  ms INTEGER, billing TEXT NOT NULL, reason TEXT, PRIMARY KEY(provider,turn_id)
);
--> statement-breakpoint
CREATE INDEX response_time_turns_time ON response_time_turns(provider,source,ts);
--> statement-breakpoint
CREATE TABLE response_time_hours (
  provider TEXT NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL, billing TEXT NOT NULL,
  hour INTEGER NOT NULL, ms INTEGER NOT NULL, turns INTEGER NOT NULL,
  PRIMARY KEY(provider,source,hour,model,billing,ms)
);
