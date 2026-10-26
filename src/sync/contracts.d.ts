export declare const USAGE_VENDOR_IDS: readonly ["codex", "claude", "opencode", "grok", "gemini"];
export declare const VENDOR_IDS: readonly ["codex", "claude", "opencode", "grok", "gemini", "gauges"];
export type UsageVendorId = (typeof USAGE_VENDOR_IDS)[number];
export type VendorId = (typeof VENDOR_IDS)[number];
export declare function isUsageVendor(vendor: VendorId): vendor is UsageVendorId;
// Request/history label only: "full" selects all existing archive inputs for forced incremental publication.
export type SyncMode = "incremental" | "full";
export type SyncTrigger = "manual" | "auto" | "cli";
export type SyncScope = {
    kind: "all";
} | {
    kind: "vendor";
    vendor: VendorId;
} | {
    kind: "vendors";
    vendors: VendorId[];
} | {
    kind: "accounts";
    accounts: import("../shared/rebuild-accounts").RebuildAccount[];
    meters?: import("../shared/rebuild-accounts").RebuildMeters;
};
export type SyncRunStatus = "running" | "success" | "partial_success" | "failure";
export type VendorSyncStatus = "pending" | "success" | "failure";
export declare const CONFIG_DOMAINS: readonly ["accounts", "rate-cards", "projects", "cycles", "plans", "plans-catalog", "claude-gauge", "grok-gauge"];
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
export interface VendorSourceImpact {
    basis: "source-record-semantic-diff-v1";
    scope: "published-source-identities" | "no-publication";
    sourceFactsChanged: ExactSourceImpactMetric;
    sourceCorrections: ExactSourceImpactMetric;
    sourceDeletions: ExactSourceImpactMetric;
    canonicalFacts: ExactSourceImpactMetric;
    duplicates: ExactSourceImpactMetric;
    evidence: SourceImpactTableEvidence[];
}
export interface VendorSyncResult {
    vendor: VendorId;
    status: VendorSyncStatus;
    processedInputs: number;
    skippedInputs: number;
    writtenRows: number;
    sourceImpact?: VendorSourceImpact;
    dirtyRange: DirtyTimestampRange | null;
    dataChanged: boolean;
    error: string | null;
    diagnostics: Record<string, unknown>;
    startedAt: string | null;
    finishedAt: string | null;
}
export interface SyncRunResult {
    runId: string;
    ownerPid?: number;
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
    vendors: VendorSyncResult[];
    error: string | null;
}
export declare function isVendorId(value: string | null | undefined): value is VendorId;
export declare function vendorsForScope(scope: SyncScope): VendorId[];
export declare function pendingVendorResult(vendor: VendorId): VendorSyncResult;
