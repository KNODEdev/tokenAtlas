import type { Database } from "./sqlite";
import { asSchemaWriter } from "./schema-writer";

/**
 * Raw usage tables whose rows carry columns derived by the remap (src/projects/remap.ts): repository and group. Projects
 * and session gaps are no longer derived into raw rows (project rules apply at read time, active time is stored in the
 * ledgers), so their old columns stay as they are and nothing reads them.
 */
const DERIVED_TABLES = ["claude_events", "oc_events", "events", "grok_events"] as const;

/** Repository columns of one raw table, with the repository lookup index. */
export function ensureRepoColumns(sqlite: Database, table: string): void {
  asSchemaWriter(sqlite, () => {
    const cols = new Set((sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    if (!cols.has("repo")) {
      sqlite.run(`ALTER TABLE ${table} ADD COLUMN repo TEXT`);
      sqlite.run(`CREATE INDEX IF NOT EXISTS ${table}_repo_idx ON ${table}(repo)`);
    }
    if (!cols.has("repo_group")) sqlite.run(`ALTER TABLE ${table} ADD COLUMN repo_group TEXT`);
  });
}

/**
 * The derived columns belong to the main schema before any import: a sync stage copies the main
 * schema and publication copies only the columns the main table has, so a column the remap
 * added only in a stage would be dropped on publication.
 */
export function ensureDerivedColumns(sqlite: Database): void {
  asSchemaWriter(sqlite, () => {
    for (const table of DERIVED_TABLES) {
      if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      ensureRepoColumns(sqlite, table);
    }
  });
}
