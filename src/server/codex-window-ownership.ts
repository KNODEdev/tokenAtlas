import type { Database } from "bun:sqlite";
import { loadAccountResolver } from "./account-resolver";
import { preparedProbeAccountIndexReady, readPreparedProbeAccountRange, readPreparedProbeAccountingRevision,
  ProbeAccountIndexUnavailable } from "./current/probe-account-reader";

const RESET_TOLERANCE_MS = 120_000;
const MAX_BRACKET_MS = 24 * 3_600_000;
export interface WindowSample {
  ts: string;
  resets_at: number | null;
  limit_id: string | null;
}
interface VerifiedWindow { subject: string; ts: number; reset: number }

function lowerBound(rows: VerifiedWindow[], at: number): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]!.ts < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const verifiedMonths = new WeakMap<Database, Map<string, { stamp: string; verified: Array<[number, number]> }>>();
const monthStart = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const nextMonth = (start: number) => { const d = new Date(start); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/**
 * One account's identity-verified readings of a counter window in one UTC month of accounting time,
 * as [reading, reset] instants. Kept per month with the writer's day revisions of that account in
 * its configuration, so a new reading recomputes only its own month; every account asking about the
 * same period reuses the rest. A month is also a bounded read, however long the account's history.
 */
function verifiedMonth(sqlite: Database, owner: string, windowMinutes: number, start: number): Array<[number, number]> {
  const since = new Date(start).toISOString(), until = new Date(nextMonth(start)).toISOString();
  const compute = (): Array<[number, number]> => {
    const prepared = readPreparedProbeAccountRange(sqlite, "codex", owner, since, until, 20_000, "accounting");
    if (!prepared) throw new ProbeAccountIndexUnavailable();
    const verified: Array<[number, number]> = [];
    for (const row of prepared.rows) {
      if (row.window_minutes !== windowMinutes || row.limit_group !== "codex" || (row.ok !== null && row.ok !== 1)) continue;
      try {
        const extra = JSON.parse(typeof row.extra === "string" ? row.extra : "{}");
        const identity = typeof extra.codex_account === "string" ? JSON.parse(extra.codex_account) : extra.codex_account;
        if (!identity?.account_id || typeof identity.subscription !== "string" || !identity.subscription.trim()) continue;
        const ts = Date.parse(row.ts), reset = Date.parse(String(row.resets_at));
        if (Number.isFinite(ts) && Number.isFinite(reset) && reset > ts) verified.push([ts, reset]);
      } catch {
        // Missing or malformed identity supplies no evidence against a sample.
      }
    }
    return verified;
  };
  const revision = readPreparedProbeAccountingRevision(sqlite, "codex", owner, since, until);
  if (!revision) throw new ProbeAccountIndexUnavailable();
  // The connection keeps each month with the revisions it was read at: the register of every account and
  // counter asks about the same months of every account.
  let months = verifiedMonths.get(sqlite);
  if (!months) verifiedMonths.set(sqlite, months = new Map());
  const key = JSON.stringify([owner, windowMinutes, since]), stamp = JSON.stringify(revision), found = months.get(key);
  if (found?.stamp === stamp) return found.verified;
  const verified = compute();
  months.set(key, { stamp, verified });
  return verified;
}

/** A profile path cannot override contradictory, identity-verified counters. */
export function excludeConflictingWindowSamples<T extends WindowSample>(
  sqlite: Database, account: string, windowMinutes: number, samples: T[],
): { samples: T[]; excluded: number } {
  const unchanged = { samples, excluded: 0 };
  if (samples.length === 0) return unchanged;
  const columns = new Set((sqlite.query("PRAGMA table_info(probe_windows)").all() as Array<{ name: string }>).map(r => r.name));
  if (!["provider", "ts", "resets_at", "window_minutes", "limit_group", "extra", "ok"].every(c => columns.has(c))) return unchanged;
  let from = Infinity, until = -Infinity;
  for (const sample of samples) {
    const at = Date.parse(sample.ts);
    if (Number.isFinite(at)) { from = Math.min(from, at); until = Math.max(until, at); }
  }
  if (!Number.isFinite(from)) return unchanged;
  if (!preparedProbeAccountIndexReady(sqlite,"codex",account)) throw new ProbeAccountIndexUnavailable();
  const since = from - MAX_BRACKET_MS, toExclusive = until + MAX_BRACKET_MS + 1;
  const verified: VerifiedWindow[] = [];
  for (const owner of loadAccountResolver(sqlite).accounts("codex")) {
    for (let start = monthStart(since); start < toExclusive; start = nextMonth(start)) {
      for (const [ts, reset] of verifiedMonth(sqlite, owner, windowMinutes, start))
        if (since <= ts && ts < toExclusive) verified.push({ subject: owner, ts, reset });
    }
  }
  const subject = account.toLowerCase();
  const own = verified.filter(r => r.subject === subject).sort((a, b) => a.ts - b.ts);
  if (own.length < 2) return unchanged;
  const other = verified.filter(r => r.subject !== subject).sort((a, b) => a.ts - b.ts);
  const accepted = samples.filter(sample => {
    if (sample.limit_id !== "codex" || sample.resets_at == null) return true;
    const at = Date.parse(sample.ts), reset = sample.resets_at * 1000;
    if (!Number.isFinite(at) || !Number.isFinite(reset)) return true;
    const pos = lowerBound(own, at);
    const before = own[pos - 1], after = own[pos];
    // Preserve real resets: verified readings must show the same continuing
    // window on both sides of the contradictory transcript sample.
    if (!before || !after || at - before.ts > MAX_BRACKET_MS || after.ts - at > MAX_BRACKET_MS
      || before.reset <= after.ts || Math.abs(before.reset - after.reset) > RESET_TOLERANCE_MS
      || Math.abs(reset - before.reset) <= RESET_TOLERANCE_MS
      || Math.abs(reset - after.reset) <= RESET_TOLERANCE_MS) return true;
    const matches = new Set<string>();
    for (let i = lowerBound(other, before.ts - RESET_TOLERANCE_MS); i < other.length; i++) {
      const candidate = other[i]!;
      if (candidate.ts > after.ts + RESET_TOLERANCE_MS) break;
      if (Math.abs(candidate.reset - reset) <= RESET_TOLERANCE_MS) matches.add(candidate.subject);
    }
    // Never guess between accounts that happen to share a reset anchor.
    return matches.size !== 1;
  });
  return { samples: accepted, excluded: samples.length - accepted.length };
}
