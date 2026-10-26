import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database, SQLQueryBindings } from "../db/sqlite";
import { configFile, expandPhysicalPath, toArchiveLogicalPath, toArchivePhysicalPath } from "../config/paths";
import { readAccountsV2 } from "../config/accounts-document";
import { ensureCodexFileModelsIndex, CODEX_FORKED_FROM_INDEX_SQL, CODEX_SOURCE_EVIDENCE_SCHEMA_SQL, CODEX_SOURCE_LOCATOR_INDEX_SQL, fileProviderIds } from "../db/codex-source-evidence";
import {
  CODEX_PARSER_VERSION, isDict, pyDumps, pyEqual, type CodexFilePreparation, type CodexRecordEvidence, type CodexRolloutParse,
} from "./codex-storage";
import { NativeParserError, OrderedPrefetch, ParsePool, parseWorkerCount, yieldToEventLoop } from "./parse-pool";
import {IngestTimer,type IngestTimings,type IngestTimingHandler} from "./ingest-timings";
import { addTrackedColumn } from "../db/analysis";
import { asSchemaWriter } from "../db/schema-writer";
import { compressedRollout, isCodexRollout, rolloutIdentity, selectRolloutRepresentation } from "./codex-rollout";
import { fileDigest } from "../sync/archive-publication";

// Codex rollout import into a replacement stage; ported from engine/codex_usage_report.py `sync`.
// Every changed rollout is parsed whole and replaces its rows, so there is no tail append here.

const SCHEMA_VERSION = 3;
const CONFLICT = /\.conflict-[a-fA-F0-9]{64}(?:\.|$)/;
const winPaths = process.platform === "win32";
const pathKey = (file: string) => winPaths ? file.toLowerCase() : file;

/** A selected transcript could not be read; the previous index is kept. */
export class CodexSourceError extends Error {
  constructor(readonly file: string, readonly errno: number | null, readonly reason: string) {
    super(`Codex transcript unavailable: ${reason}. Check local access or cloud download, then retry. Previous Codex index was kept. File: ${file}`);
  }
}
export class NoReadableCodexHome extends Error {
  constructor() { super("no readable CODEX_HOME found"); }
}

export interface CodexSyncResult {
  source_digests: Array<{ path: string; sha256: string; byteLength: number }>;
  timings?:IngestTimings;
  status: "success";
  processed_inputs: number;
  skipped_inputs: number;
  written_rows: number;
  preparation: { maxWorkers: number; preparedFiles: number; serialFiles: number; peakPendingInputBytes: number; peakPendingFiles: number };
  unavailable_inputs: Array<{ path: string; errno: number | null; message: string }>;
  dirty_range: { from: string; to: string } | null;
}

const tableColumns = (db: Database, table: string) =>
  new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));

/** The Codex tables and their additive columns, as the engine's `connect()` created them. */
export function ensureCodexSchema(db: Database): void {
  asSchemaWriter(db, () => {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const row = db.query("SELECT value FROM meta WHERE key='schema'").get() as { value: string } | null;
    const have = row ? Number.parseInt(row.value, 10) : 0;
    if (have && have < SCHEMA_VERSION) {
      // Source rollouts are pruned over time, so dropping these tables could lose history.
      throw new Error(`Codex index is schema v${have}, this build expects v${SCHEMA_VERSION}; refusing to rebuild it.`);
    }
    if (have < SCHEMA_VERSION) db.query("INSERT OR REPLACE INTO meta VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        home TEXT, path TEXT, size INTEGER, mtime REAL, events INTEGER, offset INTEGER, PRIMARY KEY (home, path));
      CREATE TABLE IF NOT EXISTS events (
        home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT, model TEXT, effort TEXT, project TEXT,
        in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, reasoning_out INTEGER);
      CREATE INDEX IF NOT EXISTS events_ts ON events(home, ts);
      CREATE INDEX IF NOT EXISTS events_global_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS events_path ON events(home, path);
      CREATE TABLE IF NOT EXISTS ratelimit (
        home TEXT, path TEXT, ts TEXT, window_minutes INTEGER, used_percent REAL, resets_at INTEGER, plan_type TEXT,
        limit_id TEXT, limit_name TEXT);
      CREATE INDEX IF NOT EXISTS rl_ts ON ratelimit(home, limit_id, window_minutes, ts);
      CREATE INDEX IF NOT EXISTS ratelimit_global_ts ON ratelimit(ts);
      CREATE INDEX IF NOT EXISTS rl_path ON ratelimit(home, path);
      CREATE INDEX IF NOT EXISTS ratelimit_identity_window ON ratelimit(home,path,window_minutes,limit_id,ts);`);
    db.exec(CODEX_SOURCE_EVIDENCE_SCHEMA_SQL);
    const files = tableColumns(db, "files");
    if (!files.has("offset")) db.exec("ALTER TABLE files ADD COLUMN offset INTEGER");
    if (!files.has("parser_version")) db.exec("ALTER TABLE files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0");
    if (!files.has("parser_state")) db.exec("ALTER TABLE files ADD COLUMN parser_state TEXT");
    const events = tableColumns(db, "events"), rates = tableColumns(db, "ratelimit");
    for (const [name, declaration] of [["source_offset", "INTEGER"], ["source_slot", "TEXT"]]) {
      if (!rates.has(name!)) db.exec(`ALTER TABLE ratelimit ADD COLUMN ${name} ${declaration}`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS ratelimit_source_identity ON ratelimit(home,path,source_offset,source_slot)");
    if (!events.has("cwd")) db.exec("ALTER TABLE events ADD COLUMN cwd TEXT");
    if (!events.has("project_id")) {
      db.exec("ALTER TABLE events ADD COLUMN project_id TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS events_project_id ON events(project_id)");
    }
    for (const [name, declaration] of [
      ["service_tier", "TEXT"], ["speed", "TEXT NOT NULL DEFAULT 'unknown'"], ["speed_source", "TEXT"],
      ["speed_source_offset", "INTEGER"], ["source_offset", "INTEGER"], ["plan_type", "TEXT"],
      ["billing_mode", "TEXT NOT NULL DEFAULT 'unknown'"], ["meter_reset", "INTEGER"], ["account_id", "TEXT"],
      ["response_id", "TEXT"], ["turn_id", "TEXT"], ["usage_source", "TEXT"], ["producer_version", "TEXT"],
      ["cache_write_status", "TEXT NOT NULL DEFAULT 'missing'"], ["usage_status", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["provider_ids_observed", "INTEGER"],
    ]) {
      if (!events.has(name!)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${declaration}`);
    }
    // Codex parser 7: a tracked column added without moving the events revision (analysis.ts).
    addTrackedColumn(db, "events", "resp_ms", "INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS events_billing_mode ON events(billing_mode) WHERE billing_mode = 'business_credits'");
    db.exec(CODEX_SOURCE_LOCATOR_INDEX_SQL);
    ensureCodexFileModelsIndex(db);
    const evidence = tableColumns(db, "codex_file_evidence");
    for (const name of ["provider_thread_id", "provider_session_id", "provider_forked_from_id", "first_token_json"]) {
      if (!evidence.has(name)) db.exec(`ALTER TABLE codex_file_evidence ADD COLUMN ${name} TEXT`);
    }
    db.exec(CODEX_FORKED_FROM_INDEX_SQL);
  });
}

/** Active and archived transcripts of one home, in the engine's (case-insensitive) name order. */
export function* iterRollouts(home: string): Generator<string> {
  function* walk(folder: string): Generator<string> {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    const order = (name: string) => winPaths ? name.toLowerCase() : name;
    entries.sort((a, b) => { const x = order(a.name), y = order(b.name); return x < y ? -1 : x > y ? 1 : 0; });
    for (const entry of entries) {
      if (CONFLICT.test(entry.name) || entry.isSymbolicLink()) continue;
      const candidate = path.join(folder, entry.name);
      // fnmatch compares case-insensitively on Windows.
      if (entry.isFile() && isCodexRollout(entry.name)) yield candidate;
      if (entry.isDirectory()) yield* walk(candidate);
    }
  }
  for (const name of ["sessions", "archived_sessions"]) {
    const root = path.join(home, name);
    if (!fs.existsSync(root)) continue;
    let linked = false;
    for (let candidate = root; ; candidate = path.dirname(candidate)) {
      try { if (fs.lstatSync(candidate).isSymbolicLink() || CONFLICT.test(path.basename(candidate))) { linked = true; break; } }
      catch { /* a missing ancestor is not a link */ }
      if (path.dirname(candidate) === candidate) break;
    }
    if (!linked) yield* walk(root);
  }
}

function errnoOf(error: NodeJS.ErrnoException): number | null {
  const code = error.code && (os.constants.errno as Record<string, number>)[error.code];
  return typeof code === "number" ? code : typeof error.errno === "number" ? Math.abs(error.errno) : null;
}

/**
 * Queued transcript paths per home. The listing that queued them proved each one an ordinary
 * file with no link below its archive root, so only the home and the folders above it are
 * checked here, once per home; the file itself is checked by the stat its read needs anyway.
 */
export function selectedRollouts(homes: string[], files: string[]): Map<string, string[]> {
  const selected = new Map<string, string[]>(homes.map(home => [path.resolve(home), []]));
  const seen = new Set<string>();
  const eligibleHomes = new Map<string, boolean>();
  for (const raw of files) {
    const file = path.resolve(raw);
    if (seen.has(file)) continue;
    seen.add(file);
    const owners = [...selected.keys()].filter(home => {
      const relative = path.relative(home, file);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      const parts = relative.split(path.sep);
      return parts.length >= 2 && (parts[0] === "sessions" || parts[0] === "archived_sessions");
    });
    if (owners.length !== 1 || !isCodexRollout(file)) throw new Error(`Selected transcript has no unique declared home: ${file}`);
    const home = owners[0]!;
    if (path.relative(home, file).split(path.sep).some(part => CONFLICT.test(part)))
      throw new Error(`Selected transcript is not an eligible archive file: ${file}`);
    let eligible = eligibleHomes.get(home);
    if (eligible === undefined) {
      eligible = true;
      for (let candidate = home; ; candidate = path.dirname(candidate)) {
        try { if (fs.lstatSync(candidate).isSymbolicLink()) eligible = false; } catch { /* a missing folder holds no link */ }
        if (CONFLICT.test(path.basename(candidate))) eligible = false;
        if (!eligible || path.dirname(candidate) === candidate) break;
      }
      eligibleHomes.set(home, eligible);
    }
    if (!eligible) throw new Error(`Selected transcript is not an eligible archive file: ${file}`);
    selected.get(home)!.push(file);
  }
  return selected;
}

interface FileStat { size: number; mtime: number; mtimeNs: bigint }
/**
 * size and st_mtime as CPython reports them: seconds + nanoseconds * 1e-9, in that arithmetic.
 * The link itself is examined, not its target: only an ordinary file is a transcript.
 */
function statOf(file: string): FileStat {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile()) throw Object.assign(new Error(`Selected transcript is unavailable: ${file}`), { code: stat.isSymbolicLink() ? "ELOOP" : "ENOENT" });
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Codex source size exceeds exact parser offset range");
  const seconds = stat.mtimeNs / 1_000_000_000n, nanos = stat.mtimeNs % 1_000_000_000n;
  return { size: Number(stat.size), mtime: Number(seconds) + Number(nanos) * 1e-9, mtimeNs: stat.mtimeNs };
}

/** Attribute turns recorded before a forked thread declared its model; pruned or ambiguous sources keep '?'. */
async function backfillUnattributedModels(db: Database, pool: ParsePool, preparedFiles: ReadonlySet<string>): Promise<{ updated: number; dates: string[] }> {
  const updates: Array<[string, string, string, number]> = [], dates: string[] = [];
  const offsets = db.query("SELECT source_offset FROM events WHERE home=? AND path=? AND model='?'");
  for (const { home, path: stored } of db.query("SELECT DISTINCT home, path FROM events WHERE model='?'").all() as Array<{ home: string; path: string }>) {
    if (preparedFiles.has(JSON.stringify([home, stored]))) continue;
    const file = toArchivePhysicalPath(stored);
    if (!fs.existsSync(file)) continue;
    let events;
    try { const prepared = await pool.run("codex", { file, size: fs.statSync(file).size });
      if (prepared.kind !== "ok") continue;
      events = prepared.parse.events;
    } catch (error) { if (error instanceof NativeParserError) throw error; continue; }
    // Only rows still carrying the marker may change, so an attributed row is never rewritten.
    const unattributed = new Set((offsets.all(home, stored) as Array<{ source_offset: number }>).map(row => row.source_offset));
    for (const row of events) {
      const ts = row[0], model = row[3], offset = row[16];
      if (model === "?" || !unattributed.has(offset as number)) continue;
      updates.push([model as string, home, stored, offset as number]);
      if (ts) dates.push(ts as string);
    }
  }
  const update = db.query("UPDATE events SET model=? WHERE home=? AND path=? AND source_offset=? AND model='?'");
  for (const values of updates) update.run(...values);
  return { updated: updates.length, dates };
}

export interface CodexSyncOptions {
  pool?: ParsePool;
  onTimings?:IngestTimingHandler;
  homes: string[];
  force?: boolean;
  /** Exact queued transcripts; no discovery. */
  files?: string[];
  /** Scan only `homes`, never homes registered in an earlier index. */
  exactHomes?: boolean;
  /** Queued files must be complete, valid JSONL; checked in the parsing read, an invalid file stays queued. */
  validateJsonl?: boolean;
  /**
   * The stage will be copied whole into an empty vendor and then discarded: of the lookup
   * indexes deferred while writing, only those the copy reads - by (home, path) - are rebuilt.
   */
  firstFill?: boolean;
  onDiscovery?: (found: number) => void;
  onFileProgress?: (completed: number, total: number) => void;
}

const EVENT_COLUMNS = "home, path, ts, surface, nested, model, effort, project, in_tok, cached_in, cache_write, out_tok, reasoning_out, cwd, "
  + "service_tier,speed,speed_source,speed_source_offset,source_offset,plan_type,billing_mode,meter_reset,account_id,"
  + "response_id,turn_id,usage_source,producer_version,cache_write_status,usage_status,resp_ms";

/** Bounded native inserts retain array order (and therefore publication rowids). */
function rowWriter(db: Database, table: string, columns: string[], suffix: SQLQueryBindings[] = []) {
  const width = columns.length;
  const statements = new Map<number, ReturnType<Database["query"]>>();
  return (home: string, file: string, rows: ReadonlyArray<ReadonlyArray<SQLQueryBindings>>) => {
    for (let offset = 0; offset < rows.length; offset += 100) {
      const count = Math.min(100, rows.length - offset);
      let statement = statements.get(count);
      if (!statement) {
        const values = `(${Array(width).fill("?").join(",")})`;
        statement = db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${Array(count).fill(values).join(",")}`);
        statements.set(count, statement);
      }
      const values: SQLQueryBindings[] = [];
      for (let index = offset; index < offset + count; index++) {
        const row = rows[index]!;
        if (row.length + 2 + suffix.length !== width) throw new Error(`Invalid Codex ${table} row width`);
        values.push(home, file, ...row, ...suffix);
      }
      statement.run(...values);
    }
  };
}

const STAGE_INDEXES = new Set(["events_ts", "events_global_ts", "events_path", "events_project_id", "events_billing_mode",
  "events_source_locator", "rl_ts", "ratelimit_global_ts", "rl_path", "ratelimit_identity_window", "ratelimit_source_identity",
  "events_analysis_day", "ratelimit_analysis_day", "events_range_sources", "ratelimit_range_sources", "events_repo_idx", "events_gap_pending_idx"]);

/** The (home, path) lookups a first-fill stage is read by: its identity list and the copy into the vendor's tables. */
const FIRST_FILL_STAGE_INDEXES = new Set(["events_path", "rl_path"]);

/** The whole inventoried source was read; proofs cover complete original records and exactly the accepted events. */
function sourceEvidenceComplete(parse: CodexRolloutParse, size: number): boolean {
  const evidence = parse.evidence;
  const sha = (value: string) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const frame = (record: CodexRecordEvidence) => record && Number.isSafeInteger(record.byteStart) && record.byteStart >= 0
    && Number.isSafeInteger(record.byteEnd) && record.byteEnd > record.byteStart && record.byteEnd <= size && sha(record.sha256);
  if (!evidence || evidence.source.scope !== "file-prefix" || evidence.source.byteLength !== size || !sha(evidence.source.sha256)
    || evidence.events.length !== parse.events.length) return false;
  const accepted = new Set(parse.events.map(row => row[16]));
  const seen = new Set<number>();
  for (const item of evidence.events) {
    if (!Number.isSafeInteger(item.sourceOffset) || item.sourceOffset < 0 || item.sourceOffset >= size || !accepted.has(item.sourceOffset)
      || seen.has(item.sourceOffset) || !frame(item.accountingRecord) || !frame(item.acceptedEventRecord)
      || !item.duplicateRecords.every(frame)) return false;
    seen.add(item.sourceOffset);
  }
  return evidence.sessionHeaders.every(item => Number.isSafeInteger(item.sourceOffset) && item.sourceOffset >= 0
    && item.sourceOffset < size && frame(item));
}

/** Ingest changed rollouts into a replacement stage; each changed rollout replaces its rows whole. */
export async function syncCodex(db: Database, options: CodexSyncOptions): Promise<CodexSyncResult> {
  const timer=new IngestTimer(options.onTimings);
  const setupEnd=timer.begin("schemaMs");
  const tables = ["events", "ratelimit", "codex_file_evidence"];
  const empty = new Set(tables.filter(table => db.query(`SELECT 1 FROM ${table} LIMIT 1`).get() === null));
  const guarded = new Set((db.query("SELECT DISTINCT tbl_name FROM sqlite_master WHERE type='trigger'").all() as
    Array<{ tbl_name: string }>).map(row => row.tbl_name));
  // Semantic triggers can seed another source table/file while this batch is being written.
  if ([...tables, "files"].some(table => guarded.has(table))) empty.clear();
  // Keep primary/unique indexes and custom guards. Only empty source tables can defer our lookup indexes.
  const deferred = (db.query("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as
    Array<{ name: string; tbl_name: string; sql: string }>).filter(index => empty.has(index.tbl_name) && !guarded.has(index.tbl_name) && STAGE_INDEXES.has(index.name)
      && !/^CREATE\s+UNIQUE\s/i.test(index.sql));
  setupEnd();
  let result:CodexSyncResult|undefined;
  try {
    timer.step("deferIndexesMs",()=>db.transaction(() => { for (const index of deferred) db.exec(`DROP INDEX "${index.name}"`); }).immediate());
    result=await writeCodex(db, options, empty,timer);
  } finally {
    const rebuilt = options.firstFill ? deferred.filter(index => FIRST_FILL_STAGE_INDEXES.has(index.name)) : deferred;
    timer.step("indexBuildMs",()=>db.transaction(() => { for (const index of rebuilt) db.exec(index.sql); }).immediate());
    timer.stop();
  }
  return {...result!,timings:timer.snapshot()};
}

async function writeCodex(db: Database, options: CodexSyncOptions, empty: Set<string>,timer:IngestTimer): Promise<CodexSyncResult> {
  const validate = options.validateJsonl === true;
  let processed = 0, skipped = 0, writtenRows = 0;
  const preparation = { maxWorkers: 0, preparedFiles: 0, serialFiles: 0, peakPendingInputBytes: 0, peakPendingFiles: 0 };
  const eventColumns = EVENT_COLUMNS.split(",").map(column => column.trim());
  // Positions in a parsed event row, which starts after home and path.
  const usageStatus = eventColumns.indexOf("usage_status") - 2, responseId = eventColumns.indexOf("response_id") - 2,
    sourceOffset = eventColumns.indexOf("source_offset") - 2;
  const insertEvents = rowWriter(db, "events", [...eventColumns, "provider_ids_observed"]);
  const insertRates = rowWriter(db, "ratelimit", "home,path,ts,window_minutes,used_percent,resets_at,plan_type,limit_id,limit_name,source_offset,source_slot".split(","));
  const insertFileEvidence = db.query(`INSERT INTO codex_file_evidence
    (home,path,source_sha256,source_byte_length,parser_version,evidence_version,session_headers_json,provider_thread_id,provider_session_id,
     provider_forked_from_id,first_token_json) VALUES (?,?,?,?,?,1,?,?,?,?,?)`);
  const unavailable: CodexSyncResult["unavailable_inputs"] = [];
  let dirtyFrom: string | null = null, dirtyTo: string | null = null;
  const logical = (file: string) => toArchiveLogicalPath(rolloutIdentity(file));
  const sourceDigests: CodexSyncResult["source_digests"] = [];
  const discoveryStarted=performance.now();
  const selected = options.files === undefined ? null : selectedRollouts(options.homes, options.files);
  // A replacement stage without prior events holds only this parser's rows; no legacy model to recover.
  const freshStage = db.query("SELECT 1 FROM events LIMIT 1").get() === null;
  let homes = selected ? [...selected.keys()] : options.homes.map(home => path.resolve(home));
  if (!options.exactHomes && selected === null) {
    const known = new Map(homes.map(home => [pathKey(home), home]));
    for (const { home } of db.query("SELECT DISTINCT home FROM files").all() as Array<{ home: string }>) {
      const physical = toArchivePhysicalPath(home);
      let directory = false;
      try { directory = fs.statSync(physical).isDirectory(); } catch { /* not a registered home any more */ }
      if (directory && !known.has(pathKey(physical))) known.set(pathKey(physical), physical);
    }
    homes = [...known.values()];
  }

  let discovered = 0, lastDiscovery = 0;
  const reportDiscovery = (force = false) => {
    const now = performance.now();
    if (force || now - lastDiscovery >= 500) { options.onDiscovery?.(discovered); lastDiscovery = now; }
  };
  reportDiscovery(true);
  const inventory = new Map<string, string[]>();
  for (const home of homes) {
    const found: string[] = [];
    for (const file of selected ? selected.get(home)! : iterRollouts(home)) { found.push(file); discovered++; reportDiscovery(); }
    inventory.set(home, [...new Map(found.map(file => [pathKey(rolloutIdentity(file)), file])).values()]);
  }
  reportDiscovery(true);
  const totalFiles = [...inventory.values()].reduce((sum, files) => sum + files.length, 0);
  timer.add("discoveryMs",performance.now()-discoveryStarted);timer.emit(true);
  let completedFiles = 0, lastProgress = 0;
  const reportProgress = () => {
    const now = performance.now();
    if (completedFiles === 0 || completedFiles === totalFiles || now - lastProgress >= 500) {
      options.onFileProgress?.(completedFiles, totalFiles); lastProgress = now;
    }
  };
  reportProgress();

  const bookmarkQuery = db.query("SELECT path,size,mtime,events,offset,parser_version,parser_state FROM files WHERE home=?");
  const oneBookmark = db.query("SELECT path,size,mtime,events,offset,parser_version,parser_state FROM files WHERE home=? AND path=?");
  const oldRange = db.query(`SELECT MIN(ts) AS low, MAX(ts) AS high FROM (
      SELECT ts FROM events WHERE home=? AND path=? UNION ALL SELECT ts FROM ratelimit WHERE home=? AND path=?)`);
  const deletes = ["events", "ratelimit", "codex_file_evidence"]
    .map(table => ({ table, statement: db.query(`DELETE FROM ${table} WHERE home=? AND path=?`) }));
  const writtenFiles = new Set<string>();
  const replaceFile = db.query("INSERT OR REPLACE INTO files (home,path,size,mtime,events,offset,parser_version,parser_state) VALUES (?,?,?,?,?,?,?,?)");
  const resetOffset = db.query("UPDATE files SET offset=size WHERE home=? AND path=?");
  const dirty = (ts: unknown) => {
    if (typeof ts !== "string") return;
    if (dirtyFrom === null || ts < dirtyFrom) dirtyFrom = ts;
    if (dirtyTo === null || ts > dirtyTo) dirtyTo = ts;
  };

  let pool: ParsePool | undefined = options.pool;
  try {
    for (const home of homes) {
      const bookmarksEnd=timer.begin("bookmarksMs");
      const hkey = logical(home);
      type Bookmark = { path: string; size: number; mtime: number; events: number | null; offset: number | null; parser_version: number; parser_state: string | null };
      const rows = (selected
        ? selected.get(home)!.flatMap(file => oneBookmark.all(hkey, logical(file)))
        : bookmarkQuery.all(hkey)) as Bookmark[];
      const known = new Map(rows.map(row => [row.path, row]));
      const pending: Array<{ file: string; stat: FileStat }> = [];
      for (const candidate of inventory.get(home)!) {
        let file = candidate;
        let stat: FileStat;
        try { file = selectRolloutRepresentation(candidate); stat = statOf(file); }
        catch (error) {
          if (selected && !compressedRollout(candidate) && !fs.existsSync(`${rolloutIdentity(candidate)}.zst`))
            throw new CodexSourceError(candidate, errnoOf(error as NodeJS.ErrnoException), (error as Error).message);
          unavailable.push({ path: logical(candidate), errno: errnoOf(error as NodeJS.ErrnoException), message: (error as Error).message });
          completedFiles++; reportProgress(); continue;
        }
        const previous = known.get(logical(file));
        let parserCurrent = !!previous && previous.parser_version === CODEX_PARSER_VERSION;
        if (parserCurrent) {
          try {
            const saved = JSON.parse(previous!.parser_state || "{}") as unknown;
            parserCurrent = isDict(saved)
              && pyEqual(Object.prototype.hasOwnProperty.call(saved, "offset") ? saved.offset : 0, previous!.offset);
          } catch { parserCurrent = false; }
        }
        const unchanged = !!previous && parserCurrent && previous.size === stat.size && Math.abs(previous.mtime - stat.mtime) < 1e-6;
        if (!options.force && unchanged) {
          if (previous!.offset === null) resetOffset.run(hkey, logical(file));
          if (compressedRollout(file) || previous!.offset === null || stat.size >= previous!.offset) { skipped++; completedFiles++; reportProgress(); continue; }
        }
        pending.push({ file, stat });
      }
      const workers = Math.min(parseWorkerCount(), pending.length);
      bookmarksEnd();
      if (!pool && workers > 0) pool = new ParsePool(workers);
      const prefetchWindow = pool?.prefetchWindow ?? 0;
      const prefetch = new OrderedPrefetch(pending, prefetchWindow, ({ file, stat }) =>
        pool?.size ? timer.pool(()=>pool!.run("codex", { file, size: stat.size, validate })) : undefined);
      let batch = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [index, { file, stat }] of pending.entries()) {
          const stored = logical(file);
          const repeated = writtenFiles.has(JSON.stringify([hkey, stored]));
          const range = !repeated && empty.has("events") && empty.has("ratelimit") ? { low: null, high: null }
            : oldRange.get(hkey, stored, hkey, stored) as { low: string | null; high: string | null };
          const parseEnd=timer.begin("readAndParseMs","parseMs");
          let prepared: CodexFilePreparation;
          const ahead = prefetch.take(index);
          let fromWorker = false;
          if (ahead) {
            try { prepared = await ahead; fromWorker = true; }
            catch (error) {
              // The Rust parser failed on this file: it stays queued with the reason; no TS parse instead.
              if (!(error instanceof NativeParserError)) throw error;
              prepared = { kind: "read_error", errno: null, message: error.message, code: "ENATIVE" };
            }
          } else prepared = await pool!.run("codex", { file, size: stat.size, validate });
          if (fromWorker) preparation.preparedFiles++; else preparation.serialFiles++;
          if (prepared.kind === "ok") {
            // Workers and serial readers must both publish the same inventoried source.
            let observed: FileStat | undefined;
            try { observed = statOf(file); } catch (error) {
              prepared = { kind: "read_error", errno: errnoOf(error as NodeJS.ErrnoException), message: (error as Error).message, code: null };
            }
            if (observed && (observed.size !== stat.size || observed.mtimeNs !== stat.mtimeNs)) {
              prepared = { kind: "read_error", errno: os.constants.errno.EAGAIN ?? 11, message: "source changed during preparation", code: "EAGAIN" };
            }
          }
          if (prepared.kind === "ok" && !sourceEvidenceComplete(prepared.parse,
            compressedRollout(file) ? prepared.parse.evidence.source.byteLength : stat.size)) {
            prepared = { kind: "read_error", errno: os.constants.errno.EAGAIN ?? 11,
              message: "complete original source evidence is unavailable; previous index was kept", code: "EAGAIN" };
          }
          parseEnd();
          if (prepared.kind === "read_error") {
            unavailable.push({ path: stored, errno: prepared.errno, message: prepared.message });
            completedFiles++; reportProgress();
            continue;
          }
          const { parse } = prepared;
          const previous = known.get(stored);
          if (previous?.offset != null && (compressedRollout(file) || previous.size < previous.offset)
            && parse.evidence.source.byteLength < previous.offset) {
            unavailable.push({ path: stored, errno: null, message: "decoded rollout is shorter than the accepted history; previous index was kept" });
            completedFiles++; reportProgress(); continue;
          }
          // Queue witnesses describe stored bytes; offsets and accounting evidence describe decoded JSONL.
          const storageDigest = compressedRollout(file) ? fileDigest(file) : parse.evidence.source.sha256;
          if (compressedRollout(file)) {
            const afterDigest = statOf(file);
            if (afterDigest.size !== stat.size || afterDigest.mtimeNs !== stat.mtimeNs) {
              unavailable.push({ path: stored, errno: os.constants.errno.EAGAIN ?? 11, message: "source changed during storage verification" });
              completedFiles++; reportProgress(); continue;
            }
          }
          sourceDigests.push({ path: file, sha256: storageDigest, byteLength: stat.size });
          dirty(range.low); dirty(range.high);
          for (const row of parse.events) dirty(row[0]);
          for (const row of parse.rateLimits) dirty(row[0]);
          const writeStarted=performance.now();
          for (const { table, statement } of deletes) if (repeated || !empty.has(table)) statement.run(hkey, stored);
          const evidenceStarted=performance.now();
          // Per call: a usage conflict the parser saw makes the call's usage invalid (it is not valued);
          // identifier presence that differs from the response id is kept (codex-source-evidence.ts).
          const evidenceOf = new Map(parse.evidence.events.map(evidence => [evidence.sourceOffset, evidence]));
          const events = parse.events.map(row => {
            const evidence = evidenceOf.get(row[sourceOffset] as number)!;
            const observed = evidence.providerThreadId !== null || evidence.providerSessionId !== null;
            const values = evidence.conflictingUsage ? row.map((value, index) => index === usageStatus ? "invalid" : value) : row;
            return [...values, observed === (row[responseId] != null) ? null : observed ? 1 : 0];
          });
          const ids = fileProviderIds(parse.evidence.events, parse.evidence.sessionHeaders.map(header => header.providerSessionId));
          timer.detail("evidenceMs",performance.now()-evidenceStarted);
          insertEvents(hkey, stored, events as SQLQueryBindings[][]);
          insertRates(hkey, stored, parse.rateLimits as SQLQueryBindings[][]);
          insertFileEvidence.run(hkey, stored, parse.evidence.source.sha256, BigInt(parse.evidence.source.byteLength),
            CODEX_PARSER_VERSION, JSON.stringify(parse.evidence.sessionHeaders), ids.thread, ids.session,
            // The file's own header comes first; a replayed parent header later in the file is not its parent.
            parse.evidence.sessionHeaders[0]?.providerForkedFromId ?? null,
            parse.firstToken ? JSON.stringify({ ...parse.firstToken, bookmark: { size: stat.size, mtime: stat.mtime } }) : null);
          // Detail spans are nested in stageWriteMs, not added to its wall-time partition.
          const fileStarted=performance.now();
          replaceFile.run(hkey, stored, stat.size, stat.mtime, parse.events.length, parse.consumed, CODEX_PARSER_VERSION, pyDumps(parse.state));
          timer.detail("filesTableMs",performance.now()-fileStarted);
          writtenFiles.add(JSON.stringify([hkey, stored]));
          processed++;
          completedFiles++; reportProgress();
          writtenRows += parse.events.length + parse.rateLimits.length;
          if (++batch % 200 === 0) { const commitStarted=performance.now();db.exec("COMMIT");timer.detail("commitMs",performance.now()-commitStarted);db.exec("BEGIN IMMEDIATE"); }
          timer.add("stageWriteMs",performance.now()-writeStarted);timer.emit();
          const yieldEnd=timer.begin("writerYieldMs");await yieldToEventLoop();yieldEnd();
        }
        timer.step("commitMs",()=>db.exec("COMMIT"),"stageWriteMs");
      } catch (error) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw error;
      }
      preparation.maxWorkers = Math.max(preparation.maxWorkers, pool?.size ?? 0);
      preparation.peakPendingFiles = Math.max(preparation.peakPendingFiles, Math.min(pending.length, prefetchWindow));
    }
    if(pool?.size){const end=timer.begin("parserProfileMs");try{timer.workerProfile(await pool.profileSnapshot());}catch{/* Optional backend metrics cannot reject facts. */}finally{end();}}
  } finally { const closeEnd=timer.begin("poolCloseMs");try{if (!options.pool) await pool?.close();}finally{closeEnd();timer.emit(true);} }

  let recovered = 0;
  const recoveredDates: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  const backfillEnd=timer.begin("backfillsMs");
  try {
    // Current files were already parsed whole; only retained legacy events can gain model evidence.
    if (selected === null && !freshStage && db.query("SELECT 1 FROM events WHERE model='?' LIMIT 1").get()) {
      const recoveryPool = options.pool ?? new ParsePool(parseWorkerCount());
      try {
        const models = await backfillUnattributedModels(db, recoveryPool, writtenFiles);
        recovered += models.updated; recoveredDates.push(...models.dates);
      } finally { if (!options.pool) await recoveryPool.close(); }
    }
    db.exec("COMMIT");
  } catch (error) { if (db.inTransaction) db.exec("ROLLBACK"); throw error; }
  finally {backfillEnd();}
  writtenRows += recovered;
  for (const ts of recoveredDates) dirty(ts);
  return {
    status: "success", processed_inputs: processed, skipped_inputs: skipped, written_rows: writtenRows,
    source_digests: sourceDigests,
    preparation, unavailable_inputs: unavailable,
    dirty_range: dirtyFrom !== null && dirtyTo !== null ? { from: dirtyFrom, to: dirtyTo } : null,
  };
}

/** The Codex homes declared in accounts.json, for a sync that names none. */
export function declaredCodexHomes(): string[] {
  return readAccountsV2(configFile("accounts.json")).sources
    .filter(source => source.vendor === "codex").map(source => expandPhysicalPath(source.home));
}

/** Homes whose session folders can be read here; discovery skips the rest. */
export function readableCodexHomes(homes: string[]): string[] {
  return homes.filter(home => fs.existsSync(home) && ["sessions", "archived_sessions"].some(name => {
    try { fs.accessSync(path.join(home, name), fs.constants.R_OK); return true; } catch { return false; }
  }));
}

