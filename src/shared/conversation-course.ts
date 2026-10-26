import type { ContextPrice } from "./context-price";

/** Codex: durable transcript-copy id; other providers: the source event's primary key. */
export interface ConversationRef { vendor: string; reference_id: number }
export interface ConversationCall {
  key: string;
  ts: string;
  model: string | null;
  tokens: { input: number; cache_read: number; cache_write: number; output: number } | null;
  api_usd: number | null;
  price_partial: boolean;
  context_price?: ContextPrice;
}
export interface ConversationCourse {
  vendor: string;
  identity: string;
  basis: "conversation" | "source_file";
  unit: "call" | "turn" | "generation";
  calls: ConversationCall[];
  truncated: boolean;
  excluded: number;
  approximate_order: boolean;
}
export const CONVERSATION_CALL_LIMIT = 5000;
