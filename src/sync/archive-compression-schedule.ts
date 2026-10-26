import fs from "node:fs";
import path from "node:path";
import { archiveCompressionPendingFiles, runArchiveCompressionTurn, startArchiveCompression,
  type ArchiveCompressionOptions, type ArchiveCompressionTurn } from "./archive-compression";
import { archiveLocalStateDirectory, atomicLocalWrite, readArchiveIdentity, withLocalArchiveLock } from "./archive-local-state";
import { withArchiveWriter } from "./archive-writers";

export const ARCHIVE_COMPRESSION_SCAN_MS = 24 * 3600_000;
export const ARCHIVE_COMPRESSION_RETRY_MS = 15 * 60_000;
interface Schedule {
  schema: 1; archiveId: string; nextScanAt: number;
  jobs: Array<{ jobId: string; retryAt: number }>;
}
export interface ScheduledArchiveCompressionTurn { nextWakeAt: number; scanned: boolean; turn?: ArchiveCompressionTurn }
const jobPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validTime = (time: number) => Number.isSafeInteger(time) && time >= 0;

/** File-only maintenance, called from its own worker, never from an HTTP read or the DB writer. */
export function runScheduledArchiveCompression(options: ArchiveCompressionOptions, now = Date.now()): ScheduledArchiveCompressionTurn {
  if (!validTime(now)) throw new Error("Invalid automatic compression time");
  const directory = path.join(archiveLocalStateDirectory(options.archiveRoot, options), "compression");
  return withArchiveWriter(options.archiveRoot, () => withLocalArchiveLock(path.join(directory, "schedule.lock"), () => {
    const file = path.join(directory, "schedule.json"), archiveId = readArchiveIdentity(options.archiveRoot);
    let state: Schedule;
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      state = { schema: 1, archiveId, nextScanAt: 0, jobs: [] };
    }
    if (!state || state.schema !== 1 || state.archiveId !== archiveId || !validTime(state.nextScanAt)
      || !Array.isArray(state.jobs) || state.jobs.some(job => !job || !jobPattern.test(job.jobId) || !validTime(job.retryAt))
      || new Set(state.jobs.map(job => job.jobId)).size !== state.jobs.length)
      throw new Error("Invalid automatic compression checkpoint");
    let scanned = false;
    if (now >= state.nextScanAt) {
      const exclude = new Set(state.jobs.flatMap(job => archiveCompressionPendingFiles(options, job.jobId)));
      const job = startArchiveCompression(options, { now, exclude });
      if (job.total) state.jobs.push({ jobId: job.jobId, retryAt: now });
      state.nextScanAt = now + ARCHIVE_COMPRESSION_SCAN_MS; scanned = true;
      // Save ownership before executing a file: restart resumes the same job.
      atomicLocalWrite(file, JSON.stringify(state));
    }
    const index = state.jobs.findIndex(job => job.retryAt <= now);
    let turn: ArchiveCompressionTurn | undefined;
    if (index >= 0) {
      const job = state.jobs[index]!;
      turn = runArchiveCompressionTurn(options, job.jobId, { maxFiles: 1, budgetMs: 250 });
      state.jobs.splice(index, 1);
      if (turn.status !== "complete") state.jobs.push({ jobId: job.jobId,
        retryAt: now + (turn.status === "waiting" ? ARCHIVE_COMPRESSION_RETRY_MS : 1000) });
      atomicLocalWrite(file, JSON.stringify(state));
    }
    return { scanned, turn, nextWakeAt: Math.min(state.nextScanAt, ...state.jobs.map(job => job.retryAt)) };
  }));
}
