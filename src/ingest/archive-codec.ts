import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTemporaryWorkspace } from "../config/temporary-storage";
import { resolveDbPath } from "../db";
import { nativeParserBinary } from "./parse-pool";
import { fileStamp, fileDigest } from "../sync/jsonl-inspection";
import { archiveSourceIdentity, compressedArchiveSource } from "../shared/archive-codec-path";

type Storage = { databasePath?: string; env?: Record<string, string | undefined> };
interface DecodeScope {
  files: Map<string, { file: string; stamp: string }>;
  workspace?: ReturnType<typeof createTemporaryWorkspace>;
  next: number;
}
const decodeScope = new AsyncLocalStorage<DecodeScope>();

/** One synchronous publication shares decoded bytes by compressed SHA, then disposes scratch. */
export function withArchiveDecodeCache<T>(operation: () => T): T {
  if (decodeScope.getStore()) return operation();
  const scope: DecodeScope = { files: new Map(), next: 0 };
  try { return decodeScope.run(scope, operation); }
  finally { scope.workspace?.dispose(); }
}

export function archiveRepresentations(file: string): string[] {
  const plain = archiveSourceIdentity(file);
  return [plain, `${plain}.zst`].filter(candidate => fileStamp(candidate) !== null);
}

export function prefixMatches(left: string, right: string, bytes: number): boolean {
  const a = fs.openSync(left, "r"), b = fs.openSync(right, "r");
  const x = Buffer.allocUnsafe(1 << 16), y = Buffer.allocUnsafe(x.length);
  try {
    for (let remaining = bytes; remaining > 0;) {
      const count = Math.min(remaining, x.length);
      if (fs.readSync(a, x, 0, count, null) !== count || fs.readSync(b, y, 0, count, null) !== count
        || !x.subarray(0, count).equals(y.subarray(0, count))) return false;
      remaining -= count;
    }
    return true;
  } finally { fs.closeSync(a); fs.closeSync(b); }
}

function openDecoded(files: string[], storage: Storage) {
  const stamps = files.map(file => fileStamp(file));
  if (stamps.some(stamp => !stamp)) throw new Error("Archive source disappeared before decoding");
  const cache = decodeScope.getStore(), witnesses = new Map<string, string>();
  const workspace = files.some(compressedArchiveSource)
    ? cache?.workspace ?? createTemporaryWorkspace("archive-codec", storage.databasePath ?? resolveDbPath(), storage.env) : undefined;
  if (cache && workspace) cache.workspace = workspace;
  const dispose = () => { if (!cache) workspace?.dispose(); };
  try {
    const decoded = files.map((file, index) => {
      if (!compressedArchiveSource(file)) return file;
      const digest = cache ? fileDigest(file) : null;
      if (digest) {
        witnesses.set(file, digest);
        const hit = cache!.files.get(digest);
        if (hit && fileStamp(hit.file) === hit.stamp) return hit.file;
      }
      const target = path.join(workspace!.directory, `${cache ? cache.next++ : index}${path.extname(archiveSourceIdentity(file))}`);
      const result = spawnSync(nativeParserBinary(), ["--decode-rollout", file, target], { windowsHide: true, encoding: "utf8" });
      if (result.error || result.status !== 0) throw new Error(`Cannot decode archive source ${file}: ${result.error?.message ?? result.stderr.trim()}`);
      if (digest) cache!.files.set(digest, { file: target, stamp: fileStamp(target)! });
      return target;
    });
    const assertStable = () => files.forEach((file, index) => {
      if (fileStamp(file) !== stamps[index]) throw new Error(`Archive source changed while reading: ${file}`);
      const digest = witnesses.get(file);
      if (digest && fileDigest(file) !== digest) throw new Error(`Archive source bytes changed while reading: ${file}`);
    });
    assertStable();
    return { decoded, assertStable, dispose };
  } catch (error) { dispose(); throw error; }
}

/** Only scratch is decoded; durable identity and physical input witnesses keep their original paths. */
export function withDecodedArchiveFiles<T>(files: string[], consume: (decoded: string[], assertStable: () => void) => T,
  mutatesInputs = false, storage: Storage = {}): T {
  const lease = openDecoded(files, storage);
  try {
    const result = consume(lease.decoded, lease.assertStable);
    if (!mutatesInputs) lease.assertStable();
    return result;
  } finally { lease.dispose(); }
}

/** Cloud transitions may deliver two names. JSONL siblings may have grown. */
export function selectArchiveRepresentation(file: string, storage: Storage = {}): string {
  const plain = archiveSourceIdentity(file), compressed = `${plain}.zst`;
  if (!fs.existsSync(compressed)) return plain;
  if (!fs.existsSync(plain)) return compressed;
  return withDecodedArchiveFiles([plain, compressed], decoded => {
    const sizes = decoded.map(candidate => fs.statSync(candidate).size);
    if (!prefixMatches(decoded[0]!, decoded[1]!, Math.min(...sizes)))
      throw new Error(`Conflicting archive source representations: ${plain}`);
    return sizes[0]! >= sizes[1]! ? plain : compressed;
  }, false, storage);
}
