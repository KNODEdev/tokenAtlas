CREATE TABLE `gauge_journal_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` text NOT NULL,
	`journal_root` text NOT NULL,
	`archive_root` text,
	`file_name` text NOT NULL,
	`payload` text NOT NULL,
	`queued_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gauge_journal_entry_id` ON `gauge_journal_outbox` (`entry_id`);--> statement-breakpoint
CREATE INDEX `gauge_journal_delivery` ON `gauge_journal_outbox` (`journal_root`,`archive_root`,`id`);--> statement-breakpoint
CREATE TABLE `gauge_journal_receipts` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`ts` text NOT NULL
);
