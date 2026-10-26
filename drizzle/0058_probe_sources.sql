-- Plan U4.3: the readings' physical evidence is stored once per reading (probe_sources) and the
-- account of a reading is read through the account periods; the million derived keys of
-- current_probe_keys, its link triggers and the version 1 key triggers of 0021 go (the probe triggers
-- keep only the revision count). The current projection folds its cards again from the evidence (its
-- key format changes), which the writer starts on its next pass.
CREATE TABLE IF NOT EXISTS probe_sources (
  probe_id INTEGER NOT NULL, ord INTEGER NOT NULL, provider TEXT NOT NULL,
  machine TEXT, home TEXT, login TEXT, basis TEXT NOT NULL, tuples INTEGER NOT NULL,
  at INTEGER, accounting_at INTEGER, observation_at INTEGER, subject TEXT NOT NULL, bare INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(probe_id, ord)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS probe_sources_tuple ON probe_sources(provider, machine, home, login, at, probe_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS probe_sources_time ON probe_sources(provider, at, probe_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS probe_sources_accounting ON probe_sources(provider, machine, home, login, accounting_at, probe_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS probe_sources_observation ON probe_sources(provider, machine, home, login, observation_at, probe_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS probe_sources_bare ON probe_sources(provider, subject, at, probe_id) WHERE bare=1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS probe_source_tuples (
  provider TEXT NOT NULL, machine TEXT NOT NULL, home TEXT NOT NULL, login TEXT NOT NULL,
  PRIMARY KEY(provider, machine, home, login)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS probe_source_dirty (probe_id INTEGER PRIMARY KEY, changed INTEGER NOT NULL DEFAULT 0) STRICT;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS probe_sources_after_insert AFTER INSERT ON probe_windows BEGIN
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (NEW.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS probe_sources_after_update AFTER UPDATE ON probe_windows BEGIN
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (OLD.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1;
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (NEW.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS probe_sources_after_delete AFTER DELETE ON probe_windows BEGIN
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (OLD.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS probe_sources_link_after_insert AFTER INSERT ON probe_fact_legacy_map WHEN NEW.legacy_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) VALUES (NEW.legacy_id); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS probe_sources_link_after_update AFTER UPDATE ON probe_fact_legacy_map BEGIN
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) SELECT OLD.legacy_id WHERE OLD.legacy_id IS NOT NULL;
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) SELECT NEW.legacy_id WHERE NEW.legacy_id IS NOT NULL; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS probe_sources_link_after_delete AFTER DELETE ON probe_fact_legacy_map WHEN OLD.legacy_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) VALUES (OLD.legacy_id); END;
--> statement-breakpoint
INSERT OR IGNORE INTO probe_source_dirty(probe_id,changed) SELECT id,1 FROM probe_windows;
--> statement-breakpoint
DROP TRIGGER IF EXISTS current_v2_link_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS current_v2_link_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS current_v2_link_after_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS probe_current_after_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS probe_current_after_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS probe_current_after_delete;
--> statement-breakpoint
CREATE TRIGGER probe_current_after_insert AFTER INSERT ON probe_windows BEGIN
  UPDATE current_projection_state SET probe_revision=probe_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER probe_current_after_update AFTER UPDATE ON probe_windows BEGIN
  UPDATE current_projection_state SET probe_revision=probe_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER probe_current_after_delete AFTER DELETE ON probe_windows BEGIN
  UPDATE current_projection_state SET probe_revision=probe_revision+1 WHERE id=1; END;
--> statement-breakpoint
DROP TABLE IF EXISTS current_probe_keys;
--> statement-breakpoint
DELETE FROM meta WHERE key LIKE 'current_v2_%';
