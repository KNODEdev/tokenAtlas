-- U4.1: the ledgers carry the sums the old summary tables held. The shared usage ledger gains the place of a call
-- (home, raw project id and name, working directory) in its dimensions and calendar-hour sums (usage_ledger_hours); the
-- Codex ledger gains the working directory. Both ledgers are derived from the event tables: they are recreated empty here
-- and the background producers fill them again. No source re-import.
-- The summary tables and their coverage protocol, which those sums replace, are dropped.
DROP TABLE IF EXISTS usage_ledger_dirty;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_day_reasons;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_hours;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_days;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_facts;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_dims;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_keys;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_state;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_state (
  provider TEXT PRIMARY KEY, version INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('backfill','resolve','revalue','replay')),
  status TEXT NOT NULL CHECK(status IN ('pending','ready')),
  cursor INTEGER NOT NULL, bookmark TEXT NOT NULL, rules_digest TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_keys (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, key TEXT NOT NULL, rates TEXT NOT NULL,
  UNIQUE(provider, key)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_dims (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, key TEXT NOT NULL,
  source TEXT, identity TEXT, model TEXT, speed TEXT, subject TEXT, vendor TEXT,
  home TEXT, project_id TEXT, project TEXT, cwd TEXT,
  UNIQUE(provider, key)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_facts (
  provider TEXT NOT NULL, row_id INTEGER NOT NULL,
  identity TEXT NOT NULL, source_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  ts TEXT NOT NULL, day TEXT NOT NULL, accounting INTEGER NOT NULL,
  model TEXT, speed TEXT NOT NULL, source TEXT, account_key TEXT, identity_conflict INTEGER NOT NULL,
  eligible INTEGER NOT NULL, vendor TEXT NOT NULL, home TEXT NOT NULL, source_id TEXT NOT NULL,
  q_uncached INTEGER NOT NULL, q_cache_read INTEGER NOT NULL, q_write_5m INTEGER NOT NULL,
  q_write_1h INTEGER NOT NULL, q_write_unknown INTEGER NOT NULL, q_out INTEGER NOT NULL, q_thinking INTEGER NOT NULL,
  usage_valid INTEGER NOT NULL, precise_time INTEGER NOT NULL,
  product TEXT, subject TEXT, session TEXT, repo TEXT, repo_group TEXT, project TEXT,
  reported_raw REAL, reported_unit TEXT, reported_provenance TEXT,
  copy_state TEXT NOT NULL CHECK(copy_state IN ('pending','canonical','duplicate','conflict')),
  dim_id INTEGER, copies INTEGER, flagged INTEGER, conflict_first INTEGER,
  m_product TEXT, m_reported_raw REAL, m_reported_conflict INTEGER, cwd TEXT, project_name TEXT,
  std_key INTEGER, std_reason TEXT, std_usd INTEGER, std_nano INTEGER, std_femto INTEGER, act_key INTEGER, act_reason TEXT, act_usd INTEGER, act_nano INTEGER, act_femto INTEGER, glb_key INTEGER, glb_reason TEXT, glb_usd INTEGER, glb_nano INTEGER, glb_femto INTEGER,
  PRIMARY KEY(provider, row_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_claude ON usage_ledger_facts(identity) WHERE provider='claude';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_claude ON usage_ledger_facts(day) WHERE provider='claude';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_gemini ON usage_ledger_facts(identity) WHERE provider='gemini';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_gemini ON usage_ledger_facts(day) WHERE provider='gemini';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_grok ON usage_ledger_facts(identity) WHERE provider='grok';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_grok ON usage_ledger_facts(day) WHERE provider='grok';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_glm ON usage_ledger_facts(identity) WHERE provider='glm';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_glm ON usage_ledger_facts(day) WHERE provider='glm';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_days (
  provider TEXT NOT NULL, day TEXT NOT NULL, dim_id INTEGER NOT NULL,
  calls INTEGER NOT NULL, first_ts TEXT NOT NULL, first_key TEXT NOT NULL, last_ts TEXT NOT NULL,
  t_uncached INTEGER NOT NULL, t_cache_read INTEGER NOT NULL, t_write_5m INTEGER NOT NULL,
  t_write_1h INTEGER NOT NULL, t_write_unknown INTEGER NOT NULL, t_out INTEGER NOT NULL, t_thinking INTEGER NOT NULL,
  tokens_reported INTEGER NOT NULL,
  duplicates INTEGER NOT NULL, conflicts INTEGER NOT NULL, conflicted_identities INTEGER NOT NULL,
  approximate_time_events INTEGER NOT NULL, invalid_token_events INTEGER NOT NULL,
  unknown_speed_tokens INTEGER NOT NULL, source_events INTEGER NOT NULL, attribution_conflicts INTEGER NOT NULL,
  std_priced_events INTEGER NOT NULL DEFAULT 0,
  std_unpriced_events INTEGER NOT NULL DEFAULT 0, std_priced_tokens INTEGER NOT NULL DEFAULT 0,
  std_unpriced_tokens INTEGER NOT NULL DEFAULT 0, std_sub_usd INTEGER NOT NULL DEFAULT 0,
  std_sub_nano INTEGER NOT NULL DEFAULT 0, std_sub_femto INTEGER NOT NULL DEFAULT 0,
  std_priced_usd INTEGER NOT NULL DEFAULT 0, std_priced_nano INTEGER NOT NULL DEFAULT 0,
  std_priced_femto INTEGER NOT NULL DEFAULT 0, act_priced_events INTEGER NOT NULL DEFAULT 0,
  act_unpriced_events INTEGER NOT NULL DEFAULT 0, act_priced_tokens INTEGER NOT NULL DEFAULT 0,
  act_unpriced_tokens INTEGER NOT NULL DEFAULT 0, act_sub_usd INTEGER NOT NULL DEFAULT 0,
  act_sub_nano INTEGER NOT NULL DEFAULT 0, act_sub_femto INTEGER NOT NULL DEFAULT 0,
  act_priced_usd INTEGER NOT NULL DEFAULT 0, act_priced_nano INTEGER NOT NULL DEFAULT 0,
  act_priced_femto INTEGER NOT NULL DEFAULT 0, glb_priced_events INTEGER NOT NULL DEFAULT 0,
  glb_unpriced_events INTEGER NOT NULL DEFAULT 0, glb_priced_tokens INTEGER NOT NULL DEFAULT 0,
  glb_unpriced_tokens INTEGER NOT NULL DEFAULT 0, glb_sub_usd INTEGER NOT NULL DEFAULT 0,
  glb_sub_nano INTEGER NOT NULL DEFAULT 0, glb_sub_femto INTEGER NOT NULL DEFAULT 0,
  glb_priced_usd INTEGER NOT NULL DEFAULT 0, glb_priced_nano INTEGER NOT NULL DEFAULT 0,
  glb_priced_femto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider, day, dim_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_hours (
  provider TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, dim_id INTEGER NOT NULL,
  calls INTEGER NOT NULL, first_ts TEXT NOT NULL, last_ts TEXT NOT NULL,
  t_uncached INTEGER NOT NULL, t_cache_read INTEGER NOT NULL, t_write_5m INTEGER NOT NULL,
  t_write_1h INTEGER NOT NULL, t_write_unknown INTEGER NOT NULL, t_out INTEGER NOT NULL, t_thinking INTEGER NOT NULL,
  PRIMARY KEY(provider, day, hour, dim_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_day_reasons (
  provider TEXT NOT NULL, day TEXT NOT NULL, dim_id INTEGER NOT NULL, variant TEXT NOT NULL, reason TEXT NOT NULL,
  events INTEGER NOT NULL, tokens INTEGER NOT NULL,
  PRIMARY KEY(provider, day, dim_id, variant, reason)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_dirty (
  provider TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('identity','day')), value TEXT NOT NULL,
  PRIMARY KEY(provider, kind, value)
) STRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_ledger_aggregates;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_ledger_events;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_ledger_dims;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_ledger_copies;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_price_ledger_state;
--> statement-breakpoint
CREATE TABLE codex_price_ledger_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  status TEXT NOT NULL,algorithm TEXT NOT NULL,facts_revision TEXT NOT NULL,rules_revision TEXT NOT NULL,
  last_event_id INTEGER NOT NULL DEFAULT 0,policy_json TEXT,fill_phase TEXT,fill_cursor TEXT) STRICT;
--> statement-breakpoint
CREATE TABLE codex_price_ledger_copies(id INTEGER PRIMARY KEY,identity TEXT NOT NULL UNIQUE,
  locator TEXT NOT NULL UNIQUE,home TEXT,path TEXT,source TEXT,relative_path TEXT,conversation TEXT) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_copies_conversation ON codex_price_ledger_copies(conversation);
--> statement-breakpoint
CREATE INDEX codex_price_ledger_copies_home_path ON codex_price_ledger_copies(home,path);
--> statement-breakpoint
CREATE TABLE codex_price_ledger_dims(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,
  source TEXT,home TEXT,model TEXT,service_tier TEXT,speed TEXT,subject TEXT,billing_mode TEXT,
  surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER,repo TEXT,project_id ANY,project TEXT,cwd TEXT) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_dims_model ON codex_price_ledger_dims(model,id);
--> statement-breakpoint
CREATE TABLE codex_price_ledger_events(id INTEGER PRIMARY KEY,copy_id INTEGER NOT NULL,source_offset INTEGER NOT NULL,
  dim_id INTEGER NOT NULL,ts TEXT NOT NULL,day TEXT NOT NULL,instant_ms INTEGER,admitted INTEGER NOT NULL,
  in_tok ANY,cached_in ANY,cache_write ANY,out_tok ANY,reasoning_out ANY,
  usage_status TEXT,cache_write_status TEXT,reported INTEGER NOT NULL,uncached INTEGER NOT NULL,
  cached INTEGER NOT NULL,writes INTEGER NOT NULL,output INTEGER NOT NULL,reasoning INTEGER NOT NULL,
  window_input INTEGER NOT NULL,window_cached INTEGER NOT NULL,window_output INTEGER NOT NULL,
  invalid_tokens INTEGER NOT NULL,common_reason TEXT,
  api_band INTEGER NOT NULL DEFAULT 0,api_reason TEXT,api_whole INTEGER,api_fraction_hi INTEGER,api_fraction_lo INTEGER,
  credit_band INTEGER NOT NULL DEFAULT 0,credit_reason TEXT,credit_whole INTEGER,credit_fraction_hi INTEGER,credit_fraction_lo INTEGER,
  identity TEXT,copy_state TEXT NOT NULL DEFAULT 'pending' CHECK(copy_state IN ('pending','canonical','duplicate','conflict')),
  UNIQUE(copy_id,source_offset)) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_events_identity ON codex_price_ledger_events(identity) WHERE identity IS NOT NULL;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_events_time ON codex_price_ledger_events(instant_ms,copy_id);
--> statement-breakpoint
CREATE INDEX codex_price_ledger_events_day ON codex_price_ledger_events(day,dim_id);
--> statement-breakpoint
CREATE INDEX codex_price_ledger_events_dim ON codex_price_ledger_events(dim_id,day,id);
--> statement-breakpoint
CREATE TABLE codex_price_ledger_aggregates(grain TEXT NOT NULL,day TEXT NOT NULL,hour INTEGER NOT NULL,dim_id INTEGER NOT NULL,
  api_band INTEGER NOT NULL,credit_band INTEGER NOT NULL,api_reason TEXT NOT NULL,credit_reason TEXT NOT NULL,
  api_zero INTEGER NOT NULL,credit_zero INTEGER NOT NULL,copy_state TEXT NOT NULL,calls INTEGER NOT NULL,first_ts TEXT NOT NULL,last_ts TEXT NOT NULL,
  reported INTEGER NOT NULL,uncached INTEGER NOT NULL,cached INTEGER NOT NULL,writes INTEGER NOT NULL,
  output INTEGER NOT NULL,reasoning INTEGER NOT NULL,window_input INTEGER NOT NULL,window_cached INTEGER NOT NULL,
  window_output INTEGER NOT NULL,invalid_tokens INTEGER NOT NULL,
  api_whole_hi INTEGER,api_whole_lo INTEGER,api_fraction_hi INTEGER,api_fraction_lo INTEGER,
  credit_whole_hi INTEGER,credit_whole_lo INTEGER,credit_fraction_hi INTEGER,credit_fraction_lo INTEGER,
  PRIMARY KEY(grain,day,hour,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero,copy_state)) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_aggregates_day ON codex_price_ledger_aggregates(grain,day,dim_id);
--> statement-breakpoint
DELETE FROM codex_ledger_work;
--> statement-breakpoint
DELETE FROM codex_ledger_dirty;
--> statement-breakpoint
DELETE FROM codex_ledger_base_policy;
--> statement-breakpoint
DELETE FROM codex_ledger_policy_target;
--> statement-breakpoint
DELETE FROM codex_ledger_reference_requests;
--> statement-breakpoint
DELETE FROM codex_ledger_reference_work;
--> statement-breakpoint
DELETE FROM codex_ledger_reference_dirty;
--> statement-breakpoint
DELETE FROM codex_ledger_reference_values;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_daily_rollups;
--> statement-breakpoint
DROP TABLE IF EXISTS project_daily_rollups;
--> statement-breakpoint
DROP TABLE IF EXISTS hourly_activity_rollups;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_cycle_rollups;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_usage_daily;
--> statement-breakpoint
DROP TABLE IF EXISTS rollup_coverage;
