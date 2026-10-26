import fs from "node:fs";
import type { ArchiveRelocationState, ArchiveRelocationEntry } from "./archive-relocation-contracts";
import { inside, samePath, stamp } from "./archive-relocation-paths";
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const COPY_CHUNK_BYTES = 1024 * 1024;

export function stableSourceFile(state: ArchiveRelocationState, entry: ArchiveRelocationEntry): string {
  const source = inside(state.sourceRoot, entry.relative);
  const info = fs.lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(fs.realpathSync(source), source)) {
    throw new Error(`Archive source is no longer a regular in-root file: ${entry.relative}`);
  }
  if (stamp(info) !== entry.sourceStamp) throw new Error(`Archive source changed during relocation: ${entry.relative}`);
  return source;
}

export function budgetAllows(processed: number, bytes: number, next: number, maxFiles: number, maxBytes: number): boolean {
  return processed === 0 || (processed < maxFiles && bytes + next <= maxBytes);
}

async function yieldIO(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

export async function hashFileBounded(file: string, maxBytes=Infinity): Promise<{ digest: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  const descriptor = await fsp.open(file, "r");
  let bytes = 0;
  try {
    while (true) {
      const read = await descriptor.read(buffer, 0, Math.min(buffer.length,maxBytes-bytes+1), null);
      if (!read.bytesRead) break;
      if(bytes+read.bytesRead>maxBytes)throw new Error("Archive file grew beyond the hash read budget");
      hash.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
      await yieldIO();
    }
    return { digest: hash.digest("hex"), bytes };
  } finally {
    await descriptor.close();
  }
}

function adjacentNumber(value: number, direction: -1 | 1): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid relocation timestamp");
  if (value === 0 && direction < 0) return 0;
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, value);
  const bits = data.getBigUint64(0);
  data.setBigUint64(0, direction > 0 ? bits + 1n : bits - 1n);
  return data.getFloat64(0);
}

/**
 * Preserve the exact stat-visible bookmark used by incremental importers. Native copy keeps
 * the original timestamp on platforms that support it. Otherwise try the neighbouring
 * representable seconds that can map back to the source's mtimeMs without rounding drift.
 * A filesystem that cannot represent the bookmark fails relocation instead of certifying a
 * destination that would spuriously re-import historical facts.
 */
async function preserveExactModifiedTime(file: string, expectedMs: number): Promise<void> {
  if ((await fsp.stat(file)).mtimeMs === expectedMs) return;
  const base = expectedMs / 1000;
  let lower = base;
  let upper = base;
  for (let attempt = 0; attempt < 129; attempt++) {
    let candidate = base;
    if (attempt > 0 && attempt % 2 === 1) candidate = lower = adjacentNumber(lower, -1);
    if (attempt > 0 && attempt % 2 === 0) candidate = upper = adjacentNumber(upper, 1);
    await fsp.utimes(file, candidate, candidate);
    if ((await fsp.stat(file)).mtimeMs === expectedMs) return;
  }
  throw new Error(`Relocation target cannot preserve the exact modification-time bookmark: ${file}`);
}

export async function destinationBookmarkMatches(
  file: string,
  entry: Pick<ArchiveRelocationEntry, "bytes" | "modifiedAtMs">,
): Promise<boolean> {
  try {
    const info = await fsp.stat(file);
    return info.isFile() && info.size === entry.bytes && info.mtimeMs === entry.modifiedAtMs;
  } catch {
    return false;
  }
}

export async function atomicCopyBounded(
  source: string,
  destination: string,
  expectedDigest: string,
  expectedBytes: number,
  expectedMode: number,
  expectedModifiedAtMs: number,
): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    // The native asynchronous copy preserves exact Windows file timestamps and leaves the
    // event loop available while the OS copies an oversized file. Content is still verified
    // incrementally before publication; timestamp restoration below covers other platforms.
    await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    const copied = await hashFileBounded(temporary);
    if (copied.bytes !== expectedBytes || copied.digest !== expectedDigest) {
      throw new Error(`Archive input changed during bounded copy: ${source}`);
    }
    await fsp.chmod(temporary, expectedMode);
    await preserveExactModifiedTime(temporary, expectedModifiedAtMs);
    const handle = await fsp.open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(temporary, destination);
    if (!await destinationBookmarkMatches(destination, {
      bytes: expectedBytes,
      modifiedAtMs: expectedModifiedAtMs,
    })) {
      throw new Error(`Relocation copy changed the incremental bookmark: ${destination}`);
    }
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}
