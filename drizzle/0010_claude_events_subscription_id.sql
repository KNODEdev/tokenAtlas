ALTER TABLE `claude_events` ADD `subscription_id` text;--> statement-breakpoint
ALTER TABLE `claude_events` ADD `subscription_conflict` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `claude_events_subscription_id_idx` ON `claude_events` (`subscription_id`);