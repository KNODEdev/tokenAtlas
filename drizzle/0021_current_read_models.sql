-- Current projection tables; GET endpoints must not rebuild them.
CREATE TABLE `current_probe_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`kind` text NOT NULL,
	`limit_group` text NOT NULL,
	`scope` text NOT NULL,
	`window_minutes` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `current_probe_keys_subject` ON `current_probe_keys` (`provider`,`subject`);--> statement-breakpoint
CREATE TABLE `current_probe_subjects` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`data` text NOT NULL,
	`generated_at` text NOT NULL,
	`next_refresh_at` text,
	PRIMARY KEY(`provider`, `subject`)
);
--> statement-breakpoint
CREATE TABLE `current_projection_dirty` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	PRIMARY KEY(`provider`, `subject`)
);
--> statement-breakpoint
CREATE TABLE `current_projection_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`probe_revision` integer DEFAULT 0 NOT NULL,
	`published_probe_revision` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`config_fingerprint` text DEFAULT '' NOT NULL,
	`generated_at` text,
	`error_code` text,
	CONSTRAINT "current_projection_singleton" CHECK("current_projection_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `subscription_current` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
-- Expression indexes are hand-maintained: keep the normalized predicates in store.ts aligned.
CREATE INDEX probe_current_key_lookup ON probe_windows (
  provider, lower(subject), kind, coalesce(limit_group, ''), coalesce(scope, ''),
  coalesce(window_minutes, -1), julianday(ts) DESC, id DESC
);--> statement-breakpoint
CREATE INDEX `probe_current_subject_lookup` ON `probe_windows` (`provider`,lower(subject),julianday(ts) DESC,id DESC);
--> statement-breakpoint
INSERT INTO current_projection_state(id) VALUES (1);
--> statement-breakpoint
CREATE TRIGGER probe_current_after_insert AFTER INSERT ON probe_windows BEGIN
  INSERT OR IGNORE INTO current_probe_keys VALUES (json_array(NEW.provider, lower(NEW.subject), NEW.kind, coalesce(NEW.limit_group, ''), coalesce(NEW.scope, ''), coalesce(NEW.window_minutes, -1)), NEW.provider, lower(NEW.subject), NEW.kind, coalesce(NEW.limit_group, ''), coalesce(NEW.scope, ''), coalesce(NEW.window_minutes, -1));
  INSERT OR IGNORE INTO current_projection_dirty VALUES (NEW.provider, lower(NEW.subject));
  UPDATE current_projection_state SET probe_revision = probe_revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER probe_current_after_update AFTER UPDATE ON probe_windows BEGIN
  INSERT OR IGNORE INTO current_probe_keys VALUES (json_array(NEW.provider, lower(NEW.subject), NEW.kind, coalesce(NEW.limit_group, ''), coalesce(NEW.scope, ''), coalesce(NEW.window_minutes, -1)), NEW.provider, lower(NEW.subject), NEW.kind, coalesce(NEW.limit_group, ''), coalesce(NEW.scope, ''), coalesce(NEW.window_minutes, -1));
  INSERT OR IGNORE INTO current_projection_dirty VALUES (OLD.provider, lower(OLD.subject));
  INSERT OR IGNORE INTO current_projection_dirty VALUES (NEW.provider, lower(NEW.subject));
  UPDATE current_projection_state SET probe_revision = probe_revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER probe_current_after_delete AFTER DELETE ON probe_windows BEGIN
  INSERT OR IGNORE INTO current_projection_dirty VALUES (OLD.provider, lower(OLD.subject));
  UPDATE current_projection_state SET probe_revision = probe_revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
INSERT OR IGNORE INTO current_probe_keys SELECT json_array(p.provider, lower(p.subject), p.kind, coalesce(p.limit_group, ''), coalesce(p.scope, ''), coalesce(p.window_minutes, -1)), p.provider, lower(p.subject), p.kind, coalesce(p.limit_group, ''), coalesce(p.scope, ''), coalesce(p.window_minutes, -1) FROM probe_windows p;
--> statement-breakpoint
INSERT OR IGNORE INTO current_projection_dirty SELECT provider, subject FROM current_probe_keys;
--> statement-breakpoint
UPDATE current_projection_state SET probe_revision = 1 WHERE EXISTS (SELECT 1 FROM current_projection_dirty);
