-- U3.2: Codex sums have no physical-copy dimension. A dimension names the source and home (the account
-- follows the source's dated periods) and the call metadata; duplicate copies were resolved per call in
-- 0048. Existing facts keep their valuations; only their dimension id moves, and the background producer
-- rebuilds every day's sums. No source re-import.
DROP INDEX IF EXISTS codex_price_ledger_dims_model;
--> statement-breakpoint
ALTER TABLE codex_price_ledger_dims RENAME TO codex_price_ledger_dims_by_copy;
--> statement-breakpoint
CREATE TABLE codex_price_ledger_dims(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE,
      source TEXT,home TEXT,model TEXT,service_tier TEXT,speed TEXT,subject TEXT,billing_mode TEXT,
      surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER,repo TEXT,project_id ANY,project TEXT) STRICT;
--> statement-breakpoint
CREATE INDEX codex_price_ledger_dims_model ON codex_price_ledger_dims(model,id);
--> statement-breakpoint
CREATE TABLE codex_ledger_dim_map(old INTEGER PRIMARY KEY,key TEXT NOT NULL) STRICT;
--> statement-breakpoint
INSERT INTO codex_ledger_dim_map(old,key) SELECT d.id,json_array(c.source,c.home,d.model,d.service_tier,d.speed,d.subject,d.billing_mode,
    d.surface,d.nested,d.plan_type,d.meter_reset,d.repo,d.project_id,d.project)
  FROM codex_price_ledger_dims_by_copy d JOIN codex_price_ledger_copies c ON c.id=d.copy_id;
--> statement-breakpoint
INSERT INTO codex_price_ledger_dims(key,source,home,model,service_tier,speed,subject,billing_mode,surface,nested,plan_type,meter_reset,repo,project_id,project)
  SELECT m.key,c.source,c.home,d.model,d.service_tier,d.speed,d.subject,d.billing_mode,d.surface,d.nested,d.plan_type,d.meter_reset,d.repo,d.project_id,d.project
  FROM codex_ledger_dim_map m JOIN codex_price_ledger_dims_by_copy d ON d.id=m.old JOIN codex_price_ledger_copies c ON c.id=d.copy_id
  WHERE true ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
UPDATE codex_price_ledger_events SET dim_id=(SELECT n.id FROM codex_ledger_dim_map m JOIN codex_price_ledger_dims n ON n.key=m.key
  WHERE m.old=codex_price_ledger_events.dim_id);
--> statement-breakpoint
DROP TABLE codex_ledger_dim_map;
--> statement-breakpoint
DROP TABLE codex_price_ledger_dims_by_copy;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS codex_price_ledger_copies_home_path ON codex_price_ledger_copies(home,path);
--> statement-breakpoint
DELETE FROM codex_price_ledger_aggregates;
--> statement-breakpoint
INSERT OR IGNORE INTO codex_ledger_dirty(kind,value) SELECT DISTINCT 'day',day FROM codex_price_ledger_events;
--> statement-breakpoint
UPDATE codex_price_ledger_state SET status='building';
