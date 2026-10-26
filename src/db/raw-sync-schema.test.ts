import { expect, test } from "bun:test";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "./sqlite";
import { applyDrizzleMigrations, ensureRawSyncIndexes } from "./migrate";
import { ensureCodexSchema } from "../ingest/codex";

test("a new database gets the Codex raw tables, so a first fill can publish Codex", () => {
  const sqlite = new Database(":memory:");
  try {
    applyDrizzleMigrations(drizzle(sqlite), path.resolve(import.meta.dir, "../../drizzle"));
    ensureRawSyncIndexes(sqlite);
    const tables = new Set((sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    for (const table of ["events", "files", "ratelimit", "codex_file_evidence"]) expect(tables.has(table)).toBe(true);
    // A Codex call lives in events and the price ledger only (U4.2).
    for (const table of ["codex_usage_facts", "codex_event_evidence"]) expect(tables.has(table)).toBe(false);
    // The stage repeats the importer's own schema step on a copy of this schema.
    expect(() => ensureCodexSchema(sqlite)).not.toThrow();
  } finally { sqlite.close(); }
});
