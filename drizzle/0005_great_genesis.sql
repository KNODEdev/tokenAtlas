CREATE TABLE `gemini_probe` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`profile` text,
	`ts` text NOT NULL,
	`limit_group` text NOT NULL,
	`kind` text NOT NULL,
	`remaining_percent` real NOT NULL,
	`resets_at` text,
	`asked_model` text,
	`ok` integer DEFAULT 1 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `gemini_probe_account_ts_idx` ON `gemini_probe` (`account`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `gemini_probe_sample_unique` ON `gemini_probe` (`account`,`limit_group`,`kind`,`ts`);--> statement-breakpoint
CREATE TABLE `grok_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`session_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`ts` text NOT NULL,
	`model` text,
	`stop_reason` text,
	`cwd` text,
	`project` text,
	`path` text NOT NULL,
	`in_tok` integer DEFAULT 0 NOT NULL,
	`cached_in` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`out_tok` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`api_duration_ms` integer DEFAULT 0 NOT NULL,
	`cost_ticks` integer DEFAULT 0 NOT NULL,
	`project_id` text
);
--> statement-breakpoint
CREATE INDEX `grok_events_store_ts_idx` ON `grok_events` (`store`,`ts`);--> statement-breakpoint
CREATE INDEX `grok_events_project_id_idx` ON `grok_events` (`project_id`);--> statement-breakpoint
CREATE INDEX `grok_events_model_idx` ON `grok_events` (`model`);--> statement-breakpoint
CREATE UNIQUE INDEX `grok_events_turn_unique` ON `grok_events` (`store`,`session_id`,`prompt_id`,`model`);--> statement-breakpoint
CREATE TABLE `grok_files` (
	`store` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` real NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`ingested_at` text NOT NULL,
	PRIMARY KEY(`store`, `path`)
);
