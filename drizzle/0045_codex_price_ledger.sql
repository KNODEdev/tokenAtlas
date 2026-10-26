-- Source proofs, durable copy identity, incremental two-base ledger and reference views.
CREATE TABLE IF NOT EXISTS codex_file_evidence (
  home TEXT NOT NULL, path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
  source_byte_length INTEGER NOT NULL CHECK(source_byte_length>=0),
  parser_version INTEGER NOT NULL, evidence_version INTEGER NOT NULL CHECK(evidence_version=1),
  session_headers_json TEXT NOT NULL, PRIMARY KEY(home,path)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_event_evidence (
  home TEXT NOT NULL, path TEXT NOT NULL, source_offset INTEGER NOT NULL CHECK(source_offset>=0),
  accounting_record_start INTEGER NOT NULL CHECK(accounting_record_start>=0),
  accounting_record_end INTEGER NOT NULL CHECK(accounting_record_end>accounting_record_start),
  accounting_record_sha256 TEXT NOT NULL,
  accepted_record_start INTEGER NOT NULL CHECK(accepted_record_start>=0),
  accepted_record_end INTEGER NOT NULL CHECK(accepted_record_end>accepted_record_start),
  accepted_record_sha256 TEXT NOT NULL,
  provider_thread_id TEXT, provider_session_id TEXT, provider_response_id TEXT, provider_turn_id TEXT,
  usage_conflict INTEGER NOT NULL CHECK(usage_conflict IN (0,1)), duplicate_records_json TEXT NOT NULL,
  PRIMARY KEY(home,path,source_offset)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_event_provider_evidence ON codex_event_evidence
  (home,path,COALESCE(provider_thread_id,provider_session_id),provider_response_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_copies (
  id TEXT PRIMARY KEY, archive_id TEXT NOT NULL, source_id TEXT NOT NULL, relative_path TEXT NOT NULL,
  provider_session_id TEXT, revision INTEGER NOT NULL CHECK(revision>0), snapshot_digest TEXT NOT NULL,
  accepted_file_digest TEXT NOT NULL, accepted_file_byte_length INTEGER NOT NULL CHECK(accepted_file_byte_length>=0),
  UNIQUE(archive_id,source_id,relative_path)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_observations (
  id TEXT PRIMARY KEY, copy_id TEXT NOT NULL REFERENCES codex_ledger_copies(id), source_offset INTEGER NOT NULL CHECK(source_offset>=0),
  record_start INTEGER NOT NULL CHECK(record_start>=0), record_end INTEGER NOT NULL CHECK(record_end>record_start),
  provider_thread_id TEXT, provider_session_id TEXT, provider_response_id TEXT, accounting_record_digest TEXT NOT NULL,
  api_input_revision TEXT NOT NULL, credit_input_revision TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_ledger_copy_observations ON codex_ledger_observations(copy_id,source_offset);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_proofs (
  copy_id TEXT NOT NULL REFERENCES codex_ledger_copies(id), revision INTEGER NOT NULL,
  observation_id TEXT NOT NULL REFERENCES codex_ledger_observations(id), evidence_sha256 TEXT NOT NULL,
  proof_kind TEXT NOT NULL, previous_file_digest TEXT NOT NULL, incoming_file_digest TEXT NOT NULL,
  PRIMARY KEY(copy_id,revision,observation_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE codex_price_ledger_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      status TEXT NOT NULL,algorithm TEXT NOT NULL,facts_revision TEXT NOT NULL,rules_revision TEXT NOT NULL,
      last_event_id INTEGER NOT NULL DEFAULT 0,policy_json TEXT) STRICT;
--> statement-breakpoint
CREATE TABLE codex_price_ledger_copies(id INTEGER PRIMARY KEY,identity TEXT NOT NULL UNIQUE,
      locator TEXT NOT NULL UNIQUE,home TEXT,path TEXT,source TEXT) STRICT;
--> statement-breakpoint
CREATE TABLE codex_price_ledger_dims(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,
      copy_id INTEGER NOT NULL,model TEXT,service_tier TEXT,speed TEXT,subject TEXT,billing_mode TEXT,
      surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER,repo TEXT,project_id ANY,project TEXT) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_dims_model ON codex_price_ledger_dims(model,id);
--> statement-breakpoint
CREATE TABLE codex_price_ledger_bands(id INTEGER PRIMARY KEY,rule_id TEXT NOT NULL,band TEXT NOT NULL,
      basis TEXT NOT NULL,denominator INTEGER NOT NULL,evidence TEXT NOT NULL,dependency_revision TEXT NOT NULL,band_json TEXT NOT NULL,
      UNIQUE(rule_id,band,dependency_revision)) STRICT;
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
      observation_id TEXT UNIQUE,api_input_revision TEXT NOT NULL DEFAULT '',credit_input_revision TEXT NOT NULL DEFAULT '',
      metadata_revision TEXT NOT NULL DEFAULT '',
      UNIQUE(copy_id,source_offset)) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_events_time ON codex_price_ledger_events(instant_ms,copy_id);
--> statement-breakpoint
CREATE INDEX codex_price_ledger_events_day ON codex_price_ledger_events(day,dim_id);
--> statement-breakpoint
CREATE INDEX codex_price_ledger_events_dim ON codex_price_ledger_events(dim_id,day,id);
--> statement-breakpoint
CREATE TABLE codex_price_ledger_aggregates(grain TEXT NOT NULL,day TEXT NOT NULL,hour INTEGER NOT NULL,dim_id INTEGER NOT NULL,
      api_band INTEGER NOT NULL,credit_band INTEGER NOT NULL,api_reason TEXT NOT NULL,credit_reason TEXT NOT NULL,
      api_zero INTEGER NOT NULL,credit_zero INTEGER NOT NULL,calls INTEGER NOT NULL,first_ts TEXT NOT NULL,last_ts TEXT NOT NULL,
      reported INTEGER NOT NULL,uncached INTEGER NOT NULL,cached INTEGER NOT NULL,writes INTEGER NOT NULL,
      output INTEGER NOT NULL,reasoning INTEGER NOT NULL,window_input INTEGER NOT NULL,window_cached INTEGER NOT NULL,
      window_output INTEGER NOT NULL,invalid_tokens INTEGER NOT NULL,
      api_whole_hi INTEGER,api_whole_lo INTEGER,api_fraction_hi INTEGER,api_fraction_lo INTEGER,
      credit_whole_hi INTEGER,credit_whole_lo INTEGER,credit_fraction_hi INTEGER,credit_fraction_lo INTEGER,
      PRIMARY KEY(grain,day,hour,dim_id,api_band,credit_band,api_reason,credit_reason,api_zero,credit_zero)) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_aggregates_day ON codex_price_ledger_aggregates(grain,day,dim_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_work (
  id INTEGER PRIMARY KEY, work_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('copy','rules')),
  home TEXT,path TEXT,sequence INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'queued',target_digest TEXT,target_length INTEGER,copy_identity TEXT,
  pending_digest TEXT,pending_length INTEGER,
  initial_copy INTEGER NOT NULL DEFAULT 0,error TEXT,model TEXT,basis TEXT,from_day TEXT,until_day TEXT,
  input_above INTEGER,input_until INTEGER,
  processed INTEGER NOT NULL DEFAULT 0
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_base_policy (
  band_key TEXT PRIMARY KEY,dependency_revision TEXT NOT NULL,band_json TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_policy_target (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),rules_revision TEXT NOT NULL,base_revision TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_retractions (
  observation_id TEXT PRIMARY KEY,copy_identity TEXT NOT NULL,expected_copy_revision INTEGER NOT NULL,
  accepted_file_digest TEXT NOT NULL,record_digest TEXT NOT NULL,record_start INTEGER NOT NULL,record_end INTEGER NOT NULL,
  correction_digest TEXT NOT NULL,declaration_json TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_ledger_work_pending ON codex_ledger_work(status,id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_ledger_work_dispatch ON codex_ledger_work(kind,id) WHERE status IN ('queued','finalize');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_price_ledger_observation ON codex_price_ledger_events(observation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_price_ledger_pending_locators ON codex_price_ledger_events(source_offset) WHERE source_offset<0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_ledger_provider_observation ON codex_ledger_observations(copy_id,COALESCE(provider_thread_id,provider_session_id),provider_response_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_reference_requests (
  reference_day TEXT PRIMARY KEY,dependency_revision TEXT NOT NULL,bands_json TEXT NOT NULL,rules_revision TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_reference_work (
  reference_day TEXT NOT NULL,work_key TEXT NOT NULL,model TEXT,input_above INTEGER,input_until INTEGER,
  cursor INTEGER NOT NULL DEFAULT -1,processed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(reference_day,work_key)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_reference_dirty (
  reference_day TEXT NOT NULL,event_id INTEGER NOT NULL,PRIMARY KEY(reference_day,event_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS codex_ledger_reference_values (
  reference_day TEXT NOT NULL,event_id INTEGER NOT NULL,api_input_revision TEXT NOT NULL,
  dependency_revision TEXT,reason TEXT,rule_id TEXT,long_context INTEGER NOT NULL DEFAULT 0,band_id INTEGER,
  denominator INTEGER,whole INTEGER,fraction_hi INTEGER,fraction_lo INTEGER,
  PRIMARY KEY(reference_day,event_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_ledger_reference_values_event ON codex_ledger_reference_values(event_id);
