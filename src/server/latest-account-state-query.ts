import type { Database } from "bun:sqlite";
import { loadAccountResolver } from "./account-resolver";
import { ProbeAccountIndexUnavailable, readPreparedProbeTimestamp } from "./current/probe-account-reader";

export interface LatestAccountSample {
  account: string; limit_id: string; limit_name: string | null; plan_type: string | null; slot: string;
  window_minutes: number | null; used_percent: number; resets_at: string | null;
  rate_limit_reached: number; reset_credits: number; ts: string; machine: string | null;
}

/** Lexical MAX(ts) among qualifying successes, then every non-error row at that raw timestamp. */
export function readLatestAccountStateRows(db: Database): LatestAccountSample[] {
  const rows: LatestAccountSample[] = [];
  for (const account of loadAccountResolver(db).accounts("codex")) {
    const newest = readPreparedProbeTimestamp(db, "codex", account, "codex-success");
    if (!newest) throw new ProbeAccountIndexUnavailable();
    for (const row of newest.rows) {
      if (row.kind === "error") continue;
      rows.push({ account, limit_id: row.limit_group as string, limit_name: row.scope as string | null,
        plan_type: row.plan as string | null, slot: row.kind, window_minutes: row.window_minutes as number | null,
        used_percent: row.used_percent as number, resets_at: row.resets_at as string | null,
        rate_limit_reached: row.rate_limit_reached as number, reset_credits: row.reset_credits as number,
        ts: row.ts, machine: row.machine as string | null });
    }
  }
  return rows.sort((a,b) => a.account.localeCompare(b.account) || String(a.limit_id).localeCompare(String(b.limit_id)) || a.slot.localeCompare(b.slot));
}
