-- Preserve completed timing projections and promote only subsequently changed calls.
ALTER TABLE model_speed_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE model_speed_queue ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX model_speed_queue_work ON model_speed_queue(provider,priority,queued_at,event_id);
--> statement-breakpoint
CREATE TABLE model_speed_queue_counts(provider TEXT PRIMARY KEY,pending INTEGER NOT NULL CHECK(pending>=0),
  served INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
INSERT INTO model_speed_queue_counts(provider,pending) SELECT provider,COUNT(*) FROM model_speed_queue GROUP BY provider;
--> statement-breakpoint
CREATE TRIGGER model_speed_queue_added AFTER INSERT ON model_speed_queue BEGIN
  INSERT INTO model_speed_queue_counts(provider,pending) VALUES(NEW.provider,1)
    ON CONFLICT(provider) DO UPDATE SET pending=pending+1;
END;
--> statement-breakpoint
CREATE TABLE model_timeline_state(provider TEXT PRIMARY KEY,bookmark INTEGER,scanning INTEGER NOT NULL DEFAULT 1,
  initialized INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE model_timeline_dirty(provider TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(provider,day));
--> statement-breakpoint
CREATE TABLE model_timeline_days(provider TEXT NOT NULL,day TEXT NOT NULL,model TEXT NOT NULL,first_ts TEXT NOT NULL,
  PRIMARY KEY(provider,day,model));
--> statement-breakpoint
CREATE INDEX model_timeline_minimum ON model_timeline_days(provider,model,first_ts);
--> statement-breakpoint
CREATE TABLE model_timeline_first(provider TEXT NOT NULL,model TEXT NOT NULL,first_ts TEXT NOT NULL,PRIMARY KEY(provider,model));
--> statement-breakpoint
CREATE TABLE codex_stamp_days(day TEXT NOT NULL,model TEXT NOT NULL,basis TEXT NOT NULL,signature TEXT NOT NULL,
  bands TEXT NOT NULL,tiers TEXT NOT NULL,PRIMARY KEY(day,model,basis));
--> statement-breakpoint
CREATE TABLE codex_stamp_dirty(day TEXT PRIMARY KEY);
--> statement-breakpoint
INSERT INTO codex_stamp_dirty SELECT DISTINCT day FROM codex_price_ledger_aggregates WHERE grain='day';
--> statement-breakpoint
CREATE TRIGGER model_speed_queue_removed AFTER DELETE ON model_speed_queue BEGIN
  UPDATE model_speed_queue_counts SET pending=pending-1 WHERE provider=OLD.provider;
END;
