-- WP4b follow-up: the two measures WP4c could not recover from the 0034 shape.
--
-- `nested` joins the dimension tuple. The Codex branch of global usage nulls both prices and
-- accumulates `internal_tokens` when the model is an internal review or `events.nested` is
-- 'guardian_review'; the model was already a dimension, `nested` was not. The raw value is
-- stored rather than a derived flag, because it is a live discriminator (`thread_source`)
-- and `(model, nested)` then determines that branch for every reader.
--
-- The projection tables are derived, so they are dropped and recreated once more rather than
-- altered; `event_valuations` is untouched and no amount is recomputed. The same statements
-- also bring a database still on the 0033 shape straight to this one.

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
