export interface TurnRow {
  session_id: string;
  prompt_id: string;
  ts: string;
  model: string;
  stop_reason: string | null;
  cwd: string | null;
  project: string;
  path: string;
  in_tok: number;
  cached_in: number;
  cache_write: number;
  out_tok: number;
  reasoning: number;
  model_calls: number;
  api_duration_ms: number;
  cost_ticks: number;
}
export function decodeCwd(dirName: string): string | null {
  if (!dirName) return null;
  try {
    return decodeURIComponent(dirName);
  } catch {
    return dirName;
  }
}
