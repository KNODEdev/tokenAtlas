import fs from "node:fs";
import path from "node:path";

export const databaseSelectionMarker = "# tokenAtlas: selected local database";
export const databaseEnvFile = path.resolve(import.meta.dir, "../../.env");

/** A selection made in the app outranks an inherited launcher environment. */
export function selectedDatabasePath(envFile = databaseEnvFile): string | undefined {
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

export function databaseEnvironmentContents(existing: string, destination: string): string {
  const kept = existing.split(/\r?\n/).filter(line => line !== databaseSelectionMarker
    && !/^\s*(?:export\s+)?TOKENATLAS_DB\s*=/.test(line)).join("\n").trimEnd();
  return `${kept ? kept + "\n\n" : ""}${databaseSelectionMarker}\nTOKENATLAS_DB=${JSON.stringify(destination.replace(/\\/g, "/"))}\n`;
}
