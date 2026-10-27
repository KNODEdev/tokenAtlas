import type { Database } from "bun:sqlite";
import { preparedProbeAccountIndexReady, probeReadContext, selectOwnedProbes } from "./current/probe-account-reader";
import type { BillingCycleBankedGrants } from "../shared/billing-cycles";
import type { CreditReading, ResetCredit } from "./window-end-causes";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export type BankedGrants = BillingCycleBankedGrants;

/**
 * Grants in [start, end) from the account's reset-credit readings: when two consecutive readings both carry the credit
 * list (09.10 on), each credit id not seen before; otherwise each rise of the count. A grant and a use between two
 * readings cancel out in the count, so the count era can miss one; the list era cannot. Null without a reading inside.
 */
export function bankedGrants(readings: readonly CreditReading[], start: number, end: number): BankedGrants | null {
  const sorted = readings.filter((r) => r.ts < end).sort((a, b) => a.ts - b.ts);
  const inside = sorted.filter((r) => r.ts >= start);
  if (!inside.length) return null;
  const baseline = sorted.filter((r) => r.ts < start).at(-1);
  const anchored = baseline !== undefined && start - baseline.ts <= DAY_MS;
  const series = anchored ? [baseline, ...inside] : inside;
  const seen = new Set<string>((series[0]!.list ?? []).map((credit) => credit.id));
  let count = 0;
  for (let i = 1; i < series.length; i++) {
    const previous = series[i - 1]!, reading = series[i]!;
    if (previous.list && reading.list) count += reading.list.filter((credit) => !seen.has(credit.id)).length;
    else count += Math.max(0, reading.count - previous.count);
    for (const credit of reading.list ?? []) seen.add(credit.id);
  }
  return { count, from: iso(series[0]!.ts), complete: anchored };
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
