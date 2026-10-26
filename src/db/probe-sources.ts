import type { Database } from "./sqlite";
import { asSchemaWriter } from "./schema-writer";

/**
 * Where each limit reading was taken (plan U4.3): its verified physical evidence, stored once per
 * reading. The evidence does not depend on the source declarations, so a declaration or period
 * change rewrites nothing here; the archive source follows from the evidence and the declarations
 * of the moment, the account from the account periods (`current/probe-account-reader.ts`).
 *
 * - `probe_sources`: one row per physical tuple of a reading (one in practice, more only for
 *   disagreeing deliveries), or one row without a tuple when the reading proves nothing.
 *   `at` is the collection instant in ms, `accounting_at` and `observation_at` the reading's
 *   accounting and Claude observation instants (`current/probe-accounting-time.ts`); `subject` and
 *   `bare` (no computer recorded) are what an owner correction matches; `revision` moves with every
 *   write of the reading.
 * - `probe_source_tuples`: the distinct physical tuples ever written (a few dozen), so readers map
 *   sources to tuples without scanning the evidence. Never pruned: a stale tuple reads as empty.
 * - `probe_source_dirty`: readings whose evidence must be (re)written: new, corrected, deleted
 *   (`changed`) or newly linked to a canonical fact (only the evidence may differ). Triggers queue them; the current projection writer
 *   writes them (`writeProbeSources`) and knows from the old and new rows which accounts moved.
 */
export const PROBE_SOURCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS probe_sources (
  probe_id INTEGER NOT NULL, ord INTEGER NOT NULL, provider TEXT NOT NULL,
  machine TEXT, home TEXT, login TEXT, basis TEXT NOT NULL, tuples INTEGER NOT NULL,
  at INTEGER, accounting_at INTEGER, observation_at INTEGER, subject TEXT NOT NULL, bare INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(probe_id, ord)
) STRICT;
CREATE INDEX IF NOT EXISTS probe_sources_tuple ON probe_sources(provider, machine, home, login, at, probe_id);
CREATE INDEX IF NOT EXISTS probe_sources_time ON probe_sources(provider, at, probe_id);
CREATE INDEX IF NOT EXISTS probe_sources_accounting ON probe_sources(provider, machine, home, login, accounting_at, probe_id);
CREATE INDEX IF NOT EXISTS probe_sources_observation ON probe_sources(provider, machine, home, login, observation_at, probe_id);
CREATE INDEX IF NOT EXISTS probe_sources_bare ON probe_sources(provider, subject, at, probe_id) WHERE bare=1;
CREATE TABLE IF NOT EXISTS probe_source_tuples (
  provider TEXT NOT NULL, machine TEXT NOT NULL, home TEXT NOT NULL, login TEXT NOT NULL,
  PRIMARY KEY(provider, machine, home, login)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS probe_source_dirty (probe_id INTEGER PRIMARY KEY, changed INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TRIGGER IF NOT EXISTS probe_sources_after_insert AFTER INSERT ON probe_windows BEGIN
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (NEW.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1; END;
CREATE TRIGGER IF NOT EXISTS probe_sources_after_update AFTER UPDATE ON probe_windows BEGIN
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (OLD.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1;
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (NEW.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1; END;
CREATE TRIGGER IF NOT EXISTS probe_sources_after_delete AFTER DELETE ON probe_windows BEGIN
  INSERT INTO probe_source_dirty(probe_id,changed) VALUES (OLD.id,1) ON CONFLICT(probe_id) DO UPDATE SET changed=1; END;`;

/** Canonical links decide the evidence: a new, changed or removed link queues its reading again. */
export const PROBE_SOURCE_LINK_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS probe_sources_link_after_insert AFTER INSERT ON probe_fact_legacy_map WHEN NEW.legacy_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) VALUES (NEW.legacy_id); END;
CREATE TRIGGER IF NOT EXISTS probe_sources_link_after_update AFTER UPDATE ON probe_fact_legacy_map BEGIN
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) SELECT OLD.legacy_id WHERE OLD.legacy_id IS NOT NULL;
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) SELECT NEW.legacy_id WHERE NEW.legacy_id IS NOT NULL; END;
CREATE TRIGGER IF NOT EXISTS probe_sources_link_after_delete AFTER DELETE ON probe_fact_legacy_map WHEN OLD.legacy_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO probe_source_dirty(probe_id) VALUES (OLD.legacy_id); END;`;

const exists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(name);

/** Creates the evidence tables and their triggers where they are missing (fixtures, partial schemas). */
export function ensureProbeSourcesSchema(db: Database): void {
  asSchemaWriter(db, () => {
    if (!exists(db, "probe_windows")) return;
    if (!exists(db, "probe_sources")) {
      db.exec(PROBE_SOURCES_SCHEMA_SQL);
      db.exec("INSERT OR IGNORE INTO probe_source_dirty(probe_id,changed) SELECT id,1 FROM probe_windows");
    } else if (!exists(db, "probe_sources_after_insert") || !exists(db, "probe_source_tuples")) db.exec(PROBE_SOURCES_SCHEMA_SQL);
    if (exists(db, "probe_fact_legacy_map") && !exists(db, "probe_sources_link_after_insert")) db.exec(PROBE_SOURCE_LINK_TRIGGERS_SQL);
    requeueChangedEvidence(db);
  });
}

/**
 * Bumped when the physical evidence of some readings is read differently; only those readings are
 * queued again, once. 2: an Antigravity pool reading (`pool:<id>`) is taken in its worker's Windows
 * account, not the probing process's.
 */
const EVIDENCE_RULES_KEY = "probe_sources_rules", EVIDENCE_RULES = "2";
function requeueChangedEvidence(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  const rules = (db.query("SELECT value FROM meta WHERE key=?").get(EVIDENCE_RULES_KEY) as { value: string } | null)?.value;
  if (rules === EVIDENCE_RULES) return;
  // Partial schemas without the payload have no pool readings.
  if ((db.query("PRAGMA table_info(probe_windows)").all() as Array<{ name: string }>).some(column => column.name === "extra"))
    db.exec(`INSERT OR IGNORE INTO probe_source_dirty(probe_id) SELECT id FROM probe_windows
      WHERE provider='gemini' AND extra LIKE '%"home":"pool:%'`);
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(EVIDENCE_RULES_KEY, EVIDENCE_RULES);
}

const PUBLISHED = "probe_sources_published";
/** The evidence of every reading was written at least once; before that, readers answer "preparing" (golden rules §9). */
export function probeSourcesPublished(db: Database): boolean {
  if (!exists(db, "probe_sources") || !exists(db, "meta")) return false;
  return (db.query("SELECT value FROM meta WHERE key=?").get(PUBLISHED) as { value: string } | null)?.value === "1";
}
/** Readings whose evidence is still to be written: newer data in processing. */
export function probeSourcesPending(db: Database): boolean {
  return exists(db, "probe_source_dirty") && !!db.query("SELECT 1 FROM probe_source_dirty LIMIT 1").get();
}
/** Called by the writer when the queue is empty. */
export function markProbeSourcesPublished(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  db.query("INSERT INTO meta(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value='1'").run(PUBLISHED);
}
