-- Timing-only projection of canonical calls; no source facts, valuations or parser cursors are changed.
CREATE TABLE model_speed_state(provider TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE model_speed_queue(provider TEXT NOT NULL,event_id INTEGER NOT NULL,PRIMARY KEY(provider,event_id));
--> statement-breakpoint
CREATE TABLE model_speed_facts(
  provider TEXT NOT NULL,event_id INTEGER NOT NULL,key TEXT NOT NULL,source TEXT,identity TEXT,model TEXT,
  speed TEXT,effort TEXT,service_tier TEXT,billing TEXT,ts TEXT NOT NULL,hour INTEGER NOT NULL,calls INTEGER NOT NULL,
  timed_calls INTEGER NOT NULL,timed_out INTEGER NOT NULL,timed_ms INTEGER NOT NULL,
  timed_long_calls INTEGER NOT NULL,timed_long_out INTEGER NOT NULL,timed_long_ms INTEGER NOT NULL,
  PRIMARY KEY(provider,event_id));
--> statement-breakpoint
CREATE INDEX model_speed_facts_boundary ON model_speed_facts(provider,key,hour,ts);
--> statement-breakpoint
CREATE TABLE model_speed_hours(
  provider TEXT NOT NULL,key TEXT NOT NULL,source TEXT,identity TEXT,model TEXT,speed TEXT,effort TEXT,service_tier TEXT,billing TEXT,
  hour INTEGER NOT NULL,calls INTEGER NOT NULL,timed_calls INTEGER NOT NULL,timed_out INTEGER NOT NULL,timed_ms INTEGER NOT NULL,
  timed_long_calls INTEGER NOT NULL,timed_long_out INTEGER NOT NULL,timed_long_ms INTEGER NOT NULL,
  PRIMARY KEY(provider,key,hour));
--> statement-breakpoint
ALTER TABLE response_time_copies ADD COLUMN service_tier TEXT;
--> statement-breakpoint
ALTER TABLE response_time_copies ADD COLUMN effort TEXT;
--> statement-breakpoint
ALTER TABLE response_time_copies ADD COLUMN mode_known INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE response_time_turns ADD COLUMN service_tier TEXT;
--> statement-breakpoint
ALTER TABLE response_time_turns ADD COLUMN effort TEXT;
--> statement-breakpoint
ALTER TABLE response_time_turns ADD COLUMN mode_known INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE response_time_hours RENAME TO response_time_hours_0095;
--> statement-breakpoint
CREATE TABLE response_time_hours (
  provider TEXT NOT NULL,source TEXT NOT NULL,model TEXT NOT NULL,billing TEXT NOT NULL,
  hour INTEGER NOT NULL,ms INTEGER NOT NULL,turns INTEGER NOT NULL,
  service_tier TEXT NOT NULL DEFAULT '',effort TEXT NOT NULL DEFAULT '',mode_known INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider,source,hour,model,billing,ms,service_tier,effort,mode_known));
--> statement-breakpoint
INSERT INTO response_time_hours(provider,source,model,billing,hour,ms,turns)
  SELECT provider,source,model,billing,hour,ms,turns FROM response_time_hours_0095;
--> statement-breakpoint
DROP TABLE response_time_hours_0095;
