CREATE TABLE `sync_revisions` (
	`id` integer PRIMARY KEY NOT NULL,
	`data_revision` integer DEFAULT 0 NOT NULL,
	`config_revision` integer DEFAULT 0 NOT NULL,
	`config_fingerprint` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `sync_revisions` (`id`, `data_revision`, `config_revision`, `config_fingerprint`, `updated_at`)
VALUES (1, 0, 0, '', '1970-01-01T00:00:00.000Z');
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`scope` text NOT NULL,
	`vendor` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`before_data_revision` integer NOT NULL,
	`after_data_revision` integer NOT NULL,
	`before_config_revision` integer NOT NULL,
	`after_config_revision` integer NOT NULL,
	`result_json` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_status_started_idx` ON `sync_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sync_runs_one_running_idx` ON `sync_runs` (`status`) WHERE `status` = 'running';--> statement-breakpoint
CREATE TABLE `vendor_sync_revisions` (
	`vendor` text PRIMARY KEY NOT NULL,
	`data_revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
