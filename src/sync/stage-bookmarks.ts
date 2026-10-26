import type { SQLQueryBindings, Database } from "../db/sqlite";
import { quoteIdentifier, tableColumns } from "./sync-sql";
import type { DeltaSpec, DeltaIdentity } from "./vendor-publication-schema";
import { identityWhere } from "./publication-identities";

/** `size`/`mtime` below zero is the existing "registered but not read" marker. */
const UNREAD_BOOKMARK = { size: -1, mtime: -1 } as const;

/**
 * A bookmark asserts which bytes of a source produced the facts stored for its
 * identity. A ranged publication keeps only part of a whole-file reading, so each
 * identity is resolved on evidence, as a whole tuple - never a maximum and never
 * a blend of two different readings.
 */
export type BookmarkState = { row: Record<string, SQLQueryBindings> | null; snapshot: string | null };

export type BookmarkOutcome = "retained" | "proven" | "unread";

export function nullableTableColumns(sqlite: Database, table: string): Set<string> {
  return new Set((sqlite.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; notnull: number }>)
    .filter((column) => !column.notnull).map((column) => column.name));
}

export function readBookmarkState(sqlite: Database, spec: DeltaSpec, identity: DeltaIdentity): BookmarkState {
  if (spec.bookmarkTable) {
    const where = identityWhere(spec, identity);
    return { row: sqlite.query(`SELECT * FROM ${quoteIdentifier(spec.bookmarkTable)} WHERE ${where.sql}`)
      .get(...where.params) as Record<string, SQLQueryBindings> | null, snapshot: null };
  }
  const row = sqlite.query("SELECT value FROM meta WHERE key = ?")
    .get(`opencode_snapshot:${identity.store}`) as { value: string } | null;
  return { row: null, snapshot: row?.value ?? null };
}

export function hasReadBookmark(sqlite: Database, spec: DeltaSpec, state: BookmarkState): boolean {
  const row = state.row ?? (state.snapshot ? JSON.parse(state.snapshot) as Record<string, unknown> : null);
  const nonnegativeInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!row || typeof row.path !== "string" || !nonnegativeInteger(row.size)
    || typeof row.mtime !== "number" || !Number.isFinite(row.mtime) || row.mtime < 0) return false;
  for (const column of spec.bookmarkProgress) {
    if (column !== "parser_state" && !nonnegativeInteger(row[column])) return false;
  }
  if (spec.bookmarkParser.some(column => !nonnegativeInteger(row[column]))) return false;
  if (spec.bookmarkTable === "files") {
    if (typeof row.parser_state !== "string") return false;
    if ((row.offset as number) > (row.size as number)) {
      if (typeof row.home !== "string") return false;
      // Compressed file sizes are physical; resume offsets belong to the proven decoded JSONL.
      const proof = sqlite.query("SELECT source_byte_length FROM codex_file_evidence WHERE home=? AND path=?")
        .get(row.home, row.path) as { source_byte_length: number } | null;
      if (!proof || (row.offset as number) > proof.source_byte_length) return false;
    }
    try {
      const parser = JSON.parse(row.parser_state);
      if (!parser || typeof parser !== "object" || parser.offset !== row.offset) return false;
    } catch { return false; }
  }
  return true;
}

/** Registration and path survive so discovery and a later generation still find the source. */
export function unreadBookmark(spec: DeltaSpec, state: BookmarkState, nullableColumns: ReadonlySet<string>): BookmarkState | null {
  if (state.row) {
    const marked: Record<string, SQLQueryBindings> = { ...state.row, ...UNREAD_BOOKMARK };
    for (const column of spec.bookmarkProgress) {
      if (column in marked) marked[column] = nullableColumns.has(column) ? null : 0;
    }
    return { row: marked, snapshot: null };
  }
  if (!state.snapshot) return null;
  const snapshot = JSON.parse(state.snapshot) as Record<string, unknown>;
  if (typeof snapshot.path !== "string") throw new Error("Invalid OpenCode source bookmark");
  return { row: null, snapshot: JSON.stringify({ ...snapshot, ...UNREAD_BOOKMARK }) };
}

/** Values are rebound as they were read, so REAL mtimes keep their exact double. */
export function writeBookmarkState(active: Database, spec: DeltaSpec, identity: DeltaIdentity, state: BookmarkState): void {
  if (spec.bookmarkTable && state.row) {
    const where = identityWhere(spec, identity);
    active.query(`DELETE FROM ${quoteIdentifier(spec.bookmarkTable)} WHERE ${where.sql}`).run(...where.params);
    const columns = tableColumns(active, spec.bookmarkTable);
    active.query(`INSERT INTO ${quoteIdentifier(spec.bookmarkTable)} (${columns.map(quoteIdentifier).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => state.row![column] ?? null));
    return;
  }
  if (!spec.bookmarkTable && state.snapshot) {
    active.query(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`opencode_snapshot:${identity.store}`, state.snapshot);
  }
}
