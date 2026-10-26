-- WP4b: one provider-scoped register of priced usage, plus the durable per-event
-- valuation table that replaces the `event:valuation` analysis namespace for new writes.
-- Installed both as a migration and, for fixtures and partially migrated databases,
-- by `installUsagePriceRegister` in src/db/event-valuations.ts.

-- Per-event valuations. The key is the durable source identity plus the valuation
-- variant; the fact, rule and dependency stamps are columns, so a re-parse overwrites
-- the row in place instead of orphaning it under a new content-addressed key.
CREATE TABLE IF NOT EXISTS event_valuations (
  provider TEXT NOT NULL,
  identity TEXT NOT NULL,
  variant TEXT NOT NULL,
  day TEXT NOT NULL,
  facts_stamp TEXT NOT NULL,
  rules_stamp TEXT NOT NULL,
  source_stamp TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (provider, identity, variant)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS event_valuations_day ON event_valuations (provider, day);
--> statement-breakpoint
-- One scope per provider. Accounts are a dimension, not a scope.
CREATE TABLE IF NOT EXISTS usage_price_scopes (
  scope TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  cursor INTEGER NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  rules_digest TEXT NOT NULL,
  sources TEXT NOT NULL,
  attribution TEXT NOT NULL,
  mirror_policy INTEGER NOT NULL
);
--> statement-breakpoint
-- Dimension dictionary: `dim` is analysisHash([account,home,model,speed,subject,billing_mode]).
CREATE TABLE IF NOT EXISTS usage_price_dims (
  scope TEXT NOT NULL,
  dim TEXT NOT NULL,
  account TEXT, home TEXT, model TEXT, speed TEXT, subject TEXT, billing_mode TEXT,
  PRIMARY KEY (scope, dim)
) WITHOUT ROWID;
--> statement-breakpoint
-- One row per deduplicated event identity and day. A conflicted subscription identity
-- carries no amounts but still reports its conflict on every day it was recorded on.
CREATE TABLE IF NOT EXISTS usage_price_contributions (
  scope TEXT NOT NULL,
  identity TEXT NOT NULL,
  day TEXT NOT NULL,
  copy TEXT NOT NULL,
  dim TEXT NOT NULL,
  ts TEXT NOT NULL,
  calls INTEGER NOT NULL,
  tokens TEXT NOT NULL,
  counts TEXT NOT NULL,
  quality TEXT NOT NULL,
  dependency TEXT NOT NULL,
  PRIMARY KEY (scope, identity, day)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_price_contrib_copy ON usage_price_contributions (scope, copy, identity);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_price_contrib_copy_day ON usage_price_contributions (scope, copy, day, ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_price_contrib_dependency ON usage_price_contributions (scope, dependency, identity);
--> statement-breakpoint
-- Physical copies. Only Codex mirrors several copies of one logical rollout; every other
-- provider has exactly one copy per account, which is always selected.
CREATE TABLE IF NOT EXISTS usage_price_copies (
  scope TEXT NOT NULL,
  copy TEXT NOT NULL,
  home TEXT, path TEXT, account TEXT,
  mirror_identity TEXT NOT NULL,
  calls INTEGER NOT NULL,
  last_ts TEXT NOT NULL,
  tokens TEXT NOT NULL,
  selected_all INTEGER NOT NULL,
  PRIMARY KEY (scope, copy)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_price_copy_mirror ON usage_price_copies (scope, mirror_identity);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_price_copy_source ON usage_price_copies (home, path, scope);
--> statement-breakpoint
-- The exact layer: range-dependent mirror selection reads (calls, last_ts, tokens) per
-- copy and day, so a report range reproduces today's per-event copy choice.
CREATE TABLE IF NOT EXISTS usage_price_copy_days (
  scope TEXT NOT NULL,
  copy TEXT NOT NULL,
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  calls INTEGER NOT NULL,
  last_ts TEXT NOT NULL,
  tokens TEXT NOT NULL,
  counts TEXT NOT NULL,
  quality TEXT NOT NULL,
  PRIMARY KEY (scope, copy, day, dim)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_price_copy_day ON usage_price_copy_days (scope, day, copy);
--> statement-breakpoint
-- The fast layer: whole-history copy selection, for account-wide totals.
CREATE TABLE IF NOT EXISTS usage_price_days (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  calls INTEGER NOT NULL,
  tokens TEXT NOT NULL,
  counts TEXT NOT NULL,
  quality TEXT NOT NULL,
  PRIMARY KEY (scope, day, dim)
) WITHOUT ROWID;
--> statement-breakpoint
-- Dated rule partitions. A price correction rewalks only the identities that depend on it.
CREATE TABLE IF NOT EXISTS usage_price_dependencies (
  scope TEXT NOT NULL,
  dependency TEXT NOT NULL,
  model TEXT,
  day TEXT NOT NULL,
  speed TEXT NOT NULL,
  stamp TEXT NOT NULL,
  bookmark TEXT,
  PRIMARY KEY (scope, dependency)
) WITHOUT ROWID;
--> statement-breakpoint
-- Copies whose ownership changed; every contribution of the copy is revisited in batches.
CREATE TABLE IF NOT EXISTS usage_price_tasks (
  scope TEXT NOT NULL,
  copy TEXT NOT NULL,
  home TEXT NOT NULL,
  path TEXT NOT NULL,
  phase TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  PRIMARY KEY (scope, copy)
) WITHOUT ROWID;
