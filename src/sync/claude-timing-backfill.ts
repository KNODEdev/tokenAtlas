import fs from "node:fs";
import type { Database } from "../db/sqlite";
import { toArchivePhysicalPath } from "../config/paths";
import { CLAUDE_PARSER_VERSION } from "../ingest/claude";
import { parserUnavailable, type ParsePool } from "../ingest/parse-pool";
import type { NewClaudeEvent } from "../db/schema";

/** Bytes read per sync cycle, so the one-time pass never holds a cycle for long. */
export const CLAUDE_TIMING_BACKFILL_BUDGET = 2 * 1024 ** 3;
/** Files parsed between two writes: each batch is one short write transaction under the write lease. */
const BATCH_FILES = 64;
const BATCH_BYTES = 256 * 1024 ** 2;
/**
 * Rows one write transaction updates: each row also moves its day's change revisions (triggers), about 0.25 ms
 * a row on the 06.10 database copy, so a transaction stays near a quarter of a second.
 */
const ROWS_PER_WRITE = 1000;

/** A file is tried in this many cycles; after that it keeps unknown times until the import reads it again. */
export const CLAUDE_TIMING_ATTEMPTS = 3;
export interface ClaudeTimingBackfillStep {
  files: number; bytes: number; updated: number; skipped: number; done: boolean;
  /** Files that could not be read or parsed this cycle, each with its own error; the others were written. */
  failures: Array<{ path: string; error: string }>;
  /** Files left out after `CLAUDE_TIMING_ATTEMPTS` failed cycles. */
  deferred: number;
  /** The parser was unavailable: the pass stopped there, no file's retries were spent, the next cycle tries again. */
  unavailable?: string;
}
/** Failed attempts per file, kept by the caller (the sync queue's task state) across cycles. */
export interface ClaudeTimingAttempts { count(file: string): number; fail(file: string): void }
interface FileRow { store: string; path: string; size: number; mtime: number }
interface Parsed { file: FileRow; events: Array<Pick<NewClaudeEvent, "store" | "call_id" | "resp_ms">> | null }
type Parser = Pick<ParsePool, "run">;

/**
 * Parser 6 records each Claude call's response time (`resp_ms`). Files an earlier parser read keep their
 * rows: the pass parses them again and writes only `resp_ms` into the rows that file owns (the copy the
 * row keeps, by `path`), then marks the file read by parser 6. The rows keep their ids, so the usage
 * ledger sees changed times only: it updates its facts' times and timed sums and reprices nothing
 * (usage-ledger-producer.ts, `reconcileDay`). A file changed since its last import is left to the
 * ordinary import, which reads it whole with parser 6.
 *
 * Progress is the files' own `parser_version`, so an interrupted pass resumes without a cursor and a
 * file is never applied twice (a file interrupted between its writes is applied again; a time already
 * written is not rewritten). Parsing runs outside the write lease; the writes are short transactions of
 * at most `ROWS_PER_WRITE` rows, each under the lease (`write`), which is free between them.
 *
 * Each file settles alone: one that cannot be read or parsed is reported with its own error and the
 * others of its batch are written. It is tried again in later cycles, at most `CLAUDE_TIMING_ATTEMPTS`
 * times when the caller keeps `attempts`; then it is passed over, so it never holds back the pass. A parser that is
 * unavailable (missing, outdated, gone) is no file's fault: the pass stops for this cycle and spends no retries.
 */
export async function backfillClaudeTiming(sqlite: Database, pool: Parser,
  write: <T>(apply: () => T) => Promise<T>, budget = CLAUDE_TIMING_BACKFILL_BUDGET,
  onProgress?: (files: number) => void, attempts?: ClaudeTimingAttempts): Promise<ClaudeTimingBackfillStep> {
  const step: ClaudeTimingBackfillStep = { files: 0, bytes: 0, updated: 0, skipped: 0, done: false, failures: [], deferred: 0 };
  const page = sqlite.query(`SELECT store, path, size, mtime FROM claude_files WHERE parser_version < ? AND (store > ? OR store = ? AND path > ?)
    ORDER BY store, path LIMIT ${BATCH_FILES}`);
  const failed = (file: FileRow, physical: string, error: unknown) => {
    step.failures.push({ path: physical, error: error instanceof Error ? error.message : String(error) });
    attempts?.fail(file.path);
  };
  let after: [string, string] = ["", ""];
  while (step.bytes < budget) {
    const rows = page.all(CLAUDE_PARSER_VERSION, after[0], after[0], after[1]) as FileRow[];
    if (rows.length === 0) { step.done = true; break; }
    const batch: Array<{ file: FileRow; physical: string; parse: Promise<Parsed> }> = [];
    let bytes = 0;
    for (const file of rows) {
      after = [file.store, file.path];
      if (attempts && attempts.count(file.path) >= CLAUDE_TIMING_ATTEMPTS) { step.deferred++; continue; }
      const physical = toArchivePhysicalPath(file.path);
      let stat: fs.Stats;
      try { stat = fs.statSync(physical); }
      catch (error) {
        // A missing archive file keeps its facts untimed: there is nothing to read again.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") batch.push({ file, physical, parse: Promise.resolve({ file, events: null }) });
        else failed(file, physical, error);
        continue;
      }
      // Changed since its import: the ordinary import reads it with parser 6.
      if (stat.size !== file.size || Math.abs(stat.mtimeMs - file.mtime) >= 1) { step.skipped++; continue; }
      bytes += stat.size;
      batch.push({ file, physical, parse: pool.run("claude", { store: file.store, file: physical }).then(result => ({ file, events: result.events })) });
      if (bytes >= BATCH_BYTES) break;
    }
    const settled = await Promise.allSettled(batch.map(item => item.parse));
    const parsed: Parsed[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") parsed.push(result.value);
      else if (parserUnavailable(result.reason)) step.unavailable ??= result.reason instanceof Error ? result.reason.message : String(result.reason);
      else failed(batch[index]!.file, batch[index]!.physical, result.reason);
    });
    for (const slice of slices(parsed))
      step.updated += await write(() => sqlite.transaction(() => applyTimes(sqlite, slice)).immediate());
    step.files += parsed.length;
    step.bytes += bytes;
    onProgress?.(step.files);
    if (step.unavailable) break;
  }
  return step;
}

/** One write: some timed calls of some files; `last` marks a file whose calls all are in it or an earlier write. */
type Slice = Array<{ file: FileRow; events: NonNullable<Parsed["events"]>; last: boolean }>;
function slices(parsed: Parsed[]): Slice[] {
  const out: Slice[] = [];
  let current: Slice = [], rows = 0;
  for (const { file, events } of parsed) {
    const timed = (events ?? []).filter(event => typeof event.resp_ms === "number" && event.resp_ms > 0);
    for (let offset = 0; offset === 0 || offset < timed.length; offset += ROWS_PER_WRITE) {
      const part = timed.slice(offset, offset + ROWS_PER_WRITE);
      if (rows && rows + part.length > ROWS_PER_WRITE) { out.push(current); current = []; rows = 0; }
      current.push({ file, events: part, last: offset + ROWS_PER_WRITE >= timed.length });
      rows += part.length;
    }
  }
  if (current.length) out.push(current);
  return out;
}

/** Writes times into the rows each file owns; a file whose bookmark moved meanwhile is skipped. */
function applyTimes(sqlite: Database, slice: Slice): number {
  const current = sqlite.query("SELECT size, mtime, parser_version FROM claude_files WHERE store=? AND path=?");
  // RETURNING counts this statement's rows; `changes` would include the fact-day revisions its trigger writes.
  const update = sqlite.query("UPDATE claude_events SET resp_ms=?1 WHERE store=?2 AND call_id=?3 AND path=?4 AND resp_ms IS NOT ?1 RETURNING 1");
  const done = sqlite.query("UPDATE claude_files SET parser_version=? WHERE store=? AND path=?");
  let updated = 0;
  for (const { file, events, last } of slice) {
    const now = current.get(file.store, file.path) as { size: number; mtime: number; parser_version: number } | null;
    if (!now || now.parser_version >= CLAUDE_PARSER_VERSION || now.size !== file.size || now.mtime !== file.mtime) continue;
    for (const event of events) updated += update.all(event.resp_ms!, event.store, event.call_id, file.path).length;
    if (last) done.run(CLAUDE_PARSER_VERSION, file.store, file.path);
  }
  return updated;
}
