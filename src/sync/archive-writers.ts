import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { allocateLocalIdentity, readLocalMachineId } from "../config/local-identity";
import { resolveArchiveRootFromEnv } from "../config/path-environment";

/** Coordination files are local protocol state, never archived source evidence. */
export const ARCHIVE_WRITERS_DIRECTORY = path.join(".archive-inventory", "writers");
export const ARCHIVE_RELOCATION_OWNER_FILE = ".archive-relocation-owner.json";
const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Explicit producer startup; ordinary guards only read this local identity. */
export function initializeArchiveWriterIdentity(): void {
  allocateLocalIdentity("tokenatlas-archive-writer", "archive-writer", {
    machine: os.hostname(), profile: "archive-writer",
  });
}

interface Owner { schema: 1; token: string; host: string; pid: number; machineId?: string }
interface Barrier extends Owner { jobId: string; phase: "fenced" | "relocated"; destination?: string }
export class ArchiveWritesPausedError extends Error {
  constructor(readonly archiveRoot: string, readonly jobId: string, readonly destination?: string) {
    super(destination
      ? `Archive moved to '${destination}'; restart with its current location before writing to '${archiveRoot}'`
      : `Archive writes are paused for relocation '${jobId}': ${archiveRoot}`);
    this.name = "ArchiveWritesPausedError";
  }
}

const machineUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function canonicalRoot(root: string): string {
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Archive root is not a directory: ${root}`);
  return resolved;
}
function rootKey(root: string): string {
  const resolved = canonicalRoot(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported = ["EINVAL", "ENOTSUP", "EISDIR"].includes(String(code)) ||
      (process.platform === "win32" && ["EACCES", "EPERM"].includes(String(code)));
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
function archiveIdentity(root: string): string {
  const file = path.join(root, ".archive-inventory", "identity.json");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: unknown; archiveId?: unknown };
  if (value.schema !== 1 || typeof value.archiveId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.archiveId)) {
    throw new Error(`Invalid archive identity: ${file}`);
  }
  return value.archiveId;
}
function owner(): Owner {
  const machineId = readLocalMachineId();
  return {
    schema: 1,
    token: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    ...(machineId ? { machineId } : {}),
  };
}
function read<T extends Owner>(file: string, barrier = false): T | null {
  let value: T;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (missing(error)) return null; throw error; }
  if (!value || value.schema !== 1 || !uuid.test(value.token) || typeof value.host !== "string" || !value.host ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      (value.machineId !== undefined && (typeof value.machineId !== "string" || !machineUuid.test(value.machineId)))) {
    throw new Error(`Invalid archive writer record: ${file}`);
  }
  if (barrier) {
    const gate = value as unknown as Barrier;
    if (!uuid.test(gate.jobId) || !["fenced", "relocated"].includes(gate.phase) ||
        (gate.phase === "relocated" && (typeof gate.destination !== "string" || !path.isAbsolute(gate.destination)))) {
      throw new Error(`Invalid archive write barrier: ${file}`);
    }
  }
  return value;
}
function deadLocal(record: Owner, localMachineId: string | null = readLocalMachineId()): boolean {
  // Legacy/unknown owners and owners from another durable machine instance are
  // never reclaimed, even when their hostname happens to match this machine.
  if (!localMachineId || !record.machineId || record.machineId !== localMachineId) return false;
  try { process.kill(record.pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
/** Walks the immutable recovery chain; `files` is root-first and ends at `gate`. */
function currentBarrier(directory: string): { files: string[]; gate: Barrier } | null {
  const files = [path.join(directory, "barrier.json")];
  let gate = read<Barrier>(files[0]!, true);
  if (!gate) return null;
  const tokens = new Set<string>();
  while (true) {
    if (tokens.has(gate.token) || tokens.size >= 10_000) throw new Error("Invalid archive fence recovery chain");
    tokens.add(gate.token);
    const nextFile = path.join(directory, `resume-${gate.token}.json`);
    const next = read<Barrier>(nextFile, true);
    if (!next) return { files, gate };
    if (gate.phase !== "fenced" || next.jobId !== gate.jobId) throw new Error("Archive fence recovery identity changed");
    files.push(nextFile);
    gate = next;
  }
}
function publishExclusive(file: string, value: Owner): void {
  const candidate = `${file}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const descriptor = fs.openSync(candidate, "wx");
    try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.linkSync(candidate, file);
    published = true;
    syncDirectory(path.dirname(file));
  } finally {
    // The public owner is valid even if Windows temporarily prevents private-link cleanup.
    try { fs.unlinkSync(candidate); } catch (error) { if (!published && !missing(error)) throw error; }
  }
}
function removeOwned(file: string, token: string): void {
  const current = read(file);
  if (!current || current.token !== token) throw new Error(`Archive writer ownership changed: ${file}`);
  fs.unlinkSync(file);
  syncDirectory(path.dirname(file));
}
function assertWritable(root: string, gateFile: string): void {
  if (fs.existsSync(path.join(root, ARCHIVE_RELOCATION_OWNER_FILE))) {
    throw new Error("Relocation destination is staged; activation has not been committed");
  }
  const gate = currentBarrier(path.dirname(gateFile))?.gate;
  if (gate) throw new ArchiveWritesPausedError(root, gate.jobId, gate.destination);
}

/** Read-only publication checks admission without a lease; mutations still require withArchiveWriter. */
export function assertArchiveWriteAdmission(root: string): void {
  const physicalRoot = canonicalRoot(root);
  const key = process.platform === "win32" ? physicalRoot.toLowerCase() : physicalRoot;
  if (held.getStore()?.get(key)?.active) return;
  assertWritable(physicalRoot, path.join(physicalRoot, ARCHIVE_WRITERS_DIRECTORY, "barrier.json"));
}

/** Holds a durable lease for the entire write, including nested publication/rollback. */
export function withArchiveWriter<T>(root: string, operation: () => T): T {
  const physicalRoot = canonicalRoot(root);
  const key = process.platform === "win32" ? physicalRoot.toLowerCase() : physicalRoot;
  const inherited = held.getStore();
  if (inherited?.get(key)?.active) return operation();
  const directory = path.join(physicalRoot, ARCHIVE_WRITERS_DIRECTORY);
  const gate = path.join(directory, "barrier.json");
  assertWritable(physicalRoot, gate);
  fs.mkdirSync(directory, { recursive: true });
  const lease = owner();
  const leaseFile = path.join(directory, `${lease.token}.json`);
  publishExclusive(leaseFile, lease);
  const context = { active: true };
  const release = () => { context.active = false; removeOwned(leaseFile, lease.token); };
  let asynchronous = false;
  try {
    // The relocator closes admission before enumerating leases. Either it sees
    // this lease, or this second read rejects the writer before any data changes.
    assertWritable(physicalRoot, gate);
    const result = held.run(new Map([...(inherited ?? []), [key, context]]), operation);
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
      asynchronous = true;
      return Promise.resolve(result).finally(release) as T;
    }
    return result;
  } finally { if (!asynchronous) release(); }
}

/** Explicit file overrides outside an archive keep their existing behavior. */
export function withArchiveFileWriter<T>(file: string, operation: () => T): T {
  const resolvedFile = path.resolve(file);
  let directory = path.dirname(resolvedFile);
  while (true) {
    if (fs.existsSync(path.join(directory, ".archive-inventory", "identity.json")) ||
        fs.existsSync(path.join(directory, ARCHIVE_RELOCATION_OWNER_FILE)) ||
        fs.existsSync(path.join(directory, ARCHIVE_WRITERS_DIRECTORY))) return withArchiveWriter(directory, operation);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const configured = resolveArchiveRootFromEnv(process.env);
  if (pathInside(configured, resolvedFile)) return withArchiveWriter(configured, operation);
  return operation();
}

export interface ArchiveWriterFence {
  root: string;
  jobId: string;
  /** Throws while any live/local or unconfirmed remote writer holds a lease. */
  assertDrained(): void;
  release(): void;
  /** Keep the old root closed permanently after the caller commits the locator. */
  markRelocated(destination: string): void;
}

/**
 * Admission remains closed across a crash. Only the same relocation can reclaim
 * its dead local owner; remote leases/barriers are never expired by wall clock.
 */
export function acquireArchiveWriterFence(root: string, jobId: string): ArchiveWriterFence {
  if (!uuid.test(jobId)) throw new Error("Invalid archive relocation job ID");
  const physicalRoot = canonicalRoot(root);
  const directory = path.join(physicalRoot, ARCHIVE_WRITERS_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const rootFile = path.join(directory, "barrier.json");
  let file = rootFile;
  const previous = currentBarrier(directory)?.gate;
  if (previous) {
    if (previous.phase !== "fenced" || previous.jobId !== jobId || !deadLocal(previous)) {
      throw new ArchiveWritesPausedError(physicalRoot, previous.jobId, previous.destination);
    }
    // Never delete-and-replace a stale owner: competing resumes could delete
    // each other's new lock. Exactly one immutable successor can be linked.
    file = path.join(directory, `resume-${previous.token}.json`);
  }
  const gate: Barrier = { ...owner(), jobId, phase: "fenced" };
  publishExclusive(file, gate);
  // A contender that observed the same dead owner can be delayed past its own
  // link. Linking a successor name is exclusive, but once a released chain frees
  // that name the link alone proves nothing: only the chain reachable from the
  // root does. A malformed chain throws here and keeps this record, so a fence
  // that cannot be disproved stays closed.
  if (currentBarrier(directory)?.gate.token !== gate.token) {
    // This record is already unreachable; a blocked cleanup costs nothing.
    try { removeOwned(file, gate.token); } catch { /* another record holds the name */ }
    throw new Error("Archive relocation fence ownership changed");
  }
  let closed = false;
  const assertOwned = (): string[] => {
    const chain = closed ? null : currentBarrier(directory);
    if (!chain || chain.gate.token !== gate.token) throw new Error("Archive relocation fence is no longer owned");
    return chain.files;
  };
  const assertDrained = () => {
    assertOwned();
    const localMachineId = readLocalMachineId();
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".json") || name === "barrier.json") continue;
      if (name.startsWith("resume-") && uuid.test(name.slice(7, -5))) continue;
      if (!uuid.test(name.slice(0, -5))) throw new Error(`Unknown archive writer lease: ${name}`);
      const leaseFile = path.join(directory, name);
      const lease = read(leaseFile);
      if (!lease) continue;
      if (deadLocal(lease, localMachineId)) { removeOwned(leaseFile, lease.token); continue; }
      throw new Error(`Archive writer still active: ${lease.host}/${lease.pid}`);
    }
  };
  return {
    root: physicalRoot, jobId, assertDrained,
    release() {
      const chain = assertOwned();
      // Admission reopens exactly when the root disappears, so the root goes
      // first and every later step is pure cleanup.
      fs.unlinkSync(rootFile);
      syncDirectory(directory);
      closed = true;
      // The successors of this chain are unreachable now; dropping them keeps
      // resumed relocations from accumulating names forever. A blocked cleanup
      // (Windows sharing violation) must never fail an accomplished release.
      for (const node of chain.slice(1).reverse()) {
        try { fs.unlinkSync(node); } catch { /* unreachable recovery leftovers */ }
      }
    },
    markRelocated(destination) {
      assertDrained();
      if (!path.isAbsolute(destination) || /[\r\n\0]/.test(destination)) throw new Error("Invalid archive relocation destination");
      let resolvedDestination: string;
      try { resolvedDestination = canonicalRoot(destination); }
      catch { throw new Error("Invalid archive relocation destination"); }
      if (rootKey(resolvedDestination) === rootKey(physicalRoot)) throw new Error("Invalid archive relocation destination");
      if (archiveIdentity(resolvedDestination) !== archiveIdentity(physicalRoot)) {
        throw new Error("Relocation destination belongs to a different archive");
      }
      const target = { ...gate, phase: "relocated" as const, destination: resolvedDestination };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const descriptor = fs.openSync(temporary, "wx");
        try { fs.writeFileSync(descriptor, JSON.stringify(target)); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
        fs.renameSync(temporary, file);
        syncDirectory(directory);
        closed = true;
      } finally { try { fs.unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
    },
  };
}
