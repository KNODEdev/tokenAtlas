import type { LocalArchiveSelection, proveLocalArchiveActivation } from "../config/archive-locator";

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export const MACHINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ArchiveRelocationProcessProof {
  processInstance:string;
  pid:number;
  processStartedAt:string;
  machineId:string;
  destinationStamp:string;
}

export interface ArchiveRelocationVerificationReceipt extends ArchiveRelocationProcessProof {
  status:"verified";
  verifiedAt:string;
  contract:"local-filesystem-read-write-check";
  read:{relative:string;digest:string;bytes:number};
  write:{relative:string;digest:string;bytes:number};
}

export interface ArchiveRelocationVerificationOptions {
  stateDirectory:string;
  env?:Record<string,string|undefined>;
  hooks?:{beforeReceipt?:()=>void|Promise<void>};
}

type EntryStatus = "pending" | "copying" | "copied" | "verified";

export type ArchiveRelocationPhase = "copying" | "verifying" | "ready-to-switch" | "activating" | "activated";

export type ArchiveRelocationActivationPhase =
  | "fencing"
  | "final-verified"
  | "destination-unsealed"
  | "locator-committed"
  | "source-fenced"
  | "complete";

export type ArchiveRelocationActivationHook =
  | "writers-drained"
  | "destination-marker-removed"
  | "locator-committed"
  | "source-relocated";

export interface ArchiveRelocationEntry {
  relative: string;
  sourceStamp: string;
  bytes: number;
  mode: number;
  modifiedAtMs: number;
  digest: string | null;
  status: EntryStatus;
}

export interface ArchiveRelocationState {
  schema: 1;
  jobId: string;
  archiveId: string;
  sourceRoot: string;
  destinationRoot: string;
  phase: ArchiveRelocationPhase;
  directories: string[];
  entries: ArchiveRelocationEntry[];
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  lastError?: string;
  postActivation?:ArchiveRelocationVerificationReceipt;
  activation?: {
    phase: ArchiveRelocationActivationPhase;
    priorLocator: LocalArchiveSelection | null;
    contract: "local-shared-filesystem-writers-only";
    remoteProcessExclusion: "not-proven";
    startedAt: string;
    decisionAt?: string;
    completedAt?: string;
    provenance?:ArchiveRelocationProcessProof;
  };
}

export interface ArchiveRelocationStepOptions {
  /** Caller-owned local directory outside both archive roots. */
  stateDirectory: string;
  maxFiles?: number;
  /** Scheduling budget between files. Native copying is asynchronous; hashing yields every 1 MiB. */
  maxBytes?: number;
}

export interface ArchiveRelocationActivationOptions {
  stateDirectory: string;
  /** Existing prepared local database; activation never migrates or rewrites it. */
  database: string;
  env?: Record<string, string | undefined>;
  /** Acceptance hooks. A child may terminate here to exercise a real restart window. */
  hooks?: {
    onPhase?: (phase: ArchiveRelocationActivationHook) => void | Promise<void>;
    afterLocatorCommit?: () => void;
    proveDecision?: typeof proveLocalArchiveActivation;
  };
}

export interface ArchiveRelocationWriterFence {
  /** The integration must keep every archive writer fenced until operation resolves. */
  runWhileAllWritersFenced<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ScannedFile {
  relative: string;
  sourceStamp: string;
  bytes: number;
  mode: number;
  modifiedAtMs: number;
}

export interface ScanResult {
  directories: string[];
  files: ScannedFile[];
}
