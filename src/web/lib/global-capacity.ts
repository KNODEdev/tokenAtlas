import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { api, type ApiAccount } from "./api";
import type { RosterCard } from "./roster";
import { subscriptionAnalysisAdapter } from "./subscription-analysis";
import type { CapacityCyclesEntry } from "../../shared/capacity-cycles";
import { staleReportTime } from "./report-freshness";

export interface CapacityAccount { id: string; provider: string; active: boolean; label: string; }
export interface CapacityAccountResult {
  account: CapacityAccount; counter: string; counterLabel: string; windows: CodexComparisonWindow[]; error?: string; unavailable?: boolean;
  preparedAt?:number|null;
  /** Its stored sums are still being written in the background. */
  preparing?: boolean;
}
export function capacityAccounts(accounts: ApiAccount[], cards: RosterCard[]): CapacityAccount[] {
  const result = new Map<string, CapacityAccount>();
  for (const account of accounts) {
    if (["all", "__all__"].includes(account.id)) continue;
    const card = cards.find(card => card.id === account.id);
    const provider = subscriptionAnalysisAdapter(account.vendor ?? card?.group ?? "unknown").id;
    result.set(account.id, { id: account.id, provider, active: card?.active === true, label: account.label ?? card?.vendorAccount ?? account.login ?? account.id });
  }
  for (const card of cards) if (!result.has(card.id) && !["all", "__all__"].includes(card.id)) {
    result.set(card.id, { id: card.id, provider: subscriptionAnalysisAdapter(card.group).id, active: card.active, label: card.vendorAccount ?? card.id });
  }
  return [...result.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

/**
 * The cycles of every account in one read of the stored register (`/api/capacity-cycles`): nothing is computed for
 * this screen, so the comparison never waits behind per-subscription reports. Accounts without a stored answer
 * stay explicit: `unavailable` (no cycles of this window length), `preparing` (sums still being stored) or `error`.
 */
export async function readGlobalCapacity(accounts: CapacityAccount[], range: { since: string; until: string }, minutes: 300 | 10080 | 43200,
  signal?: AbortSignal): Promise<Map<string, CapacityAccountResult[]>> {
  const response = await api.capacityCycles({ ...range, window_minutes: minutes }, signal);
  const preparedAt = staleReportTime(response);
  const entries = new Map<string, CapacityCyclesEntry[]>();
  for (const entry of response.accounts) entries.set(entry.account, [...entries.get(entry.account) ?? [], entry]);
  return new Map(accounts.map((account): [string, CapacityAccountResult[]] => {
    const base = { account, counter: "", counterLabel: "", windows: [], ...(preparedAt === null ? {} : { preparedAt }) };
    const own = account.id.endsWith("::business") ? [] : entries.get(account.id.toLowerCase()) ?? [];
    if (!own.length) return [account.id, [{ ...base, unavailable: true }]];
    return [account.id, own.map(entry => ({ account, counter: entry.counter, counterLabel: entry.counter_label, preparedAt,
      windows: entry.windows.filter(window => window.account.toLowerCase() === account.id.toLowerCase() && (window.window_minutes ?? 10080) === minutes),
      ...(entry.preparing ? { preparing: true } : {}), ...(entry.unavailable ? { unavailable: true } : {}), ...(entry.error ? { error: entry.error } : {}) }))];
  }));
}
