import fs from "node:fs";
import path from "node:path";
import { missing, stamp } from "./file-fingerprint";

/** What `lstat` says about one path: its kind and stamp, that it is gone, or the error it failed with. */
export type StampResult =
  | { kind: "file"; stamp: string }
  | { kind: "directory" | "link" | "other" }
  | { kind: "missing" }
  | { kind: "error"; error: string };

// Below this many paths a child process costs more than it saves.
const PARALLEL_FROM = 1024;
const CONCURRENCY = 32;

function describe(info: fs.Stats): StampResult {
  if (info.isSymbolicLink()) return { kind: "link" };
  if (info.isDirectory()) return { kind: "directory" };
  return info.isFile() ? { kind: "file", stamp: stamp(info) } : { kind: "other" };
}
function failure(error: unknown): StampResult {
  return missing(error) ? { kind: "missing" } : { kind: "error", error: error instanceof Error ? error.message : String(error) };
}
function inline(file: string): StampResult {
  try { return describe(fs.lstatSync(file)); } catch (error) { return failure(error); }
}

/**
 * `lstat` of many paths, in input order. A stat opens the file, and a cloud folder (OneDrive)
 * answers each open slowly but many of them at once, so a large batch is stated concurrently
 * by a child process (callers are synchronous). Any failure of that process falls back to
 * stating here, one path at a time.
 */
export function stampAll(files: string[]): StampResult[] {
  if (files.length < PARALLEL_FROM) return files.map(inline);
  try {
    const child = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "stamp-batch.ts")], {
      stdin: Buffer.from(JSON.stringify(files)), stdout: "pipe", stderr: "pipe",
    });
    if (child.exitCode === 0) {
      const results = JSON.parse(child.stdout.toString()) as StampResult[];
      if (Array.isArray(results) && results.length === files.length) return results;
    }
  } catch { /* stated below */ }
  return files.map(inline);
}

async function stampConcurrently(files: string[]): Promise<StampResult[]> {
  const results = new Array<StampResult>(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const index = next++;
      try { results[index] = describe(await fs.promises.lstat(files[index]!)); }
      catch (error) { results[index] = failure(error); }
    }
  }));
  return results;
}

if (import.meta.main) {
  const files = JSON.parse(await Bun.stdin.text()) as string[];
  process.stdout.write(JSON.stringify(await stampConcurrently(files)));
}
