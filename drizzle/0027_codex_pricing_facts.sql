-- Preserve request context and missing-counter evidence in the durable projection.
ALTER TABLE subscription_usage_daily ADD COLUMN codex_pricing_facts TEXT;
--> statement-breakpoint
UPDATE rollup_coverage SET status = 'stale';
