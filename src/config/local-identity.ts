import { Database } from "../db/sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveArchiveRootFromEnv } from "./path-environment";
import { assertLocalStateOutsideRoots, resolveLocalStateRootBase } from "./archive-locator";

export interface LocalIdentity { machine_id: string; runtime_id: string; runtime_key: string; kind: string }
export function localStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = resolveLocalStateRootBase(env);
  const archiveRoot = resolveArchiveRootFromEnv(env);
  const configRoot = path.resolve(env.TOKENATLAS_CONFIG?.trim() || path.join(archiveRoot, "config"));
  assertLocalStateOutsideRoots(root, [archiveRoot, configRoot]);
  return root;
}
function validateLocal(db: Database): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const machines = db.query("SELECT singleton,id FROM local_machine").all() as { singleton: number; id: string }[];
  const runtimes = db.query("SELECT runtime_key,id,kind FROM local_runtimes").all() as { runtime_key: string; id: string; kind: string }[];
  if (machines.length !== 1 || machines[0]!.singleton !== 1 || !uuid.test(machines[0]!.id) ||
      runtimes.some(r => !uuid.test(r.id) || !r.runtime_key.trim() || !r.kind.trim())) throw new Error("Invalid local identity state");
  const ids = new Set([machines[0]!.id, ...runtimes.map(r => r.id)]);
  if (ids.size !== runtimes.length + 1 || (db.query("SELECT entity_id FROM local_aliases").all() as { entity_id: string }[]).some(a => !ids.has(a.entity_id))) throw new Error("Invalid local identity state");
}
function openLocal(create: boolean): Database | null {
  const root = localStateRoot();
  const file = path.join(root, "identity.sqlite");
  const exists = fs.existsSync(file);
  if (!exists && !create) return null;
  if (!exists) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new Database(file, { create, readonly: !create });
  try {
    db.exec("PRAGMA busy_timeout=10000");
    if (create) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        if ((exists || tables.length) && !tables.some(t => t.name === "local_machine")) throw new Error("Invalid local identity database");
        if (tables.length) validateLocal(db);
        db.exec(`CREATE TABLE IF NOT EXISTS local_machine (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE);
          CREATE TABLE IF NOT EXISTS local_runtimes (runtime_key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS local_aliases (entity_id TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(entity_id,alias));`);
        if (!tables.length) db.query("INSERT INTO local_machine VALUES (1,?)").run(randomUUID());
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    } else {
      validateLocal(db);
    }
    return db;
  } catch (e) { db.close(); throw e; }
}
export function allocateLocalIdentity(runtimeKey: string, kind: string, aliases: { machine: string; profile: string }): LocalIdentity {
  if (!runtimeKey.trim() || !kind.trim()) throw new Error("Explicit runtime key and kind required");
  const db = openLocal(true)!;
  try {
    return db.transaction(() => {
      validateLocal(db);
      db.query("INSERT OR IGNORE INTO local_runtimes VALUES (?,?,?)").run(runtimeKey, randomUUID(), kind);
      const machine = db.query("SELECT id FROM local_machine WHERE singleton=1").get() as { id: string };
      const runtime = db.query("SELECT id,kind FROM local_runtimes WHERE runtime_key=?").get(runtimeKey) as { id: string; kind: string };
      if (runtime.kind !== kind) throw new Error("Runtime kind changed without a new declaration");
      const add = db.query("INSERT OR IGNORE INTO local_aliases VALUES (?,?)");
      add.run(machine.id, aliases.machine); add.run(runtime.id, aliases.profile);
      return { machine_id: machine.id, runtime_id: runtime.id, runtime_key: runtimeKey, kind };
    }).immediate();
  } finally { db.close(); }
}
/** Read the durable machine instance without creating or modifying local state. */
export function readLocalMachineId(): string | null {
  const db = openLocal(false);
  if (!db) return null;
  try {
    return (db.query("SELECT id FROM local_machine WHERE singleton=1").get() as { id: string }).id;
  } finally { db.close(); }
}
