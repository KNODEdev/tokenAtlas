-- Cloud session funding (docs/cloud-sessions-import-2026-10-23.md): `billing_mode` of a Claude call is 'grant' when the
-- provider billed it from a promotional cloud credit (the session's `rate_limit_event` reported `ccr_promotional`), NULL
-- otherwise. It is copied to the call's ledger fact, where plan windows leave it out as funded (like Codex credits).
-- New nullable columns only: no row changes, nothing is recomputed here. The change-tracking triggers of claude_events
-- follow its columns and are handed over exactly as in 0065, so the new column moves no analysis revision.
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
ALTER TABLE claude_events ADD COLUMN billing_mode TEXT;
--> statement-breakpoint
ALTER TABLE usage_ledger_facts ADD COLUMN billing_mode TEXT;
