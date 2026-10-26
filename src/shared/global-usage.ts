import type { ContextPreviewResponse } from "./context-preview";
export interface UsageAmount {
  subtotal: number;
  priced_calls: number;
  unpriced_calls: number;
}

export interface GlobalUsageRow {
  day: string;
  provider: string;
  account: string | null;
  source: string;
  model: string | null;
  calls: number;
  tokens: number;
  internal_tokens?: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  api_usd: UsageAmount;
  credits: UsageAmount;
  credit_unit: string | null;
}

export interface GlobalUsageResponse extends ContextPreviewResponse<GlobalUsageResponse> {
  since: string;
  until: string;
  timezone: "UTC";
  rows: GlobalUsageRow[];
  sources: Array<{ id: string; available: boolean; events: number }>;
  excluded_duplicates: number;
  conflicting_events: number;
  approximate_time_events: number;
  actual_cost_available: false;
}

export const GLOBAL_USAGE_MAX_DAYS = 36600;
