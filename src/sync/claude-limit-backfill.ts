import fs from "node:fs";
import type { Database } from "bun:sqlite";
import { toArchivePhysicalPath } from "../config/paths";
import type { SyncFileQueue } from "./file-queue";

/** The parser that first read text refusals; later parser versions do not make this pass run again. */
const LIMIT_PARSER_VERSION = 5;
export const CLAUDE_LIMIT_TASK = `claude-limit-hits@${LIMIT_PARSER_VERSION}`;
const TASK = CLAUDE_LIMIT_TASK;
const MARKER = Buffer.from('"isApiErrorMessage":true');
/** Bytes read per sync cycle, so the one-time pass never holds a cycle for long. */
export const CLAUDE_LIMIT_BACKFILL_BUDGET = 1024 ** 3;
const PAGE = 500;

export interface ClaudeLimitBackfillStep { scanned: number; bytes: number; revisited: string[]; done: boolean; retry?: { path: string; error: string } }

/**
 * Parser 5 reads older text API refusals that parser 4 skipped. A file indexed by an
 * earlier parser is read again only when its bytes hold such a refusal; for every other file the
 * older bookmark already witnesses everything parser 5 would publish. The pass walks claude_files
 * in path order in budgeted steps and keeps its cursor in the queue's own state, so a restart
 * resumes where it stopped and each machine does it once for its own database.
 */
export function revisitClaudeLimitSources(queue: SyncFileQueue, sqlite: Database, budget = CLAUDE_LIMIT_BACKFILL_BUDGET,
  onProgress?: (scanned: number) => void): ClaudeLimitBackfillStep {
  const state = queue.taskState(TASK);
  const step: ClaudeLimitBackfillStep = { scanned: 0, bytes: 0, revisited: [], done: state === "done" };
  if (step.done) return step;
  let after = state ? (JSON.parse(state) as { after: string }).after : "";
  const page = sqlite.query(`SELECT path FROM claude_files WHERE parser_version < ? AND path > ?
    GROUP BY path ORDER BY path LIMIT ${PAGE}`);
  scan: while (step.bytes < budget) {
    const rows = page.all(LIMIT_PARSER_VERSION, after) as Array<{ path: string }>;
    if (rows.length === 0) { step.done = true; break; }
    for (const row of rows) {
      const file = toArchivePhysicalPath(row.path);
      let bytes: Buffer;
      try { bytes = fs.readFileSync(file); }
      catch (error) {
        // A missing archive file keeps its facts; there is nothing newer to read from it. Any
        // other failure (a busy or not yet downloaded file) stops here and is retried next cycle.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          step.retry = { path: file, error: error instanceof Error ? error.message : String(error) };
          break scan;
        }
        bytes = Buffer.alloc(0);
      }
      after = row.path;
      step.scanned++;
      step.bytes += bytes.length;
      onProgress?.(step.scanned);
      if (bytes.includes(Buffer.from('"quotaLimits"')) || (bytes.includes(MARKER)
        && bytes.includes(Buffer.from('"error":"rate_limit"'))
        && bytes.includes(Buffer.from("You've hit your")))) {
        queue.revisit(file, "claude"); step.revisited.push(file);
      }
      if (step.bytes >= budget) break;
    }
  }
  queue.setTaskState(TASK, step.done ? "done" : JSON.stringify({ after }));
  return step;
}
