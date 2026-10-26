/**
 * Test oracle of the activity rule (docs/stored-activity-plan-2026-10-07.md, decision D2), frozen from the
 * Claude history algorithm as it stood on 07.10.2026 (`computeClaudeHistoryDay` and `sessionPredecessors`
 * in claude-history-usage.ts): a pure function over a list of ledger facts, so the stored gaps and day sums
 * and every later reader can be checked against it. Nothing here reads a database.
 *
 * Rule: a call's active time is the distance to the previous call of the same chain - the same session and
 * the same owner, among canonical eligible calls (and, in the GLM ledger, among the ineligible calls not on a
 * zai rate, the OpenCode-other calls, as their own class) - in the order (instant, identity), counted only
 * when positive, capped at the idle cutoff, and counted on the later call (its day and group). The
 * predecessor may be any distance back and does not depend on the selected range; a call without a session
 * neither receives nor bridges a gap.
 */

/** A fact as the oracle reads it: the ledger's columns (`usage_ledger_facts`) the rule depends on. */
export interface OracleFact {
  /** Any key of the fact (the ledger's row id); results are keyed by it. */
  id: number | string;
  identity: string;
  /** Exact UTC instant, ISO 8601 (`toISOString` form). */
  ts: string;
  session: string | null;
  copy_state: string;
  eligible: boolean | number;
  vendor: string;
}
/** The owner of a fact (a verified account, or a chain key); null when no owner reads it. */
export type OracleOwner<F> = (fact: F) => string | null;

/** OpenCode's plan vendors in the GLM ledger; the other ineligible calls there are their own class (repo-history.ts). */
const GLM_RATE_VENDORS = new Set(["zai", "z-ai"]);


/** The chain class of a fact: `e` canonical eligible, `o` canonical OpenCode-other, null outside every chain. */
export function oracleClass(provider: string, fact: Pick<OracleFact, "copy_state" | "eligible" | "vendor">): "e" | "o" | null {
  if (fact.copy_state !== "canonical") return null;
  if (fact.eligible === true || fact.eligible === 1) return "e";
  return provider === "glm" && !GLM_RATE_VENDORS.has(fact.vendor) ? "o" : null;
}

function byInstantThenIdentity(a: OracleFact, b: OracleFact): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

interface Walked<F> { fact: F; owner: string; day: string; gapMs: number | null; from: string | null }

/**
 * The Claude walk: per owner and class, the days in order, each day's calls in (instant, identity) order; a
 * session's first call of a day takes its gap from the session's last instant before that day (seeded, for the
 * first day, from every earlier call however far back), the others from the previous call of the day.
 */
function walk<F extends OracleFact>(provider: string, facts: readonly F[], ownerOf: OracleOwner<F>): Array<Walked<F>> {
  const scopes = new Map<string, F[]>();
  for (const fact of facts) {
    const kind = oracleClass(provider, fact);
    if (!kind) continue;
    const owner = ownerOf(fact);
    if (owner === null) continue;
    const scope = JSON.stringify([owner, kind]);
    (scopes.get(scope) ?? scopes.set(scope, []).get(scope)!).push(fact);
  }
  const out: Array<Walked<F>> = [];
  for (const [scope, list] of scopes) {
    const owner = (JSON.parse(scope) as [string, string])[0];
    const byDay = new Map<string, F[]>();
    for (const fact of list) {
      const day = new Date(fact.ts).toISOString().slice(0, 10);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(fact);
    }
    /** Session -> its last instant so far. */
    const previous = new Map<string, string>();
    for (const day of [...byDay.keys()].sort()) {
      const sessions = new Map<string, { first_ts: string; last_ts: string; first: number }>();
      const walked: Array<Walked<F>> = [];
      for (const fact of byDay.get(day)!.sort(byInstantThenIdentity)) {
        const entry: Walked<F> = { fact, owner, day, gapMs: null, from: null };
        walked.push(entry);
        const session = fact.session ?? null;
        if (!session) continue;
        const state = sessions.get(session);
        if (!state) { sessions.set(session, { first_ts: fact.ts, last_ts: fact.ts, first: walked.length - 1 }); continue; }
        entry.gapMs = Date.parse(fact.ts) - Date.parse(state.last_ts);
        entry.from = state.last_ts;
        if (fact.ts > state.last_ts) state.last_ts = fact.ts;
      }
      for (const [session, state] of sessions) {
        const last = previous.get(session);
        if (last !== undefined) {
          const first = walked[state.first]!;
          first.gapMs = Date.parse(state.first_ts) - Date.parse(last);
          first.from = last;
        }
        if (last === undefined || state.last_ts > last) previous.set(session, state.last_ts);
      }
      out.push(...walked);
    }
  }
  return out;
}

/** Each chained fact's gap to its predecessor and the predecessor's instant; facts without a predecessor are absent. */
export function oracleGaps<F extends OracleFact>(provider: string, facts: readonly F[], ownerOf: OracleOwner<F>):
  Map<F["id"], { gapMs: number; from: string }> {
  const gaps = new Map<F["id"], { gapMs: number; from: string }>();
  for (const row of walk(provider, facts, ownerOf)) if (row.gapMs !== null) gaps.set(row.fact.id, { gapMs: row.gapMs, from: row.from! });
  return gaps;
}

/**
 * Active milliseconds per `day \0 owner \0 group` of the later call, for one idle cutoff, over the calls whose
 * UTC day lies in `[since, until]`; predecessors before `since` still count. Exact integers.
 */
export function oracleActivity<F extends OracleFact>(provider: string, facts: readonly F[], options: {
  cutoffMinutes: number; ownerOf: OracleOwner<F>; groupOf: (fact: F) => string; since?: string; until?: string;
}): Map<string, number> {
  const cutoff = options.cutoffMinutes * 60_000;
  const sums = new Map<string, number>();
  for (const row of walk(provider, facts, options.ownerOf)) {
    if (options.since !== undefined && row.day < options.since || options.until !== undefined && row.day > options.until) continue;
    if (row.gapMs === null || row.gapMs <= 0) continue;
    const key = `${row.day}\u0000${row.owner}\u0000${options.groupOf(row.fact)}`;
    sums.set(key, (sums.get(key) ?? 0) + Math.min(row.gapMs, cutoff));
  }
  return sums;
}

/** Independent endpoint sweep for the prepared union, separate from the production merge algorithm. */
export function oracleIntervalUnion(intervals: readonly [number, number][]): Array<[number, number]> {
  const changes = new Map<number, number>();
  for (const [a, b] of intervals) {
    changes.set(a, (changes.get(a) ?? 0) + 1);
    changes.set(b, (changes.get(b) ?? 0) - 1);
  }
  const result: Array<[number, number]> = [];
  let count = 0, start = 0;
  for (const [at, change] of [...changes].sort((a, b) => a[0] - b[0])) {
    if (!count && change > 0) start = at;
    count += change;
    if (!count && at > start) result.push([start, at]);
  }
  return result;
}

