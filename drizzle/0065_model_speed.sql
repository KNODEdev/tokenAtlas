-- Model output speed (docs/verification/model-speed-2026-10-06.md): the time a Claude call took from the user
-- record it answers to its last block, as a fact of the call (claude_events.resp_ms, copied to its ledger fact),
-- and per day, hour and dimension the timed calls with their output tokens and milliseconds, all of them and those
-- with at least 256 output tokens. New columns only: no row changes, nothing is recomputed here. Existing facts
-- stay untimed (NULL, sums 0) until the timing backfill reads their transcripts again (sync/claude-timing-backfill.ts).
-- The change-tracking triggers of claude_events follow its columns: as in 0041, the exact triggers are handed over
-- (analysis_tracking_handoff) and guards hold every write until installAnalysisTracking reinstalls them, so the new
-- column does not count as possibly missed changes and no analysis revision moves.
CREATE TABLE IF NOT EXISTS analysis_tracking_handoff(source TEXT PRIMARY KEY,columns TEXT NOT NULL,triggers TEXT NOT NULL);
--> statement-breakpoint
INSERT OR REPLACE INTO analysis_tracking_handoff(source,columns,triggers)
SELECT 'claude_events',
  (SELECT json_group_array(c.name) FROM (SELECT name FROM pragma_table_info('claude_events') ORDER BY cid) c),
  (SELECT json_group_object(s.name,s.sql) FROM sqlite_master s WHERE s.type='trigger' AND s.tbl_name='claude_events'
    AND s.name IN ('analysis_claude_events_insert','analysis_claude_events_update','analysis_claude_events_delete'));
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_claude_events_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_claude_events_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_claude_events_delete;
--> statement-breakpoint
CREATE TRIGGER analysis_claude_events_insert BEFORE INSERT ON claude_events BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_claude_events_update BEFORE UPDATE ON claude_events BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_claude_events_delete BEFORE DELETE ON claude_events BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
ALTER TABLE claude_events ADD COLUMN resp_ms INTEGER;
--> statement-breakpoint
ALTER TABLE usage_ledger_facts ADD COLUMN resp_ms INTEGER;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN timed_calls INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN timed_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN timed_long_calls INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN timed_long_out INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_days ADD COLUMN timed_long_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_hours ADD COLUMN timed_calls INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_hours ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_hours ADD COLUMN timed_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_hours ADD COLUMN timed_long_calls INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_hours ADD COLUMN timed_long_out INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE usage_ledger_hours ADD COLUMN timed_long_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Codex: the response time of a priced call (parser 6, `events.resp_ms`, a column the Codex import adds) copied to the
-- per-call ledger, and the timed sums of each aggregate cohort. Old calls stay untimed until their file is imported again.
ALTER TABLE codex_price_ledger_events ADD COLUMN resp_ms INTEGER;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN timed_calls INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN timed_ms INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN timed_long_calls INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN timed_long_out INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_aggregates ADD COLUMN timed_long_ms INTEGER NOT NULL DEFAULT 0;
