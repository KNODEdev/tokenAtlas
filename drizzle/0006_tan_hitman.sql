CREATE TABLE `gemini_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`conversation_id` text NOT NULL,
	`gen_idx` integer NOT NULL,
	`ts` text NOT NULL,
	`ts_basis` text NOT NULL,
	`model` text,
	`workspace` text,
	`path` text NOT NULL,
	`fresh_in` integer DEFAULT 0 NOT NULL,
	`cached_in` integer DEFAULT 0 NOT NULL,
	`out_total` integer DEFAULT 0 NOT NULL,
	`out_thinking` integer DEFAULT 0 NOT NULL,
	`out_visible` integer DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`context_limit` integer DEFAULT 0 NOT NULL,
	`usd` real DEFAULT 0 NOT NULL,
	`project_id` text
);
--> statement-breakpoint
CREATE INDEX `gemini_events_store_ts_idx` ON `gemini_events` (`store`,`ts`);--> statement-breakpoint
CREATE INDEX `gemini_events_model_idx` ON `gemini_events` (`model`);--> statement-breakpoint
CREATE UNIQUE INDEX `gemini_events_gen_unique` ON `gemini_events` (`store`,`conversation_id`,`gen_idx`);--> statement-breakpoint
CREATE TABLE `gemini_files` (
	`store` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` real NOT NULL,
	`generations` integer DEFAULT 0 NOT NULL,
	`ingested_at` text NOT NULL,
	PRIMARY KEY(`store`, `path`)
);
