export type SyncPhase =
  | "readings" | "scan" | "identity" | "mirror" | "stage" | "ingest"
  | "validate" | "publish" | "attribution" | "projects"
  | "checkpoint" | "finalize";

/**
 * The phase a synchronization run is in, kept in the run's record. `completed`/`total`
 * count the run's steps. What a phase is doing at this moment, with its own counter,
 * is in the progress register (`ProgressEntry`, scopes `sync` and `sync:<vendor>`).
 */
export interface SyncProgress {
  phase: SyncPhase;
  vendor?: string;
  startedAt: string;
  completed: number;
  total: number;
}
