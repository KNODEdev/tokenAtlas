import type { ReadRefreshCheck } from "../../../shared/read-refresh";
import type { UsageVendorId, VendorId } from "./accounts";

export type AnalysisRebuildScope = import("../../../shared/analysis-rebuild").RebuildScope;
export type AnalysisRebuildOptions = import("../../../shared/analysis-rebuild").RebuildOptions;
export type AnalysisRebuildJob = {
  generation: number; scope: AnalysisRebuildScope; range: {from:string;until:string} | null;
  mode?: import("../../../shared/analysis-rebuild").RebuildMode;
  vendors?: VendorId[];
  accounts?: import("../../../shared/rebuild-accounts").RebuildAccount[];
  meters?: "archive";
  timeBounds?: {from:string;untilExclusive:string} | null;
  requestedAt?: string;
  state: "queued" | "running" | "complete" | "error"; error: string | null;
  phase?: "sources" | "summaries" | "reports"; completed?:number; total?:number; warnings?:string[];
};
export interface SyncRunResult {
  rebuildGeneration?: number;
  progress?: import("../../../shared/sync-progress").SyncProgress;
  runId: string;
  ownerPid?: number;
  trigger: "manual" | "auto" | "cli";
  scope: { kind: "all" } | { kind: "vendor"; vendor: VendorId } | { kind: "vendors"; vendors: VendorId[] }
    | { kind: "accounts"; accounts: import("../../../shared/rebuild-accounts").RebuildAccount[]; meters?: "archive" };
  mode: "incremental" | "full";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial_success" | "failure";
  beforeRevisions: { data: number; config: number; vendors: Record<VendorId, number> };
  afterRevisions: { data: number; config: number; vendors: Record<VendorId, number> };
  changedConfigDomains?: Array<
    | "accounts"
    | "rate-cards"
    | "projects"
    | "cycles"
    | "plans"
    | "plans-catalog"
    | "claude-gauge"
    | "grok-gauge"
  >;
  aggregateWorkRequested: boolean;
  vendors: Array<{
    vendor: VendorId;
    status: "pending" | "success" | "failure";
    processedInputs: number;
    skippedInputs: number;
    writtenRows: number;
    dirtyRange: { from: string; to: string } | null;
    dataChanged: boolean;
    error: string | null;
    diagnostics: Record<string, unknown>;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  error: string | null;
}
export type AtlasBootstrapStage =
  | "local-check"
  | "snapshot-discovery"
  | "snapshot-validation"
  | "snapshot-installation"
  | "migration"
  | "path-rebase"
  | "incremental-catch-up"
  | "full-ingest-fallback"
  | "complete";
type AtlasBootstrapAttempt = {
  snapshotId: string | null;
  accepted: boolean;
  stage: "discovery" | "validation" | "copy" | "migration" | "rebase" | "integrity" | "installation" | null;
  code:
    | "snapshot-pool-read-failed"
    | "snapshot-validation-failed"
    | "snapshot-copy-failed"
    | "snapshot-migration-failed"
    | "snapshot-rebase-failed"
    | "snapshot-integrity-failed"
    | "snapshot-installation-failed"
    | null;
  reason: string | null;
};
type AtlasSnapshotRevisions = { data: number; config: number; derived: number };
export interface AtlasIndexSnapshotManifest {
  manifestVersion: 2;
  kind: "tokenatlas-index";
  snapshotId: string;
  schemaVersion: number;
  revisions: AtlasSnapshotRevisions;
  vendorDataRevisions: Record<UsageVendorId, number>;
  sourceArchiveRoot: string;
  sourceMachine: string;
  createdAt: string;
  sizeBytes: number;
  checksum: { algorithm: "sha256"; value: string };
  vendorRowCounts: Record<UsageVendorId, number>;
  identityFingerprint: string;
}
type AtlasSnapshotValidation = {
  valid: boolean;
  compatible: boolean;
  manifest: AtlasIndexSnapshotManifest | null;
  errors: string[];
};
type AtlasSnapshotPublishResult = {
  status: "created" | "reused" | "skipped" | "aborted";
  reason: "identical-snapshot" | "unchanged-data" | "daily-limit" | "lease-lost" | null;
  snapshotId: string | null;
  databasePath: string | null;
  manifestPath: string | null;
  manifest: AtlasIndexSnapshotManifest | null;
  validation: AtlasSnapshotValidation | null;
  leaseLostAfterCommit: boolean;
};
type AtlasNewestValidSnapshot = {
  id: string;
  created_at: string;
  age_seconds: number;
  revisions: AtlasSnapshotRevisions;
  vendor_revisions: Record<UsageVendorId, number>;
  compatible: boolean;
  validation: "manifest-only" | "full";
};
export interface RemapProgress {
  phase: "repos" | "gaps" | "projects" | "finalize" | "done";
  phase_index: number;
  phase_count: number;
  message: string;
  table?: string;
  item_index?: number;
  item_count?: number;
  assigned?: number;
  total?: number;
}
export interface RemapStatus {
  running: boolean;
  why: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  ok: boolean | null;
  log_tail: string[];
  message: string;
  progress: RemapProgress | null;
  tables: Record<
    string,
    { phase: RemapProgress["phase"]; message: string; assigned?: number; total?: number }
  >;
  rows: Record<string, number>;
}
export interface SyncStatus {
  /** Every running stage and background producer, from the server's progress register. */
  progress?: import("../../../shared/progress").ProgressEntry[];
  readings_revision?: number | null;
  identity_revision?: number;
  running: boolean;
  trigger: "manual" | "auto" | "cli" | null;
  mode: "incremental" | "full" | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  ok: boolean | null;
  phase: string | null;
  phase_index: number;
  phase_count: number;
  log_tail: string[];
  remap?: RemapStatus | null;
  completion_id?: string | null;
  revisions?: {
    data: number | null;
    config: number | null;
    derived: number | null;
  };
  read_changes?: ReadRefreshCheck;
  watch?: {
    active: boolean;
    running: boolean;
    followUpPending: boolean;
    reconciliationMs: number;
    debounceMs: number;
    watchedRoots: string[];
    missingRoots: string[];
    errors: string[];
    lastSignalAt: string | null;
    lastReconciledAt: string | null;
  } | null;
  run?: SyncRunResult | null;
  bootstrap?: AtlasBootstrapStatus | null;
  snapshot?: AtlasSnapshotPublicationStatus | null;
}
export interface AtlasBootstrapStatus {
  running: boolean;
  stage: AtlasBootstrapStage | null;
  message: string;
  started_at: string | null;
  finished_at: string | null;
  ok: boolean | null;
  status: "local-ready" | "snapshot-installed" | "full-ingest-required" | null;
  selected_snapshot_id: string | null;
  catch_up_mode: "incremental" | "full" | null;
  attempts: AtlasBootstrapAttempt[];
  changed_path_rows: number;
  cleared_bookmarks: number;
  error: string | null;
}
export type AtlasSnapshotApiManifest = Omit<AtlasIndexSnapshotManifest, "sourceArchiveRoot">;
export interface AtlasSnapshotApiResult extends Omit<
  AtlasSnapshotPublishResult,
  "databasePath" | "manifestPath" | "manifest" | "validation"
> {
  manifest: AtlasSnapshotApiManifest | null;
  validation: (Omit<NonNullable<AtlasSnapshotPublishResult["validation"]>, "manifest"> & {
    manifest: AtlasSnapshotApiManifest | null;
  }) | null;
}
export interface AtlasSnapshotPublicationStatus {
  running: boolean;
  mode: "automatic" | "manual" | null;
  started_at: string | null;
  finished_at: string | null;
  result: AtlasSnapshotApiResult | null;
  error: string | null;
}
export interface AtlasSnapshotStatus extends AtlasSnapshotPublicationStatus {
  newest_valid: AtlasNewestValidSnapshot | null;
  discovery_error: { code: string; stage: string } | null;
}
export function syncRevisionKey(status: SyncStatus): string | null {
  const revisions = status.revisions;
  if (!revisions) return null;
  if (revisions.data == null && revisions.config == null && revisions.derived == null) return null;
  return `${revisions.data ?? "legacy"}:${revisions.config ?? "legacy"}:${revisions.derived ?? "legacy"}`;
}
export function syncRevisionDecision(
  previous: string | undefined,
  status: SyncStatus
): { revision: string | undefined; refresh: boolean } {
  if (status.running || status.remap?.running) return { revision: previous, refresh: false };
  const revision = syncRevisionKey(status);
  if (revision == null) return { revision: previous, refresh: false };
  if (previous === undefined) return { revision, refresh: false };
  return { revision, refresh: revision !== previous };
}
export function readingsRevisionDecision(previous: number | undefined, status: SyncStatus) {
  const revision = status.readings_revision;
  if (revision == null) return { revision: previous, refresh: false };
  return { revision, refresh: previous !== undefined && revision !== previous };
}
export function syncRunChanged(status: SyncStatus): boolean {
  const run = status.run;
  return Boolean(
    run &&
      run.status !== "running" &&
      (run.beforeRevisions.data !== run.afterRevisions.data ||
        run.beforeRevisions.config !== run.afterRevisions.config)
  );
}
