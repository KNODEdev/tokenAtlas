import type { CodexAccountingReport, CodexComparisonWindow, CodexAccountingOptions, TimelineMarkersResponse } from "./codex-accounting";

/** A capacity report is of one subscription; the all-accounts scope has its own views. */
export const SELECT_ONE_SUBSCRIPTION = "Select one subscription to analyse its capacity";

/** Provider adapters publish the same measured quantities; unavailable units stay unavailable. */
export interface SubscriptionAnalysisProvider {
  id: string;
  label: string;
  credits: boolean;
  speed: boolean;
  counter: string | null;
  counter_reason: string | null;
  counters?: Array<{ id: string; label: string }>;
}

export const CODEX_ANALYSIS_PROVIDER: SubscriptionAnalysisProvider = {
  id: "codex", label: "OpenAI / Codex", credits: true, speed: true,
  counter: "weekly", counter_reason: null,
};

export type SubscriptionComparisonWindow = CodexComparisonWindow;
export type SubscriptionAccountingOptions = CodexAccountingOptions & { counter?: string };
export type SubscriptionAccountingReport = CodexAccountingReport;

export interface SubscriptionModelDetail {
  day: string;
  model: string;
  speed: string;
  source: string;
  calls: number;
  tokens: number;
  quantities: Record<string, number>;
  rates: Record<string, number | null>;
  costs: Record<string, number | null>;
  api_standard: number | null;
  api_actual: number | null;
  pricing_source: string | null;
  pricing_note: string;
  pricing_issue?: "missing_rate" | "unknown_mode" | "invalid_cache_totals" | null;
}

export interface SubscriptionAnalysisExtensions {
  provider?: SubscriptionAnalysisProvider;
  model_details?: SubscriptionModelDetail[];
  timeline_markers?: TimelineMarkersResponse;
  /**
   * The one shared Claude Code usage-share estimate. Conditional token equivalents with
   * their assumptions and coverage; never a measured account total, and never merged
   * into `tokens` or `amounts`.
   */
  claude_code_capacity?: import("./claude-code-capacity").ClaudeCodeCapacitySummary | null;
}
