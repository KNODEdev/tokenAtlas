import type { UsageVendorId } from "../sync/contracts";
import type { StartupUpdate } from "../shared/startup";

export const ATLAS_SNAPSHOT_KIND = "tokenatlas-index" as const;

export const ATLAS_SNAPSHOT_MANIFEST_VERSION = 2 as const;

export const ATLAS_SNAPSHOT_DATABASE_SUFFIX = ".atlas.sqlite";

export const ATLAS_SNAPSHOT_MANIFEST_SUFFIX = ".atlas-manifest.json";

export const ATLAS_SNAPSHOT_BARRIER_SUFFIX = ".atlas-ready";

export const ATLAS_SNAPSHOT_PUBLICATION_LEASE = ".atlas-publication-lease.sqlite";

export const MIN_COMPATIBLE_ATLAS_SCHEMA_VERSION = 13;

export interface AtlasSnapshotRevisions {
  data: number;
  config: number;
  derived: number;
}

export interface AtlasIndexSnapshotManifest {
  /** Only in manifests written before the source registry and probe bindings were retired; kept for their identity. */
  registryDigest?: string;
  probeFactsDigest?: string;
  /** See `registryDigest`. */
  bindingsDigest?: string;
  manifestVersion: typeof ATLAS_SNAPSHOT_MANIFEST_VERSION;
  kind: typeof ATLAS_SNAPSHOT_KIND;
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

/** The OpenCode file is a vendor source snapshot, never an Atlas index candidate. */
export interface OpenCodeSourceSnapshotDescriptor {
  kind: "opencode-source";
  databaseName: "opencode.sqlite";
  manifestSuffix: ".source.json";
}

export const OPENCODE_SOURCE_SNAPSHOT: OpenCodeSourceSnapshotDescriptor = {
  kind: "opencode-source",
  databaseName: "opencode.sqlite",
  manifestSuffix: ".source.json",
};

export interface AtlasSnapshotValidation {
  valid: boolean;
  compatible: boolean;
  manifest: AtlasIndexSnapshotManifest | null;
  errors: string[];
}

export interface AtlasNewestValidSnapshot {
  id: string;
  created_at: string;
  age_seconds: number;
  revisions: AtlasSnapshotRevisions;
  vendor_revisions: Record<UsageVendorId, number>;
  compatible: boolean;
  validation: "manifest-only" | "full";
}

export interface AtlasSnapshotCandidate extends AtlasSnapshotValidation {
  snapshotId: string;
  databasePath: string;
  manifestPath: string;
  barrierPath: string;
  sortTime: string;
}

export interface AtlasSnapshotPublishResult {
  status: "created" | "reused" | "skipped" | "aborted";
  reason: "identical-snapshot" | "unchanged-data" | "daily-limit" | "lease-lost" | null;
  snapshotId: string | null;
  databasePath: string | null;
  manifestPath: string | null;
  manifest: AtlasIndexSnapshotManifest | null;
  validation: AtlasSnapshotValidation | null;
  leaseLostAfterCommit: boolean;
}

export interface PublishAtlasSnapshotOptions {
  dbPath: string;
  archiveRoot?: string;
  poolPath?: string;
  sourceMachine?: string;
  mode: "automatic" | "manual";
  now?: Date;
  currentSchemaVersion?: number;
  lockTimeoutMs?: number;
  leaseStaleMs?: number;
  /** Always copy, never answer with an existing snapshot. The identity fingerprint omits some
   * durable state, so a pre-migration snapshot cannot trust an "identical" older copy. */
  requireFreshCopy?: boolean;
  onProgress?: (update: StartupUpdate) => void;
  failpoints?: AtlasSnapshotPublishFailpoints;
}

export interface AtlasSnapshotPublishFailpoints {
  afterClaimAcquired?: (token: string, renew: () => void) => void;
  beforeDatabaseCopy?: () => void;
  afterPreCommitRenewal?: (token: string) => void;
  afterLeaseLost?: (token: string) => void;
  afterDatabaseRename?: () => void;
  afterManifestRename?: () => void;
  beforeRetentionDelete?: (snapshotId: string) => void;
  afterRetentionManifestDelete?: (snapshotId: string) => void;
}

export class AtlasSnapshotDiscoveryError extends Error {
  readonly code = "snapshot-pool-read-failed" as const;
  readonly stage = "discovery" as const;

  constructor() {
    super("Atlas snapshot pool could not be read");
    this.name = "AtlasSnapshotDiscoveryError";
  }
}
