import type { CodexTokenRates } from "./codex-accounting";
import type { WindowTokenCounts } from "./window-model-usage";

export interface WindowPriceParts {
  rates: CodexTokenRates;
  input: number;
  cached: number;
  cache_write?: number;
  output: number;
  total: number;
  rule_id: string;
  sources: string[];
  confidence: "official" | "user";
}

/** A row has one dated price and context band; model names may repeat. */
export interface CodexWindowModelRow extends WindowTokenCounts {
  model: string;
  speed: "standard" | "fast" | "unknown";
  first: string;
  last: string;
  calls: number;
  tokens: number;
  long_context: boolean;
  api: WindowPriceParts | null;
  credits: WindowPriceParts | null;
  actual_api: number | null;
  actual_credits: number | null;
  unpriced_reason: string | null;
}

/** Canonical, valid input counters in a UTC bucket; hourly in a cycle, daily in long history. */
export interface CodexModelCacheHour {
  model: string;
  hour: string;
  calls: number;
  input: number;
  cached: number;
}

export interface CodexWindowCacheTimeline {
  from: string;
  /** Exclusive end, including the final millisecond of an end-inclusive observation. */
  until: string;
  grain?: "hour" | "day";
  hours: CodexModelCacheHour[];
}

export interface CodexModelCacheHistory extends CodexWindowCacheTimeline {
  account: string;
  model: string;
}

export interface CodexWindowDetail {
  basis: "dated-standard-reference";
  rows: CodexWindowModelRow[];
  /** Absent in an older stored answer while its successor is prepared in the background. */
  cache_timeline?: CodexWindowCacheTimeline;
  surfaces?: Array<{ name: string; calls: number; tokens: number; fresh: number; usd: number; usd_partial: boolean }>;
  excluded_mirror_events: number;
  excluded_counter_events: number;
  unknown_speed_tokens: number;
  invalid_token_events: number;
}
