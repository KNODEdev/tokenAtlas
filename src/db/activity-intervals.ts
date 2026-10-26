import type { Database } from "./sqlite";

/** Half-open UTC intervals in integer milliseconds. */
export type ActivityInterval = [from: number, until: number];
export const ACTIVITY_INTERVALS_SCHEMA = `CREATE TABLE IF NOT EXISTS usage_activity_intervals (
  provider TEXT NOT NULL, day TEXT NOT NULL, dim_id INTEGER NOT NULL, cutoff INTEGER NOT NULL,
  intervals TEXT NOT NULL, PRIMARY KEY(provider, day, dim_id, cutoff)
) STRICT;`;
export const ACTIVITY_CUTOFF_MINUTES = [5, 10, 15, 30, 45, 60] as const;

/** Sorted, disjoint intervals; parallel sessions and adjacent segments count once. */
export function unionActivity(intervals: readonly ActivityInterval[]): ActivityInterval[] {
  const result: ActivityInterval[] = [];
  for (const [from, until] of [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || until <= from) throw new Error("Invalid activity interval");
    const previous = result.at(-1);
    if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], until);
    else result.push([from, until]);
  }
  return result;
}

/** Runs only inside the ledger's day publication transaction, alongside its other activity sums. */
export function publishActivityIntervals(db: Database, provider: string, days: readonly string[]): void {
  if (!db.inTransaction) throw new Error("Activity publication requires the producer transaction");
  if (!["codex", "claude", "grok", "glm"].includes(provider)) return;
  const list = JSON.stringify(days);
  db.query("DELETE FROM usage_activity_intervals WHERE provider=? AND day IN (SELECT value FROM json_each(?))").run(provider, list);
  const rows = provider === "codex"
    ? db.query(`SELECT day,dim_id,instant_ms until,gap_ms gap FROM codex_price_ledger_events INDEXED BY codex_price_ledger_events_day
        WHERE day IN (SELECT value FROM json_each(?)) AND admitted=1 AND copy_state='canonical' AND gap_ms>0`).all(list)
    : db.query(`SELECT day,dim_id,ts until,gap_ms gap
        FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
        WHERE provider='${provider}' AND day IN (SELECT value FROM json_each(?)) AND accounting=1 AND copy_state='canonical' AND gap_ms>0
          AND NOT EXISTS (SELECT 1 FROM usage_ledger_mixed_sessions m WHERE m.provider=? AND m.session=usage_ledger_facts.session)
          AND (eligible=1 OR (?='glm' AND vendor NOT IN ('zai','z-ai')))`)
        .all(list, provider, provider);
  const groups = new Map<string, { day: string; dim: number; calls: Array<{ until: number; gap: number }> }>();
  for (const row of rows as Array<{ day: string; dim_id: number; until: number | string; gap: number }>) {
    const key = JSON.stringify([row.day, row.dim_id]);
    const group = groups.get(key) ?? { day: row.day, dim: row.dim_id, calls: [] };
    group.calls.push({ until: typeof row.until === "string" ? Date.parse(row.until) : row.until, gap: row.gap }); groups.set(key, group);
  }
  const write = db.query("INSERT INTO usage_activity_intervals VALUES(?,?,?,?,?)");
  for (const group of groups.values()) for (const cutoff of ACTIVITY_CUTOFF_MINUTES) {
    const intervals = unionActivity(group.calls.map(call => [call.until - Math.min(call.gap, cutoff * 60_000), call.until]));
    write.run(provider, group.day, group.dim, cutoff, JSON.stringify(intervals));
  }
}

/** Only prepared rows; a missing nonzero day is pending, never a silent session-sum fallback. */
export function storedActivityIntervals(db: Database, provider: string, cutoff: number, range: { since?: string; until?: string }): Map<string, ActivityInterval[]> {
  const terms = ["provider=?", "cutoff=?"], params: Array<string | number> = [provider, cutoff];
  if (range.since) { terms.push("day>=?"); params.push(range.since); }
  if (range.until) { terms.push("day<=?"); params.push(range.until); }
  return new Map((db.query(`SELECT day,dim_id,intervals FROM usage_activity_intervals WHERE ${terms.join(" AND ")}`).all(...params) as
    Array<{ day: string; dim_id: number; intervals: string }>).map(row => [`${row.day}|${row.dim_id}`, JSON.parse(row.intervals) as ActivityInterval[]]));
}
