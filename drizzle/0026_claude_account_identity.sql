ALTER TABLE claude_events ADD COLUMN account_key text;
--> statement-breakpoint
ALTER TABLE claude_files ADD COLUMN parser_version integer NOT NULL DEFAULT 0;
