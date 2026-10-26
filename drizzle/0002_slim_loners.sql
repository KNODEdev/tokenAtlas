ALTER TABLE `claude_events` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `claude_events_project_id_idx` ON `claude_events` (`project_id`);--> statement-breakpoint
ALTER TABLE `oc_events` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `oc_events_project_id_idx` ON `oc_events` (`project_id`);