import { publishVendorFirstFill } from "./vendor-first-fill";
import { publishVendorDelta } from "./vendor-delta-publication";
import type { ValidationStep, VendorTelemetry } from "./vendor-progress";
import { VALIDATION_LABELS } from "./vendor-progress";
import { Database } from "../db/sqlite";
import type { DeltaIdentity } from "./vendor-publication-schema";
import { vendorIdentityFingerprints, DELTA_SPECS, VENDOR_TABLES } from "./vendor-publication-schema";
import { validateReparse, reparseIdentities } from "./reparse";
import { retainClaudeUnreadOwners, retainClaudeIdentityEvidence, validateStage } from "./incremental-stage";
import { REMAPPED_TABLES, storedFingerprint, recordPublishedProjectRules } from "../projects/remap";
import { collectDeltaIdentities, identityKey } from "./publication-identities";
import { readAccountsV2 } from "../config/accounts-document";
import { configFile, ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { publishAppendDelta } from "./gauge-publication";
import { unavailableSourceImpact, unchangedSourceImpact } from "./source-impact";
import type { VendorId, SyncRunResult } from "./contracts";
import type { SyncCoordinatorOptions } from "./coordinator-contracts";
import type { SyncStore } from "./store";
import type { ReparseRange } from "./reparse";
import type { SyncPhase } from "../shared/sync-progress";
import type { ProgressRegistry } from "./progress";
import type { PreparedVendorSources } from "./vendor-source-preparation";

export interface PreparedPublicationFacts {
  identities: DeltaIdentity[];
  active: ReturnType<typeof vendorIdentityFingerprints>;
  staged: ReturnType<typeof vendorIdentityFingerprints>;
}

export interface RunPublicationState {
  remappedRows: boolean;
  affected: Map<VendorId, DeltaIdentity[]>;
}

export interface StagePublicationServices {
  sqlite: Database;
  store: SyncStore;
  prepareStage: NonNullable<SyncCoordinatorOptions["prepareStage"]>;
  now: () => string;
  saveRun: (result: SyncRunResult) => void;
  options: Pick<SyncCoordinatorOptions, "beforeIncrementalPublish" | "afterPublishBeforeRevision">;
  queuedFiles: boolean;
}

export interface StagePublicationWork {
  result: SyncRunResult;
  outcome: SyncRunResult["vendors"][number];
  stagePath: string;
  prepared: PreparedVendorSources;
  shouldPublish: boolean;
  priorReparse: unknown;
  forceReparse: ReparseRange | undefined;
  rebuild: boolean;
  publicationState: RunPublicationState;
  saveCompletedSourceBookmark: () => void;
  takeWriteLease: (scope: string) => Promise<void>;
  fence: () => void;
  progress: (phase: SyncPhase, completed: number, vendor?: VendorId) => void;
  progressRegister: Pick<ProgressRegistry, "report">;
  scope: string;
  step: number;
}

export async function publishVendorStage(
  services: StagePublicationServices,
  work: StagePublicationWork,
  telemetry: VendorTelemetry,
): Promise<boolean> {
  const { sqlite, store, prepareStage, now, saveRun } = services;
  const { result, outcome, stagePath, shouldPublish, forceReparse, rebuild,
    publicationState, saveCompletedSourceBookmark, takeWriteLease, fence, progress, progressRegister, scope, step } = work;
  const { firstFill, appendOnly, changedFiles, adapter } = work.prepared;
  const { reparsePlan } = work.prepared;
  const { timings, phase, timingStart, timingEnd, measureTiming, measurePublication, publicationProgress } = telemetry;
  let comparisonStarted: number | undefined;
  const finishComparison = () => {
    timingEnd("comparisonMs", comparisonStarted);
    comparisonStarted = undefined;
  };
  progress("validate", step + 3, outcome.vendor);
  const validationProgress = (operation: ValidationStep, item?: number, items?: number) =>
    progressRegister.report(scope, `validate.${operation}`, VALIDATION_LABELS[operation], "tables", item ?? 0, items ?? null);
  if (adapter.validationErrors.length > 0) throw new Error(adapter.validationErrors.join("; "));
  if (shouldPublish) {
    if (result.scope.kind === "accounts" && !reparsePlan
      && !(appendOnly && result.scope.meters === "archive")) throw new Error("Account publication requires a semantic reparse plan");
    const publishStarted = performance.now();
    const stage = new Database(stagePath);
    let preparedFacts: PreparedPublicationFacts | undefined;
    let validationStarted = timingStart();
    try {
      // Full source rereads use the same bounded cache as report workers;
      // remapping and validation must not churn SQLite's tiny default cache.
      stage.exec("PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY");
      if(reparsePlan) {
        validationProgress("sources");
        validateReparse(stage,DELTA_SPECS[outcome.vendor],reparsePlan);
      }
      if (outcome.vendor === "claude" && !firstFill) {
        validationProgress("identities");
        if (changedFiles) retainClaudeUnreadOwners(sqlite, stage, changedFiles);
        retainClaudeIdentityEvidence(sqlite, stage);
      }
      if (!appendOnly) {
        validationProgress("repos");
        measureTiming("remapMs",()=>prepareStage(stage, update => {
          if (update.phase === "done") return;
          validationProgress(update.phase === "finalize" ? "rules" : update.phase, update.item_index, update.item_count);
        }, VENDOR_TABLES[outcome.vendor].data));
      }
      // The rules the stage was mapped with, recorded with its publication (recordPublishedProjectRules).
      const remapped = VENDOR_TABLES[outcome.vendor].data.some(table => REMAPPED_TABLES.includes(table));
      const stageRules = storedFingerprint(stage);
      const recordProjectRules = () => {
        if (!remapped) return;
        recordPublishedProjectRules(sqlite, stageRules, publicationState.remappedRows);
        publicationState.remappedRows ||= outcome.dataChanged;
      };
      if (!appendOnly && !firstFill && result.scope.kind !== "accounts") {
        const detected = collectDeltaIdentities(sqlite, stage, outcome.vendor, changedFiles);
        const identities = reparsePlan ? reparseIdentities(DELTA_SPECS[outcome.vendor], detected, reparsePlan) : detected;
        preparedFacts = { identities,
          active: vendorIdentityFingerprints(sqlite, outcome.vendor, identities, true, true),
          staged: vendorIdentityFingerprints(stage, outcome.vendor, identities) };
      }
      const acceptedUnchanged = !!preparedFacts && preparedFacts.identities.length > 0
        && preparedFacts.identities.every(identity => {
          const key = identityKey(DELTA_SPECS[outcome.vendor], identity);
          return preparedFacts!.active.cachedIdentities.has(key)
            && preparedFacts!.active.byIdentity.get(key) === preparedFacts!.staged.byIdentity.get(key);
        });
      // A first-fill stage was written by this process moments ago and is never reused after an
      // interruption; checking every page of a multi-GB file cost Codex 40 s.
      validateStage(stage, outcome.vendor, adapter.validationErrors, validationProgress, acceptedUnchanged,measureTiming,!firstFill);
      timingEnd("validationMs", validationStarted);
      validationStarted = undefined;
      await takeWriteLease(scope);
      progress("publish", step + 4, outcome.vendor);
      publicationProgress.report("compare");
      if (appendOnly) {
        if (result.scope.kind === "accounts" && result.scope.meters === "archive") fence();
        const gaugeDeclarations = result.scope.kind === "accounts" && result.scope.meters === "archive"
          ? readAccountsV2(configFile("accounts.json")).sources : undefined;
        const publicationStarted = timingStart();
        const append = () => publishAppendDelta(sqlite, stagePath, (inserted, meters) => {
          publicationProgress.report("commit");
          outcome.dataChanged = inserted > 0;
          outcome.writtenRows = inserted;
          outcome.sourceImpact = inserted > 0
            ? unavailableSourceImpact("append-publication-does-not-expose-a-trustworthy-source-record-diff", true)
            : unchangedSourceImpact();
          outcome.diagnostics = { ...outcome.diagnostics, appended: inserted,
            probeShadowScope: "not-evaluated-global-history" };
          if (meters) outcome.diagnostics.reparse = {
            ...(outcome.diagnostics.reparse as Record<string, unknown> | undefined),
            accountScope: "usage-with-archived-counters", meterDays: meters.days,
            selectedCounters: meters.selectedCounters,
          };
          // Vendor revision only: gauges feed no rollups, and the global
          // data revision is what marks rollup coverage stale.
          result.afterRevisions = inserted > 0
            ? store.advanceVendorInTransaction(outcome.vendor, now())
            : store.revisions();
          outcome.status = "success";
          outcome.finishedAt = now();
          saveCompletedSourceBookmark();
          saveRun(result);
        }, rebuild,
          rebuild && forceReparse
            ? forceReparse
            : undefined, result.scope.kind === "accounts" && result.scope.meters === "archive"
              ? result.scope.accounts : undefined, gaugeDeclarations
                ? { declarations: gaugeDeclarations, archiveRoot: ARCHIVE_LOGICAL_ROOT, defaultLogin: LOGIN }
                : undefined,firstFill ? elapsed => {timings.indexBuildMs=elapsed;} : undefined,measurePublication);
        publicationProgress.report("write");
        try {
          append();
        }
        finally { timingEnd("publicationMs", publicationStarted); }
      } else if (firstFill) {
        publishVendorFirstFill(services, work, telemetry, stage, recordProjectRules);
      } else {
        publishVendorDelta(services, work, telemetry, { stage, preparedFacts, recordProjectRules,
          startComparison: () => { comparisonStarted = timingStart(); }, finishComparison });
      }
    } finally {
      timingEnd("validationMs", validationStarted);
      finishComparison();
      stage.close();
      phase("publishMs", publishStarted);
    }
    return true;
  } else {
    if (result.scope.kind === "accounts") outcome.diagnostics = {...outcome.diagnostics,reparse:{
      ...(outcome.diagnostics.reparse as Record<string, unknown>),
      ...(outcome.vendor === "gauges" && result.scope.meters === "archive"
        ? {meterDays:[], selectedCounters:0, accountScope:"usage-with-archived-counters"}
        : {selectedDays:[],accountScope:"usage-with-existing-meters"})}};
    outcome.status = "success";
    outcome.sourceImpact = unchangedSourceImpact();
    outcome.finishedAt = now();
    saveCompletedSourceBookmark();
  }
  return false;
}
