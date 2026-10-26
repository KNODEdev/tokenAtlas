-- Stage 4 final schema. Account ownership stays in account_periods; recorded Claude
-- subscription_id remains authentic session evidence and is deliberately preserved.

-- Pre-v8 Codex price register. Its triggers on events read rollout_owner and its own
-- tables; they must go before any statement below revalidates the schema.
DROP TRIGGER IF EXISTS codex_price_revision_events_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_price_revision_events_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_price_revision_events_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_price_revision_rollout_owner_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_price_revision_rollout_owner_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS codex_price_revision_rollout_owner_delete;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_state;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_scopes;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_invalidations;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_tasks;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_contributions;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_copies;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_copy_days;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_days;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_dependencies;
--> statement-breakpoint

-- Tracking of probe_windows and project_daily_rollups must be dropped for the column changes
-- below. The former triggers and columns are handed to installAnalysisTracking, which keeps
-- revisions only when the former triggers were exact trackers. Until then guards reject
-- every write, so nothing can change these sources untracked. No row of either changes
-- meaning here: the dropped probe column has no reader and merged rollups keep their sums.
CREATE TABLE analysis_tracking_handoff(source TEXT PRIMARY KEY,columns TEXT NOT NULL,triggers TEXT NOT NULL);
--> statement-breakpoint
INSERT INTO analysis_tracking_handoff(source,columns,triggers)
SELECT name,
  (SELECT json_group_array(c.name) FROM (SELECT name FROM pragma_table_info(t.name) ORDER BY cid) c),
  (SELECT json_group_object(s.name,s.sql) FROM sqlite_master s WHERE s.type='trigger' AND s.tbl_name=t.name
    AND s.name IN ('analysis_'||t.name||'_insert','analysis_'||t.name||'_update','analysis_'||t.name||'_delete'))
FROM sqlite_master t WHERE t.type='table' AND t.name IN ('probe_windows','project_daily_rollups');
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_probe_windows_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_probe_windows_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_probe_windows_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_windows_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_windows_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_windows_delete;
--> statement-breakpoint
CREATE TRIGGER analysis_probe_windows_insert BEFORE INSERT ON probe_windows BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_probe_windows_update BEFORE UPDATE ON probe_windows BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_probe_windows_delete BEFORE DELETE ON probe_windows BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_change_probe_windows_insert BEFORE INSERT ON probe_windows BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_change_probe_windows_update BEFORE UPDATE ON probe_windows BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_change_probe_windows_delete BEFORE DELETE ON probe_windows BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
ALTER TABLE probe_windows DROP COLUMN era_unattributed;
--> statement-breakpoint

-- Five observed owner-split keys collide after removing owner. The table copy
-- merges all 16 measures and retains the earliest/latest fact times exactly.
CREATE TABLE project_daily_rollups_w9 (
  day TEXT NOT NULL, vendor TEXT NOT NULL, store TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  speed TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0, in_tok INTEGER NOT NULL DEFAULT 0,
  cached_in INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0, in_uncached INTEGER NOT NULL DEFAULT 0,
  in_cache_read INTEGER NOT NULL DEFAULT 0, in_cache_write INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0, cache_write_1h INTEGER NOT NULL DEFAULT 0,
  out_total INTEGER NOT NULL DEFAULT 0, out_thinking INTEGER NOT NULL DEFAULT 0,
  cost_ticks INTEGER NOT NULL DEFAULT 0, vendor_usd REAL NOT NULL DEFAULT 0,
  first_ts TEXT NOT NULL, last_ts TEXT NOT NULL,
  PRIMARY KEY(day,vendor,store,path,cwd,project,project_id,repo,model,speed,provider)
);
--> statement-breakpoint
INSERT INTO project_daily_rollups_w9 (
  day,vendor,store,path,cwd,project,project_id,repo,model,speed,provider,
  calls,in_tok,cached_in,cache_read,cache_write,out_tok,reasoning,in_uncached,
  in_cache_read,in_cache_write,cache_write_5m,cache_write_1h,out_total,out_thinking,
  cost_ticks,vendor_usd,first_ts,last_ts
)
SELECT day,vendor,store,path,cwd,project,project_id,repo,model,speed,provider,
  SUM(calls),SUM(in_tok),SUM(cached_in),SUM(cache_read),SUM(cache_write),SUM(out_tok),
  SUM(reasoning),SUM(in_uncached),SUM(in_cache_read),SUM(in_cache_write),
  SUM(cache_write_5m),SUM(cache_write_1h),SUM(out_total),SUM(out_thinking),
  SUM(cost_ticks),SUM(vendor_usd),MIN(first_ts),MAX(last_ts)
FROM project_daily_rollups
GROUP BY day,vendor,store,path,cwd,project,project_id,repo,model,speed,provider;
--> statement-breakpoint
DROP TABLE IF EXISTS project_daily_rollups;
--> statement-breakpoint
ALTER TABLE project_daily_rollups_w9 RENAME TO project_daily_rollups;
--> statement-breakpoint
CREATE INDEX project_daily_project_day_idx ON project_daily_rollups(project_id,day);
--> statement-breakpoint
CREATE INDEX project_daily_vendor_day_idx ON project_daily_rollups(vendor,day);
--> statement-breakpoint
CREATE TRIGGER analysis_project_daily_rollups_insert BEFORE INSERT ON project_daily_rollups BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_project_daily_rollups_update BEFORE UPDATE ON project_daily_rollups BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint
CREATE TRIGGER analysis_project_daily_rollups_delete BEFORE DELETE ON project_daily_rollups BEGIN SELECT RAISE(ABORT,'analysis tracking reinstall pending'); END;
--> statement-breakpoint

-- Version 8 already stores physical identity and source in these columns.
-- Rename in place to preserve every register row and all indexes.
ALTER TABLE usage_price_copies RENAME COLUMN account TO source;
--> statement-breakpoint
ALTER TABLE usage_price_meter_models RENAME COLUMN account TO source;
--> statement-breakpoint
ALTER TABLE usage_price_dims RENAME COLUMN account TO identity;
--> statement-breakpoint
ALTER TABLE usage_price_dims RENAME COLUMN home TO source;
--> statement-breakpoint
ALTER TABLE usage_price_scopes DROP COLUMN attribution;
--> statement-breakpoint

-- Remove only unambiguous pre-v8 account-keyed subscription valuations.
DELETE FROM event_valuations
WHERE provider <> 'codex'
  AND variant IN ('dated-actual-api','dated-standard-api')
  AND CASE WHEN json_valid(identity) THEN
    CASE WHEN json_type(identity)='array' AND json_array_length(identity)=4
      THEN json_type(identity,'$[2]')='text' AND instr(json_extract(identity,'$[2]'),'/')=0
      ELSE 0 END
    ELSE 0 END;
--> statement-breakpoint

-- Drop retired source/binding and account-stamp projections in child-first order.
DROP TABLE IF EXISTS probe_attributions;
--> statement-breakpoint
DROP TABLE IF EXISTS probe_attribution_checkpoints;
--> statement-breakpoint
DROP TABLE IF EXISTS probe_attribution_dirty;
--> statement-breakpoint
DROP TABLE IF EXISTS probe_attribution_state;
--> statement-breakpoint
DROP TABLE IF EXISTS probe_attribution_generations;
--> statement-breakpoint
DROP TABLE IF EXISTS source_aliases;
--> statement-breakpoint
DROP TABLE IF EXISTS source_replicas;
--> statement-breakpoint
DROP TABLE IF EXISTS logical_sources;
--> statement-breakpoint
DROP TABLE IF EXISTS source_runtimes;
--> statement-breakpoint
DROP TABLE IF EXISTS source_machines;
--> statement-breakpoint
DROP TABLE IF EXISTS source_backfill_checkpoints;
--> statement-breakpoint
DROP TABLE IF EXISTS source_mapping_conflicts;
--> statement-breakpoint
DROP TABLE IF EXISTS source_mapping_versions;
--> statement-breakpoint
DROP TABLE IF EXISTS source_binding_conflicts;
--> statement-breakpoint
DROP TABLE IF EXISTS source_binding_versions;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_fact_total_contributions;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_fact_total_days;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_fact_total_dirty;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_fact_total_state;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_price_contributions;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_price_days;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_price_dependencies;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_price_dirty;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_price_state;
--> statement-breakpoint
DROP TABLE IF EXISTS account_observations;
--> statement-breakpoint
DROP TABLE IF EXISTS rollout_owner;
--> statement-breakpoint
DROP TABLE IF EXISTS ratelimit_owner;
--> statement-breakpoint
-- analysis_attribution_dirty stays: former tracking triggers on events/ratelimit still write to it.
-- installAnalysisTracking replaces those triggers and then drops it (see analysis.ts).
DELETE FROM analysis_source_revisions WHERE source IN ('rollout_owner','ratelimit_owner');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
--> statement-breakpoint
DELETE FROM meta WHERE key IN ('eras_fingerprint','local_mapping_cache');
