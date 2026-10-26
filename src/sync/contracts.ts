import { normalizeRebuildAccounts, normalizeRebuildMeters, type RebuildAccount, type RebuildMeters } from "../shared/rebuild-accounts";

// Transcript vendors: their events feed rollups and the bootstrap snapshot.
export const USAGE_VENDOR_IDS = ["codex", "claude", "opencode", "grok", "gemini"] as const;
// `gauges` is the cross-machine journal of probe samples: append-only rows
// into probe_windows, no rollups, no data revision.
export const VENDOR_IDS = [...USAGE_VENDOR_IDS, "gauges"] as const;
const VENDOR_SET: ReadonlySet<string | null | undefined> = new Set(VENDOR_IDS);

export type UsageVendorId = (typeof USAGE_VENDOR_IDS)[number];
export type VendorId = (typeof VENDOR_IDS)[number];

export function isUsageVendor(vendor: VendorId): vendor is UsageVendorId {
  return USAGE_VENDOR_IDS.some((usage) => usage === vendor);
}
// Request/history label only: "full" selects all existing archive inputs for forced incremental publication.
export type SyncMode = "incremental" | "full";
export type SyncTrigger = "manual" | "auto" | "cli";
export type SyncScope =
  | { kind: "all" }
  | { kind: "vendor"; vendor: VendorId }
  | { kind: "vendors"; vendors: VendorId[] }
  | { kind: "accounts"; accounts: RebuildAccount[]; meters?: RebuildMeters };
export type SyncRunStatus = "running" | "success" | "partial_success" | "failure";
export type VendorSyncStatus = "pending" | "success" | "failure";
export const CONFIG_DOMAINS = [
  "accounts",
  "rate-cards",
  "projects",
  "cycles",
  "plans",
  "plans-catalog",
  "claude-gauge",
  "grok-gauge",
] as const;
export type ConfigDomain = (typeof CONFIG_DOMAINS)[number];

export interface DirtyTimestampRange {
  from: string;
  to: string;
}

export interface RevisionSnapshot {
  data: number;
  config: number;
  vendors: Record<VendorId, number>;
}

export interface ExactSourceImpactMetric {
  status: "available" | "unavailable";
  value: string | null;
  reason: string | null;
}

export interface SourceImpactTableEvidence {
  provider: VendorId;
  table: string;
  keyColumns: string[];
  semanticColumns: string[];
  status: "available" | "unavailable";
  reason: string | null;
  beforeRecords: string | null;
  afterRecords: string | null;
  additions: string | null;
  corrections: string | null;
  deletions: string | null;
}

/**
 * Semantic changes to the provider source records published by one vendor run.
 * These are deliberately distinct from cross-copy canonical facts, which are
 * produced by the shared fact register after source publication.
 */
export interface VendorSourceImpact {
  basis: "source-record-semantic-diff-v1";
  scope: "published-source-identities" | "no-publication";
  sourceFactsChanged: ExactSourceImpactMetric;
  sourceCorrections: ExactSourceImpactMetric;
  sourceDeletions: ExactSourceImpactMetric;
  canonicalFacts: ExactSourceImpactMetric;
  duplicates: ExactSourceImpactMetric;
  evidence: SourceImpactTableEvidence[];
  /** Set when the stored copy kept only the first evidence rows; the metrics stay exact. */
  evidenceTotal?: number;
}

/** Wall-clock cost of one vendor's run. Optional spans are absent if not entered or unavailable. */
export interface VendorPhaseTimings {
  mirrorMs: number;
  stageMs: number;
  ingestMs: number;
  publishMs: number;
  /** Reparse planning after stage creation; outside publishMs. */
  reparsePreparationMs?: number;
  /** Stage validation and shared remapping; nested inside publishMs. */
  validationMs?: number;
  /** Source comparison and publication preparation; nested inside publishMs. */
  comparisonMs?: number;
  /** Publication call, including its transaction callbacks; nested inside publishMs. */
  publicationMs?: number;
  /** Advisory file-progress saves during the source import; nested inside ingestMs. */
  progressSaveMs?: number;
  discoveryMs?: number;
  indexBuildMs?: number;
  sourceWitnessMs?:number;
  steps?:Record<string,number>;
}

export interface VendorSyncResult {
  vendor: VendorId;
  status: VendorSyncStatus;
  processedInputs: number;
  skippedInputs: number;
  writtenRows: number;
  /** Optional for compatibility with sync runs stored before source-impact reporting. */
  sourceImpact?: VendorSourceImpact;
  dirtyRange: DirtyTimestampRange | null;
  /** Exact disjoint source periods; absent on older persisted sync runs. */
  dirtyRanges?: DirtyTimestampRange[];
  /**
   * Proven where the run read its inputs: every required source was read, with
   * nothing pending, unavailable or left for a reread. Diagnostics are sampled
   * when a stored run is reduced, so a resumed rebuild reads completeness here
   * instead of inferring it from evidence that may have been cut. Absent on sync
   * runs stored before this flag existed.
   */
  inputsComplete?: boolean;
  dataChanged: boolean;
  error: string | null;
  diagnostics: Record<string, unknown>;
  /** Absent on sync runs stored before phase timing was reported. */
  timings?: VendorPhaseTimings;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SyncRunResult {
  rebuildGeneration?: number;
  rebuildConfiguration?: string;
  progress?: import("../shared/sync-progress").SyncProgress;
  /** Status version, advanced by each live-progress write; the newer of file and record wins. */
  statusSequence?: number;
  runId: string;
  ownerPid?: number;
  /** OS process birth identity; PID alone can be reused after an interrupted run. */
  ownerProcessStart?: string;
  trigger: SyncTrigger;
  scope: SyncScope;
  mode: SyncMode;
  startedAt: string;
  finishedAt: string | null;
  status: SyncRunStatus;
  beforeRevisions: RevisionSnapshot;
  afterRevisions: RevisionSnapshot;
  changedConfigDomains?: ConfigDomain[];
  aggregateWorkRequested: boolean;
  /** Time spent refreshing attribution and projects after publication. */
  derivedMs?: number;
  vendors: VendorSyncResult[];
  error: string | null;
  /** The stored copy was reduced to fit the persistence cap; diagnostics are sampled. */
  truncated?: boolean;
}

export function isVendorId(value: string | null | undefined): value is VendorId {
  return VENDOR_SET.has(value);
}

export function vendorsForScope(scope: SyncScope): VendorId[] {
  if (!scope || typeof scope !== "object") throw new Error("Invalid sync scope");
  const raw = scope as unknown as Record<string, unknown>;
  if ("subjects" in raw || "accounts" in raw && scope.kind !== "accounts") throw new Error("Account and subject sync selectors are not supported for this scope");
  if ("meters" in raw && scope.kind !== "accounts") throw new Error("Meter archive selection is only supported for account sync scopes");
  if (scope.kind === "accounts") {
    if ("vendors" in raw || "vendor" in raw) throw new Error("Vendor and account sync selectors cannot be combined");
    const accounts = normalizeRebuildAccounts(scope.accounts);
    const meters = normalizeRebuildMeters(scope.meters);
    const selected = new Set<VendorId>(accounts.map(account => account.vendor));
    if (meters === "archive") selected.add("gauges");
    return VENDOR_IDS.filter(vendor => selected.has(vendor));
  }
  if (scope.kind === "all") return [...VENDOR_IDS];
  if (scope.kind === "vendor") {
    if (!isVendorId(scope.vendor)) throw new Error(`Unknown sync vendor: ${String(scope.vendor)}`);
    return [scope.vendor];
  }
  if (scope.kind === "vendors") {
    if (!Array.isArray(scope.vendors) || scope.vendors.length === 0) throw new Error("Vendor sync scope must contain at least one vendor");
    const selected = new Set<VendorId>();
    for (const vendor of scope.vendors) {
      if (typeof vendor !== "string" || !isVendorId(vendor)) throw new Error(`Unknown sync vendor: ${String(vendor)}`);
      if (selected.has(vendor)) throw new Error(`Duplicate sync vendor: ${vendor}`);
      selected.add(vendor);
    }
    return VENDOR_IDS.filter(vendor => selected.has(vendor));
  }
  throw new Error(`Unknown sync scope: ${String(raw.kind)}`);
}

export function pendingVendorResult(vendor: VendorId): VendorSyncResult {
  return {
    vendor,
    status: "pending",
    processedInputs: 0,
    skippedInputs: 0,
    writtenRows: 0,
    dirtyRange: null,
    dataChanged: false,
    error: null,
    diagnostics: {},
    timings: { mirrorMs: 0, stageMs: 0, ingestMs: 0, publishMs: 0 },
    startedAt: null,
    finishedAt: null,
  };
}
