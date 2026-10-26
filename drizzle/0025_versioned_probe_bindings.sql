CREATE TABLE source_binding_versions (binding_id TEXT NOT NULL, binding_version INTEGER NOT NULL, source_id TEXT NOT NULL, config_version INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(binding_id,binding_version));
--> statement-breakpoint
CREATE TABLE source_binding_conflicts (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE probe_attribution_state (source_id TEXT PRIMARY KEY NOT NULL, requested_config INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, selected_generation TEXT, error TEXT);
--> statement-breakpoint
CREATE TABLE probe_attribution_dirty (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL, valid_from TEXT, valid_until TEXT, owners TEXT NOT NULL, counter_id TEXT);
--> statement-breakpoint
CREATE TABLE probe_attribution_generations (id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, config_version INTEGER NOT NULL, revision INTEGER NOT NULL, dependencies TEXT NOT NULL, status TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE probe_attributions (generation TEXT NOT NULL REFERENCES probe_attribution_generations(id), counter_id TEXT NOT NULL REFERENCES probe_counters(id), legacy_id INTEGER, owner TEXT, reason TEXT, binding_id TEXT, binding_version INTEGER, PRIMARY KEY(generation,counter_id));
--> statement-breakpoint
CREATE TABLE probe_attribution_checkpoints (generation TEXT PRIMARY KEY NOT NULL REFERENCES probe_attribution_generations(id), cursor TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX probe_observation_source ON probe_observations(json_extract(header,'$.origin.source_id'));
--> statement-breakpoint
CREATE INDEX probe_counter_observation ON probe_counters(observation_id);
--> statement-breakpoint
CREATE INDEX probe_attribution_source_dirty ON probe_attribution_dirty(source_id,revision);
--> statement-breakpoint
CREATE INDEX probe_binding_source ON source_binding_versions(source_id,config_version);
--> statement-breakpoint
CREATE TRIGGER source_binding_no_update BEFORE UPDATE ON source_binding_versions BEGIN SELECT RAISE(ABORT,'Immutable binding version'); END;
--> statement-breakpoint
CREATE TRIGGER source_binding_no_delete BEFORE DELETE ON source_binding_versions BEGIN SELECT RAISE(ABORT,'Immutable binding version'); END;
--> statement-breakpoint
CREATE TRIGGER source_binding_no_replace BEFORE INSERT ON source_binding_versions WHEN EXISTS(SELECT 1 FROM source_binding_versions WHERE binding_id=NEW.binding_id AND binding_version=NEW.binding_version) BEGIN SELECT RAISE(ABORT,'Immutable binding version'); END;
