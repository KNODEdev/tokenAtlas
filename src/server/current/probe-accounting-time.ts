import { claudeCodeProductShareFromExtra } from "../../providers/adapters/claude";

const WEEK = 7 * 86_400_000;

/** Account ownership uses collection time; accounting alone may observe a coherent earlier Claude share. */
export function probeAccountingTime(row: {
  provider: string; kind: string; ts: string; resets_at: string | null; extra: string | null;
}): string {
  if (row.provider !== "claude" && row.provider !== "anthropic" || row.kind !== "weekly_all") return row.ts;
  const share = claudeCodeProductShareFromExtra(row.extra);
  const reset = row.resets_at ? Date.parse(row.resets_at) : NaN;
  return share && reset - Date.parse(share.window_started_at) === WEEK && Date.parse(share.as_of) < reset
    ? share.as_of : row.ts;
}

/** The observation reader groups by raw vendor as_of even when the share itself is invalid. */
export function probeClaudeObservationTime(row: {
  provider: string; kind: string; scope: string | null; ts: string; extra: string | null;
}): string | null {
  if (row.provider !== "claude" || row.kind !== "weekly_all" || row.scope) return null;
  let asOf: unknown;
  try {
    const parsed: unknown = JSON.parse(row.extra ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      asOf = (parsed as Record<string, unknown>)["claude.share.as_of"];
  } catch { /* Invalid share metadata still leaves collection-time evidence. */ }
  const value = typeof asOf === "string" && Number.isFinite(Date.parse(asOf)) ? asOf : row.ts;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
