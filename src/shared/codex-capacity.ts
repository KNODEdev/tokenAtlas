import type { CodexAccountingReport } from "./codex-accounting";

export interface CodexCapacityRange { range: { since: string; until: string } | null }

/** Ordinary Capacity needs published cycles, not the accounting report's traffic/calibration scans. */
export type CodexCapacityReport = Pick<CodexAccountingReport, "scope" | "provider" | "windows" | "meter_history"> & {
  projection: true;
  updating?: true;
};
