import type { UsageVendorId } from "../sync/contracts";
import { Database } from "./sqlite";
import type { SQLQueryBindings } from "./sqlite";
import { USAGE_VENDOR_IDS } from "../sync/contracts";
import { ledgerRevision } from "./ledger-revision";
import type { AtlasSnapshotRevisions } from "./snapshot-contracts";

const VENDOR_TABLES: Record<UsageVendorId, string> = {
  codex: "events",
  claude: "claude_events",
  opencode: "oc_events",
  grok: "grok_events",
  gemini: "gemini_events",
};

export class SnapshotDatabase extends Database {
  private readonly queries = new Set<ReturnType<Database["query"]>>();

  override query<T, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) {
    const statement = super.query<T, P>(sql);
    this.queries.add(statement);
    return statement;
  }

  override close(): void {
    // Bun 1.3.14 leaves evicted query statements alive until GC, locking files on Windows.
    for (const statement of this.queries) statement.finalize();
    this.queries.clear();
    super.close(true);
  }
}

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  meta: ["key", "value"],
  events: ["home", "path", "ts", "cwd"],
  files: ["home", "path"],
  ratelimit: ["home", "path", "ts"],
  claude_events: ["store", "path", "ts", "cwd", "project"],
  claude_files: ["store", "path"],
  oc_events: ["store", "ts", "directory", "project"],
  grok_events: ["store", "path", "ts", "cwd", "project"],
  grok_files: ["store", "path"],
  gemini_events: ["store", "path", "ts", "workspace"],
  gemini_files: ["store", "path"],
  sync_revisions: ["data_revision", "config_revision"],
  vendor_sync_revisions: ["vendor", "data_revision"],
};

export function databaseSchemaVersion(sqlite: Database): number {
  let statement: ReturnType<Database["prepare"]> | null = null;
  try {
    statement = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations");
    const row = statement.get() as { n: number } | null;
    return (row?.n ?? 0) - 1;
  } catch {
    return -1;
  } finally {
    statement?.finalize();
  }
}

function tableColumns(sqlite: Database, table: string): Set<string> {
  const statement = sqlite.prepare(`PRAGMA table_info(\"${table}\")`);
  try {
    const rows = statement.all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } finally {
    statement.finalize();
  }
}

export function validateRequiredSchema(sqlite: Database): string[] {
  const errors: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = tableColumns(sqlite, table);
    if (columns.size === 0) {
      errors.push(`required table is missing: ${table}`);
      continue;
    }
    for (const column of required) {
      if (!columns.has(column)) errors.push(`required column is missing: ${table}.${column}`);
    }
  }
  return errors;
}

export function sqliteIntegrityErrors(sqlite: Database): string[] {
  const statement = sqlite.prepare("PRAGMA integrity_check");
  try {
    const rows = statement.all() as Array<Record<string, unknown>>;
    if (rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok") return [];
    return ["SQLite integrity check failed"];
  } finally {
    statement.finalize();
  }
}

function countRows(sqlite: Database, table: string): number {
  const statement = sqlite.prepare(`SELECT COUNT(*) AS n FROM \"${table}\"`);
  try {
    const row = statement.get() as { n: number } | null;
    return row?.n ?? 0;
  } finally {
    statement.finalize();
  }
}

export function readVendorRowCounts(sqlite: Database): Record<UsageVendorId, number> {
  const counts = {} as Record<UsageVendorId, number>;
  for (const vendor of USAGE_VENDOR_IDS) counts[vendor] = countRows(sqlite, VENDOR_TABLES[vendor]);
  return counts;
}

export function readRevisions(sqlite: Database): AtlasSnapshotRevisions {
  const syncStatement = sqlite.prepare("SELECT data_revision, config_revision FROM sync_revisions WHERE id = 1");
  let sync: { data_revision: number; config_revision: number } | null;
  try {
    sync = syncStatement.get() as { data_revision: number; config_revision: number } | null;
  } finally {
    syncStatement.finalize();
  }
  if (!sync) throw new Error("snapshot revision rows are missing");
  return { data: sync.data_revision, config: sync.config_revision, derived: ledgerRevision(sqlite) };
}

export function readVendorDataRevisions(sqlite: Database): Record<UsageVendorId, number> {
  const out = Object.fromEntries(USAGE_VENDOR_IDS.map((vendor) => [vendor, 0])) as Record<UsageVendorId, number>;
  const statement = sqlite.prepare("SELECT vendor, data_revision FROM vendor_sync_revisions");
  let rows: Array<{ vendor: string; data_revision: number }>;
  try {
    rows = statement.all() as Array<{ vendor: string; data_revision: number }>;
  } finally {
    statement.finalize();
  }
  for (const row of rows) {
    if (USAGE_VENDOR_IDS.includes(row.vendor as UsageVendorId)) out[row.vendor as UsageVendorId] = row.data_revision;
  }
  return out;
}

export function atlasSnapshotRevisions(dbPath: string): AtlasSnapshotRevisions {
  const sqlite = new SnapshotDatabase(dbPath, { readonly: true });
  try {
    return readRevisions(sqlite);
  } finally {
    sqlite.close();
  }
}
