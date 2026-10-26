import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertLocalStateOutsideRoots, resolveLocalStateRootBase } from "../config/archive-locator";

export interface ArchiveLocalStateOptions {
  localStateRoot?: string;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const safeName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    const unsupported = ["EINVAL", "ENOTSUP", "EISDIR"].includes(code)
      || (process.platform === "win32" && ["EACCES", "EPERM"].includes(code));
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readArchiveIdentity(root: string): string {
  const file = path.join(root, ".archive-inventory", "identity.json");
  let info: fs.Stats;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (missing(error)) throw new Error(`Archive has no identity: ${root}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Invalid archive identity: ${file}`);
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as { schema?: unknown; archiveId?: unknown };
  if (value.schema !== 1 || !safeName(value.archiveId)) throw new Error(`Invalid archive identity: ${file}`);
  return value.archiveId;
}

export function archiveLocalStateDirectory(
  archiveRoot: string,
  options: ArchiveLocalStateOptions = {},
): string {
  const localRoot = path.resolve(options.localStateRoot ?? resolveLocalStateRootBase());
  // Only the transferable archive is categorically forbidden here.
  assertLocalStateOutsideRoots(localRoot, [path.resolve(archiveRoot)]);
  return path.join(localRoot, "archives", readArchiveIdentity(archiveRoot));
}

export function archivePublicationLocalPaths(
  archiveRoot: string,
  relative: string,
  options: ArchiveLocalStateOptions = {},
): { directory: string; state: string; lock: string } {
  const key = createHash("sha256").update(relative).digest("hex");
  const directory = path.join(archiveLocalStateDirectory(archiveRoot, options), "publications", key);
  return { directory, state: path.join(directory, "state.json"), lock: path.join(directory, "publish.lock") };
}

export function atomicLocalWrite(file: string, bytes: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    try { fs.unlinkSync(temporary); }
    catch (error) { if (!missing(error)) throw error; }
  }
}

interface LocalLockOwner {
  schema: 1;
  token: string;
  host: string;
  pid: number;
  startedAt: string;
}

function readLock(file: string): LocalLockOwner | null {
  let value: LocalLockOwner;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as LocalLockOwner; }
  catch (error) { if (missing(error)) return null; throw error; }
  if (value.schema !== 1 || !/^[a-f0-9-]{36}$/i.test(value.token)
    || typeof value.host !== "string" || !value.host
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error(`Invalid local archive lock: ${file}`);
  }
  return value;
}

function reclaimDeadLocalLock(file: string): void {
  const prior = readLock(file);
  if (!prior) return;
  if (prior.host !== os.hostname()) throw new Error(`Local archive work is locked by ${prior.host}/${prior.pid}: ${file}`);
  try {
    process.kill(prior.pid, 0);
    throw new Error(`Local archive work is locked by ${prior.host}/${prior.pid}: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  fs.unlinkSync(file);
  syncDirectory(path.dirname(file));
}

/** Local locks serialize one machine's checkpoint; the shared writer fence still protects archive bytes. */
export function withLocalArchiveLock<T>(file: string, operation: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  reclaimDeadLocalLock(file);
  const owner: LocalLockOwner = {
    schema: 1,
    token: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const descriptor = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(owner));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try {
    return operation();
  } finally {
    const current = readLock(file);
    if (!current || current.token !== owner.token) throw new Error(`Local archive lock ownership changed: ${file}`);
    fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
  }
}
