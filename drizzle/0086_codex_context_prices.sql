CREATE TABLE codex_context_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL DEFAULT 1,
  cursor INTEGER NOT NULL DEFAULT -1, filled INTEGER NOT NULL DEFAULT 0,
  source_revision INTEGER NOT NULL DEFAULT 0, covered_revision INTEGER NOT NULL DEFAULT -1,
  rules_json TEXT NOT NULL DEFAULT '[]', generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
INSERT INTO codex_context_state(singleton) VALUES(1);
--> statement-breakpoint
CREATE TABLE codex_context_dirty (event_id INTEGER PRIMARY KEY) STRICT;
--> statement-breakpoint
CREATE TABLE codex_context_work (
  model TEXT NOT NULL, from_day TEXT NOT NULL, until_day TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT -1, PRIMARY KEY(model,from_day,until_day)
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_context_events (
  event_id INTEGER PRIMARY KEY, dim_id INTEGER NOT NULL, day TEXT NOT NULL, hour INTEGER,
  cohort TEXT NOT NULL, source_revision TEXT NOT NULL, rule_revision TEXT NOT NULL,
  included INTEGER NOT NULL CHECK(included IN (0,1)), reason TEXT,
  base_n TEXT, base_d TEXT, extra_n TEXT, extra_d TEXT, stored_n TEXT, stored_d TEXT,
  tokens TEXT NOT NULL, long_tokens TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX codex_context_events_scope ON codex_context_events(day,dim_id,hour);
--> statement-breakpoint
CREATE TABLE codex_context_aggregates (
  key TEXT PRIMARY KEY, grain TEXT NOT NULL CHECK(grain IN ('day','hour')),
  day TEXT NOT NULL, hour INTEGER NOT NULL, dim_id INTEGER NOT NULL,
  cohort TEXT NOT NULL, rule_revision TEXT NOT NULL, included INTEGER NOT NULL, reason TEXT,
  calls INTEGER NOT NULL, tokens TEXT NOT NULL, long_tokens TEXT NOT NULL,
  base_n TEXT NOT NULL, base_d TEXT NOT NULL, extra_n TEXT NOT NULL, extra_d TEXT NOT NULL,
  stored_n TEXT NOT NULL, stored_d TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX codex_context_aggregates_day ON codex_context_aggregates(grain,day,dim_id);
--> statement-breakpoint
CREATE INDEX codex_context_aggregates_hour ON codex_context_aggregates(grain,hour,dim_id);
--> statement-breakpoint
CREATE TRIGGER codex_context_insert AFTER INSERT ON codex_price_ledger_events BEGIN
  INSERT OR IGNORE INTO codex_context_dirty(event_id) VALUES(NEW.id);
  UPDATE codex_context_state SET source_revision=source_revision+1 WHERE singleton=1;
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_delete AFTER DELETE ON codex_price_ledger_events BEGIN
  INSERT OR IGNORE INTO codex_context_dirty(event_id) VALUES(OLD.id);
  UPDATE codex_context_state SET source_revision=source_revision+1 WHERE singleton=1;
END;
--> statement-breakpoint
CREATE TRIGGER codex_context_update AFTER UPDATE OF
  dim_id,day,instant_ms,admitted,in_tok,common_reason,invalid_tokens,reported,uncached,cached,writes,output,
  api_band,api_reason,api_whole,api_fraction_hi,api_fraction_lo,
  credit_band,credit_reason,credit_whole,credit_fraction_hi,credit_fraction_lo,copy_state
ON codex_price_ledger_events WHEN
  OLD.dim_id IS NOT NEW.dim_id OR OLD.day IS NOT NEW.day OR OLD.instant_ms IS NOT NEW.instant_ms OR
  OLD.admitted IS NOT NEW.admitted OR OLD.in_tok IS NOT NEW.in_tok OR OLD.common_reason IS NOT NEW.common_reason OR
  OLD.invalid_tokens IS NOT NEW.invalid_tokens OR OLD.reported IS NOT NEW.reported OR
  OLD.uncached IS NOT NEW.uncached OR OLD.cached IS NOT NEW.cached OR OLD.writes IS NOT NEW.writes OR OLD.output IS NOT NEW.output OR
  OLD.api_band IS NOT NEW.api_band OR OLD.api_reason IS NOT NEW.api_reason OR OLD.api_whole IS NOT NEW.api_whole OR
  OLD.api_fraction_hi IS NOT NEW.api_fraction_hi OR OLD.api_fraction_lo IS NOT NEW.api_fraction_lo OR
  OLD.credit_band IS NOT NEW.credit_band OR OLD.credit_reason IS NOT NEW.credit_reason OR OLD.credit_whole IS NOT NEW.credit_whole OR
  OLD.credit_fraction_hi IS NOT NEW.credit_fraction_hi OR OLD.credit_fraction_lo IS NOT NEW.credit_fraction_lo OR
  OLD.copy_state IS NOT NEW.copy_state BEGIN
  INSERT OR IGNORE INTO codex_context_dirty(event_id) VALUES(NEW.id);
  UPDATE codex_context_state SET source_revision=source_revision+1 WHERE singleton=1;
END;
