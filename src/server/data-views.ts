import { handleHealth as apiHandleHealth, handleMissingRates as apiHandleMissingRates, handlePlanHealth as apiHandlePlanHealth } from "./api-health";
import { handleEraTimelines as apiHandleEraTimelines } from "./api-era-timelines";
import { handleCycles as apiHandleCycles } from "./api-cycle-settings";
import { handleSummary as apiHandleSummary, handleBreakdown as apiHandleBreakdown, handleCompare as apiHandleCompare, handleCache as apiHandleCache, handleLeverage as apiHandleLeverage } from "./api-summary";
import { handleAccountHistory as apiHandleAccountHistory } from "./api-account-history";
import { handleActivity as apiHandleActivity, handleModelSpeed as apiHandleModelSpeed } from "./api-activity";
import { handleProjects as apiHandleProjects, handleProjectsRows as apiHandleProjectsRows, handleRepoHistory as apiHandleRepoHistory, handleProjectCost as apiHandleProjectCost, handlePlanPriceCoverage as apiHandlePlanPriceCoverage, handleBillingCycles as apiHandleBillingCycles } from "./api-projects";
import { handleAccounts as apiHandleAccounts } from "./api-accounts";
import { handleCycleBreakdown as apiHandleCycleBreakdown } from "./api-cycle-breakdown";
import { handleClaudeLimit as apiHandleClaudeLimit } from "./api-provider-limits";
import { handleClaudeAccountSplits as apiHandleClaudeAccountSplits } from "./api-window-rail";
import { handleGauge as apiHandleGauge } from "./api-gauge";
import { handlePlanCapacity as apiHandlePlanCapacity } from "./api-plan-settings";
import type { AppContext } from "./app-context-types";
import {CODEX_CANONICAL_COPY_POLICY} from "../db/codex-ledger-canonical";
import { preparingRows } from "./preparing-response";
export { preparingRows } from "./preparing-response";


import { analysisHash } from "../db/analysis";
import { handleHistoryCoverage } from "./history-coverage";
import { handleCodexAccounting } from "./codex-accounting";
import { handleCapacityCycles } from "./capacity-cycles";
import { handleCodexCapacity, handleCodexCapacityRange } from "./codex-capacity";
import { CAPACITY_CYCLE_RESULTS_CLOCK } from "./capacity-cycle-producer";
import { handleModelCapacity } from "./model-capacity";
import { handleModelUsageShare } from "./model-usage-share";
import { handleCodexTimelineMarkers,timelineMarkerFilesStamp } from "./codex-timeline-markers";
import { projectCapacityConfiguration } from "./project-cost-configuration";
import { loadProjects } from "../projects/remap";
import { handleSourceHealth } from "./source-health";
import { presentSourceHealth, preparedAtMs, presentClockFields, PREPARED_AT_HEADER } from "./data-clock";
import { vendorDiscoveryIdentity } from "./vendor-discovery";
import { WINDOW_USAGE_CLOCK } from "./window-usage-clock";
import { dataVersion, DATA_VERSION_HEADER } from "./data-version";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-unavailable";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { CodexLedgerNotReady } from "../db/codex-price-ledger";
import { handleModelCacheHistory } from "./model-cache-history";
import { handleWindowProjects } from "./window-projects";
import { contextRequested } from "./codex-context-preview";

const facts = ["events","claude_events","oc_events","grok_events","gemini_events"];
const observations = ["ratelimit","probe_windows"];
// Who is signed in where: the running observed account periods (their `last_seen` moves with each reading).
const identity = ["account_periods"];
type Builder = (ctx:AppContext,url:URL)=>Response|Promise<Response>;
export interface DataView { build:Builder; sources:readonly string[]; clock:boolean; preparationClock?:false|"day"; present?:(body:unknown,nowMs:number)=>unknown; probeIndexRequired?:boolean;
  /** Plan U4.4: built on each request from stored rows (no remembered report); see `serveDataView`. */
  direct?:true }
const historical = (build:Builder):DataView=>({build,sources:facts,clock:false});
// Claude's limit refusals are percentage readings of its rail windows, derived from transcripts.
const claudeReadings = ["claude_limit_hits"];
const current = (build:Builder):DataView=>({build,sources:[...facts,...observations,...claudeReadings,...identity],clock:true});
// Stored window sums (plan U1.4): views that show them follow the window producer's publications.
const withWindowSums = (view:DataView):DataView=>({...view,sources:[...view.sources,WINDOW_USAGE_CLOCK]});
// Plan costs priced from stored billing-cycle prices (docs/plan-price-from-cycles-2026-10-18.md).
const withCyclePrices = (view:DataView):DataView=>({...view,sources:[...view.sources,"billing_cycles"]});
/** A view that reads only stored rows (ledger days and sums, limit windows, window usage, probe readings, periods). */
const rows = (view:DataView):DataView=>({...view,direct:true});

/** Every analytical GET is declared here; bounded details and operational routes are classified separately. */
export const DATA_VIEWS:Readonly<Record<string,DataView>> = {
  "/api/source-health":{...current(handleSourceHealth),preparationClock:"day",present:presentSourceHealth},
  "/api/health":{...current(apiHandleHealth),preparationClock:"day",sources:[...facts,...observations,...identity,"files","claude_files","meta","sync_revisions","vendor_sync_revisions","sync_runs"]},
  // Ledger day sums against the current rate card: the missing-price alert of the status bar and account cards.
  "/api/missing-rates":rows(historical(apiHandleMissingRates)),
  "/api/era-timelines":rows({...current(apiHandleEraTimelines),preparationClock:"day"}),
  "/api/cycles":rows({...current(ctx=>apiHandleCycles(ctx))}),
  "/api/summary":rows(historical(apiHandleSummary)),
  "/api/breakdown":rows(historical(apiHandleBreakdown)),
  "/api/compare":rows(historical(apiHandleCompare)),
  "/api/cache":rows(historical(apiHandleCache)),
  "/api/leverage":rows({...current(apiHandleLeverage),sources:["events","claude_events","account_periods"]}),
  "/api/account-history":rows(historical(apiHandleAccountHistory)),
  "/api/activity":rows(historical(apiHandleActivity)),
  // Output speed per model of one Claude subscription: the ledger's timed hour sums (model-speed.ts).
  "/api/model-speed":rows({...historical(apiHandleModelSpeed),sources:[...facts,...identity,"response_time_hours"]}),
  "/api/projects":rows(historical(apiHandleProjects)),
  "/api/projects/rows":rows(historical(apiHandleProjectsRows)),
  "/api/projects/unassigned":rows(historical(apiHandleProjectsRows)),
  "/api/repo-history":rows(withCyclePrices(historical(apiHandleRepoHistory))),
  // Stored day sums per account and subject, their capacities from stored windows and readings (stored-project-usage.ts).
  "/api/project-cost":rows({...withCyclePrices(withWindowSums(current(apiHandleProjectCost))),clock:false}),
  // The project report's subscriptions and their plan-price stretches, without its capacities (plan-price-coverage.ts).
  "/api/plan-price-coverage":rows({...withCyclePrices(current(apiHandlePlanPriceCoverage)),clock:false}),
  // Stored billing cycles of every account (billing-cycles-view.ts): one read, `stale` while the producer catches up.
  "/api/billing-cycles":rows(withWindowSums({build:apiHandleBillingCycles,sources:["billing_cycles",...identity],clock:false})),
  // Calls per account from the ledgers' stored sums; built on each request off the HTTP thread.
  "/api/accounts":rows({...current(apiHandleAccounts),clock:false,probeIndexRequired:true}),
  "/api/cycle-breakdown":withWindowSums(current(apiHandleCycleBreakdown)),
  "/api/model-cache-history":{build:handleModelCacheHistory,sources:["events",...identity],clock:false},
  "/api/window-projects":{build:handleWindowProjects,sources:[...facts,...identity],clock:false},
  // A window screen (window-screens.ts): stored per account.
  "/api/claude-limit":{...withWindowSums(current(apiHandleClaudeLimit)),preparationClock:"day"},
  "/api/claude-limit-card":{...withWindowSums(current((ctx,url)=>apiHandleClaudeLimit(ctx,url,true))),preparationClock:"day"},
  "/api/claude-account-splits":rows({...withWindowSums(current(apiHandleClaudeAccountSplits)),preparationClock:"day"}),
  "/api/gauge":current(apiHandleGauge),
  "/api/planhealth":current(apiHandlePlanHealth),
  "/api/plan-capacity":rows({...withWindowSums(current(apiHandlePlanCapacity)),preparationClock:"day"}),
  // Every subscription's cycles for the capacity comparison: the stored register and its stored sums (capacity-cycles.ts).
  "/api/capacity-cycles":rows({build:handleCapacityCycles,sources:[CAPACITY_CYCLE_RESULTS_CLOCK,...identity],clock:false}),
  "/api/codex-capacity":rows({build:handleCodexCapacity,sources:[CAPACITY_CYCLE_RESULTS_CLOCK,...identity],clock:false}),
  "/api/codex-capacity-range":rows({build:handleCodexCapacityRange,sources:[CAPACITY_CYCLE_RESULTS_CLOCK,...identity],clock:false}),
  "/api/model-capacity":rows({...withWindowSums(current(handleModelCapacity)),clock:false}),
  // Estimated limit share by model from the same stored window sums and meter readings (model-usage-share.ts).
  "/api/model-usage-share":rows({...withWindowSums(current((ctx,url)=>handleModelUsageShare(ctx,url))),clock:false}),
  "/api/codex-accounting":{...current((ctx,url)=>handleCodexAccounting(ctx,new Request(url))),clock:false,sources:["events","ratelimit","probe_windows",WINDOW_USAGE_CLOCK]},
  "/api/history-coverage":{...current(handleHistoryCoverage),preparationClock:false},
  "/api/codex-timeline-markers":{...current((ctx,url)=>handleCodexTimelineMarkers(ctx.sqlite,new Request(url),undefined,ctx.rateCards)),preparationClock:false},
  "/api/subscription-timeline-markers":{...current((ctx,url)=>handleCodexTimelineMarkers(ctx.sqlite,new Request(url),undefined,ctx.rateCards,url.searchParams.get("provider")??"")),preparationClock:false},
};
/**
 * Whether answers of a route read stored window sums: a declared view only when it declares their clock; any
 * other route is assumed to. Window sums publish several times per synchronization, so the remembered answers
 * and responses of the views that never read them are not dropped for it.
 */
export function readsWindowSums(pathname:string):boolean {
  const view=DATA_VIEWS[pathname];
  return view ? view.sources.includes(WINDOW_USAGE_CLOCK) : true;
}
export type DataContext = Pick<AppContext,"accounts"|"claudeGauge"|"grokGauge"|"cycles"|"plans"|"plansCatalog"|"rootDir"|
  "codexDiscovery"|"vendorDiscovery"|"identityRevision"|"eraErrors"> & { subHomes:[string,string[]][] };
export function snapshotDataContext(ctx:AppContext):DataContext {
  const {accounts,claudeGauge,grokGauge,cycles,plans,plansCatalog,rootDir,codexDiscovery,vendorDiscovery,identityRevision,eraErrors}=ctx;
  return {accounts,claudeGauge,grokGauge,cycles,plans,plansCatalog,rootDir,codexDiscovery,vendorDiscovery,identityRevision,eraErrors,
    subHomes:[...ctx.subIdToHomes]};
}
export interface DataEnvelope {status:number;body:unknown;headers:[string,string][]}
/** Clock-dependent presentation of a kept body. Declared hooks own their own view. */
export function presentDataView(view:DataView,envelope:DataEnvelope,nowMs=Date.now()):DataEnvelope {
  if(view.present) return {...envelope,body:view.present(envelope.body,nowMs)};
  const preparedMs=preparedAtMs(envelope.headers);
  // Only views whose preparation actually used the clock are presented generically;
  // a view that declared preparationClock:false keeps its builder's own wording.
  return !view.clock || view.preparationClock===false || preparedMs===null || nowMs===preparedMs
    ? envelope : {...envelope,body:presentClockFields(envelope.body,nowMs,preparedMs)};
}
/**
 * Builds a view from the current rows. A view that reads the clock records its build instant, so a
 * kept answer (data-read.ts) presents ages and countdowns from it (`presentDataView`).
 */
export async function buildDataView(ctx:AppContext,url:URL,nowMs=Date.now()):Promise<DataEnvelope> {
  const view=DATA_VIEWS[url.pathname];
  if(!view)throw new Error(`Unregistered data view: ${url.pathname}`);
  const response=await view.build(ctx,url);
  const headers=[...response.headers] as [string,string][];
  if(view.clock)headers.push([PREPARED_AT_HEADER,new Date(nowMs).toISOString()]);
  return {status:response.status,body:await response.json(),headers};
}
export function dataViewResponse(envelope:DataEnvelope,state:string):Response {
  return Response.json(envelope.body,{status:envelope.status,headers:{...Object.fromEntries(envelope.headers),"X-Analysis":state,"X-Cache":state==="memory"?"hit":"miss"}});
}
export function dataConfigurationStamp(ctx:AppContext,includeClock=true):string {
  const {identityRevision:_notificationRevision,vendorDiscovery,...configuration}=snapshotDataContext(ctx);
  return analysisHash([CODEX_CANONICAL_COPY_POLICY,ctx.rateCards,timelineMarkerFilesStamp(),{...configuration,vendorDiscovery:vendorDiscoveryIdentity(vendorDiscovery)},[...ctx.homeToSubId],loadProjects(),projectCapacityConfiguration(),includeClock?Math.floor(Date.now()/60000):null]);
}

/** The remaining API surface has an explicit reason to bypass report preparation. */
export const DIRECT_DATA_ROUTES:Readonly<Record<string,string>>={
  "/api/cycle-breakdowns":"bounded transport of canonical cycle-breakdown stored answers; no separate report or dependency",
  "/api/subscription-rate":"stored rows (shared subscription capacities); no report preparation",
  '/api/project-plan':'stored rows (canonical daily project traffic and shared subscription capacities); no report preparation',
  "/api/app-activity":"bounded live preparation metadata; no report preparation or response cache",
  "/api/credit-notices":"stored notice rows (credit-notice producer) and the user's acknowledgement",
  "/api/claude-login":"in-memory sign-in state and the user's start of the Claude Code sign-in (claude-login.ts); reads no data",
  "/api/usage-series":"stored rows (limit windows, window usage), built in a worker (direct-read.ts); a window screen (window-screens.ts)",
  "/api/windows":"stored rows (limit windows, window usage, one read of the account's probe readings), built in a worker (direct-read.ts); a window screen (window-screens.ts)",
  "/api/roster":"stored rows (current cards, limit windows, window usage, probe readings), built in a worker (direct-read.ts); no report preparation; kept per data stamp and minute",
  "/api/subscription-accounting":"stored rows (register days, limit windows, window usage); a window screen (window-screens.ts)",
  "/api/global-usage":"stored rows (register days of both ledgers); no report preparation",
  "/api/events":"bounded, paginated source detail",
  "/api/bootstrap":"current projection snapshot",
  "/api/revisions":"small revision metadata",
  "/api/account-state":"latest provider readings and explicit probe action",
  "/api/probe-notices":"stored rows (one read of the published current cards' probe health); no report preparation",
  "/api/account-periods":"account and plan periods with the owner's declarations file",
  "/api/sync":"live process status and explicit sync action",
  "/api/analysis/rebuild":"explicit source rebuild; its last phase waits for the derived registers",
  "/api/manual-capacity":"explicit manual capacity measurement storage",
  "/api/window-end-overrides":"explicit window end-cause corrections storage",
  "/api/index-snapshot":"snapshot operation/status",
  "/api/rate-cards":"configuration",
  "/api/codex-pricing":"configuration",
  "/api/codex-ledger-settings":"configuration of the shared Codex price ledger",
  "/api/setup":"configuration and local source discovery",
  "/api/setup/database":"explicit local database relocation and its status",
  "/api/setup/directory":"user-invoked native directory picker",
  "/api/setup/confirm":"explicit first-run confirmation of the folders; releases a fresh database's first import",
  "/api/setup/temporary":"explicit local temporary directory configuration",
  "/api/setup/cloud-sessions":"explicit local Claude cloud session interval and its last run",
  "/api/source-profile":"focused local source configuration",
  "/api/source-folders":"user-requested local directory metadata",
  "/api/plans":"configuration",
  "/api/plans-catalog":"configuration",
  "/api/grok-anchor":"configuration",
  "/api/projects/assign":"mutation",
  "/api/projects/merge":"mutation",
  "/api/projects/reassign":"mutation",
  "/api/projects/remap":"mutation",
  "/api/projects/update":"mutation",
};

/**
 * Answers a view that reads stored rows (plan U4.4): built on this request, never remembered, never
 * queued. A row still being prepared answers the preparation receipt; every answer names the version of
 * the stored rows it was read from.
 */
export async function serveDataView(ctx:AppContext,url:URL):Promise<Response> {
  const view=DATA_VIEWS[url.pathname];
  if(!view)throw new Error(`Unregistered data view: ${url.pathname}`);
  const version=dataVersion(ctx.sqlite,{capacityCycles:view.sources.includes("capacity_cycle_results"),firstTokenTimes:view.sources.includes("response_time_hours"),contextPrices:contextRequested(url) ? url.pathname : false});
  let response:Response;
  try { response=await view.build(ctx,url); }
  catch(error) {
    if(error instanceof ProbeAccountIndexUnavailable || error instanceof SubscriptionFactsPending || error instanceof CodexLedgerNotReady)
      response=preparingRows();
    else throw error;
  }
  response.headers.set(DATA_VERSION_HEADER,version);
  return response;
}
