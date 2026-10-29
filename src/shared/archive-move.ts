/** Settings → move archive: what the server reports while copying, switching and after the restart. */
export interface ArchiveMoveResult { jobId: string; destination: string; error: string | null }
export interface ArchiveMoveStatus {
  archive: string;
  job: null | {
    jobId: string;
    destination: string;
    phase: "copying" | "verifying" | "ready-to-switch" | "activating" | "activated" | "failed";
    files: number;
    copiedFiles: number;
    bytes: number;
    copiedBytes: number;
    error: string | null;
  };
  result: ArchiveMoveResult | null;
}
