import {IngestTimer,type IngestTimings,type IngestTimingHandler} from "./ingest-timings";
import { type GenRow, type InvariantReport } from "./gemini-types";
import type { ParsePool, ParseFormats } from "./parse-pool";
import { fileParseTask, runFileTasks, type FileParseTask } from "./file-parse-tasks";
import fs from "node:fs";
import { exactFiles, isSourceConflict } from "./exact-files";
import path from "node:path";
import { Database, type SQLQueryBindings } from "../db/sqlite";
import { archive, archiveLogical, archiveProfiles, toArchiveLogicalPath } from "../config/paths";
import { activeDatabasePath } from "../db";
import { loadRateCard } from "../server/rate-cards-file";
import { selectContextRates, type ContextTier } from "../shared/context-tier";
const INVARIANT_TOLERANCE = 0.01;
const ARCHIVE_ROOT = archive("gemini");
const ARCHIVE_LOGICAL_ROOT = archiveLogical("gemini");
export function storeForGeminiProfile(profile: string, persistedStore?: string): {store:string;account:null} {
  if (!profile || profile === "." || profile === ".." || /[\\/\u0000]/.test(profile)) throw new Error("Invalid Gemini archive profile");
  // An existing store is an opaque import identity, even if its historical spelling resembles an account.
  // New stores name only the physical archive profile and never claim an account.
  return {store:persistedStore ?? `source:gemini:${encodeURIComponent(profile)}`,account:null};
}

/** Preserve a profile's persisted import identity through config edits, restart and reimport. */
export function persistedGeminiStores(atlasPath: string, profiles: readonly string[]): Map<string,string> {
  const wanted = new Set(profiles), stores = new Map<string,Set<string>>();
  if (!fs.existsSync(atlasPath) || wanted.size === 0) return new Map();
  const sqlite = new Database(atlasPath, { readonly: true });
  try {
    const rows = sqlite.query("SELECT store,path FROM gemini_files").all() as Array<{store:string;path:string}>;
    for (const row of rows) {
      const relative = path.relative(ARCHIVE_LOGICAL_ROOT, row.path.replace(/\\/g,"/"));
      const parts = relative.split(/[\\/]/);
      if (path.isAbsolute(relative) || parts[0] === ".." || parts.length !== 3 || parts[1] !== "conversations" || !wanted.has(parts[0]!)) continue;
      const found = stores.get(parts[0]!) ?? new Set<string>();
      found.add(row.store); stores.set(parts[0]!, found);
    }
    const out = new Map<string,string>();
    for (const [profile, found] of stores) {
      if (found.size !== 1) throw new Error(`Gemini profile ${profile} has conflicting persisted stores: ${[...found].join(", ")}`);
      out.set(profile,[...found][0]!);
    }
    return out;
  } catch (error) {
    if (String(error).includes("no such table: gemini_files")) return new Map();
    throw error;
  } finally { sqlite.close(); }
}
export { type GenRow, type InvariantReport } from "./gemini-types";
interface GoogleRate {
  in_uncached: number;
  in_cache_read: number;
  out_total: number;
  long_context?: ContextTier<Omit<GoogleRate, "long_context">>;
}
function loadGoogleRates(rootDir: string): Record<string, GoogleRate> {
  try {
    const raw = loadRateCard(path.join(rootDir, "rate-cards.json")) as {
      vendors?: Record<string, { models?: Record<string, GoogleRate> }>;
    };
    return { ...(raw.vendors?.anthropic?.models ?? {}), ...(raw.vendors?.google?.models ?? {}) };
  } catch {
    return {};
  }
}
export function rateFor(rates: Record<string, GoogleRate>, model: string | null): GoogleRate | null {
  if (!model) return null;
  if (rates[model]) return rates[model]!;
  let best: { key: string; rate: GoogleRate } | null = null;
  for (const [k, v] of Object.entries(rates)) {
    if (model.startsWith(k) && (best == null || k.length > best.key.length)) best = { key: k, rate: v };
  }
  return best?.rate ?? null;
}
function priceOf(g: GenRow, rates: Record<string, GoogleRate>): number {
  const model = rateFor(rates, g.model);
  // Antigravity reports cache apart from fresh input, so their sum is the prompt size.
  const r = model && selectContextRates(model, model.long_context, model.long_context, g.fresh_in + g.cached_in).rates;
  if (!r) return 0;
  return (
    (g.fresh_in / 1e6) * r.in_uncached +
    (g.cached_in / 1e6) * r.in_cache_read +
    (g.out_total / 1e6) * r.out_total
  );
}
const GEMINI_EVENT_COLUMNS = [
  "store",
  "conversation_id",
  "gen_idx",
  "ts",
  "ts_basis",
  "model",
  "workspace",
  "path",
  "fresh_in",
  "cached_in",
  "out_total",
  "out_thinking",
  "out_visible",
  "context_tokens",
  "context_limit",
  "usd",
  "project_id",
] as const;
function hydrateIncrementalHistory(
  sqlite: Database,
  sourceAtlasPath: string,
  files: Array<{ physical: string; logical: string }>,
  store: string,
): void {
  const source = new Database(sourceAtlasPath, { readonly: true });
  try {
    const bookmarksByPath = new Map<string, Array<{ store: string; size: number; mtime: number }>>();
    for (const row of files.flatMap(file => source
      .query("SELECT store, path, size, mtime FROM gemini_files WHERE path = ?")
      .all(file.logical)) as Array<{ store: string; path: string; size: number; mtime: number }>) {
      const records = bookmarksByPath.get(row.path) ?? [];
      records.push(row);
      bookmarksByPath.set(row.path, records);
    }
    if(bookmarksByPath.size===0)return;
    const events = source.query(
      `SELECT ${GEMINI_EVENT_COLUMNS.join(", ")} FROM gemini_events WHERE store = ? AND path = ?`,
    );
    const insert = sqlite.query(
      `INSERT OR IGNORE INTO gemini_events (${GEMINI_EVENT_COLUMNS.join(", ")})
       VALUES (${GEMINI_EVENT_COLUMNS.map(() => "?").join(", ")})`,
    );
    sqlite.transaction(() => {
      for (const file of files) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file.physical);
        } catch {
          continue;
        }
        const bookmarks = bookmarksByPath.get(file.logical) ?? [];
        const current = bookmarks.find((row) => row.store === store);
        const needsHistory =
          bookmarks.some((row) => row.store !== store) ||
          (current != null && (current.size !== stat.size || current.mtime !== stat.mtimeMs));
        if (!needsHistory) continue;
        for (const bookmark of bookmarks) {
          for (const row of events.all(bookmark.store, file.logical) as Array<Record<string, SQLQueryBindings>>) {
            insert.run(...GEMINI_EVENT_COLUMNS.map((column) => row[column] ?? null));
          }
        }
      }
    }).immediate();
  } finally {
    source.close();
  }
}
export interface GeminiIngestResult {
  timings?:IngestTimings;
  store: string;
  files: number;
  skipped: number;
  reassigned: number;
  generations: number;
  unpricedModels: Record<string, number>;
  invariant: InvariantReport;
  dirtyRange: { from: string; to: string } | null;
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
export function listGeminiConversationFiles(conversationsDir: string): string[] {
  try {
    return fs.readdirSync(conversationsDir)
      .filter(file => file.endsWith(".db") && !isSourceConflict(file))
      .map(file => path.join(conversationsDir, file))
      .filter(file => !fs.lstatSync(file).isSymbolicLink());
  } catch {
    return [];
  }
}

function* ingestGeminiSteps(
  conversationsDir: string,
  store: string,
  opts: { force?: boolean; atlasPath?: string; rootDir?: string; sourceAtlasPath?: string; logicalPath?: (physical: string) => string; files?: string[]; archivedInput?: boolean; reassignmentFiles?: string[];
    discoveredFiles?: string[]; onFileChecked?: () => void; onTimings?:IngestTimingHandler; parsePool?: ParsePool } = {}
): Generator<FileParseTask<ParseFormats["gemini"]["output"]>, GeminiIngestResult, ParseFormats["gemini"]["output"]> {
  const timer=new IngestTimer(opts.onTimings);
  const { initDb } = require("../db") as typeof import("../db");
  const { sqlite } = initDb(opts.atlasPath);
  const statements: Array<{ finalize(): void }> = [];
  let accepted:Database|undefined;
  try {
    if(opts.sourceAtlasPath && path.resolve(opts.sourceAtlasPath)!==path.resolve(opts.atlasPath??""))accepted=new Database(opts.sourceAtlasPath,{readonly:true});
    const rootDir = opts.rootDir ?? path.resolve(import.meta.dir, "../..");
    const rates = loadGoogleRates(rootDir);
    const logicalPath = opts.logicalPath ?? toArchiveLogicalPath;
    let files: string[];
    const discoveryStarted=performance.now();
    if (opts.files !== undefined) {
      files = exactFiles(opts.files, conversationsDir);
      if (files.some(file => path.extname(file) !== ".db" || path.dirname(file) !== path.resolve(conversationsDir))) throw new Error("Invalid Gemini conversation path");
    } else files = opts.discoveredFiles ?? listGeminiConversationFiles(conversationsDir);
    timer.add("discoveryMs",performance.now()-discoveryStarted);timer.emit(true);
    if (
      opts.sourceAtlasPath &&
      opts.atlasPath &&
      path.resolve(opts.sourceAtlasPath) !== path.resolve(opts.atlasPath)
    ) {
      timer.measure("stageWriteMs",()=>hydrateIncrementalHistory(sqlite, opts.sourceAtlasPath!, files.map(physical => ({ physical, logical: logicalPath(physical) })), store));
    }
    const seen = new Map<string, Array<{ store: string; size: number; mtime: number; generations: number }>>();
    try {
      for (const r of files.flatMap(file => sqlite
        .query("SELECT store, path, size, mtime, generations FROM gemini_files WHERE path = ?")
        .all(logicalPath(file))) as Array<{ store: string; path: string; size: number; mtime: number; generations: number }>) {
        const records = seen.get(r.path) ?? [];
        records.push(r);
        seen.set(r.path, records);
      }
    } catch {
    }
    const inv: InvariantReport = { checked: 0, violations: 0, examples: [] };
    const unpriced: Record<string, number> = {};
    const pending: GenRow[] = [];
    const fileStats: Array<{ file: string; size: number; mtime: number; gens: number }> = [];
    const physicalFiles: Array<{ file: string; size: number; mtime: number; gens: number; changed: boolean; sourceStore?: string }> = [];
    let skipped = 0;
    let reassigned = 0;
    for (const physicalFile of files) {
      const file = logicalPath(physicalFile);
      let st: fs.Stats;
      try {
        st = fs.statSync(physicalFile);
      } catch (error) {
        if (opts.files !== undefined) throw error;
        opts.onFileChecked?.();
        continue;
      }
      const matching = (seen.get(file) ?? []).filter((row) => row.size === st.size && row.mtime === st.mtimeMs);
      // Multiple matching bookmarks cannot establish which stored history is authoritative.
      const prev = matching.length === 1 ? matching[0] : undefined;
      if ((!opts.force || opts.reassignmentFiles?.includes(physicalFile)) && prev) {
        skipped += 1;
        if (seen.get(file)?.some((row) => row.store !== store)) reassigned += 1;
        physicalFiles.push({ file, size: st.size, mtime: st.mtimeMs, gens: prev.generations, changed: false, sourceStore: prev.store });
        opts.onFileChecked?.();
        continue;
      }
      if(opts.archivedInput&&!opts.atlasPath)throw new Error('Archived Gemini read requires a local database path');
      const task = fileParseTask("gemini", { file: physicalFile, strictRead: opts.files !== undefined || opts.archivedInput === true, archivedInput: opts.archivedInput });
      const parsed = yield {
          pooled: pool => timer.pool(() => task.pooled(pool)),
      };
      const rows = parsed.rows;
      inv.checked += parsed.invariant.checked;
      inv.violations += parsed.invariant.violations;
      inv.examples.push(...parsed.invariant.examples.slice(0, 5 - inv.examples.length));
      for (const row of rows) row.path = file;
      pending.push(...rows);
      fileStats.push({ file, size: st.size, mtime: st.mtimeMs, gens: rows.length });
      physicalFiles.push({ file, size: st.size, mtime: st.mtimeMs, gens: rows.length, changed: true });
      opts.onFileChecked?.();
      timer.emit();
    }
    if (inv.checked > 0 && inv.violations / inv.checked > INVARIANT_TOLERANCE) {
      // Abort before the transaction so a changed wire format cannot write plausible-looking garbage.
      throw new Error(
        `gemini: niezmiennik out_total = thinking + visible złamany w ${inv.violations}/${inv.checked} generacji ` +
          `(próg ${(INVARIANT_TOLERANCE * 100).toFixed(0)}%). Najpewniej agy przenumerowało pola protobufu i ścieżki ` +
          `w src/ingest/gemini.ts wskazują teraz na co innego. NIC NIE ZAPISANO. Przykłady:\n  ` +
          inv.examples.join("\n  ")
      );
    }
    const now = new Date().toISOString();
    let dirtyRange: { from: string; to: string } | null = null;
    const writeStarted=performance.now();
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const previousProjects = new Map<string, string>();
      const insEvent = sqlite.prepare(
        `INSERT INTO gemini_events
           (store, conversation_id, gen_idx, ts, ts_basis, model, workspace, path,
            fresh_in, cached_in, out_total, out_thinking, out_visible,
            context_tokens, context_limit, usd, project_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (store, conversation_id, gen_idx) DO UPDATE SET
           ts=excluded.ts,
           ts_basis=excluded.ts_basis,
           model=excluded.model,
           workspace=excluded.workspace,
           path=excluded.path,
           fresh_in=excluded.fresh_in,
           cached_in=excluded.cached_in,
           out_total=excluded.out_total,
           out_thinking=excluded.out_thinking,
           out_visible=excluded.out_visible,
           context_tokens=excluded.context_tokens,
           context_limit=excluded.context_limit,
           usd=excluded.usd,
           project_id=excluded.project_id`
      );
      statements.push(insEvent);
      const insFile = sqlite.prepare(
        `INSERT OR REPLACE INTO gemini_files (store, path, size, mtime, generations, ingested_at)
         VALUES (?,?,?,?,?,?)`
      );
      statements.push(insFile);
      const readHistory = sqlite.query(
        `SELECT ${GEMINI_EVENT_COLUMNS.join(", ")} FROM gemini_events WHERE store = ? AND path = ?`,
      );
      const restoreHistory = sqlite.query(
        `INSERT INTO gemini_events (${GEMINI_EVENT_COLUMNS.join(", ")})
         VALUES (${GEMINI_EVENT_COLUMNS.map(() => "?").join(", ")})`,
      );
      const incomingByPath=new Map<string,GenRow[]>();
      for(const row of pending){const rows=incomingByPath.get(row.path)??[];rows.push(row);incomingByPath.set(row.path,rows);}
      for (const f of physicalFiles) {
        const incoming=f.changed?(incomingByPath.get(f.file)??[]):readHistory.all(f.sourceStore??store,f.file) as Array<{conversation_id:string;gen_idx:number}>;
        const generations=new Set(incoming.map(row=>JSON.stringify([row.conversation_id,row.gen_idx])));
        const conversations=JSON.stringify([...new Set(incoming.map(row=>row.conversation_id))]);
        for(const database of [sqlite,accepted])if(database && incoming.length) {
          const conflicts=database.query(`SELECT conversation_id,gen_idx FROM gemini_events
            WHERE store=? AND conversation_id IN (SELECT value FROM json_each(?)) AND path<>?`)
            .all(store,conversations,f.file) as Array<{conversation_id:string;gen_idx:number}>;
          if(conflicts.some(row=>generations.has(JSON.stringify([row.conversation_id,row.gen_idx]))))
            throw new Error("Gemini source identity conflicts with a different conversation path; no source facts were changed");
        }
        const legacyStores = (seen.get(f.file) ?? []).map((row) => row.store).filter((id) => id !== store).sort();
        if (!f.changed && legacyStores.length === 0) continue;

        // Bookmarks identify the indexed store/path histories to reconcile. Preserve
        // target annotations first, while token data comes only from the unique
        // matching source (or the physical file when bookmarks are ambiguous).
        let authoritative: Array<Record<string, SQLQueryBindings>> = [];
        for (const candidate of [store, ...legacyStores]) {
          const history = readHistory.all(candidate, f.file) as Array<Record<string, SQLQueryBindings>>;
          if (candidate === f.sourceStore) authoritative = history;
          for (const row of history) {
            dirtyRange = extendDirtyRange(dirtyRange, row.ts as string);
            const key = `${f.file}\u0000${row.conversation_id}\u0000${row.gen_idx}`;
            if (row.project_id != null && !previousProjects.has(key)) {
              previousProjects.set(key, row.project_id as string);
            }
          }
          sqlite.query("DELETE FROM gemini_events WHERE store = ? AND path = ?").run(candidate, f.file);
          if (candidate !== store) {
            sqlite.query("DELETE FROM gemini_files WHERE store = ? AND path = ?").run(candidate, f.file);
          }
        }
        if (!f.changed) {
          for (const row of authoritative) {
            row.store = store;
            row.project_id = previousProjects.get(`${f.file}\u0000${row.conversation_id}\u0000${row.gen_idx}`) ?? null;
            restoreHistory.run(...GEMINI_EVENT_COLUMNS.map((column) => row[column] ?? null));
          }
        }
      }
      for (const g of pending) {
        dirtyRange = extendDirtyRange(dirtyRange, g.ts);
        const usd = priceOf(g, rates);
        if (usd === 0 && g.model) unpriced[g.model] = (unpriced[g.model] ?? 0) + g.fresh_in + g.cached_in + g.out_total;
        insEvent.run(
          store,
          g.conversation_id,
          g.gen_idx,
          g.ts,
          g.ts_basis,
          g.model,
          g.workspace,
          g.path,
          g.fresh_in,
          g.cached_in,
          g.out_total,
          g.out_thinking,
          g.out_visible,
          g.context_tokens,
          g.context_limit,
          usd,
          previousProjects.get(`${g.path}\u0000${g.conversation_id}\u0000${g.gen_idx}`) ?? null
        );
      }
      for (const f of physicalFiles) {
        if(f.changed || seen.get(f.file)?.some(row=>row.store!==store))
          insFile.run(store, f.file, f.size, f.mtime, f.gens, now);
      }
      sqlite.exec("COMMIT");
      timer.add("stageWriteMs",performance.now()-writeStarted);timer.emit(true);
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
    return {
      ...(opts.onTimings?{timings:timer.snapshot()}:{}),
      store,
      files: fileStats.length,
      skipped,
      reassigned,
      generations: pending.length,
      unpricedModels: unpriced,
      invariant: inv,
      dirtyRange,
    };
  } finally {
    try {
      for (const statement of statements) statement.finalize();
    } finally {
      try{sqlite.close();}finally{accepted?.close();timer.stop();}
    }
  }
}

export function discoverStores(atlasPath = activeDatabasePath()): Array<{ dir: string; store: string }> {
  const out: Array<{ dir: string; store: string }> = [];
  const profiles = archiveProfiles("gemini");
  const persisted = persistedGeminiStores(atlasPath, profiles);
  for (const profile of profiles) {
    const dir = path.join(ARCHIVE_ROOT, profile, "conversations");
    if (!fs.existsSync(dir)) continue;
    const {store} = storeForGeminiProfile(profile,persisted.get(profile));
    out.push({ dir, store });
  }
  return out;
}
export function ingestGeminiAsync(...args: Parameters<typeof ingestGeminiSteps>): Promise<GeminiIngestResult> {
  return runFileTasks(ingestGeminiSteps(...args), args[2]?.parsePool);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const force = args.includes("--force");
  const homeFlag = flag("--home");
  const storeFlag = flag("--store");
  const targets = homeFlag ? [{ dir: homeFlag, store: storeFlag ?? "main" }] : discoverStores(flag("--db") ?? activeDatabasePath());
  if (targets.length === 0) {
    console.error("gemini: nie znaleziono żadnego katalogu rozmów w archiwum");
    process.exit(1);
  }
  for (const t of targets) {
    const r = await ingestGeminiAsync(t.dir, t.store, { force, atlasPath: flag("--db") ?? activeDatabasePath(), archivedInput: true });
    console.log(
      `gemini_events[${r.store}]: ${r.generations.toLocaleString()} generacji z ${r.files} rozmów, ${r.skipped} bez zmian ` +
        `· niezmiennik ${r.invariant.checked - r.invariant.violations}/${r.invariant.checked}`
    );
    const un = Object.entries(r.unpricedModels).sort((a, b) => b[1] - a[1]);
    if (un.length > 0) {
      console.log(
        `  bez stawki (${un.length}): ` +
          un
            .slice(0, 5)
            .map(([m, t2]) => `${m} ${(t2 / 1e6).toFixed(1)}M`)
            .join(", ")
      );
    }
  }
}
