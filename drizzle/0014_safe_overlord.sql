CREATE TABLE `codex_cycle_rollups` (
	`ts` text NOT NULL,
	`home` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`surface` text DEFAULT '' NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`in_tok` integer DEFAULT 0 NOT NULL,
	`cached_in` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`out_tok` integer DEFAULT 0 NOT NULL,
	`reasoning_out` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`ts`, `home`, `path`, `model`, `surface`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `codex_cycle_home_ts_idx` ON `codex_cycle_rollups` (`home`,`ts`);--> statement-breakpoint
CREATE INDEX `codex_cycle_home_path_model_idx` ON `codex_cycle_rollups` (`home`,`path`,`model`);--> statement-breakpoint
CREATE INDEX `codex_cycle_path_home_ts_idx` ON `codex_cycle_rollups` (`path`,`home`,`ts`);--> statement-breakpoint
CREATE INDEX `codex_cycle_path_ts_idx` ON `codex_cycle_rollups` (`path`,`ts`);--> statement-breakpoint
CREATE TABLE `hourly_activity_rollups` (
	`bucket_hour` text NOT NULL,
	`local_day` text NOT NULL,
	`dow` integer NOT NULL,
	`hour` integer NOT NULL,
	`vendor` text NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`tokens_fresh` integer DEFAULT 0 NOT NULL,
	`first_ts` text NOT NULL,
	`last_ts` text NOT NULL,
	PRIMARY KEY(`bucket_hour`, `vendor`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `hourly_activity_vendor_day_idx` ON `hourly_activity_rollups` (`vendor`,`local_day`);--> statement-breakpoint
CREATE INDEX `hourly_activity_project_day_idx` ON `hourly_activity_rollups` (`project_id`,`local_day`);--> statement-breakpoint
CREATE TABLE `project_daily_rollups` (
	`day` text NOT NULL,
	`vendor` text NOT NULL,
	`store` text DEFAULT '' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`cwd` text DEFAULT '' NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`repo` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`speed` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`in_tok` integer DEFAULT 0 NOT NULL,
	`cached_in` integer DEFAULT 0 NOT NULL,
	`cache_read` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`out_tok` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`in_uncached` integer DEFAULT 0 NOT NULL,
	`in_cache_read` integer DEFAULT 0 NOT NULL,
	`in_cache_write` integer DEFAULT 0 NOT NULL,
	`cache_write_5m` integer DEFAULT 0 NOT NULL,
	`cache_write_1h` integer DEFAULT 0 NOT NULL,
	`out_total` integer DEFAULT 0 NOT NULL,
	`out_thinking` integer DEFAULT 0 NOT NULL,
	`cost_ticks` integer DEFAULT 0 NOT NULL,
	`vendor_usd` real DEFAULT 0 NOT NULL,
	`first_ts` text NOT NULL,
	`last_ts` text NOT NULL,
	PRIMARY KEY(`day`, `vendor`, `store`, `owner`, `path`, `cwd`, `project`, `project_id`, `repo`, `model`, `speed`, `provider`)
);
--> statement-breakpoint
CREATE INDEX `project_daily_project_day_idx` ON `project_daily_rollups` (`project_id`,`day`);--> statement-breakpoint
CREATE INDEX `project_daily_vendor_day_idx` ON `project_daily_rollups` (`vendor`,`day`);--> statement-breakpoint
CREATE TABLE `rollup_coverage` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_data_revision` integer DEFAULT -1 NOT NULL,
	`derived_revision` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'stale' NOT NULL,
	`rebuilt_at` text,
	`last_error` text
);
--> statement-breakpoint
INSERT INTO `rollup_coverage` (`id`, `source_data_revision`, `derived_revision`, `status`)
VALUES (1, -1, 0, 'stale');
--> statement-breakpoint
CREATE TABLE `usage_daily_rollups` (
	`day` text NOT NULL,
	`vendor` text NOT NULL,
	`account` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`speed` text DEFAULT '' NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`in_tok` integer DEFAULT 0 NOT NULL,
	`cached_in` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`out_tok` integer DEFAULT 0 NOT NULL,
	`reasoning_out` integer DEFAULT 0 NOT NULL,
	`in_uncached` integer DEFAULT 0 NOT NULL,
	`in_cache_read` integer DEFAULT 0 NOT NULL,
	`in_cache_write` integer DEFAULT 0 NOT NULL,
	`cache_write_5m` integer DEFAULT 0 NOT NULL,
	`cache_write_1h` integer DEFAULT 0 NOT NULL,
	`out_total` integer DEFAULT 0 NOT NULL,
	`out_thinking` integer DEFAULT 0 NOT NULL,
	`first_ts` text NOT NULL,
	`last_ts` text NOT NULL,
	PRIMARY KEY(`day`, `vendor`, `account`, `model`, `speed`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_daily_vendor_day_idx` ON `usage_daily_rollups` (`vendor`,`day`);--> statement-breakpoint
CREATE INDEX `usage_daily_project_day_idx` ON `usage_daily_rollups` (`project_id`,`day`);
