CREATE TABLE codex_context_final_window_usage (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL,
  cycle TEXT NOT NULL, rail TEXT NOT NULL, readings TEXT NOT NULL, slices TEXT NOT NULL, reference TEXT,
  PRIMARY KEY(provider, account, counter, window_id)
) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_window_usage SELECT * FROM window_usage;
--> statement-breakpoint
CREATE TABLE codex_context_final_billing_cycles (
  provider TEXT NOT NULL, account TEXT NOT NULL, start_ts TEXT NOT NULL, end_ts TEXT NOT NULL,
  plan TEXT NOT NULL, basis TEXT NOT NULL CHECK(basis IN ('declared','observed','inferred')),
  anchor_uncertain INTEGER NOT NULL, cycle_months INTEGER NOT NULL,
  amount_minor INTEGER, currency TEXT, price_source TEXT NOT NULL, catalog_usd REAL,
  counter TEXT, windows_share REAL NOT NULL, idle_share REAL NOT NULL, windows_touched INTEGER NOT NULL,
  observed_share REAL, used_pp REAL, api_usd REAL, capacity_usd REAL,
  is_current INTEGER NOT NULL, flags TEXT NOT NULL, detail TEXT NOT NULL, inputs_rev TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY(provider, account, start_ts)
) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_billing_cycles SELECT * FROM billing_cycles;
--> statement-breakpoint
CREATE TABLE codex_context_final_window_point_values (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
  plan TEXT, regime_factor REAL, pp REAL, basis TEXT NOT NULL CHECK(basis IN ('final','at_limit')),
  events INTEGER, tokens_input INTEGER, tokens_cached INTEGER, tokens_output INTEGER,
  api_standard REAL, api_normalized REAL, credits_low REAL, credits_high REAL, unpriced_events INTEGER,
  status TEXT NOT NULL CHECK(status IN ('eligible','open','no_percent','small_span','sums_missing','unpriced','regime_mixed')),
  scope TEXT, inputs_rev TEXT NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY(provider, account, counter, window_start)
) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_window_point_values SELECT * FROM window_point_values;
--> statement-breakpoint
CREATE TABLE codex_context_final_subscription_capacity_windows (
provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, scope_start TEXT NOT NULL,
signature TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, computed_at TEXT NOT NULL,
PRIMARY KEY(provider,account,counter,window_id)) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_subscription_capacity_windows SELECT * FROM subscription_capacity_windows;
--> statement-breakpoint
CREATE TABLE codex_context_final_subscription_capacity_dirty (
provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
sequence INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(provider,account,from_ms)) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_subscription_capacity_dirty SELECT * FROM subscription_capacity_dirty;
--> statement-breakpoint
CREATE TABLE codex_context_final_subscription_capacity_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_subscription_capacity_state SELECT * FROM subscription_capacity_state;
--> statement-breakpoint
CREATE TABLE codex_context_final_project_plan_days (provider TEXT NOT NULL,day TEXT NOT NULL,signature TEXT NOT NULL,
 checked INTEGER NOT NULL,body TEXT NOT NULL,computed_at TEXT NOT NULL,PRIMARY KEY(provider,day)) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_project_plan_days SELECT * FROM project_plan_days;
--> statement-breakpoint
CREATE TABLE codex_context_final_project_plan_dirty (provider TEXT NOT NULL,day TEXT NOT NULL,until_day TEXT,
 sequence INTEGER NOT NULL,PRIMARY KEY(provider,day)) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_project_plan_dirty SELECT * FROM project_plan_dirty;
--> statement-breakpoint
CREATE TABLE codex_context_final_project_plan_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_project_plan_state SELECT * FROM project_plan_state;
--> statement-breakpoint
CREATE TABLE codex_context_final_state(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_state VALUES('version','1');
--> statement-breakpoint
CREATE TABLE codex_context_final_pending(account TEXT NOT NULL,counter TEXT NOT NULL,window_id TEXT NOT NULL,PRIMARY KEY(account,counter,window_id)) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_final_pending SELECT account,counter,window_id FROM window_usage WHERE provider='codex';
--> statement-breakpoint
CREATE TABLE codex_context_final_windows(account TEXT NOT NULL,counter TEXT NOT NULL,window_id TEXT NOT NULL,inputs TEXT NOT NULL,missing INTEGER NOT NULL,PRIMARY KEY(account,counter,window_id)) STRICT;
--> statement-breakpoint
DELETE FROM codex_context_final_project_plan_days WHERE provider='codex';
--> statement-breakpoint
DELETE FROM codex_context_final_project_plan_state;
--> statement-breakpoint
DELETE FROM codex_context_final_project_plan_dirty;
--> statement-breakpoint
DELETE FROM codex_context_final_subscription_capacity_state;
--> statement-breakpoint
DELETE FROM codex_context_final_subscription_capacity_dirty;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_model_insert AFTER INSERT ON codex_context_model_windows BEGIN
 INSERT OR IGNORE INTO codex_context_final_pending VALUES(NEW.account,NEW.counter,NEW.window_id);
 END;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_model_update AFTER UPDATE ON codex_context_model_windows BEGIN
 INSERT OR IGNORE INTO codex_context_final_pending VALUES(NEW.account,NEW.counter,NEW.window_id);
 END;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_model_delete AFTER DELETE ON codex_context_model_windows BEGIN
 INSERT OR IGNORE INTO codex_context_final_pending VALUES(OLD.account,OLD.counter,OLD.window_id);
 END;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_project_insert AFTER INSERT ON codex_context_aggregates WHEN NEW.grain='day' BEGIN
 INSERT INTO codex_context_final_project_plan_dirty(provider,day,until_day,sequence)
 VALUES('codex',date(NEW.day,'-1 day'),NEW.day,(SELECT revision+1 FROM codex_context_state WHERE singleton=1))
 ON CONFLICT(provider,day) DO UPDATE SET sequence=excluded.sequence,until_day=MAX(until_day,excluded.until_day);
 END;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_project_update AFTER UPDATE ON codex_context_aggregates WHEN NEW.grain='day' BEGIN
 INSERT INTO codex_context_final_project_plan_dirty(provider,day,until_day,sequence)
 VALUES('codex',date(NEW.day,'-1 day'),NEW.day,(SELECT revision+1 FROM codex_context_state WHERE singleton=1))
 ON CONFLICT(provider,day) DO UPDATE SET sequence=excluded.sequence,until_day=MAX(until_day,excluded.until_day);
 END;
--> statement-breakpoint
CREATE TRIGGER codex_context_final_project_delete AFTER DELETE ON codex_context_aggregates WHEN OLD.grain='day' BEGIN
 INSERT INTO codex_context_final_project_plan_dirty(provider,day,until_day,sequence)
 VALUES('codex',date(OLD.day,'-1 day'),OLD.day,(SELECT revision+1 FROM codex_context_state WHERE singleton=1))
 ON CONFLICT(provider,day) DO UPDATE SET sequence=excluded.sequence,until_day=MAX(until_day,excluded.until_day);
 END;
