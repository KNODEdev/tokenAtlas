import type { ApiCycle, CycleBreakdownResponse, RosterResponse, UsageSeries } from "./api";
import type { BillingCycle, BillingCyclesAccount } from "../../shared/billing-cycles";
import type { RateWindow } from "../../shared/subscription-rate";
import { previewContextAmount } from "../../shared/context-price";
import { pointBasisWithContext, currentPointBasis, creditBasisOf } from "../../shared/current-point-basis";
import type { RailWindow } from "./windows";
import { isContextPreviewSelected } from "../../shared/context-preview";
import { hasContextCompanion, isContextCompanionOwned } from "./context-companion";

/** Whole-window estimates share the whole-window ratio; buckets retain their own stored scope. */
export function cyclesWithContextPreview(cycles: ApiCycle[], on: boolean): ApiCycle[] {
  if (!on) return cycles;
  return cycles.map((cycle, index) => {
    const usd = previewContextAmount(cycle.usd, cycle.context_price, true);
    const previous = cycles[index - 1];
    const previousUsd = previous && previewContextAmount(previous.usd, previous.context_price, true);
    return { ...cycle, usd,
      ...(cycle.point_basis !== undefined ? { point_basis: pointBasisWithContext(cycle.point_basis, true) } : {}),
      usd_per_percent: previewContextAmount(cycle.usd_per_percent, cycle.context_price, true),
      usd_at_100_percent: previewContextAmount(cycle.usd_at_100_percent, cycle.context_price, true),
      delta_usd: previousUsd === undefined || cycle.delta_usd === null ? cycle.delta_usd
        : cycle.delta_usd + (usd - cycle.usd) - (previousUsd - previous!.usd),
      pct_of_prev_usd: previousUsd === undefined || usd === cycle.usd && previousUsd === previous!.usd
        ? cycle.pct_of_prev_usd : previousUsd > 0 ? usd / previousUsd * 100 : null,
      ...(cycle.at_limit ? { at_limit: { ...cycle.at_limit,
        api_standard: previewContextAmount(cycle.at_limit.api_standard, cycle.at_limit_context_price, true) } } : {}) };
  });
}

export function seriesWithContextPreview(series: UsageSeries, on: boolean): UsageSeries {
  if (!on) return series;
  const cycles = cyclesWithContextPreview(series.cycles, true);
  const closed = cycles.filter(cycle => !cycle.is_active && !cycle.shadow);
  return { ...series, cycles, stats: series.stats && { ...series.stats,
    total_usd: cycles.filter(cycle => !cycle.shadow).reduce((sum, cycle) => sum + cycle.usd, 0),
    avg_closed_usd: closed.length ? closed.reduce((sum, cycle) => sum + cycle.usd, 0) / closed.length : null } };
}

export function rosterWithContextPreview(roster: RosterResponse, on: boolean): RosterResponse {
  return !on ? roster : { ...roster, accounts: roster.accounts.map(account => {
    if (!["codex", "openai"].includes(account.vendor)) return account;
    const cycles = cyclesWithContextPreview(account.cycles, true);
    return { ...account, cycles, credit_basis: creditBasisOf(currentPointBasis(cycles)) ?? undefined };
  }) };
}

/** Fallback Codex window rails read /api/windows rather than /api/usage-series. */
export function railWithContextPreview(windows: RailWindow[], on: boolean): RailWindow[] {
  return !on ? windows : windows.map(window => window.counterKey?.startsWith("codex:")
    ? { ...window, usd: previewContextAmount(window.usd, window.context_price, true) } : window);
}

/** Totals use the matching stored span's ratio. Days, sessions, burn and model detail retain their recorded amounts. */
export function breakdownWithContextPreview<T extends CycleBreakdownResponse | null>(data: T, on: boolean): T {
  if (isContextPreviewSelected(data) || hasContextCompanion(data) || data?.context_preview_status) return data;
  return (!on || !data ? data : { ...data, totals: { ...data.totals,
    usd: previewContextAmount(data.totals.usd, data.totals.context_price, true) } }) as T;
}

export function billingCycleWithContextPreview(cycle: BillingCycle, on: boolean): BillingCycle {
  if(isContextPreviewSelected(cycle)||isContextCompanionOwned(cycle))return cycle;
  if (!on) return cycle;
  return { ...cycle, api_usd: previewContextAmount(cycle.api_usd, cycle.context_price, true),
    used_units: cycle.used_units && { ...cycle.used_units,
      api_usd: previewContextAmount(cycle.used_units.api_usd, cycle.context_price, true) } };
}

export function billingAccountWithContextPreview(account: BillingCyclesAccount, on: boolean): BillingCyclesAccount {
  return !on || account.provider !== "codex" ? account : { ...account,
    cycles: account.cycles.map(cycle => billingCycleWithContextPreview(cycle, true)) };
}

/** api_usd is whole-window work; capacity, rates and reference valuations have no matching split. */
export function rateWithContextPreview(window: RateWindow, on: boolean): RateWindow {
  if(isContextPreviewSelected(window)||isContextCompanionOwned(window))return window;
  return !on || window.provider !== "codex" ? window : { ...window,
    api_usd: previewContextAmount(window.api_usd, window.context_price, true) };
}
