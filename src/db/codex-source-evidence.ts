import type { Database } from "./sqlite";
import { asSchemaWriter } from "./schema-writer";

// Native detail reads join original evidence by its complete physical locator.
export const CODEX_SOURCE_LOCATOR_INDEX_SQL = "CREATE INDEX IF NOT EXISTS events_source_locator ON events(home,path,source_offset)";
/**
 * The models and meter resets of one transcript, with its row count and newest row, read from the index alone
 * (loadCodexLimitProbes): cold reads of the table's pages were most of the longest limit-window step. `meter_reset`
 * is a column the Codex schema adds, so the index is ensured with it, not by a drizzle migration. An older raw
 * `events` table without those columns gets the index once a later schema step has added them; until then
 * there is nothing to cover, and a migration never fails on it.
 */
export function ensureCodexFileModelsIndex(db: Database): void {
  asSchemaWriter(db, () => {
    const columns = new Set((db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(column => column.name));
    if (["home", "path", "model", "meter_reset"].every(column => columns.has(column)))
      db.exec("CREATE INDEX IF NOT EXISTS events_file_models ON events(home,path,model,meter_reset)");
  });
}

/**
 * Whole-file proof of a Codex transcript: the digest and length the parser read, and the
 * provider thread and session of the file. Thread and session are inferred - the one value the
 * file's calls (or its session header) carry - not evidence that the provider wrote them at a
 * given call. `provider_forked_from_id` is the parent thread a forked transcript's own session header
 * names (`forked_from_id`): such a transcript may open with a replay of the parent's calls.
 * Per call that is `events.response_id IS NOT NULL`; a call where it is not
 * (identifiers without a response id, or the reverse) keeps the difference in
 * `events.provider_ids_observed` (docs/u3.0-codex-ledger-design-2026-10-04.md §3).
 */
export const CODEX_SOURCE_EVIDENCE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS codex_file_evidence (
  home TEXT NOT NULL, path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
  source_byte_length INTEGER NOT NULL CHECK(source_byte_length>=0),
  parser_version INTEGER NOT NULL, evidence_version INTEGER NOT NULL CHECK(evidence_version=1),
  session_headers_json TEXT NOT NULL, provider_thread_id TEXT, provider_session_id TEXT, PRIMARY KEY(home,path)
) STRICT;`;
/**
 * `provider_forked_from_id` is added where the import owns the table (ensureCodexSchema, ensureRawSyncIndexes),
 * like the other additive Codex columns; the index finds the forks of a thread (the ledger re-resolves them when
 * their parent's calls change).
 */
export const CODEX_FORKED_FROM_INDEX_SQL = `CREATE INDEX IF NOT EXISTS codex_file_evidence_forked_from
  ON codex_file_evidence(provider_forked_from_id) WHERE provider_forked_from_id IS NOT NULL`;

const exists = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

/**
 * One-time move out of the retired per-call evidence table (U4.2): each file takes its single
 * thread and session, each call whose identifier presence differs from its response id keeps
 * that difference, then the table goes. Runs where `events` is owned (ensureRawSyncIndexes),
 * after the migration that added the file columns.
 */
export function retireCodexEventEvidence(db: Database): void {
  if (!exists(db, "codex_event_evidence")) return;
  db.transaction(() => {
    if (exists(db, "events")) {
      db.exec(`UPDATE events AS e SET provider_ids_observed = p.observed FROM (
          SELECT home, path, source_offset,
            CASE WHEN provider_thread_id IS NOT NULL OR provider_session_id IS NOT NULL THEN 1 ELSE 0 END AS observed
          FROM codex_event_evidence) p
        WHERE p.home = e.home AND p.path = e.path AND p.source_offset = e.source_offset
          AND p.observed <> (e.response_id IS NOT NULL)`);
    }
    for (const column of ["provider_thread_id", "provider_session_id"]) {
      db.exec(`UPDATE codex_file_evidence AS f SET ${column} = p.value FROM (
          SELECT home, path, MIN(${column}) AS value FROM codex_event_evidence WHERE ${column} IS NOT NULL
          GROUP BY home, path HAVING COUNT(DISTINCT ${column}) = 1) p
        WHERE p.home = f.home AND p.path = f.path AND f.${column} IS NULL`);
    }
    db.exec("DROP TABLE codex_event_evidence");
  }).immediate();
}

/** The one thread and session a file's calls carry (session header as the fallback); null where there is none or more than one. */
export function fileProviderIds(events: ReadonlyArray<{ providerThreadId: string | null; providerSessionId: string | null }>,
  headerSessions: ReadonlyArray<string | null>): { thread: string | null; session: string | null } {
  const only = (values: Array<string | null>) => {
    const distinct = new Set(values.filter((value): value is string => !!value));
    return distinct.size === 1 ? [...distinct][0]! : null;
  };
  return { thread: only(events.map(event => event.providerThreadId)),
    session: only(events.map(event => event.providerSessionId)) ?? only([...headerSessions]) };
}
