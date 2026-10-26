import { directChanges } from "./change-count";
import { Database } from "./sqlite";

export interface ArchivePathColumn {
  table: string;
  column: string;
}

export const ARCHIVE_PATH_COLUMNS: readonly ArchivePathColumn[] = [
  { table: "events", column: "home" },
  { table: "events", column: "path" },
  { table: "files", column: "home" },
  { table: "files", column: "path" },
  { table: "ratelimit", column: "home" },
  { table: "ratelimit", column: "path" },
  { table: "claude_events", column: "path" },
  { table: "claude_limit_hits", column: "path" },
  { table: "claude_files", column: "path" },
  { table: "grok_events", column: "path" },
  { table: "grok_files", column: "path" },
  { table: "gemini_events", column: "path" },
  { table: "gemini_files", column: "path" },
  // Producer state: the transcript a stored Codex limit-window reading came from.
  { table: "limit_window_inputs", column: "home" },
  { table: "limit_window_inputs", column: "path" },
] as const;

export interface ArchiveRebaseResult {
  sourceRoot: string;
  targetRoot: string;
  changedRows: number;
  clearedBookmarks: number;
  targets: Record<string, number>;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function trimRoot(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

function comparableRoot(value: string): string {
  return trimRoot(value).replace(/\\/g, "/").toLowerCase();
}

function columnsFor(sqlite: Database, table: string): Set<string> {
  const statement = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`);
  try {
    const rows = statement.all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } finally {
    statement.finalize();
  }
}

function rewriteColumn(
  sqlite: Database,
  target: ArchivePathColumn,
  sourceRoot: string,
  targetRoot: string,
): number {
  const table = quoteIdentifier(target.table);
  const column = quoteIdentifier(target.column);
  const sourceLength = sourceRoot.length;
  const boundary = /[\\/]$/.test(sourceRoot)
    ? ""
    : `AND (length(${column}) = ? OR substr(${column}, ?, 1) IN ('/', char(92)))`;
  const bindings: Array<string | number> = [
    targetRoot,
    sourceLength + 1,
    sourceLength,
    sourceRoot,
  ];
  if (boundary) bindings.push(sourceLength, sourceLength + 1);
  sqlite.run(
    `UPDATE ${table}
        SET ${column} = ? || substr(${column}, ?)
      WHERE lower(replace(substr(${column}, 1, ?), '/', char(92))) =
            lower(replace(?, '/', char(92)))
        ${boundary}`,
    bindings,
  );
  return directChanges(sqlite);
}

export function rebaseArchivePaths(
  sqlite: Database,
  sourceArchiveRoot: string,
  targetArchiveRoot: string,
): ArchiveRebaseResult {
  const sourceRoot = trimRoot(sourceArchiveRoot);
  const targetRoot = trimRoot(targetArchiveRoot);
  if (!sourceRoot || !targetRoot) throw new Error("archive roots must not be empty");
  const result: ArchiveRebaseResult = {
    sourceRoot,
    targetRoot,
    changedRows: 0,
    clearedBookmarks: 0,
    targets: {},
  };
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (comparableRoot(sourceRoot) !== comparableRoot(targetRoot)) {
      const columns = new Map<string, Set<string>>();
      for (const target of ARCHIVE_PATH_COLUMNS) {
        const tableColumns = columns.get(target.table) ?? columnsFor(sqlite, target.table);
        columns.set(target.table, tableColumns);
        if (!tableColumns.has(target.column)) continue;
        const changed = rewriteColumn(sqlite, target, sourceRoot, targetRoot);
        result.targets[`${target.table}.${target.column}`] = changed;
        result.changedRows += changed;
      }
    }
    const metaColumns = columnsFor(sqlite, "meta");
    if (metaColumns.has("key") && metaColumns.has("value")) {
      const cleared = sqlite.run(
        "DELETE FROM meta WHERE key LIKE 'opencode_snapshot:%' OR key LIKE 'sync_source_fingerprint:%'",
      );
      result.clearedBookmarks = cleared.changes;
    }
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}
