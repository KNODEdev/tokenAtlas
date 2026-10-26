import { api, type ApiAccount, type HistoryCoverageRow } from "./api";
import { useAsync } from "./useAsync";
import { codexCounterMinutes } from "../../shared/codex-counters";

export type RecordedRange = { since: string; until: string };

/** Bounds come from stored coverage, including meter-only history and unattributed traffic. */
export function recordedRange(rows: readonly {
  usage: Pick<HistoryCoverageRow["usage"], "first_day" | "last_day">;
  gauge: Pick<HistoryCoverageRow["gauge"], "first_at" | "last_at">;
}[], accounts: readonly Pick<ApiAccount, "first_event_ts" | "last_event_ts">[], gauges: boolean): RecordedRange | null {
  const first = rows.flatMap(row => [row.usage.first_day, ...(gauges ? [row.gauge.first_at] : [])]);
  const last = rows.flatMap(row => [row.usage.last_day, ...(gauges ? [row.gauge.last_at] : [])]);
  first.push(...accounts.map(account => account.first_event_ts));
  last.push(...accounts.map(account => account.last_event_ts));
  const days = (values: (string | null)[]) => values.flatMap(value => value ? [value.slice(0, 10)] : []).sort();
  const since = days(first)[0], until = days(last).at(-1);
  return since && until ? { since, until } : null;
}

/** Read metadata only when All is selected; the normal API refresh keeps its bounds current. */
export function useRecordedRange(enabled: boolean, account?: string, gauges = true, capacityCounter?: string | null) {
  const state = useAsync(async signal => {
    if (!enabled) return null;
    if (account && capacityCounter !== undefined) {
      const minutes = capacityCounter === null ? null : codexCounterMinutes(capacityCounter);
      if (capacityCounter !== null && minutes === null) throw new Error("Invalid Codex counter");
      return api.codexCapacityRange({ account, ...(minutes ? { window_minutes: minutes } : {}) }, signal);
    }
    const [coverage, accounts] = await Promise.all([
      api.historyCoverage(account, signal),
      account ? Promise.resolve(null) : api.accounts(signal),
    ]);
    return { range: recordedRange(coverage.subscriptions, accounts?.subscriptions ?? [], gauges) };
  }, [enabled, account, gauges, capacityCounter]);
  // A refresh retains the completed bounds, including an empty history, until its replacement arrives.
  return { ...state, data: state.data?.range ?? null, ready: !enabled || state.data !== null };
}
