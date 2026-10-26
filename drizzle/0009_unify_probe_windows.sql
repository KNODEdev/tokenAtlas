CREATE TABLE `probe_windows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`ts` text NOT NULL,
	`plan` text,
	`kind` text NOT NULL,
	`limit_group` text,
	`scope` text,
	`reported_percent_side` text NOT NULL,
	`used_percent` real,
	`remaining_percent` real,
	`vendor_percent` real,
	`window_minutes` real,
	`allowance` real,
	`used` real,
	`remaining` real,
	`resets_at` text,
	`rate_limit_reached` integer,
	`reset_credits` integer,
	`profile` text,
	`ok` integer,
	`error` text,
	`extra` text
);
--> statement-breakpoint
CREATE INDEX `probe_windows_provider_subject_ts_idx` ON `probe_windows` (`provider`,`subject`,`ts`);--> statement-breakpoint
CREATE INDEX `probe_windows_lookup_idx` ON `probe_windows` (`provider`,`subject`,`limit_group`,`kind`,`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `probe_windows_claude_sample_unique` ON `probe_windows` (`provider`,`subject`,`kind`,`scope`,`ts`) WHERE "probe_windows"."provider" = 'claude';--> statement-breakpoint
CREATE UNIQUE INDEX `probe_windows_codex_sample_unique` ON `probe_windows` (`provider`,`subject`,`limit_group`,`kind`,`ts`) WHERE "probe_windows"."provider" = 'codex';--> statement-breakpoint
CREATE UNIQUE INDEX `probe_windows_gemini_sample_unique` ON `probe_windows` (`provider`,`subject`,`limit_group`,`kind`,`ts`) WHERE "probe_windows"."provider" = 'gemini';--> statement-breakpoint
CREATE UNIQUE INDEX `probe_windows_glm_sample_unique` ON `probe_windows` (`provider`,`subject`,`kind`,`ts`) WHERE "probe_windows"."provider" = 'glm';--> statement-breakpoint
INSERT INTO `probe_windows` (
	`provider`, `subject`, `ts`, `plan`, `kind`, `limit_group`, `scope`, `reported_percent_side`,
	`used_percent`, `remaining_percent`, `vendor_percent`, `window_minutes`, `allowance`, `used`,
	`remaining`, `resets_at`, `rate_limit_reached`, `reset_credits`, `profile`, `ok`, `error`, `extra`
)
SELECT
	'claude', `subscription`, `ts`, `plan`, `kind`, `limit_group`, `scope_label`, 'used',
	`percent`, NULL, `percent`, NULL, NULL, NULL,
	NULL, `resets_at`, NULL, NULL, NULL, NULL, NULL,
	json_object('severity', `severity`, 'is_active', json(CASE WHEN `is_active` = 1 THEN 'true' ELSE 'false' END))
FROM `claude_probe`;--> statement-breakpoint
INSERT INTO `probe_windows` (
	`provider`, `subject`, `ts`, `plan`, `kind`, `limit_group`, `scope`, `reported_percent_side`,
	`used_percent`, `remaining_percent`, `vendor_percent`, `window_minutes`, `allowance`, `used`,
	`remaining`, `resets_at`, `rate_limit_reached`, `reset_credits`, `profile`, `ok`, `error`, `extra`
)
SELECT
	'codex', `account`, `ts`, `plan_type`, `slot`, `limit_id`, `limit_name`, 'used',
	`used_percent`, NULL, `used_percent`, `window_minutes`, NULL, NULL,
	NULL,
	CASE WHEN `resets_at` IS NULL THEN NULL
	     ELSE strftime('%Y-%m-%dT%H:%M:%fZ', `resets_at`, 'unixepoch') END,
	`rate_limit_reached`, `reset_credits`, NULL, NULL, NULL, json_object('home', `home`)
FROM `codex_probe`;--> statement-breakpoint
INSERT INTO `probe_windows` (
	`provider`, `subject`, `ts`, `plan`, `kind`, `limit_group`, `scope`, `reported_percent_side`,
	`used_percent`, `remaining_percent`, `vendor_percent`, `window_minutes`, `allowance`, `used`,
	`remaining`, `resets_at`, `rate_limit_reached`, `reset_credits`, `profile`, `ok`, `error`, `extra`
)
SELECT
	'gemini', `account`, `ts`, NULL, `kind`, `limit_group`, `asked_model`, 'remaining',
	CASE WHEN `ok` = 1 THEN MAX(0.0, MIN(100.0, 100.0 - `remaining_percent`)) ELSE NULL END,
	CASE WHEN `ok` = 1 THEN `remaining_percent` ELSE NULL END,
	CASE WHEN `ok` = 1 THEN `remaining_percent` ELSE NULL END,
	NULL, NULL, NULL, NULL, `resets_at`, NULL, NULL, `profile`, `ok`, `error`, NULL
FROM `gemini_probe`;--> statement-breakpoint
INSERT INTO `probe_windows` (
	`provider`, `subject`, `ts`, `plan`, `kind`, `limit_group`, `scope`, `reported_percent_side`,
	`used_percent`, `remaining_percent`, `vendor_percent`, `window_minutes`, `allowance`, `used`,
	`remaining`, `resets_at`, `rate_limit_reached`, `reset_credits`, `profile`, `ok`, `error`, `extra`
)
SELECT
	'glm', `subscription`, `ts`, `level`, `kind`, NULL, NULL, 'used',
	CASE WHEN `allowance` IS NOT NULL OR `vendor_percent` IS NOT NULL THEN `percent` ELSE NULL END,
	NULL, `vendor_percent`, `window_hours` * 60.0, `allowance`, `used`,
	`remaining`, `resets_at`, NULL, NULL, NULL, NULL, NULL, NULL
FROM `glm_probe`;--> statement-breakpoint
CREATE TEMP TABLE `_probe_windows_parity_guard` (
	`provider` text PRIMARY KEY,
	`expected` integer NOT NULL,
	`actual` integer NOT NULL,
	CHECK (`expected` = `actual`)
);--> statement-breakpoint
INSERT INTO `_probe_windows_parity_guard`
SELECT 'claude', (SELECT count(*) FROM `claude_probe`),
	(SELECT count(*) FROM `probe_windows` WHERE `provider` = 'claude');--> statement-breakpoint
INSERT INTO `_probe_windows_parity_guard`
SELECT 'codex', (SELECT count(*) FROM `codex_probe`),
	(SELECT count(*) FROM `probe_windows` WHERE `provider` = 'codex');--> statement-breakpoint
INSERT INTO `_probe_windows_parity_guard`
SELECT 'gemini', (SELECT count(*) FROM `gemini_probe`),
	(SELECT count(*) FROM `probe_windows` WHERE `provider` = 'gemini');--> statement-breakpoint
INSERT INTO `_probe_windows_parity_guard`
SELECT 'glm', (SELECT count(*) FROM `glm_probe`),
	(SELECT count(*) FROM `probe_windows` WHERE `provider` = 'glm');--> statement-breakpoint
-- The parity guard must pass before any legacy probe table is dropped.
DROP TABLE `_probe_windows_parity_guard`;--> statement-breakpoint
DROP TABLE `claude_probe`;--> statement-breakpoint
DROP TABLE `codex_probe`;--> statement-breakpoint
DROP TABLE `gemini_probe`;--> statement-breakpoint
DROP TABLE `glm_probe`;
