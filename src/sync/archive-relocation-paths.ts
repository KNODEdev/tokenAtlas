import path from "node:path";
import fs from "node:fs";
import { realArchiveLocation, locationContains } from "../config/archive-location";

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function safeRelative(relative: string): void {
  if (!relative || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe relocation path: ${relative}`);
  }
  if (relative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe relocation path: ${relative}`);
  }
}

export function inside(root: string, relative: string): string {
  safeRelative(relative);
  const result = path.resolve(root, ...relative.split("/"));
  const relation = path.relative(path.resolve(root), result);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Unsafe relocation path: ${relative}`);
  }
  return result;
}

export function stamp(stat: fs.Stats): string {
  return JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]);
}

export function externalStateDirectory(raw: string, source: string, destination: string): string {
  if (!raw.trim() || /[\r\n\0]/.test(raw)) throw new Error("Invalid relocation state directory");
  const result = realArchiveLocation(raw);
  if (locationContains(source, result) || locationContains(destination, result)) {
    throw new Error("Relocation state must remain outside both archive roots");
  }
  return result;
}

export function assertSeparate(source: string, destination: string): void {
  if (locationContains(source, destination) || locationContains(destination, source)) {
    throw new Error("Archive relocation roots must not be equal, nested, or overlapping");
  }
}

export function ensureRootStillMatches(root: string): void {
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`Relocation root is unavailable or replaced: ${root}`);
  }
  if (!samePath(fs.realpathSync(root), root)) throw new Error(`Relocation root changed identity: ${root}`);
}

export function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException).code);
    const unsupported = ["EINVAL", "ENOTSUP", "EISDIR"].includes(code) ||
      (process.platform === "win32" && ["EACCES", "EPERM"].includes(code));
    if (!unsupported) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
