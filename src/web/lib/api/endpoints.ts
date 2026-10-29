import type { AccountPeriodsView, PeriodEdit, PeriodEditPreview, PeriodEditResult } from "../../../shared/account-periods";
import type { ClaudeLoginResponse, ClaudeLoginView } from "../../../shared/claude-login";
import type { ArchiveMoveStatus } from "../../../shared/archive-move";
import type { CloudSessionsResponse } from "../../../shared/cloud-sessions";
import type { CodexPricingEdit, CodexPricingSettings } from "../../../shared/codex-pricing-settings";
import type { CreditNoticeView } from "../../../shared/credit-notices";
import type { MissingRateSummary } from "../../../shared/missing-rate";
import type { ProbeNoticesResponse } from "../../../shared/probe-error";
import type { SourceHealthResponse, SourceProfileConfiguration, SourceProfileEdit } from "../../../shared/source-health";
import type { AccountHistoryResponse, AccountsResponse, AccountStateResponse, ClaudeLimitResponse, RosterResponse, VendorId } from "./accounts";
import type { ProjectCostResponse } from "./project-cost";
import type { ApiProject, AssignRequest, MergeRequest, MergeResponse, ProjectsResponse, ProjectUpdateRequest, ProjectUpdateResponse, ReassignRequest, ReassignResponse, RemapResult, RepoHistoryResponse, SubjectListResponse, UnassignedRow } from "./projects";
import type { CycleSaveRequest, CycleSaveResponse, CyclesResponse, GrokAnchorResponse, GrokAnchorSaveRequest, HistoryCoverageResponse, PlanCapacityResult, PlanSaveRequest, PlansCatalog, PlansCatalogResponse, PlanSettingRow, PlansResponse, RateCardsResponse } from "./settings";
import type { HealthResponse, SetupSaveRequest, SetupSaveResponse, SetupState } from "./setup";
import type { AnalysisRebuildJob, AnalysisRebuildOptions, AnalysisRebuildScope, SyncStatus } from "./sync";
import { fetchJson, get, indexSnapshotRequest, post, readRefreshPaths, syncRequestPath } from "./transport";
import { publishDisplayPlanCatalog } from "../plan-catalog";
import type { ActivityResponse, BreakdownRow, CycleBreakdownResponse, EventsResponse, UsageSeries, WindowsResponse } from "./usage";

const windowAccountsQuery = (provider: string, accounts: readonly string[]) =>
  new URLSearchParams([["provider", provider], ...accounts.map((account) => ["account", account] as [string, string])]).toString();
let catalogWrites = 0;

export const api = {
  health: () => get<HealthResponse>("/api/health"),
  projectPlan:(project:string|undefined,plans:readonly string[],signal?:AbortSignal)=>get<import('../../../shared/project-plan').ProjectPlanResponse>('/api/project-plan',{project,plans:plans.join(',')},signal),
  missingRates: () => get<MissingRateSummary>("/api/missing-rates"),
  creditNotices: () => get<{ notices: CreditNoticeView[] }>("/api/credit-notices"),
  acknowledgeCreditNotices: (ids: number[]) => post<{ acknowledged: number }>("/api/credit-notices", { ids }),
  /** Accounts whose limit readings stopped for a reason the user fixes (expired sign-in, another account). */
  probeNotices: () => get<ProbeNoticesResponse>("/api/probe-notices"),
  /** "Connect Claude": this computer's name and the Claude Code sign-ins started from it. */
  claudeLogins: () => get<ClaudeLoginResponse>("/api/claude-login"),
  /** Starts the official Claude Code sign-in for a subscription's profile on this computer. */
  claudeLoginStart: (subject: string) => post<{ login: ClaudeLoginView }>("/api/claude-login", { subject }),
  accounts: (signal?: AbortSignal) => get<AccountsResponse>("/api/accounts", undefined, signal),
  accountPeriods: () => get<AccountPeriodsView>("/api/account-periods"),
  previewPeriodEdit: (edit: PeriodEdit) => post<PeriodEditPreview>("/api/account-periods", { ...edit, preview: true }),
  savePeriodEdit: (edit: PeriodEdit) => post<PeriodEditResult>("/api/account-periods", edit),
  /** Which days of each priced subscription's traffic have no plan price (the Projects screen's "no plan price"). */
  planPriceCoverage: (signal?: AbortSignal) =>
    get<import("../../../shared/plan-price-coverage").PlanPriceCoverage>("/api/plan-price-coverage", undefined, signal),
  /** Every account's stored billing cycles (Settings → Accounts); `stale` while the background producer catches up. */
  billingCycles: (signal?: AbortSignal) =>
    get<import("../../../shared/billing-cycles").BillingCyclesView>("/api/billing-cycles", undefined, signal),
  /** One account's stored cycles; an account the producer has not filled yet comes back without cycles, `stale` while work is due. */
  billingCyclesOf: (provider: string, account: string, signal?: AbortSignal) =>
    get<import("../../../shared/billing-cycles").BillingCyclesAccount>("/api/billing-cycles", { provider, account }, signal),
  /** `bounds`: one closed window or counter segment from the rail; without them the live window. */
  claudeLimit: (account?: string, bounds?: { from: string; until: string } | null, signal?:AbortSignal) => {
    const params = new URLSearchParams();
    if (account) params.set("account", account);
    if (bounds) { params.set("from", bounds.from); params.set("until", bounds.until); }
    const query = params.toString();
    return get<ClaudeLimitResponse>(`/api/claude-limit${query ? `?${query}` : ""}`,undefined,signal);
  },
  claudeLimitCard: (account?: string, bounds?: { from: string; until: string } | null, signal?:AbortSignal) => {
    const params = new URLSearchParams();
    if (account) params.set("account", account);
    if (bounds) { params.set("from", bounds.from); params.set("until", bounds.until); }
    const query = params.toString();
    return get<ClaudeLimitResponse>(`/api/claude-limit-card${query ? `?${query}` : ""}`,undefined,signal);
  },
  rateCards: () => get<RateCardsResponse>("/api/rate-cards"),
  saveRateCard: (p: { vendor: string; model: string; rates?: Record<string, number | null>; codex_speed?: { credit_multiplier: number; api_multiplier?: number; valid_from: string } }) =>
    post<RateCardsResponse>("/api/rate-cards", p),
  /** A vendor's long-context premium, saved alone; the ledger revalues its long requests in the background. */
  saveVendorContextPremium: (p: { vendor: string; long_context_premium: boolean }) => post<RateCardsResponse>("/api/rate-cards", p),
  codexAccounting: (p: { since: string; until: string; account?: string; project?: string; window_minutes?: 300 | 10080 | 43200; reference_day?: string; detail_cycle?: string }, signal?:AbortSignal) =>
    get<import("../../../shared/codex-accounting").CodexAccountingReport>("/api/codex-accounting", p,signal),
  capacityCycles: (p: { since: string; until: string; window_minutes: 300 | 10080 | 43200 }, signal?: AbortSignal) =>
    get<import("../../../shared/capacity-cycles").CapacityCyclesResponse>("/api/capacity-cycles", p, signal),
  codexCapacity: (p: { since: string; until: string; account: string; window_minutes?: 300 | 10080 | 43200 }, signal?: AbortSignal) =>
    get<import("../../../shared/codex-capacity").CodexCapacityReport>("/api/codex-capacity", p, signal),
  codexCapacityRange: (p: { account: string; window_minutes?: 300 | 10080 | 43200 }, signal?: AbortSignal) =>
    get<import("../../../shared/codex-capacity").CodexCapacityRange>("/api/codex-capacity-range", p, signal),
  modelCapacity: (p: { provider: string; account: string; counter?: string; since: string; until: string }, signal?: AbortSignal) =>
    get<import("../../../shared/model-capacity").ModelCapacityResponse>("/api/model-capacity", p, signal),
  modelUsageShare: (p: { provider: string; account: string; counter?: string; since: string; until: string; window?: string }, signal?: AbortSignal) =>
    get<import("../../../shared/model-usage-share").ModelUsageShareResponse>("/api/model-usage-share", p, signal),
  subscriptionAccounting: (p: { provider: string; since: string; until: string; account?: string; project?: string; counter?: string; reference_day?: string; detail_cycle?: string }, signal?:AbortSignal) =>
    get<import("../../../shared/subscription-accounting").SubscriptionAccountingReport>("/api/subscription-accounting", p,signal),
  manualCapacity: (provider: string, account: string) =>
    get<import("../../../shared/manual-capacity").ManualCapacityStore>("/api/manual-capacity", { provider, account }),
  saveManualCapacity: (provider: string, account: string, body: { revision: string; measurement?: import("../../../shared/manual-capacity").ManualCapacityInput; remove?: string }) =>
    post<import("../../../shared/manual-capacity").ManualCapacityStore>(`/api/manual-capacity?${new URLSearchParams({ provider, account })}`, body),
  windowEndOverrides: (provider: string, accounts: readonly string[], signal?: AbortSignal) =>
    get<import("../../../shared/window-end-overrides").AccountWindowEnds>(`/api/window-end-overrides?${windowAccountsQuery(provider, accounts)}`, undefined, signal),
  saveWindowEndOverride: (provider: string, accounts: readonly string[], body: import("../../../shared/window-end-overrides").WindowEndOverrideInput) =>
    post<import("../../../shared/window-end-overrides").AccountWindowEnds>(`/api/window-end-overrides?${windowAccountsQuery(provider, accounts)}`, body),
  subscriptionTimelineMarkers: (provider: string) =>
    get<import("../../../shared/codex-accounting").TimelineMarkersResponse>("/api/subscription-timeline-markers", { provider }),
  saveSubscriptionTimelineMarker: (provider: string, p: { revision: string; marker?: import("../../../shared/codex-accounting").TimelineMarker; remove?: string }) =>
    post<import("../../../shared/codex-accounting").TimelineMarkersResponse>("/api/subscription-timeline-markers?provider=" + encodeURIComponent(provider), p),
  codexTimelineMarkers: () => get<import("../../../shared/codex-accounting").TimelineMarkersResponse>("/api/codex-timeline-markers"),
  saveCodexTimelineMarker: (p: { revision: string; marker?: import("../../../shared/codex-accounting").TimelineMarker; remove?: string }) =>
    post<import("../../../shared/codex-accounting").TimelineMarkersResponse>("/api/codex-timeline-markers", p),
  roster: (p?: { window?: number }) => get<RosterResponse>("/api/roster", p),
  accountHistory: (p?: { group?: string; since?: string; until?: string }, signal?:AbortSignal) =>
    get<AccountHistoryResponse>("/api/account-history", p,signal),
  claudeAccountSplits: (p: { since: string; until: string }, signal?:AbortSignal) =>
    get<import("../../../shared/claude-code-capacity").ClaudeAccountSplitsResponse>("/api/claude-account-splits", p,signal),
  globalUsage: (p: { since: string; until: string }, signal?:AbortSignal) =>
    get<import("../../../shared/global-usage").GlobalUsageResponse>("/api/global-usage", p,signal),
  modelCacheHistory: (p: { account: string; model: string; since?: string; until: string }, signal?: AbortSignal) =>
    get<import("../../../shared/codex-window-detail").CodexModelCacheHistory>("/api/model-cache-history", p, signal),
  windowProjects: (p: { account: string; from: string; until: string }, signal?: AbortSignal) =>
    get<import("../../../shared/window-projects").WindowProjectsResponse>("/api/window-projects", p, signal),
  accountState: () => get<AccountStateResponse>("/api/account-state"),
  usageSeries: (p: { account: string; window?: number; limit_id?: string; points?: number; since?: string; until?: string }, signal?:AbortSignal) =>
    get<UsageSeries>("/api/usage-series", p,signal),
  windows: (p: { account: string }, signal?:AbortSignal) => get<WindowsResponse>("/api/windows", p,signal),
  cycles: () => get<CyclesResponse>("/api/cycles"),
  cyclesSave: (body: CycleSaveRequest) => post<CycleSaveResponse>("/api/cycles", body),
  plans: (asOf?: string) => get<PlansResponse>("/api/plans", { as_of: asOf }),
  plansSave: (body: PlanSaveRequest) => post<{ ok: true; rows: PlanSettingRow[] }>("/api/plans", body),
  historyCoverage: (subscription?: string, signal?: AbortSignal) =>
    get<HistoryCoverageResponse>("/api/history-coverage", { subscription }, signal),
  codexPricing: () => get<CodexPricingSettings>("/api/codex-pricing"),
  saveCodexPricing: (body: CodexPricingEdit) => post<CodexPricingSettings>("/api/codex-pricing", body),
  plansCatalog: async () => {
    const writes = catalogWrites;
    const response = await get<PlansCatalogResponse>("/api/plans-catalog");
    if (writes === catalogWrites) publishDisplayPlanCatalog(response.catalog);
    return response;
  },
  plansCatalogSave: (body: PlansCatalog | { catalog: PlansCatalog }) =>
    post<PlansCatalogResponse>("/api/plans-catalog", "catalog" in body ? body : { catalog: body }).then(response => {
      catalogWrites++;
      publishDisplayPlanCatalog(response.catalog);
      return response;
    }),
  planCapacity: (p: { provider: string; plan_id: string; window_kind: string; as_of?: string }) =>
    get<PlanCapacityResult>("/api/plan-capacity", p),
  setup: () => get<SetupState>("/api/setup"),
  saveTemporaryDirectory: (directory: string) => post<{root:string}>("/api/setup/temporary", { directory }),
  cloudSessions: () => get<CloudSessionsResponse>("/api/setup/cloud-sessions"),
  saveCloudSessionsMinutes: (minutes: number) => post<CloudSessionsResponse>("/api/setup/cloud-sessions", { minutes }),
  relocateDatabaseToFolder: (directory: string) => post<{destination:string}>("/api/setup/database", { directory }),
  chooseArchiveDirectory: () => post<{path:string|null}>("/api/setup/directory", {}),
  relocateDatabase: (destination: string) => post<{ destination: string }>("/api/setup/database", { destination }),
  archiveMove: (signal?: AbortSignal) => get<ArchiveMoveStatus>("/api/setup/archive-move", undefined, signal),
  startArchiveMove: (directory: string) => post<ArchiveMoveStatus>("/api/setup/archive-move", { directory }),
  databaseLocation: (signal?: AbortSignal) => get<{ database: string; result: { destination: string; error: string | null } | null }>("/api/setup/database", undefined, signal),
  setupStatus: () => get<Pick<SetupState, "configured"> & { locations_confirmed?: boolean }>("/api/setup", { summary: 1 }),
  confirmLocations: () => post<{ ok: true; locations_confirmed: boolean }>("/api/setup/confirm", {}),
  sourceHealth: (signal?:AbortSignal) => get<SourceHealthResponse>("/api/source-health",undefined,signal),
  sourceProfiles: (discover?: string,signal?:AbortSignal) => get<SourceProfileConfiguration>("/api/source-profile", { discover },signal),
  sourceFolders: (path?: string) => get<import("../../../shared/source-folders").SourceFolderListing>("/api/source-folders", { path }),
  saveSourceProfile: (body: SourceProfileEdit) => post<SetupSaveResponse>("/api/source-profile", body),
  setupSave: (body: SetupSaveRequest) => post<SetupSaveResponse>("/api/setup", body),
  grokAnchor: () => get<GrokAnchorResponse>("/api/grok-anchor"),
  grokAnchorSave: (body: GrokAnchorSaveRequest) => post<GrokAnchorResponse>("/api/grok-anchor", body),
  breakdown: (p: {
    dim: string;
    vendor?: string;
    account?: string;
    since?: string;
    until?: string;
    since_ts?: string;
    until_ts?: string;
    project_id?: string;
  },signal?:AbortSignal) =>
    get<{ rows: BreakdownRow[]; [k: string]: unknown }>("/api/breakdown", p,signal),
  summary: (p: { group?: string; vendor?: string; since?: string; until?: string; project_id?: string }) =>
    get<{ rows: Record<string, unknown>[]; [k: string]: unknown }>("/api/summary", p),
  activity: (p?: { vendor?: string; account?: string; since?: string; until?: string; project_id?: string },signal?:AbortSignal) =>
    get<ActivityResponse>("/api/activity", p,signal),
  modelSpeed: (p: { account: string; since?: string; until?: string; grain?: "day" | "hour" }, signal?: AbortSignal) =>
    get<import("../model-speed").ModelSpeedResponse>("/api/model-speed", p, signal),
  subscriptionRate: (account?:string,signal?:AbortSignal) => get<import("../../../shared/subscription-rate").SubscriptionRateResponse>("/api/subscription-rate",{account},signal),
  cycleBreakdown: (p: {
    account: string;
    since_ts: string;
    until_ts: string;
    anchor?: number;
    limit_id?: string;
    session_window?: number;
    project_id?: string;
    end_inclusive?: boolean;
  }, signal?: AbortSignal, batchCycle = false) => get<CycleBreakdownResponse>("/api/cycle-breakdown", { ...p, end_inclusive: p.end_inclusive ? "true" : undefined, valuation: "dated" }, signal, { reuseSettled: true, batchCycle }),
  events: (p?: {
    conversation?: "1";
    vendor?: string;
    account?: string;
    since?: string;
    until?: string;
    /** Exact bounds `[from_ts, until_ts)` in UTC; never combined with since/until. */
    from_ts?: string;
    until_ts?: string;
    model?: string;
    project?: string;
    project_id?: string;
    order?: string;
    limit?: number;
    offset?: number;
  }, signal?: AbortSignal) => get<EventsResponse>("/api/events", p, signal),
  conversationCourse: (p: import("../../../shared/conversation-course").ConversationRef & { context?: "1" }, signal?: AbortSignal) =>
    get<import("../../../shared/conversation-course").ConversationCourse>("/api/conversation-course", { ...p }, signal),
  subjects: (p?: { idle_gap?: number; since?: string; until?: string }) =>
    get<SubjectListResponse>("/api/repo-history", p),
  projectCost: (p?: { since?: string; until?: string }, signal?: AbortSignal) =>
    get<ProjectCostResponse>("/api/project-cost", p, signal),
  repoHistory: (p: {
    repo?: string;
    project?: string;
    granularity?: "day" | "week" | "month";
    by?: "none" | "vendor" | "model" | "account";
    idle_gap?: number;
    since?: string;
    until?: string;
  }) => get<RepoHistoryResponse>("/api/repo-history", p),
  projects: () => get<ProjectsResponse>("/api/projects"),
  projectsUnassigned: (p?: { limit?: number; q?: string }) =>
    get<{ total: number; total_unfiltered: number; query: string; rows: UnassignedRow[] }>(
      "/api/projects/unassigned",
      p,
    ),
  projectsAssign: (body: AssignRequest) => post<{ ok: true; project: ApiProject; incremental: true; remap: null }>("/api/projects/assign", body),
  projectsRows: (p: { project_id: string; limit?: number; q?: string }) =>
    get<{ project_id: string | null; total: number; total_unfiltered: number; query: string; rows: UnassignedRow[] }>(
      "/api/projects/rows",
      p,
    ),
  projectsReassign: (body: ReassignRequest) => post<ReassignResponse>("/api/projects/reassign", body),
  projectsUpdate: (body: ProjectUpdateRequest) => post<ProjectUpdateResponse>("/api/projects/update", body),
  projectsMerge: (body: MergeRequest) => post<MergeResponse>("/api/projects/merge", body),
  projectsRemap: () => post<{ ok: true; remap: RemapResult }>("/api/projects/remap"),
  syncStatus: (signal?: AbortSignal, cursor?: number) => get<SyncStatus>("/api/sync", {
    read_cursor: cursor, read_paths: readRefreshPaths(),
  }, signal),
  analysisRebuildStatus: (signal?: AbortSignal) => fetchJson<{job:AnalysisRebuildJob|null}>(new URL("/api/analysis/rebuild", window.location.origin), signal),
  rebuildAnalysis: (selection: AnalysisRebuildScope | AnalysisRebuildOptions) => post<{ok:true;generation:number;job:AnalysisRebuildJob}>("/api/analysis/rebuild", typeof selection === "string" ? {scope:selection} : selection),
  resumeAnalysis: () => post<{ok:true;generation:number;job:AnalysisRebuildJob}>("/api/analysis/rebuild", {action:"resume"}),
  syncStart: (mode: "incremental" | "full" = "incremental", vendor?: VendorId) =>
    post<SyncStatus>(syncRequestPath(mode, vendor)),
  indexSnapshotStatus: () => indexSnapshotRequest("GET"),
  indexSnapshotCreate: () => indexSnapshotRequest("POST"),
};
