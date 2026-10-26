import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ATLAS_SNAPSHOT_BARRIER_SUFFIX } from "./snapshot-contracts";

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function syncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Windows does not expose directory fsync; the per-publication barrier remains the durable commit marker.
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export const publicationWaitSignal = new Int32Array(new SharedArrayBuffer(4));

export function renamePublicationFile(source: string, destination: string, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
      if (!code || !["EBUSY", "EPERM", "EACCES"].includes(code) || Date.now() >= deadline) {
        throw error;
      }
      // Windows scanners can briefly retain a handle after SQLite closes it.
      Atomics.wait(publicationWaitSignal, 0, 0, 50);
    }
  }
}

export function establishDurablePair(
  poolPath: string,
  snapshotIdValue: string,
  databasePath: string,
  manifestPath: string,
): string {
  syncFile(databasePath);
  syncFile(manifestPath);
  syncDirectory(poolPath);
  const barrierPath = path.join(poolPath, `${snapshotIdValue}${ATLAS_SNAPSHOT_BARRIER_SUFFIX}`);
  const barrierTemp = `${barrierPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(barrierTemp, `${snapshotIdValue}\n`, { flag: "wx" });
    syncFile(barrierTemp);
    renamePublicationFile(barrierTemp, barrierPath);
    syncFile(barrierPath);
    syncDirectory(poolPath);
    return barrierPath;
  } finally {
    if (fs.existsSync(barrierTemp)) fs.rmSync(barrierTemp);
  }
}
