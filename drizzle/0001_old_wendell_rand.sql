CREATE TABLE `oc_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`message_id` text NOT NULL,
	`session_id` text,
	`ts` text NOT NULL,
	`model` text,
	`provider` text,
	`agent` text,
	`mode` text,
	`project` text,
	`directory` text,
	`in_tok` integer DEFAULT 0 NOT NULL,
	`out_tok` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`cache_read` integer DEFAULT 0 NOT NULL,
	`cache_write` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oc_events_store_ts_idx` ON `oc_events` (`store`,`ts`);--> statement-breakpoint
CREATE INDEX `oc_events_model_idx` ON `oc_events` (`model`);--> statement-breakpoint
CREATE UNIQUE INDEX `oc_events_store_message_unique` ON `oc_events` (`store`,`message_id`);