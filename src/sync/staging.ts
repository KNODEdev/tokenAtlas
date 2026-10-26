import fs from "node:fs";
import path from "node:path";

/**
 * Stage databases are scratch copies named `<runId>-<vendor>.sqlite` inside the
 * staging root, where `<vendor>` is a vendor id (`identity` for the retired source-registry
 * clone, still recognized so an old stage is cleaned up). Nothing else in that directory
 * belongs to this module.
 */
const STAGE_ARTIFACT =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([a-z]+)\.sqlite(?:-wal|-shm|-journal|\.progress\.json(?:\.tmp)?)?$/i;

/** A stage without any `sync_runs` record is scratch once no live attempt can still own it. */
export const ORPHAN_STAGE_MS = 24 * 60 * 60 * 1000;

/**
 * A stage file is disposable once its own run has finished, whatever that run's status.
 * Nothing ever reuses an abandoned stage: a new attempt stages under a fresh run id, so
 * a failed or partially successful run's stage is scratch that only occupies disk. A
 * stage whose run left no record is kept until it has aged past the orphan window, so a
 * crashed run's evidence survives a restart that has not yet recorded it.
 */
export function stageRunIsDisposable(
  run: { status: string; finishedAt: string | null } | null,
  modifiedAtMs: number,
  nowMs: number
): boolean {
  if (!run) return nowMs - modifiedAtMs >= ORPHAN_STAGE_MS;
  return run.status !== "running" && run.finishedAt != null;
}

const REMOVE_ATTEMPTS = 3;
const REMOVE_RETRY_MS = 25;

export interface StageCleanupResult {
  removed: string[];
  /** Files that are still on disk; cleanup stays retryable and must stay visible. */
  retained: string[];
}

export function stageArtifacts(stagePath: string): string[] {
  return [stagePath, `${stagePath}-wal`, `${stagePath}-shm`, `${stagePath}-journal`];
}

export function stagePathFor(stagingRoot: string, runId: string, vendor: string): string {
  return path.join(stagingRoot, `${runId}-${vendor}.sqlite`);
}

/**
 * Delete one stage database, its SQLite sidecars and advisory progress. An ingest path that leaves a
 * connection open past its own return keeps the file locked on Windows until the
 * unreachable handle is finalized, so a failed unlink is retried after a forced
 * collection instead of being abandoned.
 */
export function removeStageArtifacts(stagePath: string): StageCleanupResult {
  const removed: string[] = [];
  const retained: string[] = [];
  for (const file of stageArtifacts(stagePath)) {
    let outstanding: unknown;
    for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt++) {
      try {
        fs.unlinkSync(file);
        removed.push(file);
        outstanding = undefined;
        break;
      } catch (error) {
        outstanding = error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          outstanding = undefined;
          break;
        }
        if (attempt === REMOVE_ATTEMPTS) break;
        Bun.gc(true);
        Bun.sleepSync(REMOVE_RETRY_MS);
      }
    }
    if (outstanding !== undefined) retained.push(file);
  }
  return { removed, retained };
}

export interface StageRecoveryResult {
  removed: number;
  retained: number;
  cursor: string | null;
}

/**
 * Bounded sweep of stage artifacts an earlier run could not delete. Storage would
 * otherwise grow without limit, because every run stages under a fresh run id and
 * nothing ever reuses an abandoned file.
 *
 * Only artifacts the caller can prove disposable are removed. Unknown file names,
 * subdirectories, symlinks and the run in progress are kept. The predicate also
 * receives the stage's newest modification time, so a caller can age out an
 * orphan whose run left no record at all.
 */
export function recoverDisposableStages(
  stagingRoot: string,
  disposable: (runId: string, vendor: string, modifiedAtMs: number) => boolean,
  limit = 500,
  after: string | null = null
): StageRecoveryResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, retained: 0, cursor: after };
  }
  const stages = new Map<string, { runId: string; vendor: string; files: string[]; modifiedAtMs: number }>();
  for (const entry of entries) {
    // Regular files only: a subdirectory or a link that
    // could point outside the staging root is never a stage artifact.
    if (!entry.isFile()) continue;
    const match = STAGE_ARTIFACT.exec(entry.name);
    if (!match) continue;
    const runId = match[1]!, vendor = match[2]!;
    const key = `${runId}-${vendor}`;
    const stage = stages.get(key) ?? { runId, vendor, files: [], modifiedAtMs: 0 };
    stage.files.push(entry.name);
    // An unreadable stat leaves the stage looking new, so ageing can only keep it.
    try { stage.modifiedAtMs = Math.max(stage.modifiedAtMs, fs.statSync(path.join(stagingRoot, entry.name)).mtimeMs); }
    catch { stage.modifiedAtMs = Math.max(stage.modifiedAtMs, Date.now()); }
    stages.set(key, stage);
  }
  const keys = [...stages.keys()].sort();
  const next = after === null ? 0 : keys.findIndex(key => key > after);
  const start = next < 0 ? 0 : next;
  const result: StageRecoveryResult = { removed: 0, retained: 0, cursor: after };
  // Resume past retained groups too: failures at the front must not starve later
  // successful runs. The caller persists the cursor across coordinator restarts.
  for (let offset = 0; offset < Math.min(keys.length, limit); offset++) {
    const key = keys[(start + offset) % keys.length]!;
    const stage = stages.get(key)!;
    const verdict = disposable(stage.runId, stage.vendor, stage.modifiedAtMs);
    result.cursor = key;
    if (!verdict) {
      result.retained += stage.files.length;
      continue;
    }
    for (const file of stage.files) {
      try {
        fs.unlinkSync(path.join(stagingRoot, file));
        result.removed += 1;
      } catch (error) {
        // A concurrent sweep may have won the race; anything else stays for a later run.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") result.removed += 1;
        else result.retained += 1;
      }
    }
  }
  return result;
}
