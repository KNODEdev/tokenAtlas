CREATE TABLE probe_observations (id TEXT PRIMARY KEY NOT NULL, header TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE probe_counters (id TEXT PRIMARY KEY NOT NULL, observation_id TEXT NOT NULL REFERENCES probe_observations(id), discriminator TEXT NOT NULL, payload TEXT NOT NULL, payload_digest TEXT NOT NULL, UNIQUE(observation_id, discriminator));
--> statement-breakpoint
CREATE TABLE probe_fact_deliveries (id TEXT PRIMARY KEY NOT NULL, counter_id TEXT NOT NULL REFERENCES probe_counters(id), evidence TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE probe_fact_legacy_map (id TEXT PRIMARY KEY NOT NULL, namespace TEXT NOT NULL, legacy_id INTEGER, evidence_hash TEXT NOT NULL, counter_id TEXT NOT NULL REFERENCES probe_counters(id), reason TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX probe_fact_legacy_pointer ON probe_fact_legacy_map(namespace, legacy_id);
--> statement-breakpoint
CREATE TABLE probe_fact_conflicts (id TEXT PRIMARY KEY NOT NULL, family TEXT NOT NULL, reason TEXT NOT NULL, existing_payload TEXT NOT NULL, candidate_payload TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE probe_fact_backfill_checkpoints (id TEXT PRIMARY KEY NOT NULL, namespace TEXT NOT NULL, cursor INTEGER NOT NULL, evidence_hash TEXT NOT NULL);
--> statement-breakpoint
CREATE TRIGGER probe_observations_no_update BEFORE UPDATE ON probe_observations BEGIN SELECT RAISE(ABORT, 'Immutable probe observation'); END;
--> statement-breakpoint
CREATE TRIGGER probe_observations_no_delete BEFORE DELETE ON probe_observations BEGIN SELECT RAISE(ABORT, 'Immutable probe observation'); END;
--> statement-breakpoint
CREATE TRIGGER probe_counters_no_update BEFORE UPDATE ON probe_counters BEGIN SELECT RAISE(ABORT, 'Immutable probe counter'); END;
--> statement-breakpoint
CREATE TRIGGER probe_counters_no_delete BEFORE DELETE ON probe_counters BEGIN SELECT RAISE(ABORT, 'Immutable probe counter'); END;
--> statement-breakpoint
CREATE TRIGGER probe_observations_no_replace BEFORE INSERT ON probe_observations WHEN EXISTS(SELECT 1 FROM probe_observations WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'Immutable probe observation'); END;
--> statement-breakpoint
CREATE TRIGGER probe_counters_no_replace BEFORE INSERT ON probe_counters WHEN EXISTS(SELECT 1 FROM probe_counters WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'Immutable probe counter'); END;
