import { EXCEPTION_VIEWS, createDataRead } from "./data-read";
import type { ReadRegister } from "../db/read-freshness";
import { usageRegisters, registersOfSources, FRESHNESS_HEADER, freshnessHeader } from "../db/read-freshness";
import { usageLedgerProviderOf } from "../db/usage-ledger-read";
import { DATA_VIEWS, readsWindowSums } from "./data-views";
import { contextRequested, contextProjectionStamp } from "./codex-context-preview";
import path from "path";
import { ResponseMemoryBudget } from "./response-memory";
import { ResponseCache, readingsRevision, cacheKey, CLOCK_CACHEABLE_ROUTES, CACHEABLE_ROUTES } from "./cache";
import { ratesWithoutAuthoritativeCodexPolicy, codexLedgerRequestStamp } from "./codex-ledger-request";
import { vendorDiscoveryIdentity } from "./vendor-discovery";
import { handleWindowEndOverrides } from "./window-end-overrides";
import { manualCapacityStamp, handleManualCapacity } from "./manual-capacity";
import { CoalescedReads, cancelledRead } from "./coalesced-read";
import { createDirectRead } from "./direct-read";
import { createRosterFallback } from "./roster-fallback";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { preparingDataResponse } from "./preparing-response";
import { saveTemporaryDirectory } from "../config/temporary-storage";
import { readCloudSyncSetting, saveCloudSyncMinutes } from "../sync/claude-cloud-settings";
import { resolveDbPath } from "../db";
import { validateDatabaseDestination } from "../db/relocate";
import { serveCycleReadBatch } from "./cycle-read-batch";
import { chooseArchiveDirectory } from "./directory-picker";
import { createClaudeLoginService, handleClaudeLogin, claudeLoginHome } from "./claude-login";
import { refuseCrossSiteWrite, refuseForeignHost } from "./write-guard";
import type { SetupSaveInput } from "./setup";
import { prepareSourceProfileEdit, readSourceProfileConfiguration } from "./source-profile";
import type { SourceProfileEdit } from "../shared/source-health";
import { analysisRebuildStatus, resumeAnalysisRebuild, queueAnalysisRebuild } from "./analysis-rebuild";
import type { RebuildOptions } from "../shared/analysis-rebuild";
import { parseRebuildOptions } from "../shared/analysis-rebuild";
import { codexSourceHomes } from "./capacity-equivalents";
import { readSubscriptionRates } from "./subscription-rate";
import { readProjectPlanConversion } from "./project-plan";
import { codexAccountingRequest } from "./codex-accounting";
import { handleCodexTimelineMarkers } from "./codex-timeline-markers";
import { handleCodexPricingSettings } from "./codex-pricing-settings";
import { handleCodexLedgerSettings } from "./codex-ledger-settings-http";
import { isVendorId } from "../sync/contracts";
import { readProgress, progressDirectory } from "../sync/progress";
import { readRefreshCheck } from "./read-refresh";
import { buildSetupStatus } from "./setup";
import { handleSourceFolders } from "./source-folders";
import { buildSourceInventory } from "./source-health";
import { detectSourceProfiles } from "./source-detection";
import { handleHistoryCoverage } from "./history-coverage";
import fs from "fs";
import { rateCardsFileReader } from "./rate-cards-file";
import { trackMainThreadRequest } from "./main-thread-stall";
import { DATA_VERSION_HEADER, dataVersion } from "./data-version";
import { handleAppActivity } from "./app-activity";
import { handleCreditNotices } from "./credit-notices-api";
import { MACHINE } from "../config/paths";
import { handleCurrentRequest } from "./current/http";
import { analysisHash } from "../db/analysis";
import { WINDOW_SCREENS, storedScopeOf } from "./window-screens";
import type { AppContext } from "./app-context-types";
import { ledgerHealthState, handleProbeNotices, handlePlanHealth } from "./api-health";
import { handleProjectsAssign, handleProjectsMerge, handleProjectsReassign, handleProjectsUpdate, handleRepoHistory, handleProjects, handleProjectsRows } from "./api-projects";
import { handleProjectsRemap, getRemapState } from "./server-remap";
import { handleSetupSave, handleAccountPeriods, handleSetup } from "./api-setup";
import { awaitingLocations, getAtlasBootstrapState } from "./server-bootstrap";
import { handleGrokAnchorSave, handleClaudeLimit, handleGrokAnchor } from "./api-provider-limits";
import { handleCyclesSave, handleCycles } from "./api-cycle-settings";
import { handlePlansSave, handlePlansCatalogSave, handlePlans, handlePlansCatalog, handlePlanCapacity } from "./api-plan-settings";
import { handleRateCardsSave, handleRateCards } from "./api-rates";
import { handleAccountState } from "./account-probes";
import { serveSubscriptionAccounting, serveGlobalUsage } from "./api-usage-series";
import { handleIndexSnapshot, getAtlasSnapshotPublicationState } from "./api-index-snapshot";
import { startSync, gaugeJournalOutbox, currentSyncState } from "./server-sync";
import { handleSummary, handleBreakdown, handleCompare, handleCache, handleLeverage } from "./api-summary";
import { handleGauge } from "./api-gauge";
import { handleClaudeAccountSplits } from "./api-window-rail";
import { handleEraTimelines } from "./api-era-timelines";
import { handleAccounts } from "./api-accounts";
import { handleCycleBreakdown } from "./api-cycle-breakdown";
import { handleActivity } from "./api-activity";
import { handleEvents, eventRequest } from "./api-events";
import { handleConversationCourse } from "./conversation-course";
import { handleAccountHistory } from "./api-account-history";

/** Whole-ledger exception views keep their reads off the HTTP thread. */
const wholeLedgerException = (route: string) => route === "/api/planhealth" && !!EXCEPTION_VIEWS[route];

/** Stored-row routes outside the register map that also name the data version they answered from. */
const DATA_VERSION_ROUTES: ReadonlySet<string> = new Set(["/api/roster", "/api/windows", "/api/subscription-rate", "/api/project-plan"]);

/** The registers a GET route reads: a data view's declared sources, or the direct reports' own. */
const DIRECT_READ_REGISTERS: Readonly<Record<string, readonly ReadRegister[]>> = {
  "/api/events": ["codex"],
};

function readRegistersOf(url: URL): readonly ReadRegister[] {
  if (url.pathname === "/api/usage-series" || url.pathname === "/api/global-usage") return usageRegisters();
  if (url.pathname === "/api/subscription-accounting") {
    const provider = url.searchParams.get("provider")?.toLowerCase() ?? "";
    if (["codex", "openai"].includes(provider)) return ["codex", "window-usage", "probe-sources"];
    const ledger = usageLedgerProviderOf(provider);
    return ledger ? [ledger, "window-usage", "probe-sources"] : [];
  }
  const view = DATA_VIEWS[url.pathname];
  return view ? registersOfSources(view.sources) : DIRECT_READ_REGISTERS[url.pathname] ?? [];
}

export function createFetchHandler(ctx: AppContext) {
  const rootDir = path.resolve(import.meta.dir, "../..");
  const publicDir = path.join(rootDir, "public");
  const memory = new ResponseMemoryBudget();
  const cache = new ResponseCache((includeReadings)=>[ratesWithoutAuthoritativeCodexPolicy(ctx.rateCards),ctx.accounts,ctx.claudeGauge,ctx.grokGauge,ctx.cycles,ctx.plans,ctx.plansCatalog,
    [...ctx.homeToSubId??[]],[...ctx.subIdToHomes??[]],ctx.eras?.fingerprint,includeReadings ? [ctx.codexDiscovery,vendorDiscoveryIdentity(ctx.vendorDiscovery),ctx.identityRevision,manualCapacityStamp()] : null], memory);
  const reads = new CoalescedReads();
  const readData = createDataRead(undefined, { memory });
  ctx.analysisReader=readData;
  const directRead = ctx.directReader = createDirectRead();
  const rosterFallback = createRosterFallback();
  ctx.responseCache = cache;
  async function serve(req: Request, url: URL): Promise<Response> {
    try {
      return await serveRoute(req, url);
    } catch (error) {
      if (req.method === "GET" && (error instanceof CodexLedgerNotReady || error instanceof SubscriptionFactsPending)) return preparingDataResponse();
      throw error;
    }
  }
  async function serveRoute(req: Request, url: URL): Promise<Response> {
    if (url.pathname === "/api/setup/temporary" && req.method === "POST") {
      try {
        const body = await req.json() as { directory?: unknown };
        if (typeof body.directory !== "string") throw new Error("Wybierz folder tymczasowy.");
        return Response.json({ root: saveTemporaryDirectory(body.directory, ctx.dbPath ?? resolveDbPath()) });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
      }
    }
    if (url.pathname === "/api/setup/cloud-sessions" && req.method === "GET") {
      try { return Response.json({ setting: readCloudSyncSetting(), status: ctx.cloudSessions?.status() ?? null }); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
    }
    if (url.pathname === "/api/setup/cloud-sessions" && req.method === "POST") {
      try {
        const body = await req.json() as { minutes?: unknown };
        const setting = saveCloudSyncMinutes(body.minutes);
        if (setting.minutes > 0) ctx.cloudSessions?.runSoon();
        return Response.json({ setting: readCloudSyncSetting(), status: ctx.cloudSessions?.status() ?? null });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
      }
    }
    if (url.pathname === "/api/setup/database" && req.method === "GET") {
      return Response.json({ database: ctx.dbPath, result: JSON.parse(process.env.TOKENATLAS_DB_RELOCATION_RESULT || "null") });
    }
    if (url.pathname === "/api/setup/database" && req.method === "POST") {
      try {
        const body = await req.json() as { destination?: unknown; directory?: unknown };
        const source = ctx.dbPath ?? resolveDbPath();
        if (body.directory !== undefined && (typeof body.directory !== "string" || !body.directory.trim()
          || !path.isAbsolute(body.directory) || /[\r\n\0]/.test(body.directory))) throw new Error("Wybierz pełną ścieżkę folderu bazy.");
        const requested = typeof body.directory === "string" ? path.join(body.directory.trim(), path.basename(source)) : body.destination;
        if (typeof requested !== "string") throw new Error("Choose a database folder. / Wybierz folder bazy.");
        const destination = validateDatabaseDestination(source, requested);
        if (!ctx.relocateDatabase) throw new Error("Restart the server using bun run serve to enable database relocation.");
        ctx.relocateDatabase(destination);
        return Response.json({ destination }, { status: 202 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
      }
    }
    if (url.pathname === "/api/health") {
      const res = await readData(ctx,req);
      if(res.status!==200)return res;
      const body = (await res.json()) as Record<string, unknown>;
      return Response.json({...body,status:ctx.homeConflict || ctx.eraErrors.length>0 ? "degraded":"ok",
        home_conflict:ctx.homeConflict?.message??null,era_conflicts:ctx.eraErrors,
        rollups:ledgerHealthState(ctx),cache:cache.stats()},{headers:res.headers});
    }
    if (url.pathname === "/api/cycle-breakdowns") return serveCycleReadBatch(req, (urls, signal) => readData.batch(ctx, urls, signal));
    if (req.method === "GET" && DATA_VIEWS[url.pathname]?.direct) return directRead(ctx, url, req.signal);
    if (req.method === "GET" && DATA_VIEWS[url.pathname]) return readData(ctx,req);
    if (url.pathname === "/api/projects/assign" && req.method === "POST") {
      return handleProjectsAssign(ctx, req);
    }
    if (url.pathname === "/api/projects/merge" && req.method === "POST") {
      return handleProjectsMerge(ctx, req);
    }
    if (url.pathname === "/api/projects/reassign" && req.method === "POST") {
      return handleProjectsReassign(ctx, req);
    }
    if (url.pathname === "/api/projects/update" && req.method === "POST") {
      return handleProjectsUpdate(ctx, req);
    }
    if (url.pathname === "/api/projects/remap" && req.method === "POST") {
      return handleProjectsRemap(ctx);
    }
    if (url.pathname === "/api/setup/directory" && req.method === "POST") {
      try { return Response.json({path:await chooseArchiveDirectory()}); }
      catch (error) { return Response.json({error:error instanceof Error?error.message:String(error)}, {status:503}); }
    }
    if (url.pathname === "/api/setup" && req.method === "POST") {
      return await handleSetupSave(ctx, req);
    }
    if (url.pathname === "/api/setup/confirm" && req.method === "POST") {
      // Releasing the first import is the app page's decision; `respond` refuses cross-site writes (write-guard.ts).
      ctx.confirmLocations?.();
      return Response.json({ ok: true, locations_confirmed: !awaitingLocations });
    }
    if (url.pathname === "/api/source-profile" && req.method === "POST") {
      let input: SetupSaveInput;
      try {
        input = prepareSourceProfileEdit(readSourceProfileConfiguration(ctx.sqlite), await req.json() as SourceProfileEdit);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
      return await handleSetupSave(ctx, new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
    }
    if (url.pathname === "/api/analysis/rebuild") {
      if (req.method === "GET") return Response.json({job:analysisRebuildStatus(ctx.sqlite)});
      if (req.method !== "POST") return Response.json({ error: "Use POST to rebuild analyses" }, { status: 405 });
      let selection: RebuildOptions, resume=false;
      try {
        const input = await req.text();
        const options = input ? JSON.parse(input) : {};
        resume=options.action==="resume";
        selection = parseRebuildOptions(options);
      } catch (error) { return Response.json({error:error instanceof Error?error.message:"Invalid recalculation options"}, {status:400}); }
      try {
        await ctx.waitForBackgroundWriters?.();
        const job = resume ? resumeAnalysisRebuild(ctx.sqlite) : queueAnalysisRebuild(ctx.sqlite, selection, new Date(), true,
          ctx.accounts.subscriptions ?? [], ctx.eras, ctx.rateCards, codexSourceHomes(ctx.homeToSubId), ctx.accounts.sources);
        return Response.json({ ok: true, generation:job.generation, job });
      } catch (error) {
        const busy = /database is locked|SQLITE_BUSY/i.test(String(error));
        const alreadyRunning = /already queued or running/.test(String(error));
        return Response.json({ error: busy
          ? "Data is being saved. Try again when synchronization finishes. / Trwa zapis danych. Spróbuj ponownie po zakończeniu synchronizacji."
          : String(error instanceof Error ? error.message : error) }, { status: busy || alreadyRunning ? 409 : 503 });
      }
    }
    if (url.pathname === "/api/grok-anchor" && req.method === "POST") {
      return await handleGrokAnchorSave(ctx, req);
    }
    if (url.pathname === "/api/cycles" && req.method === "POST") {
      return await handleCyclesSave(ctx, req);
    }
    if (url.pathname === "/api/plans" && req.method === "POST") {
      return await handlePlansSave(ctx, req);
    }
    if (url.pathname === "/api/plans-catalog" && req.method === "POST") {
      return await handlePlansCatalogSave(ctx, req);
    }
    if (url.pathname === "/api/rate-cards" && req.method === "POST") {
      return await handleRateCardsSave(ctx, req);
    }
    if (url.pathname === "/api/account-state") {
      return await handleAccountState(ctx, req);
    }
    if (url.pathname === "/api/probe-notices" && req.method === "GET") return handleProbeNotices(ctx);
    if (url.pathname === "/api/subscription-rate" && req.method === "GET") return Response.json(readSubscriptionRates(ctx.sqlite, url.searchParams.get("account") || undefined,contextRequested(url)));
    if(url.pathname==='/api/project-plan'&&req.method==='GET')return Response.json(readProjectPlanConversion(ctx.sqlite,ctx.plansCatalog,url.searchParams.get('project')??undefined,[...url.searchParams.getAll('plan'),...(url.searchParams.get('plans')??'').split(',').filter(Boolean)],Date.now(),contextRequested(url)));
    if (url.pathname === "/api/manual-capacity") return handleManualCapacity(req);
    if (url.pathname === "/api/window-end-overrides") return handleWindowEndOverrides(req, ctx.sqlite);
    // Codex accounting is on the exception list (data-read.ts): the subscription route's Codex provider is the same report.
    // A request it refuses (no subscription, invalid dates) is answered here, before any work is queued.
    const codexProvider = url.pathname === "/api/subscription-accounting" && ["codex", "openai"].includes(url.searchParams.get("provider")?.toLowerCase() ?? "");
    if (codexProvider || url.pathname === "/api/codex-accounting" && req.method === "GET") {
      const refused = codexAccountingRequest(url.searchParams);
      if ("error" in refused) return Response.json({ error: refused.error }, { status: 400 });
    }
    if (codexProvider) {
      const codex = new URL(url);
      codex.pathname = "/api/codex-accounting";
      codex.searchParams.delete("provider");
      return readData(ctx, new Request(codex, { signal: req.signal }));
    }
    if (url.pathname === "/api/subscription-accounting") {
      return serveSubscriptionAccounting(ctx, req);
    }
    if (url.pathname === "/api/codex-timeline-markers") {
      return handleCodexTimelineMarkers(ctx.sqlite, req, undefined, ctx.rateCards);
    }
    if (url.pathname === "/api/subscription-timeline-markers") {
      return handleCodexTimelineMarkers(ctx.sqlite, req, undefined, ctx.rateCards, url.searchParams.get("provider") ?? "");
    }
    if (url.pathname === "/api/account-periods") return req.method === "GET" ? directRead(ctx, url, req.signal) : handleAccountPeriods(ctx, req);
    if (url.pathname === "/api/codex-pricing") {
      return handleCodexPricingSettings(ctx, req);
    }
    if (url.pathname === "/api/codex-ledger-settings") return handleCodexLedgerSettings(ctx, req);
    if (url.pathname === "/api/index-snapshot") {
      return handleIndexSnapshot(ctx, req);
    }
    if (url.pathname === "/api/sync") {
      if (req.method === "POST") {
        const mode = url.searchParams.get("mode") === "full" ? "full" : "incremental";
        const vendorValue = url.searchParams.get("vendor");
        if (vendorValue && !isVendorId(vendorValue)) {
          return Response.json({ error: `Unknown sync vendor '${vendorValue}'` }, { status: 400 });
        }
        const vendor = isVendorId(vendorValue) ? vendorValue : undefined;
        return Response.json({
          ...startSync(rootDir, "manual", mode, ctx, vendor),
          remap: getRemapState(),
          watch: ctx.syncWatcher?.status() ?? null,
          bootstrap: getAtlasBootstrapState(),
          snapshot: getAtlasSnapshotPublicationState(),
          outbox: gaugeJournalOutbox(ctx),
        });
      }
      return Response.json({
        ...currentSyncState(ctx),
        // Every running stage and background producer, from the one progress register.
        progress: readProgress(progressDirectory(ctx.sqlite.filename)),
        identity_revision: ctx.identityRevision ?? 0,
        readings_revision: readingsRevision(ctx.sqlite),
        read_changes: readRefreshCheck(ctx, url),
        remap: getRemapState(),
        watch: ctx.syncWatcher?.status() ?? null,
        bootstrap: getAtlasBootstrapState(),
        snapshot: getAtlasSnapshotPublicationState(),
        outbox: gaugeJournalOutbox(ctx),
      });
    }
    if (req.method !== "GET") {
      return Response.json({ error: `Method ${req.method} not allowed` }, { status: 405 });
    }
    if (url.pathname === "/api/planhealth") {
      return handlePlanHealth(ctx, url);
    }
    if (url.pathname === "/api/summary") {
      return handleSummary(ctx, url);
    }
    if (url.pathname === "/api/breakdown") {
      return handleBreakdown(ctx, url);
    }
    if (url.pathname === "/api/compare") {
      return handleCompare(ctx, url);
    }
    if (url.pathname === "/api/cache") {
      return handleCache(ctx, url);
    }
    if (url.pathname === "/api/gauge") {
      return handleGauge(ctx, url);
    }
    if (url.pathname === "/api/claude-limit") {
      return handleClaudeLimit(ctx, url);
    }
    if (url.pathname === "/api/claude-limit-card") {
      return handleClaudeLimit(ctx, url, true);
    }
    if (url.pathname === "/api/claude-account-splits") {
      return handleClaudeAccountSplits(ctx, url);
    }
    if (url.pathname === "/api/leverage") {
      return handleLeverage(ctx, url);
    }
    if (url.pathname === "/api/roster") {
      return await rosterFallback.respond(cacheKey(url), ctx.dbPath ?? "", await directRead(ctx, url, req.signal));
    }
    if (url.pathname === "/api/era-timelines") {
      return handleEraTimelines(ctx);
    }
    if (url.pathname === "/api/accounts") {
      return handleAccounts(ctx);
    }
    if (url.pathname === "/api/rate-cards") {
      return handleRateCards(ctx);
    }
    if (url.pathname === "/api/setup") {
      return url.searchParams.get("summary") === "1"
        ? Response.json({ ...buildSetupStatus(), locations_confirmed: !awaitingLocations }) : handleSetup(ctx);
    }
    if (url.pathname === "/api/source-folders") return handleSourceFolders(req);
    if (url.pathname === "/api/source-profile") {
      const config = readSourceProfileConfiguration(ctx.sqlite);
      const vendor = url.searchParams.get("discover");
      return Response.json({ ...config, inventory: buildSourceInventory(ctx), ...(vendor ? { detected_profiles: detectSourceProfiles(vendor, config) } : {}) });
    }
    if (url.pathname === "/api/grok-anchor") {
      return handleGrokAnchor(ctx);
    }
    if (url.pathname === "/api/cycles") {
      return handleCycles(ctx);
    }
    if (url.pathname === "/api/plans") {
      return handlePlans(ctx, url);
    }
    if (url.pathname === "/api/history-coverage") {
      return handleHistoryCoverage(ctx, url);
    }
    if (url.pathname === "/api/plans-catalog") {
      return handlePlansCatalog(ctx);
    }
    if (url.pathname === "/api/plan-capacity") {
      return handlePlanCapacity(ctx, url);
    }
    if (url.pathname === "/api/windows") {
      return await directRead(ctx, url, req.signal);
    }
    if (url.pathname === "/api/usage-series") {
      return await directRead(ctx, url, req.signal);
    }
    if (url.pathname === "/api/cycle-breakdown") {
      return handleCycleBreakdown(ctx, url);
    }
    if (url.pathname === "/api/repo-history") {
      return handleRepoHistory(ctx, url, req);
    }
    if (url.pathname === "/api/activity") {
      return handleActivity(ctx, url);
    }
    if (url.pathname === "/api/events") {
      return handleEvents(ctx, url);
    }
    if (url.pathname === "/api/conversation-course") return handleConversationCourse(ctx, url);
    if (url.pathname === "/api/account-history") {
      return handleAccountHistory(ctx, url);
    }
    if (url.pathname === "/api/global-usage") {
      return serveGlobalUsage(ctx, url);
    }
    if (url.pathname === "/api/projects") {
      return handleProjects(ctx);
    }
    if (url.pathname === "/api/projects/unassigned" || url.pathname === "/api/projects/rows") {
      return handleProjectsRows(ctx, url);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const indexFile = path.join(publicDir, "index.html");
      if (fs.existsSync(indexFile)) {
        return new Response(fs.readFileSync(indexFile, "utf-8"), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }
    let reqSubPath = url.pathname;
    if (reqSubPath.startsWith("/public/")) {
      reqSubPath = reqSubPath.slice(8);
    } else if (reqSubPath.startsWith("/")) {
      reqSubPath = reqSubPath.slice(1);
    }
    if (reqSubPath) {
      const safeSubPath = path.normalize(reqSubPath).replace(/^(\.\.[\/\\])+/, "");
      const targetFile = path.join(publicDir, safeSubPath);
      if (targetFile.startsWith(publicDir) && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
        const ext = path.extname(targetFile).toLowerCase();
        let mime = "application/octet-stream";
        if (ext === ".html" || ext === ".htm") mime = "text/html; charset=utf-8";
        else if (ext === ".css") mime = "text/css; charset=utf-8";
        else if (ext === ".js") mime = "application/javascript; charset=utf-8";
        else if (ext === ".json") mime = "application/json; charset=utf-8";
        else if (ext === ".svg") mime = "image/svg+xml";
        else if (ext === ".png") mime = "image/png";
        return new Response(fs.readFileSync(targetFile), {
          headers: { "Content-Type": mime },
        });
      }
    }
    return Response.json({ error: "Not Found", path: url.pathname }, { status: 404 });
  }
  // Every successful read of the registers says how fresh they are (golden rules §9): the response's rows
  // are the last published ones, and the header names the registers with newer data in processing. It
  // also names the version of the stored rows it was read from (plan U4.4); a kept exception answer
  // already carries the version it was computed from.
  // An edit of rate-cards.json outside Settings reaches this process as it reaches the background worker.
  // A file that does not parse keeps the loaded card; the warning is written once per error.
  const rateCardsFile = rateCardsFileReader();
  let rateCardsWarning = "";
  function followRateCardsFile(): void {
    try {
      const read = rateCardsFile();
      rateCardsWarning = "";
      if (read.changed && read.rates) ctx.rateCards = read.rates;
    } catch (error) {
      const message = `[rate-cards] keeping the loaded card: ${error instanceof Error ? error.message : String(error)}`;
      if (message !== rateCardsWarning) console.warn(message);
      rateCardsWarning = message;
    }
  }
  followRateCardsFile();
  return async function fetch(req: Request): Promise<Response> {
    const refused = refuseForeignHost(req);
    if (refused) return refused;
    const handled = trackMainThreadRequest(new URL(req.url).pathname);
    let response: Response;
    try { response = await respond(req); } finally { handled(); }
    if (req.method !== "GET" || response.status !== 200 || !ctx.sqlite) return response;
    const url = new URL(req.url), registers = readRegistersOf(url);
    if (registers.length) response.headers.set(FRESHNESS_HEADER, freshnessHeader(ctx.sqlite, registers));
    if ((registers.length || DATA_VERSION_ROUTES.has(url.pathname)) && !response.headers.has(DATA_VERSION_HEADER))
      response.headers.set(DATA_VERSION_HEADER, dataVersion(ctx.sqlite, { contextPrices: contextRequested(url) ? url.pathname : false }));
    return response;
  };
  async function respond(req: Request): Promise<Response> {
    // Every write: another web page must not reach this loopback server with a simple request.
    const refused = refuseCrossSiteWrite(req);
    if (refused) return refused;
    const url = new URL(req.url);
    if (url.pathname === "/api/app-activity" && req.method === "GET") return handleAppActivity(ctx.sqlite, readData.activity());
    if (url.pathname === "/api/credit-notices") return await handleCreditNotices(ctx.sqlite, req);
    if (url.pathname === "/api/claude-login") {
      // A new token is read at once by the same scheduled Claude reading, not by a second scheduler.
      ctx.claudeLogin ??= createClaudeLoginService({ onSignedIn: () => {
        void ctx.refreshLiveReadings?.("claude")?.catch(error => console.warn("[tokenAtlas claude-login] reading after sign-in failed", error));
      } });
      return await handleClaudeLogin(req, { service: ctx.claudeLogin, machine: MACHINE,
        resolveHome: subject => claudeLoginHome(subject, ctx.vendorDiscovery, MACHINE) });
    }
    if (url.pathname.startsWith("/api/")) followRateCardsFile();
    if (ctx.databaseRelocating) return Response.json({ error: "Database relocation in progress. / Trwa przenoszenie bazy." }, { status: 503 });
    const currentPath = url.pathname === "/api/bootstrap" || url.pathname === "/api/revisions"
      || /^\/api\/subscriptions\/[^/]+\/current$/.test(url.pathname);
    if (currentPath) {
      const current = handleCurrentRequest({
        sqlite: ctx.sqlite, accounts: ctx.accounts,
        attributionBlocked: Boolean(ctx.homeConflict || ctx.eraErrors?.length),
      }, req);
      if (current) return current;
    }
    if (
      ctx.homeConflict &&
      url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/setup" &&
      url.pathname !== "/api/health"
    ) {
      return Response.json(
        {
          error: ctx.homeConflict.message,
          hint: "POST /api/setup with non-conflicting home/source_home paths",
        },
        { status: 503 }
      );
    }
    if (req.method === "POST") {
      const rateDependency = analysisHash(ratesWithoutAuthoritativeCodexPolicy(ctx.rateCards));
      const res = await serve(req, url);
      const scopedPolicyEdit = ["/api/codex-ledger-settings", "/api/codex-pricing", "/api/rate-cards"].includes(url.pathname)
        && ctx.rateCards.codex_ledger_policy && rateDependency === analysisHash(ratesWithoutAuthoritativeCodexPolicy(ctx.rateCards));
      if (res.ok && url.pathname !== "/api/sync" && !scopedPolicyEdit) cache.invalidate();
      return res;
    }
    // A window screen answers from its stored row, also while the ledger behind it is repriced (window-screens.ts).
    if (req.method === "GET" && WINDOW_SCREENS[url.pathname] && (DATA_VIEWS[url.pathname] || storedScopeOf(ctx, url))) return readData(ctx, req);
    // Plan health reads the whole Codex ledger: its stamp took 1-1.6 s on this thread after every Codex publication. It
    // keeps its own answers off the HTTP thread (data-read.ts), so no stamp is needed here. (The account list reads only
    // stored call counts: a rows view, without a price stamp.)
    if (req.method === "GET" && wholeLedgerException(url.pathname)) return readData(ctx, req);
    if (req.method === "GET") {
      if (url.pathname === "/api/events") {
        const parsed = eventRequest(ctx,url);
        if (parsed instanceof Response) return parsed;
      }
      try { codexLedgerRequestStamp(ctx, url); }
      catch (error) { if (error instanceof SubscriptionFactsPending) return preparingDataResponse(); throw error; }
    }
    if (url.pathname === "/api/leverage" || url.pathname === "/api/account-history") return serve(req, url);
    // Prepared marker rows are tiny; read their current pending state instead of caching a stale freshness label.
    if (req.method === "GET" && DATA_VIEWS[url.pathname]?.sources.includes("model_timeline_first")) return serve(req, url);
    const clocked = DATA_VIEWS[url.pathname]?.clock === true || CLOCK_CACHEABLE_ROUTES.has(url.pathname) || url.pathname === "/api/project-cost";
    if (!ctx.sqlite || req.method !== "GET" || (!DATA_VIEWS[url.pathname] && !CACHEABLE_ROUTES.has(url.pathname) && !clocked)) {
      return serve(req, url);
    }
    if (req.signal.aborted) return cancelledRead();
    const key = cacheKey(url);
    const windowSums = readsWindowSums(url.pathname);
    const currentStamp = (): string => (clocked
      ? cache.clockStamp(ctx.sqlite, Date.now(), windowSums)
      : cache.stamp(ctx.sqlite, ["/api/health", "/api/codex-accounting", "/api/subscription-accounting", "/api/project-cost"].includes(url.pathname), windowSums))
        + ":codex:" + (codexLedgerRequestStamp(ctx, url) ?? "none")
        + (contextRequested(url) ? ":" + contextProjectionStamp(ctx.sqlite, url) : "");
    let stamp: string, hit: string | null;
    try { stamp = currentStamp(); hit = cache.get(key, stamp); }
    catch (error) { if (error instanceof SubscriptionFactsPending) return preparingDataResponse(); throw error; }
    if (hit !== null) {
      if (url.pathname === "/api/health") {
        const body = JSON.parse(hit) as Record<string, unknown>;
        return Response.json(
          { ...body, cache: cache.stats() },
          { headers: { "X-Cache": "hit" } }
        );
      }
      return new Response(hit, { headers: { "Content-Type": "application/json", "X-Cache": "hit" } });
    }
    const publicationStable = !cache.syncInProgress(ctx.sqlite);
    return reads.run(JSON.stringify([key, stamp]), req.signal, async (signal) => {
      const res = await serve(new Request(req, { signal }), url);
      if (signal.aborted) return cancelledRead();
      if (res.status !== 200 || res.headers.get("X-Analysis") === "stale" ||
        /(?:^|,)\s*no-store\b/i.test(res.headers.get("Cache-Control") ?? "")) return res;
      const body = await res.text();
      // Never publish a result computed across invalidation, a clock boundary,
      // or an in-progress sync under the previous terminal revision.
      let nativeStable = false;
      try { nativeStable = currentStamp() === stamp; }
      catch (error) { if (error instanceof SubscriptionFactsPending) return preparingDataResponse(); throw error; }
      if (!signal.aborted && publicationStable && !cache.syncInProgress(ctx.sqlite) && nativeStable) {
        cache.set(key, stamp, body);
      }
      const headers = new Headers(res.headers);
      headers.set("X-Cache", "miss");
      return new Response(body, { headers });
    });
  }

}
