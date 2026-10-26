-- U3.0 note §5: a Codex call is valued at a reference day where it is read, from its stored token buckets and
-- that day's API bands (codex-ledger-reference.ts). The per-call reference values, their requests and their
-- work queues are not read any more.
DROP TABLE IF EXISTS codex_ledger_reference_values;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_reference_dirty;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_reference_work;
--> statement-breakpoint
DROP TABLE IF EXISTS codex_ledger_reference_requests;
--> statement-breakpoint
-- U3.0 note §4: the Codex price ledger keeps its facts and sums, and its producer's state and queue move to the
-- shared machinery. State: the `codex` row of usage_ledger_state (algorithm -> version, facts revision -> covered,
-- fill phase and cursor -> backfill bookmark, rules revision and published policy -> rules_digest, rules_json).
-- Queue: usage_ledger_dirty kinds copy, blocked, rules (scope and resume point), identity (conversation), day.
-- Bands the queued rules follow: usage_ledger_keys. No fact or sum is rewritten; nothing is re-imported.
ALTER TABLE usage_ledger_state ADD COLUMN rules_json TEXT;
--> statement-breakpoint
ALTER TABLE usage_ledger_dirty RENAME TO usage_ledger_dirty_before_0062;
--> statement-breakpoint
CREATE TABLE usage_ledger_dirty (
  provider TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('identity','day','copy','blocked','rules')), value TEXT NOT NULL,
  PRIMARY KEY(provider, kind, value)
) STRICT;
--> statement-breakpoint
INSERT INTO usage_ledger_dirty(provider,kind,value) SELECT provider,kind,value FROM usage_ledger_dirty_before_0062;
--> statement-breakpoint
DROP TABLE usage_ledger_dirty_before_0062;
--> statement-breakpoint
INSERT OR REPLACE INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest,revision,published_revision,rules_json)
  SELECT 'codex', CASE WHEN algorithm='codex-two-base-exact-v1' THEN 1 ELSE 0 END,
    CASE WHEN fill_phase IS NULL THEN 'reconcile' ELSE 'backfill' END,
    CASE WHEN status='ready' AND fill_phase IS NULL THEN 'ready' ELSE 'pending' END,
    CASE WHEN facts_revision<>'' AND facts_revision NOT GLOB '*[^0-9]*' THEN CAST(facts_revision AS INTEGER) ELSE 0 END,
    CASE WHEN fill_phase IS NULL THEN '' ELSE json_object('phase',fill_phase,'cursor',fill_cursor) END,
    rules_revision, last_event_id, CASE WHEN status='ready' THEN last_event_id ELSE 0 END, policy_json
  FROM codex_price_ledger_state WHERE singleton=1;
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT 'codex', CASE WHEN status='blocked' THEN 'blocked' ELSE 'copy' END, json_array(home,path) FROM codex_ledger_work WHERE kind='copy';
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT 'codex','rules',json_object('model',model,'basis',basis,'fromDay',from_day,'untilDay',until_day,
    'inputAbove',input_above,'inputUntil',input_until,'after',cursor) FROM codex_ledger_work WHERE kind='rules';
--> statement-breakpoint
INSERT OR IGNORE INTO usage_ledger_dirty(provider,kind,value)
  SELECT 'codex', CASE kind WHEN 'conversation' THEN 'identity' ELSE 'day' END, value FROM codex_ledger_dirty;
--> statement-breakpoint
DELETE FROM usage_ledger_keys WHERE provider='codex';
--> statement-breakpoint
INSERT INTO usage_ledger_keys(provider,key,rates) SELECT 'codex',band_key,band_json FROM codex_ledger_base_policy;
--> statement-breakpoint
DROP TABLE codex_ledger_work;
--> statement-breakpoint
DROP TABLE codex_ledger_dirty;
--> statement-breakpoint
DROP TABLE codex_ledger_base_policy;
--> statement-breakpoint
DROP TABLE codex_ledger_policy_target;
--> statement-breakpoint
DROP TABLE codex_price_ledger_state;
