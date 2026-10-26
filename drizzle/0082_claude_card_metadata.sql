CREATE TABLE IF NOT EXISTS claude_card_members(account TEXT NOT NULL,probe_id INTEGER NOT NULL,at_ms INTEGER NOT NULL,
 reset_ms REAL,reset_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,probe_id)) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claude_card_member_time ON claude_card_members(account,at_ms,probe_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS claude_card_member_reset ON claude_card_members(account,reset_ms);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claude_card_components(account TEXT NOT NULL,component TEXT NOT NULL,from_ms REAL,until_ms REAL,
 observations INTEGER NOT NULL,samples INTEGER NOT NULL,PRIMARY KEY(account,component)) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claude_card_state(account TEXT PRIMARY KEY,version INTEGER NOT NULL) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claude_card_dirty_probes(account TEXT NOT NULL,probe_id INTEGER NOT NULL,PRIMARY KEY(account,probe_id)) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claude_card_dirty_ranges(account TEXT NOT NULL,from_ms INTEGER NOT NULL,until_ms INTEGER,after_id INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(account,from_ms)) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS claude_card_component_work(account TEXT NOT NULL,component TEXT NOT NULL,from_ms REAL,until_ms REAL,
 PRIMARY KEY(account,component)) STRICT;
