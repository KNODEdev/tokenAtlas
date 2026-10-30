import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { databaseEnvFile, databaseLocalStateRoot, localSettingsFile, saveDatabaseSelection, selectedDatabasePath } from "../db/location";
import { legacyLocalStateRoot } from "./archive-locator";

/** Stopped-server handoff: preserve durable machine state before publishing a new location. */
export function copyLocalState(source: string, destination: string): boolean {
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase() || !fs.existsSync(source)) return false;
  if (fs.existsSync(destination)) throw new Error("Destination local state already exists; refusing to replace its identity");
  const staged = `${path.resolve(destination)}.stage-${randomUUID()}`;
  fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
  try {
    const target = path.resolve(destination).toLowerCase();
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === "temp") continue;
      // The database may live inside the old state folder (%LOCALAPPDATA%\tokenAtlas\data): never copy its folder into itself.
      const child = path.resolve(source, entry.name).toLowerCase();
      if (target === child || target.startsWith(child + path.sep)) continue;
      fs.cpSync(path.join(source, entry.name), path.join(staged, entry.name), { recursive: true, errorOnExist: true, force: false });
    }
    fs.renameSync(staged, destination);
    return true;
  } finally { fs.rmSync(staged, { recursive: true, force: true }); }
}

/** Called once by the supervisor before it starts the server child and its path-dependent modules. */
export function prepareLocalSettings(envFile = databaseEnvFile, env = process.env): void {
  if ((env.NODE_ENV === "test" && envFile === databaseEnvFile) || env.TOKENATLAS_LOCAL_STATE?.trim() || fs.existsSync(localSettingsFile(envFile))) return;
  const database = selectedDatabasePath(envFile);
  if (!database) return;
  const target = databaseLocalStateRoot(database);
  const copied = copyLocalState(legacyLocalStateRoot(env), target);
  try { saveDatabaseSelection(database, envFile); }
  catch (error) {
    if (copied && !fs.existsSync(localSettingsFile(envFile))) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
