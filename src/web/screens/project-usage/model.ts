import type { Equivalent, ProjectCostResponse, SubjectRow } from "../../lib/api";
import { subscriptionPlanHistory } from "../../lib/subscription-plan";

export type SortKey = "api" | "tokens" | "time" | "share";
export type MixSlice = {
  id: string;
  plan: string | null;
  /** API-eq of the subject's traffic on this subscription. */
  api: number;
  billed: number | null;
  weekly: Equivalent;
  monthly: Equivalent;
};
export function rankingCostOf(cost: ProjectCostResponse | null | undefined): {
  billed: Map<string, number | null>;
  billedComplete: Map<string, boolean>;
  api: Map<string, number>;
  share: Map<string, number | null>;
  mix: Map<string, MixSlice[]>;
} {
  const billed = new Map<string, number | null>();
  const billedComplete = new Map<string, boolean>();
  const api = new Map<string, number>();
  const share = new Map<string, number | null>();
  const mix = new Map<string, MixSlice[]>();
  const planOf = new Map((cost?.subscriptions ?? []).map((s) => [s.id.toLowerCase(), subscriptionPlanHistory(s)]));
  for (const c of cost?.subjects ?? []) {
    billed.set(c.subject, c.billed_usd);
    billedComplete.set(c.subject, c.billed_complete);
    api.set(c.subject, c.api_usd);
    share.set(c.subject, c.share_of_priced_spend_pct);
    const slices = Object.entries(c.subscriptions)
      .map(([id, s]) => ({
        id,
        plan: planOf.get(id.toLowerCase()) ?? null,
        api: s.api_usd,
        billed: s.billed_usd,
        weekly: s.equivalents.weekly_cycles,
        monthly: s.equivalents.monthly_subscriptions,
      }))
      .sort(
        (a, b) =>
          (b.billed ?? Number.NEGATIVE_INFINITY) - (a.billed ?? Number.NEGATIVE_INFINITY),
      );
    mix.set(c.subject, slices);
  }
  return { billed, billedComplete, api, share, mix };
}
function sortValue(n: number | null | undefined): number {
  return n == null ? Number.NEGATIVE_INFINITY : n;
}
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) + 1 : 0;
}
export function rangeDaysOf(cost: ProjectCostResponse | null): number | null {
  if (!cost) return null;
  let first: string | null = null;
  let last: string | null = null;
  for (const s of cost.subscriptions) {
    if (s.first_day && (!first || s.first_day < first)) first = s.first_day;
    if (s.last_day && (!last || s.last_day > last)) last = s.last_day;
  }
  return first && last ? daysBetween(first, last) : null;
}
/** Days of wall-clock time the range spans: the preset, or the recorded span for the whole history. */
export function spanDays(range: string, cost: ProjectCostResponse | null): number | null {
  const days = Number(range);
  return range !== "all" && Number.isFinite(days) && days > 0 ? days : rangeDaysOf(cost);
}
/**
 * How many agent sessions ran at once on average: summed session time over the range's wall-clock
 * time. Parallel sessions add up, so the session total is not working time.
 */
export function agentParallelism(totalSeconds: number, days: number | null): number | null {
  return days != null && days > 0 && totalSeconds > 0 ? totalSeconds / (days * 86_400) : null;
}
export function subjectKey(row: { kind: "project" | "repo"; id: string }): string {
  return `${row.kind === "project" ? "p" : "r"}:${row.id}`;
}
/** The ranking order; API-eq by default (UI audit decision 15), a subject without a value last. */
export function sortSubjects(rows: SubjectRow[], key: SortKey, cost: ReturnType<typeof rankingCostOf>): SubjectRow[] {
  const value = (row: SubjectRow): number =>
    key === "tokens" ? row.tokens
      : key === "time" ? row.active_seconds
      : key === "share" ? sortValue(cost.billed.get(subjectKey(row)))
      : sortValue(cost.api.get(subjectKey(row)));
  return [...rows].sort((a, b) => value(b) - value(a));
}
export interface GeneratedProjectCost {
  generation: number;
  payload: ProjectCostResponse;
}
export function costForRequest(
  state: { data: GeneratedProjectCost | null; error: string | null; loading: boolean },
  expected: { generation: number; since?: string },
): ProjectCostResponse | null {
  const result = state.data;
  // A reload of the same scope keeps the previous answer on screen; generation and range decide what matches.
  if (state.error != null || result == null) return null;
  if (result.generation !== expected.generation) return null;
  return (result.payload.since ?? null) === (expected.since ?? null) ? result.payload : null;
}
