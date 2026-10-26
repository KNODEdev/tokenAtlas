import { initializeArchiveWriterIdentity } from "../sync/archive-writers";
import { startServer } from "./server-lifecycle";

// Public API and executable entry remain stable for scripts, workers and integrations.
export {periodEras,subscriptionMaps} from './subscription-maps';
export { subscriptionDailyUsage } from "./subscription-usage";
export { rebuildSubscriptionMaps, createAppContext, reloadAppContextConfiguration } from "./app-context";
export type { AppContext } from "./app-context-types";
export { resolveSubscription } from "./account-scope";
export { parseCommonDateParams } from "./api-request-params";
export { handleSummary, handleBreakdown, handleCompare, handleCache, handleLeverage } from "./api-summary";
export { handleGauge } from "./api-gauge";
export { collectHealthUnpriced, handleProbeNotices, handleMissingRates, handleHealth, handlePlanHealth } from "./api-health";
export type { HealthUnpricedItem } from "./api-health";
export { activitySubscriptionAt, machineForActivitySource, buildIdentityReport, observedVendorAccounts } from "./account-identity";
export type { IdentitySource, IdentityWarning, IdentityReport } from "./account-identity";
export { handleRateCardsSave, handleRateCards } from "./api-rates";
export { handleAccounts } from "./api-accounts";
export type { AccountEntry } from "./api-accounts";
export { cycleElapsedMs, handleUsageSeries, serveSubscriptionAccounting } from "./api-usage-series";
export { handleClaudeAccountSplits, handleWindows } from "./api-window-rail";
export { handleEvents } from "./api-events";
export { handleProjectCost, handlePlanPriceCoverage, handleBillingCycles, handleRepoHistory, handleProjects, handleProjectsRows, handleProjectsAssign, handleProjectsReassign, handleProjectsUpdate, handleProjectsMerge } from "./api-projects";
export { handleActivity, handleModelSpeed } from "./api-activity";
export { handleCycleBreakdown } from "./api-cycle-breakdown";
export type { CycleDay, CycleSession } from "./api-cycle-breakdown";
export { syncPhaseFromLine, isIndexEmpty, needsRemap, resolvedSyncRunnerEnvironment, runSyncProcess, advanceAnalysisRebuildSources, startSync } from "./server-sync";
export type { SyncState, SyncRevisionState, SyncProcessRunner } from "./server-sync";
export { getAtlasBootstrapState } from "./server-bootstrap";
export type { AtlasBootstrapState } from "./server-bootstrap";
export { handleIndexSnapshot } from "./api-index-snapshot";
export type { AtlasSnapshotPublicationState } from "./api-index-snapshot";
export { getRemapState, startStartupRemap, handleProjectsRemap } from "./server-remap";
export type { RemapState } from "./server-remap";
export { handleAccountHistory } from "./api-account-history";
export { handleCycles, handleCyclesSave } from "./api-cycle-settings";
export type { CadenceSegmentRow, CycleSettingRow } from "./api-cycle-settings";
export { handlePlans, handlePlansSave, handlePlansCatalog, collectVersionedPlanWindowObservations, handlePlanCapacity, handlePlansCatalogSave } from "./api-plan-settings";
export { handleSetup, handleAccountPeriods, handleSetupSave } from "./api-setup";
export { handleGrokAnchor, handleGrokAnchorSave, handleClaudeLimit } from "./api-provider-limits";
export { currentProbeSubscription, probeSubscriptionGate, probeTargets, runCodexProbePoll, refreshCodexDiscovery, latestAccountState, selectCodexPlanState, handleAccountState, refreshVendorDiscovery } from "./account-probes";
export type { AccountStateRow } from "./account-probes";
export { EMPTY_SUBSCRIPTION_ACTIVITY, subscriptionActivity, subscriptionProbeDays, dayInEra, eraSegmentStats, buildEraTimelines, handleEraTimelines } from "./api-era-timelines";
export type { SubscriptionActivity, EraSegmentStats, EraSegment, SubscriptionEraTimeline, VendorAccountTimeline, EraTimelinesPayload } from "./api-era-timelines";
export { mergeRosterAccounts, handleRoster } from "./api-roster";
export { createFetchHandler } from "./api-router";
export { keepsSocketOpen, startServer } from "./server-lifecycle";
export type { StartServerRuntime } from "./server-lifecycle";

if (import.meta.main) {
  if (!process.argv.includes("--atlas-server-child")) {
    const { superviseServer } = await import("./supervisor");
    process.exit(await superviseServer(import.meta.path));
  } else {
    initializeArchiveWriterIdentity();
    const running = startServer();
    process.once("SIGINT", running.close);
    process.once("SIGTERM", running.close);
  }
}
