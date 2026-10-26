import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createTemporaryWorkspace } from "../config/temporary-storage";
import { resolveDbPath } from "../db";
import { nativeParserBinary, yieldToEventLoop } from "../ingest/parse-pool";
import { withDecodedArchiveFiles, withArchiveDecodeCache } from "../ingest/archive-codec";
import { archiveCodecSource, type ArchiveCodecVendor } from "../shared/archive-codec-path";
import { assertSafeArchiveRelative, containedArchivePath, isRecoverableArchiveSource } from "./archive-source-path";
import { archiveLocalStateDirectory, atomicLocalWrite, readArchiveIdentity, withLocalArchiveLock, type ArchiveLocalStateOptions } from "./archive-local-state";
import { publishArchiveFile } from "./archive-publication";
import { fileStamp, inspectJsonl } from "./jsonl-inspection";
import { forgetOriginal } from "./archive-originals";
import { withArchiveWriter } from "./archive-writers";
import { SyncFileQueue } from "./file-queue";
import { localStateRoot } from "../config/local-identity";

export const ARCHIVE_COMPRESSION_MIN_AGE_MS = 7 * 24 * 3600_000;
export interface ArchiveCompressionOptions extends ArchiveLocalStateOptions {
  archiveRoot: string;
  vendors?: readonly ArchiveCodecVendor[];
  databasePath?: string;
  env?: Record<string, string | undefined>;
}
interface PlannedFile { relative: string; stamp: string; bytes: number }
export interface ArchiveCompressionPlan {
  schema: 1; archiveId: string; createdAt: string; cutoff: number; files: PlannedFile[]; sourceBytes: number;
}
interface Proof { bytes: number; sha256: string; compressedBytes: number }
interface FileProgress { status: "verified" | "compressed" | "skipped" | "retry"; proof?: Proof; reason?: string }
export interface ArchiveCompressionJob {
  schema: 1; jobId: string; archiveId: string; total: number; cursor: number; retries: number[];
  compressed: number; skipped: number; sourceBytes: number; compressedBytes: number;
}
export interface ArchiveCompressionTurn {
  job: ArchiveCompressionJob; status: "pending" | "waiting" | "complete"; attempted: number;
  errors: Array<{ relative: string; message: string }>;
}
const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === "ENOENT";
const exactCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digestPattern = /^[a-f0-9]{64}$/;
const eligible = (relative: string) => !!archiveCodecSource(relative) && /\.jsonl$/i.test(relative) && isRecoverableArchiveSource(relative);

/** Existing installations stay Codex-only until additional providers are explicitly selected. */
export function archiveCompressionVendors(options: ArchiveCompressionOptions): ArchiveCodecVendor[] {
  const requested = options.vendors ?? (options.env ?? process.env).TOKENATLAS_ARCHIVE_COMPRESSION_PROVIDERS?.split(",") ?? ["codex"];
  if (!requested.length || requested.some(vendor => !["codex","claude","grok"].includes(vendor.trim())))
    throw new Error("Archive compression providers must be codex, claude or grok");
  return [...new Set(requested.map(vendor => vendor.trim() as ArchiveCodecVendor))];
}

/** Every plan/apply read checks ancestors again; a saved plan cannot follow a new cloud junction. */
function checkedFile(root: string, relative: string): string {
  assertSafeArchiveRelative(relative);
  if (!eligible(relative)) throw new Error(`Not a compressible archive source: ${relative}`);
  const file = containedArchivePath(root, relative);
  const parts = relative.split("/");
  let current = path.resolve(root);
  if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new Error(`Invalid compression archive root: ${root}`);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Linked or unavailable archive directory: ${current}`);
  }
  return file;
}

/** A metadata-only inventory; ordinary source sync does not start a compression job. */
export function planArchiveCompression(options: ArchiveCompressionOptions, now = Date.now()): ArchiveCompressionPlan {
  if (!Number.isFinite(now)) throw new Error("Invalid compression plan time");
  const root = path.resolve(options.archiveRoot), files: PlannedFile[] = [], cutoff = now - ARCHIVE_COMPRESSION_MIN_AGE_MS;
  const archiveId = readArchiveIdentity(root);
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      entries = fs.readdirSync(directory, { withFileTypes: true });
    }
    catch (cause) { if (missing(cause)) return; throw cause; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (!entry.isFile() || !eligible(relative)) continue;
      checkedFile(root, relative);
      const stamp = fileStamp(file), stat = fs.statSync(file);
      if (!stamp || stat.mtimeMs > cutoff) continue;
      if (!exactCount(stat.size)) throw new Error(`Archive size exceeds exact range: ${file}`);
      files.push({ relative, stamp, bytes: stat.size });
    }
  };
  checkedRoot(root); for (const vendor of archiveCompressionVendors(options)) walk(path.join(root, vendor));
  return { schema: 1, archiveId, createdAt: new Date(now).toISOString(), cutoff, files,
    sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
function checkedRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid compression archive root: ${root}`);
}
function directory(options: ArchiveCompressionOptions, jobId: string): string {
  if (!jobIdPattern.test(jobId)) throw new Error("Invalid archive compression job id");
  return path.join(archiveLocalStateDirectory(options.archiveRoot, options), "compression", jobId);
}
function progressFile(root: string, relative: string): string {
  return path.join(root, "files", `${createHash("sha256").update(relative).digest("hex")}.json`);
}
function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
function validProof(proof: Proof | undefined): boolean {
  return !!proof && exactCount(proof.bytes) && exactCount(proof.compressedBytes) && digestPattern.test(proof.sha256);
}
function readProgress(file: string): FileProgress | null {
  let state: FileProgress;
  try { state = readJson(file); } catch (cause) { if (missing(cause)) return null; throw cause; }
  if (!state || !["verified", "compressed", "skipped", "retry"].includes(state.status)
    || state.proof !== undefined && !validProof(state.proof) || state.status === "compressed" && !validProof(state.proof)
    || state.reason !== undefined && typeof state.reason !== "string") throw new Error(`Invalid compression progress: ${file}`);
  return state;
}
function readJob(options: ArchiveCompressionOptions, jobId: string) {
  const root = directory(options, jobId), plan = readJson<ArchiveCompressionPlan>(path.join(root, "plan.json"));
  const job = readJson<ArchiveCompressionJob>(path.join(root, "state.json"));
  const identity = readArchiveIdentity(options.archiveRoot);
  if (!plan || plan.schema !== 1 || plan.archiveId !== identity || !Array.isArray(plan.files)
    || !Number.isFinite(plan.cutoff) || !Number.isFinite(Date.parse(plan.createdAt)) || !exactCount(plan.sourceBytes)
    || plan.files.some(file => !file || !eligible(file.relative) || typeof file.stamp !== "string" || !exactCount(file.bytes))
    || plan.sourceBytes !== plan.files.reduce((sum, file) => sum + file.bytes, 0)
    || new Set(plan.files.map(file => file.relative)).size !== plan.files.length
    || !job || job.schema !== 1 || job.archiveId !== identity || job.jobId !== jobId || job.total !== plan.files.length
    || ![job.cursor, job.compressed, job.skipped, job.sourceBytes, job.compressedBytes].every(exactCount) || job.cursor > job.total
    || !Array.isArray(job.retries) || job.retries.some(index => !exactCount(index) || index >= job.cursor)
    || new Set(job.retries).size !== job.retries.length
    || job.compressed + job.skipped + job.retries.length !== job.cursor
    || job.sourceBytes > plan.sourceBytes || job.compressedBytes > job.sourceBytes
    || job.compressed === 0 && (job.sourceBytes !== 0 || job.compressedBytes !== 0))
    throw new Error(`Invalid archive compression checkpoint: ${root}`);
  if (job.cursor === job.total && !job.retries.length) {
    let compressed = 0, skipped = 0, sourceBytes = 0, compressedBytes = 0;
    for (const entry of plan.files) {
      const state = readProgress(progressFile(root, entry.relative));
      if (state?.status === "compressed" && state.proof!.bytes === entry.bytes) {
        compressed++; sourceBytes += state.proof!.bytes; compressedBytes += state.proof!.compressedBytes;
      } else if (state?.status === "skipped") skipped++;
      else throw new Error(`Missing completed compression proof: ${entry.relative}`);
    }
    if (compressed !== job.compressed || skipped !== job.skipped || sourceBytes !== job.sourceBytes || compressedBytes !== job.compressedBytes)
      throw new Error(`Compression receipts disagree with its counters: ${root}`);
  }
  return { root, plan, job };
}
export function startArchiveCompression(options: ArchiveCompressionOptions,
  selection: { now?: number; exclude?: ReadonlySet<string> } = {}): ArchiveCompressionJob {
  const plan = planArchiveCompression(options, selection.now);
  if (selection.exclude?.size) {
    plan.files = plan.files.filter(file => !selection.exclude!.has(file.relative));
    plan.sourceBytes = plan.files.reduce((sum, file) => sum + file.bytes, 0);
  }
  const jobId = randomUUID(), root = directory(options, jobId);
  const job: ArchiveCompressionJob = { schema: 1, jobId, archiveId: plan.archiveId, total: plan.files.length, cursor: 0,
    retries: [], compressed: 0, skipped: 0, sourceBytes: 0, compressedBytes: 0 };
  atomicLocalWrite(path.join(root, "plan.json"), JSON.stringify(plan));
  atomicLocalWrite(path.join(root, "state.json"), JSON.stringify(job));
  return job;
}
export function archiveCompressionStatus(options: ArchiveCompressionOptions, jobId: string): ArchiveCompressionTurn {
  const { job } = readJob(options, jobId);
  return { job, status: job.cursor < job.total ? "pending" : job.retries.length ? "waiting" : "complete", attempted: 0, errors: [] };
}

/** Daily inventories exclude work already owned by a durable automatic job. */
export function archiveCompressionPendingFiles(options: ArchiveCompressionOptions, jobId: string): string[] {
  const { plan, job } = readJob(options, jobId);
  return [...job.retries.map(index => plan.files[index]!.relative), ...plan.files.slice(job.cursor).map(file => file.relative)];
}

function verifyCompressed(file: string, proof: Proof, options: ArchiveCompressionOptions): number {
  return withDecodedArchiveFiles([file], ([decoded]) => {
    const reading = inspectJsonl(decoded!, true);
    if (reading.bytes !== proof.bytes || reading.publishableDigest !== proof.sha256)
      throw new Error(`Compressed archive differs from its verified JSONL: ${file}`);
    return fs.statSync(file).size;
  }, false, options);
}

function compressOne(options: ArchiveCompressionOptions, entry: PlannedFile, checkpoint: string,
  notify: (source: string, destination: string) => void): FileProgress {
  const previous = readProgress(checkpoint);
  if (previous?.status === "skipped") return previous;
  const source = checkedFile(options.archiveRoot, entry.relative), destination = `${source}.zst`;
  if (previous?.status === "compressed") { notify(source, destination); return previous; }
  const stamp = fileStamp(source);
  if (!stamp) {
    if (!previous?.proof) {
      if (fileStamp(destination)) return { status: "skipped", reason: "archive representation changed since the cold-file inventory" };
      throw new Error(`Archive JSONL unavailable without a compression proof: ${source}`);
    }
    const compressedBytes = verifyCompressed(destination, previous.proof, options);
    withArchiveWriter(options.archiveRoot, () => forgetOriginal(options.archiveRoot, source, options));
    notify(source, destination);
    return { status: "compressed", proof: { ...previous.proof, compressedBytes } };
  }
  if (stamp !== entry.stamp) return { status: "skipped", reason: "archive changed since the cold-file inventory" };
  const original = inspectJsonl(source, true);
  if (original.stamp !== entry.stamp || original.bytes !== entry.bytes) throw new Error(`Archive changed during compression inspection: ${source}`);
  const workspace = createTemporaryWorkspace("archive-compression", options.databasePath ?? resolveDbPath(), options.env);
  try {
    const candidate = path.join(workspace.directory, "candidate.jsonl.zst");
    const encoded = spawnSync(nativeParserBinary(), ["--encode-rollout", source, candidate], { windowsHide: true, encoding: "utf8" });
    if (encoded.error || encoded.status !== 0) throw new Error(`Cannot compress archive JSONL: ${encoded.error?.message ?? encoded.stderr.trim()}`);
    const proof: Proof = { bytes: original.bytes, sha256: original.publishableDigest, compressedBytes: fs.statSync(candidate).size };
    if (proof.compressedBytes >= proof.bytes) return { status: "skipped", reason: "Zstandard does not reduce this file" };
    verifyCompressed(candidate, proof, options);
    if (fileStamp(source) !== entry.stamp) throw new Error(`Archive changed during compression: ${source}`);
    // This proof survives a crash after publication/retirement, even when scratch has disappeared.
    atomicLocalWrite(checkpoint, JSON.stringify({ status: "verified", proof } satisfies FileProgress));
    checkedFile(options.archiveRoot, entry.relative);
    publishArchiveFile(candidate, destination, { ...options, jsonl: true, representationOnly: true,
      provenance: source, expectedArchiveSource: { file: source, stamp: entry.stamp } });
    const compressedBytes = verifyCompressed(destination, proof, options);
    if (fileStamp(source) !== null) throw new Error(`Archive compression retirement is unfinished: ${source}`);
    withArchiveWriter(options.archiveRoot, () => forgetOriginal(options.archiveRoot, source, options));
    notify(source, destination);
    return { status: "compressed", proof: { ...proof, compressedBytes } };
  } finally { workspace.dispose(); }
}

/** Bounded, single-worker turns; per-file proofs avoid rewriting a whole plan for each source. */
export function runArchiveCompressionTurn(options: ArchiveCompressionOptions, jobId: string,
  limits: { maxFiles?: number; budgetMs?: number } = {}): ArchiveCompressionTurn {
  const maxFiles = limits.maxFiles ?? 20, budgetMs = limits.budgetMs ?? 1000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 1000 || !Number.isFinite(budgetMs) || budgetMs < 0)
    throw new Error("Invalid archive compression turn limits");
  const root = directory(options, jobId);
  // One turn owns the job; individual publications use the shared archive/source writer protocol.
  const result = withLocalArchiveLock(path.join(root, "job.lock"), () => {
    const { plan, job } = readJob(options, jobId), errors: ArchiveCompressionTurn["errors"] = [];
    const deadline = performance.now() + budgetMs;
    const indices = [...Array.from({ length: Math.min(maxFiles, job.total - job.cursor) }, (_, offset) => job.cursor + offset),
      ...job.retries].slice(0, maxFiles);
    let queue: SyncFileQueue | undefined;
    const notify = (source: string, destination: string) => {
      queue ??= new SyncFileQueue(options.archiveRoot, options.localStateRoot ?? localStateRoot(options.env));
      // Owner writes are suppressed by the watcher, so notify the durable queue explicitly.
      const vendor = archiveCodecSource(path.relative(options.archiveRoot,source).split(path.sep).join("/"))!.vendor;
      queue.enqueue(source, vendor); queue.enqueue(destination, vendor);
    };
    let attempted = 0;
    try {
      for (const index of indices) {
        if (attempted && performance.now() >= deadline) break;
        const entry = plan.files[index]!, checkpoint = progressFile(root, entry.relative);
        let state: FileProgress;
        try { state = withArchiveDecodeCache(() => compressOne(options, entry, checkpoint, notify)); }
        catch (cause) {
          const prior = readProgress(checkpoint);
          state = { status: "retry", ...(prior?.proof ? { proof: prior.proof } : {}), reason: String(cause) };
          if (errors.length < 20) errors.push({ relative: entry.relative, message: state.reason! });
        }
        atomicLocalWrite(checkpoint, JSON.stringify(state));
        job.retries = job.retries.filter(value => value !== index);
        if (state.status === "retry") job.retries.push(index);
        else if (state.status === "compressed") { job.compressed++; job.sourceBytes += state.proof!.bytes; job.compressedBytes += state.proof!.compressedBytes; }
        else if (state.status === "skipped") job.skipped++;
        if (index === job.cursor) job.cursor++;
        atomicLocalWrite(path.join(root, "state.json"), JSON.stringify(job)); attempted++;
      }
    } finally { queue?.close(); }
    return { job, status: job.cursor < job.total ? "pending" : job.retries.length ? "waiting" : "complete", attempted, errors } as ArchiveCompressionTurn;
  });
  return result;
}

export async function advanceArchiveCompression(options: ArchiveCompressionOptions, jobId: string,
  limits: { maxFiles?: number; budgetMs?: number } = {}): Promise<ArchiveCompressionTurn> {
  const result = runArchiveCompressionTurn(options, jobId, limits);
  await yieldToEventLoop();
  return result;
}
