import type { LocalArchiveSelection } from "../config/archive-locator";
import { samePath } from "./archive-relocation-paths";
import { realArchiveLocation, locationContains } from "../config/archive-location";
import path from "node:path";
import { resolveConfigRootFromEnvironment, resolveOverridePhysicalPathFromEnv } from "../config/path-environment";
import fs from "node:fs";
import { Database } from "../db/sqlite";
import { readRebuildStatusJson } from "../db/rebuild-status";

export function selectionMatches(selection: LocalArchiveSelection | null, root: string, archiveId: string): boolean {
  return !!selection && selection.archiveId === archiveId && samePath(selection.root, root);
}

export function assertActivationEnvironment(destination: string, env: Record<string, string | undefined>): void {
  const explicit = env.TOKENATLAS_ARCHIVE?.trim();
  if (explicit !== undefined && (!explicit || /[\r\n\0]/.test(explicit))) {
    throw new Error("Invalid TOKENATLAS_ARCHIVE override");
  }
  if (explicit && !samePath(realArchiveLocation(explicit), destination)) {
    throw new Error(`TOKENATLAS_ARCHIVE points to '${path.resolve(explicit)}', not relocation destination '${destination}'`);
  }
}

const STORE_PATH_OVERRIDES = [
  "TOKENATLAS_STORE_LIVE",
  "TOKENATLAS_STORE_DESKTOP",
] as const;

/** Refuse cutover while a configured live reader would still resolve into the retiring root. */
export function assertActivationPathOverrides(
  source: string,
  destination: string,
  env: Record<string, string | undefined>,
): void {
  const configured: Array<[string, string]> = [];
  if (env.TOKENATLAS_CONFIG?.trim()) {
    configured.push([
      "TOKENATLAS_CONFIG",
      resolveConfigRootFromEnvironment(env, destination),
    ]);
  }
  for (const name of STORE_PATH_OVERRIDES) {
    const raw = env[name];
    if (raw) configured.push([name, resolveOverridePhysicalPathFromEnv(raw, env, destination)]);
  }
  for (const [name, candidate] of configured) {
    const physical = realArchiveLocation(candidate);
    if (locationContains(source, physical)) {
      throw new Error(`${name} resolves inside the retiring archive source: '${physical}'`);
    }
  }
}

export interface DatabaseAdmission {
  commit(): void;
  rollback(): void;
}

/** BEGIN IMMEDIATE serializes sync/reset admission while retaining ordinary WAL readers. */
export function acquireDatabaseAdmission(database: string, archiveId: string): DatabaseAdmission {
  const file = path.resolve(database);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Archive activation requires the prepared local database: ${file}`);
  }
  const db = new Database(file);
  let open = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    open = true;
    const exists = (table: string) => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) != null;
    if (exists("sync_runs") && db.query(`SELECT 1 FROM sync_runs
      WHERE status IN ('queued','pending','running') LIMIT 1`).get()) {
      throw new Error("Archive activation is blocked while a local sync is queued or running");
    }
    const rebuild = readRebuildStatusJson(db);
    if (rebuild && ["queued", "running"].includes((JSON.parse(rebuild) as { state?: string }).state ?? "")) {
      throw new Error("Archive activation is blocked while an analysis rebuild is queued or running");
    }
    if (exists("meta")) {
      const bound = db.query("SELECT value FROM meta WHERE key='archive:identity'").get() as { value: string } | null;
      if (bound && bound.value !== archiveId) throw new Error("Prepared local database belongs to a different archive identity");
    }
  } catch (error) {
    if (open) try { db.exec("ROLLBACK"); } catch { /* preserve admission failure */ }
    db.close();
    throw error;
  }
  const finish = (sql: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    try { db.exec(sql); }
    finally { open = false; db.close(); }
  };
  return { commit: () => finish("COMMIT"), rollback: () => finish("ROLLBACK") };
}
