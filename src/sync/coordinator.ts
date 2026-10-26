import { createVendorTelemetry } from "./vendor-progress";
import { prepareVendorSources } from "./vendor-source-preparation";
import { publishVendorStage } from "./vendor-stage-publication";
import type { SyncRunResult, VendorId, ConfigDomain } from "./contracts";
import { Database } from "../db/sqlite";
import { SyncStore, boundedDiagnostics } from "./store";
import type { VendorAdapters } from "./adapters";
import type { RemapProgressHandler } from "../projects/remap";
import { liveProgressWriter, pruneLiveProgress } from "./live-progress";
import { SyncFileQueue } from "./file-queue";
import type { SyncFileRoot, SyncFileFailure } from "./file-queue";
import { ProgressRegistry, progressDirectory } from "./progress";
import { constants } from "bun:sqlite";
import { ensureRawSyncIndexes } from "../db/migrate";
import { ensureAcceptedFacts } from "./accepted-facts";
import { createProductionAdapters } from "./adapters";
import { mirrorVendorSources, vendorSourceFingerprint, archiveFileRoots, syncFileRoots, originalForOwnArchiveFile } from "./mirror";
import { CONFIG_DOMAINS, vendorsForScope, pendingVendorResult } from "./contracts";
import { remap, loadProjects, REMAPPED_TABLES } from "../projects/remap";
import fs from "node:fs";
import { ARCHIVE_ROOT, configFile, toArchivePhysicalPath, toArchiveLogicalPath } from "../config/paths";
import { revisitClaudeLimitSources, CLAUDE_LIMIT_TASK } from "./claude-limit-backfill";
import { readProcessBirth } from "./process-owner";
import type { ReparseRange } from "./reparse";
import type { SyncPhase } from "../shared/sync-progress";
import { WriteLease } from "../db/write-lease";
import { hasUnfinishedFirstFills, recoverFirstFills } from "./first-fill";
import path from "node:path";
import { recoverDisposableStages, stagePathFor, removeStageArtifacts } from "./staging";
import { fileDigest } from "../config/canonical-json";
import { unavailableSourceImpact } from "./source-impact";
import { retainProbeConflicts } from "../db/probe-facts";
import { CLAUDE_CLOUD_PARSER_VERSION, CLAUDE_PARSER_VERSION } from "../ingest/claude";
import { ParsePool, parseWorkerCount } from "../ingest/parse-pool";
import { backfillClaudeTiming } from "./claude-timing-backfill";
import type { SyncCoordinatorOptions, ConfigSnapshot, SyncRequest, SyncExecution } from "./coordinator-contracts";
import { execWithBusyRetry, tableExists, quoteIdentifier } from "./sync-sql";
import { acceptedFactsSpecs } from "./vendor-publication-schema";
import { configurationFingerprints, refreshDerivedState } from "./sync-configuration";
import { RUN_SCOPE, vendorScope, PHASE_LABELS } from "./vendor-progress";
import { calculationInput, stillGrowing, calculationInputName } from "./source-input-selection";
import type { DeltaIdentity } from "./vendor-publication-schema";

export { boundedReparseInputs, stillGrowing, mirrorInputFailed } from "./source-input-selection";
export type { SyncRequest, SyncExecution, SyncCoordinatorOptions } from "./coordinator-contracts";
export { createIncrementalStage } from "./incremental-stage";

/** A stage without any `sync_runs` record is scratch once no live attempt can still own it. */
const ORPHAN_STAGE_MS = 24 * 60 * 60 * 1000;

function finalStatus(result: SyncRunResult): SyncRunResult["status"] {
  const successes = result.vendors.filter((vendor) => vendor.status === "success").length;
  const failures = result.vendors.filter((vendor) => vendor.status === "failure" ||
    (Array.isArray(vendor.diagnostics.pendingInputs)&&vendor.diagnostics.pendingInputs.length>0)).length;
  if (failures === 0) return "success";
  if (successes === 0) return "failure";
  return "partial_success";
}

export class SyncCoordinator {
  private readonly sqlite: Database;
  private readonly store: SyncStore;
  private readonly adapters: VendorAdapters;
  private readonly mirror: NonNullable<SyncCoordinatorOptions["mirror"]>;
  private readonly configFingerprints: () => ConfigSnapshot;
  private readonly sourceFingerprint: (vendor: VendorId) => string;
  private readonly prepareStage: (sqlite: Database, onProgress?: RemapProgressHandler, tables?: readonly string[]) => void;
  private readonly refreshDerived: NonNullable<SyncCoordinatorOptions["refreshDerived"]>;
  private readonly now: () => string;
  private active: SyncRunResult | null = null;
  private live: ReturnType<typeof liveProgressWriter> | null = null;
  private activeCompletion: Promise<SyncRunResult> | null = null;
  private fileQueue:SyncFileQueue|null=null;
  private fileRoots:SyncFileRoot[]=[];
  private fileFailures=new Map<VendorId,SyncFileFailure[]>();
  private queuedFiles=false;
  /** The parser-6 response-time pass runs at the end of this run (`claudeTimingPass`). */
  private claudeTimingDue=false;
  private readonly discoveryTimings=new Map<VendorId,number>();
  private readonly discoverySteps=new Map<VendorId,Record<string,number>>();
  private readonly progressRegister: ProgressRegistry;
  constructor(private readonly options: SyncCoordinatorOptions) {
    this.sqlite = new Database(options.dbPath, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI);
    execWithBusyRetry(this.sqlite, "PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
    ensureRawSyncIndexes(this.sqlite);
    ensureAcceptedFacts(this.sqlite, acceptedFactsSpecs());
    this.store = new SyncStore(this.sqlite);
    this.adapters = options.adapters ?? createProductionAdapters();
    this.mirror = options.mirror ?? mirrorVendorSources;
    this.configFingerprints =
      options.configFingerprints ??
      (options.configFingerprint
        ? () => ({
            fingerprint: options.configFingerprint!(),
            domains: Object.fromEntries(
              CONFIG_DOMAINS.map((domain) => [domain, options.configFingerprint!()])
            ) as Record<ConfigDomain, string>,
          })
        : configurationFingerprints);
    this.sourceFingerprint = options.sourceFingerprint ?? vendorSourceFingerprint;
    this.prepareStage = options.prepareStage ?? ((sqlite, onProgress, tables) => remap(sqlite, loadProjects(), onProgress, tables));
    this.refreshDerived = options.refreshDerived ?? refreshDerivedState;
    this.now = options.now ?? (() => new Date().toISOString());
    this.progressRegister = new ProgressRegistry(progressDirectory(options.dbPath));
    this.store.recoverInterrupted(this.now());
  }
  enter(request: SyncRequest): SyncExecution {
    if(request.reparse && request.mode!=="incremental")throw new Error("Source rereading requires incremental publication");
    const alreadyRunning = this.active;
    if (alreadyRunning) {
      return {
        initial: alreadyRunning,
        completion: this.activeCompletion ?? Promise.resolve(alreadyRunning),
        owned: true,
      };
    }
    this.store.recoverInterrupted(this.now());
    const before = this.store.revisions();
    const config = this.configFingerprints();
    const configChanged = config.fingerprint !== this.store.configurationFingerprint();
    const domainBaselines = Object.fromEntries(
      CONFIG_DOMAINS.map((domain) => [domain, this.store.configDomainFingerprint(domain)])
    ) as Record<ConfigDomain, string | null>;
    const hasDomainBaselines = CONFIG_DOMAINS.every((domain) => domainBaselines[domain] != null);
    const changedConfigDomains = configChanged
      ? hasDomainBaselines
        ? CONFIG_DOMAINS.filter((domain) => domainBaselines[domain] !== config.domains[domain])
        : [...CONFIG_DOMAINS]
      : [];
    const requestedVendors = vendorsForScope(request.scope);
    if (request.scope.kind === "accounts" && (!request.reparse || request.mode !== "incremental" || request.rebuildGeneration === undefined))
      throw new Error("Account selection requires an incremental rebuild generation");
    if (request.reparse && (request.scope.kind === "vendors" || request.scope.kind === "accounts")
      && changedConfigDomains.some(domain => domain === "accounts" || domain === "projects"))
      throw new Error("Account or project configuration requires synchronization before a selected rebuild; selected vendors were not expanded");
    if ((request.collection === "archive" || request.collection === "mirror-only") && request.bootstrapRecoveryId) {
      try {
        if (!fs.statSync(ARCHIVE_ROOT).isDirectory()) throw new Error("archive root is not a directory");
        fs.readdirSync(ARCHIVE_ROOT);
      } catch (error) {
        throw new Error(`Configured source archive is unavailable: ${ARCHIVE_ROOT}: ${String(error)}`);
      }
    }
    this.queuedFiles=!this.options.adapters&&!this.options.sourceFingerprint&&!this.options.mirror
      &&request.mode==="incremental"&&!request.reparse;
    this.fileRoots=[];
    this.fileFailures=new Map();
    this.claudeTimingDue=false;
    this.discoveryTimings.clear();
    this.discoverySteps.clear();
    // Entries of an earlier run that ended without clearing them (a crash) are not this run's.
    this.progressRegister.endAll(RUN_SCOPE);
    const pendingRevisions=new Map<VendorId,number|null>();
    if(this.queuedFiles) {
      const discoveryStarted=performance.now();
      this.fileQueue??=new SyncFileQueue(ARCHIVE_ROOT);
      const freshCollectionTask=request.collection==="mirror-only"&&request.bootstrapRecoveryId
        ? `bootstrap-source:${request.bootstrapRecoveryId}`:null;
      if(freshCollectionTask&&!this.fileQueue.taskState(freshCollectionTask))this.fileQueue.reconcileLater();
      const roots=(request.collection==="archive" ? archiveFileRoots() : syncFileRoots())
        .filter(root=>requestedVendors.includes(root.vendor));
      this.fileRoots=request.collection==="mirror-only" ? roots.filter(root=>root.kind==="source") : roots;
      // Collection copies originals only, so it lists only them; the archive is listed once, by
      // the archive import that follows. The listing also records what later runs compare with.
      this.progressRegister.step(RUN_SCOPE,"listing","Looking for changed files","files");
      this.fileQueue.prepare(this.fileRoots,Date.now(),
        (done,total)=>this.progressRegister.advance(RUN_SCOPE,done,total));
      this.progressRegister.end(RUN_SCOPE);
      const listingFinished=performance.now();
      if(freshCollectionTask)this.fileQueue.setTaskState(freshCollectionTask,"1");
      if(request.collection==="mirror-only") {
        this.progressRegister.step(RUN_SCOPE,"archive-check","Checking archived copies","files");
        this.fileQueue.requeueMissingArchiveSources(roots,originalForOwnArchiveFile,(done,total)=>this.progressRegister.advance(RUN_SCOPE,done,total));
        this.progressRegister.end(RUN_SCOPE);
      }
      if(request.collection==="archive"&&request.bootstrapRecoveryId)
        this.fileQueue.revisitAcceptedForTask(`bootstrap:${request.bootstrapRecoveryId}`,roots,calculationInput);
      if(requestedVendors.includes("claude")&&roots.some(root=>root.vendor==="claude"&&root.kind==="archive")) {
        this.claudeTimingDue=request.collection!=="mirror-only";
        // One-time pass for parser 4: files holding a limit refusal are read again (see the module).
        try {
          const step=revisitClaudeLimitSources(this.fileQueue,this.sqlite,undefined,
            scanned=>this.progressRegister.report(RUN_SCOPE,"limit-scan","Checking files for limit messages","files",scanned,null));
          if(step.revisited.length||step.retry)console.log(`[sync] Claude limit refusals: ${step.revisited.length} file(s) queued, ${step.scanned} scanned${step.retry?`, retry ${step.retry.path}: ${step.retry.error}`:""}${step.done?", pass complete":""}`);
        } catch(error) {
          console.warn("[sync] Claude limit refusal pass deferred:",error instanceof Error?error.message:error);
        } finally {this.progressRegister.end(RUN_SCOPE);}
        // Cloud session events read by an older cloud parser are queued again, and only they (claude.ts).
        const stale=this.sqlite.query("SELECT DISTINCT path FROM claude_files WHERE parser_version<? AND path LIKE '%.events.jsonl'")
          .all(CLAUDE_CLOUD_PARSER_VERSION) as Array<{path:string}>;
        for(const row of stale) {
          const file=toArchivePhysicalPath(row.path);
          // Unchanged bytes would be accepted as already read; `revisit` drops that witness so the file is parsed again.
          if(fs.existsSync(file))this.fileQueue.revisit(file,"claude");
        }
        if(stale.length)console.log(`[sync] Claude cloud sessions: ${stale.length} file(s) queued for the current cloud parser`);
      }
      const recoveryFinished=performance.now();
      for(const vendor of requestedVendors) {
        pendingRevisions.set(vendor,this.fileQueue.pendingRevision(vendor,this.fileRoots));
        this.fileFailures.set(vendor,this.fileQueue.reconciliationFailures(vendor));
      }
      // Queue walking is shared; charge it once, rather than once per provider.
      const first=requestedVendors[0];
      if(first)this.discoveryTimings.set(first,Math.round(performance.now()-discoveryStarted));
      if(first)this.discoverySteps.set(first,{
        queueListingMs:Math.round(listingFinished-discoveryStarted),
        queueRecoveryMs:Math.round(recoveryFinished-listingFinished),
      });
    }
    const sourceFingerprints = new Map(
      requestedVendors.map((vendor) => [vendor, request.reparse && request.rebuildGeneration !== undefined ? `rebuild:${request.rebuildGeneration}:${vendor}` : this.queuedFiles ? `queue:${pendingRevisions.get(vendor)??0}` : this.sourceFingerprint(vendor)] as const)
    );
    const completedReparse=request.reparse && request.rebuildGeneration!==undefined
      ? this.store.completedReparseVendors(request.rebuildGeneration,config.fingerprint) : new Map();
    const dirtyVendors = request.mode === "full"
      ? requestedVendors
      : requestedVendors.filter(
          (vendor) => this.queuedFiles ? pendingRevisions.get(vendor)!=null || !!this.fileFailures.get(vendor)?.length : request.reparse && !completedReparse.has(vendor)
            || this.store.sourceBookmark(vendor) !== sourceFingerprints.get(vendor)
        );
    // Import readings from other machines before their transcript history.
    dirtyVendors.sort((a, b) => Number(b === "gauges") - Number(a === "gauges"));
    const result: SyncRunResult = {
      runId: crypto.randomUUID(),
      ownerPid: process.pid,
      ownerProcessStart: readProcessBirth(process.pid)?.identity,
      trigger: request.trigger,
      scope: request.scope,
      mode: request.mode,
      rebuildGeneration:request.rebuildGeneration,
      rebuildConfiguration:request.rebuildGeneration!==undefined?config.fingerprint:undefined,
      startedAt: this.now(),
      finishedAt: null,
      status: "running",
      beforeRevisions: before,
      afterRevisions: before,
      changedConfigDomains,
      aggregateWorkRequested: false,
      vendors: [...requestedVendors.filter(vendor=>!dirtyVendors.includes(vendor) && completedReparse.has(vendor))
        .map(vendor=>completedReparse.get(vendor)!),...dirtyVendors.map(pendingVendorResult)],
      error: null,
    };
    const claim = this.store.claimRun(result);
    if (!claim.claimed) {
      this.progressRegister.endAll(RUN_SCOPE);
      return { initial: claim.run, completion: this.waitForTerminal(claim.run.runId), owned: false };
    }
    if (!configChanged && !hasDomainBaselines) this.store.seedConfigDomainFingerprints(config.domains);
    this.saveRun(result);
    this.active = result;
    this.activeCompletion = this.execute(result, config, changedConfigDomains, sourceFingerprints, request.reparse,completedReparse,request.collection).finally(() => {
      // The finished record in sync_runs is authoritative again.
      this.progressRegister.endAll(RUN_SCOPE);
      this.live?.clear();
      this.live = null;
      this.active = null;
      this.activeCompletion = null;
    });
    return { initial: result, completion: this.activeCompletion, owned: true };
  }
  latest(): SyncRunResult | null {
    return this.active ?? this.store.latestRun();
  }
  close(): void {
    this.fileQueue?.close();
    this.sqlite.close();
  }
  /**
   * A stage file is disposable once its own run has finished, whatever that run's
   * status. Nothing ever reuses an abandoned stage: a new attempt stages under a
   * fresh run id, so a failed or partially successful run's stage is scratch that
   * only occupies disk. The run in progress and any run still recorded as running
   * are kept, and a stage whose run left no record at all is kept until it has
   * aged past the orphan window, so a crashed run's evidence survives a restart.
   */
  private stageIsDisposable(runId: string, vendor: string, currentRunId: string, modifiedAtMs: number): boolean {
    if (runId === currentRunId) return false;
    let run: SyncRunResult | null;
    try {
      run = this.store.runById(runId);
    } catch {
      return false;
    }
    if (!run) return Date.parse(this.now()) - modifiedAtMs >= ORPHAN_STAGE_MS;
    return run.status !== "running" && run.finishedAt != null;
  }
  /** Every status save also refreshes the run's live progress file (see live-progress.ts). */
  private saveRun(result: SyncRunResult): void {
    if (this.live && this.active?.runId === result.runId) this.live.write(result);
    this.store.saveRun(result);
  }
  /** Saves advisory run status; a status update must never wait behind another writer, so a busy database throws. */
  private saveStatusWithoutWaiting(result: SyncRunResult): void {
    // The file stays current even when the database is busy or the run's own transaction is open.
    if (this.live && this.active?.runId === result.runId) this.live.write(result);
    const {timeout} = this.sqlite.query("PRAGMA busy_timeout").get() as {timeout:number};
    this.sqlite.exec("PRAGMA busy_timeout=0");
    try { this.store.saveRun(result); }
    finally { this.sqlite.exec(`PRAGMA busy_timeout=${timeout}`); }
  }
  private checkpointWal(): void {
    try {
      this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A reader holding the WAL just postpones the truncation to the next publish.
    }
  }
  private async execute(
    result: SyncRunResult,
    config: ConfigSnapshot,
    changedConfigDomains: ConfigDomain[],
    enteredFingerprints: ReadonlyMap<VendorId, string> = new Map(),
    reparse?: ReparseRange,
    completedReparse:ReadonlyMap<VendorId,SyncRunResult["vendors"][number]>=new Map(),
    collection?: "archive" | "collect-archive" | "mirror-only",
  ): Promise<SyncRunResult> {
    const affected = new Map<VendorId, DeltaIdentity[]>();
    const verifiedQueueHints=new Set<VendorId>();
    const omitVerifiedQueueHints=()=>{
      result.vendors=result.vendors.filter(outcome=>!verifiedQueueHints.has(outcome.vendor));
    };
    // Steps count work units, not elapsed-time percentages. Even a no-op has
    // identity and publication work after source discovery.
    const total = result.vendors.length * 6 + 5;
    pruneLiveProgress(this.options.dbPath, result.runId);
    const live = liveProgressWriter(this.options.dbPath, result.runId);
    this.live = live;
    // The run's phase is part of its record; what the phase is doing right now is in the
    // progress register, under the run's scope or the scope of the vendor it works on.
    const progress = (phase: SyncPhase, completed: number, vendor?: VendorId) => {
      result.progress = { phase, completed, total, vendor, startedAt: this.now() };
      this.saveRun(result);
      // While a vendor works, the run itself has no step of its own.
      if (vendor) this.progressRegister.end(RUN_SCOPE);
      this.progressRegister.step(vendor ? vendorScope(vendor) : RUN_SCOPE, phase, PHASE_LABELS[phase], "items");
    };
    // Multi-row writes to the database happen under the write lease (U2.2): the undo of a stopped
    // first fill, each vendor's publication (released after it, so the server's background
    // writer works while the next vendor is staged) and the derived refresh.
    const writeLease = new WriteLease(this.sqlite, "sync");
    const takeWriteLease = async (scope: string) => {
      if (writeLease.held || writeLease.tryAcquire()) return;
      this.progressRegister.report(scope, "write-lease", "Waiting for the background writer to hand over", "items", 0, null);
      await writeLease.acquire();
    };
    const releaseWriteLease = () => {
      try { if (writeLease.held) writeLease.release(); }
      catch (error) { console.warn("[sync] write lease release failed; it lapses with this process", String(error)); }
    };
    try {
      progress("identity", 0);
      // This run holds the run lock: a first fill left unfinished by a stopped run is undone, so
      // its vendor is empty again and is filled from the files that stayed queued.
      let undone: string[] = [];
      if (hasUnfinishedFirstFills(this.sqlite)) {
        await takeWriteLease(RUN_SCOPE);
        undone = recoverFirstFills(this.sqlite);
        releaseWriteLease();
      }
      if (undone.length) console.warn(`[sync] unfinished first fill undone for ${undone.join(", ")}; it is imported again`);
      // A rebuild generation reads the archive's current content in place. Ordinary
      // synchronization waits while it publishes sources (rebuild-source-gate), and
      // anything appended later is picked up by the next ordinary read.
      const rebuild = result.rebuildGeneration !== undefined && reparse !== undefined;
      const stagingRoot = path.join(path.dirname(this.options.dbPath), "sync-staging");
      // Cleanup can lose a race with a connection an ingest path left open. Nothing
      // ever reuses an abandoned stage, so retry the disposable ones here instead of
      // letting the staging directory grow with every run.
      const cleanupCursorKey = "sync_stage_cleanup_cursor";
      this.sqlite.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
      const cleanupCursor = this.sqlite.query("SELECT value FROM meta WHERE key=?")
        .get(cleanupCursorKey) as { value: string } | null;
      const recovery = recoverDisposableStages(stagingRoot, (runId, vendor, modifiedAtMs) =>
        this.stageIsDisposable(runId, vendor, result.runId, modifiedAtMs), 500, cleanupCursor?.value ?? null);
      if (recovery.cursor !== null && recovery.cursor !== cleanupCursor?.value) {
        this.sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(cleanupCursorKey, recovery.cursor);
      }
      // Gemini assignments are acknowledged only against the declarations this run read.
      const accountsFile = configFile("accounts.json");
      const accountsDigest = fileDigest(accountsFile);
      const fence = () => {
        if (fileDigest(accountsFile) !== accountsDigest) throw new Error("accounts.json changed before publication");
      };
      if (result.vendors.length > 0) {
        (this.options.ensureStagingRoot ?? ((directory) => fs.mkdirSync(directory, { recursive: true })))(stagingRoot);
      }
      // Whether the project-remapped tables held rows before each publication of this run.
      const publicationState = { affected, remappedRows: REMAPPED_TABLES.some(table => tableExists(this.sqlite, table)
        && !!this.sqlite.query(`SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1`).get()) };
      const processVendor = async (outcome: SyncRunResult["vendors"][number]) => {
        const forceReparse=reparse && !completedReparse.has(outcome.vendor)?reparse:undefined;
        const step = 1 + result.vendors.indexOf(outcome) * 6;
        const stagePath = stagePathFor(stagingRoot, result.runId, outcome.vendor);
        const scope = vendorScope(outcome.vendor);
        let outcomeCommitted = false;
        let retainFailedStage = false;
        // A queued input that was still being written while this run read it is not unread: it
        // stays queued and the next cycle reads the rest, so it does not make the run partial.
        // A rebuild has no queue to keep it in and still counts it as unread.
        const deferredInputs: SyncFileFailure[] = [];
        const deferGrowing = (items: SyncFileFailure[]) => {
          if (!this.queuedFiles || rebuild || !this.fileQueue) return;
          for (let index = items.length - 1; index >= 0; index--) {
            const item = items[index]!;
            if (!stillGrowing(item)) continue;
            const file = toArchivePhysicalPath(item.path);
            if (!fs.existsSync(file)) continue;
            if (!this.fileQueue.hasPending(outcome.vendor, file)) this.fileQueue.enqueue(file, outcome.vendor);
            deferredInputs.push(item);
            items.splice(index, 1);
          }
        };
        const deferredDiagnostics = () => deferredInputs.length
          ? { deferredInputs: deferredInputs.slice(0, 20), deferredInputsTotal: deferredInputs.length } : {};
        outcome.startedAt = this.now();
        // Telemetry updates outcome.timings directly, so every save persists the measured phases.
        const telemetry = createVendorTelemetry({ result, outcome, scope,
          discoveryTimings: this.discoveryTimings, discoverySteps: this.discoverySteps,
          progressRegister: this.progressRegister, saveStatusWithoutWaiting: run => this.saveStatusWithoutWaiting(run) });
        const { timings, measureTiming } = telemetry;
        this.options.beforeVendorSave?.();
        this.saveRun(result);
        try {
          const prepared = await prepareVendorSources({
            sqlite: this.sqlite, options: this.options, queuedFiles: this.queuedFiles,
            queue: () => this.fileQueue, ensureQueue: () => this.fileQueue ??= new SyncFileQueue(ARCHIVE_ROOT),
            fileRoots: this.fileRoots, fileFailures: this.fileFailures, ingest: input => this.adapters[outcome.vendor](input),
            mirror: (...args) => this.mirror(...args), readSourceFingerprint: vendor => this.sourceFingerprint(vendor),
            progressRegister: this.progressRegister, saveStatusWithoutWaiting: run => this.saveStatusWithoutWaiting(run),
          }, { result, outcome, stagePath, forceReparse, rebuild, collection,
            enteredFingerprint: enteredFingerprints.get(outcome.vendor), step, scope, progress,
            deferredInputs, deferGrowing, deferredDiagnostics }, telemetry);
          if (prepared.kind === "verified") { verifiedQueueHints.add(outcome.vendor); return; }
          if (prepared.kind === "mirror-only") return;
          const { batch, pendingInputs, sourceFingerprint, reparsePlan, adapter, changedFiles,
            mirror, unreadableEvidence, unreadJournals, observed } = prepared;
          const saveCompletedSourceBookmark = () => {
            if (adapter.retryRequired||pendingInputs.length||deferredInputs.length) this.store.clearSourceBookmark(outcome.vendor);
            else this.store.saveSourceBookmark(outcome.vendor, sourceFingerprint);
          };
          const shouldPublish = adapter.processedInputs > 0 || adapter.writtenRows > 0 || !!reparsePlan?.identities.length;
          outcome.dirtyRange = null;
          const priorReparse=completedReparse.get(outcome.vendor)?.diagnostics.reparse;
          // The mirror result lists every archived, absent or failed file; the run
          // record keeps a sample of each list, never the whole enumeration.
          outcome.diagnostics = { ...outcome.diagnostics,...adapter.diagnostics, ...(changedFiles !== undefined ? {selectedInputs: changedFiles.length} : {}), mirror: boundedDiagnostics(mirror as unknown as Record<string, unknown>), ...(pendingInputs.length?{pendingInputs:pendingInputs.slice(0,20),pendingInputsTotal:pendingInputs.length,
              warnings:pendingInputs.slice(0,20).map(item=>`${item.path}: ${item.error}`)}:{}), ...deferredDiagnostics(), ...(unreadableEvidence.length?{unreadableEvidence:unreadableEvidence.slice(0,20),unreadableEvidenceTotal:unreadableEvidence.length}:{}), ...(priorReparse?{reparse:priorReparse}:{}),
            ...(reparsePlan?{reparse:{requested:reparsePlan.identities.length,unavailable:reparsePlan.unavailable}}:{}),
            ...(unreadJournals.length?{reparse:{requested:0,unavailable:unreadJournals}}:{}) };
          // Proven here, where the inputs were read: a stored run's diagnostic lists
          // are sampled once it exceeds the persistence cap, so a resumed rebuild must
          // not read completeness out of evidence that may have been cut away.
          outcome.inputsComplete = pendingInputs.length === 0 && !reparsePlan?.unavailable.length && !unreadJournals.length
            && !(priorReparse as {unavailable?:unknown[]}|undefined)?.unavailable?.length
            && !(adapter.diagnostics.unavailableInputs as unknown[]|undefined)?.length
            && !adapter.diagnostics.unavailableInputsTotal;
          outcomeCommitted = await publishVendorStage({
            sqlite: this.sqlite, store: this.store, prepareStage: (...args) => this.prepareStage(...args),
            now: () => this.now(), saveRun: run => this.saveRun(run), options: this.options, queuedFiles: this.queuedFiles,
          }, { result, outcome, stagePath, prepared, shouldPublish, priorReparse, forceReparse, rebuild,
            publicationState, saveCompletedSourceBookmark, takeWriteLease, fence, progress,
            progressRegister: this.progressRegister, scope, step }, telemetry);
          if(batch&&outcome.status==="success") {
            // A deferred input keeps its queue entry: accepting its old witness would drop the unread rest.
            const failed=new Set([...pendingInputs.map(item=>path.resolve(item.path).toLowerCase()),
              ...deferredInputs.map(item=>path.resolve(toArchivePhysicalPath(item.path)).toLowerCase())]);
            if (outcome.vendor === "codex") for (const item of [...pendingInputs, ...deferredInputs]) {
              const logical = toArchiveLogicalPath(item.path);
              for (const row of [...batch, ...observed]) if (toArchiveLogicalPath(row.path) === logical)
                failed.add(path.resolve(row.path).toLowerCase());
            }
            const witnesses=new Map([...batch,...observed].map(row=>[path.resolve(row.path),row]));
            const changed=measureTiming("checkpointDigestMs",()=>this.fileQueue!.acknowledge([...witnesses.values()].filter(row=>!failed.has(path.resolve(row.path).toLowerCase().replace(/-(wal|shm)$/, ""))&&!failed.has(path.resolve(row.path).toLowerCase()))));
            const changedInputs=changed.filter(input=>calculationInputName(outcome.vendor,input.path));
            // Acknowledgement queued them again; one that grew after its read waits for the next cycle.
            const deferredBefore=deferredInputs.length;
            deferGrowing(changedInputs);
            if(changedInputs.length){
              pendingInputs.push(...changedInputs);outcome.inputsComplete=false;
              outcome.diagnostics={...outcome.diagnostics,pendingInputs:pendingInputs.slice(0,20),pendingInputsTotal:pendingInputs.length,...deferredDiagnostics()};
              this.store.clearSourceBookmark(outcome.vendor);this.saveRun(result);
            } else if(deferredInputs.length>deferredBefore) {
              outcome.diagnostics={...outcome.diagnostics,...deferredDiagnostics()};
              this.store.clearSourceBookmark(outcome.vendor);this.saveRun(result);
            }
          }
        } catch (error) {
          // The publication receipt commits with facts. Cleanup can fail afterwards;
          // the in-memory flag alone cannot distinguish that from a rollback.
          const committed = !this.sqlite.inTransaction
            ? this.store.runById(result.runId)?.vendors.find(vendor => vendor.vendor === outcome.vendor
              && vendor.status === "success" && vendor.sourceImpact !== undefined)
            : undefined;
          if (committed) {
            outcomeCommitted = true;
            Object.assign(outcome, committed);
            outcome.timings = timings;
            const message = error instanceof Error ? error.message : String(error);
            const warnings = Array.isArray(outcome.diagnostics.warnings) ? outcome.diagnostics.warnings : [];
            outcome.diagnostics = {...outcome.diagnostics, postPublicationError: message,
              warnings: [...warnings, `Source published; checkpoint or cleanup needs retry: ${message}`]};
            this.saveRun(result);
          } else {
            if (outcome.vendor === "gauges" && result.scope.kind !== "accounts" && fs.existsSync(stagePath)) {
              await takeWriteLease(scope);
              let failedStage: Database | undefined;
              try {
                failedStage = new Database(stagePath, { readonly: true });
                retainProbeConflicts(this.sqlite, failedStage);
              } catch { retainFailedStage = true; }
              finally { failedStage?.close(true); }
            }
            outcome.status = "failure";
            outcome.sourceImpact = unavailableSourceImpact("source-publication-failed-or-rolled-back");
            outcome.dataChanged = false;
            outcome.dirtyRange = null;
            affected.delete(outcome.vendor);
            outcome.error = error instanceof Error ? error.message : String(error);
            result.afterRevisions = this.store.revisions();
            result.aggregateWorkRequested = result.vendors.some(
              (vendor) => vendor.status === "success" && vendor.dataChanged
            );
          }
        } finally {
          this.progressRegister.end(scope);
          // A retained failed stage is evidence, not residue: it may hold the only
          // copy of observations this run never managed to publish.
          const retained = retainFailedStage ? [] : removeStageArtifacts(stagePath).retained;
          if (retained.length > 0) {
            const warnings = Array.isArray(outcome.diagnostics.warnings) ? outcome.diagnostics.warnings : [];
            outcome.diagnostics = { ...outcome.diagnostics, stageCleanup: { retained },
              warnings: [...warnings, `Stage cleanup incomplete; a later run retries: ${retained.join(", ")}`] };
          }
          if (!outcomeCommitted) {
            outcome.finishedAt = this.now();
            result.afterRevisions = this.store.revisions();
            this.saveRun(result);
          } else {
            if (retained.length > 0) this.saveRun(result);
            if (outcome.dataChanged) {
              progress("checkpoint", step + 5, outcome.vendor);
              this.checkpointWal();
            }
          }
          releaseWriteLease();
        }
      };
      // Vendors form a queue: one vendor at a time goes through every stage, so its parser pool,
      // its stage and its publication never compete with another vendor's.
      for (const outcome of result.vendors) {
        if (outcome.status !== "success") await processVendor(outcome);
      }
      const tail = 1 + result.vendors.length * 6;
      if (collection === "mirror-only") {
        // Collection publishes archive bytes only. Configuration and derived facts
        // belong to the subsequent archive import.
        result.afterRevisions = this.store.revisions();
        omitVerifiedQueueHints();
        return this.finalizeRun(result);
      }
      if (this.claudeTimingDue) await this.claudeTimingPass(takeWriteLease, releaseWriteLease);
      await takeWriteLease(RUN_SCOPE);
      progress("attribution", tail);
      const derivedStarted = performance.now();
      this.refreshDerived(this.sqlite, result, changedConfigDomains, affected,
        phase => progress(phase, tail + ["attribution", "projects"].indexOf(phase)));
      result.derivedMs = Math.round(performance.now() - derivedStarted);
      progress("checkpoint", tail + 2);
      if (result.vendors.some(vendor => vendor.dataChanged) || changedConfigDomains.length)
        this.checkpointWal();
      progress("finalize", tail + 3);
      const acknowledge = () => {
        result.afterRevisions = config.fingerprint !== this.store.configurationFingerprint()
          ? this.store.observeConfigDomains(config.fingerprint, config.domains, this.now()) : this.store.revisions();
      };
      acknowledge();
      releaseWriteLease();
      omitVerifiedQueueHints();
      return this.finalizeRun(result);
    } catch (error) {
      releaseWriteLease();
      omitVerifiedQueueHints();
      return this.finalizeUnexpectedFailure(result, error);
    } finally { releaseWriteLease(); }
  }
  /**
   * One-time pass for parser 6, a budget per cycle: Claude files an older parser read get their calls' response
   * times in place (claude-timing-backfill.ts). It waits for the parser-5 refusal pass, which reads such files whole.
   * Each batch is written under the write lease and released after it, so the background writer follows in between.
   */
  private async claudeTimingPass(take: (scope: string) => Promise<void>, release: () => void): Promise<void> {
    if (this.fileQueue?.taskState(CLAUDE_LIMIT_TASK) !== "done"
      && this.sqlite.query("SELECT 1 FROM claude_files WHERE parser_version < 5 LIMIT 1").get()) return;
    // Once the pass is complete a cycle costs this one read, not a parser start.
    if (!this.sqlite.query("SELECT 1 FROM claude_files WHERE parser_version < ? LIMIT 1").get(CLAUDE_PARSER_VERSION)) return;
    let pool: ParsePool | undefined;
    try {
      pool = new ParsePool(parseWorkerCount());
      const queue = this.fileQueue, task = "claude-timing-failures";
      const step = await backfillClaudeTiming(this.sqlite, pool, async apply => {
        await take(RUN_SCOPE);
        try { return apply(); } finally { release(); }
      }, undefined, files => this.progressRegister.report(RUN_SCOPE, "timing-scan", "Reading response times", "files", files, null),
      queue ? { count: file => Number(queue.fileTaskState(task, file) ?? 0),
        fail: file => queue.setFileTaskState(task, file, String(Number(queue.fileTaskState(task, file) ?? 0) + 1)) } : undefined);
      if (step.files || step.failures.length || step.unavailable) console.log(`[sync] Claude response times: ${step.files} file(s), ${step.updated} call(s) timed, `
        + `${step.skipped} changed file(s) left to the import, ${step.deferred} deferred`
        + `${step.failures.map(failure => `; failed ${failure.path}: ${failure.error}`).join("")}`
        + `${step.unavailable ? `; parser unavailable, deferred: ${step.unavailable}` : ""}${step.done ? ", pass complete" : ""}`);
    } catch (error) {
      console.warn("[sync] Claude response-time pass deferred:", error instanceof Error ? error.message : error);
    } finally {
      this.progressRegister.end(RUN_SCOPE);
      await pool?.close();
    }
  }
  private async waitForTerminal(runId: string): Promise<SyncRunResult> {
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      const persisted = this.store.runById(runId);
      if (persisted && persisted.status !== "running") return persisted;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for external sync run ${runId}`);
      await Bun.sleep(100);
    }
  }
  private finalizeRun(result: SyncRunResult): SyncRunResult {
    result.status = finalStatus(result);
    result.finishedAt = this.now();
    if (result.progress) result.progress.completed = result.progress.total;
    const errors = result.vendors
      .filter((vendor) => vendor.error)
      .map((vendor) => `${vendor.vendor}: ${vendor.error}`);
    result.error = errors.length > 0 ? errors.join("; ") : null;
    this.saveRun(result);
    return result;
  }
  private finalizeUnexpectedFailure(result: SyncRunResult, error: unknown): SyncRunResult {
    const message = error instanceof Error ? error.message : String(error);
    for (const outcome of result.vendors) {
      if (outcome.status !== "pending") continue;
      outcome.status = "failure";
      outcome.error = `Sync setup failed: ${message}`;
      outcome.sourceImpact ??= unavailableSourceImpact("sync-setup-failed-before-publication");
      outcome.finishedAt = this.now();
    }
    result.afterRevisions = this.store.revisions();
    result.status = "failure";
    result.finishedAt = this.now();
    result.error = result.vendors.some(outcome => outcome.status === "success")
      ? `Sync failed after source publication: ${message}` : `Sync setup failed: ${message}`;
    try {
      this.store.saveRunWithBusyRetry(result);
    } catch (persistenceError) {
      const persistenceMessage =
        persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
      result.error = `${result.error}; failure persistence failed: ${persistenceMessage}`;
      this.store.releaseRunClaim(result);
    }
    return result;
  }
}

export function enterSyncPipeline(coordinator: SyncCoordinator, request: SyncRequest): SyncExecution {
  return coordinator.enter(request);
}
