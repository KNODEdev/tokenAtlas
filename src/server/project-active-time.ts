import type { Database } from "../db/sqlite";
import { unionActivity, type ActivityInterval } from "../db/activity-intervals";
import { currentProjectRules, placeSubject } from "../projects/rules-now";
import type { AccountReadPlan, AccountResolver } from "./account-resolver";
import { codexActivityKey, readActivityDays, readCodexOwnedDays, readCodexPlaces, readUsageLedgerPlaces,
  requireUsageLedgerSums } from "./ledger-sums";
import { ownedRegisterRows } from "./stored-history-usage";
import type { RateCard } from "./pricing";
import { resolveCodexSubId } from "./capacity-equivalents";

export interface ProjectActivity {
  subject: string | null; repo: string | null; source: string | null;
  vendor: string; model: string | null; account: string | null; intervals: ActivityInterval[];
}
const DAY = 86_400_000;
/** Adjacent pricing days can contain UTC intervals in the selected range, including midnight gaps. */
function activityReadRange(range: { since?: string; until?: string }): { since?: string; until?: string } {
  const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
  return { ...(range.since ? { since: shift(range.since, -2) } : {}), ...(range.until ? { until: shift(range.until, 2) } : {}) };
}

/** Reads prepared interval unions. Only the existing account-boundary/mixed-session exceptions read facts. */
export function readProjectActivity(db: Database, resolver: AccountResolver, rates: RateCard, cutoff: number,
  range: { since?: string; until?: string }): ProjectActivity[] {
  const expanded = activityReadRange(range), rules = currentProjectRules(db), result: ProjectActivity[] = [];
  for (const provider of ["claude", "grok", "glm"] as const) {
    if (!requireUsageLedgerSums(db, provider)) continue;
    const dims = readUsageLedgerPlaces(db, provider);
    const plans = ownedRegisterRows(db, provider, rates, { ...expanded, resolver }).plans;
    const collect = (plan: AccountReadPlan, kind: "e" | "o") => {
      const intervals = new Map<string, ActivityInterval[]>();
      readActivityDays(db, provider, plan, cutoff, expanded, kind, intervals);
      for (const [key, spans] of intervals) {
        const [day, dim] = key.split("|"), place = dims.get(dim!)!;
        result.push({ subject: placeSubject(rules, provider, place, day!), repo: place.repo, source: place.source,
          vendor: kind === "o" ? "opencode" : provider, model: place.model, account: kind === "o" ? place.home : plan.account, intervals: spans });
      }
    };
    for (const plan of plans) collect(plan, "e");
    if (provider === "glm") collect({ provider, account: "*", identityKeys: [], ranges: [], owns: () => true, days: () => [] }, "o");
  }
  const codex = new Map<string, ActivityInterval[]>();
  const rows = readCodexOwnedDays(db, resolver, cutoff, expanded, codex);
  if (rows.size) {
    const dims = readCodexPlaces(db);
    for (const row of rows.values()) {
      const place = dims.get(row.dim)!, spans = codex.get(codexActivityKey(row.day, row.dim, row.owner));
      if (spans?.length) result.push({ subject: placeSubject(rules, "codex", place, row.day), repo: place.repo, source: place.source,
        vendor: "codex", model: place.model, account: resolveCodexSubId(row.owner), intervals: spans });
    }
  }
  const from = range.since ? Date.parse(`${range.since}T00:00:00Z`) : -Infinity;
  const until = range.until ? Date.parse(`${range.until}T00:00:00Z`) + DAY : Infinity;
  return result.map(row => ({ ...row, intervals: row.intervals.map(([a, b]): ActivityInterval => [Math.max(a, from), Math.min(b, until)])
    .filter(([a, b]) => b > a) })).filter(row => row.intervals.length > 0);
}

/** UTC days are disjoint; counting per machine after union guarantees at most 24 h per day per PC. */
export function activityByDay(rows: readonly ProjectActivity[], machineOf: (source: string | null) => string | null):
  Map<string, Map<string, ActivityInterval[]>> {
  const days = new Map<string, Map<string, ActivityInterval[]>>();
  for (const row of rows) for (const [from, until] of row.intervals) {
    const machine = machineOf(row.source)?.trim().toUpperCase() || "?";
    for (let start = from; start < until;) {
      const day = new Date(start).toISOString().slice(0, 10), end = Math.min(until, Date.parse(day) + DAY);
      const parts = days.get(day) ?? new Map<string, ActivityInterval[]>();
      const spans = parts.get(machine) ?? []; spans.push([start, end]); parts.set(machine, spans); days.set(day, parts);
      start = end;
    }
  }
  for (const parts of days.values()) for (const [machine, spans] of parts) parts.set(machine, unionActivity(spans));
  return days;
}

export const intervalSeconds = (spans: readonly ActivityInterval[]) => spans.reduce((sum, [a, b]) => sum + (b - a), 0) / 1000;
