export type ActivityProviderId = "codex" | "claude" | "gemini" | "grok" | "glm";
export type ActivityState = "missing" | "pending" | "retiring" | "backfill" | "replay" | "ready" | "unavailable";
export interface ActivityStage {
  /** Stored preparation state, not certification of the current pricing configuration. */
  state: ActivityState;
  version: number | null;
  /** Durable numeric position, never an event count or percentage. */
  checkpoint: number | null;
  cursor: number | null;
  /** Last checkpoint change observed by this process; unknown on the first observation. */
  lastProgressAt: number | null;
  etaMs: null;
}
export interface ActivityProvider {
  provider: ActivityProviderId;
  register: ActivityStage;
  facts: ActivityStage | null;
}
export type ActivityView = "overview" | "usage" | "capacity" | "history" | "projects" | "subscriptions" | "accounts" | "other";
export type ActivityIssueReason = "account-unavailable" | "database-busy" | "invalid-request" | "preparation-failed";
export interface AppActivity {
  observedAt: number;
  observationStartedAt: number;
  busy: boolean;
  unavailable: boolean;
  providers: ActivityProvider[];
  /** Every running stage and background producer, from the progress register. */
  progress: import("./progress").ProgressEntry[];
  reports: {
    /** Counts are lower bounds when truncated. Failed markers are excluded from pending. */
    pending: number;
    failed: number;
    truncated: boolean;
    views: Array<{ view: ActivityView; pending: number; failed: number; issues?: Array<{ reason: ActivityIssueReason; count: number }> }>;
  };
}
