-- Plan U4.4: no remembered reports. Views read stored rows on each request; the few on the exception
-- list are kept in server memory only. The report tables, the persisted responses and the report
-- request queue go; the explicit rebuild's status moves to meta first, so a job survives the upgrade.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS analysis_results (namespace TEXT NOT NULL, key TEXT NOT NULL, stamp TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (namespace, key));
--> statement-breakpoint
INSERT INTO meta(key,value)
  SELECT 'analysis_rebuild_status', data FROM analysis_results WHERE namespace='maintenance' AND key='rebuild'
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_results;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_requests;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_responses;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_body_refs;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_bodies;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_storage_state;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_storage_progress;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_response_schema;
--> statement-breakpoint
DROP TABLE IF EXISTS analysis_response_legacy_disabled;
--> statement-breakpoint
-- Revision clocks only the remembered reports read: rebuild selectors, their clock, the format seed, the
-- per-day buckets and the usage ledgers' per-folder and per-identity clocks. Whole-table clocks (`*`) stay.
DELETE FROM analysis_source_revisions WHERE source IN ('__analysis_rebuild__','__analysis_rebuild_clock__','__analysis_format_seed__')
  OR bucket <> '*' OR source GLOB 'usage-ledger:*:*';
