import { codexFirstTokenAdapter } from "./codex";
import type { FirstTokenAdapter } from "./types";

/** Only verified source semantics enter the common register. */
export const firstTokenAdapters: readonly FirstTokenAdapter[] = [codexFirstTokenAdapter];

// Grok's streamStartMs changes between model calls; agentTimestampMs timestamps recorded
// chunks, not proven first-token arrival. Neither is admitted as TTFT without a source contract.
export const FIRST_TOKEN_UNAVAILABLE = {
  grok: "unverified_stream_timestamps",
  claude: "no_first_token_timestamp",
  gemini: "no_first_token_timestamp",
  glm: "no_first_token_timestamp",
} as const;
