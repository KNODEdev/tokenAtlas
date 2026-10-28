import type { Database } from "bun:sqlite";
import { preparedProbeAccountIndexReady, probeReadContext, selectOwnedProbes } from "./current/probe-account-reader";
import type { BillingCycleBankedGrants } from "../shared/billing-cycles";
import type { CreditReading, ResetCredit } from "./window-end-causes";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export type BankedGrants = BillingCycleBankedGrants;

/**
 * Grants in [start, end) from the account's reset-credit readings: when two consecutive readings both carry the credit
 * list, dated grants belong to their provider timestamp, not their first observation. Undated IDs and count rises
 * are observation-based lower bounds: a grant and a use between readings can cancel out. Null without a reading inside.
 */
export function bankedGrants(readings: readonly CreditReading[], start: number, end: number): BankedGrants | null {
  const sorted = readings.filter((r) => r.ts < end).sort((a, b) => a.ts - b.ts);
  const inside = sorted.filter((r) => r.ts >= start);
  if (!inside.length) return null;
  const baseline = sorted.filter((r) => r.ts < start).at(-1);
  const anchored = baseline !== undefined && start - baseline.ts <= DAY_MS;
  const series = anchored ? [baseline, ...inside] : inside;
  const seen = new Set<string>();
  let datedCount = 0, observedCount = 0, outsideCount = 0;
  let complete = anchored;
  for (let i = 0; i < series.length; i++) {
    const previous = series[i - 1], reading = series[i]!;
    if (!reading.list) complete = false;
    for (const credit of reading.list ?? []) {
      if (seen.has(credit.id)) continue;
      seen.add(credit.id);
      const granted = Date.parse(credit.granted_at);
      if (Number.isFinite(granted) && granted <= reading.ts) {
        if (granted >= start && granted < end) {
          datedCount++;
          if (previous?.list && previous.ts >= start) observedCount++;
        } else if (reading.ts >= start) outsideCount++;
      } else {
        complete = false;
        if (previous?.list && previous.ts >= start) observedCount++;
      }
    }
    if (previous && (!reading.list || !previous.list)) {
      complete = false;
      // A count rise spanning the cycle boundary cannot date the grant to this cycle.
      if (previous.ts >= start) observedCount += Math.max(0, reading.count - previous.count);
    }
  }
  // A later credit list can describe the same grants already seen as count rises.
  return { count: Math.max(datedCount, observedCount - outsideCount), from: iso(series[0]!.ts), complete };
}

const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** A Codex account's reset-credit readings in [from, until); empty before the probe index is ready. */
export function creditReadings(db: Database, account: string, from: number, until: number): CreditReading[] {
  if (!tableExists(db, "probe_windows") || !preparedProbeAccountIndexReady(db)) return [];
  const rows = selectOwnedProbes(db, probeReadContext(db), "codex", account, { from, until,
    where: "p.reset_credits IS NOT NULL", columns: `p.id, p.ts, p.reset_credits, json_extract(p.extra, '$."codex.reset_credits"') AS credit_list` })
    .map(({ row }) => row as unknown as { ts: string; reset_credits: number; credit_list: string | null });
  // Consecutive readings mostly repeat the same list text: parse each distinct text once.
  const parsed = new Map<string, ResetCredit[] | null>();
  const listOf = (text: string | null) => {
    if (!text) return null;
    if (!parsed.has(text)) {
      let list: unknown = null;
      try { list = JSON.parse(text); } catch { /* Not a list. */ }
      parsed.set(text, Array.isArray(list) ? list as ResetCredit[] : null);
    }
    return parsed.get(text)!;
  };
  return rows.map((row) => ({ ts: Date.parse(row.ts), count: row.reset_credits, list: listOf(row.credit_list) }));
}
