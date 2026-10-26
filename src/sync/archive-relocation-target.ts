import { ARCHIVE_RELOCATION_OWNER_FILE, ARCHIVE_WRITERS_DIRECTORY } from "./archive-writers";
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import type { ScanResult, ScannedFile, ArchiveRelocationState } from "./archive-relocation-contracts";
import { safeRelative, inside, samePath, stamp, ensureRootStillMatches, assertSeparate } from "./archive-relocation-paths";
import { randomUUID } from "node:crypto";
import { readJson } from "./archive-relocation-state";
import { UUID } from "./archive-relocation-contracts";
import type { ArchiveWriterFence } from "./archive-writers";

export const OWNER_FILE = ARCHIVE_RELOCATION_OWNER_FILE;

/**
 * Ignore only artifacts produced by the repository's atomic write/copy contracts:
 * *.tmp-<uuid> and identity-link candidates *.<uuid>.tmp. Unknown lock/temp names remain ordinary evidence.
 */
function knownAtomicTransient(relative: string): boolean {
  const coordination = ARCHIVE_WRITERS_DIRECTORY.split(path.sep).join("/");
  if (relative === coordination || relative.startsWith(`${coordination}/`)) return true;
  const name = path.posix.basename(relative);
  if (/\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(name)) return true;
  if (/\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/i.test(name)) return true;
  return false;
}

export async function scanTree(root: string, ignoreAtomicTransients = true): Promise<ScanResult> {
  const directories: string[] = [];
  const files: ScannedFile[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await fsp.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      safeRelative(relative);
      // A publisher can remove its temp file between readdir and lstat.
      if (ignoreAtomicTransients && knownAtomicTransient(relative)) continue;
      const absolute = inside(root, relative);
      const info = await fsp.lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symlink or reparse-point source is not relocatable: ${relative}`);
      if (info.isDirectory()) {
        directories.push(relative);
        await visit(absolute, relative);
      } else if (info.isFile()) {
        if (!samePath(fs.realpathSync(absolute), absolute)) throw new Error(`Archive path escapes through a link: ${relative}`);
        files.push({
          relative,
          sourceStamp: stamp(info),
          bytes: info.size,
          mode: info.mode,
          modifiedAtMs: info.mtimeMs,
        });
      } else {
        throw new Error(`Unsupported archive entry: ${relative}`);
      }
    }
  };
  await visit(root, "");
  return { directories, files };
}

export function ownerPayload(state: ArchiveRelocationState): string {
  return JSON.stringify({ schema: 1, jobId: state.jobId, archiveId: state.archiveId, sourceRoot: state.sourceRoot });
}

export function claimOwnerExclusively(marker: string, payload: string): void {
  const candidate = `${marker}.${randomUUID()}.claim`;
  const descriptor = fs.openSync(candidate, "wx");
  try {
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    try { fs.linkSync(candidate, marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    fs.unlinkSync(candidate);
  }
}

export function ensureOwnedTarget(state: ArchiveRelocationState): void {
  ensureRootStillMatches(state.sourceRoot);
  assertSeparate(state.sourceRoot, state.destinationRoot);
  if (!fs.existsSync(state.destinationRoot)) fs.mkdirSync(state.destinationRoot, { recursive: true });
  ensureRootStillMatches(state.destinationRoot);
  const marker = path.join(state.destinationRoot, OWNER_FILE);
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(state.destinationRoot).length) {
      throw new Error("Relocation target is occupied and is not owned by this operation");
    }
    claimOwnerExclusively(marker, ownerPayload(state));
  }
  const owner = readJson(marker) as { schema?: number; jobId?: string; archiveId?: string; sourceRoot?: string };
  if (owner.schema !== 1 || owner.jobId !== state.jobId || owner.archiveId !== state.archiveId ||
      !owner.sourceRoot || !samePath(owner.sourceRoot, state.sourceRoot)) {
    throw new Error("Relocation target belongs to another operation");
  }
}

export function reconcile(state: ArchiveRelocationState, scan: ScanResult): boolean {
  const currentDirectories = new Set(scan.directories);
  for (const previous of state.directories) {
    if (!currentDirectories.has(previous)) {
      throw new Error(`Archive directory disappeared during relocation: ${previous}. Restore it and retry, or acknowledge a new scan while all writers are fenced.`);
    }
  }
  const byPath = new Map(state.entries.map(entry => [entry.relative, entry]));
  const currentFiles = new Set(scan.files.map(file => file.relative));
  for (const entry of state.entries) {
    if (!currentFiles.has(entry.relative)) {
      throw new Error(`Archive file disappeared during relocation: ${entry.relative}. Restore it and retry, or acknowledge an uncopied disappearance while all writers are fenced.`);
    }
  }
  let changed = false;
  for (const file of scan.files) {
    if (file.relative === OWNER_FILE) throw new Error(`${OWNER_FILE} is reserved for relocation ownership`);
    const entry = byPath.get(file.relative);
    if (!entry) {
      state.entries.push({ ...file, digest: null, status: "pending" });
      changed = true;
    } else if (entry.sourceStamp !== file.sourceStamp) {
      Object.assign(entry, file, { digest: null, status: "pending" as const });
      changed = true;
    }
  }
  for (const directory of scan.directories) {
    if (!state.directories.includes(directory)) {
      state.directories.push(directory);
      changed = true;
    }
  }
  if (changed) {
    state.phase = "copying";
    delete state.readyAt;
  }
  return changed;
}

function ownedTemporary(relative: string, allowed: Set<string>): boolean {
  const index = relative.lastIndexOf(".tmp-");
  if (index < 0) return false;
  const base = relative.slice(0, index);
  const suffix = relative.slice(index + 5);
  return (base === OWNER_FILE || allowed.has(base)) && UUID.test(suffix);
}

export async function validateDestination(state: ArchiveRelocationState, fence?: ArchiveWriterFence): Promise<void> {
  if (fence && (fence.jobId !== state.jobId || !samePath(fence.root, state.destinationRoot))) {
    throw new Error("Destination fence belongs to another relocation");
  }
  fence?.assertDrained();
  const scan = await scanTree(state.destinationRoot, false);
  fence?.assertDrained();
  const coordination = ARCHIVE_WRITERS_DIRECTORY.split(path.sep).join("/");
  const guarded = (relative: string) => !!fence && (relative === coordination || relative.startsWith(`${coordination}/`));
  const allowedFiles = new Set(state.entries.map(entry => entry.relative));
  const allowedDirectories = new Set(state.directories);
  // Releasing a writer fence can leave its empty coordination directory behind.
  // Files within it still require an owned fence or are rejected below.
  allowedDirectories.add(coordination);
  for (const file of scan.files) {
    if (file.relative === OWNER_FILE || allowedFiles.has(file.relative) || guarded(file.relative)) continue;
    if (ownedTemporary(file.relative, allowedFiles)) {
      fs.unlinkSync(inside(state.destinationRoot, file.relative));
      continue;
    }
    throw new Error(`Foreign data found in relocation target: ${file.relative}`);
  }
  for (const directory of scan.directories) {
    if (!allowedDirectories.has(directory) && !guarded(directory)) throw new Error(`Foreign directory found in relocation target: ${directory}`);
  }
}
