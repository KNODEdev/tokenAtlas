CREATE TABLE `glm_probe` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription` text NOT NULL,
	`ts` text NOT NULL,
	`level` text,
	`kind` text NOT NULL,
	`window_hours` real,
	`allowance` real,
	`used` real NOT NULL,
	`remaining` real,
	`percent` real NOT NULL,
	`resets_at` text
);
--> statement-breakpoint
CREATE INDEX `glm_probe_ts_idx` ON `glm_probe` (`subscription`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `glm_probe_sample_unique` ON `glm_probe` (`subscription`,`kind`,`ts`);