CREATE INDEX `claude_events_ts_idx` ON `claude_events` (`ts`);--> statement-breakpoint
CREATE INDEX `gemini_events_ts_idx` ON `gemini_events` (`ts`);--> statement-breakpoint
CREATE INDEX `grok_events_ts_idx` ON `grok_events` (`ts`);--> statement-breakpoint
CREATE INDEX `oc_events_ts_idx` ON `oc_events` (`ts`);