CREATE TABLE usage_activity_intervals (
  provider TEXT NOT NULL, day TEXT NOT NULL, dim_id INTEGER NOT NULL, cutoff INTEGER NOT NULL,
  intervals TEXT NOT NULL, PRIMARY KEY(provider, day, dim_id, cutoff)
) STRICT;
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
SELECT DISTINCT provider,'activity',day FROM usage_ledger_days WHERE provider IN ('claude','grok','glm');
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
SELECT DISTINCT 'codex','activity',day FROM codex_price_ledger_aggregates WHERE grain='day';
