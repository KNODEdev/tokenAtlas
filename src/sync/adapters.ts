import { jsonlArchiveSource } from "../shared/archive-codec-path";
import { withDecodedArchiveFiles } from "../ingest/archive-codec";
import fs from "node:fs";
import { compressedRollout, rolloutIdentity } from "../shared/codex-rollout-path";
import { validateArchivedJsonl } from "./jsonl-inspection";
import { ParsePool, ParseWorkerError, parseWorkerCount } from "../ingest/parse-pool";
import path from "node:path";
import {
  ARCHIVE_LOGICAL_ROOT,
  ARCHIVE_ROOT,
  archive,
  archiveProfiles,
  configFile,
  toArchiveLogicalPath,
  toArchivePhysicalPath,
} from "../config/paths";
import { ingestClaude } from "../ingest/claude";
import { declaredCodexHomes, ensureCodexSchema, readableCodexHomes, syncCodex } from "../ingest/codex";
import { Database } from "../db/sqlite";
import { initDb } from "../db";
import { ingestGaugesAsync } from "../ingest/gauges";
import { ingestGeminiAsync, listGeminiConversationFiles, persistedGeminiStores, storeForGeminiProfile } from "../ingest/gemini";
import { findSessionFiles, ingestGrokAsync } from "../ingest/grok";
import { grokSourceIdentity } from "../ingest/grok-source";
import { ensureArchiveIdentity } from "./archive-inventory";
import { readArchiveIdentity } from "./archive-local-state";
import { ingestOpencodeAsync } from "../ingest/opencode";
import type { DirtyTimestampRange, SyncMode, VendorId } from "./contracts";
import {IngestTimer,sumIngestTimings,type IngestTimingHandler,type IngestTimings} from "../ingest/ingest-timings";
import { DIAGNOSTIC_LIST_LIMIT, boundedDiagnostics } from "./store";
/**
 * Registered sources a reread must cover. A rebuild reads the archive only: a source registered
 * elsewhere is left unread, so the reparse refuses to publish instead of reading the original.
 */
function reparseSources(context: AdapterContext): NonNullable<AdapterContext["reparseSources"]> {
  return (context.reparseSources ?? []).filter(source => {
    if (context.changedFiles !== undefined && !context.changedFiles.some(file =>
      toArchiveLogicalPath(file) === toArchiveLogicalPath(source.path))) return false;
    if (!context.rebuild) return true;
    const relative = path.relative(ARCHIVE_LOGICAL_ROOT, toArchiveLogicalPath(source.path));
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}
function profiles(context: AdapterContext, vendor: string): string[] {
  if(context.changedFiles)return [...new Set(context.changedFiles.map(file=>path.relative(ARCHIVE_ROOT,file).split(path.sep)).filter(parts=>parts[0]===vendor&&parts.length>2).map(parts=>parts[1]!))];
  return archiveProfiles(vendor);
}

export interface AdapterContext {
  parsePool?: ParsePool;
  firstFill?:boolean;
  onIngestTimings?:IngestTimingHandler;
  onFileProgress?: (completed: number, total: number) => void;
  onFileDiscovery?: (found: number) => void;
  changedFiles?:string[];
  gaugeEvidenceDbPath?: string;
  activeDbPath: string;
  stageDbPath: string;
  mode: SyncMode;
  reparse?: boolean;
  reparseSources?: Array<Record<string,string|number> & {path:string}>;
  rootDir: string;
  /** A rebuild generation reads the archive in place and nothing outside it. */
  rebuild?: boolean;
}

export interface NormalizedAdapterResult {
  processedFiles?:string[];
  /** Whole-file SHA-256 from the parsing read, for parsers that produce it outside the stage tables. */
  sourceDigests?:Array<{path:string;sha256:string;byteLength:number}>;
  failedInputs?:Array<{path:string;error:string}>;
  processedInputs: number;
  skippedInputs: number;
  writtenRows: number;
  dirtyRange: DirtyTimestampRange | null;
  diagnostics: Record<string, unknown>;
  validationErrors: string[];
  /** Readable inputs succeeded, but unavailable inputs still need another pass. */
  retryRequired?: boolean;
}

export type VendorAdapter = (context: AdapterContext) => Promise<NormalizedAdapterResult>;
export type VendorAdapters = Record<VendorId, VendorAdapter>;

/** A diagnostic list keeps its first entries and, when longer, its real count. */
export function cappedList<T>(name: string, items: T[]): Record<string, unknown> {
  return {
    [name]: items.slice(0, DIAGNOSTIC_LIST_LIMIT),
    ...(items.length > DIAGNOSTIC_LIST_LIMIT ? { [`${name}Total`]: items.length } : {}),
  };
}

/** Engine output is a tail sample: the last lines carry the failure. */
function unavailableSource(message:string):NormalizedAdapterResult {
  return {processedInputs:0,skippedInputs:0,writtenRows:0,dirtyRange:null,diagnostics:{warnings:[message]},validationErrors:[]};
}

function mergeRange(
  current: DirtyTimestampRange | null,
  next: DirtyTimestampRange | null
): DirtyTimestampRange | null {
  if (!next) return current;
  if (!current) return next;
  return {
    from: next.from < current.from ? next.from : current.from,
    to: next.to > current.to ? next.to : current.to,
  };
}

async function runCodex(context: AdapterContext): Promise<NormalizedAdapterResult> {
  const setupTimer=new IngestTimer(context.onIngestTimings),setupEnd=setupTimer.begin("providerSetupMs");
  try {
  const homes = context.changedFiles || context.rebuild
    ? profiles(context, "codex").filter(profile => profile !== "_ledger").map(profile => archive("codex", profile)) : [];
  // Without an archived home the import would fall back to declared provider folders.
  if (context.rebuild && !homes.length) return unavailableSource("Codex archive has no session profile; previously indexed data preserved.");
  // Incremental stages contain bookmarks, not old facts, while publication diffs each changed
  // rollout against the stored rows, so the stage holds each changed rollout's complete history.
  const files = context.changedFiles?.filter(file => /[/\\](?:sessions|archived_sessions)[/\\].*\.jsonl(?:\.zst)?$/i.test(file));
  let scanned = homes.length ? homes : declaredCodexHomes();
  if (files === undefined) scanned = readableCodexHomes(scanned);
  if (!scanned.length && !(files && files.length === 0)) {
    if (context.reparse) return unavailableSource("Codex sources unavailable; previously indexed data preserved.");
    throw new Error("Codex import found no readable CODEX_HOME");
  }
  const { sqlite: stage } = initDb(context.stageDbPath);
  let result;
  try {
    ensureCodexSchema(stage);
    setupEnd();setupTimer.stop();
    const setupTimings=setupTimer.snapshot();
    result = await syncCodex(stage, {
      pool: context.parsePool,
      homes: scanned,
      files,
      force: context.reparse === true || context.changedFiles !== undefined,
      // Homes registered by an earlier index may lie outside the archive; a rebuild never reads them.
      exactHomes: context.rebuild === true,
      onDiscovery: context.onFileDiscovery,
      onFileProgress: context.onFileProgress,
      validateJsonl: context.changedFiles !== undefined,
      firstFill: context.firstFill === true,
      onTimings:timing=>context.onIngestTimings?.(sumIngestTimings([setupTimings,timing])),
    });
    if(result.timings)result.timings=sumIngestTimings([setupTimings,result.timings]);
  } finally {const closeStarted=performance.now();stage.close();setupTimer.stop();if(result?.timings){const ms=Math.round(performance.now()-closeStarted);result.timings.overheadMs=(result.timings.overheadMs??0)+ms;result.timings.elapsedMs+=ms;result.timings.steps={...result.timings.steps,dbCloseMs:ms};}}
  const unavailable = result.unavailable_inputs;
  return {
    processedInputs: result.processed_inputs,
    sourceDigests: result.source_digests,
    failedInputs:unavailable.map(input=>({path:toArchivePhysicalPath(input.path),error:input.message})),
    ...(files?{processedFiles:files.filter(file=>!unavailable.some(input=>toArchiveLogicalPath(rolloutIdentity(file))===input.path))}:{}),
    skippedInputs: result.skipped_inputs,
    writtenRows: result.written_rows,
    dirtyRange: result.dirty_range,
    diagnostics: {
      ingestTimings:result.timings,
      filePreparation: result.preparation,
      ...cappedList("unavailableInputs", unavailable),
      ...(unavailable.length ? cappedList("warnings", unavailable.map(input =>
        `Codex transcript unavailable and kept for retry: ${input.path}: ${input.message}`)) : {}),
    },
    validationErrors: [],
    retryRequired: unavailable.length > 0,
  };
  }finally{setupEnd();setupTimer.stop();}
}

async function runClaude(context: AdapterContext): Promise<NormalizedAdapterResult> {
  const result = await ingestClaude({
    firstFill: context.firstFill,
    onFileProgress: context.onFileProgress,
    onTimings:context.onIngestTimings,
    dbPath: context.stageDbPath,
    force: context.reparse === true||context.changedFiles!==undefined,
    files:context.changedFiles?.filter(file=>jsonlArchiveSource(file)),
    isolateSelectedFiles:context.changedFiles!==undefined,
    validateJsonl:context.changedFiles!==undefined,
    // Coordinator stages inherit the already migrated active schema. Migrating a
    // disposable stage would reinstall its deliberately omitted trackers.
    skipMigrations: true,
    additionalInputs:reparseSources(context).map(source=>({store:String(source.store),path:toArchivePhysicalPath(source.path)})),
    // The archive's profile folders, stored the way ordinary archive reads store them;
    // store overrides pointing at provider folders do not apply to a rebuild.
    ...(context.rebuild ? { exclusiveInputs: profiles(context, "claude").map(profile =>
      ({store:profile.endsWith("-desktop")?"desktop":"live",path:archive("claude",profile)})) } : {}),
  });
  return {
    processedInputs: result.processed,
    skippedInputs: result.skipped,
    writtenRows: result.writtenRows,
    dirtyRange: result.dirtyRange,
    ...(result.failedInputs?{failedInputs:result.failedInputs,processedFiles:result.processedFiles}:{}),
    ...(result.sourceDigests?{sourceDigests:result.sourceDigests}:{}),
    diagnostics: {
      ingestTimings:result.timings,
      discovered: result.discovered,
      unreadable: result.unreadable,
      timings: result.timings,
    },
    validationErrors:
      result.unreadable > 0 && result.failedInputs===undefined ? [`${result.unreadable} Claude input(s) could not be read`] : [],
    retryRequired: result.unreadable > 0,
  };
}

async function runOpencode(context: AdapterContext): Promise<NormalizedAdapterResult> {
  const snapshots = profiles(context, "opencode")
    .map((machine) => ({
      file: archive("opencode", machine, "opencode.sqlite"),
      store: machine,
    }))
    .filter((item) => fs.existsSync(item.file));
  for(const source of reparseSources(context))if(!snapshots.some(snapshot=>snapshot.store===source.store))
    snapshots.push({file:toArchivePhysicalPath(source.path),store:String(source.store)});
  if (snapshots.length === 0) {
    if(context.reparse)return unavailableSource("OpenCode sources unavailable; previously indexed data preserved.");
    throw new Error(`No OpenCode archive snapshot found in ${archive("opencode")}`);
  }
  let processed = 0;
  let skipped = 0;
  let written = 0;
  let dirtyRange: DirtyTimestampRange | null = null;
  const stores: Record<string, unknown> = {};
  const timingParts:IngestTimings[]=[];
  context.onFileProgress?.(0, snapshots.length);
  for (const snapshot of snapshots) {
    const result = await ingestOpencodeAsync(snapshot.file, snapshot.store, {
      parsePool: context.parsePool,
      atlasPath: context.stageDbPath,
      force: context.reparse === true||context.changedFiles!==undefined,
      logicalPath: toArchiveLogicalPath(snapshot.file),
      archivedInput: true,
      onTimings:timing=>context.onIngestTimings?.(sumIngestTimings([...timingParts,timing])),
    });
    stores[snapshot.store] = result;
    if(result.timings)timingParts.push(result.timings);
    if (result.skipped) skipped += 1;
    else {
      processed += 1;
      written += result.rows;
      dirtyRange = mergeRange(dirtyRange, result.dirtyRange ?? null);
    }
    context.onFileProgress?.(processed + skipped, snapshots.length);
  }
  return {
    processedInputs: processed,
    skippedInputs: skipped,
    writtenRows: written,
    dirtyRange,
    diagnostics: { stores,ingestTimings:sumIngestTimings(timingParts) },
    validationErrors: [],
  };
}

async function runGrok(context: AdapterContext): Promise<NormalizedAdapterResult> {
  const roots = profiles(context, "grok")
    .map((profile) => ({root:archive("grok", profile, "sessions"),store:"grok"}))
    .filter((item) => fs.existsSync(item.root));
  for(const source of reparseSources(context)) {
    const root=path.dirname(path.dirname(path.dirname(toArchivePhysicalPath(source.path)))),store=String(source.store);
    if(!roots.some(item=>item.root===root && item.store===store))roots.push({root,store});
  }
  if (roots.length === 0) {
    if(context.reparse)return unavailableSource("Grok sources unavailable; previously indexed data preserved.");
    throw new Error(`No Grok archive sessions found in ${archive("grok")}`);
  }
  let processed = 0;
  let skipped = 0;
  let written = 0;
  let dirtyRange: DirtyTimestampRange | null = null;
  const rootsDiagnostics: Record<string, unknown> = {};
  const timingParts:IngestTimings[]=[];
  const inventories = context.changedFiles === undefined && context.onFileProgress
    ? roots.map(item => findSessionFiles(item.root)) : undefined;
  const totalFiles = inventories?.reduce((total, files) => total + files.length, 0) ?? 0;
  let completedFiles = 0;
  if (inventories) context.onFileProgress?.(0, totalFiles);
  for (const [index, {root,store}] of roots.entries()) {
    const result = await ingestGrokAsync(root, store, {
      parsePool: context.parsePool,
      files:context.changedFiles?.filter(file=>path.relative(root,file)!==".."&&!path.relative(root,file).startsWith(`..${path.sep}`)),
      atlasPath: context.stageDbPath,
      sourceAtlasPath: context.activeDbPath,
      sourceId: grokSourceIdentity(toArchiveLogicalPath(root), {
        archiveRoot: ARCHIVE_LOGICAL_ROOT,
        archiveId: context.rebuild ? readArchiveIdentity(archive()) : ensureArchiveIdentity(archive()),
      }) ?? "",
      force: context.reparse === true||context.changedFiles!==undefined,
      logicalPath: toArchiveLogicalPath,
      onTimings:timing=>context.onIngestTimings?.(sumIngestTimings([...timingParts,timing])),
      ...(inventories ? { discoveredFiles: inventories[index], onFileChecked: () =>
        context.onFileProgress?.(++completedFiles, totalFiles) } : {}),
    });
    rootsDiagnostics[root] = result;
    if(result.timings)timingParts.push(result.timings);
    processed += result.files;
    skipped += result.skipped;
    written += result.turns;
    dirtyRange = mergeRange(dirtyRange, result.dirtyRange);
  }
  return {
    processedInputs: processed,
    skippedInputs: skipped,
    writtenRows: written,
    dirtyRange,
    diagnostics: { roots: rootsDiagnostics,ingestTimings:sumIngestTimings(timingParts) },
    validationErrors: [],
  };
}

function* geminiTargetSteps(
  context: AdapterContext,
  targets: Array<{ profile: string; dir: string; store: string }>,
  inventories?: ReadonlyMap<string, string[]>,
): Generator<Parameters<typeof ingestGeminiAsync>, NormalizedAdapterResult, Awaited<ReturnType<typeof ingestGeminiAsync>>> {
  let processed = 0;
  let skipped = 0;
  let written = 0;
  let dirtyRange: DirtyTimestampRange | null = null;
  const stores: Record<string, unknown> = {};
  const timingParts:IngestTimings[]=[];
  const totalFiles = inventories ? [...inventories.values()].reduce((total, files) => total + files.length, 0)
    : context.changedFiles?.filter(file=>targets.some(target=>path.dirname(file)===path.resolve(target.dir))&&file.endsWith(".db")).length??0;
  let completedFiles = 0;
  context.onFileProgress?.(0, totalFiles);
  for (const target of targets) {
    const result = yield [target.dir, target.store, {
      parsePool: context.parsePool,
      files:context.changedFiles?.filter(file=>path.dirname(file)===path.resolve(target.dir)&&file.endsWith(".db")),
      atlasPath: context.stageDbPath,
      sourceAtlasPath: context.activeDbPath,
      force: context.reparse === true||context.changedFiles!==undefined,
      rootDir: context.rootDir,
      logicalPath: toArchiveLogicalPath,
      archivedInput: true,
      onTimings:timing=>context.onIngestTimings?.(sumIngestTimings([...timingParts,timing])),
      ...(inventories ? { discoveredFiles: inventories.get(target.dir) } : {}),
      onFileChecked:()=>context.onFileProgress?.(++completedFiles,totalFiles),
    }];
    stores[target.profile] = result;
    if(result.timings)timingParts.push(result.timings);
    processed += result.files + result.reassigned;
    skipped += result.skipped - result.reassigned;
    written += result.generations;
    dirtyRange = mergeRange(dirtyRange, result.dirtyRange);
  }
  return {
    processedInputs: processed,
    skippedInputs: skipped,
    writtenRows: written,
    dirtyRange,
    diagnostics: { stores,ingestTimings:sumIngestTimings(timingParts) },
    validationErrors: [],
  };
}

export async function ingestGeminiTargetsAsync(...args: Parameters<typeof geminiTargetSteps>): Promise<NormalizedAdapterResult> {
  const steps = geminiTargetSteps(...args);
  let next = steps.next();
  while (!next.done) next = steps.next(await ingestGeminiAsync(...next.value));
  return next.value;
}

async function runGemini(context: AdapterContext): Promise<NormalizedAdapterResult> {
  const profileNames = profiles(context, "gemini");
  const persisted = persistedGeminiStores(context.activeDbPath, profileNames);
  const targets = profileNames
    .map((profile) => ({
      profile,
      dir: archive("gemini", profile, "conversations"),
      ...storeForGeminiProfile(profile,persisted.get(profile)),
    }))
    .filter(target => fs.existsSync(target.dir));
  for(const source of reparseSources(context)) {
    const dir=path.dirname(toArchivePhysicalPath(source.path));
    if(!targets.some(target=>path.resolve(target.dir)===path.resolve(dir)))
      targets.push({profile:`registered:${source.store}:${dir}`,dir,store:String(source.store),account:null});
  }
  if (targets.length === 0) {
    if(context.reparse)return unavailableSource("Gemini sources unavailable; previously indexed data preserved.");
    throw new Error(`No Gemini archive conversations found in ${archive("gemini")}`);
  }
  const inventories = context.changedFiles === undefined && context.onFileProgress
    ? new Map(targets.map(target => [target.dir, listGeminiConversationFiles(target.dir)])) : undefined;
  const result=await ingestGeminiTargetsAsync(context, targets, inventories);
  return result;
}

async function runGauges(context: AdapterContext): Promise<NormalizedAdapterResult> {
  // No journal yet (the other machines have not deployed) is an empty
  // success, not a failure: the vendor exists so the first journal is picked
  // up the moment it appears.
  const result = await ingestGaugesAsync({ firstFill:context.firstFill,onTimings:context.onIngestTimings,atlasPath: context.stageDbPath, force: context.reparse === true, includeOwnStore: context.rebuild, files:context.changedFiles?.filter(file=>jsonlArchiveSource(file)), evidenceDbPath: context.gaugeEvidenceDbPath, onFileProgress: context.onFileProgress });
  return {
    processedInputs: result.files - result.skipped - (result.failedInputs?.length??0),
    failedInputs:result.failedInputs,processedFiles:result.processedFiles,retryRequired:!!result.failedInputs?.length,
    skippedInputs: result.skipped,
    writtenRows: result.rows,
    dirtyRange: null,
    diagnostics: { ingestTimings:result.timings,stores: result.stores, malformed: result.malformed, files: result.details },
    // A torn final line is left for the next read; a complete invalid row is not rebuild input.
    validationErrors: context.rebuild && result.malformed ? [`Gauge journal contains ${result.malformed} invalid rows`] : [],
  };
}

/**
 * `String(error)` of each file whose archived JSONL is incomplete or unparseable, undefined when
 * it is valid, in input order. Large batches are checked in parse workers; any worker failure
 * checks that file here. Progress is reported as files checked of all queued files.
 */
export async function validateQueuedJsonl(vendor:VendorId,files:string[],onProgress?:(completed:number,total:number)=>void,sharedPool?:ParsePool):Promise<Array<string|undefined>> {
  const check=(file:string)=>{
    try{if(jsonlArchiveSource(file)&&vendor!=="gauges")withDecodedArchiveFiles([file],([decoded])=>validateArchivedJsonl(decoded!));return undefined;}
    catch(error){return String(error);}
  };
  if (files.some(compressedRollout) && vendor !== "codex") return files.map(check);
  if (vendor === "codex" && files.some(compressedRollout)) {
    const pool = sharedPool ?? new ParsePool(Math.min(parseWorkerCount(), files.length));
    let completed = 0; onProgress?.(0, files.length);
    try {
      return await Promise.all(files.map(async file => {
        let error: string | undefined;
        try {
          if (compressedRollout(file)) {
            const prepared = await pool.run("codex", { file, size: fs.statSync(file).size, validate: true });
            if (prepared.kind === "read_error") throw new Error(prepared.message);
          } else error = check(file);
        } catch (cause) { error = String(cause); }
        onProgress?.(++completed, files.length); return error;
      }));
    } finally { if (!sharedPool) await pool.close(); }
  }
  const jsonl=files.filter(file=>file.endsWith(".jsonl")&&vendor!=="gauges").length;
  const workers=Math.min(parseWorkerCount(),jsonl);
  if(jsonl<64||workers<2)return files.map(check);
  const pool=sharedPool??new ParsePool(workers);
  let completed=0;
  onProgress?.(0,files.length);
  try {
    return await Promise.all(files.map(async file=>{
      const result=!file.endsWith(".jsonl")||vendor==="gauges"?undefined
        : await pool.run("validateJsonl",{file}).then(()=>undefined,(error:unknown)=>error instanceof ParseWorkerError?check(file):String(error));
      onProgress?.(++completed,files.length);
      return result;
    }));
  } finally {if(!sharedPool)await pool.close();}
}

function isolateQueuedInputs(vendor:VendorId,adapter:VendorAdapter):VendorAdapter {
  return async context=>{
    if(context.changedFiles===undefined) {
      const whole=await adapter(context);
      return {...whole,diagnostics:boundedDiagnostics(whole.diagnostics)};
    }
    const failedInputs:Array<{path:string;error:string}>=[];
    const valid:string[]=[];
    const validationTimer=new IngestTimer(context.onIngestTimings),validationEnd=validationTimer.begin("queuedValidationMs");
    let checks:Array<string|undefined>;
    // Codex, Claude and Grok check each file in the read that parses it (runCodex/runClaude validateJsonl):
    // a separate pass read every queued file twice, 259 s for Codex on a cold archive (03.10).
    const parserValidates=vendor==="codex"||vendor==="claude"||vendor==="grok";
    try{checks=parserValidates?context.changedFiles.map(()=>undefined)
      :await validateQueuedJsonl(vendor,context.changedFiles,context.onFileProgress,context.parsePool);}finally{validationEnd();validationTimer.stop();}
    for(const [index,file] of context.changedFiles.entries()) {
      const error=checks[index];
      if(error===undefined)valid.push(file);
      else failedInputs.push({path:file,error});
    }
    const result:NormalizedAdapterResult={processedInputs:0,skippedInputs:0,writtenRows:0,dirtyRange:null,
      diagnostics:{},validationErrors:[],processedFiles:[],failedInputs};
    const timingParts:IngestTimings[]=[validationTimer.snapshot()];
    // Batch fresh Gemini inputs to amortize setup. A failure retries the established
    // per-file path, preserving readable inputs and source identity collision checks.
    if(vendor==="gemini" && context.firstFill && valid.length>1) {
      let attempted:IngestTimings|undefined;
      try {
        const part=await adapter({...context,changedFiles:valid,onIngestTimings:timing=>{attempted=timing;context.onIngestTimings?.(timing);}});
        if(part.validationErrors.length)throw new Error(part.validationErrors.join("; "));
        return {...part,processedFiles:part.processedFiles??valid,failedInputs:[...failedInputs,...part.failedInputs??[]],
          diagnostics:boundedDiagnostics({...part.diagnostics,batchedInputs:valid.length})};
      }catch{if(attempted)timingParts.push(attempted);}
    }
    // These importers preserve each selected file's transaction and report failures independently.
    const batchGauge=vendor==="gauges" && context.firstFill;
    const groups=vendor==="codex"||vendor==="claude"||batchGauge?[valid]:valid.map(file=>[file]);
    const groupedFiles = vendor!=="codex" && vendor!=="claude" && !batchGauge;
    const invalidCount = failedInputs.length;
    if (groupedFiles) context.onFileProgress?.(invalidCount, context.changedFiles.length);
    let completedGroups = 0;
    for(const files of groups) {
      if(!files.length)continue;
      try {
        const part=await adapter({...context,changedFiles:files,
          onIngestTimings:timing=>context.onIngestTimings?.(sumIngestTimings([...timingParts,timing])),
          ...(groupedFiles ? { onFileProgress: undefined } : {})});
        if(part.validationErrors.length)throw new Error(part.validationErrors.join("; "));
        result.processedInputs+=part.processedInputs;result.skippedInputs+=part.skippedInputs;result.writtenRows+=part.writtenRows;
        result.dirtyRange=mergeRange(result.dirtyRange,part.dirtyRange);
        result.retryRequired ||= part.retryRequired;
        if(part.diagnostics.ingestTimings)timingParts.push(part.diagnostics.ingestTimings as IngestTimings);
        failedInputs.push(...(part.failedInputs??[]));
        result.processedFiles!.push(...(part.processedFiles??files));
        if(part.sourceDigests)(result.sourceDigests??=[]).push(...part.sourceDigests);
        // One adapter call per file: an unbounded list would grow with the queue.
        // Lists stay capped while their `<name>Total` counters keep the real totals.
        const listCounters=new Set(Object.keys(part.diagnostics)
          .filter(key=>Array.isArray(part.diagnostics[key])).map(key=>`${key}Total`));
        const listTotal=(diagnostics:Record<string,unknown>,key:string,list:unknown[]):number=>
          typeof diagnostics[`${key}Total`]==="number"?diagnostics[`${key}Total`] as number:list.length;
        for(const [key,value] of Object.entries(part.diagnostics)) {
          if(listCounters.has(key))continue;
          const previous=result.diagnostics[key];
          if(Array.isArray(value)) {
            const carried=Array.isArray(previous)?previous:[];
            const total=(Array.isArray(previous)?listTotal(result.diagnostics,key,carried):0)
              +listTotal(part.diagnostics,key,value);
            result.diagnostics[key]=[...carried,...value].slice(0,DIAGNOSTIC_LIST_LIMIT);
            if(total>DIAGNOSTIC_LIST_LIMIT)result.diagnostics[`${key}Total`]=total;
            continue;
          }
          result.diagnostics[key]=typeof value==="number"&&typeof previous==="number"?previous+value
            : value&&previous&&typeof value==="object"&&typeof previous==="object"&&!Array.isArray(previous)
              ? {...previous,...value}:value;
        }
      } catch(error) {for(const file of files)failedInputs.push({path:file,error:String(error)});}
      completedGroups += files.length;
      if (groupedFiles) context.onFileProgress?.(invalidCount + completedGroups, context.changedFiles.length);
    }
    result.diagnostics=boundedDiagnostics(result.diagnostics);
    if(timingParts.length)result.diagnostics.ingestTimings=sumIngestTimings(timingParts);
    return result;
  };
}

function measureAdapter(adapter:VendorAdapter):VendorAdapter {
  return async context=>{
    const started=performance.now();
    let latest:IngestTimings={discoveryMs:0,parseMs:0,poolMs:0,stageWriteMs:0,restMs:0,elapsedMs:0};
    const snapshot=(timing=latest):IngestTimings=>{
      const elapsedMs=Math.round(performance.now()-started);
      return {...timing,elapsedMs,restMs:Math.max(0,elapsedMs-timing.discoveryMs-timing.parseMs-timing.stageWriteMs-(timing.overheadMs??0))};
    };
    const report=(timing=latest)=>{latest=timing;try{context.onIngestTimings?.(snapshot(timing));}catch{/* Advisory telemetry. */}};
    const heartbeat=setInterval(()=>report(),1000);heartbeat.unref();
    try {
      const result=await adapter({...context,onIngestTimings:report});
      const timing=snapshot(result.diagnostics.ingestTimings as IngestTimings|undefined);
      report(timing);
      return {...result,diagnostics:{...result.diagnostics,ingestTimings:timing}};
    }finally{clearInterval(heartbeat);}
  };
}

/** Reuse one bounded pool across batched imports and isolated per-file retries. */
function withFileParsePool(adapter:VendorAdapter):VendorAdapter {
  return async context=>{
    if(context.parsePool)return adapter(context);
    const workers=parseWorkerCount();
    if(!workers)return adapter(context);
    const pool=new ParsePool(workers);
    try{return await adapter({...context,parsePool:pool});}
    finally{await pool.close();}
  };
}

export function createProductionAdapters(): VendorAdapters {
  const adapters:VendorAdapters = {
    codex: runCodex,
    claude: runClaude,
    opencode: runOpencode,
    grok: runGrok,
    gemini: runGemini,
    gauges: runGauges,
  };
  return Object.fromEntries(Object.entries(adapters).map(([vendor,adapter])=>{
    const isolated=isolateQueuedInputs(vendor as VendorId,adapter);
    return [vendor,measureAdapter(["gemini","grok","opencode"].includes(vendor)?withFileParsePool(isolated):isolated)];
  })) as VendorAdapters;
}
