import type { Database } from "bun:sqlite";

/**
 * The explicit analysis rebuild's status (server/analysis-rebuild.ts): one JSON value in `meta`. It
 * moved there from the removed report tables (migration 0059), so readers that cannot depend on the
 * server read it here.
 */
export const REBUILD_STATUS_KEY = "analysis_rebuild_status";

const hasMeta = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();

export function readRebuildStatusJson(db: Database): string | null {
  if (!hasMeta(db)) return null;
  return (db.query("SELECT value FROM meta WHERE key=?").get(REBUILD_STATUS_KEY) as { value: string } | null)?.value ?? null;
}

export function writeRebuildStatusJson(db: Database, json: string): void {
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(REBUILD_STATUS_KEY, json);
}
