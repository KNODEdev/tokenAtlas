/** Units a progress counter can count in. */
export type ProgressUnit = "files" | "records" | "indexes" | "tables" | "changes" | "readings" | "accounts" | "sources" | "days" | "items";

/**
 * What one scope of work is doing now and how far it got. A scope is one independent
 * worker: the synchronization run (`sync`), one of its vendors (`sync:codex`) or one
 * background producer (`usage-ledger:claude`, `codex-ledger`, `account-periods`,
 * `limit-windows`). `step` is a stable key the screen translates; `label` is the same
 * step in English for logs and for keys the screen does not know.
 */
export interface ProgressEntry {
  scope: string;
  step: string;
  label: string;
  done: number;
  /** Null while the amount of work is not known yet. */
  total: number | null;
  unit: ProgressUnit;
  /** When this step of the scope began. */
  startedAt: string;
  updatedAt: string;
}

export const PROGRESS_UNITS: readonly ProgressUnit[] = ["files", "records", "indexes", "tables", "changes", "readings", "accounts", "sources", "days", "items"];
