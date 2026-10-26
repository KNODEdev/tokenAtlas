import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertArchiveWriteAdmission, withArchiveFileWriter, withArchiveWriter } from "./archive-writers";
import {
  archivePublicationLocalPaths,
  atomicLocalWrite,
  readArchiveIdentity,
  type ArchiveLocalStateOptions,
  withLocalArchiveLock,
} from "./archive-local-state";
import { assertSafeArchiveRelative, containedArchivePath, isRecoverableArchiveSource } from "./archive-source-path";
import { acceptedArchiveFingerprint } from "./file-queue";
import { fileStamp, inspectJsonl, fileDigest } from "./jsonl-inspection";
export { fileDigest } from "./jsonl-inspection";
import { originalUnchanged, readOriginalRecord, recordOriginal } from "./archive-originals";
import { prefixMatches, archiveRepresentations, withDecodedArchiveFiles } from "../ingest/archive-codec";
import { archiveCodecSource, archiveSourceIdentity, compressedArchiveSource } from "../shared/archive-codec-path";

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const digestPattern = /^[a-f0-9]{64}$/;

/**
 * Stats before creating: Bun's recursive mkdir raises EEXIST for an existing cloud directory
 * that carries the read-only attribute, which OneDrive sets on pinned folders.
 */
export function ensureDirectory(directory: string): void {
  try {
    if (!fs.statSync(directory).isDirectory()) throw new Error(`Not an archive directory: ${directory}`);
  } catch (error) {
    if (!missing(error)) throw error;
    fs.mkdirSync(directory, { recursive: true });
  }
}


export function atomicArchiveCopy(source: string, destination: string, expectedDigest: string, expectedDestinationStamp?: string | null,
  expectedSourceStamp?: string): void {
  return withArchiveFileWriter(destination, () => copyUnfenced(source, destination, expectedDigest, expectedDestinationStamp, expectedSourceStamp));
}

function copyUnfenced(source: string, destination: string, expectedDigest: string, expectedDestinationStamp?: string | null,
  expectedSourceStamp?: string): void {
  ensureDirectory(path.dirname(destination));
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    const descriptor = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    if (fileDigest(temporary) !== expectedDigest) throw new Error(`Archive input changed during copy: ${source}`);
    if (expectedSourceStamp !== undefined && fileStamp(source) !== expectedSourceStamp)
      throw new Error(`Archive source changed while reading: ${source}`);
    if (expectedDestinationStamp !== undefined && fileStamp(destination) !== expectedDestinationStamp)
      throw new Error(`Archive destination changed during publication: ${destination}`);
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Flush before atomic replacement; never remove an existing destination first. */
export function atomicArchiveWrite(file: string, bytes: Uint8Array | string): void {
  return withArchiveFileWriter(file, () => writeUnfenced(file, bytes));
}

function writeUnfenced(file: string, bytes: Uint8Array | string): void {
  ensureDirectory(path.dirname(file));
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    const descriptor = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

interface PublicationState {
  schema: 1;
  archiveId: string;
  relative: string;
  source: string;
  format: "jsonl" | "opaque";
  sourceStamp: string;
  destinationStamp: string;
  acceptedDigest: string;
  acceptedBytes: number;
  observedSourceBytes: number;
  publishableSourceBytes: number;
  updatedAt: string;
  /** Physical bytes above fence copying; decoded bytes fence logical history across codecs. */
  logicalDigest?: string;
  logicalBytes?: number;
  representation?: string;
}

export interface ArchivePublicationOptions extends ArchiveLocalStateOptions {
  archiveRoot: string;
  provenance?: string;
  jsonl?: boolean;
  /** Archive compaction may change the codec only, never adopt a content rewrite. */
  representationOnly?: boolean;
  expectedArchiveSource?: { file: string; stamp: string };
}

export class ArchivePublicationConflictError extends Error {
  constructor(
    readonly source: string,
    readonly destination: string,
    readonly conflictFile: string,
    reason: string,
    /** These exact source bytes were already recorded as a divergence before this run. */
    readonly alreadyRecorded = false,
  ) {
    super(`Unresolved archive source conflict: ${reason}; accepted archive kept at '${destination}', source evidence kept at '${conflictFile}'`);
    this.name = "ArchivePublicationConflictError";
  }
}

function archiveRelative(archiveRoot: string, destination: string): string {
  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(destination);
  const relative = path.relative(root, resolved).split(path.sep).join("/");
  assertSafeArchiveRelative(relative);
  if (containedArchivePath(root, relative) !== resolved || !isRecoverableArchiveSource(relative)) {
    throw new Error(`Destination is not an ordinary vendor archive source: ${destination}`);
  }
  return relative;
}

export function archivePublicationPaths(
  archiveRoot: string,
  destination: string,
  options: ArchiveLocalStateOptions = {},
): { relative: string; directory: string; state: string; lock: string } {
  const physicalRelative = archiveRelative(archiveRoot, destination);
  const relative = archiveCodecSource(physicalRelative) ? archiveSourceIdentity(physicalRelative) : physicalRelative;
  return { relative, ...archivePublicationLocalPaths(archiveRoot, relative, options) };
}

function readState(file: string, relative: string): PublicationState | null {
  let value: PublicationState;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as PublicationState; }
  catch (error) { if (missing(error)) return null; throw error; }
  if (value.schema !== 1 || value.relative !== relative || typeof value.archiveId !== "string"
    || typeof value.source !== "string" || !path.isAbsolute(value.source)
    || !["jsonl", "opaque"].includes(value.format)
    || typeof value.sourceStamp !== "string" || typeof value.destinationStamp !== "string"
    || !digestPattern.test(value.acceptedDigest)
    || !Number.isSafeInteger(value.acceptedBytes) || value.acceptedBytes < 0
    || !Number.isSafeInteger(value.observedSourceBytes) || value.observedSourceBytes < 0
    || !Number.isSafeInteger(value.publishableSourceBytes) || value.publishableSourceBytes < 0
    || value.publishableSourceBytes > value.observedSourceBytes
    || (value.logicalDigest !== undefined && !digestPattern.test(value.logicalDigest))
    || (value.logicalBytes !== undefined && (!Number.isSafeInteger(value.logicalBytes) || value.logicalBytes < 0))
    || ((value.logicalBytes === undefined) !== (value.logicalDigest === undefined))
    || (value.representation !== undefined && ![relative, `${relative}.zst`].includes(value.representation))
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(`Invalid local archive publication state: ${file}`);
  }
  return value;
}


function replaceWithPrefix(
  source: string,
  destination: string,
  bytes: number,
  expectedDigest: string,
  expectedSourceStamp: string,
  expectedDestinationStamp: string | null,
): void {
  ensureDirectory(path.dirname(destination));
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    const input = fs.openSync(source, "r");
    const output = fs.openSync(temporary, "wx");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let remaining = bytes;
    try {
      while (remaining > 0) {
        const count = fs.readSync(input, chunk, 0, Math.min(remaining, chunk.length), null);
        if (count === 0) throw new Error(`Archive source changed while reading: ${source}`);
        fs.writeSync(output, chunk, 0, count);
        hash.update(chunk.subarray(0, count));
        remaining -= count;
      }
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(input);
      fs.closeSync(output);
    }
    if (hash.digest("hex") !== expectedDigest || fileStamp(source) !== expectedSourceStamp) {
      throw new Error(`Archive source changed while reading: ${source}`);
    }
    if (fileStamp(destination) !== expectedDestinationStamp) {
      throw new Error(`Archive destination changed during publication: ${destination}`);
    }
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Whether an archive copy holds exactly its original's bytes: one read of each, for the background verification. */
export function copyEqualsOriginal(source: string, destination: string): boolean {
  const sourceStamp = fileStamp(source), destinationStamp = fileStamp(destination);
  if (!sourceStamp || !destinationStamp) return false;
  const bytes = fs.statSync(source).size;
  if (fs.statSync(destination).size !== bytes) return false;
  const equal = prefixMatches(source, destination, bytes);
  if (fileStamp(source) !== sourceStamp) throw new Error(`Archive source changed while reading: ${source}`);
  if (fileStamp(destination) !== destinationStamp) throw new Error(`Archive destination changed while reading: ${destination}`);
  return equal;
}

/**
 * One read of the original and of its archive copy, side by side: whether the shorter is a byte
 * prefix of the longer, and the copy's length and digest. This is what an archive copy without
 * local publication state (a new computer, a cleared state folder) needs to be accepted as it is:
 * reading each file once, without parsing records the copy already holds.
 */
function compareWithArchived(source: string, destination: string): {
  prefixEqual: boolean; sourceBytes: number; destinationBytes: number; destinationDigest: string; destinationEndsRecord: boolean;
} {
  const sourceStamp = fileStamp(source), destinationStamp = fileStamp(destination);
  if (!sourceStamp) throw new Error(`Archive source disappeared: ${source}`);
  if (!destinationStamp) throw new Error(`Archive destination changed while reading: ${destination}`);
  const sourceDescriptor = fs.openSync(source, "r"), destinationDescriptor = fs.openSync(destination, "r");
  const hash = createHash("sha256");
  const sourceChunk = Buffer.allocUnsafe(1024 * 1024), destinationChunk = Buffer.allocUnsafe(sourceChunk.length);
  let prefixEqual = true, last = -1, sourceBytes = 0, destinationBytes = 0;
  try {
    sourceBytes = fs.fstatSync(sourceDescriptor).size;
    destinationBytes = fs.fstatSync(destinationDescriptor).size;
    // The shorter file must be a byte prefix of the longer; the copy is hashed whole.
    const common = Math.min(sourceBytes, destinationBytes);
    for (let offset = 0; offset < destinationBytes;) {
      const count = fs.readSync(destinationDescriptor, destinationChunk, 0, Math.min(destinationChunk.length, destinationBytes - offset), offset);
      if (count === 0) throw new Error(`Archive destination changed while reading: ${destination}`);
      hash.update(destinationChunk.subarray(0, count));
      if (prefixEqual && offset < common) {
        const compared = Math.min(count, common - offset);
        if (fs.readSync(sourceDescriptor, sourceChunk, 0, compared, offset) !== compared
          || !sourceChunk.subarray(0, compared).equals(destinationChunk.subarray(0, compared))) prefixEqual = false;
      }
      last = destinationChunk[count - 1]!;
      offset += count;
    }
  } finally {
    fs.closeSync(sourceDescriptor);
    fs.closeSync(destinationDescriptor);
  }
  if (fileStamp(source) !== sourceStamp) throw new Error(`Archive source changed while reading: ${source}`);
  if (fileStamp(destination) !== destinationStamp) throw new Error(`Archive destination changed while reading: ${destination}`);
  return { prefixEqual, sourceBytes, destinationBytes, destinationDigest: hash.digest("hex"), destinationEndsRecord: last === 10 };
}

/**
 * A provider may re-encode its own log: Codex rewrote finished sessions when it
 * moved from `legacy` to `paginated` history, adding `ordinal` to every record
 * and re-serialising events. The bytes no longer start with the accepted prefix
 * although not one accounted record changed, and refusing that forever would
 * leave the archive behind its provider over a representation detail.
 *
 * Accounted records are the contract: a rewrite may be adopted only when every
 * record this archive already accepted is still there, in order, and the file
 * did not shrink. A source that dropped accounted records - the same paginated
 * rewrite does that when it stops materialising history inline - stays a
 * conflict for a person to decide, and the accepted archive stays authoritative.
 */
function accountedRecords(file: string, bytes: number): string[] | null {
  const records: string[] = [];
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, ordered((value as Record<string, unknown>)[key])])) : value;
  // Only the bytes this publication treats as whole records are compared.
  const text = fs.readFileSync(file).subarray(0, bytes).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const body = line.trim();
    if (!body) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(body) as Record<string, unknown>; } catch { return null; }
    if (value.type !== "token_usage_record") continue;
    delete value.ordinal;
    records.push(JSON.stringify(ordered(value)));
  }
  return records;
}

/** Only the vendor whose format actually migrated; every other source keeps the strict rule. */
function rewriteMayBeAdopted(archiveRoot: string, destination: string, source: string,
  sourceBytes: number, acceptedBytes: number, acceptedFile = destination): boolean {
  const relative = path.relative(archiveRoot, destination).split(path.sep).join("/");
  if (!relative.startsWith("codex/") || sourceBytes < acceptedBytes) return false;
  const accepted = accountedRecords(acceptedFile, acceptedBytes);
  const rewritten = accountedRecords(source, sourceBytes);
  // An accepted reading with nothing accounted has no fact to lose; the reading
  // itself is still kept beside the adopted one.
  if (!accepted || !rewritten) return false;
  let index = 0;
  for (const record of rewritten) {
    if (record === accepted[index]) index++;
    if (index === accepted.length) return true;
  }
  return index === accepted.length;
}

/** The reading being replaced stays in the archive as the original it was. */
function preserveSupersededReading(destination: string): void {
  const digest = fileDigest(destination);
  const superseded = `${destination}.superseded-${digest}.reading`;
  if (fs.existsSync(superseded)) {
    if (fileDigest(superseded) !== digest) throw new Error(`Superseded reading collision: ${superseded}`);
    return;
  }
  atomicArchiveCopy(destination, superseded, digest);
}

/**
 * Records a divergence the archive will not take. The first time a given source
 * state is seen it is raised, so nobody misses it; once those exact bytes are on
 * record the decision stands and the caller reports it instead of failing every
 * cycle over a file no run can import. A source that changes again is raised anew.
 */
function preserveConflict(source: string, destination: string, reason: string, jsonl=false): never {
  const sourceStamp = fileStamp(source);
  if (!sourceStamp) throw new Error(`Archive source disappeared: ${source}`);
  const sourceDigest = fileDigest(source);
  if (fileStamp(source) !== sourceStamp) throw new Error(`Archive source changed while reading: ${source}`);
  const branchKey=jsonl?createHash("sha256").update(path.resolve(source)).digest("hex"):sourceDigest;
  const conflict = path.join(
    path.dirname(destination),
    `${path.basename(destination)}.conflict-${branchKey}.source`,
  );
  let alreadyRecorded = false;
  if (fs.existsSync(conflict)) {
    const previousDigest=fileDigest(conflict);
    alreadyRecorded = previousDigest===sourceDigest;
    if(!alreadyRecorded) {
      if(!jsonl)throw new Error(`Archive conflict evidence collision: ${conflict}`);
      const previousBytes=fs.statSync(conflict).size,sourceBytes=fs.statSync(source).size;
      if(prefixMatches(source,conflict,Math.min(previousBytes,sourceBytes))) {
        if(sourceBytes>previousBytes)atomicArchiveCopy(source,conflict,sourceDigest);
      } else {
        // Preserve a genuinely divergent branch; ordinary appends update its one file.
        const priorBranch=`${destination}.conflict-${previousDigest}.source`;
        if(!fs.existsSync(priorBranch))atomicArchiveCopy(conflict,priorBranch,previousDigest);
        else if(fileDigest(priorBranch)!==previousDigest)throw new Error(`Archive conflict evidence collision: ${priorBranch}`);
        atomicArchiveCopy(source,conflict,sourceDigest);
      }
    }
  } else {
    atomicArchiveCopy(source, conflict, sourceDigest);
  }
  throw new ArchivePublicationConflictError(source, destination, conflict, reason, alreadyRecorded);
}

function writeState(
  stateFile: string,
  archiveId: string,
  relative: string,
  source: string,
  format: "jsonl" | "opaque",
  sourceStamp: string,
  destination: string,
  acceptedDigest: string,
  acceptedBytes: number,
  observedSourceBytes: number,
  publishableSourceBytes: number,
): void {
  const destinationStamp = fileStamp(destination);
  if (!destinationStamp) throw new Error(`Archive destination disappeared after publication: ${destination}`);
  const next: PublicationState = {
    schema: 1,
    archiveId,
    relative,
    source,
    format,
    sourceStamp,
    destinationStamp,
    acceptedDigest,
    acceptedBytes,
    observedSourceBytes,
    publishableSourceBytes,
    updatedAt: new Date().toISOString(),
  };
  atomicLocalWrite(stateFile, JSON.stringify(next));
}

/** Metadata-only current check. Missing/corrupt local state never mutates the archive. */
export function archivePublicationIsCurrent(
  archiveRoot: string,
  destination: string,
  options: ArchiveLocalStateOptions = {},
): boolean {
  const paths = archivePublicationPaths(archiveRoot, destination, options);
  const state = readState(paths.state, paths.relative);
  return !!state && state.destinationStamp === fileStamp(destination);
}

/** A durable checkpoint can prove a no-op without creating cloud writer records or local locks. */
function publicationUnchanged(source: string, destination: string, options: ArchivePublicationOptions): boolean {
  if (options.representationOnly || options.expectedArchiveSource) return false;
  const paths = archivePublicationPaths(options.archiveRoot, destination, options);
  const state = readState(paths.state, paths.relative);
  if (!state || state.source !== path.resolve(options.provenance ?? source) || state.sourceStamp !== fileStamp(source)) return false;
  const encoded = archiveCodecSource(paths.relative)?.format === "jsonl" && (compressedArchiveSource(source)
    || fs.existsSync(`${archiveSourceIdentity(destination)}.zst`) || state.logicalDigest !== undefined);
  if (encoded) {
    if (compressedArchiveSource(source) !== compressedArchiveSource(destination)) return false;
    const files = archiveRepresentations(destination);
    return files.length === 1
      && state.representation === paths.relative + (compressedArchiveSource(files[0]!) ? ".zst" : "")
      && state.destinationStamp === fileStamp(files[0]!);
  }
  if (state.format !== (options.jsonl ? "jsonl" : "opaque") || state.destinationStamp !== fileStamp(destination)) return false;
  // The ordinary publication also repairs a missing transferable original witness.
  return state.acceptedBytes !== state.observedSourceBytes || readOriginalRecord(options.archiveRoot, destination) !== null;
}

/**
 * Publish one ordinary source. JSONL may only grow from the accepted prefix, except
 * for a rewrite that provably keeps every accounted record; opaque sources are
 * immutable once accepted until a format-specific policy exists.
 */
export function publishArchiveFile(
  source: string,
  destination: string,
  options: ArchivePublicationOptions,
): "copied" | "unchanged" {
  if (publicationUnchanged(source, destination, options)) {
    assertArchiveWriteAdmission(options.archiveRoot);
    // A relocation or another publisher may have moved the checkpoint while admission was checked.
    if (publicationUnchanged(source, destination, options)) return "unchanged";
  }
  const relative = archiveRelative(options.archiveRoot, destination);
  if (archiveCodecSource(relative)?.format === "jsonl" && (compressedArchiveSource(source)
    || fs.existsSync(`${archiveSourceIdentity(destination)}.zst`)
    || readState(archivePublicationPaths(options.archiveRoot, destination, options).state, archiveSourceIdentity(relative))?.logicalDigest !== undefined)) {
    return publishEncodedJsonlArchive(source, destination, options);
  }
  return withArchiveWriter(options.archiveRoot, () => {
    const paths = archivePublicationPaths(options.archiveRoot, destination, options);
    return withLocalArchiveLock(paths.lock, () => {
      const provenance = path.resolve(options.provenance ?? source);
      const sourcePath = path.resolve(source);
      const sourceStamp = fileStamp(sourcePath);
      if (!sourceStamp) throw new Error(`Archive source disappeared: ${sourcePath}`);
      const destinationStamp = fileStamp(destination);
      const state = readState(paths.state, paths.relative);
      if (destinationStamp === null && !state
        && acceptedArchiveFingerprint(options.archiveRoot,destination,options.localStateRoot))
        throw new Error(`Archived source is missing and its previously accepted bytes have no publication checkpoint: ${destination}`);
      const format = options.jsonl ? "jsonl" : "opaque";
      // Copies verified equal to their whole original are recorded in the archive (archive-originals.ts).
      const record = (stamp: string, digest: string, bytes: number) =>
        recordOriginal(options.archiveRoot, sourcePath, destination, stamp, digest, bytes, options);
      if (destinationStamp !== null && state && state.source === provenance && state.sourceStamp === sourceStamp
        && state.destinationStamp === destinationStamp && state.format === format) {
        if (state.acceptedBytes === state.observedSourceBytes && !readOriginalRecord(options.archiveRoot, destination))
          record(sourceStamp, state.acceptedDigest, state.acceptedBytes);
        return "unchanged";
      }
      // Without local state (a new computer, a cleared state folder), a copy whose original still has the
      // path, size and time recorded at its last verification is accepted without reading either file.
      if (destinationStamp !== null && !state && originalUnchanged(options.archiveRoot, sourcePath, destination)) {
        const known = readOriginalRecord(options.archiveRoot, destination)!;
        writeState(paths.state, readArchiveIdentity(options.archiveRoot), paths.relative, provenance, format, sourceStamp, destination,
          known.digest, known.bytes, known.bytes, known.bytes);
        return "unchanged";
      }

      const archiveId = readArchiveIdentity(options.archiveRoot);
      if (options.jsonl) {
        const trusted=state?.format==="jsonl"&&state.destinationStamp===destinationStamp?state:null;
        // A copy this computer holds no state for: one side-by-side read decides whether it is
        // already the original (or the original's longer self) without parsing what it holds.
        if (!trusted && destinationStamp !== null) {
          const compared = compareWithArchived(sourcePath, destination);
          if (compared.prefixEqual && compared.destinationEndsRecord && compared.sourceBytes >= compared.destinationBytes) {
            if (compared.sourceBytes === compared.destinationBytes) {
              // The copy is the original.
              record(sourceStamp, compared.destinationDigest, compared.destinationBytes);
              writeState(paths.state, archiveId, paths.relative, provenance, "jsonl", sourceStamp, destination,
                compared.destinationDigest, compared.destinationBytes, compared.sourceBytes, compared.sourceBytes);
              return "unchanged";
            }
            // The original grew: only its records past the accepted copy are parsed.
            const grown = inspectJsonl(sourcePath, false, compared.destinationBytes);
            if (grown.prefixDigest === compared.destinationDigest) {
              const changed = grown.publishableBytes > compared.destinationBytes;
              if (changed) replaceWithPrefix(sourcePath, destination, grown.publishableBytes, grown.publishableDigest, grown.stamp, destinationStamp);
              if (changed && grown.publishableBytes === grown.bytes) record(grown.stamp, grown.publishableDigest, grown.publishableBytes);
              writeState(paths.state, archiveId, paths.relative, provenance, "jsonl", grown.stamp, destination,
                changed ? grown.publishableDigest : compared.destinationDigest, changed ? grown.publishableBytes : compared.destinationBytes,
                grown.bytes, grown.publishableBytes);
              return changed ? "copied" : "unchanged";
            }
          }
          // A shorter original, a divergence or an unusual copy takes the full path below, which
          // keeps the accepted archive and decides between an adoptable rewrite and a conflict.
        }
        const observed = inspectJsonl(sourcePath,false,destinationStamp===null&&state?.format==="jsonl"
          ? state.acceptedBytes : trusted?.acceptedBytes??0);
        if (destinationStamp === null && state) {
          if (state.source !== provenance || state.format !== "jsonl"
            || observed.publishableBytes < state.acceptedBytes
            || (state.acceptedBytes > 0 && observed.prefixDigest !== state.acceptedDigest))
            throw new Error(`Archived JSONL is missing and the original cannot prove its accepted prefix: ${destination}`);
        }
        if (observed.publishableBytes === 0 && observed.incompleteTail && destinationStamp === null) {
          throw new Error(`Incomplete first JSONL record; archive publication deferred: ${sourcePath}`);
        }
        const accepted = destinationStamp === null ? null : trusted ? {bytes:trusted.acceptedBytes} : inspectJsonl(destination, true);
        let adopted = false;
        if (accepted) {
          const common = Math.min(observed.publishableBytes, accepted.bytes);
          const matches=trusted&&observed.publishableBytes>=trusted.acceptedBytes
            ? trusted.acceptedBytes===0||observed.prefixDigest===trusted.acceptedDigest
            : prefixMatches(sourcePath,destination,common);
          if (!matches) {
            // A rewrite that still carries every accepted accounted record is adopted,
            // and the reading it replaces is kept beside it, so no original is lost.
            if (!rewriteMayBeAdopted(options.archiveRoot, destination, sourcePath, observed.publishableBytes, accepted.bytes))
              preserveConflict(sourcePath, destination, "source no longer has the accepted JSONL prefix",true);
            preserveSupersededReading(destination);
            adopted = true;
          }
        }
        let changed = false;
        if (!accepted || adopted || observed.publishableBytes > accepted.bytes) {
          replaceWithPrefix(sourcePath, destination, observed.publishableBytes, observed.publishableDigest,
            observed.stamp, destinationStamp);
          changed = true;
        }
        const acceptedBytes = changed ? observed.publishableBytes : accepted!.bytes;
        const acceptedDigest = changed ? observed.publishableDigest
          : state?.destinationStamp === destinationStamp && state.acceptedBytes === acceptedBytes
            ? state.acceptedDigest : fileDigest(destination);
        if (acceptedBytes === observed.bytes) record(observed.stamp, acceptedDigest, acceptedBytes);
        writeState(paths.state, archiveId, paths.relative, provenance, "jsonl", observed.stamp, destination,
          acceptedDigest, acceptedBytes, observed.bytes, observed.publishableBytes);
        return changed ? "copied" : "unchanged";
      }

      const sourceDigest = fileDigest(sourcePath);
      if (fileStamp(sourcePath) !== sourceStamp) throw new Error(`Archive source changed while reading: ${sourcePath}`);
      const sourceBytes = fs.statSync(sourcePath).size;
      if (destinationStamp === null) {
        if (state && (state.source !== provenance || state.format !== "opaque"
          || sourceDigest !== state.acceptedDigest || sourceBytes !== state.acceptedBytes))
          throw new Error(`Archived source is missing and the original cannot prove its accepted bytes: ${destination}`);
        atomicArchiveCopy(sourcePath, destination, sourceDigest);
        record(sourceStamp, sourceDigest, sourceBytes);
        writeState(paths.state, archiveId, paths.relative, provenance, "opaque", sourceStamp, destination,
          sourceDigest, sourceBytes, sourceBytes, sourceBytes);
        return "copied";
      }
      const destinationDigest = fileDigest(destination);
      if (fileStamp(destination) !== destinationStamp) throw new Error(`Archive destination changed during publication: ${destination}`);
      if (sourceDigest !== destinationDigest) {
        preserveConflict(sourcePath, destination, "opaque source changed and has no append contract");
      }
      const bytes = fs.statSync(destination).size;
      record(sourceStamp, destinationDigest, bytes);
      writeState(paths.state, archiveId, paths.relative, provenance, "opaque", sourceStamp, destination,
        destinationDigest, bytes, sourceBytes, sourceBytes);
      return "unchanged";
    });
  });
}

/** One accepted history, even when OneDrive delivers codec transitions in separate operations. */
function publishEncodedJsonlArchive(source: string, destination: string, options: ArchivePublicationOptions): "copied" | "unchanged" {
  if (compressedArchiveSource(source) !== compressedArchiveSource(destination)) throw new Error("Archive destination must keep the source codec");
  return withArchiveWriter(options.archiveRoot, () => {
    const paths = archivePublicationPaths(options.archiveRoot, destination, options);
    return withLocalArchiveLock(paths.lock, () => {
      const guardArchiveSource = () => {
        const expected = options.expectedArchiveSource;
        if (!expected) return;
        const guarded = archivePublicationPaths(options.archiveRoot, expected.file, options);
        if (guarded.relative !== paths.relative || fileStamp(expected.file) !== expected.stamp)
          throw new Error(`Archive source changed before compression publication: ${expected.file}`);
      };
      guardArchiveSource();
      const sourceStamp = fileStamp(source);
      if (!sourceStamp) throw new Error(`Archive source disappeared: ${source}`);
      const acceptedFiles = archiveRepresentations(destination);
      const state = readState(paths.state, paths.relative);
      if (!options.representationOnly && acceptedFiles.length === 1 && state?.representation === paths.relative + (compressedArchiveSource(acceptedFiles[0]!) ? ".zst" : "")
        && state.source === path.resolve(options.provenance ?? source) && state.sourceStamp === sourceStamp
        && state.destinationStamp === fileStamp(acceptedFiles[0]!)) return "unchanged";
      if (!acceptedFiles.length && !state && [archiveSourceIdentity(destination), `${archiveSourceIdentity(destination)}.zst`]
        .some(file => acceptedArchiveFingerprint(options.archiveRoot, file, options.localStateRoot)))
        throw new Error(`Archived source is missing and its accepted bytes have no publication checkpoint: ${destination}`);
      return withDecodedArchiveFiles([source, ...acceptedFiles], (decoded, assertStable) => {
        const observed = inspectJsonl(decoded[0]!);
        if (compressedArchiveSource(source) && observed.incompleteTail)
          throw new Error(`Incomplete compressed JSONL; archive publication deferred: ${source}`);
        if (!observed.publishableBytes && observed.incompleteTail)
          throw new Error(`Incomplete first JSONL record; archive publication deferred: ${source}`);
        const accepted = acceptedFiles.map((file, index) => ({ file, decoded: decoded[index + 1]!,
          stamp: fileStamp(file)!, storageDigest: fileDigest(file), inspection: inspectJsonl(decoded[index + 1]!, true) }));
        accepted.sort((a, b) => b.inspection.bytes - a.inspection.bytes
          || Number(compressedArchiveSource(b.file)) - Number(compressedArchiveSource(a.file)));
        const longest = accepted[0];
        if (accepted.some(item => !prefixMatches(item.decoded, longest!.decoded, item.inspection.bytes)))
          throw new Error(`Conflicting archive representations: ${archiveSourceIdentity(destination)}`);
        if (state) {
          const bytes = state.logicalBytes ?? state.acceptedBytes;
          const digest = state.logicalDigest ?? state.acceptedDigest;
          const candidates = [
            { file: decoded[0]!, bytes: observed.publishableBytes },
            ...accepted.map(item => ({ file: item.decoded, bytes: item.inspection.bytes })),
          ];
          if (!candidates.some(candidate => candidate.bytes >= bytes
            && (!bytes || inspectJsonl(candidate.file, false, bytes).prefixDigest === digest)))
            throw new Error(`Archived JSONL is missing and the original cannot prove its accepted prefix: ${destination}`);
        }
        let adopted = false;
        if (options.representationOnly && (!longest || longest.inspection.bytes !== observed.publishableBytes
          || longest.inspection.publishableDigest !== observed.publishableDigest))
          throw new Error(`Archive compression candidate is not the exact accepted history: ${destination}`);
        if (longest && !prefixMatches(decoded[0]!, longest.decoded, Math.min(observed.publishableBytes, longest.inspection.bytes))) {
          if (!rewriteMayBeAdopted(options.archiveRoot, destination, decoded[0]!, observed.publishableBytes, longest.inspection.bytes, longest.decoded))
            preserveConflict(source, longest.file, "source no longer has the accepted decoded JSONL prefix");
          adopted = true;
        }
        // Retain a longer archive and still checkpoint the unchanged shorter original for cheap later mirrors.
        const retainedLonger = longest && !adopted && observed.publishableBytes < longest.inspection.bytes;
        const logicalBytes = retainedLonger ? longest.inspection.bytes : observed.publishableBytes;
        const logicalDigest = retainedLonger ? longest.inspection.publishableDigest : observed.publishableDigest;
        assertStable();
        guardArchiveSource();
        if (adopted) preserveSupersededReading(longest!.file);
        // Keep compacted cold history when its provider still owns an identical plain original.
        const publishedDestination = retainedLonger ? longest.file : !compressedArchiveSource(source) && longest && compressedArchiveSource(longest.file) && !adopted
          && longest.inspection.bytes === observed.publishableBytes && longest.inspection.publishableDigest === observed.publishableDigest
          ? longest.file : destination;
        const targetStamp = accepted.find(item => item.file === publishedDestination)?.stamp ?? null;
        const sameRepresentation = longest?.file === publishedDestination && !adopted
          && longest.inspection.publishableDigest === logicalDigest;
        const expectedDigest = sameRepresentation ? longest!.storageDigest
          : compressedArchiveSource(source) ? fileDigest(source) : observed.publishableDigest;
        assertStable();
        guardArchiveSource();
        if (!sameRepresentation) {
          if (compressedArchiveSource(source)) atomicArchiveCopy(source, publishedDestination, expectedDigest, targetStamp, sourceStamp);
          else replaceWithPrefix(source, publishedDestination, observed.publishableBytes, observed.publishableDigest, sourceStamp, targetStamp);
        }
        if (fileStamp(source) !== sourceStamp) throw new Error(`Archive source changed while reading: ${source}`);
        const publishedStamp = fileStamp(publishedDestination);
        const bytes = fs.statSync(publishedDestination).size, digest = fileDigest(publishedDestination);
        if (digest !== expectedDigest || fileStamp(publishedDestination) !== publishedStamp || sameRepresentation && publishedStamp !== targetStamp)
          throw new Error(`Archive destination changed during publication: ${destination}`);
        // Checkpoint before retiring the other name: a crash leaves two compatible representations.
        const next: PublicationState = { schema: 1, archiveId: readArchiveIdentity(options.archiveRoot), relative: paths.relative,
          source: path.resolve(options.provenance ?? source), format: "jsonl", sourceStamp, destinationStamp: publishedStamp!,
          acceptedDigest: digest, acceptedBytes: bytes, observedSourceBytes: fs.statSync(source).size,
          publishableSourceBytes: compressedArchiveSource(source) ? fs.statSync(source).size : observed.publishableBytes,
          logicalBytes, logicalDigest,
          representation: paths.relative + (compressedArchiveSource(publishedDestination) ? ".zst" : ""), updatedAt: new Date().toISOString() };
        atomicLocalWrite(paths.state, JSON.stringify(next));
        if (!options.representationOnly && observed.bytes === observed.publishableBytes && fileDigest(source) === digest)
          recordOriginal(options.archiveRoot, source, publishedDestination, sourceStamp, digest, bytes, options);
        for (const item of accepted) if (item.file !== publishedDestination) {
          if (fileStamp(publishedDestination) !== publishedStamp) throw new Error(`Archive destination changed during publication: ${publishedDestination}`);
          if (fileStamp(item.file) !== item.stamp) throw new Error(`Archive destination changed during publication: ${item.file}`);
          withArchiveFileWriter(item.file, () => fs.unlinkSync(item.file));
        }
        return sameRepresentation && accepted.length === 1 ? "unchanged" : "copied";
      }, true);
    });
  });
}
