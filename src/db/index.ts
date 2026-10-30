import { Database } from "./sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import os from "os";
import path from "path";
import fs from "fs";
import { selectedDatabasePath } from "./location";
/** The database the server runs on: a selection saved in Settings outranks an inherited launcher variable. */
export function activeDatabasePath(envFile?: string): string {
  return selectedDatabasePath(envFile) ?? resolveDbPath();
}
// Read the installation's saved settings by absolute path, including the legacy managed .env
// selection, so a process started elsewhere never falls through to an empty default database.
export function resolveDbPath(customPath?: string, env: Record<string, string | undefined> = process.env): string {
  let p = customPath || (env === process.env ? selectedDatabasePath() : undefined) || env.TOKENATLAS_DB || selectedDatabasePath();
  if (!p) {
    p = defaultDatabasePath(env);
  } else if (p.startsWith("~")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}
/**
 * A new Windows installation keeps its machine-only files together under %LOCALAPPDATA%\tokenAtlas; `data\` keeps
 * the database and its local state apart from the pre-selection state in that folder. An existing default
 * database stays where it is.
 */
export function defaultDatabasePath(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const legacy = path.join(os.homedir(), ".tokenatlas", "atlas.sqlite");
  if (platform !== "win32" || fs.existsSync(legacy)) return legacy;
  return path.join(env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local"), "tokenAtlas", "data", "atlas.sqlite");
}
/** Writer settings shared by every connection that imports or publishes rows. */
export function applyConnectionSettings(sqlite: Database): void {
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  // A checkpoint truncates the WAL back to this size; without it the WAL kept
  // growing past 400 MB next to a 1 GB index.
  sqlite.exec("PRAGMA journal_size_limit = 67108864;");
  sqlite.exec("PRAGMA cache_size = -65536;");
  sqlite.exec("PRAGMA mmap_size = 268435456;");
  sqlite.exec("PRAGMA temp_store = MEMORY;");
}
export function initDb(customPath?: string) {
  const dbPath = resolveDbPath(customPath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath, { create: true });
  try {
    applyConnectionSettings(sqlite);
    const db = drizzle(sqlite, { schema });
    return { db, sqlite, dbPath };
  } catch (error) {
    // Cleanup must not replace the initialization failure.
    try { sqlite.close(); } catch { /* Preserve the original error. */ }
    throw error;
  }
}
