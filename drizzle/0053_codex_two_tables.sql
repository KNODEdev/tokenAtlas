-- U4.2: a Codex call is written to `events` and, valued, to `codex_price_ledger_events` (two tables instead of five).
-- Recognized counters (`codex_usage_facts`) and the per-call record proofs (`codex_ledger_observations`, copy
-- identities, witnesses, retractions) are gone; the archive keeps every original line. Provider thread and session
-- move to the file (`codex_file_evidence`); `codex_event_evidence` is retired by the schema step that owns `events`
-- (retireCodexEventEvidence), which first moves its identifiers. The ledger is derived from `events`: it is cleared
-- here and the background producer fills it again. No source re-import.
ALTER TABLE codex_file_evidence ADD COLUMN provider_thread_id TEXT;
--> statement-breakpoint
ALTER TABLE codex_file_evidence ADD COLUMN provider_session_id TEXT;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_usage_facts;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_proofs;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_observations;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_copies;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_retractions;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_work;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_base_policy;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_policy_target;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_dirty;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_reference_requests;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_reference_work;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_reference_dirty;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_reference_values;
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
  surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER,repo TEXT,project_id ANY,project TEXT) STRICT;
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
CREATE TABLE codex_ledger_work (
  id INTEGER PRIMARY KEY,work_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('copy','rules')),
  home TEXT,path TEXT,sequence INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','blocked')),error TEXT,
  model TEXT,basis TEXT,from_day TEXT,until_day TEXT,input_above INTEGER,input_until INTEGER,
  processed INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
CREATE INDEX codex_ledger_work_pending ON codex_ledger_work(status,id);
--> statement-breakpoint
CREATE INDEX codex_ledger_work_dispatch ON codex_ledger_work(kind,id) WHERE status='queued';
--> statement-breakpoint
CREATE TABLE codex_ledger_base_policy (
  band_key TEXT PRIMARY KEY,dependency_revision TEXT NOT NULL,band_json TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_ledger_policy_target (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),rules_revision TEXT NOT NULL,base_revision TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_ledger_dirty (
  kind TEXT NOT NULL CHECK(kind IN ('conversation','day')),value TEXT NOT NULL,PRIMARY KEY(kind,value)
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_ledger_reference_requests (
  reference_day TEXT PRIMARY KEY,dependency_revision TEXT NOT NULL,bands_json TEXT NOT NULL,rules_revision TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_ledger_reference_work (
  reference_day TEXT NOT NULL,work_key TEXT NOT NULL,model TEXT,input_above INTEGER,input_until INTEGER,
  cursor INTEGER NOT NULL DEFAULT -1,processed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(reference_day,work_key)
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_ledger_reference_dirty (
  reference_day TEXT NOT NULL,event_id INTEGER NOT NULL,PRIMARY KEY(reference_day,event_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_ledger_reference_values (
  reference_day TEXT NOT NULL,event_id INTEGER NOT NULL,
  dependency_revision TEXT,reason TEXT,rule_id TEXT,long_context INTEGER NOT NULL DEFAULT 0,band_id INTEGER,
  denominator INTEGER,whole INTEGER,fraction_hi INTEGER,fraction_lo INTEGER,
  PRIMARY KEY(reference_day,event_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX codex_ledger_reference_values_event ON codex_ledger_reference_values(event_id);
