CREATE TABLE `codex_probe` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`home` text NOT NULL,
	`ts` text NOT NULL,
	`limit_id` text NOT NULL,
	`limit_name` text,
	`plan_type` text,
	`slot` text NOT NULL,
	`window_minutes` integer,
	`used_percent` real NOT NULL,
	`resets_at` integer,
	`rate_limit_reached` integer DEFAULT 0 NOT NULL,
	`reset_credits` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `codex_probe_account_ts_idx` ON `codex_probe` (`account`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `codex_probe_sample_unique` ON `codex_probe` (`account`,`limit_id`,`slot`,`ts`);