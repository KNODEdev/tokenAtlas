import { ProbeFactConflict } from "../../db/probe-facts";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { JournalFile } from "./journal";

/** Inspect the transport before payload parsing can classify a line as legacy/malformed.
 * Torn JSON still follows the legacy malformed-line path: no envelope can be read from it.
 * Complete JSON declaring either envelope field must pass version/ID validation.
 */
export function journalEntryId(line: string): string | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.journal_version === undefined && record.journal_entry_id === undefined) return null;
  if ((record.journal_version !== 2 && record.journal_version !== 3) || typeof record.journal_entry_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.journal_entry_id)) {
    throw new Error("Unsupported gauge journal envelope");
  }
  return record.journal_entry_id;
}

/** Called inside the ingest transaction AFTER payload validation, before its fact write. */
export function acceptJournalEntry(sqlite: Database, line: string, file: JournalFile, ts: string): boolean {
  const entryId = journalEntryId(line);
  if (entryId == null) return true;
  // Include the file type; the same delivery ID cannot be repurposed across two journals.
  const hash = createHash("sha256").update(file).update("\0").update(line.trim()).digest("hex");
  const prior = sqlite.query("SELECT payload_hash FROM gauge_journal_receipts WHERE entry_id = ?")
    .get(entryId) as { payload_hash: string } | null;
  if (prior) {
    if (prior.payload_hash !== hash) throw new ProbeFactConflict("unknown", prior.payload_hash, line, "Gauge journal entry identity conflict");
    return false;
  }
  sqlite.query("INSERT INTO gauge_journal_receipts (entry_id, payload_hash, ts) VALUES (?, ?, ?)")
    .run(entryId, hash, ts);
  return true;
}
