/** Canonical input includes both cache reads and cache writes; reasoning is inside output. */
export interface WindowTokenCounts {
  input: number;
  cached: number;
  cache_write: number;
  /** False when the sum cannot prove that every call reported cache writes. */
  cache_write_complete?: boolean;
  output: number;
  reasoning: number;
}

/** Prepared, counted model traffic; unpriced tokens retain their quantities. */
export interface WindowModelUsage extends WindowTokenCounts {
  model: string | null;
  calls: number;
  api_standard: number;
  unpriced_tokens: number;
}
