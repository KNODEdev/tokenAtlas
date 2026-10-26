import type { CodexComparisonWindow } from "./codex-accounting";

/** One subscription's cycles of one counter for the capacity comparison (`/api/capacity-cycles`), or why it has none yet. */
export interface CapacityCyclesEntry {
  account: string; provider: string; counter: string; counter_label: string; windows: CodexComparisonWindow[];
  /** Its stored sums are still being written by the background producer: read again shortly. */
  preparing?: true;
  /** Last published cycles remain available while their dependent inputs are updated. */
  stale?: true;
  /** No stored window of this window length overlaps the days. */
  unavailable?: true;
  error?: string;
}
export interface CapacityCyclesResponse { since: string; until: string; window_minutes: 300 | 10080 | 43200; accounts: CapacityCyclesEntry[] }
