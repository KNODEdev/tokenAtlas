-- M2 of docs/stored-activity-plan-2026-10-07.md (step 7): project rules apply at read time (src/projects/resolve.ts), so the
-- ledgers' dimensions are keyed by the place of a call and no longer by its project.
-- Usage ledger: key json_array(source, account key, model, speed, vendor, home, project name, cwd, repo, repo group, shift),
--   `shift` being the raw day of the calls' timestamps less their UTC day (-1, 0 or 1), so a dated rule reads each stored row
--   on its calls' raw day. `subject` and `project_id` are no longer filled.
-- Codex: key json_array(source, home, model, service_tier, speed, billing_mode, surface, nested, plan_type, meter_reset,
--   repo, project, cwd) - without subject and project id.
-- Dimensions are relabelled in place; those that now share a key merge into the least id, their day, hour, reason, cohort
-- and per-file rows summed (sums, MIN and MAX only, so exact) and their calls moved. The old -> new map must be a function:
-- a dimension whose calls carry more than one shift stops the migration (CHECK constraint failed:
-- dims_with_several_shifts = 0) - such a ledger is rebuilt from its source rows instead.
ALTER TABLE usage_ledger_dims ADD COLUMN shift INTEGER;
--> statement-breakpoint
CREATE TEMP TABLE migration_0069_guard(dims_with_several_shifts INTEGER NOT NULL CHECK(dims_with_several_shifts = 0));
--> statement-breakpoint
INSERT INTO temp.migration_0069_guard SELECT COUNT(*) FROM (SELECT provider, dim_id FROM usage_ledger_facts WHERE dim_id IS NOT NULL
  GROUP BY provider, dim_id HAVING COUNT(DISTINCT CAST(julianday(src_day) - julianday(day) AS INTEGER)) > 1);
--> statement-breakpoint
DROP TABLE temp.migration_0069_guard;
--> statement-breakpoint
CREATE TEMP TABLE m0069_shift AS SELECT provider, dim_id old, MIN(CAST(julianday(src_day) - julianday(day) AS INTEGER)) shift
  FROM usage_ledger_facts WHERE dim_id IS NOT NULL GROUP BY provider, dim_id;
--> statement-breakpoint
CREATE TEMP TABLE m0069_usage AS SELECT d.provider, d.id old,
    json_array(d.source, d.identity, d.model, d.speed, d.vendor, d.home, d.project, d.cwd, d.repo, d.repo_group, COALESCE(s.shift, 0)) key,
    COALESCE(s.shift, 0) shift, 0 survivor
  FROM usage_ledger_dims d LEFT JOIN temp.m0069_shift s ON s.provider=d.provider AND s.old=d.id;
--> statement-breakpoint
CREATE INDEX temp.m0069_usage_key ON m0069_usage(provider, key, old);
--> statement-breakpoint
UPDATE temp.m0069_usage AS m SET survivor=(SELECT MIN(o.old) FROM temp.m0069_usage o WHERE o.provider=m.provider AND o.key=m.key);
--> statement-breakpoint
CREATE INDEX temp.m0069_usage_old ON m0069_usage(provider, old);
--> statement-breakpoint
CREATE TEMP TABLE m0069_codex AS SELECT id old,
    json_array(source, home, model, service_tier, speed, billing_mode, surface, nested, plan_type, meter_reset, repo, project, cwd) key, 0 survivor
  FROM codex_price_ledger_dims;
--> statement-breakpoint
CREATE INDEX temp.m0069_codex_key ON m0069_codex(key, old);
--> statement-breakpoint
UPDATE temp.m0069_codex AS m SET survivor=(SELECT MIN(o.old) FROM temp.m0069_codex o WHERE o.key=m.key);
--> statement-breakpoint
CREATE INDEX temp.m0069_codex_old ON m0069_codex(old);
--> statement-breakpoint
-- usage_ledger_days: the rows of every merged dimension and of its survivor, summed into the survivor's.
CREATE TEMP TABLE m0069_usage_ledger_days AS SELECT t.provider,t.day,m.survivor,SUM(t.calls),substr(MIN(t.first_ts||char(31)||t.first_key),1,instr(MIN(t.first_ts||char(31)||t.first_key),char(31))-1),substr(MIN(t.first_ts||char(31)||t.first_key),instr(MIN(t.first_ts||char(31)||t.first_key),char(31))+1),MAX(t.last_ts),SUM(t.t_uncached),SUM(t.t_cache_read),SUM(t.t_write_5m),SUM(t.t_write_1h),SUM(t.t_write_unknown),SUM(t.t_out),SUM(t.t_thinking),SUM(t.tokens_reported),SUM(t.duplicates),SUM(t.conflicts),SUM(t.conflicted_identities),SUM(t.approximate_time_events),SUM(t.invalid_token_events),SUM(t.unknown_speed_tokens),SUM(t.source_events),SUM(t.attribution_conflicts),SUM(t.std_priced_events),SUM(t.std_unpriced_events),SUM(t.std_priced_tokens),SUM(t.std_unpriced_tokens),SUM(t.std_sub_usd),SUM(t.std_sub_nano),SUM(t.std_sub_femto),SUM(t.std_priced_usd),SUM(t.std_priced_nano),SUM(t.std_priced_femto),SUM(t.act_priced_events),SUM(t.act_unpriced_events),SUM(t.act_priced_tokens),SUM(t.act_unpriced_tokens),SUM(t.act_sub_usd),SUM(t.act_sub_nano),SUM(t.act_sub_femto),SUM(t.act_priced_usd),SUM(t.act_priced_nano),SUM(t.act_priced_femto),SUM(t.glb_priced_events),SUM(t.glb_unpriced_events),SUM(t.glb_priced_tokens),SUM(t.glb_unpriced_tokens),SUM(t.glb_sub_usd),SUM(t.glb_sub_nano),SUM(t.glb_sub_femto),SUM(t.glb_priced_usd),SUM(t.glb_priced_nano),SUM(t.glb_priced_femto),SUM(t.timed_calls),SUM(t.timed_out),SUM(t.timed_ms),SUM(t.timed_long_calls),SUM(t.timed_long_out),SUM(t.timed_long_ms),SUM(t.active_5m_ms),SUM(t.active_10m_ms),SUM(t.active_15m_ms),SUM(t.active_30m_ms),SUM(t.active_45m_ms),SUM(t.active_60m_ms),MIN(t.gap_from_ts),SUM(t.src_shift_calls)
  FROM usage_ledger_days t JOIN temp.m0069_usage m ON m.provider=t.provider AND m.old=t.dim_id WHERE m.survivor IN (SELECT survivor FROM temp.m0069_usage WHERE old<>survivor)
  GROUP BY t.provider,t.day,m.survivor;
--> statement-breakpoint
DELETE FROM usage_ledger_days WHERE EXISTS (SELECT 1 FROM temp.m0069_usage m WHERE m.provider=usage_ledger_days.provider AND m.old=usage_ledger_days.dim_id AND m.survivor IN (SELECT survivor FROM temp.m0069_usage WHERE old<>survivor));
--> statement-breakpoint
INSERT INTO usage_ledger_days SELECT * FROM temp.m0069_usage_ledger_days;
--> statement-breakpoint
DROP TABLE temp.m0069_usage_ledger_days;
--> statement-breakpoint
-- usage_ledger_hours: the rows of every merged dimension and of its survivor, summed into the survivor's.
CREATE TEMP TABLE m0069_usage_ledger_hours AS SELECT t.provider,t.day,t.hour,m.survivor,SUM(t.calls),MIN(t.first_ts),MAX(t.last_ts),SUM(t.t_uncached),SUM(t.t_cache_read),SUM(t.t_write_5m),SUM(t.t_write_1h),SUM(t.t_write_unknown),SUM(t.t_out),SUM(t.t_thinking),SUM(t.timed_calls),SUM(t.timed_out),SUM(t.timed_ms),SUM(t.timed_long_calls),SUM(t.timed_long_out),SUM(t.timed_long_ms)
  FROM usage_ledger_hours t JOIN temp.m0069_usage m ON m.provider=t.provider AND m.old=t.dim_id WHERE m.survivor IN (SELECT survivor FROM temp.m0069_usage WHERE old<>survivor)
  GROUP BY t.provider,t.day,t.hour,m.survivor;
--> statement-breakpoint
DELETE FROM usage_ledger_hours WHERE EXISTS (SELECT 1 FROM temp.m0069_usage m WHERE m.provider=usage_ledger_hours.provider AND m.old=usage_ledger_hours.dim_id AND m.survivor IN (SELECT survivor FROM temp.m0069_usage WHERE old<>survivor));
--> statement-breakpoint
INSERT INTO usage_ledger_hours SELECT * FROM temp.m0069_usage_ledger_hours;
--> statement-breakpoint
DROP TABLE temp.m0069_usage_ledger_hours;
--> statement-breakpoint
-- usage_ledger_day_reasons: the rows of every merged dimension and of its survivor, summed into the survivor's.
CREATE TEMP TABLE m0069_usage_ledger_day_reasons AS SELECT t.provider,t.day,m.survivor,t.variant,t.reason,SUM(t.events),SUM(t.tokens)
  FROM usage_ledger_day_reasons t JOIN temp.m0069_usage m ON m.provider=t.provider AND m.old=t.dim_id WHERE m.survivor IN (SELECT survivor FROM temp.m0069_usage WHERE old<>survivor)
  GROUP BY t.provider,t.day,t.variant,t.reason,m.survivor;
--> statement-breakpoint
DELETE FROM usage_ledger_day_reasons WHERE EXISTS (SELECT 1 FROM temp.m0069_usage m WHERE m.provider=usage_ledger_day_reasons.provider AND m.old=usage_ledger_day_reasons.dim_id AND m.survivor IN (SELECT survivor FROM temp.m0069_usage WHERE old<>survivor));
--> statement-breakpoint
INSERT INTO usage_ledger_day_reasons SELECT * FROM temp.m0069_usage_ledger_day_reasons;
--> statement-breakpoint
DROP TABLE temp.m0069_usage_ledger_day_reasons;
--> statement-breakpoint
-- codex_price_ledger_aggregates: the rows of every merged dimension and of its survivor, summed into the survivor's.
CREATE TEMP TABLE m0069_codex_price_ledger_aggregates AS SELECT t.grain,t.day,t.hour,m.survivor,t.api_band,t.credit_band,t.api_reason,t.credit_reason,t.api_zero,t.credit_zero,t.copy_state,SUM(t.calls),MIN(t.first_ts),MAX(t.last_ts),SUM(t.reported),SUM(t.uncached),SUM(t.cached),SUM(t.writes),SUM(t.output),SUM(t.reasoning),SUM(t.window_input),SUM(t.window_cached),SUM(t.window_output),SUM(t.invalid_tokens),SUM(t.api_whole_hi),SUM(t.api_whole_lo),SUM(t.api_fraction_hi),SUM(t.api_fraction_lo),SUM(t.credit_whole_hi),SUM(t.credit_whole_lo),SUM(t.credit_fraction_hi),SUM(t.credit_fraction_lo),SUM(t.timed_calls),SUM(t.timed_out),SUM(t.timed_ms),SUM(t.timed_long_calls),SUM(t.timed_long_out),SUM(t.timed_long_ms),SUM(t.active_5m_ms),SUM(t.active_10m_ms),SUM(t.active_15m_ms),SUM(t.active_30m_ms),SUM(t.active_45m_ms),SUM(t.active_60m_ms),MIN(t.gap_from_ms)
  FROM codex_price_ledger_aggregates t JOIN temp.m0069_codex m ON m.old=t.dim_id WHERE m.survivor IN (SELECT survivor FROM temp.m0069_codex WHERE old<>survivor)
  GROUP BY t.grain,t.day,t.hour,t.api_band,t.credit_band,t.api_reason,t.credit_reason,t.api_zero,t.credit_zero,t.copy_state,m.survivor;
--> statement-breakpoint
DELETE FROM codex_price_ledger_aggregates WHERE EXISTS (SELECT 1 FROM temp.m0069_codex m WHERE m.old=codex_price_ledger_aggregates.dim_id AND m.survivor IN (SELECT survivor FROM temp.m0069_codex WHERE old<>survivor));
--> statement-breakpoint
INSERT INTO codex_price_ledger_aggregates SELECT * FROM temp.m0069_codex_price_ledger_aggregates;
--> statement-breakpoint
DROP TABLE temp.m0069_codex_price_ledger_aggregates;
--> statement-breakpoint
-- codex_price_ledger_file_models: the rows of every merged dimension and of its survivor, summed into the survivor's.
CREATE TEMP TABLE m0069_codex_price_ledger_file_models AS SELECT t.hour,m.survivor,t.day,t.copy_id,MIN(t.first_ms),MAX(t.last_ms)
  FROM codex_price_ledger_file_models t JOIN temp.m0069_codex m ON m.old=t.dim_id WHERE m.survivor IN (SELECT survivor FROM temp.m0069_codex WHERE old<>survivor)
  GROUP BY t.hour,t.day,t.copy_id,m.survivor;
--> statement-breakpoint
DELETE FROM codex_price_ledger_file_models WHERE EXISTS (SELECT 1 FROM temp.m0069_codex m WHERE m.old=codex_price_ledger_file_models.dim_id AND m.survivor IN (SELECT survivor FROM temp.m0069_codex WHERE old<>survivor));
--> statement-breakpoint
INSERT INTO codex_price_ledger_file_models SELECT * FROM temp.m0069_codex_price_ledger_file_models;
--> statement-breakpoint
DROP TABLE temp.m0069_codex_price_ledger_file_models;
--> statement-breakpoint
UPDATE usage_ledger_facts AS f SET dim_id=m.survivor FROM temp.m0069_usage m WHERE m.provider=f.provider AND m.old=f.dim_id AND m.old<>m.survivor;
--> statement-breakpoint
UPDATE codex_price_ledger_events AS e SET dim_id=m.survivor FROM temp.m0069_codex m WHERE m.old=e.dim_id AND m.old<>m.survivor;
--> statement-breakpoint
DELETE FROM usage_ledger_dims WHERE EXISTS (SELECT 1 FROM temp.m0069_usage m WHERE m.provider=usage_ledger_dims.provider AND m.old=usage_ledger_dims.id AND m.old<>m.survivor);
--> statement-breakpoint
DELETE FROM codex_price_ledger_dims WHERE EXISTS (SELECT 1 FROM temp.m0069_codex m WHERE m.old=codex_price_ledger_dims.id AND m.old<>m.survivor);
--> statement-breakpoint
UPDATE usage_ledger_dims AS d SET key=m.key, shift=m.shift, subject=NULL, project_id=NULL FROM temp.m0069_usage m WHERE m.provider=d.provider AND m.old=d.id;
--> statement-breakpoint
UPDATE codex_price_ledger_dims AS d SET key=m.key, subject=NULL, project_id=NULL FROM temp.m0069_codex m WHERE m.old=d.id;
--> statement-breakpoint
DROP TABLE temp.m0069_shift;
--> statement-breakpoint
DROP TABLE temp.m0069_usage;
--> statement-breakpoint
DROP TABLE temp.m0069_codex;
