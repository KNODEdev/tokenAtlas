CREATE TABLE codex_context_detail_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_detail_state(singleton,version) VALUES(1,1);
--> statement-breakpoint
CREATE TABLE codex_context_detail_dirty(day TEXT NOT NULL,dim_id INTEGER NOT NULL,PRIMARY KEY(day,dim_id)) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_detail_dirty SELECT DISTINCT day,-1 FROM codex_context_aggregates WHERE grain='day';
--> statement-breakpoint
CREATE TABLE codex_context_bucket_parts(event_id INTEGER PRIMARY KEY,day TEXT NOT NULL,dim_id INTEGER NOT NULL,hour INTEGER,instant_ms INTEGER,
  cohort TEXT NOT NULL,parts TEXT NOT NULL) STRICT;
--> statement-breakpoint
CREATE INDEX codex_context_bucket_parts_scope ON codex_context_bucket_parts(day,dim_id,hour);
--> statement-breakpoint
CREATE TABLE codex_context_model_pending(account TEXT NOT NULL,counter TEXT NOT NULL,window_id TEXT NOT NULL,PRIMARY KEY(account,counter,window_id)) STRICT;
--> statement-breakpoint
CREATE TABLE codex_context_model_windows(account TEXT NOT NULL,counter TEXT NOT NULL,window_id TEXT NOT NULL,inputs TEXT NOT NULL,data TEXT NOT NULL,
  PRIMARY KEY(account,counter,window_id)) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_model_pending SELECT account,counter,window_id FROM window_usage WHERE provider='codex';
--> statement-breakpoint
CREATE TRIGGER codex_context_details_aggregate_insert AFTER INSERT ON codex_context_aggregates WHEN NEW.grain='day' BEGIN
  INSERT OR IGNORE INTO codex_context_detail_dirty VALUES(NEW.day,NEW.dim_id);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_details_aggregate_update AFTER UPDATE ON codex_context_aggregates WHEN NEW.grain='day' BEGIN
  INSERT OR IGNORE INTO codex_context_detail_dirty VALUES(NEW.day,NEW.dim_id);
  INSERT OR IGNORE INTO codex_context_detail_dirty VALUES(OLD.day,OLD.dim_id);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_details_aggregate_delete AFTER DELETE ON codex_context_aggregates WHEN OLD.grain='day' BEGIN
  INSERT OR IGNORE INTO codex_context_detail_dirty VALUES(OLD.day,OLD.dim_id);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_usage_insert AFTER INSERT ON window_usage WHEN NEW.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending VALUES(NEW.account,NEW.counter,NEW.window_id);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_usage_update AFTER UPDATE ON window_usage WHEN NEW.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending VALUES(NEW.account,NEW.counter,NEW.window_id);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_usage_delete AFTER DELETE ON window_usage WHEN OLD.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending VALUES(OLD.account,OLD.counter,OLD.window_id);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_window_insert AFTER INSERT ON limit_windows WHEN NEW.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending SELECT account,counter,window_id FROM limit_windows
    WHERE provider='codex' AND account=NEW.account AND counter=NEW.counter AND start_ts<NEW.end_ts AND end_ts>NEW.start_ts;
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_window_update AFTER UPDATE ON limit_windows WHEN NEW.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending SELECT account,counter,window_id FROM limit_windows
    WHERE provider='codex' AND account=NEW.account AND counter=NEW.counter AND start_ts<MAX(OLD.end_ts,NEW.end_ts) AND end_ts>MIN(OLD.start_ts,NEW.start_ts);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_window_delete AFTER DELETE ON limit_windows WHEN OLD.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending VALUES(OLD.account,OLD.counter,OLD.window_id);
  INSERT OR IGNORE INTO codex_context_model_pending SELECT account,counter,window_id FROM limit_windows
    WHERE provider='codex' AND account=OLD.account AND counter=OLD.counter AND start_ts<OLD.end_ts AND end_ts>OLD.start_ts;
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_period_insert AFTER INSERT ON account_periods WHEN NEW.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending SELECT account,counter,window_id FROM limit_windows
    WHERE provider='codex' AND start_ts<COALESCE(NEW.until_ts,'9999') AND end_ts>NEW.from_ts AND account=NEW.account COLLATE NOCASE;
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_period_update AFTER UPDATE ON account_periods WHEN NEW.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending SELECT account,counter,window_id FROM limit_windows
    WHERE provider='codex' AND start_ts<MAX(COALESCE(OLD.until_ts,'9999'),COALESCE(NEW.until_ts,'9999')) AND end_ts>MIN(OLD.from_ts,NEW.from_ts)
      AND (account=NEW.account COLLATE NOCASE OR account=OLD.account COLLATE NOCASE);
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_model_period_delete AFTER DELETE ON account_periods WHEN OLD.provider='codex' BEGIN
  INSERT OR IGNORE INTO codex_context_model_pending SELECT account,counter,window_id FROM limit_windows
    WHERE provider='codex' AND start_ts<COALESCE(OLD.until_ts,'9999') AND end_ts>OLD.from_ts AND account=OLD.account COLLATE NOCASE;
END;
