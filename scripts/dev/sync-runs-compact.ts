// Compacts oversized `sync_runs.result_json` rows to the same bounded form the
// coordinator now persists (`boundedSyncRunResult`). A failing run used to store
// one diagnostic entry per source file, so single rows reached tens of megabytes.
//
// What it must not touch: the coordinator re-reads a committed vendor outcome after a
// post-publication error, so revisions, mode and
// each vendor's status, counts, dataChanged, dirty ranges and source impact are
// copied through untouched and verified before anything is written.
//
// The work is batched and resumable: each batch commits on its own and a compacted
// row drops below the cap, so an interrupted run simply continues where it stopped.
import path from "node:path";
import { Database } from "../../src/db/sqlite";
import { resolveDbPath } from "../../src/db";
import { SYNC_RUN_RESULT_MAX_BYTES, boundedSyncRunResult } from "../../src/sync/store";
import type { SyncRunResult } from "../../src/sync/contracts";

export const DEFAULT_MIN_AGE_DAYS = 7;
export const DEFAULT_BATCH_ROWS = 50;

export interface CompactionOptions {
  maxBytes?: number;
  /** Include finished runs younger than the age floor. */
  all?: boolean;
  minAgeDays?: number;
  batchRows?: number;
  apply?: boolean;
  now?: Date;
}

export interface CompactionReport {
  candidates: number;
  compacted: number;
  bytesBefore: number;
  bytesAfter: number;
  storedBytesBefore: number;
  storedBytesAfter: number;
  applied: boolean;
}

interface CandidateRow {
  run_id: string;
  bytes: number;
}

/** Every field the recovery and the run store read back must survive untouched. */
export function preservesEvidence(before: SyncRunResult, after: SyncRunResult): boolean {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const runKeys = ["runId", "trigger", "scope", "mode", "status", "startedAt", "finishedAt", "ownerPid", "ownerProcessStart",
    "beforeRevisions", "afterRevisions", "aggregateWorkRequested", "changedConfigDomains",
    "rebuildGeneration", "rebuildConfiguration", "progress"] as const;
  for (const key of runKeys) if (!same(before[key], after[key])) return false;
  if (before.vendors.length !== after.vendors.length) return false;
  const vendorKeys = ["vendor", "status", "processedInputs", "skippedInputs", "writtenRows",
    "sourceImpact", "dirtyRange", "dirtyRanges", "dataChanged", "startedAt", "finishedAt"] as const;
  return before.vendors.every((vendor, index) =>
    vendorKeys.every((key) => same(vendor[key], after.vendors[index]![key])));
}

function storedBytes(sqlite: Database): number {
  const row = sqlite.query("SELECT COALESCE(sum(length(result_json)), 0) AS bytes FROM sync_runs").get() as { bytes: number };
  return row.bytes;
}

export function compactSyncRuns(sqlite: Database, options: CompactionOptions = {}): CompactionReport {
  const maxBytes = options.maxBytes ?? SYNC_RUN_RESULT_MAX_BYTES;
  const batchRows = options.batchRows ?? DEFAULT_BATCH_ROWS;
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const floor = new Date(now.getTime() - (options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS) * 86_400_000).toISOString();
  const report: CompactionReport = {
    candidates: 0, compacted: 0, bytesBefore: 0, bytesAfter: 0,
    storedBytesBefore: storedBytes(sqlite), storedBytesAfter: 0, applied: apply,
  };
  // A running run is still being written by its owner and is never compacted.
  const select = sqlite.query(
    `SELECT run_id, length(result_json) AS bytes FROM sync_runs
      WHERE run_id > ? AND result_json IS NOT NULL AND length(result_json) > ?
        AND status <> 'running' AND finished_at IS NOT NULL
        ${options.all === true ? "" : "AND finished_at < ?"}
      ORDER BY run_id LIMIT ?`
  );
  const read = sqlite.query("SELECT result_json FROM sync_runs WHERE run_id = ?");
  // A read-only connection must not prepare a write.
  const update = apply ? sqlite.query("UPDATE sync_runs SET result_json = ? WHERE run_id = ?") : null;
  let cursor = "";
  for (;;) {
    const batch = (options.all === true
      ? select.all(cursor, maxBytes, batchRows)
      : select.all(cursor, maxBytes, floor, batchRows)) as CandidateRow[];
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.run_id;
    const rewritten: Array<{ runId: string; payload: string; before: number }> = [];
    for (const candidate of batch) {
      report.candidates += 1;
      const row = read.get(candidate.run_id) as { result_json: string } | null;
      if (!row) continue;
      let stored: SyncRunResult;
      try {
        stored = JSON.parse(row.result_json) as SyncRunResult;
      } catch {
        // An unparsable payload carries no evidence this tool can preserve.
        continue;
      }
      const bounded = boundedSyncRunResult(stored, maxBytes);
      if (bounded === stored) continue;
      if (!preservesEvidence(stored, bounded)) {
        throw new Error(`Refusing to compact ${candidate.run_id}: evidence fields would change`);
      }
      const payload = JSON.stringify(bounded);
      report.compacted += 1;
      report.bytesBefore += candidate.bytes;
      report.bytesAfter += Buffer.byteLength(payload);
      rewritten.push({ runId: candidate.run_id, payload, before: candidate.bytes });
    }
    if (update && rewritten.length > 0) {
      sqlite.transaction(() => {
        for (const row of rewritten) update.run(row.payload, row.runId);
      }).immediate();
    }
  }
  report.storedBytesAfter = apply ? storedBytes(sqlite) : report.storedBytesBefore;
  return report;
}

function megabytes(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const databasePath = resolveDbPath(value("--db"));
  const apply = args.includes("--apply");
  const days = Number(value("--days") ?? DEFAULT_MIN_AGE_DAYS);
  const maxBytes = Number(value("--max-bytes") ?? SYNC_RUN_RESULT_MAX_BYTES);
  if (!Number.isFinite(days) || days < 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    console.error("Usage: bun scripts/dev/sync-runs-compact.ts [--db <file>] [--days 7] [--all] [--max-bytes 1048576] [--batch 50] [--apply]");
    process.exit(1);
  }
  const sqlite = new Database(databasePath, apply ? { readwrite: true } : { readonly: true });
  try {
    sqlite.exec("PRAGMA busy_timeout=30000");
    const report = compactSyncRuns(sqlite, {
      maxBytes, apply, minAgeDays: days, all: args.includes("--all"),
      batchRows: Number(value("--batch") ?? DEFAULT_BATCH_ROWS),
    });
    console.log(`Database: ${path.resolve(databasePath)}`);
    console.log(`Scope: runs over ${megabytes(maxBytes)}${args.includes("--all") ? ", any finished run" : `, finished more than ${days} day(s) ago`}`);
    console.log(`Oversized records: ${report.compacted} of ${report.candidates} candidate(s)`);
    console.log(`Record payloads: ${megabytes(report.bytesBefore)} before, ${megabytes(report.bytesAfter)} after`);
    console.log(`Stored sync_runs payload: ${megabytes(report.storedBytesBefore)} before, ${megabytes(report.storedBytesAfter)} after`);
    if (!apply) console.log("Dry run. Re-run with --apply to write; the file keeps its size and reuses the freed pages.");
  } finally {
    sqlite.close();
  }
}
