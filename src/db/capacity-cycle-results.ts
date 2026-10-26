import type { Database } from "bun:sqlite";
import { asSchemaWriter } from "./schema-writer";

export const CAPACITY_CYCLE_RESULTS_SQL = `
CREATE TABLE IF NOT EXISTS capacity_cycle_results (
  provider TEXT NOT NULL, account TEXT NOT NULL, counter TEXT NOT NULL, window_id TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, window_minutes INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 1, body TEXT, error TEXT, preparing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider,account,counter,window_id)
) STRICT;
CREATE INDEX IF NOT EXISTS capacity_cycle_results_range ON capacity_cycle_results(window_minutes,end_ts,start_ts);
CREATE TABLE IF NOT EXISTS capacity_cycle_result_dirty (
  provider TEXT NOT NULL, account TEXT NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER,
  sequence INTEGER NOT NULL DEFAULT 1, phase TEXT NOT NULL DEFAULT 'windows', cursor TEXT,
  PRIMARY KEY(provider,account,from_ms)
) STRICT;
CREATE TABLE IF NOT EXISTS capacity_cycle_result_state (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;`;

export function hasCapacityCycleResults(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capacity_cycle_results'").get();
}
export function ensureCapacityCycleResults(db: Database): void {
  asSchemaWriter(db, () => db.exec(CAPACITY_CYCLE_RESULTS_SQL));
}
export function bumpCapacityCycleResultsClock(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='analysis_source_revisions'").get())
    db.query("INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES('capacity_cycle_results','*',1) ON CONFLICT(source,bucket) DO UPDATE SET revision=revision+1").run();
}
/** Written with the common window publication, never by an HTTP read. */
export function markCapacityCycleResultsDirty(db: Database, provider: string, account: string, from: number, until: number | null, initial = false): void {
  if (!account || !hasCapacityCycleResults(db)) return;
  // Before the first discovery, its full inventory will cover every source publication already present.
  if (!initial && !db.query("SELECT 1 FROM capacity_cycle_result_state LIMIT 1").get()) return;
  db.query(`INSERT INTO capacity_cycle_result_dirty(provider,account,from_ms,until_ms) VALUES(?,?,?,?)
    ON CONFLICT(provider,account,from_ms) DO UPDATE SET until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END,
    sequence=sequence+1,phase='windows',cursor=NULL`)
    .run(provider, account, Math.floor(from), until === null ? null : Math.ceil(until));
  bumpCapacityCycleResultsClock(db);
}
