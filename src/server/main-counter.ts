import type { Database } from "bun:sqlite";
import { isFreePlan } from "../shared/period-end";
export { isFreePlan };

/**
 * A limit counter of an account: its stored id, its kind (the first element of a JSON id) and its window length. `plans`:
 * whether its windows carried the Free plan and a paid plan (absent or both false: no plan known).
 */
export interface Counter { id: string; kind: string; minutes: number; plans?: { free: boolean; paid: boolean } }

export function parseCounter(id: string, minutes: number, plans?: Counter["plans"]): Counter {
  try {
    const parsed = JSON.parse(id) as unknown;
    if (Array.isArray(parsed)) return { id, kind: String(parsed[0] ?? ""), minutes, ...(plans ? { plans } : {}) };
  } catch { /* A plain counter name. */ }
  return { id, kind: id, minutes, ...(plans ? { plans } : {}) };
}

/** The account's counters with their longest window and the plans their windows carried. */
export function countersOf(db: Database, provider: string, account: string): Counter[] {
  return (db.query(`SELECT counter, MAX(window_minutes) AS minutes, MAX(plan = 'free') AS free, MAX(plan IS NOT NULL AND plan <> 'free') AS paid
      FROM limit_windows WHERE provider=? AND account=? GROUP BY counter`)
    .all(provider, account) as Array<{ counter: string; minutes: number; free: number | null; paid: number | null }>)
    .map((row) => parseCounter(row.counter, row.minutes, { free: row.free === 1, paid: row.paid === 1 }));
}

/**
 * The account's main counter (docs/billing-cycles-design-2026-10-08.md §2): the longest window that is not a scoped
 * sub-limit (Codex 10080, Claude `weekly_all`, GLM weekly). Shorter counters nest in it, so they are shown beside it and
 * never summed; billing capacity is calibrated from it only.
 */
export function mainCounterOf(counters: readonly Counter[]): Counter | null {
  const candidates = counters.filter((c) => !/scoped/i.test(c.kind)).sort((a, b) => b.minutes - a.minutes || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

/**
 * The main counter of a cycle on a Free or a paid plan (user decision 21.10): Codex's Free 30-day meter is longer than the
 * weekly one, so taking the account's longest counter left every paid cycle of an account that was once on Free without
 * windows. A counter whose windows carried only the other kind of plan is left out; one without known plans fits both.
 * Without a fitting counter, the account's main counter.
 */
export function mainCounterFor(counters: readonly Counter[], free: boolean): Counter | null {
  const fits = (c: Counter) => !c.plans || (!c.plans.free && !c.plans.paid) || (free ? c.plans.free : c.plans.paid);
  return mainCounterOf(counters.filter(fits)) ?? mainCounterOf(counters);
}

/** The distinct main counters of an account's Free and paid cycles. */
export function mainCountersOf(counters: readonly Counter[]): Counter[] {
  const found = [mainCounterFor(counters, false), mainCounterFor(counters, true)].filter((c): c is Counter => c !== null);
  return found.filter((c, i) => found.findIndex((other) => other.id === c.id) === i);
}
