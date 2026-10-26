import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const metaValue = (db: Database, key: string) => {
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
};

export const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
