ALTER TABLE grok_events ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE grok_files ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
DROP INDEX grok_events_turn_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX grok_events_turn_unique ON grok_events(store, source_id, session_id, prompt_id, model);
