import type { ConfigDomain, SyncTrigger, SyncScope, SyncMode, SyncRunResult, VendorId } from "./contracts";
import type { VendorAdapters } from "./adapters";
import type { MirrorResult } from "./mirror";
import type { Database } from "../db/sqlite";
import type { RemapProgressHandler } from "../projects/remap";
import type { DeltaIdentity } from "./vendor-publication-schema";

export interface ConfigSnapshot {
  fingerprint: string;
  domains: Record<ConfigDomain, string>;
}

export interface SyncRequest {
  trigger: SyncTrigger;
  scope: SyncScope;
  mode: SyncMode;
  reparse?: import("./reparse").ReparseRange;
  rebuildGeneration?: number;
  collection?: "archive" | "collect-archive" | "mirror-only";
  /** Identifies the new Atlas index whose archive inputs must be queued once. */
  bootstrapRecoveryId?: string;
}

export interface SyncExecution {
  initial: SyncRunResult;
  completion: Promise<SyncRunResult>;
  owned: boolean;
}

export interface SyncCoordinatorOptions {
  dbPath: string;
  rootDir: string;
  adapters?: VendorAdapters;
  mirror?: (vendor: VendorId, rootDir: string, mode: SyncMode, changedPaths?:string[],
    onProgress?:(completed:number,total:number|null)=>void,
    onSourceArchived?:(source:string,archives:readonly string[])=>void) => Promise<MirrorResult>;
  /** Injected adapters may supply their own discovery instead of archive selection. */
  archiveInputs?: (vendor: VendorId) => string[] | undefined;
  configFingerprint?: () => string;
  configFingerprints?: () => ConfigSnapshot;
  sourceFingerprint?: (vendor: VendorId) => string;
  prepareStage?: (sqlite: Database, onProgress?: RemapProgressHandler, tables?: readonly string[]) => void;
  ensureStagingRoot?: (directory: string) => void;
  beforeVendorSave?: () => void;
  beforeIncrementalPublish?: () => void;
  afterPublishBeforeRevision?: () => void;
  refreshDerived?: (
    sqlite: Database,
    result: SyncRunResult,
    changedDomains: ConfigDomain[],
    affected: ReadonlyMap<VendorId, DeltaIdentity[]>,
    /** A phase starts. */
    progress: (phase: "attribution" | "projects") => void,
  ) => void;
  now?: () => string;
}
