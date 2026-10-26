import path from "node:path";
import fs from "node:fs";
import { isRecord, integerField } from "./snapshot-manifest";

export function currentAtlasSchemaVersion(): number {
  const journalPath = path.resolve(import.meta.dir, "../../drizzle/meta/_journal.json");
  const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error("migration journal is invalid");
  }
  const indexes = parsed.entries
    .filter(isRecord)
    .map((entry) => integerField(entry, "idx"))
    .filter((index): index is number => index !== null);
  if (indexes.length === 0) throw new Error("migration journal is empty");
  // Counted like a database's applied migrations (databaseSchemaVersion): a number reserved for a
  // migration still on another branch leaves a gap in the indexes, not in the count.
  return indexes.length - 1;
}
