import { realArchiveLocation, readArchiveIdentity } from "../config/archive-location";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pinCanonicalArchiveRoot } from "../config/archive-paths";
import type { ArchiveRelocationState, ArchiveRelocationStepOptions, ArchiveRelocationWriterFence } from "./archive-relocation-contracts";
import { assertSeparate, externalStateDirectory, samePath, inside, ensureRootStillMatches } from "./archive-relocation-paths";
import { jobPath, validateState, readJson, STATE_SCHEMA, writeState } from "./archive-relocation-state";
import path from "node:path";
import { acquireJobLock, releaseJobLock } from "./archive-relocation-lock";
import { ensureOwnedTarget, scanTree, reconcile, validateDestination } from "./archive-relocation-target";
import { budgetAllows, stableSourceFile, hashFileBounded, destinationBookmarkMatches, atomicCopyBounded } from "./archive-relocation-copy";
import type { ArchiveWriterFence } from "./archive-writers";

export function startArchiveRelocation(source: string, destination: string, options: {
  stateDirectory: string;
  jobId?: string;
}): ArchiveRelocationState {
  const sourceRoot = realArchiveLocation(source);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new Error("Archive source is not a directory");
  const destinationRoot = realArchiveLocation(destination);
  assertSeparate(sourceRoot, destinationRoot);
  const stateDirectory = externalStateDirectory(options.stateDirectory, sourceRoot, destinationRoot);
  fs.mkdirSync(stateDirectory, { recursive: true });
  const archiveId = readArchiveIdentity(sourceRoot);
  if (!archiveId) throw new Error("Archive source has no durable identity");
  const jobId = options.jobId ?? randomUUID();
  const file = jobPath(stateDirectory, jobId);
  if (fs.existsSync(file)) {
    const existing = validateState(readJson(file));
    if (existing.jobId !== jobId || !samePath(existing.sourceRoot, sourceRoot) || !samePath(existing.destinationRoot, destinationRoot) || existing.archiveId !== archiveId) {
      throw new Error("Relocation job arguments do not match durable state");
    }
    return existing;
  }
  if (fs.existsSync(destinationRoot)) {
    if (!fs.statSync(destinationRoot).isDirectory()) throw new Error("Relocation target is not a directory");
    if (fs.readdirSync(destinationRoot).length) throw new Error("Relocation target must be empty or owned by this operation");
  }
  const now = new Date().toISOString();
  pinCanonicalArchiveRoot(sourceRoot);
  const state: ArchiveRelocationState = {
    schema: STATE_SCHEMA,
    jobId,
    archiveId,
    sourceRoot,
    destinationRoot,
    phase: "copying",
    directories: [],
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
  writeState(file, state);
  return state;
}

/**
 * Forget only paths that vanished before any bytes were published. The supplied
 * coordinator must hold a genuine all-writer fence for the complete rescan.
 * Copied evidence is never discarded; restore such a path from the staged copy.
 */
export async function acknowledgeUncopiedRelocationDisappearance(
  jobId: string,
  options: ArchiveRelocationStepOptions & { writerFence: ArchiveRelocationWriterFence },
): Promise<ArchiveRelocationState> {
  const stateFile = jobPath(path.resolve(options.stateDirectory), jobId);
  const lockFile = `${stateFile}.lock`;
  const lock = acquireJobLock(lockFile);
  let active: ArchiveRelocationState | null = null;
  try {
    return await options.writerFence.runWhileAllWritersFenced(async () => {
      active = validateState(readJson(stateFile));
      if (active.jobId !== jobId) throw new Error("Corrupt archive relocation state: job ID does not match its filename");
      externalStateDirectory(options.stateDirectory, active.sourceRoot, active.destinationRoot);
      ensureOwnedTarget(active);
      const scan = await scanTree(active.sourceRoot);
      const files = new Set(scan.files.map(file => file.relative));
      const missingEntries = active.entries.filter(entry => !files.has(entry.relative));
      for (const entry of missingEntries) {
        const staged = inside(active.destinationRoot, entry.relative);
        if (entry.digest !== null || fs.existsSync(staged)) {
          throw new Error(`Finalized relocation evidence is retained for '${entry.relative}'; restore it to the source before retrying`);
        }
      }
      active.entries = active.entries.filter(entry => files.has(entry.relative));
      const directories = new Set(scan.directories);
      for (const directory of [...active.directories].sort((a, b) => b.length - a.length)) {
        if (directories.has(directory)) continue;
        const staged = inside(active.destinationRoot, directory);
        if (fs.existsSync(staged)) {
          if (fs.readdirSync(staged).length) throw new Error(`Staged directory is not empty: ${directory}`);
          fs.rmdirSync(staged);
        }
      }
      active.directories = active.directories.filter(directory => directories.has(directory));
      reconcile(active, scan);
      active.phase = "copying";
      delete active.readyAt;
      delete active.lastError;
      writeState(stateFile, active);
      return active;
    });
  } catch (error) {
    // TypeScript does not track assignments made inside the awaited fence callback.
    const failed = active as ArchiveRelocationState | null;
    if (failed) {
      failed.lastError = error instanceof Error ? error.message : String(error);
      try { writeState(stateFile, failed); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    releaseJobLock(lock, lockFile);
  }
}

export async function advanceArchiveRelocation(jobId: string, options: ArchiveRelocationStepOptions): Promise<ArchiveRelocationState> {
  const stateFile = jobPath(path.resolve(options.stateDirectory), jobId);
  const lockFile = `${stateFile}.lock`;
  const lock = acquireJobLock(lockFile);
  let active: ArchiveRelocationState | null = null;
  try {
    active = validateState(readJson(stateFile));
    if (active.jobId !== jobId) throw new Error("Corrupt archive relocation state: job ID does not match its filename");
    const state = active;
    const save = () => writeState(stateFile, state);
    if (state.phase === "activated") return state;
    if (state.phase === "activating") throw new Error("Archive activation is in progress; resume it with the explicit activate command");
    externalStateDirectory(options.stateDirectory, state.sourceRoot, state.destinationRoot);
    ensureOwnedTarget(state);
    if (readArchiveIdentity(state.sourceRoot) !== state.archiveId) throw new Error("Archive identity changed during relocation");

    if (state.phase === "ready-to-switch") {
      state.phase = "verifying";
      for (const entry of state.entries) entry.status = "copied";
      delete state.readyAt;
      save();
    }

    const scan = await scanTree(state.sourceRoot);
    reconcile(state, scan);
    save();
    await validateDestination(state);

    const maxFiles = Math.max(1, options.maxFiles ?? 32);
    const maxBytes = Math.max(1, options.maxBytes ?? 64 * 1024 * 1024);
    let processed = 0;
    let processedBytes = 0;

    if (state.phase === "copying") {
      for (const directory of state.directories) fs.mkdirSync(inside(state.destinationRoot, directory), { recursive: true });
      for (const entry of state.entries) {
        if (entry.status === "copied" || entry.status === "verified") continue;
        if (!budgetAllows(processed, processedBytes, entry.bytes, maxFiles, maxBytes)) break;
        const sourceFile = stableSourceFile(state, entry);
        const destinationFile = inside(state.destinationRoot, entry.relative);
        if (entry.status === "copying" && entry.digest && fs.existsSync(destinationFile)) {
          const existing = await hashFileBounded(destinationFile);
          if (existing.bytes === entry.bytes && existing.digest === entry.digest &&
              await destinationBookmarkMatches(destinationFile, entry)) {
            entry.status = "copied";
            save();
            processed++;
            processedBytes += entry.bytes;
            continue;
          }
        }
        const observed = await hashFileBounded(sourceFile);
        stableSourceFile(state, entry);
        if (observed.bytes !== entry.bytes) throw new Error(`Archive source changed while hashing: ${entry.relative}`);
        entry.digest = observed.digest;
        entry.status = "copying";
        save();
        await atomicCopyBounded(sourceFile, destinationFile, observed.digest, entry.bytes,
          entry.mode, entry.modifiedAtMs);
        stableSourceFile(state, entry);
        const copied = await hashFileBounded(destinationFile);
        if (copied.bytes !== entry.bytes || copied.digest !== observed.digest) {
          throw new Error(`Relocation copy verification failed: ${entry.relative}`);
        }
        entry.status = "copied";
        save();
        processed++;
        processedBytes += entry.bytes;
      }
      if (state.entries.every(entry => entry.status === "copied" || entry.status === "verified")) {
        state.phase = "verifying";
        save();
      }
      return state;
    }

    for (const entry of state.entries) {
      if (entry.status === "verified") continue;
      if (!budgetAllows(processed, processedBytes, entry.bytes, maxFiles, maxBytes)) break;
      const sourceFile = stableSourceFile(state, entry);
      const sourceDigest = await hashFileBounded(sourceFile);
      stableSourceFile(state, entry);
      const destinationFile = inside(state.destinationRoot, entry.relative);
      const destinationExists = fs.existsSync(destinationFile);
      const destinationDigest = destinationExists
        ? await hashFileBounded(destinationFile)
        : null;
      const destinationBookmark = destinationExists && await destinationBookmarkMatches(destinationFile, entry);
      if (sourceDigest.bytes !== entry.bytes || sourceDigest.digest !== entry.digest ||
          !destinationDigest || destinationDigest.bytes !== entry.bytes || destinationDigest.digest !== entry.digest ||
          !destinationBookmark) {
        entry.digest = null;
        entry.status = "pending";
        state.phase = "copying";
        delete state.readyAt;
        save();
        return state;
      }
      entry.status = "verified";
      save();
      processed++;
      processedBytes += entry.bytes;
    }
    if (!state.entries.every(entry => entry.status === "verified")) return state;

    const finalScan = await scanTree(state.sourceRoot);
    if (reconcile(state, finalScan)) {
      save();
      return state;
    }
    await validateDestination(state);
    if (readArchiveIdentity(state.destinationRoot) !== state.archiveId) {
      throw new Error("Relocated archive identity was not preserved");
    }
    state.phase = "ready-to-switch";
    state.readyAt = new Date().toISOString();
    delete state.lastError;
    save();
    return state;
  } catch (error) {
    if (active) {
      active.lastError = error instanceof Error ? error.message : String(error);
      try { writeState(stateFile, active); } catch { /* preserve the original relocation failure */ }
    }
    throw error;
  } finally {
    releaseJobLock(lock, lockFile);
  }
}

export async function finalCopyAndVerify(state: ArchiveRelocationState, stateFile: string, fence: ArchiveWriterFence): Promise<void> {
  ensureRootStillMatches(state.sourceRoot);
  ensureRootStillMatches(state.destinationRoot);
  ensureOwnedTarget(state);
  if (readArchiveIdentity(state.sourceRoot) !== state.archiveId || readArchiveIdentity(state.destinationRoot) !== state.archiveId) {
    throw new Error("Archive identity changed before activation");
  }
  reconcile(state, await scanTree(state.sourceRoot));
  state.phase = "activating";
  for (const directory of state.directories) fs.mkdirSync(inside(state.destinationRoot, directory), { recursive: true });
  await validateDestination(state, fence);
  for (const entry of state.entries) {
    const sourceFile = stableSourceFile(state, entry);
    const source = await hashFileBounded(sourceFile);
    stableSourceFile(state, entry);
    if (source.bytes !== entry.bytes) throw new Error(`Archive source changed during final activation copy: ${entry.relative}`);
    entry.digest = source.digest;
    const destinationFile = inside(state.destinationRoot, entry.relative);
    let matches = false;
    if (fs.existsSync(destinationFile) && await destinationBookmarkMatches(destinationFile, entry)) {
      const destination = await hashFileBounded(destinationFile);
      matches = destination.bytes === entry.bytes && destination.digest === source.digest;
    }
    if (!matches) {
      entry.status = "copying";
      writeState(stateFile, state);
      await atomicCopyBounded(sourceFile, destinationFile, source.digest, entry.bytes, entry.mode, entry.modifiedAtMs);
    }
    const verified = await hashFileBounded(destinationFile);
    stableSourceFile(state, entry);
    if (verified.bytes !== entry.bytes || verified.digest !== source.digest ||
        !await destinationBookmarkMatches(destinationFile, entry)) {
      throw new Error(`Final relocation verification failed: ${entry.relative}`);
    }
    entry.status = "verified";
    writeState(stateFile, state);
  }
  const changed = reconcile(state, await scanTree(state.sourceRoot));
  state.phase = "activating";
  if (changed) throw new Error("Archive changed after final fenced copy");
  await validateDestination(state, fence);
  if (readArchiveIdentity(state.destinationRoot) !== state.archiveId) throw new Error("Relocated archive identity was not preserved");
  state.readyAt = new Date().toISOString();
}
