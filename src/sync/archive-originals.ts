import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { archiveLocalStateDirectory, withLocalArchiveLock, type ArchiveLocalStateOptions } from "./archive-local-state";
import { atomicArchiveWrite } from "./archive-publication";
import { fileStamp } from "./jsonl-inspection";

/**
 * What the archive knows of each copy's original (user decision 2026-10-05): the original's path,
 * size and exact modification time, and the copy's digest, recorded only after the copy's bytes
 * were confirmed equal to the whole original. It lives in the archive (it survives a deleted
 * database or local state) and never changes the archived files themselves. One manifest per
 * archive folder, `.archive-inventory/originals/<folder>/files.json`, written atomically; folders
 * of different computers are different files, so two computers never write the same manifest.
 * A missing, unreadable or other-schema manifest counts as empty: its files are simply read.
 *
 * A copy pass without local state skips a copy whose original still has the recorded path, size
 * and time (and whose copy has the recorded size) without reading either file. A time without a
 * sub-second part may be truncated and proves nothing, so such files are always read.
 */
export interface OriginalRecord { source: string; bytes: number; mtimeNs: string; copyBytes: number; digest: string }
interface Manifest { schema: 1; files: Record<string, OriginalRecord> }

const MANIFEST_DIRECTORY = path.join(".archive-inventory", "originals");
const digestPattern = /^[a-f0-9]{64}$/;

function locate(archiveRoot: string, destination: string): { manifest: string; name: string; relativeFolder: string } {
  const relative = path.relative(path.resolve(archiveRoot), path.resolve(destination));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Not an archive file: ${destination}`);
  const relativeFolder = path.dirname(relative);
  return { manifest: path.join(archiveRoot, MANIFEST_DIRECTORY, relativeFolder, "files.json"), name: path.basename(relative), relativeFolder };
}

function valid(record: unknown): record is OriginalRecord {
  const value = record as OriginalRecord;
  return !!value && typeof value.source === "string" && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && typeof value.mtimeNs === "string" && /^\d+$/.test(value.mtimeNs) && Number.isSafeInteger(value.copyBytes) && digestPattern.test(value.digest);
}

/** Read manifests, kept while their file is unchanged: a copy pass reads each folder's manifest once. */
const cache = new Map<string, { stamp: string; files: Record<string, OriginalRecord> }>();
function readManifest(file: string): Record<string, OriginalRecord> {
  let stamp: string | null;
  try { stamp = fileStamp(file); } catch { return {}; }
  if (!stamp) { cache.delete(file); return {}; }
  const known = cache.get(file);
  if (known?.stamp === stamp) return known.files;
  let files: Record<string, OriginalRecord> = {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
    if (value?.schema === 1 && value.files && typeof value.files === "object")
      files = Object.fromEntries(Object.entries(value.files).filter(([, record]) => valid(record)));
  } catch { /* An unreadable manifest is empty: its files are read and recorded again. */ }
  cache.set(file, { stamp, files });
  return files;
}

function updateManifest(archiveRoot: string, destination: string, options: ArchiveLocalStateOptions,
  change: (files: Record<string, OriginalRecord>, name: string) => boolean): void {
  const { manifest, name, relativeFolder } = locate(archiveRoot, destination);
  // Writers of one folder are processes of one computer: a local lock orders them.
  const lock = path.join(archiveLocalStateDirectory(archiveRoot, options), "originals",
    `${createHash("sha256").update(relativeFolder).digest("hex")}.lock`);
  withLocalArchiveLock(lock, () => {
    const files = { ...readManifest(manifest) };
    if (!change(files, name)) return;
    atomicArchiveWrite(manifest, JSON.stringify({ schema: 1, files } satisfies Manifest));
  });
}

/** The recorded original of an archive copy, or null. */
export function readOriginalRecord(archiveRoot: string, destination: string): OriginalRecord | null {
  const { manifest, name } = locate(archiveRoot, destination);
  return readManifest(manifest)[name] ?? null;
}

/** Whether the copy can be accepted without reading: its original still has the recorded path, size and exact time. */
export function originalUnchanged(archiveRoot: string, source: string, destination: string): boolean {
  const record = readOriginalRecord(archiveRoot, destination);
  if (!record || record.source !== path.resolve(source)) return false;
  const original = fs.statSync(source, { bigint: true, throwIfNoEntry: false });
  const copy = fs.statSync(destination, { bigint: true, throwIfNoEntry: false });
  return !!original && !!copy && original.isFile() && copy.isFile() && original.size === BigInt(record.bytes)
    && copy.size === BigInt(record.copyBytes) && original.mtimeNs.toString() === record.mtimeNs
    && original.mtimeNs % 1_000_000_000n !== 0n;
}

/**
 * Records that the copy holds the whole original's bytes (`bytes`, `digest`), verified while the
 * original had `sourceStamp`. Nothing is recorded when the original has moved on since.
 */
export function recordOriginal(archiveRoot: string, source: string, destination: string, sourceStamp: string,
  digest: string, bytes: number, options: ArchiveLocalStateOptions = {}): void {
  const original = fs.statSync(source, { bigint: true });
  if (fileStamp(source) !== sourceStamp || original.size !== BigInt(bytes)) return;
  const record: OriginalRecord = { source: path.resolve(source), bytes, mtimeNs: original.mtimeNs.toString(), copyBytes: bytes, digest };
  updateManifest(archiveRoot, destination, options, (files, name) => {
    const known = files[name];
    if (known && JSON.stringify(known) === JSON.stringify(record)) return false;
    files[name] = record;
    return true;
  });
}

/** Removes a copy's record, so the next copy pass reads both files. */
export function forgetOriginal(archiveRoot: string, destination: string, options: ArchiveLocalStateOptions = {}): void {
  updateManifest(archiveRoot, destination, options, (files, name) => {
    if (!(name in files)) return false;
    delete files[name];
    return true;
  });
}
