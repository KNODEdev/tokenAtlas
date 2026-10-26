export interface GenRow {
  conversation_id: string;
  gen_idx: number;
  ts: string;
  ts_basis: "conversation" | "mtime";
  model: string | null;
  workspace: string | null;
  path: string;
  fresh_in: number;
  cached_in: number;
  out_total: number;
  out_thinking: number;
  out_visible: number;
  context_tokens: number;
  context_limit: number;
}
export interface InvariantReport {
  checked: number;
  violations: number;
  examples: string[];
}
