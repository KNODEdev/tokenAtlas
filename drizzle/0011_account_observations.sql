CREATE TABLE `account_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`vendor` text NOT NULL,
	`source` text NOT NULL,
	`identity_kind` text NOT NULL,
	`identity` text NOT NULL,
	`raw_source` text
);
--> statement-breakpoint
CREATE INDEX `account_observations_vendor_source_ts_idx` ON `account_observations` (`vendor`,`source`,`ts`);