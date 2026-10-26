import type { AppContext } from "./app-context-types";
import { CODEX_COUNTERS, isCodexWindowMinutes } from "../shared/codex-counters";
export { CODEX_COUNTERS } from "../shared/codex-counters";
import type { CodexComparisonWindow } from "../shared/codex-accounting";
import type { CapacityCyclesEntry, CapacityCyclesResponse } from "../shared/capacity-cycles";
import { parseCapacityCounter } from "../shared/manual-capacity";
import { ledgerProviderOf } from "./subscription-accounting-adapters";
import { readManualCapacity } from "./manual-capacity";
import { loadPlans } from "./plans";
import { loadPlansCatalog } from "./plans-catalog";
import { hasCapacityCycleResults } from "../db/capacity-cycle-results";
import { capacityCycleConfiguration, capacityCycleStateKey, capacityCycleSubjects, type CapacityCycleResultRow } from "./capacity-cycle-producer";
import { withReadSnapshot } from "../db/analysis";
import { limitWindowsReady } from "../db/limit-windows";
import { codexLimitCounter } from "./codex-limit-windows";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string) => DAY.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** The register provider of a declared subscription: Codex or a shared-ledger provider (as window-screens.ts). */
export function capacityProviderOf(vendor: string | undefined): string | null {
  const name = (vendor || "codex").toLowerCase();
  return ["codex", "openai"].includes(name) ? "codex" : ledgerProviderOf(name)?.id ?? null;
}
export const capacityCounterLabel =(counter: string) => {
  const parts = parseCapacityCounter(counter);
  return parts ? [parts[0], parts[1], `${parts[2]}m`].filter(Boolean).join(" · ") : counter;
};

/** Ordinary reads select completed per-cycle projections; missing work belongs to the background writer. */
export function handleCapacityCycles(ctx: AppContext, url: URL, selection: { account?: string; allowStale?: boolean } = {}): Response {
  const since = url.searchParams.get("since") ?? "", until = url.searchParams.get("until") ?? "";
  const minutes = Number(url.searchParams.get("window_minutes") ?? 10080);
  if (!validDay(since) || !validDay(until) || since > until) return Response.json({ error: "Expected since and until as YYYY-MM-DD" }, { status: 400 });
  if (!isCodexWindowMinutes(minutes)) return Response.json({ error: "Expected window_minutes 300 or 10080 or 43200" }, { status: 400 });
  ctx = { ...ctx, plans: ctx.plans ?? loadPlans(), plansCatalog: ctx.plansCatalog ?? loadPlansCatalog() };
  return withReadSnapshot(ctx.sqlite, () => {
    const available = hasCapacityCycleResults(ctx.sqlite);
    const start = new Date(since).toISOString();
    const end = new Date(Date.parse(until) + 86_400_000).toISOString();
    const rows = available ? ctx.sqlite.query(`SELECT * FROM capacity_cycle_results WHERE window_minutes=? AND start_ts<?
      AND (end_ts>? OR (window_id LIKE 'manual:%' AND end_ts=?)) AND (? IS NULL OR account=?) ORDER BY start_ts,window_id`)
      .all(minutes, end, start, start, selection.account ?? null, selection.account ?? null) as CapacityCycleResultRow[] : [];
    const states = available ? new Map((ctx.sqlite.query("SELECT key,value FROM capacity_cycle_result_state").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value])) : new Map<string, string>();
    // A mark can touch another part of a full cycle outside the date filter, including a newly published identity.
    const queued = available ? ctx.sqlite.query(`SELECT DISTINCT d.provider,d.account FROM capacity_cycle_result_dirty d WHERE
      (? IS NULL OR d.account='*' OR d.account=?) AND ((d.from_ms < ? AND (d.until_ms IS NULL OR d.until_ms > ?))
      OR EXISTS(SELECT 1 FROM capacity_cycle_results w WHERE (d.provider='*' OR d.provider=w.provider) AND (d.account='*' OR d.account=w.account)
        AND (? IS NULL OR w.account=?)
        AND w.window_minutes=? AND w.start_ts<? AND w.end_ts>?
        AND d.from_ms < julianday(w.end_ts)*86400000-210866760000000+1 AND (d.until_ms IS NULL OR d.until_ms > julianday(w.start_ts)*86400000-210866760000000-1))
      OR EXISTS(SELECT 1 FROM limit_windows w WHERE (d.provider='*' OR d.provider=w.provider) AND (d.account='*' OR d.account=w.account)
        AND (? IS NULL OR w.account=?)
        AND w.window_minutes=? AND w.start_ts<? AND w.end_ts>?
        AND d.from_ms < julianday(w.end_ts)*86400000-210866760000000+1 AND (d.until_ms IS NULL OR d.until_ms > julianday(w.start_ts)*86400000-210866760000000-1)))`)
      .all(selection.account ?? null, selection.account ?? null, Date.parse(end), Date.parse(start), selection.account ?? null, selection.account ?? null,
        minutes, end, start, selection.account ?? null, selection.account ?? null, minutes, end, start) as Array<{ provider: string; account: string }> : [];
    const manual = new Map<string, ReturnType<typeof readManualCapacity>["measurements"]>();
    const accounts: CapacityCyclesEntry[] = [];
    for (const [account, provider] of capacityCycleSubjects(ctx)) {
      if (selection.account && account !== selection.account) continue;
      const measurements = manual.get(provider) ?? (provider === "codex" ? [] : readManualCapacity(provider).measurements); manual.set(provider, measurements);
      const configurationReady = states.get(capacityCycleStateKey(provider, account)) === capacityCycleConfiguration(ctx, provider, account, measurements);
      const scopeQueued = queued.some(scope => (scope.provider === "*" || scope.provider === provider) && (scope.account === "*" || scope.account === account));
      const selected = rows.filter(row => row.provider === provider && row.account === account);
      const counters = provider === "codex" ? [CODEX_COUNTERS[minutes].id] : [...new Set(selected.map(row => row.counter))].sort();
      const before = accounts.length;
      for (const counter of counters) {
        const group = selected.filter(row => provider === "codex" || row.counter === counter);
        const base = { account, provider, counter, counter_label: provider === "codex" ? CODEX_COUNTERS[minutes].label : capacityCounterLabel(counter), windows: [] as CodexComparisonWindow[] };
        if (selection.allowStale && group.some(row => row.error)) {
          accounts.push({ ...base, error: group.find(row => row.error)!.error! });
          continue;
        }
        if (!configurationReady || scopeQueued || !limitWindowsReady(ctx.sqlite, provider, account, provider === "codex" ? codexLimitCounter(minutes) : counter)
          || group.some(row => row.dirty || row.preparing)) {
          const completed = group.filter(row => row.body && !row.error).map(row => JSON.parse(row.body!) as CodexComparisonWindow);
          accounts.push(selection.allowStale && completed.length && !group.some(row => row.error)
            ? { ...base, windows: completed, stale: true } : { ...base, preparing: true });
        }
        else if (group.some(row => row.error)) accounts.push({ ...base, error: group.find(row => row.error)!.error! });
        else accounts.push({ ...base, windows: group.flatMap(row => row.body ? [JSON.parse(row.body) as CodexComparisonWindow] : []) });
      }
      if (provider !== "codex") {
        const answered = accounts.splice(before), kept = answered.filter(entry => entry.windows.length || entry.preparing || entry.error);
        accounts.push(...(kept.length ? kept : [{ account, provider, counter: "", counter_label: "", windows: [],
          ...(configurationReady && !scopeQueued ? { unavailable: true as const } : { preparing: true as const }) }]));
      }
    }
    return Response.json({ since, until, window_minutes: minutes, accounts } satisfies CapacityCyclesResponse);
  });
}
