import type { QueuedSyncFile, SyncFileQueue, SyncFileRoot, SyncFileFailure } from "./file-queue";
import { tablesAreEmpty } from "./first-fill";
import { VENDOR_TABLES, APPEND_VENDORS, DELTA_SPECS } from "./vendor-publication-schema";
import { calculationInput, mirrorInputFailed, calculationInputName, archiveCalculationInputs, addClaudeAuditCompanions, unreadInputSummary, boundedReparseInputs, unreadableRegisteredJournals } from "./source-input-selection";
import { unchangedSourceImpact } from "./source-impact";
import path from "node:path";
import { boundedDiagnostics } from "./store";
import { archiveCodecSource } from "../shared/archive-codec-path";
import { ARCHIVE_ROOT, toArchiveLogicalPath, toArchivePhysicalPath } from "../config/paths";
import fs from "node:fs";
import { archiveRepresentations } from "../ingest/archive-codec";
import { supersededJournals } from "../providers/core/journal-files";
import { createIncrementalStage } from "./incremental-stage";
import type { ReparsePlan, ReparseRange } from "./reparse";
import { Database } from "../db/sqlite";
import { prepareReparse } from "./reparse";
import { quoteIdentifier, tableColumns } from "./sync-sql";
import type { NormalizedAdapterResult, VendorAdapters } from "./adapters";
import { compressedRollout } from "../shared/codex-rollout-path";
import { rolloutRepresentations } from "../ingest/codex-rollout";
import { fileDigest as storageFileDigest } from "./archive-publication";
import type { VendorId, SyncRunResult } from "./contracts";
import type { SyncCoordinatorOptions, SyncRequest } from "./coordinator-contracts";
import type { ProgressRegistry } from "./progress";
import type { SyncPhase } from "../shared/sync-progress";
import type { VendorTelemetry } from "./vendor-progress";

interface SourcePreparationServices {
  sqlite: Database;
  options: Pick<SyncCoordinatorOptions, "dbPath" | "rootDir" | "archiveInputs">;
  queuedFiles: boolean;
  queue: () => SyncFileQueue | null;
  ensureQueue: () => SyncFileQueue;
  fileRoots: SyncFileRoot[];
  fileFailures: Map<VendorId, SyncFileFailure[]>;
  ingest: VendorAdapters[VendorId];
  mirror: NonNullable<SyncCoordinatorOptions["mirror"]>;
  readSourceFingerprint: (vendor: VendorId) => string;
  progressRegister: Pick<ProgressRegistry, "report" | "end">;
  saveStatusWithoutWaiting: (result: SyncRunResult) => void;
}

interface SourcePreparationWork {
  result: SyncRunResult;
  outcome: SyncRunResult["vendors"][number];
  stagePath: string;
  forceReparse: ReparseRange | undefined;
  rebuild: boolean;
  collection: SyncRequest["collection"];
  enteredFingerprint: string | undefined;
  step: number;
  scope: string;
  progress: (phase: SyncPhase, completed: number, vendor?: VendorId) => void;
  deferredInputs: SyncFileFailure[];
  deferGrowing: (items: SyncFileFailure[]) => void;
  deferredDiagnostics: () => Record<string, unknown>;
}

export async function prepareVendorSources(
  services: SourcePreparationServices,
  work: SourcePreparationWork,
  telemetry: VendorTelemetry,
) {
  const { sqlite, options, queuedFiles, queue, ensureQueue, fileRoots, fileFailures,
    ingest, mirror: mirrorSources, readSourceFingerprint, progressRegister, saveStatusWithoutWaiting } = services;
  const { result, outcome, stagePath, forceReparse, rebuild, collection, enteredFingerprint,
    step, scope, progress, deferredInputs, deferGrowing, deferredDiagnostics } = work;
  const { timings, phase, timingStart, timingEnd } = telemetry;
  let batch:QueuedSyncFile[]|undefined;
  if(queuedFiles) {
    // Finish this vendor before hashing another provider's backlog. Queue hints remain
    // pending until take verifies them and publication acknowledges the selected bytes.
    const started=performance.now();
    const deferHashing=tablesAreEmpty(sqlite,VENDOR_TABLES[outcome.vendor].publish);
    try {
      batch=queue()!.take(outcome.vendor,fileRoots,
        deferHashing ? file=>calculationInput(outcome.vendor,file) : false,
        (done,total)=>progressRegister.report(scope,deferHashing?"select":"verify",
          deferHashing?"Selecting changed files":"Verifying file contents","files",done,total));
      fileFailures.set(outcome.vendor,[...queue()!.takeFailures(outcome.vendor),
        ...queue()!.reconciliationFailures(outcome.vendor)]);
    } finally {
      const elapsed=Math.round(performance.now()-started);
      timings.discoveryMs=(timings.discoveryMs??0)+elapsed;
      (timings.steps??={}).queueSelectionMs=elapsed;
      progressRegister.end(scope);
    }
    if(!batch.length&&!fileFailures.get(outcome.vendor)?.length) {
      outcome.status="success";
      outcome.inputsComplete=true;
      outcome.sourceImpact=unchangedSourceImpact();
      // Preserve the completed-run contract: a verified unchanged hint is not an import.
      return { kind: "verified" as const };
    }
  }
  // TOKENATLAS_FIRST_FILL=off publishes an empty provider through the ordinary path: the
  // reference that acceptance compares the first fill with.
  const firstFill = process.env.TOKENATLAS_FIRST_FILL !== "off"
    && result.scope.kind !== "accounts" && !forceReparse?.from && !forceReparse?.until
    && tablesAreEmpty(sqlite, VENDOR_TABLES[outcome.vendor].publish)
    && (outcome.vendor !== "gauges" || tablesAreEmpty(sqlite,["probe_observations","probe_counters"]));
  const appendOnly = APPEND_VENDORS.has(outcome.vendor);
  progress("mirror", step, outcome.vendor);
  const mirrorStarted = performance.now();
  // Copying originals can take minutes on a machine without publication state: count files.
  const mirrorProgress = (completed: number, fileTotal: number | null) =>
    progressRegister.report(scope, "copy", "Copying originals", "files", completed, fileTotal);
  const mirrorKey=(file:string)=>process.platform==="win32"?path.resolve(file).toLowerCase():path.resolve(file);
  const originals=new Map(batch?.filter(row=>row.kind==="source").map(row=>[mirrorKey(row.path),row]));
  const mirroredRevisions=new Map<string,number>();
  const checkpointMirror=(source:string,archives:readonly string[])=>{
    const row=originals.get(mirrorKey(source));
    if(!row||!queue())return;
    for(const queued of queue()!.checkpointMirroredSource(row,archives))
      mirroredRevisions.set(mirrorKey(queued.path),queued.revision);
  };
  const mirror = collection === "archive"
    ? {copied:0, skipped:0, errors:[], warnings:[]} : await mirrorSources(outcome.vendor, options.rootDir, result.mode,batch?.filter(row=>row.kind==="source").map(row=>row.path), mirrorProgress,checkpointMirror);
  phase("mirrorMs", mirrorStarted);
  // Named file failures remain pending while readable archive inputs proceed,
  // including the first full import. Unscoped collector failures still stop it.
  const unscopedMirrorErrors = mirror.errors.filter(message =>
    !mirror.failedFiles?.some(file => message.startsWith(`${file}: `)));
  if (unscopedMirrorErrors.length > 0) throw new Error(`Mirror failed: ${unscopedMirrorErrors.join("; ")}`);
  if(collection==="mirror-only") {
    for(const file of mirror.archiveFiles??[])if(!mirroredRevisions.has(mirrorKey(file)))queue()?.enqueue(file,outcome.vendor);
    const failures=[...fileFailures.get(outcome.vendor)??[],...(mirror.failedFiles??[]).map(file=>({path:file,error:mirror.errors.find(message=>message.startsWith(`${file}: `))??"Mirror failed"}))];
    const failed=new Set(failures.map(item=>process.platform==="win32"
      ? path.resolve(item.path).toLowerCase():path.resolve(item.path)));
    if(batch)queue()!.acknowledge(batch.filter(row=>!mirrorInputFailed(row.path,failed)));
    outcome.processedInputs=mirror.copied;
    outcome.skippedInputs=mirror.skipped;
    // As in the import below, only an unread calculation input leaves collection incomplete;
    // an unreadable link or tool file beside the transcripts stays queued and reported.
    const pendingInputs=failures.filter(item=>calculationInputName(outcome.vendor,item.path));
    const unreadableEvidence=failures.filter(item=>!calculationInputName(outcome.vendor,item.path));
    deferGrowing(pendingInputs);
    outcome.inputsComplete=pendingInputs.length===0;
    outcome.diagnostics={mirror:boundedDiagnostics(mirror as unknown as Record<string,unknown>),
      ...(pendingInputs.length?{pendingInputs:pendingInputs.slice(0,20),pendingInputsTotal:pendingInputs.length}:{}),
      ...deferredDiagnostics(),
      ...(unreadableEvidence.length?{unreadableEvidence:unreadableEvidence.slice(0,20),unreadableEvidenceTotal:unreadableEvidence.length}:{})};
    outcome.status="success";
    outcome.sourceImpact=unchangedSourceImpact();
    return { kind: "mirror-only" as const };
  }
  // Each file carries the error that names it. Joining every message into
  // every entry made one run record grow to tens of megabytes.
  const mirrorError=(file:string)=>mirror.errors.find(message=>message.startsWith(`${file}: `))
    ??mirror.errors.find(message=>!message.includes(": "))??mirror.errors[0]??"Mirror failed";
  const queueFailures=[...fileFailures.get(outcome.vendor)??[],...(mirror.failedFiles??[]).map(file=>({path:file,error:mirrorError(file)}))];
  // Only an unread calculation input leaves the vendor incomplete. An archive
  // file no calculation reads - an attachment, a tool result, a link in a
  // mirrored working tree - is reported and stays queued, never a failure of
  // facts it cannot affect.
  const pendingInputs=queueFailures.filter(item=>calculationInputName(outcome.vendor,item.path));
  const unreadableEvidence=queueFailures.filter(item=>!calculationInputName(outcome.vendor,item.path));
  // Import only retained archive files, including outputs from this copy pass.
  const selectedArchiveInputs = result.mode === "full"
    ? (options.archiveInputs ?? archiveCalculationInputs)(outcome.vendor) : undefined;
  const archiveFiles=selectedArchiveInputs ?? (batch?[...new Set([...batch.filter(row=>row.kind==="archive").map(row=>row.path),...mirror.archiveFiles??[]])]:undefined);
  // A vanished codec name is retired only after a readable sibling is accepted below.
  const retiredRepresentations = (archiveFiles ?? []).filter(file =>
    archiveCodecSource(path.relative(ARCHIVE_ROOT,file).split(path.sep).join("/"))?.vendor === outcome.vendor
    && !fs.existsSync(file) && archiveRepresentations(file).length > 0);
  for (const retired of retiredRepresentations) archiveFiles!.push(...archiveRepresentations(retired));
  const observed:QueuedSyncFile[]=[];
  if (archiveFiles?.length) ensureQueue();
  // Archive-only collection performs no mirror writes; the queue already witnessed these inputs.
  const archiveWitnessStarted=performance.now();
  const queuedWitnesses=collection==="archive" ? new Map(batch?.map(row=>[path.resolve(row.path),row])) : undefined;
  const unwitnessed=(archiveFiles??[]).filter(file=>!queuedWitnesses?.has(path.resolve(file)));
  const extraWitnesses=unwitnessed.length?queue()!.observeAll(unwitnessed,outcome.vendor):[];
  const extras=new Map(unwitnessed.map((file,index)=>{
    const witness=extraWitnesses[index]!;
    return [path.resolve(file),witness instanceof Error?witness:{...witness,revision:mirroredRevisions.get(mirrorKey(file))??witness.revision}] as const;
  }));
  const witnesses=(archiveFiles??[]).map(file=>queuedWitnesses?.get(path.resolve(file))??extras.get(path.resolve(file))!);
  (timings.steps??={}).archiveWitnessMs=Math.round(performance.now()-archiveWitnessStarted);
  for(const [index,file] of (archiveFiles??[]).entries()) {
    try {
      const witness=witnesses[index]!;
      if(witness instanceof Error)throw witness;
      // A journal its owner rewrote into other files left on purpose; those files carry its facts.
      // Until a cloud client has delivered every one of them, the disappearance stays a retried failure.
      const replaced=witness.fingerprint==="missing"&&outcome.vendor==="gauges"?supersededJournals(path.dirname(file))[path.basename(file)]:undefined;
      if(replaced?.into.every(target=>fs.existsSync(path.join(path.dirname(file),target)))){observed.push(witness);continue;}
      if(witness.fingerprint==="missing"&&calculationInput(outcome.vendor,file) && !retiredRepresentations.includes(file))throw new Error("Archived source is unavailable; retained facts kept for retry");
      observed.push(witness);
    } catch(error) {
      const failure={path:file,error:error instanceof Error?error.message:String(error)};
      (calculationInputName(outcome.vendor,file)?pendingInputs:unreadableEvidence).push(failure);
    }
  }
  let changedFiles=archiveFiles?observed.filter(row=>row.fingerprint!=="missing").map(row=>row.path).filter(file=>calculationInput(outcome.vendor,file)):undefined;
  if(changedFiles&&outcome.vendor==="claude") {
    // Audit identity changes also affect the already indexed SDK transcript.
    addClaudeAuditCompanions(sqlite, changedFiles);
  }
  const entered = batch ? `queue:${batch.reduce((revision,row)=>Math.max(revision,row.revision),0)}`
    : enteredFingerprint;
  deferGrowing(pendingInputs);
  if(pendingInputs.length&&changedFiles?.length===0)throw new Error(unreadInputSummary(pendingInputs));
  const sourceFingerprint =
    (rebuild||queuedFiles||mirror.copied === 0) && entered != null ? entered : readSourceFingerprint(outcome.vendor);
  if (rebuild && appendOnly && forceReparse && (forceReparse.from || forceReparse.until)
    && result.mode !== "full" && result.scope.kind !== "accounts") {
    // Accepted gauge evidence is already durable; only changed journals need an append read.
    const inputs = (options.archiveInputs ?? archiveCalculationInputs)(outcome.vendor);
    if (inputs !== undefined) changedFiles = await boundedReparseInputs(sqlite, outcome.vendor, [], inputs);
  }
  progress("stage", step + 1, outcome.vendor);
  const stageStarted = performance.now();
  if (!(appendOnly && changedFiles?.length === 0))
    createIncrementalStage(sqlite, stagePath, outcome.vendor,changedFiles);
  phase("stageMs", stageStarted);
  let reparsePlan:ReparsePlan|undefined;
  const unreadJournals = rebuild && outcome.vendor === "gauges" ? unreadableRegisteredJournals(sqlite) : [];
  if(forceReparse && !appendOnly) {
    const preparationStarted = timingStart();
    try {
      const stage=new Database(stagePath);
      try{
        reparsePlan=prepareReparse(sqlite,stage,DELTA_SPECS[outcome.vendor],VENDOR_TABLES[outcome.vendor].data,forceReparse);
        if (rebuild && reparsePlan.bounds && result.mode !== "full" && result.scope.kind !== "accounts") {
          const inputs = (options.archiveInputs ?? archiveCalculationInputs)(outcome.vendor);
          // Undefined delegates discovery to the injected adapter; it is not an empty inventory.
          if (inputs !== undefined) {
            changedFiles = await boundedReparseInputs(sqlite, outcome.vendor, reparsePlan.sources, inputs);
            if (outcome.vendor === "claude") addClaudeAuditCompanions(sqlite, changedFiles);
            const bookmarks = DELTA_SPECS[outcome.vendor].bookmarkTable;
            // Delta detection must see exactly the bookmarks of the selected sources.
            if (bookmarks) stage.query(`DELETE FROM ${quoteIdentifier(bookmarks)}
              WHERE path NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(changedFiles.map(toArchiveLogicalPath)));
          }
        }
      }
      finally{stage.close();}
    } finally { timingEnd("reparsePreparationMs", preparationStarted); }
  }
  if (changedFiles !== undefined) outcome.diagnostics.selectedInputs = changedFiles.length;
  progress("ingest", step + 2, outcome.vendor);
  const ingestStarted = performance.now();
  let lastTimingSaveAt = 0;
  let warnedTimingSave = false;
  let progressSaveMs = 0;
  const saveIngestTimings = (immediate: boolean) => {
    const now = performance.now();
    if (!immediate && now - lastTimingSaveAt < 500) return;
    try {
      // Waiting here would stall the import, which runs on this thread.
      saveStatusWithoutWaiting(result);
    } catch (error) {
      // Telemetry must not invalidate staged facts; the next phase save is authoritative.
      if (!warnedTimingSave) {
        console.warn(`[sync] ingest timing save deferred: ${error instanceof Error ? error.message : String(error)}`);
        warnedTimingSave = true;
      }
    } finally {
      progressSaveMs += performance.now() - now;
      timings.progressSaveMs = Math.round(progressSaveMs);
    }
    lastTimingSaveAt = now;
  };
  const onFileDiscovery = (found: number) =>
    progressRegister.report(scope, "discover", "Collecting the file list", "files", found, null);
  const onFileProgress = (completed: number, fileTotal: number) =>
    progressRegister.report(scope, "parse", "Reading files", "files", completed, fileTotal);
  const adapter:NormalizedAdapterResult = changedFiles?.length === 0
    ? { processedInputs:0, skippedInputs:0, writtenRows:0, dirtyRange:null, diagnostics:{emptyInputs:true}, validationErrors:[] }
    : await ingest({
    activeDbPath: options.dbPath,
    stageDbPath: stagePath,
    mode: "incremental",
    rootDir: options.rootDir,
    firstFill,
    onIngestTimings:ingestTimings=>{
      outcome.diagnostics.ingestTimings=ingestTimings;
      timings.ingestMs=Math.round(performance.now()-ingestStarted);saveIngestTimings(false);
    },
    // Account meter selection needs all archived counters; ordinary ranged
    // rebuilds have no reason to replay an unchanged accepted journal.
    reparse: outcome.vendor === "gauges"
      ? result.mode === "full" || result.scope.kind === "accounts" && result.scope.meters === "archive"
        || !!forceReparse && !forceReparse.from && !forceReparse.until
      : !!forceReparse || result.mode === "full",
    reparseSources:reparsePlan?.sources,
    onFileProgress,
    onFileDiscovery,
    ...(rebuild || collection === "archive" || selectedArchiveInputs !== undefined ? { rebuild: true } : {}),
    changedFiles,
    ...(outcome.vendor === "gauges"
      ? { gaugeEvidenceDbPath: options.dbPath } : {}),
  });
  timings.ingestMs=Math.round(performance.now()-ingestStarted);
  if(adapter.failedInputs?.length) {
    pendingInputs.push(...adapter.failedInputs);
    const stage=new Database(stagePath);
    try {stage.transaction(()=>{
      for(const failed of adapter.failedInputs!) {
        const logical=toArchiveLogicalPath(failed.path);
        for(const table of VENDOR_TABLES[outcome.vendor].publish) {
          if(tableColumns(stage,table).includes("path"))stage.query(`DELETE FROM ${quoteIdentifier(table)} WHERE path=?`).run(logical);
        }
        if(outcome.vendor==="opencode") {
          const store=path.relative(ARCHIVE_ROOT,failed.path).split(path.sep)[1]!;
          stage.query("DELETE FROM oc_events WHERE store=?").run(store);
          stage.query("DELETE FROM meta WHERE key=?").run(`opencode_snapshot:${store}`);
        }
      }
    }).immediate();}finally{stage.close();}
  }
  if(adapter.processedFiles)changedFiles=adapter.processedFiles;
  // A deferred queue witness takes the digest of the parsing read (one read per file): Codex
  // stores it with the file's evidence, Claude returns it with the parse.
  if(batch && (outcome.vendor==="codex"||outcome.vendor==="claude") && observed.some(row=>row.fingerprint!=="missing" && JSON.parse(row.fingerprint)[1]===null)) {
    const witnessStarted=performance.now();
    const proofs=outcome.vendor==="codex"?new Database(stagePath,{readonly:true}):null;
    try {
      const byPath=new Map<string,{source_sha256:string;source_byte_length:number}>();
      // One read: the key is (home,path), so a lookup by path alone scanned the table per file.
      if(proofs)for(const proof of proofs.query("SELECT path,source_sha256,source_byte_length FROM codex_file_evidence ORDER BY rowid")
        .iterate() as Iterable<{path:string;source_sha256:string;source_byte_length:number}>)
        if(!byPath.has(proof.path))byPath.set(proof.path,proof);
      const storageProofs = new Map((adapter.sourceDigests ?? []).map(digest => [path.resolve(digest.path), digest]));
      for(let i=0;i<observed.length;i++) {
        const row=observed[i]!;
        if(row.fingerprint==="missing" || JSON.parse(row.fingerprint)[1]!==null)continue;
        const storage = storageProofs.get(path.resolve(row.path));
        // Compressed storage has its own physical witness; the stage evidence stays decoded.
        let proof = storage ? { source_sha256: storage.sha256, source_byte_length: storage.byteLength }
          : byPath.get(toArchiveLogicalPath(row.path));
        if (outcome.vendor === "codex" && !storage && proof && (compressedRollout(row.path) || rolloutRepresentations(row.path).length > 1)) {
          proof = { source_sha256: storageFileDigest(row.path), source_byte_length: fs.statSync(row.path).size };
        }
        if(!proof) {
          // A Claude file the importer did not read (e.g. outside its store layout) is hashed
          // here instead of staying queued forever; Codex always returns its evidence.
          if(outcome.vendor==="claude"){
            try{const [witness]=queue()!.observeAll([row.path],"claude");
              if(!(witness instanceof Error)&&witness)observed[i]={...row,fingerprint:witness.fingerprint};else throw witness;}
            catch(error){pendingInputs.push({path:row.path,error:String(error)});}
            continue;
          }
          pendingInputs.push({path:row.path,error:"Parser did not return complete file evidence"});
          continue;
        }
        try { observed[i]=queue()!.resolveParsedFingerprint(row,proof.source_sha256,proof.source_byte_length); }
        catch(error) {pendingInputs.push({path:row.path,error:String(error)});}
      }
    }finally{proofs?.close();timings.sourceWitnessMs=Math.round(performance.now()-witnessStarted);}
    // A moving source has no accepted witness; publish only the other prepared files.
    if(pendingInputs.length) {
      const failed=new Set(pendingInputs.map(input=>path.resolve(toArchivePhysicalPath(input.path)).toLowerCase()));
      if(changedFiles)changedFiles=changedFiles.filter(file=>!failed.has(path.resolve(file).toLowerCase()));
      const retained=observed.filter(row=>!failed.has(path.resolve(row.path).toLowerCase()));observed.splice(0,observed.length,...retained);
      const stage=new Database(stagePath);
      // One pass per table: keys lead with home, so a per-file DELETE by path scans the table.
      const paths=JSON.stringify(pendingInputs.map(input=>toArchiveLogicalPath(input.path)));
      try{stage.transaction(()=>{for(const table of VENDOR_TABLES[outcome.vendor].publish)
        if(tableColumns(stage,table).includes("path"))stage.query(`DELETE FROM ${quoteIdentifier(table)} WHERE path IN (SELECT value FROM json_each(?))`).run(paths);}).immediate();}
      finally{stage.close();}
    }
  }
  // Facts of a file the parser saw growing were left out of the stage above; it is read next cycle.
  deferGrowing(pendingInputs);
  // The parser's own list of unread inputs, without the deferred ones.
  const deferredKeys = new Set(deferredInputs.map(item => path.resolve(toArchivePhysicalPath(item.path)).toLowerCase()));
  const deferredKey = (file: string) => deferredKeys.has(path.resolve(toArchivePhysicalPath(file)).toLowerCase());
  if (deferredKeys.size && Array.isArray(adapter.diagnostics.unavailableInputs)) {
    const deferredFailures = adapter.failedInputs?.filter(input => deferredKey(input.path)).length ?? 0;
    const total = Number(adapter.diagnostics.unavailableInputsTotal ?? adapter.diagnostics.unavailableInputs.length) - deferredFailures;
    adapter.diagnostics.unavailableInputs = (adapter.diagnostics.unavailableInputs as Array<{path:string}>).filter(input => !deferredKey(input.path));
    if (adapter.diagnostics.unavailableInputsTotal !== undefined) adapter.diagnostics.unavailableInputsTotal = Math.max(total, (adapter.diagnostics.unavailableInputs as unknown[]).length);
    if (!(adapter.diagnostics.unavailableInputs as unknown[]).length && !Number(adapter.diagnostics.unavailableInputsTotal ?? 0)) {
      delete adapter.diagnostics.unavailableInputs; delete adapter.diagnostics.unavailableInputsTotal;
    }
  }
  outcome.processedInputs = adapter.processedInputs;
  outcome.skippedInputs = adapter.skippedInputs;
  outcome.writtenRows = adapter.writtenRows;
  return { kind: "prepared" as const, batch, firstFill, appendOnly, observed, pendingInputs,
    changedFiles, sourceFingerprint, reparsePlan, unreadJournals, adapter, mirror, unreadableEvidence };
}

export type PreparedVendorSources = Extract<Awaited<ReturnType<typeof prepareVendorSources>>, { kind: "prepared" }>;

