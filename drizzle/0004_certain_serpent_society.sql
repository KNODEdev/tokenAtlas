CREATE TABLE `claude_probe` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription` text NOT NULL,
	`ts` text NOT NULL,
	`plan` text,
	`kind` text NOT NULL,
	`limit_group` text,
	`scope_label` text,
	`percent` real NOT NULL,
	`severity` text,
	`resets_at` text,
	`is_active` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claude_probe_ts_idx` ON `claude_probe` (`subscription`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `claude_probe_sample_unique` ON `claude_probe` (`subscription`,`kind`,`scope_label`,`ts`);