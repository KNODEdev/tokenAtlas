CREATE TABLE source_machines (id TEXT PRIMARY KEY, payload TEXT NOT NULL, provenance TEXT NOT NULL, evidence TEXT NOT NULL, declaration_version INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE source_runtimes (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES source_machines(id), kind TEXT NOT NULL, payload TEXT NOT NULL, provenance TEXT NOT NULL, evidence TEXT NOT NULL, declaration_version INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE logical_sources (id TEXT PRIMARY KEY, runtime_id TEXT REFERENCES source_runtimes(id), vendor TEXT NOT NULL, stream_kind TEXT NOT NULL, payload TEXT NOT NULL, provenance TEXT NOT NULL, evidence TEXT NOT NULL, declaration_version INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE source_replicas (id TEXT PRIMARY KEY, source_id TEXT REFERENCES logical_sources(id), role TEXT NOT NULL, locator TEXT NOT NULL, payload TEXT NOT NULL, provenance TEXT NOT NULL, evidence TEXT NOT NULL, declaration_version INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE source_aliases (id TEXT PRIMARY KEY, declaration_key TEXT NOT NULL UNIQUE, source_id TEXT REFERENCES logical_sources(id), replica_id TEXT REFERENCES source_replicas(id), machine_scope TEXT NOT NULL, runtime_scope TEXT NOT NULL, resolution_digest TEXT NOT NULL, original TEXT NOT NULL, resolved TEXT NOT NULL, platform TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE source_mapping_versions (config_version INTEGER PRIMARY KEY, prior_version INTEGER, declaration_digest TEXT NOT NULL, payload TEXT NOT NULL, recorded_at TEXT NOT NULL, authored_by TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE source_mapping_conflicts (id TEXT PRIMARY KEY, conflict_key TEXT NOT NULL UNIQUE, affected_id TEXT NOT NULL, existing_payload TEXT NOT NULL, candidate_payload TEXT NOT NULL, reason TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE source_backfill_checkpoints (group_key TEXT PRIMARY KEY, config_version INTEGER NOT NULL REFERENCES source_mapping_versions(config_version), declaration_digest TEXT NOT NULL, resolution_digest TEXT NOT NULL);
