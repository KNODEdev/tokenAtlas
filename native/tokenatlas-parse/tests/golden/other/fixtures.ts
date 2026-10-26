import fs from "node:fs";
import path from "node:path";
import { Database } from "../../../../../src/db/sqlite";

function varint(value: number): number[] {
  const out: number[] = [];
  while (value >= 128) { out.push(value % 128 | 128); value = Math.floor(value / 128); }
  out.push(value); return out;
}
const scalar = (field: number, value: number) => [field * 8, ...varint(value)];
const bytes = (field: number, value: number[]) => [...varint(field * 8 + 2), ...varint(value.length), ...value];
const text = (field: number, value: string) => bytes(field, [...Buffer.from(value)]);

/** Rebuild small SQLite goldens from reviewed recipes, avoiding opaque binary fixtures. */
export function createOtherSqliteGoldens(directory: string): { gemini: string; mtime: string; opencode: string } {
  fs.mkdirSync(directory, { recursive: true });
  const recipe = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "gemini.json"), "utf8")) as {
    metadata: { updated: number; workspace: string };
    generations: Array<{ idx: number; hex?: string; null?: boolean; fresh?: number; duplicateFresh?: number; cached?: number; total?: number;
      thinking?: number; visible?: number; model?: string; modelHex?: string; context?: number; limit?: number }>;
  };
  const files = { gemini: path.join(directory, "conversation #😀.db"), mtime: path.join(directory, "mtime.db"), opencode: path.join(directory, "opencode #😀.sqlite") };
  for (const file of [files.gemini, files.mtime]) {
    const db = new Database(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE trajectory_metadata_blob(data BLOB); CREATE TABLE gen_metadata(idx INTEGER, data BLOB)");
      if (file === files.gemini) db.query("INSERT INTO trajectory_metadata_blob VALUES(?)").run(new Uint8Array([
        ...bytes(2, scalar(1, recipe.metadata.updated)), ...text(18, recipe.metadata.workspace),
      ]));
      for (const r of recipe.generations) {
        const data = r.null ? null : r.hex ? Buffer.from(r.hex, "hex") : new Uint8Array(bytes(1, [
          ...bytes(4, [...scalar(2, r.fresh ?? 0), ...(r.duplicateFresh === undefined ? [] : scalar(2, r.duplicateFresh)), ...scalar(5, r.cached ?? 0),
            ...scalar(3, r.total ?? 0), ...scalar(9, r.thinking ?? 0), ...scalar(10, r.visible ?? 0)]),
          ...(r.modelHex ? bytes(19, [...Buffer.from(r.modelHex, "hex")]) : r.model ? text(19, r.model) : []),
          ...bytes(9, bytes(10, [...scalar(1, r.context ?? 0), ...scalar(4, r.limit ?? 0)])),
        ]));
        db.query("INSERT INTO gen_metadata VALUES(?,?)").run(r.idx, data);
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    fs.utimesSync(file, 1788264000.123, 1788264000.123);
  }
  const oc = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "opencode.json"), "utf8")) as {
    sessions: Array<[string, string | null]>; messages: Array<[string, string, unknown]>;
  };
  const db = new Database(files.opencode);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)");
    for (const row of oc.sessions) db.query("INSERT INTO session VALUES(?,?)").run(...row);
    for (const [id, session, value] of oc.messages) db.query("INSERT INTO message VALUES(?,?,?)").run(id, session, JSON.stringify(value));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  return files;
}
