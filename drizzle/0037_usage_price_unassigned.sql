-- WP4f: contributions for traffic no declared account owns.
--
-- The subscription fact index is built per declared account, so it never indexes a row whose
-- subscription does not resolve, whose provider identity the source recorded incompletely, or -
-- for OpenCode - whose vendor is outside the GLM plan. Global usage has always counted all of
-- them, which is why its subscription branch still walked events. The register now indexes them
-- on a second track, under global usage's own identity `[vendor, home, identity]`.
--
-- `usage_price_dims.vendor` carries the rate vendor global usage prices such a row under, and is
-- NULL for every contribution a provider's own accounting track owns. Account-scoped readers add
-- `vendor IS NULL`, which excludes unassigned traffic whatever account its own evidence names.
--
-- The projection tables are derived, so they are dropped and recreated once more: the dimension
-- tuple changed, and the stored measures gained the `api_global` variant and the `source_events`
-- and `attribution_conflicts` counters. `event_valuations` is untouched, so no price is recomputed.
--
-- `grok_events` also needs an index on the global turn identity, because its unique index leads
-- with `source_id`, which that identity does not carry. It is installed by `ensureRawSyncIndexes`
-- instead of here, because this file is also executed on databases that have no provider tables.

-- A populated v5 database must not come out of this looking like a database that never had a
-- register: `absent` is the one state a reader may answer from the pre-register per-event path,
-- so dropping the scope rows outright would turn an upgrade into silent per-event work on every
-- read until the worker got round to rebuilding. The providers are carried across and re-seeded
-- as superseded rows, which readers report as "preparation required" and which the producer
-- discards and rebuilds on its first batch.
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
DROP TABLE IF EXISTS usage_price_superseded;
--> statement-breakpoint
CREATE TABLE usage_price_superseded AS SELECT scope, provider, version FROM usage_price_scopes;
--> statement-breakpoint
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
  -- Codex: the declared mirror source homes. A subscription provider: the prepared fact-index
  -- accounts, because that set decides which of the two tracks owns a source row.
  sources TEXT NOT NULL,
  attribution TEXT NOT NULL,
  mirror_policy INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE usage_price_dims (
  scope TEXT NOT NULL,
  dim TEXT NOT NULL,
  account TEXT, home TEXT, model TEXT, speed TEXT, subject TEXT, billing_mode TEXT, surface TEXT, nested TEXT,
  -- The global-usage rate vendor of unassigned traffic; NULL for a provider's own track.
  vendor TEXT,
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
  -- The ordering key of the recorded copy this contribution was built from: the subscription
  -- fact index's `source_key`, which is the source row id as TEXT. The report path orders
  -- events by `(ts, source_key)` compared as text, so `"10"` precedes `"2"`; reproducing its row
  -- order needs the key of each group's earliest event, not only that event's instant.
  source_key TEXT NOT NULL DEFAULT '',
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
  -- The ordering key of the earliest contribution of the group, carried beside its instant:
  -- `(first_ts, first_key)` is the minimum of the `(ts, source_key)` pairs, which is the pair
  -- the report path orders its events by.
  first_key TEXT NOT NULL DEFAULT '',
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
  first_key TEXT NOT NULL DEFAULT '',
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
--> statement-breakpoint
-- The carried providers, re-seeded under their previous version so that a reader reports
-- "preparation required" rather than "never ran", and the producer's own version check discards
-- and rebuilds the scope on its first batch. `event_valuations` is untouched by all of this, so
-- the rebuild re-aggregates without repricing a single event.
INSERT INTO usage_price_scopes (scope, provider, version, cursor, phase, status, bookmark,
    rules_digest, sources, attribution, mirror_policy)
  SELECT scope, provider, version, 0, 'backfill', 'superseded', '', '', '', '', 0
  FROM usage_price_superseded;
--> statement-breakpoint
DROP TABLE usage_price_superseded;
