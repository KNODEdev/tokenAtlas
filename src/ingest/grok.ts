import { archiveSourceIdentity } from "../shared/archive-codec-path";
import { selectArchiveRepresentation } from "./archive-codec";
import { decodeCwd, type TurnRow } from "./grok-types";
import type { ParsePool } from "./parse-pool";
import { fileParseTask, runFileTasks, type FileParseTask } from "./file-parse-tasks";
import fs from "node:fs";
import {IngestTimer,type IngestTimings,type IngestTimingHandler} from "./ingest-timings";
import { exactFiles, isSourceConflict } from "./exact-files";
import path from "node:path";
import { Database } from "../db/sqlite";
import { grokSourceIdentity } from "./grok-source";
import { ensureArchiveIdentity } from "../sync/archive-inventory";
import { GROK_TICKS_PER_USD } from "../shared/grok-usage";
import { archive, archiveProfiles, preferredProfile, PROFILE } from "../config/paths";
const ARCHIVE_PROFILE = preferredProfile("grok");
const ARCHIVE_HOME = ARCHIVE_PROFILE
  ? archive("grok", ARCHIVE_PROFILE, "sessions")
  : archive("grok", PROFILE, "sessions");
export { GROK_TICKS_PER_USD } from "../shared/grok-usage";
// xAI documents no tick scale, so keep raw ticks in storage and apply this assumption at read time.
export function usdOfTicks(ticks: number): number {
  return ticks / GROK_TICKS_PER_USD;
}
export { decodeCwd } from "./grok-types";
const turnKey = (row: Pick<TurnRow,"session_id"|"prompt_id"|"model">) =>
  JSON.stringify([row.session_id,row.prompt_id,row.model]);
export function findSessionFiles(root: string): { file: string; cwd: string | null }[] {
  const out: { file: string; cwd: string | null }[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || isSourceConflict(d.name)) continue;
    const cwd = decodeCwd(d.name);
    const cwdDir = path.join(root, d.name);
    let sessions: fs.Dirent[];
    try {
      sessions = fs.readdirSync(cwdDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sdir of sessions) {
      if (!sdir.isDirectory() || isSourceConflict(sdir.name)) continue;
      const file = selectArchiveRepresentation(path.join(cwdDir, sdir.name, "updates.jsonl"));
      if (fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()) out.push({ file, cwd });
    }
  }
  return out;
}
export interface GrokIngestResult {
  timings?:IngestTimings;
  files: number;
  skipped: number;
  turns: number;
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
function* ingestGrokSteps(
  sessionsRoot: string,
  store: string,
  opts: { force?: boolean; atlasPath?: string; sourceAtlasPath?: string; sourceId?: string; logicalPath?: (physical: string) => string; files?: string[];
    discoveredFiles?: ReturnType<typeof findSessionFiles>; onFileChecked?: () => void; onTimings?:IngestTimingHandler; parsePool?: ParsePool } = {}
): Generator<FileParseTask<TurnRow[]>, GrokIngestResult, TurnRow[]> {
  const timer=new IngestTimer(opts.onTimings);
  const { initDb } = require("../db") as typeof import("../db");
  const { sqlite } = initDb(opts.atlasPath);
  let active: Database | null = null;
  const statements: Array<{ finalize(): void }> = [];
  try {
    const sourceId = opts.sourceId ?? "";
    active = opts.sourceAtlasPath && opts.sourceAtlasPath !== opts.atlasPath
      ? new Database(opts.sourceAtlasPath, { readonly: true }) : null;
    const files = timer.measure("discoveryMs",()=> (opts.files === undefined ? opts.discoveredFiles ?? findSessionFiles(sessionsRoot) : [...new Set(exactFiles(opts.files, sessionsRoot).map(archiveSourceIdentity))].map(file => {
      file = selectArchiveRepresentation(file);
      const relative = path.relative(path.resolve(sessionsRoot), file).split(path.sep);
      if (relative.length !== 3 || archiveSourceIdentity(relative[2]!) !== "updates.jsonl") throw new Error(`Invalid Grok session path: ${file}`);
      return { file, cwd: decodeCwd(relative[0]!) };
    })).sort((a,b) => a.file.localeCompare(b.file)));timer.emit(true);
    const seen = new Map<string, { size: number; mtime: number; source_id: string }>();
    try {
      const bookmarks = opts.files === undefined ? sqlite
        .query("SELECT path, size, mtime, source_id FROM grok_files WHERE store = ?")
        .all(store) : files.flatMap(({file}) => sqlite.query("SELECT path, size, mtime, source_id FROM grok_files WHERE store = ? AND path = ?").all(store, opts.logicalPath?.(file) ?? archiveSourceIdentity(file)));
      for (const r of bookmarks as Array<{ path: string; size: number; mtime: number; source_id: string }>) {
        seen.set(r.path, r);
      }
    } catch {
    }
    const now = new Date().toISOString();
    let ingestedFiles = 0;
    let skipped = 0;
    let turns = 0;
    let dirtyRange: { from: string; to: string } | null = null;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const insEvent = sqlite.prepare(
        `INSERT INTO grok_events
           (store, source_id, session_id, prompt_id, ts, model, stop_reason, cwd, project, path,
            in_tok, cached_in, cache_write, out_tok, reasoning, model_calls,
            api_duration_ms, cost_ticks, project_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (store, source_id, session_id, prompt_id, model) DO UPDATE SET
           ts=excluded.ts,
           stop_reason=excluded.stop_reason,
           cwd=excluded.cwd,
           project=excluded.project,
           path=excluded.path,
           in_tok=excluded.in_tok,
           cached_in=excluded.cached_in,
           cache_write=excluded.cache_write,
           out_tok=excluded.out_tok,
           reasoning=excluded.reasoning,
           model_calls=excluded.model_calls,
           api_duration_ms=excluded.api_duration_ms,
           cost_ticks=excluded.cost_ticks,
           project_id=excluded.project_id`
      );
      statements.push(insEvent);
      const insFile = sqlite.prepare(
        `INSERT OR REPLACE INTO grok_files (store, source_id, path, size, mtime, turns, ingested_at)
         VALUES (?,?,?,?,?,?,?)`
      );
      statements.push(insFile);
      for (const { file: physicalFile, cwd } of files) {
        const file = opts.logicalPath?.(physicalFile) ?? archiveSourceIdentity(physicalFile);
        let st: fs.Stats;
        try {
          st = fs.statSync(physicalFile);
        } catch (error) {
          if (opts.files !== undefined) throw error;
          opts.onFileChecked?.();
          continue;
        }
        const prev = seen.get(file);
        if (!opts.force && prev && prev.source_id === sourceId && prev.size === st.size && prev.mtime === st.mtimeMs) {
          skipped += 1;
          opts.onFileChecked?.();
          continue;
        }
        const task = fileParseTask("grok", { file: physicalFile, cwd, strictRead: opts.files !== undefined });
        const rows = yield {
          pooled: pool => timer.pool(() => task.pooled(pool)),
        };
        for (const row of rows) row.path = file;
        const writeStarted=performance.now();
        type StoredTurn = TurnRow & {source_id:string;project_id:string|null};
        const sessions=JSON.stringify([...new Set(rows.map(row=>row.session_id))]);
        const read=(database:Database)=>database.query(`SELECT * FROM grok_events WHERE store=? AND path=?
          UNION ALL SELECT * FROM grok_events WHERE store=? AND source_id=?
            AND session_id IN (SELECT value FROM json_each(?)) AND path<>?`)
          .all(store,file,store,sourceId,sessions,file) as StoredTurn[];
        const staged=read(sqlite),accepted=active?read(active):staged;
        const annotations=new Map<string,string|null>();
        for(const old of accepted)if(old.path===file && !annotations.has(turnKey(old)))
          annotations.set(turnKey(old),old.project_id);
        const existingRows=new Map(staged.filter(row=>row.path!==file && row.source_id===sourceId).map(row=>[turnKey(row),row]));
        const acceptedRows=new Map(accepted.filter(row=>row.source_id===sourceId).map(row=>[turnKey(row),row]));
        for(const old of staged)if(old.path===file)dirtyRange=extendDirtyRange(dirtyRange,old.ts);
        sqlite.query("DELETE FROM grok_events WHERE store = ? AND path = ?").run(store, file);
        for (const r of rows) {
          dirtyRange = extendDirtyRange(dirtyRange, r.ts);
          const key=turnKey(r);
          const existing=existingRows.get(key);
          const previous=existing ?? (active?acceptedRows.get(key):undefined);
          if (sourceId && previous && previous.path !== file) {
            const fields = Object.keys(r).filter(key => key !== "path") as Array<keyof TurnRow>;
            if (fields.some(key => previous[key] !== r[key])) throw new Error(`Conflicting Grok replicas for source ${sourceId}, session ${r.session_id}, prompt ${r.prompt_id}`);
            if (existing) continue;
            // Keep the canonical physical owner when an unchanged replica is encountered in a delta stage.
            r.path = previous.path;
          }
          const annotation = annotations.get(key) ?? previous?.project_id ?? null;
          insEvent.run(
            store,
            sourceId,
            r.session_id,
            r.prompt_id,
            r.ts,
            r.model,
            r.stop_reason,
            r.cwd,
            r.project,
            r.path,
            r.in_tok,
            r.cached_in,
            r.cache_write,
            r.out_tok,
            r.reasoning,
            r.model_calls,
            r.api_duration_ms,
            r.cost_ticks,
            annotation
          );
          existingRows.set(key,{...r,source_id:sourceId,project_id:annotation});
        }
        insFile.run(store, sourceId, file, st.size, st.mtimeMs, rows.length, now);
        timer.add("stageWriteMs",performance.now()-writeStarted);timer.emit();
        ingestedFiles += 1;
        turns += rows.length;
        opts.onFileChecked?.();
      }
      timer.measure("stageWriteMs",()=>sqlite.exec("COMMIT"));timer.emit(true);
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
    return {
      ...(opts.onTimings?{timings:timer.snapshot()}:{}),
      files: ingestedFiles,
      skipped,
      turns,
      dirtyRange,
    };
  } finally {
    try {
      for (const statement of statements) statement.finalize();
    } finally {
      try { active?.close(); } finally { sqlite.close();timer.stop(); }
    }
  }
}

export function ingestGrokAsync(...args: Parameters<typeof ingestGrokSteps>): Promise<GrokIngestResult> {
  return runFileTasks(ingestGrokSteps(...args), args[2]?.parsePool);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const store = flag("--store") ?? "grok";
  const force = args.includes("--force");
  const explicit = flag("--home");
  const roots = explicit
    ? [explicit]
    : archiveProfiles("grok")
        .map((p) => archive("grok", p, "sessions"))
        .filter((d) => fs.existsSync(d));
  if (roots.length === 0) {
    console.error(`grok sessions not found: ${ARCHIVE_HOME}`);
    process.exit(1);
  }
  let turns = 0;
  let files = 0;
  let skipped = 0;
  for (const root of roots) {
    const archiveRoot = archive();
    const relative = path.relative(archiveRoot, root);
    const sourceId = flag("--source-id") ?? (!relative.startsWith("..") && !path.isAbsolute(relative)
      ? grokSourceIdentity(root, { archiveRoot, archiveId: ensureArchiveIdentity(archiveRoot) }) ?? "" : "");
    const r = await ingestGrokAsync(root, store, { force, sourceId });
    turns += r.turns;
    files += r.files;
    skipped += r.skipped;
  }
  console.log(
    `grok_events[${store}]: ${turns.toLocaleString()} turn-rows from ${files} file(s) in ${roots.length} root(s), ${skipped} unchanged`
  );
}
