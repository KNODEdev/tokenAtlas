-- WP4b follow-up: the four producer defects found by the WP4 review.
--
-- `usage_price_copies.mirror_identity` is now derived from the stable physical-copy owner
-- (`rollout_owner`, or the declared home mapping), never from an event's era-resolved account,
-- so two copies of one rollout cannot land in different mirror groups and double-count.
-- `usage_price_copies.tokens` now holds the same reported measure the legacy selector compares
-- (`COALESCE(in_tok,0)+COALESCE(out_tok,0)`), not the sum of every bucket.
--
-- The two new queues make copy selection and day publication bounded and resumable: a batch
-- enqueues what it invalidated and drains a bounded slice, instead of re-selecting every mirror
-- group and republishing every touched day inside one transaction.
--
-- The projection tables are derived, so they are dropped and recreated once more; both stored
-- measures above changed meaning, so an existing register has to be rebuilt from facts. The
-- valuations in `event_valuations` are untouched, so no price is recomputed.

DROP TABLE IF EXISTS usage_price_selection;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_price_dirty_days;
--> statement-breakpoint
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
DROP TABLE IF EXISTS usage_price_meter_models;
--> statement-breakpoint
CREATE TABLE usage_price_scopes (
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
CREATE TABLE usage_price_dims (
  scope TEXT NOT NULL,
  dim TEXT NOT NULL,
  account TEXT, home TEXT, model TEXT, speed TEXT, subject TEXT, billing_mode TEXT, surface TEXT, nested TEXT,
  PRIMARY KEY (scope, dim)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE usage_price_contributions (
  scope TEXT NOT NULL,
  identity TEXT NOT NULL,
  day TEXT NOT NULL,
  copy TEXT NOT NULL,
  dim TEXT NOT NULL,
  ts TEXT NOT NULL,
  calls INTEGER NOT NULL,
  tokens TEXT NOT NULL,
  tokens_reported TEXT NOT NULL,
  counts TEXT NOT NULL,
  quality TEXT NOT NULL,
  dependency TEXT NOT NULL,
  -- -1 stands for "this event declared no meter reset"; see usage_price_meter_models.
  meter_reset INTEGER NOT NULL DEFAULT -1,
  PRIMARY KEY (scope, identity, day)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX usage_price_contrib_copy ON usage_price_contributions (scope, copy, identity);
--> statement-breakpoint
CREATE INDEX usage_price_contrib_copy_day ON usage_price_contributions (scope, copy, day, ts);
--> statement-breakpoint
CREATE INDEX usage_price_contrib_copy_day_dim ON usage_price_contributions (scope, copy, day, dim, ts);
--> statement-breakpoint
CREATE INDEX usage_price_contrib_dependency ON usage_price_contributions (scope, dependency, identity);
--> statement-breakpoint
CREATE TABLE usage_price_copies (
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
CREATE INDEX usage_price_copy_mirror ON usage_price_copies (scope, mirror_identity);
--> statement-breakpoint
CREATE INDEX usage_price_copy_source ON usage_price_copies (home, path, scope);
--> statement-breakpoint
CREATE TABLE usage_price_copy_days (
  scope TEXT NOT NULL,
  copy TEXT NOT NULL,
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  calls INTEGER NOT NULL,
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  tokens TEXT NOT NULL,
  tokens_reported TEXT NOT NULL,
  counts TEXT NOT NULL,
  quality TEXT NOT NULL,
  PRIMARY KEY (scope, copy, day, dim)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX usage_price_copy_day ON usage_price_copy_days (scope, day, copy);
--> statement-breakpoint
CREATE TABLE usage_price_days (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  calls INTEGER NOT NULL,
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  tokens TEXT NOT NULL,
  tokens_reported TEXT NOT NULL,
  counts TEXT NOT NULL,
  quality TEXT NOT NULL,
  PRIMARY KEY (scope, day, dim)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE usage_price_dependencies (
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
CREATE TABLE usage_price_tasks (
  scope TEXT NOT NULL,
  copy TEXT NOT NULL,
  home TEXT NOT NULL,
  path TEXT NOT NULL,
  phase TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  PRIMARY KEY (scope, copy)
) WITHOUT ROWID;
--> statement-breakpoint
-- Spark/main evidence per rollout. `spark` and `main` are event counts, not flags, so a
-- removed event subtracts exactly what it added; a reader takes `SUM(...) > 0` as the flag.
-- `meter_reset = -1` is the path-level row the report keeps beside each reset-level row, and
-- an empty `account` stands for unattributed traffic, because a WITHOUT ROWID key cannot be NULL.
CREATE TABLE usage_price_meter_models (
  scope TEXT NOT NULL,
  home TEXT NOT NULL,
  path TEXT NOT NULL,
  meter_reset INTEGER NOT NULL,
  day TEXT NOT NULL,
  account TEXT NOT NULL,
  spark INTEGER NOT NULL,
  main INTEGER NOT NULL,
  PRIMARY KEY (scope, home, path, meter_reset, day, account)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX usage_price_meter_day ON usage_price_meter_models (scope, day);
--> statement-breakpoint

-- Mirror groups whose copy selection is stale, and days whose published totals are stale.
-- Both are drained in bounded slices charged against the batch limit.
CREATE TABLE usage_price_selection (
  scope TEXT NOT NULL,
  mirror_identity TEXT NOT NULL,
  PRIMARY KEY (scope, mirror_identity)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE usage_price_dirty_days (
  scope TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (scope, day)
) WITHOUT ROWID;
