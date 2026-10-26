CREATE TABLE `gauge_files` (
	`store` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` real NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`rows` integer DEFAULT 0 NOT NULL,
	`ingested_at` text NOT NULL,
	PRIMARY KEY(`store`, `path`)
);
--> statement-breakpoint
ALTER TABLE `account_observations` ADD `machine` text;--> statement-breakpoint
ALTER TABLE `probe_windows` ADD `machine` text;--> statement-breakpoint
CREATE INDEX `probe_windows_provider_ts_idx` ON `probe_windows` (`provider`,`ts`);