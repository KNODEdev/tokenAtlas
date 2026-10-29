export const STARTUP_PHASES = [
  "migration-check", "snapshot-wait", "snapshot-copy", "snapshot-validation",
  "snapshot-checksum", "snapshot-publication", "snapshot-retention", "migration", "configuration", "server", "failed",
] as const;
export type StartupPhase = typeof STARTUP_PHASES[number];

export interface StartupUpdate {
  phase: StartupPhase;
  snapshotFile?: string;
  /** Expected copy size: all source pages, including free pages and committed WAL content. */
  snapshotTotalBytes?: number;
  /** Bytes actually read during the current checksum pass, independent of output file size. */
  snapshotProcessedBytes?: number;
  /** Pending migrations not declared additive; they are why the full copy is made. */
  snapshotMigrations?: string[];
}

export interface StartupStatus {
  phase: StartupPhase;
  startedAt: string;
  stageStartedAt: string;
  snapshotDirectory: string;
  snapshotBytes: number | null;
  snapshotTotalBytes: number | null;
  snapshotProcessedBytes: number | null;
  snapshotMigrations: string[] | null;
  error: string | null;
}
