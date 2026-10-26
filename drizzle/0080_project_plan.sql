CREATE TABLE project_plan_days (provider TEXT NOT NULL,day TEXT NOT NULL,signature TEXT NOT NULL,
 checked INTEGER NOT NULL,body TEXT NOT NULL,computed_at TEXT NOT NULL,PRIMARY KEY(provider,day)) STRICT;
--> statement-breakpoint
CREATE TABLE project_plan_dirty (provider TEXT NOT NULL,day TEXT NOT NULL,until_day TEXT,
 sequence INTEGER NOT NULL,PRIMARY KEY(provider,day)) STRICT;
--> statement-breakpoint
CREATE TABLE project_plan_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
