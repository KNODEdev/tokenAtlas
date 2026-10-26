import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import type { NormalizedAdapterResult, VendorAdapter, VendorAdapters } from "./adapters";
import type { VendorId } from "./contracts";
import { ensureCodexSchema, syncCodex, type CodexSyncResult } from "../ingest/codex";

/** Imports one Codex home into a database file the way the sync adapter does. */
export async function importCodexHome(dbPath: string, home: string): Promise<CodexSyncResult> {
  const db = new Database(dbPath);
  try { ensureCodexSchema(db); return await syncCodex(db, { homes: [home] }); }
  finally { db.close(); }
}

/** The Codex tables of a test database, as a first Codex import creates them. */
export function createCodexSchema(dbPath: string): void {
  const db = new Database(dbPath);
  try { ensureCodexSchema(db); } finally { db.close(); }
}

/** Minimal current account document for synthetic sync fixtures. */
export function emptyAccountsDocument() {
  return { version: 2 as const, subscriptions: [], sources: [] };
}

export function createTestDatabase(): { directory: string; dbPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-sync-test-"));
  const dbPath = path.join(directory, "atlas.sqlite");
  const sqlite = new Database(dbPath, { create: true });
  try {
    applyDrizzleMigrations(drizzle(sqlite, { schema }));
  } finally {
    sqlite.close();
  }
  return { directory, dbPath };
}

export function successfulNoop(): NormalizedAdapterResult {
  return {
    processedInputs: 0,
    skippedInputs: 1,
    writtenRows: 0,
    dirtyRange: null,
    diagnostics: {},
    validationErrors: [],
  };
}

export function adaptersWith(overrides: Partial<VendorAdapters>): VendorAdapters {
  const noop: VendorAdapter = async () => successfulNoop();
  return {
    codex: overrides.codex ?? noop,
    claude: overrides.claude ?? noop,
    opencode: overrides.opencode ?? noop,
    grok: overrides.grok ?? noop,
    gemini: overrides.gemini ?? noop,
    gauges: overrides.gauges ?? noop,
  };
}

export async function noMirror(): Promise<{ copied: number; skipped: number; warnings: string[]; errors: string[] }> {
  return { copied: 0, skipped: 0, warnings: [], errors: [] };
}

export function replaceClaudeRows(dbPath: string, marker: string): void {
  const sqlite = new Database(dbPath);
  try {
    sqlite.exec("DELETE FROM claude_events");
    sqlite
      .query("INSERT INTO claude_events (store, call_id, ts, path) VALUES ('live', ?, ?, ?)")
      .run(marker, "2026-08-31T10:00:00.000Z", `${marker}.jsonl`);
  } finally {
    sqlite.close();
  }
}

export function vendorRevision(dbPath: string, vendor: VendorId): number {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const row = sqlite
      .query("SELECT data_revision FROM vendor_sync_revisions WHERE vendor = ?")
      .get(vendor) as { data_revision: number } | null;
    return row?.data_revision ?? 0;
  } finally {
    sqlite.close();
  }
}
