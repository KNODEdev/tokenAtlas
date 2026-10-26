import os from "node:os";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { NewClaudeEvent, NewClaudeLimitHit } from "../db/schema";
import { verifySourceSqliteRead } from "./source-sqlite";
import type { TurnRow } from "./grok-types";
import type { JournalSuffix } from "./gauge-journal";
import type { GenRow, InvariantReport } from "./gemini-types";
import type { OpencodeRow } from "./opencode-types";
import type { CodexFilePreparation } from "./codex-storage";

/** Each pure file task a parse worker can run, e.g. a source format "file → rows" (see parse-worker.ts). */
export interface ParseFormats {
  /** Full content fence for immutable native SQLite reads, off the delivery thread. */
  archiveDigest: { input: { file: string }; output: string };
  grok: { input: { file: string; cwd: string | null; strictRead?: boolean }; output: TurnRow[] };
  gaugesJournal: { input: { file: string; offset: number; size: number; maxBytes?: number; includeBytes?: boolean; chunkedTransport?: boolean }; output: JournalSuffix };
  gemini: { input: { file: string; strictRead?: boolean; archivedInput?: boolean; mtimeMs?: number }; output: { rows: GenRow[]; invariant: InvariantReport } };
  opencode: { input: { file: string; archivedInput?: boolean }; output: OpencodeRow[] };
  claude: {
    /** `validate`: the file must be complete, valid JSONL (checked in the parsing read). */
    input: { store: string; file: string; since?: string; validate?: boolean };
    /** `source`: SHA-256 and length of the whole file, from the parsing read. */
    output: { events: NewClaudeEvent[]; limitHits: NewClaudeLimitHit[]; source?: { sha256: string; byteLength: number } };
  };
  /** A whole Codex rollout up to `size` bytes (src/ingest/codex-storage.ts). */
  codex: { input: { file: string; size: number; validate?: boolean }; output: CodexFilePreparation };
  /** The sync queue's content identity of one file (src/sync/file-fingerprint.ts). */
  fingerprint: { input: { file: string }; output: { fingerprint: string } };
  /** Complete, parseable JSONL records of an accepted archive file (src/sync/jsonl-inspection.ts). */
  validateJsonl: { input: { file: string }; output: Record<string, never> };
}
export type ParseFormat = keyof ParseFormats;
export type ParseRequest = { [F in ParseFormat]: { id: number; format: F; input: ParseFormats[F]["input"]; profile?: boolean; snapshot?: boolean; sentEpochMs?: number } }[ParseFormat];
export type ParseResponse = (
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string; code?: string }) & { partial?: boolean; profile?: { sentEpochMs: number; parseMs: number; queueMs: number } };

/** A Bun worker of a TS-only format could not start or died; the caller handles that file itself. */
export class ParseWorkerError extends Error {}
/**
 * The Rust parser is missing, outdated or failed on this file. No TS parser answers instead
 * (user decision 03.10): the file fails alone and stays queued, with this error visible.
 */
export class NativeParserError extends Error {}
/** The parser itself is unavailable (missing, outdated, gone after restarts, pool closed): no file was at fault. */
const unavailable = (message: string) => Object.assign(new NativeParserError(message), { unavailable: true as const });
/** Whether a parse failed because the parser was unavailable rather than because of the file. */
export function parserUnavailable(error: unknown): boolean {
  return error instanceof ParseWorkerError || error instanceof NativeParserError && (error as { unavailable?: boolean }).unavailable === true;
}

/** Worker count for file parsing; zero requests one native thread. */
export function parseWorkerCount(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TOKENATLAS_PARSE_WORKERS;
  const configured = Number(raw);
  if (raw !== undefined && raw.trim() !== "" && Number.isInteger(configured) && configured >= 0) return Math.max(1, configured);
  return Math.max(1, Math.min(8, os.availableParallelism() - 2));
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void }

export function nativeParserBinary(): string {
  return fileURLToPath(new URL(`../../native/tokenatlas-parse/target/release/tokenatlas-parse${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
}
export interface ParsePoolOptions {
  binary?: string;
  profile?: boolean;
}
const NATIVE_RESTARTS = 5;
// A request in flight during this many native crashes is the likely cause and fails alone.
const NATIVE_ATTEMPTS = 2;

/** Bounded native transcript threads; Bun workers only for formats without a native parser. */
export class ParsePool {
  private readonly idle: Worker[] = [];
  private readonly live = new Set<Worker>();
  private bunStarted = false;
  private readonly assigned = new Map<Worker, number>();
  private readonly pending = new Map<number, Pending>();
  private readonly waiting: ParseRequest[] = [];
  readonly timings = { frameAssemblyMs: 0, utf8DecodeMs: 0, jsonParseMs: 0, reconstructionMs: 0,
    workerParseMs: 0, workerDeliveryMs: 0, workerQueueMs: 0, callerQueueMs: 0, receivedBytes: 0 };
  private readonly queuedAt = new Map<number, number>();
  private nextId = 1;
  private closed = false;
  private native: ChildProcessWithoutNullStreams | undefined;
  private nativeStopped: Promise<void> = Promise.resolve();
  private readonly nativeAssigned = new Map<number, ParseRequest>();
  private readonly gaugeChunks = new Map<number, JournalSuffix["lines"]>();
  private readonly nativeFormats = new Set<ParseFormat>(["codex", "claude", "grok", "gaugesJournal", "gemini", "opencode", "archiveDigest"]);
  private prefix = Buffer.alloc(4);
  private prefixBytes = 0;
  private frameLength = 0;
  private frameBytes = 0;
  private frameChunks: Buffer[] = [];

  private nativeUnavailable: string | null = null;
  private nativeRestarts = 0;
  private readonly nativeAttempts = new Map<number, number>();
  /** Requests in flight at a native crash, retried one at a time so a second crash names the file. */
  private readonly suspects: ParseRequest[] = [];

  constructor(private readonly capacity: number, private readonly options: ParsePoolOptions = {}) {
    this.capacity = Math.max(1, capacity);
    this.startNative();
  }

  private startNative() {
    const binary = this.options.binary ?? nativeParserBinary();
    if (!fs.existsSync(binary)) {
      this.nativeUnavailable = `is missing (${binary}); build it with _dev.bat (needs Rust and MSVC build tools)`;
      return;
    }
    try {
      // Bun's test/runtime zone may differ from the OS zone even without a TZ variable.
      const child = spawn(binary, [String(this.capacity)], { stdio: "pipe", windowsHide: true,
        env: { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      this.native = child;
      this.nativeStopped = new Promise(resolve => child.once("close", () => resolve()));
      const lose = (reason: string) => { if (this.native === child) this.loseNative(reason); };
      child.stdout.on("data", (chunk: Buffer) => {
        try { if (this.native === child) this.receiveNative(chunk, child); } catch (error) { lose(error instanceof Error ? error.message : String(error)); }
      });
      // Drain diagnostics so a full stderr pipe cannot stall the protocol.
      child.stderr.resume();
      child.on("error", error => lose(error.message));
      child.stdin.on("error", error => lose(error.message));
      child.on("exit", () => lose("exited"));
    } catch (error) { this.nativeUnavailable = `could not start: ${error instanceof Error ? error.message : String(error)}`; }
  }

  private canRunNative(format: ParseFormat): boolean {
    return this.nativeFormats.has(format);
  }

  private startBunWorkers() {
    if (this.bunStarted || this.closed) return;
    this.bunStarted = true;
    for (let index = 0; index < this.capacity; index++) {
      let worker: Worker;
      try { worker = new Worker(new URL("./parse-worker.ts", import.meta.url).href); }
      catch { break; }
      worker.onmessage = (event: MessageEvent<ParseResponse>) => this.settle(worker, event.data);
      worker.onerror = (event: ErrorEvent) => { event.preventDefault(); this.lose(worker, event.message); };
      worker.addEventListener("close", () => this.lose(worker, "parse worker exited"));
      this.live.add(worker);
      this.idle.push(worker);
    }
  }

  // A native pool keeps its size when the parser is unavailable: requests are refused with the
  // reason, never left to an importer's in-process TS parse.
  get prefetchWindow(): number { return Math.max(this.capacity * 2, Math.min(this.capacity * 16, 64)); }
  get size(): number { return this.capacity; }

  async run<F extends ParseFormat>(format: F, input: ParseFormats[F]["input"]): Promise<ParseFormats[F]["output"]> {
    // Calculations accept standalone archive snapshots only, never provider originals.
    if ((format === "gemini" || format === "opencode") && !(input as { archivedInput?: boolean }).archivedInput) {
      throw new NativeParserError("Archive SQLite inputs before parsing them");
    }
    if ((format === "gemini" || format === "opencode") && (input as ParseFormats["gemini"]["input"]).archivedInput) {
      const file = (input as { file: string }).file;
      return verifySourceSqliteRead(file, () => this.runTask(format,
        format === "gemini" ? { ...input, mtimeMs: fs.statSync(file).mtimeMs } : input),
        () => this.runTask("archiveDigest", { file }));
    }
    return this.runTask(format, input);
  }

  private runTask<F extends ParseFormat>(format: F, input: ParseFormats[F]["input"]): Promise<ParseFormats[F]["output"]> {
    if (this.closed) return Promise.reject(new ParseWorkerError("parse pool closed"));
    if (this.canRunNative(format)) {
      if (!this.native) return Promise.reject(unavailable(`Native parser ${this.nativeUnavailable ?? "is unavailable"}`));
    } else {
      this.startBunWorkers();
      if (this.live.size === 0) return Promise.reject(new ParseWorkerError("parse pool unavailable"));
    }
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    if (this.options.profile) this.queuedAt.set(id, performance.now());
    this.waiting.push({ id, format, input, profile: this.options.profile } as ParseRequest);
    this.dispatch();
    return result as Promise<ParseFormats[F]["output"]>;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, { reject }] of this.pending) { this.pending.delete(id); reject(new ParseWorkerError("parse pool closed")); }
    const workers = [...this.live];
    this.live.clear();
    this.idle.length = 0;
    this.waiting.length = 0;
    this.suspects.length = 0;
    this.nativeAttempts.clear();
    this.queuedAt.clear();
    const native = this.native;
    this.native = undefined;
    this.nativeAssigned.clear();
    this.gaugeChunks.clear();
    // Subscribe at spawn: Bun may emit close during kill, before a late listener is attached.
    if (native) native.kill();
    await this.nativeStopped;
    await Promise.all(workers.map(worker => { try { return worker.terminate(); } catch { return undefined; } }));
  }

  private sendNative(request: ParseRequest) {
    this.noteDispatch(request);
    this.nativeAssigned.set(request.id, request);
    const json = Buffer.from(JSON.stringify(request));
    const frame = Buffer.allocUnsafe(4 + json.length);
    frame.writeUInt32LE(json.length); json.copy(frame, 4);
    try { this.native!.stdin.write(frame); } catch (error) { this.loseNative(error instanceof Error ? error.message : String(error)); }
  }

  private dispatch() {
    // After a crash, suspects run alone before any other native request.
    const isolating = () => this.suspects.length > 0 || [...this.nativeAssigned.keys()].some(id => this.nativeAttempts.has(id));
    if (this.native && this.nativeAssigned.size === 0 && this.suspects.length) this.sendNative(this.suspects.shift()!);
    for (let index = 0; index < this.waiting.length;) {
      const request = this.waiting[index]!;
      if (this.native && this.canRunNative(request.format)) {
        if (isolating() || this.nativeAssigned.size >= this.capacity * 8) { index++; continue; }
        this.waiting.splice(index, 1);
        this.sendNative(request);
      } else if (this.idle.length) {
        this.waiting.splice(index, 1);
        const worker = this.idle.pop()!;
        this.noteDispatch(request);
        this.assigned.set(worker, request.id);
        worker.postMessage(request);
      } else { index++; }
    }
  }

  private receiveNative(chunk: Buffer, child: ChildProcessWithoutNullStreams) {
    let offset = 0;
    // A restart during partial delivery must discard the old child's remaining frames.
    while (offset < chunk.length && this.native === child) {
      if (this.prefixBytes < 4) {
        const count = Math.min(4 - this.prefixBytes, chunk.length - offset);
        chunk.copy(this.prefix, this.prefixBytes, offset, offset + count);
        this.prefixBytes += count; offset += count;
        if (this.prefixBytes < 4) continue;
        this.frameLength = this.prefix.readUInt32LE();
        if (this.frameLength === 0) throw new Error("empty native response");
      }
      const count = Math.min(this.frameLength - this.frameBytes, chunk.length - offset);
      if (count) this.frameChunks.push(chunk.subarray(offset, offset + count));
      this.frameBytes += count; offset += count;
      if (this.frameBytes !== this.frameLength) continue;
      const assemblyStart = performance.now();
      const frame = Buffer.concat(this.frameChunks, this.frameLength);
      if (this.options.profile) { this.timings.frameAssemblyMs += performance.now() - assemblyStart; this.timings.receivedBytes += frame.length; }
      this.prefixBytes = 0; this.frameBytes = 0; this.frameChunks = [];
      const decodeStart = performance.now();
      const json = frame.toString("utf8");
      const parseStart = performance.now();
      const response = JSON.parse(json) as ParseResponse;
      if (this.options.profile) { this.timings.utf8DecodeMs += parseStart - decodeStart; this.timings.jsonParseMs += performance.now() - parseStart; }
      const request = this.nativeAssigned.get(response.id);
      if (!request || typeof response.ok !== "boolean") throw new Error("invalid native response");
      if (!response.partial) this.nativeAssigned.delete(response.id);
      if (!response.ok && response.code === "unsupported") {
        this.nativeAttempts.delete(response.id);
        this.pending.get(response.id)?.reject(unavailable(
          `Native parser does not support ${request.format}; rebuild it with _dev.bat`));
        this.pending.delete(response.id);
      }
      else {
        if (!response.partial) this.nativeAttempts.delete(response.id);
        const pending = this.pending.get(response.id);
        if (!response.partial) this.pending.delete(response.id);
        if (response.ok) {
          if (request.format === "gaugesJournal") {
            const started = performance.now();
            const suffix = response.value as JournalSuffix;
            if (this.options.profile) this.timings.reconstructionMs += performance.now() - started;
            const lines = suffix.lines as JournalSuffix["lines"];
            const accumulated = this.gaugeChunks.get(response.id) ?? [];
            if (response.partial || accumulated.length) {
              for (const line of lines) accumulated.push(line);
              if (response.partial) this.gaugeChunks.set(response.id, accumulated);
              else { suffix.lines = accumulated; this.gaugeChunks.delete(response.id); }
            }
          }
          if (!response.partial) pending?.resolve(response.value);
        }
        // A file the Rust parser rejects fails alone (e.g. invalid JSONL), with its code kept.
        else pending?.reject(Object.assign(new NativeParserError(response.message), response.code ? { code: response.code } : {}));
      }
      this.dispatch();
    }
  }

  private loseNative(reason: string) {
    const child = this.native;
    if (!child) return;
    this.native = undefined;
    this.prefixBytes = 0; this.frameBytes = 0; this.frameChunks = [];
    const inFlight = [...this.nativeAssigned.values()];
    this.nativeAssigned.clear();
    this.gaugeChunks.clear();
    try { child.kill(); } catch { /* already gone */ }
    if (this.closed) return;
    const fail = (request: ParseRequest, message: string, fileAtFault = false) => {
      this.nativeAttempts.delete(request.id);
      this.pending.get(request.id)?.reject(fileAtFault ? new NativeParserError(message) : unavailable(message)); this.pending.delete(request.id);
    };
    // Files in flight are retried one at a time on a restarted parser; a retried file that crashes
    // it again was alone in flight, so it fails alone and the others continue.
    for (const request of inFlight) {
      const attempts = (this.nativeAttempts.get(request.id) ?? 0) + 1;
      this.nativeAttempts.set(request.id, attempts);
      if (attempts >= NATIVE_ATTEMPTS) fail(request, `Native parser ${reason} while parsing this file`, true);
      else this.suspects.push(request);
    }
    if (this.nativeRestarts < NATIVE_RESTARTS) { this.nativeRestarts++; this.startNative(); }
    else this.nativeUnavailable = `${reason} after ${NATIVE_RESTARTS} restarts`;
    if (!this.native) {
      for (const request of this.suspects.splice(0)) fail(request, `Native parser ${this.nativeUnavailable ?? reason}`);
      for (let index = this.waiting.length - 1; index >= 0; index--) {
        const request = this.waiting[index]!;
        if (!this.canRunNative(request.format)) continue;
        this.waiting.splice(index, 1);
        fail(request, `Native parser ${this.nativeUnavailable ?? reason}`);
      }
    }
    this.dispatch();
  }

  private noteDispatch(request: ParseRequest) {
    if (!this.options.profile) return;
    this.timings.callerQueueMs += performance.now() - (this.queuedAt.get(request.id) ?? performance.now());
    this.queuedAt.delete(request.id);
    request.sentEpochMs = performance.timeOrigin + performance.now();
  }

  async profileSnapshot(): Promise<unknown> {
    if (this.pending.size) throw new Error("profile snapshot requires a drained pool");
    if (this.native) {
      const id = this.nextId++;
      const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
      this.nativeAssigned.set(id, { id, format: "codex", input: { file: "", size: 0 } });
      const json = Buffer.from(JSON.stringify({ id, format: "profile" }));
      const frame = Buffer.allocUnsafe(json.length + 4); frame.writeUInt32LE(json.length); json.copy(frame, 4);
      this.native.stdin.write(frame);
      return result;
    }
    const workers = this.idle.splice(0);
    return Promise.all(workers.map(worker => {
      const id = this.nextId++;
      this.assigned.set(worker, id);
      const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
      worker.postMessage({ id, format: "codex", input: { file: "", size: 0 }, snapshot: true });
      return result;
    }));
  }

  private settle(worker: Worker, response: ParseResponse) {
    if (this.options.profile && response.profile) {
      this.timings.workerParseMs += response.profile.parseMs;
      this.timings.workerQueueMs += response.profile.queueMs;
      this.timings.workerDeliveryMs += Math.max(0, performance.timeOrigin + performance.now() - response.profile.sentEpochMs);
    }
    const pending = this.pending.get(response.id);
    this.pending.delete(response.id);
    this.assigned.delete(worker);
    if (this.live.has(worker)) this.idle.push(worker);
    if (pending) {
      if (response.ok) pending.resolve(response.value);
      else pending.reject(Object.assign(new Error(response.message), response.code ? { code: response.code } : {}));
    }
    this.dispatch();
  }

  private lose(worker: Worker, message: string) {
    if (!this.live.delete(worker)) return;
    const index = this.idle.indexOf(worker);
    if (index >= 0) this.idle.splice(index, 1);
    const id = this.assigned.get(worker);
    this.assigned.delete(worker);
    const failed = new ParseWorkerError(message);
    if (id !== undefined) { this.pending.get(id)?.reject(failed); this.pending.delete(id); }
    if (this.live.size === 0) for (let index = this.waiting.length - 1; index >= 0; index--) {
      const request = this.waiting[index]!;
      if (this.native && this.canRunNative(request.format)) continue;
      this.waiting.splice(index, 1);
      this.pending.get(request.id)?.reject(failed); this.pending.delete(request.id);
    }
    this.dispatch();
    try { worker.terminate(); } catch { /* already gone */ }
  }
}

/**
 * Lets a synchronous writer hand the event loop back so parser output drains between files.
 * `Bun.sleep(0)` waits for a timer tick (about 1.5 ms on Windows): 20 s over 14,000 files.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * Starts work for the next items in a bounded window, so parsing runs ahead of an
 * ordered consumer. `start` returns undefined for items it does not want to prefetch.
 */
export class OrderedPrefetch<T, R> {
  private readonly started = new Map<number, Promise<R>>();
  private next = 0;

  constructor(private readonly items: readonly T[], private readonly window: number,
    private readonly start: (item: T) => Promise<R> | undefined) {}

  /** Fills the window from `index` on and claims the work started for `index`, if any. */
  take(index: number): Promise<R> | undefined {
    if (this.next < index) this.next = index;
    while (this.next < this.items.length && this.started.size < this.window) {
      const work = this.start(this.items[this.next]!);
      // Observed by the consumer when claimed; unclaimed work must not surface as unhandled.
      if (work) { work.catch(() => undefined); this.started.set(this.next, work); }
      this.next++;
    }
    const claimed = this.started.get(index);
    this.started.delete(index);
    return claimed;
  }
}
