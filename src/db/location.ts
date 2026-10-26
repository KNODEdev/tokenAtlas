import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const databaseSelectionMarker = "# tokenAtlas: selected local database";
export const databaseEnvFile = path.resolve(import.meta.dir, "../../.env");
export const localSettingsFile = (envFile = databaseEnvFile): string => path.join(path.dirname(envFile), "tokenatlas.local.json");
export const databaseLocalStateRoot = (database: string): string => path.join(path.dirname(path.resolve(database)), "local-state");

/** A selection made in the app outranks an inherited launcher environment. */
export function selectedDatabasePath(envFile = databaseEnvFile): string | undefined {
  const settings = localSettingsFile(envFile);
  if (fs.existsSync(settings)) {
    const value = JSON.parse(fs.readFileSync(settings, "utf8"));
    if (value?.schema !== 1 || typeof value.database !== "string" || !path.isAbsolute(value.database))
      throw new Error("Invalid saved local application settings");
    return value.database;
  }
  if (!fs.existsSync(envFile)) return undefined;
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  const marker = lines.indexOf(databaseSelectionMarker);
  if (marker < 0) return undefined;
  const line = lines[marker + 1];
  if (!line?.startsWith("TOKENATLAS_DB=")) throw new Error("Invalid saved database selection in .env");
  const value: unknown = JSON.parse(line.slice("TOKENATLAS_DB=".length));
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Invalid saved database path in .env");
  return value;
}

/** The installation keeps only its chosen database location here; runtime state lives beside that database. */
export function saveDatabaseSelection(database: string, envFile = databaseEnvFile): void {
  const file = localSettingsFile(envFile), candidate = `${file}.${randomUUID()}.tmp`;
  const value = { schema: 1, database: path.resolve(database).replace(/\\/g, "/") };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(candidate, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(candidate, file);
  } finally { fs.rmSync(candidate, { force: true }); }
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
    const marker = lines.indexOf(databaseSelectionMarker);
    if (marker >= 0 && lines[marker + 1]?.startsWith("TOKENATLAS_DB=")) {
      lines.splice(marker, 2);
      const staged = `${envFile}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(staged, lines.join("\n"), { flag: "wx", mode: 0o600 }); fs.renameSync(staged, envFile); }
      catch { /* The committed application setting remains authoritative if legacy cleanup is unavailable. */ }
      finally { try { fs.rmSync(staged, { force: true }); } catch { /* Keep the published selection. */ } }
    }
  }
}

export function databaseEnvironmentContents(existing: string, destination: string): string {
  const kept = existing.split(/\r?\n/).filter(line => line !== databaseSelectionMarker
    && !/^\s*(?:export\s+)?TOKENATLAS_DB\s*=/.test(line)).join("\n").trimEnd();
  return `${kept ? kept + "\n\n" : ""}${databaseSelectionMarker}\nTOKENATLAS_DB=${JSON.stringify(destination.replace(/\\/g, "/"))}\n`;
}
