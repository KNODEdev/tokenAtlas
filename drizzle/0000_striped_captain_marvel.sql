CREATE TABLE `claude_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`call_id` text NOT NULL,
	`session_id` text,
	`request_id` text,
	`ts` text NOT NULL,
	`model` text,
	`effort` text,
	`project` text,
	`cwd` text,
	`git_branch` text,
	`entrypoint` text,
	`is_sidechain` integer DEFAULT 0 NOT NULL,
	`agent_id` text,
	`attribution_agent` text,
	`service_tier` text,
	`speed` text,
	`cc_version` text,
	`path` text NOT NULL,
	`in_uncached` integer DEFAULT 0 NOT NULL,
	`in_cache_read` integer DEFAULT 0 NOT NULL,
	`in_cache_write` integer DEFAULT 0 NOT NULL,
	`cache_write_5m` integer DEFAULT 0 NOT NULL,
	`cache_write_1h` integer DEFAULT 0 NOT NULL,
	`out_total` integer DEFAULT 0 NOT NULL,
	`out_thinking` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claude_events_store_ts_idx` ON `claude_events` (`store`,`ts`);--> statement-breakpoint
CREATE INDEX `claude_events_store_path_idx` ON `claude_events` (`store`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `claude_events_store_call_id_unique` ON `claude_events` (`store`,`call_id`);--> statement-breakpoint
CREATE TABLE `claude_files` (
	`store` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` real NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`ingested_at` text NOT NULL,
	PRIMARY KEY(`store`, `path`)
);
