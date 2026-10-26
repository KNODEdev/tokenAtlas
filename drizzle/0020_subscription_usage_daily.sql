CREATE TABLE `subscription_usage_daily` (
	`vendor` text NOT NULL,
	`subscription_id` text NOT NULL,
	`day` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`speed` text DEFAULT '' NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`in_uncached` integer DEFAULT 0 NOT NULL,
	`in_cache_read` integer DEFAULT 0 NOT NULL,
	`in_cache_write` integer DEFAULT 0 NOT NULL,
	`cache_write_5m` integer DEFAULT 0 NOT NULL,
	`cache_write_1h` integer DEFAULT 0 NOT NULL,
	`out_total` integer DEFAULT 0 NOT NULL,
	`cost_ticks` real DEFAULT 0 NOT NULL,
	`vendor_usd` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`vendor`, `subscription_id`, `day`, `source`, `model`, `speed`)
);
--> statement-breakpoint
CREATE INDEX `subscription_usage_vendor_day_idx` ON `subscription_usage_daily` (`vendor`,`day`);
--> statement-breakpoint
UPDATE `rollup_coverage` SET `status` = 'stale', `last_error` = 'Subscription usage projection requires initial backfill' WHERE `id` = 1;
