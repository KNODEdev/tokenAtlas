import type { AppContext } from "./app-context-types";
import type { CodexProbeRunner } from "./account-probes";
import { DATA_VIEWS, DIRECT_DATA_ROUTES } from "./data-views";
import { resolveDbPath } from "../db";
import { readStartupAccounts } from "../config/accounts-document";
import { configFile, ARCHIVE_ROOT, CONFIG_ROOT, MACHINE, archive, PROFILE } from "../config/paths";
import { assertExistingAtlasSchemaCurrent, pendingAtlasBootstrapRecovery, pendingAtlasBootstrapVendors, finishAtlasBootstrapRecovery } from "../db/bootstrap";
import { mainThreadStallCheck } from "./main-thread-stall";
import { startArchiveRelocationVerification } from "../sync/archive-relocation-startup";
import { createArchiveMove } from "./archive-move";
import { countSourceFiles, type FirstImport } from "./first-import";
import { scanCodexProfiles } from "../providers/codex-identity";
import { scanVendorProfiles } from "../providers/vendor-identity";
import type { VendorProfile } from "../providers/vendor-identity";
import { configureGaugeJournal } from "../providers/core/journal";
import { setGaugeJournalDelivery } from "../providers/core/journal-runtime";
import { startAnalysisMaintenance } from "./analysis-maintenance";
import { PERIOD_DECLARATIONS_FILE } from "./period-declarations";
import path from "path";
import { SyncFileQueue } from "../sync/file-queue";
import { syncFileRoots } from "../sync/mirror";
import { isVendorId } from "../sync/contracts";
import type { VendorId } from "../sync/contracts";
import { startArchiveCompressionMaintenance } from "./archive-compression-maintenance";
import { startClaudeCloudMaintenance } from "./claude-cloud-maintenance";
import { startBootstrapCatchUp } from "./bootstrap-catch-up";
import type { AtlasBootstrapStage } from "../db/bootstrap";
import { startSyncWatcher } from "../sync/watch";
import { analysisRebuildStatus } from "./analysis-rebuild";
import { storedFingerprint, rulesFingerprint } from "../projects/remap";
import { DEFAULT_PROBE_MINUTES } from "./probe-health";
import { writeLeaseHolder } from "../db/write-lease";
import { LiveReadingsRefresh } from "./live-readings";
import { pollVendorAccount, profileIdentity, resolveVendorDiscovery, rememberedVendorAccounts } from "./vendor-discovery";
import { resolveCodexDiscovery, rememberedCodexAccounts } from "./codex-discovery";
import { claudeAccountId } from "./claude-limit";
import { runClaudeProbeCycle } from "../providers/adapters/claude";
import { grokUnifiedLogPath, runGrokProbeCycle } from "../providers/adapters/grok";
import fs from "fs";
import { readGlmKey, runGlmProbeCycle } from "../providers/adapters/glm";
import { loadPool, runGeminiProbeCycle } from "../providers/adapters/gemini";
import { ResetProbeWatch, readProbeSubjectLimits } from "./reset-probe";
import { runAtlasBootstrap, firstImportPending, awaitingLocations, locationsConfirmed, getAtlasBootstrapState, LOCATIONS_CONFIRMED_KEY, setFirstImportPending, setAwaitingLocations } from "./server-bootstrap";
import { createAppContext, rebuildSubscriptionMaps } from "./app-context";
import { refreshCodexDiscovery, refreshVendorDiscovery, probeTargets, runCodexProbePoll, probeSubscriptionGate, currentProbeSubscription } from "./account-probes";
import { createFetchHandler } from "./api-router";
import { advanceAnalysisRebuildSources, activeSyncCompletion, startSyncCompletion, needsRemap } from "./server-sync";
import { getRemapState, startStartupRemap } from "./server-remap";
import { resolveSubscription } from "./account-scope";

export interface StartServerRuntime {
  context?: AppContext;
  now?: () => string;
  codexProbeRunner?: CodexProbeRunner;
  // Directory the probe journal is appended to; null keeps the journal off.
  // Defaults to the archive except under `bun test`, which must never write
  // into the shared archive.
  gaugeJournalRoot?: string | null;
  serve?: typeof Bun.serve;
  setTimeout?: typeof globalThis.setTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearTimeout?: typeof globalThis.clearTimeout;
  clearInterval?: typeof globalThis.clearInterval;
}

/**
 * Bun closes a socket that sends nothing for 10 s. Every API answer is awaited by the page, and a cold read
 * (a stored-row screen right after a repricing, a direct read in a busy worker) can take longer: its
 * connection must not be reset mid-answer. Workers enforce their own deadlines; reads are cancellable.
 */
export function keepsSocketOpen(pathname: string): boolean {
  // Every registered route is declared in one of the two lists (data-system.test.ts).
  return !!(DATA_VIEWS[pathname] || DIRECT_DATA_ROUTES[pathname]);
}

export function startServer(
  port = Number(process.env.PORT || 7331),
  customDbPath?: string,
  runtime: StartServerRuntime = {}
) {
  const ownsContext = runtime.context == null;
  const databasePath = resolveDbPath(customDbPath);
  if (ownsContext) {
    readStartupAccounts(configFile("accounts.json"), databasePath);
    assertExistingAtlasSchemaCurrent(databasePath);
  }
  const bootstrapResult = ownsContext ? runAtlasBootstrap(databasePath) : null;
  const ctx = runtime.context ?? createAppContext(customDbPath);
  const serve = runtime.serve ?? Bun.serve;
  const rawSetTimeout = runtime.setTimeout ?? globalThis.setTimeout;
  const rawSetInterval = runtime.setInterval ?? globalThis.setInterval;
  const rawClearTimeout = runtime.clearTimeout ?? globalThis.clearTimeout;
  const rawClearInterval = runtime.clearInterval ?? globalThis.clearInterval;
  const timeoutHandles = new Set<ReturnType<typeof globalThis.setTimeout>>();
  const intervalHandles = new Set<ReturnType<typeof globalThis.setInterval>>();
  const scheduleTimeout = (callback: () => unknown, delayMs: number) => {
    let handle: ReturnType<typeof globalThis.setTimeout>;
    handle = rawSetTimeout(() => {
      timeoutHandles.delete(handle);
      return callback();
    }, delayMs);
    timeoutHandles.add(handle);
    return handle;
  };
  const scheduleInterval = (callback: () => void, delayMs: number) => {
    const handle = rawSetInterval(callback, delayMs);
    intervalHandles.add(handle);
    return handle;
  };
  const codexNow = (): string => runtime.now?.() ?? new Date().toISOString();
  if (ownsContext) {
    const stall = mainThreadStallCheck();
    scheduleInterval(stall.tick, stall.intervalMs);
  }
  const relocationVerification=ownsContext?startArchiveRelocationVerification({archiveRoot:ARCHIVE_ROOT,configRoot:CONFIG_ROOT},result=>{
    if(result.status==="pending")console.warn("[tokenAtlas archive] Restart verification pending:",result.reason);
  }):null;
  if(relocationVerification) {
    scheduleTimeout(relocationVerification.update,1000);
    scheduleInterval(relocationVerification.update,60000);
  }
  if (ownsContext) {
    ctx.scanCodexProfiles = () => scanCodexProfiles({ machine: MACHINE, declaredHomes: ctx.accounts.sources
      .filter(s => (s.vendor ?? "codex") === "codex" && (!s.machine || s.machine.toLowerCase() === MACHINE.toLowerCase()))
      .flatMap(s => s.source_home ? [s.source_home] : []) });
    refreshCodexDiscovery(ctx);
    ctx.scanVendorProfiles = () => scanVendorProfiles({machine:MACHINE, declaredHomes:ctx.accounts.sources
      .filter(s => ["claude","grok","gemini"].includes(s.vendor ?? "") && (!s.machine || s.machine.toLowerCase() === MACHINE.toLowerCase()))
      .flatMap(s => s.source_home ? [{vendor:s.vendor as VendorProfile["vendor"],home:s.source_home}] : [])});
    refreshVendorDiscovery(ctx);
  }
  const handleFetch = createFetchHandler(ctx);
  const server = serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, server) {
      if (keepsSocketOpen(new URL(req.url).pathname)) server.timeout(req, 0);
      return handleFetch(req);
    },
  });
  // Configure the local outbox even when the archive is unmounted. The background writer
  // delivers committed entries without waiting for a new probe.
  const journalRoot =
    runtime.gaugeJournalRoot !== undefined
      ? runtime.gaugeJournalRoot
      : process.env.NODE_ENV !== "test"
        ? archive("gauges", PROFILE)
        : null;
  configureGaugeJournal(journalRoot, { archiveRoot: ARCHIVE_ROOT });
  const journalTarget = journalRoot && (ctx.dbPath || ownsContext) ? { journalRoot, archiveRoot: ARCHIVE_ROOT } : null;
  setGaugeJournalDelivery(!!journalTarget);
  if (journalRoot) console.log(`[tokenAtlas API] Gauge journal: ${journalRoot}`);
  // The writer lives outside the HTTP event loop and resumes durable dirty keys after restart. The
  // sync process and a remap take turns with it through the write lease (U2.2); it only waits
  // while this thread writes readings, so those single rows never queue behind one of its batches.
  const backgroundMayStart = () => !ctx.databaseRelocating && !liveReadings.running && !vendorProbesInFlight.size;
  let reportedDeclarations: string | null = null;
  const analysisMaintenance: ReturnType<typeof startAnalysisMaintenance> | null = ownsContext ? startAnalysisMaintenance(ctx.dbPath ?? resolveDbPath(customDbPath), () => ctx.accounts,
    backgroundMayStart, result => {
      const periods = result.accountPeriods;
      if (periods?.declarationErrors?.length && periods.declarationsDigest !== reportedDeclarations)
        console.warn(`[tokenAtlas account periods] ${PERIOD_DECLARATIONS_FILE} rejected:\n  ${periods.declarationErrors.join("\n  ")}`);
      if (periods) reportedDeclarations = periods.declarationsDigest ?? null;
      if (periods?.changed && !periods.pending) rebuildSubscriptionMaps(ctx);
      // Window screens are prefilled once the registers they read have caught up (a turn that did not run them keeps the last word).
      const registers = result.registersPending;
      if (registers?.limitWindows !== undefined && registers.windowSums !== undefined)
        ctx.analysisReader?.prefillReady(!registers.limitWindows && !registers.windowSums);
      runQueuedReconciliation();
    }, { journal: () => journalTarget, answers: {
      take: () => ctx.analysisReader?.takeAnswersToStore() ?? [],
      giveBack: answers => ctx.analysisReader?.returnAnswersToStore(answers),
    } }) : null;
  ctx.waitForBackgroundWriters = async () => { await analysisMaintenance?.waitForIdle(); };
  // Every second: the current projection is the queue's first job and readings must reach the screen soon.
  if (analysisMaintenance) scheduleInterval(analysisMaintenance.update, 1000);
  // Stored window answers read lately are kept current off the HTTP thread (data-read.ts).
  if (ownsContext) scheduleInterval(() => ctx.analysisReader?.refreshStale(), 2000);
  // Every window screen's default answers are prefilled in the background, one at a time while no read waits.
  if (ownsContext) scheduleInterval(() => ctx.analysisReader?.prefill(ctx), 1000);
  if(ownsContext) {
    scheduleInterval(()=>void advanceAnalysisRebuildSources(ctx),3000);
  }
  console.log(`[tokenAtlas API] Running at http://127.0.0.1:${server.port}`);
  const rootDir = path.resolve(import.meta.dir, "../..");
  const everyMin = Number(process.env.TOKENATLAS_SYNC_MINUTES ?? 5);
  const syncFiles=Number.isFinite(everyMin)&&everyMin>0?new SyncFileQueue(ARCHIVE_ROOT):null;
  let queueRoots=syncFiles?syncFileRoots():[];
  let reconcileAfterWriter = false;
  let bootstrapCatchUpMode = bootstrapResult?.catchUpMode ?? null;
  const bootstrapRecoveryId = bootstrapCatchUpMode === "full"
    ? pendingAtlasBootstrapRecovery(ctx.dbPath ?? resolveDbPath(customDbPath)) : null;
  const bootstrapRecoveryVendors = bootstrapRecoveryId
    ? pendingAtlasBootstrapVendors(ctx.dbPath ?? resolveDbPath(customDbPath))?.filter(isVendorId) as VendorId[] | undefined
    : undefined;
  setFirstImportPending(bootstrapCatchUpMode === "full" && bootstrapRecoveryId !== null);
  setAwaitingLocations(firstImportPending && process.env.TOKENATLAS_CONFIRM_LOCATIONS?.trim() !== "0"
    && !locationsConfirmed(ctx.sqlite));
  if (awaitingLocations) {
    getAtlasBootstrapState().message = "Waiting for the folders to be confirmed on the start screen";
    console.log("[tokenAtlas API] Empty database: the first import waits for the folders to be confirmed on the start screen " +
      "(TOKENATLAS_CONFIRM_LOCATIONS=0 skips the wait).");
  }
  const archiveCompression = ownsContext && process.env.NODE_ENV !== "test"
    && process.env.TOKENATLAS_ARCHIVE_COMPRESSION?.trim() === "1"
    ? startArchiveCompressionMaintenance({ archiveRoot: ARCHIVE_ROOT, databasePath: ctx.dbPath ?? resolveDbPath(customDbPath) },
      () => !closed && !awaitingLocations && !firstImportPending && !bootstrapCatchUpMode
        && !activeSyncCompletion && !getRemapState().running && !ctx.databaseRelocating,
      result => { if (result.turn?.job.compressed) ctx.syncWatcher?.reconcile(); }) : null;
  if (archiveCompression) scheduleInterval(archiveCompression.update, 1000);
  // Claude cloud sessions → `-cloud` archive folders; the archive watcher then queues them like another computer's files.
  const cloudSessions = ownsContext && process.env.NODE_ENV !== "test"
    ? startClaudeCloudMaintenance(
      () => !closed && !awaitingLocations && !firstImportPending && !bootstrapCatchUpMode && !ctx.databaseRelocating,
      () => ctx.syncWatcher?.reconcile()) : null;
  ctx.cloudSessions = cloudSessions ?? undefined;
  if (cloudSessions) scheduleInterval(cloudSessions.update, 5000);
  // A catch-up started again after an incomplete one reads only what is still queued.
  let bootstrapRetry = false;
  const runQueuedReconciliation = () => {
    if (!reconcileAfterWriter || getRemapState().running || awaitingLocations) return;
    reconcileAfterWriter = false;
    if (bootstrapCatchUpMode) {
      const mode = bootstrapCatchUpMode;
      bootstrapCatchUpMode = null;
      Object.assign(getAtlasBootstrapState(), {
        running: true,
        started_at: new Date().toISOString(),
        stage: mode === "incremental" || bootstrapRetry ? "incremental-catch-up" : "full-ingest-fallback",
        message: mode === "incremental"
          ? "Running incremental catch-up after snapshot installation"
          : bootstrapRetry ? "Catching up files that changed during the first import"
            : "Running full ingest because no snapshot was usable",
      });
      const completion = startBootstrapCatchUp(mode, bootstrapRecoveryId, phase =>
        activeSyncCompletion ? null : startSyncCompletion(rootDir, "auto", phase.mode, ctx, undefined, undefined, undefined,
          phase.collection, phase.collection ? bootstrapRecoveryVendors : undefined,
          undefined, undefined, phase.collection ? bootstrapRecoveryId ?? undefined : undefined));
      if (!completion) {
        bootstrapCatchUpMode = mode;
        reconcileAfterWriter = true;
        if (activeSyncCompletion) void activeSyncCompletion.finally(() => runQueuedReconciliation());
        return;
      }
      // Imported, incomplete or failed, the first fill is over; readings resume.
      void completion.finally(() => {
        setFirstImportPending(false);
        void ctx.refreshLiveReadings?.().catch(e => console.warn("[tokenAtlas readings] refresh after the first import failed", e));
      }).catch(() => undefined);
      void completion.then(({ collection: collectionResult, import: result, complete }) => {
        if (!result) {
          Object.assign(getAtlasBootstrapState(), {
            running: false,
            stage: "complete" as AtlasBootstrapStage,
            message: "Bootstrap catch-up did not start",
            finished_at: new Date().toISOString(),
            ok: false,
            error: "sync runner returned no result",
          });
          return;
        }
        if (complete && bootstrapRecoveryId) finishAtlasBootstrapRecovery(ctx.sqlite, bootstrapRecoveryId);
        Object.assign(getAtlasBootstrapState(), {
          running: false,
          stage: "complete" as AtlasBootstrapStage,
          message: complete ? "Bootstrap and catch-up completed" : "Bootstrap catch-up incomplete; completed imports remain available for retry",
          finished_at: new Date().toISOString(),
          ok: complete,
          error: complete ? null : [collectionResult?.error, result.error,
            ...[collectionResult,result].flatMap(run=>run?.vendors.filter(vendor=>vendor.inputsComplete===false)
              .map(vendor=>`${vendor.vendor}: required inputs remain unread`)??[])].filter(Boolean).join("; ") || "Required source work remains incomplete",
        });
        if (!complete) {
          bootstrapCatchUpMode = mode;
          bootstrapRetry = true;
          reconcileAfterWriter = true;
        }
        ctx.syncWatcher?.reconcile();
      });
      return;
    }
    ctx.syncWatcher?.reconcile();
  };
  if (Number.isFinite(everyMin) && everyMin > 0) {
    ctx.syncWatcher = startSyncWatcher({
      resolveRoots:()=>{
        queueRoots=syncFileRoots();
        return [...queueRoots.map(root=>({path:root.path,label:`${root.vendor} ${root.kind}`})),{path:CONFIG_ROOT,label:"shared configuration"}];
      },
      ignoreChange:file=>!!file&&(/[/\\]\.archive-inventory[/\\]/.test(file)||/\.tmp(?:-|$)|\.conflict-[a-f0-9]{64}/i.test(file)),
      onFileChange:file=>syncFiles!.signal(file,queueRoots),
      onReconciliationNeeded:()=>syncFiles!.reconcileLater(),
      dbPath: ctx.dbPath ?? resolveDbPath(customDbPath),
      reconciliationMs: everyMin * 60_000,
      runIncremental: async () => {
        if (bootstrapCatchUpMode) {
          reconcileAfterWriter = true;
          runQueuedReconciliation();
          return;
        }
        const rebuilding=analysisRebuildStatus(ctx.sqlite);
        if(rebuilding?.phase==="sources" && (rebuilding.state==="queued" || rebuilding.state==="running")) {
          reconcileAfterWriter=true;
          await advanceAnalysisRebuildSources(ctx);
          return;
        }
        if (getRemapState().running) {
          reconcileAfterWriter = true;
          return;
        }
        await startSyncCompletion(rootDir, "auto", "incremental", ctx);
      },
    });
    console.log(
      `[tokenAtlas API] Live sync watcher with reconciliation every ${everyMin} min ` +
        `(TOKENATLAS_SYNC_MINUTES to change, 0 to disable)`
    );
  }
  ctx.confirmLocations = () => {
    if (!awaitingLocations) return;
    ctx.sqlite.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(LOCATIONS_CONFIRMED_KEY, new Date().toISOString());
    setAwaitingLocations(false);
    console.log("[tokenAtlas API] Folders confirmed - starting the first import.");
    const firstImport: FirstImport = { started_at: new Date().toISOString(), source_files: null };
    ctx.firstImport = firstImport;
    void countSourceFiles(syncFileRoots().filter(root => root.kind === "source"))
      .then(files => { firstImport.source_files = files; }, () => {});
    reconcileAfterWriter = true;
    runQueuedReconciliation();
  };
  if (needsRemap(ctx.sqlite)) {
    const why =
      storedFingerprint(ctx.sqlite) !== rulesFingerprint()
        ? "assignment rules changed since the last remap"
        : "derived columns missing";
    console.log(`[tokenAtlas API] ${why} - remapping in the background.`);
    reconcileAfterWriter = ctx.syncWatcher != null;
    startStartupRemap(rootDir, why, resolveDbPath(customDbPath), ctx, runQueuedReconciliation);
  }
  if (bootstrapCatchUpMode) {
    reconcileAfterWriter = true;
    runQueuedReconciliation();
  } else if (ctx.syncWatcher) {
    if (getRemapState().running) reconcileAfterWriter = true;
    else ctx.syncWatcher.reconcile();
  }
  const probeMin = Number(process.env.TOKENATLAS_PROBE_MINUTES ?? DEFAULT_PROBE_MINUTES);
  let closed = false;
  const beforeLiveRead = async () => {
    // Readings write single rows on this thread. While the sync process or a remap holds the write
    // lease, its transactions may be long (a first-fill publication), so the reading is skipped,
    // not awaited: the next probe or the run's end takes it, and the event loop never waits for
    // them. The background writer's batches are short enough to wait for.
    if (closed) return false;
    const holder = writeLeaseHolder(ctx.sqlite);
    return !holder || holder.kind === "background";
  };
  const liveReadings = new LiveReadingsRefresh(beforeLiveRead);
  ctx.refreshLiveReadings = liveReadings.run.bind(liveReadings);
  const initialTargets = probeTargets(ctx, codexNow());
  const vendorProbesInFlight = new Map<string, Promise<void>>();
  const probeDiscoveredVendor = async (id: string) => {
    const active = vendorProbesInFlight.get(id);
    if (active) return active;
    const account = ctx.vendorDiscovery?.accounts.find(a=>a.id === id);
    const source = ctx.vendorDiscovery?.profiles.filter(p=>p.key === account?.key && p.machine === MACHINE)
      .sort((a,b)=>Number(!!a.error)-Number(!!b.error))[0];
    if (!account || !source) return;
    const completion = beforeLiveRead().then(ready => ready ? pollVendorAccount(ctx.sqlite,account,source) : undefined)
      .then(() => { ctx.responseCache?.invalidateReadings(); })
      .catch(e => { console.warn("[tokenAtlas discovery] account read failed", id, e); })
      .finally(() => { vendorProbesInFlight.delete(id); });
    vendorProbesInFlight.set(id, completion);
    return completion;
  };
  if (ownsContext) {
    const identitySignature = () => JSON.stringify({
      codex:ctx.codexDiscovery?.profiles.map(p=>[p.home,p.identity?.key,p.error]),
      vendors:ctx.vendorDiscovery?.profiles.map(profileIdentity)});
    let lastIdentity = identitySignature();
    // Who is signed in where, without file revisions: `.claude.json` and the profile directory
    // change every few seconds while a client runs, and must not start a probe of every account.
    const signedIn = (codex: ReadonlyArray<{home:string;identity?:{key?:string|null}|null;error?:string|null}>,
      vendors: ReadonlyArray<{vendor:string;home:string;key?:string|null;error?:string|null}>) => JSON.stringify({
      codex:codex.map(p=>[p.home,p.identity?.key,p.error]),vendors:vendors.map(p=>[p.vendor,p.home,p.key,p.error])});
    let lastSignedIn = signedIn(ctx.codexDiscovery?.profiles ?? [], ctx.vendorDiscovery?.profiles ?? []);
    // A sign-in change is rare; probes and live readings rescan the profiles they read themselves.
    scheduleInterval(() => {
      if (activeSyncCompletion || getRemapState().running) return;
      try {
        const codexProfiles = ctx.scanCodexProfiles?.() ?? [];
        const vendorProfiles = ctx.scanVendorProfiles?.() ?? [];
        const next = JSON.stringify({codex:codexProfiles.map(p=>[p.home,p.identity?.key,p.error]),
          vendors:vendorProfiles.map(profileIdentity)});
        if (next === lastIdentity) return;
        lastIdentity = next;
        ctx.codexDiscovery = resolveCodexDiscovery(codexProfiles,ctx.accounts.subscriptions ?? [],rememberedCodexAccounts(ctx.sqlite),MACHINE);
        ctx.vendorDiscovery = resolveVendorDiscovery(vendorProfiles,ctx.accounts.subscriptions ?? [],rememberedVendorAccounts(ctx.sqlite,ctx.accounts.subscriptions),MACHINE);
        ctx.identityRevision = (ctx.identityRevision ?? 0)+1;
        ctx.responseCache?.invalidate();
        const nowSignedIn = signedIn(codexProfiles, vendorProfiles);
        if (nowSignedIn === lastSignedIn) return;
        lastSignedIn = nowSignedIn;
        void liveReadings.run("codex").catch(e=>console.warn("[tokenAtlas identity] Codex refresh failed",e));
        for (const a of ctx.vendorDiscovery?.accounts ?? []) if (a.current) void probeDiscoveredVendor(a.id);
      } catch(e) { console.warn("[tokenAtlas identity] scan failed",e); }
    }, 60_000);
  }
  if (Number.isFinite(probeMin) && probeMin > 0) {
    const poll = liveReadings.register("codex", "codex", () =>
      runCodexProbePoll(ctx, codexNow(), runtime.codexProbeRunner).catch((e: unknown) =>
        console.warn("[tokenAtlas probe] cykl nieudany:", e)
      ));
    scheduleTimeout(poll, 3_000);
    scheduleInterval(poll, probeMin * 60_000);
    console.log(
      `[tokenAtlas API] Account probe every ${probeMin} min for ${initialTargets.map((t) => t.account).join(", ") || "no local targets yet"} ` +
        `(TOKENATLAS_PROBE_MINUTES to change, 0 to disable)`
    );
  }
  if (Number.isFinite(probeMin) && probeMin > 0 && ctx.vendorDiscovery) {
    let polling = false;
    const pollVendors = async () => {
      if (polling) return;
      polling = true;
      try {
        if (!await beforeLiveRead()) return;
        refreshVendorDiscovery(ctx);
        await Promise.all(ctx.vendorDiscovery!.accounts.map(account=>probeDiscoveredVendor(account.id)));
        ctx.responseCache?.invalidateReadings();
      } catch (e) { console.warn("[tokenAtlas discovery] account probe failed", e); }
      finally { polling = false; liveReadings.noteAttempt(["claude", "grok", "gemini"]); }
    };
    for (const vendor of ["claude", "grok", "gemini"] as const) {
      liveReadings.register(vendor, vendor, async () => {
        refreshVendorDiscovery(ctx);
        await Promise.all((ctx.vendorDiscovery?.accounts ?? [])
          .filter(account => account.vendor === vendor && account.current)
          .map(account => probeDiscoveredVendor(account.id)));
      });
    }
    scheduleTimeout(() => void pollVendors(), 4_000);
    scheduleInterval(() => void pollVendors(), probeMin * 60_000);
  }
  const configuredClaudeAccount = claudeAccountId(ctx.claudeGauge.subscription);
  if (!ctx.vendorDiscovery && Number.isFinite(probeMin) && probeMin > 0 && ctx.claudeGauge?.plan && configuredClaudeAccount) {
    const subscription = configuredClaudeAccount;
    const claudeLabel = probeSubscriptionGate(ctx, "claude", subscription);
    const pollClaude = liveReadings.register("claude", "claude", () => {
      const label = claudeLabel();
      if (label == null) return;
      return runClaudeProbeCycle(ctx.sqlite, label, undefined, {
        onError: (e) => console.warn(`[tokenAtlas claude-probe] ${e.account}: ${e.error}`),
      })
        .then(() => ctx.responseCache?.invalidateReadings())
        .catch((e: unknown) => console.warn("[tokenAtlas claude-probe] cykl nieudany:", e));
    });
    scheduleTimeout(pollClaude, 4_000);
    scheduleInterval(pollClaude, probeMin * 60_000);
    console.log(`[tokenAtlas API] Claude usage probe every ${probeMin} min for ${subscription}`);
  }
  const grokLog = grokUnifiedLogPath();
  if (!ctx.vendorDiscovery && Number.isFinite(probeMin) && probeMin > 0 && fs.existsSync(grokLog)) {
    const subscription = ctx.grokGauge.subscription || ctx.grokGauge.store || "grok";
    const grokHome = path.dirname(path.dirname(grokLog));
    const pollGrok = liveReadings.register("grok", "grok", () => {
      return runGrokProbeCycle(
        ctx.sqlite,
        subscription,
        grokHome,
        { onError: (e) => console.warn(`[tokenAtlas grok-probe] ${e.account}: ${e.error}`) },
        (sourceTs) => {
          const resolved =
            resolveSubscription(ctx, "grok", grokHome, sourceTs) ??
            resolveSubscription(ctx, "grok", subscription, sourceTs);
          if (resolved) return resolved;
          // Same login on another machine: the subscription declared only
          // with that machine's archive home is still this account. Mirrors
          // what currentProbeSubscription does for Claude and GLM.
          const viaDeclaration = currentProbeSubscription(ctx, "grok", subscription);
          if (viaDeclaration) return viaDeclaration;
          const declared =
            ctx.eras.erasFor("grok", grokHome).length > 0 ||
            ctx.eras.erasFor("grok", subscription).length > 0;
          return declared ? null : subscription;
        }
      )
        .then(() => ctx.responseCache?.invalidateReadings())
        .catch((e: unknown) => console.warn("[tokenAtlas grok-probe] cykl nieudany:", e));
    });
    scheduleTimeout(pollGrok, 5_000);
    scheduleInterval(pollGrok, probeMin * 60_000);
    console.log(`[tokenAtlas API] Grok billing-log probe every ${probeMin} min for ${subscription}`);
  }
  const glmKey = readGlmKey();
  if (Number.isFinite(probeMin) && probeMin > 0 && glmKey.creds) {
    const glmLabel = probeSubscriptionGate(ctx, "glm", "glm");
    const pollGlm = liveReadings.register("glm", "gauges", () => {
      const label = glmLabel();
      if (label == null) return;
      return runGlmProbeCycle(ctx.sqlite, label, undefined, {
        onError: (e) => console.warn(`[tokenAtlas glm-probe] ${e.error}`),
      })
        .then(() => ctx.responseCache?.invalidateReadings())
        .catch((e: unknown) => console.warn("[tokenAtlas glm-probe] cykl nieudany:", e));
    });
    scheduleTimeout(pollGlm, 5_000);
    scheduleInterval(pollGlm, probeMin * 60_000);
    console.log(`[tokenAtlas API] GLM quota probe every ${probeMin} min (${glmKey.creds.provider})`);
  } else if (glmKey.error) {
    console.log(`[tokenAtlas API] GLM quota probe wylaczony: ${glmKey.error}`);
  }
  const geminiMin = Number(process.env.TOKENATLAS_GEMINI_MINUTES ?? 30);
  const pool = loadPool();
  if (!ctx.vendorDiscovery && Number.isFinite(geminiMin) && geminiMin > 0 && pool.length > 0) {
    let sweeping = false;
    const pollGemini = liveReadings.register("gemini", "gemini", () => {
      if (sweeping) return;
      sweeping = true;
      return runGeminiProbeCycle(ctx.sqlite, pool, {
        onError: (e) => console.warn(`[tokenAtlas gemini-probe] ${e.account}: ${e.error}`),
      })
        .then((r) => {
          ctx.responseCache?.invalidateReadings();
          for (const [fp, ids] of Object.entries(r.collisions)) {
            console.warn(
              `[tokenAtlas gemini-probe] KOLIZJA ODCISKU ${fp}: ${ids.join(", ")} to jedno konto Google — ` +
                `pula ma mniej przepustowości, niż wygląda`
            );
          }
        })
        .catch((e: unknown) => console.warn("[tokenAtlas gemini-probe] przemiat nieudany:", e))
        .finally(() => {
          sweeping = false;
        });
    });
    scheduleTimeout(pollGemini, 10_000);
    scheduleInterval(pollGemini, geminiMin * 60_000);
    console.log(
      `[tokenAtlas API] Gemini quota sweep every ${geminiMin} min for ${pool.length} pool account(s) ` +
        `(TOKENATLAS_GEMINI_MINUTES to change, 0 to disable)`
    );
  }
  if (ownsContext && Number.isFinite(probeMin) && probeMin > 0) {
    // A passed reset is read again within a minute instead of waiting for the probe interval.
    const resetWatch = new ResetProbeWatch();
    scheduleInterval(() => {
      for (const due of resetWatch.due(readProbeSubjectLimits(ctx.sqlite), Date.now())) {
        const discovered = ctx.vendorDiscovery?.accounts.find(a => a.id.toLowerCase() === due.subject.toLowerCase());
        if (discovered) void probeDiscoveredVendor(discovered.id);
        else liveReadings.readNow(due.provider);
      }
    }, 15_000);
  }
  const close = () => {
    if (closed) return;
    closed = true;
    for (const handle of timeoutHandles) rawClearTimeout(handle);
    for (const handle of intervalHandles) rawClearInterval(handle);
    timeoutHandles.clear();
    intervalHandles.clear();
    ctx.claudeLogin?.dispose();
    ctx.syncWatcher?.close();
    syncFiles?.close();
    void analysisMaintenance?.close();
    void archiveCompression?.close();
    void cloudSessions?.close();
    void relocationVerification?.close();
    void ctx.archiveMove?.close();
    void ctx.analysisReader?.close(); void ctx.directReader?.close();
    const stoppable = server as typeof server & { stop?: (closeActiveConnections?: boolean) => void };
    stoppable.stop?.(true);
    if (ownsContext) ctx.sqlite.close();
  };
  if (ownsContext && process.send && process.argv.includes("--atlas-server-child")) {
    // Both moves hand the supervisor a request and stop this process; it switches and starts a new one.
    const restartFor = (message: import("./supervisor").DatabaseRestartRequest | import("./supervisor").ArchiveSwitchRequest) => {
      const rebuild = analysisRebuildStatus(ctx.sqlite);
      if (ctx.databaseRelocating || activeSyncCompletion || getRemapState().running
        || liveReadings.running || vendorProbesInFlight.size || rebuild?.state === "queued" || rebuild?.state === "running") {
        throw new Error("Wait for synchronization or recalculation to finish. / Poczekaj na zakończenie synchronizacji lub przeliczania.");
      }
      ctx.databaseRelocating = true;
      process.send!(message);
      closed = true;
      for (const handle of timeoutHandles) rawClearTimeout(handle);
      for (const handle of intervalHandles) rawClearInterval(handle);
      ctx.syncWatcher?.close();
      syncFiles?.close();
      void ctx.analysisReader?.close(); void ctx.directReader?.close();
      // Allow the accepted response to reach the browser before shutting down the listener.
      rawSetTimeout(() => {
        void (async () => {
          await Promise.all([analysisMaintenance?.close(), archiveCompression?.close(), cloudSessions?.close(),
            relocationVerification?.close(), ctx.archiveMove?.close()]);
          ctx.sqlite.close();
          process.exit(75);
        })().catch(error => { console.error("[tokenAtlas] Shutdown failed:", error); process.exit(1); });
      }, 250);
    };
    ctx.relocateDatabase = destination => restartFor({ type: "relocate-database", destination });
    ctx.archiveMove = createArchiveMove({
      archiveRoot: ARCHIVE_ROOT, database: ctx.dbPath ?? resolveDbPath(customDbPath),
      activate: (jobId, stateDirectory) => restartFor({ type: "activate-archive", jobId, stateDirectory }),
      previousResult: JSON.parse(process.env.TOKENATLAS_ARCHIVE_MOVE_RESULT || "null"),
    });
    ctx.archiveMove.resume();
  }
  return { server, ctx, close };
}
