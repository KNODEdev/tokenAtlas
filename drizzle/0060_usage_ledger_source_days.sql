-- U4.5: the fact tables record which source days each write changed (fact_day_revisions, kept by triggers the
-- code installs), and the shared usage ledger follows those days instead of the fact change journal. A fact keeps its
-- source row's day and content hash, so a changed day is reconciled row by row, deletions included;
-- usage_ledger_source_days holds each reconciled day's revision. The ledger is derived from the event tables: it is
-- recreated empty here and the background producer fills it again. No source re-import.
-- The fact change journal (analysis_changes with its triggers, origin context and retention watermark) has no
-- consumer left and is dropped.
DROP TRIGGER IF EXISTS analysis_change_events_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_events_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_events_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_ratelimit_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_ratelimit_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_ratelimit_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_claude_events_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_claude_events_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_claude_events_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_claude_limit_hits_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_claude_limit_hits_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_claude_limit_hits_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_oc_events_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_oc_events_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_oc_events_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_grok_events_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_grok_events_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_grok_events_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_gemini_events_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_gemini_events_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_gemini_events_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_windows_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_windows_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_windows_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_facts_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_facts_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_change_probe_facts_delete;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_changes;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_change_context;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_change_retention;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fact_day_revisions (
  source TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(source, day)
) STRICT;
--> statement-breakpoint
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
DROP TABLE IF EXISTS usage_ledger_source_days;
--> statement-breakpoint
DROP TABLE IF EXISTS usage_ledger_state;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_state (
  provider TEXT PRIMARY KEY, version INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('backfill','resolve','revalue','reconcile')),
  status TEXT NOT NULL CHECK(status IN ('pending','ready')),
  covered INTEGER NOT NULL, bookmark TEXT NOT NULL, rules_digest TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, published_revision INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_ledger_source_days (
  provider TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(provider, day)
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
  src_day TEXT NOT NULL, src_hash TEXT NOT NULL,
  std_key INTEGER, std_reason TEXT, std_usd INTEGER, std_nano INTEGER, std_femto INTEGER, act_key INTEGER, act_reason TEXT, act_usd INTEGER, act_nano INTEGER, act_femto INTEGER, glb_key INTEGER, glb_reason TEXT, glb_usd INTEGER, glb_nano INTEGER, glb_femto INTEGER,
  PRIMARY KEY(provider, row_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_claude ON usage_ledger_facts(identity) WHERE provider='claude';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_claude ON usage_ledger_facts(day) WHERE provider='claude';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_src_day_claude ON usage_ledger_facts(src_day) WHERE provider='claude';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_gemini ON usage_ledger_facts(identity) WHERE provider='gemini';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_gemini ON usage_ledger_facts(day) WHERE provider='gemini';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_src_day_gemini ON usage_ledger_facts(src_day) WHERE provider='gemini';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_grok ON usage_ledger_facts(identity) WHERE provider='grok';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_grok ON usage_ledger_facts(day) WHERE provider='grok';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_src_day_grok ON usage_ledger_facts(src_day) WHERE provider='grok';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_glm ON usage_ledger_facts(identity) WHERE provider='glm';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_glm ON usage_ledger_facts(day) WHERE provider='glm';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_ledger_facts_src_day_glm ON usage_ledger_facts(src_day) WHERE provider='glm';
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
