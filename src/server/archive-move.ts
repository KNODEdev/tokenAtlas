import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config/paths";
import { locationContains } from "../config/archive-location";
import { resolveLocalStateRootBase } from "../config/archive-locator";
import { ensureArchiveIdentity } from "../sync/archive-inventory";
import { readArchiveRelocation, startArchiveRelocation, type ArchiveRelocationState } from "../sync/archive-relocation";
import type { ArchiveMoveResult, ArchiveMoveStatus } from "../shared/archive-move";

/**
 * Settings → "Move archive": the relocation engine (`src/sync/archive-relocation*`) copies and verifies
 * in a worker while the app keeps running; the fenced switch runs in the supervisor between two server
 * processes, as a database move does. The old folder stays untouched as a recovery copy.
 */
const POINTER_FILE = "archive-move.json";
const RETRY_MS = 5000;

export function archiveMoveStateDirectory(database: string): string {
  return path.join(path.dirname(path.resolve(database)), "archive-relocations");
}

function readPointer(stateDirectory: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDirectory, POINTER_FILE), "utf8")) as { jobId?: unknown };
    return typeof value.jobId === "string" ? value.jobId : null;
  } catch { return null; }
}
function writePointer(stateDirectory: string, jobId: string | null): void {
  const file = path.join(stateDirectory, POINTER_FILE);
  if (jobId === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ jobId }) + "\n");
}

/** Refuse before any copying what the final switch would refuse after it. */
export function validateArchiveMoveDestination(source: string, destination: string, database: string,
  env: Record<string, string | undefined> = process.env): string {
  if (typeof destination !== "string" || !destination.trim() || /[\r\n\0]/.test(destination) || !path.isAbsolute(destination.trim()))
    throw new Error("Choose the full path of the new archive folder. / Wybierz pełną ścieżkę nowego folderu archiwum.");
  const target = path.resolve(destination.trim());
  if (locationContains(source, target) || locationContains(target, source))
    throw new Error("The new folder must be outside the current archive. / Nowy folder musi leżeć poza obecnym archiwum.");
  if (locationContains(target, database) || locationContains(target, resolveLocalStateRootBase(env)))
    throw new Error("The database and local state must stay outside the archive. / Baza i stan lokalny muszą zostać poza archiwum.");
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length > 0))
    throw new Error("Choose an empty or new folder. / Wybierz pusty albo nowy folder.");
  return target;
}

export function createArchiveMove(options: {
  archiveRoot: string;
  database: string;
  /** Ask the supervisor to switch between processes; throws while sync or recalculation is busy. */
  activate?: (jobId: string, stateDirectory: string) => void;
  previousResult?: ArchiveMoveResult | null;
}) {
  const stateDirectory = archiveMoveStateDirectory(options.database);
  let worker: Bun.Subprocess<"ignore", "ignore", "pipe"> | null = null;
  let workerError: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let result = options.previousResult ?? null;

  const read = (jobId: string): ArchiveRelocationState | null => {
    try { return readArchiveRelocation(stateDirectory, jobId); } catch { return null; }
  };
  const requestSwitch = (jobId: string) => {
    if (closed || !options.activate) return;
    try { options.activate(jobId, stateDirectory); }
    catch (error) {
      // Sync or recalculation is running; the switch waits for it rather than interrupting it.
      workerError = error instanceof Error ? error.message : String(error);
      retry = setTimeout(() => { retry = null; requestSwitch(jobId); }, RETRY_MS);
    }
  };
  const copy = (jobId: string) => {
    if (worker || closed) return;
    workerError = null;
    const script = path.join(REPO_ROOT, "scripts", "archive-relocation.ts");
    const next = Bun.spawn([process.execPath, script, "run", "--job", jobId, "--state-dir", stateDirectory],
      { cwd: REPO_ROOT, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    worker = next;
    void Promise.all([next.exited, new Response(next.stderr).text()]).then(([code, stderr]) => {
      if (worker === next) worker = null;
      if (closed) return;
      if (code !== 0) { workerError = stderr.trim().split(/\r?\n/).pop() || `Copy stopped (${code})`; return; }
      if (read(jobId)?.phase === "ready-to-switch") requestSwitch(jobId);
    });
  };
  const resume = () => {
    const jobId = readPointer(stateDirectory);
    if (!jobId) return;
    const state = read(jobId);
    if (!state || state.phase === "activated") { writePointer(stateDirectory, null); return; }
    // An unfinished switch is the supervisor's to repeat; it reported the failure in `result`.
    if (state.phase === "activating") return;
    if (result?.jobId === jobId && result.error) return;
    if (state.phase === "ready-to-switch") requestSwitch(jobId);
    else copy(jobId);
  };
  return {
    start(destination: string): ArchiveMoveStatus {
      if (worker || retry) throw new Error("The archive is already being moved. / Archiwum jest już przenoszone.");
      const target = validateArchiveMoveDestination(options.archiveRoot, destination, options.database);
      // Archives from before identities existed get one now; relocation follows that identity.
      ensureArchiveIdentity(options.archiveRoot);
      // The same destination resumes its job (a failed switch included); another one starts afresh.
      const state = startArchiveRelocation(options.archiveRoot, target, { stateDirectory });
      writePointer(stateDirectory, state.jobId);
      result = null;
      copy(state.jobId);
      return this.status();
    },
    status(): ArchiveMoveStatus {
      const jobId = readPointer(stateDirectory);
      const state = jobId ? read(jobId) : null;
      const done = (entry: ArchiveRelocationState["entries"][number]) => entry.status === "copied" || entry.status === "verified";
      const failure = !state ? null
        : result?.jobId === state.jobId && result.error ? result.error
        : !worker && !retry && workerError ? workerError : null;
      return {
        archive: options.archiveRoot,
        result,
        job: state ? {
          jobId: state.jobId, destination: state.destinationRoot, phase: failure ? "failed" : state.phase,
          files: state.entries.length, copiedFiles: state.entries.filter(done).length,
          bytes: state.entries.reduce((sum, entry) => sum + entry.bytes, 0),
          copiedBytes: state.entries.filter(done).reduce((sum, entry) => sum + entry.bytes, 0),
          error: failure,
        } : null,
      };
    },
    resume,
    async close() {
      closed = true;
      if (retry) clearTimeout(retry);
      const active = worker; worker = null;
      if (active) { active.kill(); await active.exited; }
    },
  };
}
export type ArchiveMove = ReturnType<typeof createArchiveMove>;
