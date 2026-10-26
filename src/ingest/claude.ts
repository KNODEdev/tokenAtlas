import { jsonlArchiveSource, compressedArchiveSource, archiveSourceIdentity } from "../shared/archive-codec-path";
import { selectArchiveRepresentation } from "./archive-codec";
import { fileDigest as storageDigest } from "../sync/jsonl-inspection";
import fs from "fs";
import { exactFiles, isSourceConflict } from "./exact-files";
import path from "path";
import { identityCompanion } from "./claude-companion";
import { OrderedPrefetch, ParsePool, parseWorkerCount, yieldToEventLoop } from "./parse-pool";
import {IngestTimer,type IngestTimings,type IngestTimingHandler} from "./ingest-timings";
import { Database } from "../db/sqlite";
import { initDb, resolveDbPath } from "../db";
import { archive, archiveProfiles, MACHINE, preferredProfile, expandPhysicalPath, toArchiveLogicalPath } from "../config/paths";
import { claudeEvents, claudeFiles, type NewClaudeEvent, type NewClaudeLimitHit } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type * as schema from "../db/schema";
import { ClaudeFirstFill } from "./claude-first-fill";
import { CLAUDE_CLOUD_ENTRYPOINT } from "./claude-cloud";
export interface IngestOptions {
  firstFill?: boolean;
  onTimings?:IngestTimingHandler;
  store?: "live" | "desktop" | "all";
  since?: string;
  limit?: number;
  dbPath?: string;
  path?: string;
  files?: string[];
  force?: boolean;
  skipMigrations?: boolean;
  isolateSelectedFiles?: boolean;
  /** Selected files must be complete, valid JSONL; checked in the parsing read, an invalid file fails alone. */
  validateJsonl?: boolean;
  additionalInputs?: Array<{store:string;path:string}>;
  exclusiveInputs?: Array<{store:string;path:string}>;
  logicalPath?: (physical: string) => string;
  onFileProgress?: (completed: number, total: number) => void;
}
// 5: older text API refusals are read alongside structured quotaLimits. The backfill revisits
// only older files containing the relevant marker.
// 6: each call's response time (`resp_ms`); older files get it in place (sync/claude-timing-backfill.ts).
export const CLAUDE_PARSER_VERSION = 6;
// Cloud session events (`*.events.jsonl`, native claude_cloud.rs) are versioned apart, so a change there reparses only them.
// 7: the promotional cloud credit's calls (`billing_mode = 'grant'`).
export const CLAUDE_CLOUD_PARSER_VERSION = 7;
const parserVersion = (_store: string, file?: string) => file && /\.events\.jsonl(?:\.zst)?$/i.test(file) ? CLAUDE_CLOUD_PARSER_VERSION : CLAUDE_PARSER_VERSION;
export interface ClaudeIngestResult {
  discovered: number;
  processed: number;
  skipped: number;
  writtenRows: number;
  unreadable: number;
  /** Time reading and parsing transcripts, and writing their rows; together they locate import cost. */
  timings: IngestTimings & {writeMs:number};
  dirtyRange: { from: string; to: string } | null;
  failedInputs?: Array<{path:string;error:string}>;
  processedFiles?: string[];
  /** Whole-file SHA-256 of each parsed file, from its parsing read (the sync queue's identity). */
  sourceDigests?: Array<{path:string;sha256:string;byteLength:number}>;
}
function extendDirtyRange(
  range: { from: string; to: string } | null,
  timestamp: string
): { from: string; to: string } {
  if (!range) return { from: timestamp, to: timestamp };
  return {
    from: timestamp < range.from ? timestamp : range.from,
    to: timestamp > range.to ? timestamp : range.to,
  };
}
export function upsertClaudeEvents(
  db: BunSQLiteDatabase<typeof schema>,
  events: NewClaudeEvent[]
): void {
  // A cloud reading replaces a transcript copy of the same call whole and is never replaced by one
  // (claude-cloud.ts); between other copies the one with more output wins.
  const cloud = CLAUDE_CLOUD_ENTRYPOINT;
  const takeover = sql`(excluded.entrypoint IS ${cloud} AND ${claudeEvents.entrypoint} IS NOT ${cloud})`;
  const takes = sql`(${takeover} OR (${claudeEvents.entrypoint} IS NOT ${cloud} AND excluded.out_total > ${claudeEvents.out_total}))`;
  const place = Object.fromEntries((["session_id", "request_id", "ts", "model", "effort", "project", "cwd", "git_branch", "entrypoint",
    "is_sidechain", "agent_id", "attribution_agent", "service_tier", "speed", "cc_version", "billing_mode"] as const)
    .map(column => [column, sql`CASE WHEN ${takeover} THEN excluded.${sql.raw(column)} ELSE ${claudeEvents[column]} END`]));
  const chunkSize = 100;
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    db.insert(claudeEvents)
      .values(chunk)
      .onConflictDoUpdate({
        target: [claudeEvents.store, claudeEvents.call_id],
        set: {
          ...place,
          in_uncached: sql`CASE WHEN ${takes} THEN excluded.in_uncached ELSE ${claudeEvents.in_uncached} END`,
          in_cache_read: sql`CASE WHEN ${takes} THEN excluded.in_cache_read ELSE ${claudeEvents.in_cache_read} END`,
          in_cache_write: sql`CASE WHEN ${takes} THEN excluded.in_cache_write ELSE ${claudeEvents.in_cache_write} END`,
          cache_write_5m: sql`CASE WHEN ${takes} THEN excluded.cache_write_5m ELSE ${claudeEvents.cache_write_5m} END`,
          cache_write_1h: sql`CASE WHEN ${takes} THEN excluded.cache_write_1h ELSE ${claudeEvents.cache_write_1h} END`,
          out_total: sql`CASE WHEN ${takes} THEN excluded.out_total ELSE ${claudeEvents.out_total} END`,
          out_thinking: sql`CASE WHEN ${takes} THEN excluded.out_thinking ELSE ${claudeEvents.out_thinking} END`,
          path: sql`CASE WHEN ${takes} THEN excluded.path ELSE ${claudeEvents.path} END`,
          // The time of the copy the row keeps, read from the same file as its `path`.
          resp_ms: sql`CASE WHEN ${takes} THEN excluded.resp_ms ELSE ${claudeEvents.resp_ms} END`,
          subscription_conflict: sql`CASE
            WHEN COALESCE(${claudeEvents.subscription_conflict}, 0) = 1 OR COALESCE(excluded.subscription_conflict, 0) = 1 THEN 1
            WHEN excluded.account_key IS NOT NULL AND ${claudeEvents.account_key} IS NOT NULL
             AND excluded.account_key != ${claudeEvents.account_key} THEN 1
            ELSE COALESCE(${claudeEvents.subscription_conflict}, 0)
          END`,
          // Written only from a session identity; a row without one keeps what it had.
          subscription_id: sql`CASE
            WHEN COALESCE(${claudeEvents.subscription_conflict}, 0) = 1 OR COALESCE(excluded.subscription_conflict, 0) = 1 THEN NULL
            WHEN excluded.account_key IS NOT NULL AND ${claudeEvents.account_key} IS NOT NULL
             AND excluded.account_key != ${claudeEvents.account_key} THEN NULL
            WHEN excluded.account_key IS NOT NULL THEN excluded.subscription_id
            ELSE ${claudeEvents.subscription_id}
          END`,
          account_key: sql`COALESCE(excluded.account_key, ${claudeEvents.account_key})`,
        },
      })
      .run();
  }
}
export function replaceClaudeFileEvents(
  db: BunSQLiteDatabase<typeof schema>,
  sqlite: Database,
  store: string,
  filePath: string,
  events: NewClaudeEvent[]
): void {
  const callIds = [...new Set(events.map((e) => e.call_id).filter((id): id is string => Boolean(id)))];
  const preserved = new Set<string>();
  const remember = sqlite
    .query(
      `SELECT * FROM (
        SELECT call_id, account_key, subscription_id, subscription_conflict FROM claude_events WHERE store = ? AND path = ?
        ${callIds.length ? `UNION ALL SELECT call_id, account_key, subscription_id, subscription_conflict FROM claude_events WHERE store = ? AND call_id IN (${callIds.map(() => "?").join(",")})` : ""}
      ) WHERE COALESCE(subscription_conflict, 0) = 1 OR account_key IS NOT NULL`
    )
    .all(store, filePath, ...(callIds.length ? [store, ...callIds] : [])) as Array<{ call_id: string; account_key: string | null; subscription_id: string | null; subscription_conflict: number }>;
  const known = new Map(remember.map(row => [row.call_id, row]));
  for (const row of remember) if (row.subscription_conflict) preserved.add(row.call_id);
  events = events.map(event => {
    const previous = known.get(event.call_id);
    if (!previous?.account_key || event.subscription_conflict) return event;
    if (event.account_key && event.account_key !== previous.account_key) {
      preserved.add(event.call_id); return { ...event, subscription_id: null, subscription_conflict: 1 };
    }
    return event.account_key ? event : { ...event, account_key: previous.account_key, subscription_id: previous.subscription_id };
  });
  db.delete(claudeEvents)
    .where(and(eq(claudeEvents.store, store), eq(claudeEvents.path, filePath)))
    .run();
  upsertClaudeEvents(db, events);
  for (const callId of preserved) {
    sqlite
      .query(
        `UPDATE claude_events
            SET subscription_id = NULL, subscription_conflict = 1
          WHERE store = ? AND call_id = ?`
      )
      .run(store, callId);
  }
}
/** The file's refusals replace what an earlier read of the same file recorded. */
export function replaceClaudeFileLimitHits(sqlite: Database, store: string, filePath: string, hits: NewClaudeLimitHit[]): void {
  sqlite.query("DELETE FROM claude_limit_hits WHERE store = ? AND path = ?").run(store, filePath);
  // One refusal can reach the archive in two files of a store (a resumed session repeats it); the
  // newest read of either file owns it, as for claude_events.
  const insert = sqlite.query(`INSERT INTO claude_limit_hits
      (store, call_id, session_id, ts, limit_type, status, resets_at, path, subscription_id, account_key, subscription_conflict, type_basis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(store, call_id) DO UPDATE SET session_id=excluded.session_id, ts=excluded.ts, limit_type=excluded.limit_type,
      status=excluded.status, resets_at=excluded.resets_at, path=excluded.path, subscription_id=excluded.subscription_id,
      account_key=excluded.account_key, subscription_conflict=excluded.subscription_conflict, type_basis=excluded.type_basis`);
  for (const hit of hits) insert.run(hit.store, hit.call_id, hit.session_id ?? null, hit.ts, hit.limit_type, hit.status,
    hit.resets_at ?? null, filePath, hit.subscription_id ?? null, hit.account_key ?? null, hit.subscription_conflict ?? 0,
    hit.type_basis ?? "vendor");
}
export function getStoreRoots(store: string): string[] {
  const explicit = getStorePath(store);
  if (store === "live" && !process.env.TOKENATLAS_STORE_LIVE) {
    const roots = archiveProfiles("claude")
      .filter((p) => !p.endsWith("-desktop"))
      .map((p) => archive("claude", p));
    if (roots.length) return roots;
  }
  if (store === "desktop" && !process.env.TOKENATLAS_STORE_DESKTOP) {
    const roots = archiveProfiles("claude")
      .filter((p) => p.endsWith("-desktop"))
      .map((p) => archive("claude", p));
    if (roots.length) return roots;
  }
  return explicit ? [explicit] : [];
}
export function getStorePath(store: string): string | undefined {
  if (store === "live") {
    if (process.env.TOKENATLAS_STORE_LIVE) return expandPhysicalPath(process.env.TOKENATLAS_STORE_LIVE);
    const profile = preferredProfile("claude");
    if (profile) return archive("claude", profile);
    return archive("claude", MACHINE);
  }
  if (store === "desktop") {
    if (process.env.TOKENATLAS_STORE_DESKTOP) return expandPhysicalPath(process.env.TOKENATLAS_STORE_DESKTOP);
    const own = archive("claude", `${MACHINE}-desktop`);
    if (fs.existsSync(own)) return own;
    const anyDesktop = archiveProfiles("claude").find((p) => p.endsWith("-desktop"));
    return anyDesktop ? archive("claude", anyDesktop) : own;
  }
  return undefined;
}
interface DiscoveredFile {
  store: string;
  fullPath: string;
  size: number;
  mtime: number;
}
export function discoverFiles(store: string, rootDir: string, deferStat = false): DiscoveredFile[] {
  const results: DiscoveredFile[] = [];
  if (isSourceConflict(rootDir) || !fs.existsSync(rootDir) || fs.lstatSync(rootDir).isSymbolicLink()) {
    return results;
  }
  const stat = fs.statSync(rootDir);
  if (stat.isFile()) {
    if (jsonlArchiveSource(rootDir)) {
      results.push({
        store,
        fullPath: path.resolve(rootDir),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
    return results;
  }
  function walk(currentDir: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (isSourceConflict(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && jsonlArchiveSource(entry.name)) {
        try {
          const s = deferStat ? {size: -1,mtimeMs: -1} : fs.statSync(fullPath);
          results.push({
            store,
            fullPath,
            size: s.size,
            mtime: s.mtimeMs,
          });
        } catch {
        }
      }
    }
  }
  walk(rootDir);
  const selected = new Map<string, DiscoveredFile>();
  for (const item of results) {
    const key = archiveSourceIdentity(item.fullPath);
    if (selected.has(key)) continue;
    const physical = selectArchiveRepresentation(item.fullPath);
    const stat = deferStat ? {size:-1,mtimeMs:-1} : fs.statSync(physical);
    selected.set(key, {...item, fullPath: physical, size:stat.size, mtime:stat.mtimeMs});
  }
  results.splice(0, results.length, ...selected.values());
  results.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  return results;
}
export async function ingestClaude(options: IngestOptions = {}): Promise<ClaudeIngestResult> {
  const timer=new IngestTimer(options.onTimings);
  const storeOption = options.store || (options.path ? "live" : "all");
  const storesToProcess = [...new Set([
    ...(options.exclusiveInputs ? options.exclusiveInputs.map(input => input.store) : storeOption === "all" ? ["live", "desktop"] : [storeOption]),
    ...(options.additionalInputs??[]).map(input=>input.store)])];
  const dbPath = resolveDbPath(options.dbPath);
  if (!options.skipMigrations) {
    const { runMigrations } = await import("../db/migrate");
    await runMigrations(dbPath);
  }
  const { db, sqlite } = initDb(dbPath);
  timer.add("overheadMs",timer.snapshot().elapsedMs);
  let pool: ParsePool | undefined;
  let bulk: ClaudeFirstFill | undefined;
  const deferredIndexes:Array<{name:string;sql:string}>=[];
  try {
    if (options.firstFill && !sqlite.query("SELECT 1 FROM claude_events LIMIT 1").get()
      && !sqlite.query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('claude_events','claude_files')").get()) {
      bulk = new ClaudeFirstFill(sqlite);
      const owned = new Set(["claude_events_store_ts_idx","claude_events_ts_idx","claude_events_project_id_idx","claude_events_store_path_idx","claude_events_subscription_id_idx","claude_events_model_idx","claude_events_range_sources","claude_events_analysis_day","claude_events_repo_idx","claude_events_gap_pending_idx"]);
      for (const index of sqlite.query("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='claude_events' AND sql IS NOT NULL").all() as Array<{name:string;sql:string}>) {
        if (owned.has(index.name) && !/^CREATE\s+UNIQUE\s/i.test(index.sql)) {sqlite.exec(`DROP INDEX "${index.name}"`);deferredIndexes.push(index);}
      }
    }
    const logicalPath = options.logicalPath ?? toArchiveLogicalPath;
    console.log(`\n=== Claude Ingest Starting ===`);
    console.log(`Database: ${dbPath}`);
    console.log(`Stores: ${storesToProcess.join(", ")}`);
    if (options.path) console.log(`Path: ${options.path}`);
    if (options.since) console.log(`Since: ${options.since}`);
    if (options.limit) console.log(`File limit: ${options.limit}`);
    const existingFiles = options.files !== undefined || options.exclusiveInputs !== undefined ? [] : db.select().from(claudeFiles).all();
    const fileCache = new Map<string, { size: number; mtime: number; parser_version: number }>();
    for (const f of existingFiles) {
      fileCache.set(`${f.store}::${f.path}`, { size: f.size, mtime: f.mtime, parser_version: f.parser_version });
    }
    const bookmarkOf = (store: string, file: string) => {
      const key = `${store}::${file}`;
      if (!fileCache.has(key) && (options.files !== undefined || options.exclusiveInputs !== undefined)) {
        const row = sqlite.query("SELECT size, mtime, parser_version FROM claude_files WHERE store = ? AND path = ?").get(store, file) as { size: number; mtime: number; parser_version: number } | null;
        if (row) fileCache.set(key, row);
      }
      return fileCache.get(key);
    };
    const failedInputs:Array<{path:string;error:string}>=[],processedFiles:string[]=[];
    const sourceDigests:NonNullable<ClaudeIngestResult["sourceDigests"]>=[];
    const isolated=options.isolateSelectedFiles===true&&options.files!==undefined;
    const discoveryStarted=performance.now();
    const selectedFiles = options.files === undefined ? undefined : isolated
      ? [...new Set(options.files)].flatMap(file=>{try{return exactFiles([file]).map(file=>selectArchiveRepresentation(file));}catch(error){failedInputs.push({path:path.resolve(file),error:String(error)});return [];}})
      : [...new Set(exactFiles(options.files).map(file=>selectArchiveRepresentation(file)))];
    const selectedInputs = selectedFiles?.map(file => {
      const profile = path.relative(archive("claude"),path.resolve(file)).split(path.sep)[0] ?? "";
      return {path:file,store:storeOption !== "all" ? storeOption : profile.endsWith("-desktop") ? "desktop" : "live"};
    });
    const selectedRoots = options.exclusiveInputs?.map(input => input.path) ?? (options.path ? [options.path] : undefined);
    if (selectedFiles && selectedRoots) {
      for (const file of selectedFiles) {
        if (!selectedRoots.some(root => {
          const relative = path.relative(path.resolve(root), file);
          return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        })) throw new Error(`Selected Claude transcript is outside its declared roots: ${file}`);
      }
    }
    let totalDiscovered = 0;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalEventsInserted = 0;
    let unreadableCount = failedInputs.length;
    let parseMs = 0, writeMs = 0;
    let dirtyRange: { from: string; to: string } | null = null;
    const startTime = Date.now();
    const fileLimit = options.limit ?? Infinity;
    const scannedRoots = new Set<string>();
    const seenFiles = new Set<string>();
    const inventory: DiscoveredFile[][] = [];
    for (const store of storesToProcess) {
      const roots = [...new Set([...(options.exclusiveInputs ? options.exclusiveInputs.filter(input => input.store === store).map(input => input.path) : options.path ? [path.resolve(options.path)] : selectedInputs ? selectedInputs.filter(input => input.store === store).map(input => input.path) : getStoreRoots(store)),
        ...(options.additionalInputs??[]).filter(input=>input.store===store).map(input=>input.path)])];
      if (roots.length === 0) {
        if(selectedFiles===undefined)console.warn(`Unknown store: ${store}`);
        continue;
      }
      const files: DiscoveredFile[] = [];
      const directSelected=selectedFiles!==undefined&&!options.path&&!options.exclusiveInputs&&!options.additionalInputs?.length;
      if(directSelected){
        const eligible=new Set(selectedFiles);
        for(const input of selectedInputs??[]){
          const fullPath=path.resolve(input.path);if(input.store!==store||!eligible.has(fullPath))continue;
          try{if(!jsonlArchiveSource(fullPath))throw new Error(`Invalid Claude transcript: ${fullPath}`);const stat=bulk?{size:-1,mtimeMs:-1}:fs.statSync(fullPath);files.push({store,fullPath,size:stat.size,mtime:stat.mtimeMs});}
          catch(error){if(!isolated)throw error;failedInputs.push({path:fullPath,error:String(error)});unreadableCount++;}
        }
      }
      for (const rootPath of directSelected?[]:roots) {
        const rootKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
        if (scannedRoots.has(rootKey)) continue;
        scannedRoots.add(rootKey);
        if (selectedFiles !== undefined) {
          for (const fullPath of selectedFiles) {
            const relative = path.relative(path.resolve(rootPath), fullPath);
            if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
            if (!jsonlArchiveSource(fullPath)) throw new Error(`Invalid Claude transcript: ${fullPath}`);
            const stat = bulk ? {size:-1,mtimeMs:-1} : fs.statSync(fullPath);
            files.push({ store, fullPath, size: stat.size, mtime: stat.mtimeMs });
          }
          continue;
        }
        if (!fs.existsSync(rootPath)) {
          if (options.exclusiveInputs !== undefined) throw new Error(`Selected Claude source is unavailable: ${rootPath}`);
          console.warn(`Store path does not exist: ${rootPath}`);
          continue;
        }
        const found = discoverFiles(store, rootPath, !!bulk);
        console.log(`\nScanning store [${store}] at ${rootPath}... ${found.length} .jsonl files`);
        files.push(...found);
      }
      if (files.length === 0) continue;
      console.log(`Found ${files.length} .jsonl files in [${store}] across ${roots.length} root(s)`);
      inventory.push(files);
    }
    const inventoryKeys = new Set<string>();
    for (const files of inventory) for (const file of files) {
      if (!options.exclusiveInputs && storeOption !== "all" && file.store !== storeOption) continue;
      inventoryKeys.add(process.platform === "win32" ? file.fullPath.toLowerCase() : file.fullPath);
    }
    const progressTotal = options.limit === undefined ? inventoryKeys.size : Math.min(inventoryKeys.size, options.limit);
    let progressCompleted = 0;
    options.onFileProgress?.(0, progressTotal);
    // Processing order, with each physical path captured before the loop stores its logical form.
    const ordered: Array<{ file: DiscoveredFile; physicalPath: string; group: number }> = [];
    for (const [group, files] of inventory.entries()) {
      for (const file of new Map(files.map(file=>[file.fullPath,file])).values()) {
        const fileKey = process.platform === "win32" ? file.fullPath.toLowerCase() : file.fullPath;
        if (seenFiles.has(fileKey) || (!options.exclusiveInputs && storeOption !== "all" && file.store !== storeOption)) continue;
        seenFiles.add(fileKey);
        ordered.push({ file, physicalPath: file.fullPath, group });
      }
      if (options.path) break;
    }
    const needsParse = (file: DiscoveredFile, physicalPath: string): boolean => {
      if (bulk) return true;
      if (options.force) return true;
      const cached = bookmarkOf(file.store, logicalPath(physicalPath));
      const companion = identityCompanion(file.store, physicalPath);
      if (companion && fs.existsSync(companion)) {
        const stat = fs.statSync(companion), previous = bookmarkOf(file.store, logicalPath(companion));
        if (!previous || previous.size !== stat.size || Math.abs(previous.mtime - stat.mtimeMs) >= 1 || previous.parser_version !== parserVersion(file.store, companion)) return true;
      }
      return !(cached && cached.parser_version === parserVersion(file.store, physicalPath) && cached.size === file.size && Math.abs(cached.mtime - file.mtime) < 1);
    };
    timer.add("discoveryMs",performance.now()-discoveryStarted);timer.emit(true);
    // Parsing runs ahead in workers; results are applied here in file order, because the
    // call merge and identity-conflict rules depend on which file is written first. The
    // skip decision is taken again when a file's turn comes, so a speculative parse is
    // used only when the sequential rule would parse the file too.
    const workers = Math.min(parseWorkerCount(), ordered.filter(({ file, physicalPath }) => {
      try { return needsParse(file, physicalPath); } catch { return false; }
    }).length);
    pool = workers > 0 ? new ParsePool(workers) : undefined;
    const prefetch = new OrderedPrefetch(ordered, pool?.prefetchWindow ?? 0, ({ file, physicalPath }) => {
      if (!pool?.size) return undefined;
      try { if (!needsParse(file, physicalPath)) return undefined; } catch { return undefined; }
      if(file.size<0){try{const stat=timer.step("fileStatMs",()=>fs.statSync(physicalPath));file.size=stat.size;file.mtime=stat.mtimeMs;}catch{return undefined;}}
      return timer.pool(()=>pool!.run("claude", { store: file.store, file: physicalPath, since: options.since, validate: options.validateJsonl === true }));
    });
    const parseFile = async (store: string, physicalPath: string, prefetched: ReturnType<typeof prefetch.take>) => {
      return prefetched ?? (pool ??= new ParsePool(parseWorkerCount())).run("claude", {
        store, file: physicalPath, since: options.since, validate: options.validateJsonl === true,
      });
    };
    let currentGroup = -1;
    for (const [index, { file, physicalPath, group }] of ordered.entries()) {
      if (group !== currentGroup) {
        if (totalProcessed + totalSkipped >= fileLimit) break;
        currentGroup = group;
      }
      totalDiscovered++;
      if (totalProcessed + totalSkipped >= fileLimit) break;
      const prefetched = prefetch.take(index);
      const fileCheckpoint=bulk?.checkpoint();
        try {
        if (file.size < 0) {
          const stat=timer.step("fileStatMs",()=>fs.statSync(physicalPath));file.size=stat.size;file.mtime=stat.mtimeMs;
        }
        file.fullPath = logicalPath(physicalPath);
        if (!needsParse(file, physicalPath)) {
          totalSkipped++;
          processedFiles.push(physicalPath);
          continue;
        }
        let events: NewClaudeEvent[] = [];
        let limitHits: NewClaudeLimitHit[] = [];
        const parseStarted = performance.now();
        const parseEnd=timer.begin("readAndParseMs","parseMs");
        try {
          let source: { sha256: string; byteLength: number } | undefined;
          ({ events, limitHits, source } = await parseFile(file.store, physicalPath, prefetched));
          const observed=fs.statSync(physicalPath);
          if (observed.size!==file.size || observed.mtimeMs!==file.mtime) throw new Error("Claude source changed during preparation; kept for retry");
          if (source) sourceDigests.push({ path: physicalPath, ...(compressedArchiveSource(physicalPath) ? {sha256:storageDigest(physicalPath),byteLength:fs.statSync(physicalPath).size} : source) });
          for (const event of events) event.path = file.fullPath;
          for (const hit of limitHits) hit.path = file.fullPath;
        } catch (error) {
          throw error;
        } finally {
          parseMs += performance.now() - parseStarted;
          parseEnd();
        }
        const writeStarted = performance.now();
        const callIds = [...new Set(events.map((event) => event.call_id))];
        const rangeStarted=performance.now();
        const previousRange = bulk ? {from_ts:null,to_ts:null} : sqlite
          .query(
            // Separate branches retain the (store,path) and (store,call_id) index lookups.
            `SELECT MIN(ts) AS from_ts, MAX(ts) AS to_ts FROM (
              SELECT ts FROM claude_events WHERE store = ? AND path = ?
              ${callIds.length ? `UNION ALL SELECT ts FROM claude_events WHERE store = ? AND call_id IN (${callIds.map(() => "?").join(",")})` : ""}
            )`
          )
          .get(file.store, file.fullPath, ...(callIds.length ? [file.store, ...callIds] : [])) as {
          from_ts: string | null;
          to_ts: string | null;
        };
        timer.detail("priorRangeMs",performance.now()-rangeStarted);
        let callbackFinished=performance.now();
        sqlite.transaction(() => {
          const replaceStarted=performance.now();
          if (bulk) bulk.append(events);
          else replaceClaudeFileEvents(db, sqlite, file.store, file.fullPath, events);
          timer.detail("replaceEventsMs",performance.now()-replaceStarted);
          const limitsStarted=performance.now();
          replaceClaudeFileLimitHits(sqlite, file.store, file.fullPath, limitHits);
          timer.detail("limitHitsMs",performance.now()-limitsStarted);
          const filesStarted=performance.now();
          db.insert(claudeFiles)
            .values({
              store: file.store,
              path: file.fullPath,
              parser_version: parserVersion(file.store, file.fullPath),
              size: file.size,
              mtime: file.mtime,
              calls: events.length,
              ingested_at: new Date().toISOString(),
            })
            .onConflictDoUpdate({
              target: [claudeFiles.store, claudeFiles.path],
              set: {
                size: file.size,
                mtime: file.mtime,
                calls: events.length,
                parser_version: parserVersion(file.store, file.fullPath),
                ingested_at: new Date().toISOString(),
              },
            })
            .run();
          timer.detail("filesTableMs",performance.now()-filesStarted);
          callbackFinished=performance.now();
        }).immediate();
        timer.detail("commitMs",performance.now()-callbackFinished);
        writeMs += performance.now() - writeStarted;
        timer.add("stageWriteMs",performance.now()-writeStarted);timer.emit();
        // Let native stdout drain and refill the bounded parser window between synchronous writes.
        const yieldEnd=timer.begin("writerYieldMs");await yieldToEventLoop();yieldEnd();
        if (previousRange.from_ts) dirtyRange = extendDirtyRange(dirtyRange, previousRange.from_ts);
        if (previousRange.to_ts) dirtyRange = extendDirtyRange(dirtyRange, previousRange.to_ts);
        processedFiles.push(physicalPath);
        totalProcessed++;
        totalEventsInserted += events.length;
        for (const event of events) {
          dirtyRange = extendDirtyRange(dirtyRange, event.ts);
        }
        if (totalProcessed % (isolated ? 100 : 5) === 0) {
          console.log(
            `Processed [${file.store}] ${path.basename(file.fullPath)} -> ${events.length} calls (${totalProcessed} new/updated, ${totalSkipped} skipped)`
          );
        }
        } catch(error) {
          if(fileCheckpoint!==undefined)bulk?.restore(fileCheckpoint);
          if(!isolated && selectedFiles!==undefined)throw error;
          failedInputs.push({path:physicalPath,error:String(error)});unreadableCount++;
        } finally {
          progressCompleted++;
          options.onFileProgress?.(Math.min(progressCompleted, progressTotal), progressTotal);
        }
    }
    if(pool?.size){const end=timer.begin("parserProfileMs");try{timer.workerProfile(await pool.profileSnapshot());}catch{/* Optional backend metrics cannot reject facts. */}finally{end();}}
    if (bulk) timer.step("duplicateMergeMs",()=>sqlite.transaction(()=>bulk!.finish()).immediate(),"stageWriteMs");
    // The stage is copied whole into the empty vendor and discarded: only the (store, path) lookup its copy reads is built.
    timer.step("indexBuildMs",()=>{for(const index of deferredIndexes)if(index.name==="claude_events_store_path_idx")sqlite.exec(index.sql);deferredIndexes.length=0;});
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n=== Claude Ingest Summary ===`);
    console.log(`Total discovered files: ${totalDiscovered}`);
    console.log(`Files skipped (unchanged): ${totalSkipped}`);
    console.log(`Files processed (new/changed): ${totalProcessed}`);
    if (unreadableCount > 0) {
      console.log(`Files skipped (unreadable/permission): ${unreadableCount}`);
    }
    console.log(`Total event rows inserted: ${totalEventsInserted}`);
    console.log(`Elapsed time: ${durationSec}s\n`);
    return {
      discovered: totalDiscovered,
      processed: totalProcessed,
      skipped: totalSkipped,
      writtenRows: totalEventsInserted,
      unreadable: unreadableCount,
      timings: {...timer.snapshot(),parseMs:Math.round(parseMs),writeMs:Math.round(writeMs)},
      dirtyRange,
      ...((isolated||failedInputs.length)?{failedInputs,processedFiles}:{}),
      ...(sourceDigests.length?{sourceDigests}:{}),
    };
  } finally {
    const closeEnd=timer.begin("poolCloseMs");
    try { await pool?.close(); }
    finally {try{bulk?.close();for(const index of deferredIndexes)sqlite.exec(index.sql);}finally{try{sqlite.close();}finally{closeEnd();timer.stop();}}}
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: IngestOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--store" && i + 1 < args.length) {
      const val = args[++i];
      if (val && ["live", "desktop", "all"].includes(val)) {
        options.store = val as IngestOptions["store"];
      }
    } else if (arg === "--path" && i + 1 < args.length) {
      const val = args[++i];
      if (val) options.path = val;
    } else if (arg === "--since" && i + 1 < args.length) {
      const val = args[++i];
      if (val) options.since = val;
    } else if (arg === "--limit" && i + 1 < args.length) {
      const val = args[++i];
      if (val) options.limit = parseInt(val, 10);
    } else if (arg === "--db" && i + 1 < args.length) {
      const val = args[++i];
      if (val) options.dbPath = val;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run ingest:claude [options]
Options:
  --store <live|desktop|all>            Which store to ingest (default: all)
  --force                       Re-parse every file, ignoring the size+mtime cache
  --path <dirOrFile>            Specific file or directory to ingest
  --since <YYYY-MM-DD>          Only include events on or after date
  --limit <N>                   Cap how many files are processed
  --db <path>                   Custom path to atlas.sqlite database
  --help, -h                    Show this help message`);
      process.exit(0);
    }
  }
  ingestClaude(options).catch((err) => {
    console.error("Ingest failed:", err);
    process.exit(1);
  });
}
