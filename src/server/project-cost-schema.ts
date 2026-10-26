import type { Database } from "../db/sqlite";

export function tableExists(sqlite: Database, name: string): boolean {
  return sqlite.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`).get(name) != null;
}
