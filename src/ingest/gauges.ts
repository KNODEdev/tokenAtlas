import { fileParseTask, runFileTasks, type FileParseTask } from "./file-parse-tasks";
import type { CanonicalProbe } from "../db/probe-facts";
import { acceptProbeFact, backfillProbeFacts, hasHandledProbeProjection, hasProbeFacts, legacyJournalProbe, mapProbeLegacy, ProbeFactConflict, quarantineProbeConflict, recordProbeDelivery, validateCanonicalProbe } from "../db/probe-facts";
import { acceptJournalEntry, journalEntryId } from "../providers/core/journal-receipts";
import { directChanges } from "../db/change-count";
import { Database } from "../db/sqlite";
import { applyConnectionSettings } from "../db/index";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { prefixHash, type JournalSuffix } from "./gauge-journal";
import { gaugeStageEvidence } from "../sync/gauge-stage-evidence";
import { exactFiles, isSourceConflict } from "./exact-files";
import path from "node:path";
import { ARCHIVE_ROOT, PROFILE } from "../config/paths";
import {
  PROBE_JOURNAL_FILE,
  type ProbeJournalRow,
} from "../providers/core/journal";
import { JOURNAL_KINDS, journalKindOf, listJournalFiles } from "../providers/core/journal-files";
import { compactProbeBase, expandCompactProbe, isCompactProbeRecord } from "../providers/core/journal-compact";
import { GaugeFirstFill } from "./gauge-first-fill";
import { hasCustomProbeTriggers } from "../db/probe-facts";
import { IngestTimer, type IngestTimingHandler, type IngestTimings } from "./ingest-timings";
import { asSchemaWriter } from "../db/schema-writer";

export const GAUGES_ARCHIVE_DIRECTORY = "gauges";
type JournalFile = (typeof JOURNAL_KINDS)[number];

export interface GaugeIngestOptions {
  firstFill?:boolean;
  onTimings?:IngestTimingHandler;
  atlasPath: string;
  // Re-read every journal from the start, the local machine's own included.
  force: boolean;
  /** Archive rebuilds inspect the local journal too, without forcing a prefix replay. */
  includeOwnStore?: boolean;
  archiveRoot?: string;
  ownStore?: string;
  now?: () => string;
  files?: string[];
  /** Sparse stages read accepted evidence on demand from this database. */
  evidenceDbPath?: string;
  onFileProgress?: (completed: number, total: number) => void;
}

export interface GaugeFileResult {
  store: string;
  /** The file as named in the store: the unsuffixed journal or one of its segments. */
  file: string;
  skipped: boolean;
  rows: number;
  malformed: number;
  fromOffset: number;
  toOffset: number;
  readLines: number;
}

export interface GaugeIngestResult {
  failedInputs?:Array<{path:string;error:string}>;
  processedFiles?:string[];
  timings?:IngestTimings;
  files: number;
  skipped: number;
  rows: number;
  malformed: number;
  stores: string[];
  details: GaugeFileResult[];
}

interface Bookmark {
  size: number;
  mtime: number;
  offset: number;
  rows: number;
  prefix_sha256: string | null;
}
class PendingGaugeInput extends Error {}

export function ensureGaugeBookmarkSchema(sqlite: Database): void {
  asSchemaWriter(sqlite, () => {
    const columns = sqlite.query("PRAGMA table_info(gauge_files)").all() as { name: string }[];
    if (columns.length && !columns.some(column => column.name === "prefix_sha256"))
      sqlite.exec("ALTER TABLE gauge_files ADD COLUMN prefix_sha256 TEXT");
  });
}

// Which file it is, how much it holds and when that was written. The change time
// is left out on purpose: a cloud client touching attributes or hydration of an
// untouched journal must not read as an append, and the accepted position is the
// (size, mtime, offset, prefix hash) tuple below.
const fileStamp = (stat: fs.Stats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs]);

export function listGaugeStores(archiveRoot: string): string[] {
  try {
    return fs
      .readdirSync(path.join(archiveRoot, GAUGES_ARCHIVE_DIRECTORY), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isSourceConflict(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** A fact already accepted into this database, as the canonical probe it was accepted from. */
function acceptedProbe(sqlite: Database, counterId: string): CanonicalProbe | null {
  const row = sqlite.query(`SELECT c.observation_id, c.discriminator, c.payload, c.payload_digest, o.header
    FROM probe_counters c JOIN probe_observations o ON o.id = c.observation_id WHERE c.id = ?`).get(counterId) as
    { observation_id: string; discriminator: string; payload: string; payload_digest: string; header: string } | null;
  return row && { version: 1, observation_id: row.observation_id, counter_id: counterId, header: JSON.parse(row.header),
    discriminator: JSON.parse(row.discriminator), payload: JSON.parse(row.payload), payload_digest: row.payload_digest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function num(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseProbeRow(line: string, store: string, parsed?: Record<string, unknown>): ProbeJournalRow | null {
  let value: unknown = parsed;
  if (!parsed) {
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const provider = str(value, "provider");
  const subject = str(value, "subject");
  const ts = str(value, "ts");
  const kind = str(value, "kind");
  const side = str(value, "reported_percent_side");
  if (!provider || !subject || !ts || !kind || !side) return null;
  return {
    provider,
    subject,
    ts,
    plan: str(value, "plan"),
    kind,
    limit_group: str(value, "limit_group"),
    scope: str(value, "scope"),
    reported_percent_side: side,
    used_percent: num(value, "used_percent"),
    remaining_percent: num(value, "remaining_percent"),
    vendor_percent: num(value, "vendor_percent"),
    window_minutes: num(value, "window_minutes"),
    allowance: num(value, "allowance"),
    used: num(value, "used"),
    remaining: num(value, "remaining"),
    resets_at: str(value, "resets_at"),
    rate_limit_reached: num(value, "rate_limit_reached"),
    reset_credits: num(value, "reset_credits"),
    profile: str(value, "profile"),
    ok: num(value, "ok"),
    error: str(value, "error"),
    extra: str(value, "extra"),
    machine: str(value, "machine") ?? store,
    login: str(value, "login") ?? "",
    source_home: str(value, "source_home"),
    raw_subject: str(value, "raw_subject") ?? subject,
  };
}

/**
 * Ingests the gauge journals of every machine in the archive into `atlasPath`
 * (normally the sync stage). Rows are appended with INSERT OR IGNORE; the
 * cross-run dedupe against the live table happens at publish time.
 *
 * The local machine's own journal is skipped unless explicitly included: its rows were
 * written to the live table by the probe itself, so re-reading them only
 * matters after the index was rebuilt from scratch.
 */
function* ingestGaugesSteps(options: GaugeIngestOptions): Generator<FileParseTask<JournalSuffix>, GaugeIngestResult, JournalSuffix> {
  const timer=new IngestTimer(options.onTimings),discoveryEnd=timer.begin("discoveryMs","discoveryMs");
  const archiveRoot = options.archiveRoot ?? ARCHIVE_ROOT;
  const ownStore = options.ownStore ?? PROFILE;
  const now = options.now ?? (() => new Date().toISOString());
  const result: GaugeIngestResult = { files: 0, skipped: 0, rows: 0, malformed: 0, stores: [], details: [] };
  const failedInputs:Array<{path:string;error:string}>=[],processedFiles:string[]=[];
  const selected = options.files === undefined ? undefined : exactFiles(options.files, path.join(archiveRoot, GAUGES_ARCHIVE_DIRECTORY));
  const selectedStores = new Map<string, string[]>();
  for (const file of selected ?? []) {
    const relative = path.relative(path.resolve(archiveRoot, GAUGES_ARCHIVE_DIRECTORY), file).split(path.sep);
    if (relative.length !== 2 || !journalKindOf(relative[1]!)) throw new Error(`Invalid gauge journal path: ${file}`);
    selectedStores.set(relative[0]!, [...(selectedStores.get(relative[0]!) ?? []), relative[1]!]);
  }
  const journals = [...(selected === undefined ? listGaugeStores(archiveRoot) : selectedStores.keys())]
    .filter(store => !(store === ownStore && !options.force && !options.includeOwnStore && selected === undefined))
    .map(store => ({ store, files: selected === undefined
      ? JOURNAL_KINDS.flatMap(kind => listJournalFiles(path.join(archiveRoot, GAUGES_ARCHIVE_DIRECTORY, store), kind))
      : selectedStores.get(store)! }));
  const totalFiles = journals.reduce((total, item) => total + item.files.length, 0);
  let completedFiles = 0;
  options.onFileProgress?.(0, totalFiles);
  const sqlite = new Database(options.atlasPath);
  // Default rollback journaling with a full fsync more than doubled the per-line write cost.
  applyConnectionSettings(sqlite);
  discoveryEnd();
  let evidence: ReturnType<typeof gaugeStageEvidence> | undefined;
  try {
    evidence = options.evidenceDbPath ? gaugeStageEvidence(sqlite, options.evidenceDbPath) : undefined;
    ensureGaugeBookmarkSchema(sqlite);
    timer.step("backfillsMs",()=>backfillProbeFacts(sqlite));
    const bulkTables=["gauge_journal_receipts","probe_observations","probe_counters","probe_fact_deliveries","probe_fact_legacy_map"];
    let bulk=options.firstFill && hasProbeFacts(sqlite)
      && !hasCustomProbeTriggers(sqlite,bulkTables)
      && bulkTables.every(table=>!sqlite.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) ? new GaugeFirstFill(sqlite) : undefined;
    // Bulk acceptance reads rows by primary/unique keys only, so the other indexes are built once
    // at the end. The first-fill stage is a scratch file, discarded on failure: no fsync needed.
    const deferredIndexes=bulk?(sqlite.query(`SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL
      AND tbl_name IN (${[...bulkTables,"probe_windows"].map(table=>`'${table}'`).join(",")})`).all() as Array<{name:string;sql:string}>)
      .filter(index=>!/^CREATE\s+UNIQUE\s/i.test(index.sql)):[];
    if(bulk){sqlite.exec("PRAGMA synchronous=OFF");for(const index of deferredIndexes)sqlite.exec(`DROP INDEX "${index.name}"`);}
    // The row-by-row path looks mappings up by these indexes.
    const restoreIndexes=()=>timer.step("indexBuildMs",()=>{for(const index of deferredIndexes.splice(0))sqlite.exec(index.sql);});
    const canonical=hasProbeFacts(sqlite);
    const tracksReplayCounters = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gauge_replay_counters'").get() != null;
    const recordReplayCounter = tracksReplayCounters
      ? sqlite.query("INSERT OR IGNORE INTO gauge_replay_counters (counter_id, ts) VALUES (?, ?)")
      : null;
    const bookmarkOf = sqlite.query(
      "SELECT size, mtime, offset, rows, prefix_sha256 FROM gauge_files WHERE store = ? AND path = ?"
    );
    const saveBookmark = sqlite.query(
      `INSERT INTO gauge_files (store, path, size, mtime, offset, rows, ingested_at, prefix_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store, path) DO UPDATE SET
         size = excluded.size, mtime = excluded.mtime, offset = excluded.offset,
         rows = excluded.rows, ingested_at = excluded.ingested_at, prefix_sha256 = excluded.prefix_sha256`
    );
    const insertProbe = sqlite.query(
      `INSERT OR IGNORE INTO probe_windows
         (provider, subject, ts, plan, kind, limit_group, scope, reported_percent_side,
          used_percent, remaining_percent, vendor_percent, window_minutes, allowance, used,
          remaining, resets_at, rate_limit_reached, reset_credits, profile, ok, error, extra, machine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const { store, files } of journals) {
      let touched = false;
      const storeRoot = path.join(archiveRoot, GAUGES_ARCHIVE_DIRECTORY, store);
      // Probes before observations, as before segmentation; each kind oldest first.
      for (const file of files) {
        // Receipts and canonical checks follow the journal kind; bookmarks follow the file.
        const kind: JournalFile = journalKindOf(file)!;
        const filePath = path.join(storeRoot, file);
        let stat: fs.Stats;
        try {
          stat = timer.step("fileStatMs",()=>fs.lstatSync(filePath));
        } catch (error) {
          if (selected !== undefined) throw error;
          completedFiles++;
          options.onFileProgress?.(completedFiles, totalFiles);
          continue;
        }
        if (!stat.isFile()) {
          completedFiles++;
          options.onFileProgress?.(completedFiles, totalFiles);
          continue;
        }
        touched = true;
        result.files += 1;
        const bookmark = bookmarkOf.get(store, file) as Bookmark | null;
        const previousHash = !options.force && bookmark?.prefix_sha256 && stat.size >= bookmark.offset
          ? timer.step("prefixDigestMs",()=>prefixHash(filePath, bookmark.offset)) : undefined;
        const verifiedPrefix = previousHash && previousHash.copy().digest("hex") === bookmark?.prefix_sha256;
        if (fileStamp(fs.lstatSync(filePath)) !== fileStamp(stat)) {
          failedInputs.push({path:filePath,error:`Gauge journal changed during verification: ${filePath}`});completedFiles++;options.onFileProgress?.(completedFiles,totalFiles);continue;
        }
        if (verifiedPrefix && bookmark && bookmark.size === stat.size && bookmark.mtime === stat.mtimeMs) {
          result.skipped += 1;
          processedFiles.push(filePath);
          result.details.push({
            store, file, skipped: true, rows: 0, malformed: 0,
            fromOffset: bookmark.offset, toOffset: bookmark.offset,
            readLines: 0,
          });
          completedFiles++;
          options.onFileProgress?.(completedFiles, totalFiles);
          continue;
        }
        const fromOffset = verifiedPrefix && bookmark ? bookmark.offset : 0;
        const acceptedHash = verifiedPrefix ? previousHash! : createHash("sha256");
        const progress = { consumed: 0, lines: 0 };
        let rows = 0;
        let malformed = 0;
        try {
          sqlite.exec("BEGIN IMMEDIATE");
          let lineOffset = fromOffset;
          let done = false;
          while (!done) {
            const offset = fromOffset + progress.consumed;
            const parseEnd=timer.begin("journalReadMs","parseMs");
            let batch:JournalSuffix;
            try {batch = yield fileParseTask("gaugesJournal", { file: filePath, offset, size: stat.size, maxBytes: 4 * 1024 * 1024, includeBytes: true });}finally{parseEnd();}
            const linesEnd=timer.begin("lineAcceptanceMs","stageWriteMs");
            try {
            progress.consumed += batch.consumed;
            progress.lines += batch.lines.length;
            done = batch.done;
            for (const bytes of batch.bytes) acceptedHash.update(Buffer.from(bytes, "base64"));
            for (const entry of batch.lines) {
              const { line } = entry;
              const evidenceOffset = lineOffset;
              lineOffset += Buffer.byteLength(line + "\n", "utf8");
              if (!line.trim()) continue;
              // Account observation segments stay in the archive as originals, but who is signed in
              // now comes from the probe readings themselves (account periods), so they are not imported.
              if (kind !== PROBE_JOURNAL_FILE) continue;
              // Never acknowledge a malformed versioned record as ordinary legacy noise.
              // Throwing here preserves this file's facts, receipts and byte bookmark.
              const versioned = journalEntryId(line) != null;
              let raw = entry.raw;
              if (selected !== undefined && !raw) throw new Error("Invalid selected gauge journal JSON record");
              let fact;
              if (raw && isCompactProbeRecord(raw)) {
                // A compact line stands for the flat record and canonical probe it expands to.
                if (!canonical) throw new Error("Compact probe line outside a probe fact journal");
                const baseId = compactProbeBase(raw);
                const bufferedBase=baseId?bulk?.base(baseId):null;
                if(baseId&&!bufferedBase)bulk?.flush();
                if (baseId) evidence?.base(baseId);
                const base = baseId ? bufferedBase ?? acceptedProbe(sqlite, baseId) : null;
                // Files are read oldest first, so a missing base is a file the cloud has not delivered yet.
                if (baseId && !base) throw new Error("Compact probe base not ingested yet");
                raw = expandCompactProbe(raw, base).outer;
              }
              if (raw && Object.keys(raw).some(k => k.startsWith("canonical_"))) {
                const validationStarted=performance.now();
                try {
                  fact = validateCanonicalProbe(raw.canonical_probe, raw);
                }
                catch (e) { throw new ProbeFactConflict(typeof raw.provider === "string" ? raw.provider : "unknown", "", line, (versioned ? "Invalid versioned gauge journal payload; Canonical probe identity conflict: " : "Canonical probe identity conflict: ") + (e as Error).message); }
                finally{timer.detail("canonicalValidationMs",performance.now()-validationStarted);}
              }
              const row = parseProbeRow(line, store, raw ?? undefined);
              if (!row) {
                if (selected !== undefined) throw new Error("Invalid selected gauge probe record");
                if (versioned) throw new Error("Invalid versioned gauge journal payload");
                malformed += 1;
                continue;
              }
              const entryId = journalEntryId(line);
              const evidenceKey = entryId ?? `${store}:${file}:${evidenceOffset}:${line}`;
              evidence?.hydrate(entryId, raw!, evidenceKey, fact);
              const receiptStarted=performance.now();
              const accepted = bulk ? bulk.acceptJournal(line,kind,row.ts) : acceptJournalEntry(sqlite, line, kind, row.ts);
              timer.detail("journalAcceptanceMs",performance.now()-receiptStarted);
              if (canonical) {
                const deliveryStarted=performance.now();
                if (fact) {if(bulk)bulk.acceptFact(fact,true);else acceptProbeFact(sqlite, fact);}
                else fact = bulk ? bulk.legacy(raw!, evidenceKey) : legacyJournalProbe(sqlite, raw!, evidenceKey);
                recordReplayCounter?.run(fact.counter_id, fact.header.ts);
                const key=entryId ?? `${store}:${file}:${evidenceOffset}`,delivery={ payload: line, store, file, offset: evidenceOffset, received_at: now(), received_by: ownStore, role: "receiver" };
                if(bulk)bulk.delivery(fact,key,delivery);else recordProbeDelivery(sqlite,fact,key,delivery);
                timer.detail("factAndDeliveryMs",performance.now()-deliveryStarted);
              }
              if (fact ? bulk ? bulk.handled(fact) : hasHandledProbeProjection(sqlite, fact) : !accepted) continue;
              const written = insertProbe.run(
                row.provider, row.subject, row.ts, row.plan, row.kind, row.limit_group, row.scope,
                row.reported_percent_side, row.used_percent, row.remaining_percent, row.vendor_percent,
                row.window_minutes, row.allowance, row.used, row.remaining, row.resets_at,
                row.rate_limit_reached, row.reset_credits, row.profile, row.ok, row.error, row.extra,
                // A canonical unknown machine must not become the journal folder's name.
                raw?.canonical_probe && fact ? fact.payload.machine ?? null : row.machine
              );
              const changed = directChanges(sqlite);
              if (fact) {
                const id=changed ? Number(written.lastInsertRowid) : null,reason=changed ? "journal-projection" : "legacy-multiplicity-suppressed";
                if(bulk)bulk.map(fact,id,reason);else mapProbeLegacy(sqlite,fact,id,reason);
              }
              rows += changed;
            }
            bulk?.flush();
            } finally {linesEnd();}
          }
          timer.step("filesTableMs",()=>saveBookmark.run(
            store, file, stat.size, stat.mtimeMs, fromOffset + progress.consumed,
            (fromOffset === 0 ? 0 : bookmark?.rows ?? 0) + rows, now(), acceptedHash.digest("hex")
          ),"stageWriteMs");
          if (fileStamp(fs.lstatSync(filePath)) !== fileStamp(stat)) throw new PendingGaugeInput(`Gauge journal changed before checkpoint: ${filePath}`);
          timer.step("commitMs",()=>sqlite.exec("COMMIT"),"stageWriteMs");
        } catch (error) {
          if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
          evidence?.invalidate();
          bulk=undefined;
          if(error instanceof PendingGaugeInput){restoreIndexes();failedInputs.push({path:filePath,error:error.message});completedFiles++;options.onFileProgress?.(completedFiles,totalFiles);continue;}
          quarantineProbeConflict(sqlite, error);
          throw error;
        }
        result.rows += rows;
        processedFiles.push(filePath);
        result.malformed += malformed;
        result.details.push({
          store, file, skipped: false, rows, malformed, fromOffset, toOffset: fromOffset + progress.consumed, readLines: progress.lines,
        });
        completedFiles++;
        options.onFileProgress?.(completedFiles, totalFiles);
      }
      if (touched) result.stores.push(store);
    }
    restoreIndexes();
  } finally {
    try { evidence?.close(); } finally { sqlite.close();timer.stop(); }
  }
  if(options.onTimings||options.firstFill)result.timings=timer.snapshot();
  if(options.firstFill||failedInputs.length){result.failedInputs=failedInputs;result.processedFiles=processedFiles;}
  return result;
}

export function ingestGaugesAsync(...args: Parameters<typeof ingestGaugesSteps>): Promise<GaugeIngestResult> {
  return runFileTasks(ingestGaugesSteps(...args));
}
