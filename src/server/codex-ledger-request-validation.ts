import type { LedgerRange } from "../db/codex-price-ledger";
type CycleContext = { subIdToHomes: Map<string, string[]> };
export const codexEventOrderIsValid = (value: string): boolean => ["ts_desc", "ts_asc", "tokens_desc"].includes(value);
export type CodexCycleRequest = { error: string } | { since_ts: string; until_ts: string; accountParam: string;
  declared: string[]; anchor: number | null; sessionMinutes: number; fromMs: number; toMs: number };

/** Shared by the handler and cache preflight, preserving the existing parameter errors. */
export function codexCycleRequest(ctx: CycleContext, url: URL): CodexCycleRequest {
  const since_ts = url.searchParams.get("since_ts") || undefined, until_ts = url.searchParams.get("until_ts") || undefined;
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/;
  for (const [key, value] of [["since_ts", since_ts], ["until_ts", until_ts]] as const) {
    if (value !== undefined && !shape.test(value)) return { error: `Invalid '${key}' parameter: '${value}'. Expected an ISO-8601 instant, e.g. ${key === "since_ts" ? "2026-08-16" : "2026-08-23"}T12:28:50.000Z.` };
  }
  if (since_ts && until_ts && since_ts > until_ts) return { error: `'since_ts' (${since_ts}) cannot be after 'until_ts' (${until_ts}).` };
  if (!since_ts || !until_ts) return { error: "Both 'since_ts' and 'until_ts' are required - this endpoint describes one window, not a span." };
  const accountParam = url.searchParams.get("account") || "codex1", declared = ctx.subIdToHomes.get(accountParam.toLowerCase()) || [];
  if (!declared.length) return { error: `unknown account: ${accountParam}` };
  const anchorParam = url.searchParams.get("anchor"), anchor = anchorParam ? parseInt(anchorParam, 10) : null;
  if (anchorParam && (isNaN(anchor!) || anchor! <= 0)) return { error: `Invalid 'anchor' parameter: '${anchorParam}'. Expected unix seconds.` };
  const sessionParam = url.searchParams.get("session_window") || "300", sessionMinutes = parseInt(sessionParam, 10);
  if (isNaN(sessionMinutes) || sessionMinutes <= 0) return { error: `Invalid 'session_window' parameter: '${sessionParam}'` };
  const fromMs = new Date(since_ts).getTime(), toMs = new Date(until_ts).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { error: "'since_ts'/'until_ts' do not describe a window" };
  return { since_ts, until_ts, accountParam, declared, anchor, sessionMinutes, fromMs, toMs };
}

/** Normal cycle totals include their endpoint; its source burn has an independent moving lookback. */
export function codexCycleLedgerRanges(parsed: Exclude<CodexCycleRequest,{error:string}>, url: URL, nowMs = Date.now()): LedgerRange[] {
  const dated = url.searchParams.get("valuation") === "dated";
  return [{fromMs:parsed.fromMs,toMs:parsed.toMs,endInclusive:!dated || url.searchParams.get("end_inclusive") === "true"},
    ...(!dated ? [{since:new Date(nowMs - 168 * 3600000).toISOString().slice(0,10),dependencyBases:[] as const}] : [])];
}
