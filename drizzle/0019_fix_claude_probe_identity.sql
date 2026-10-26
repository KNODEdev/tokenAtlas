DROP INDEX `probe_windows_claude_sample_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `probe_windows_claude_sample_unique` ON `probe_windows` (`provider`,`subject`,`kind`,`limit_group`,`scope`,`ts`) WHERE "probe_windows"."provider" = 'claude';
