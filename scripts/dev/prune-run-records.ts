// Trims the stored copy of oversized sync run records. A run that failed over
// many inputs used to carry every message in every entry, so single rows grew to
// tens of megabytes; the coordinator now bounds what it writes, and this reclaims
// what earlier runs already stored.
//
// What it must not touch: the run store reads these records back, so the revisions,
// the mode, and each vendor's status, dataChanged and dirty ranges are copied through
// untouched.
import { activeDatabasePath } from "../../src/db";
import { Database } from "../../src/db/sqlite";

const ENTRY_LIMIT = 20;
const TEXT_LIMIT = 2000;
const ROW_LIMIT_BYTES = 256 * 1024;

type Json = Record<string, unknown>;

function trimText(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= TEXT_LIMIT) return value;
  return `${value.slice(0, TEXT_LIMIT)} … [${value.length - TEXT_LIMIT} more characters trimmed from the stored record]`;
}

function trimEntries(container: Json, key: string): void {
  const list = container[key];
  if (!Array.isArray(list)) return;
  const trimmed = list.map(item => item && typeof item === "object" && "error" in (item as Json)
    ? { ...(item as Json), error: trimText((item as Json).error) }
    : trimText(item));
  if (trimmed.length > ENTRY_LIMIT) {
    container[`${key}Total`] = trimmed.length;
    container[key] = trimmed.slice(0, ENTRY_LIMIT);
  } else container[key] = trimmed;
}

export function trimRunRecord(run: Json): Json {
  const trimmed: Json = { ...run, error: trimText(run.error) };
  trimmed.vendors = (Array.isArray(run.vendors) ? run.vendors : []).map(entry => {
    const vendor: Json = { ...(entry as Json), error: trimText((entry as Json).error) };
    const diagnostics = vendor.diagnostics;
    if (diagnostics && typeof diagnostics === "object") {
      const next = { ...(diagnostics as Json) };
      for (const key of ["pendingInputs", "unreadableEvidence", "failedInputs", "warnings"]) trimEntries(next, key);
      const mirror = next.mirror;
      if (mirror && typeof mirror === "object") {
        const copy = { ...(mirror as Json) };
        for (const key of ["archiveFiles", "errors", "warnings", "failedFiles"]) trimEntries(copy, key);
        next.mirror = copy;
      }
      vendor.diagnostics = next;
    }
    return vendor;
  });
  return trimmed;
}

/** Every field the run store reads back must survive untouched. */
export function preservesEvidence(before: Json, after: Json): boolean {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  for (const key of ["runId", "trigger", "scope", "mode", "status", "startedAt", "finishedAt",
    "beforeRevisions", "afterRevisions", "aggregateWorkRequested", "progress"]) {
    if (!same(before[key], after[key])) return false;
  }
  const left = Array.isArray(before.vendors) ? before.vendors : [];
  const right = Array.isArray(after.vendors) ? after.vendors : [];
  if (left.length !== right.length) return false;
  return left.every((entry, index) => ["vendor", "status", "dataChanged", "dirtyRange", "dirtyRanges",
    "writtenRows", "sourceImpact"].every(key => same((entry as Json)[key], (right[index] as Json)[key])));
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  // Same database this machine's server uses.
  const databasePath = activeDatabasePath();
  const sqlite = new Database(databasePath, { readonly: !apply });
  try {
    sqlite.exec("PRAGMA busy_timeout=30000");
    const rows = sqlite.query(
      "SELECT run_id, result_json FROM sync_runs WHERE length(result_json) > ? ORDER BY length(result_json) DESC"
    ).all(ROW_LIMIT_BYTES) as Array<{ run_id: string; result_json: string }>;
    const payloads: Array<{ runId: string; payload: string }> = [];
    let freed = 0;
    for (const row of rows) {
      const before = JSON.parse(row.result_json) as Json;
      const after = trimRunRecord(before);
      if (!preservesEvidence(before, after)) throw new Error(`Refusing to trim ${row.run_id}: evidence fields would change`);
      const payload = JSON.stringify(after);
      freed += row.result_json.length - payload.length;
      payloads.push({ runId: row.run_id, payload });
    }
    console.log(`${rows.length} oversized record(s); ${(freed / 1048576).toFixed(1)} MB to reclaim`);
    if (!apply) {
      console.log("Dry run. Re-run with --apply to write; the database file keeps its size and reuses the freed pages.");
    } else {
      sqlite.transaction(() => {
        const update = sqlite.query("UPDATE sync_runs SET result_json = ? WHERE run_id = ?");
        for (const row of payloads) update.run(row.payload, row.runId);
      }).immediate();
      const total = (sqlite.query("SELECT sum(length(result_json)) AS bytes FROM sync_runs").get() as { bytes: number }).bytes;
      console.log(`Written. Stored run records now hold ${(total / 1048576).toFixed(1)} MB.`);
    }
  } finally { sqlite.close(); }
}
