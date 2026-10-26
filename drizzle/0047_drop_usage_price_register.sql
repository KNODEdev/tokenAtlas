-- The usage ledger (0046) and the Codex price ledger replace the provider-scoped register (usage_price_*),
-- the subscription fact index (subscription_fact_*) and the per-event valuation cache (event_valuations).
DROP TABLE IF EXISTS usage_price_scopes;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_dims;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_contributions;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_copies;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_copy_days;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_days;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_dependencies;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_tasks;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_selection;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_dirty_days;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_copy_buckets;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_bucket_state;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_meter_models;
--> statement-breakpoint
DROP TABLE IF EXISTS event_valuations;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_fact_versions;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_fact_scopes;
