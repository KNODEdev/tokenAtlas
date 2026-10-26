import { useEffect, useSyncExternalStore } from "react";
import type { MissingRateSummary, UnpricedModel } from "../../shared/missing-rate";
import { api } from "./api";
import { compact } from "./format";
import { getLocale, translate } from "./i18n";
import { useAsync } from "./useAsync";

export { missingRateIn } from "../../shared/missing-rate";

let latest: MissingRateSummary | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => latest;

/** The last summary read; tests and server rendering seed it here. */
export function setMissingRates(summary: MissingRateSummary | null): void {
  if (summary === latest) return;
  latest = summary;
  for (const listener of listeners) listener();
}

/** Missing-rate models over the whole history (`/api/missing-rates`); null until first read. */
export function useMissingRates(): MissingRateSummary | null {
  // No signal: every card and the status bar share one memoized request.
  // Async, so a request that cannot even start (no browser location) is a failed read, not a render error.
  const read = useAsync(async () => api.missingRates(), []).data;
  useEffect(() => { if (read) setMissingRates(read); }, [read]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The Settings rate table's unpriced rows from the same summary as the alert: the models to price, then the
 * vendors without a rate card (listed, not priceable there).
 */
export function unpricedTableRows(summary: MissingRateSummary | null | undefined) {
  if (!summary) return undefined;
  return { tokens: summary.tokens, items: [
    ...summary.models.map(row => ({ ...row, reason: "missing_rate" })),
    ...(summary.unpriceable ?? []).map(row => ({ ...row, reason: "no_rate_card" })),
  ] };
}

/** "2,3 mld tokenów" / "2.3B tokens". */
export function tokenAmount(tokens: number): string {
  if (getLocale() !== "pl-PL") return `${compact(tokens)} ${translate(tokens === 1 ? "token" : "tokens", "tokenów")}`;
  const one = (value: number) => value.toLocaleString(getLocale(), { maximumFractionDigits: 1, useGrouping: false });
  const abs = Math.abs(tokens);
  if (abs >= 1e9) return `${one(tokens / 1e9)} mld tokenów`;
  if (abs >= 1e6) return `${one(tokens / 1e6)} mln tokenów`;
  if (abs >= 1e3) return `${one(tokens / 1e3)} tys. tokenów`;
  return `${tokens} ${tokens === 1 ? "token" : [2, 3, 4].includes(tokens % 10) && ![12, 13, 14].includes(tokens % 100) ? "tokeny" : "tokenów"}`;
}

/** "gpt-6.1-sol (2,3 mld tokenów), …": the largest three, then how many more. */
export function missingRateModelsText(models: readonly UnpricedModel[], limit = 3): string {
  const shown = models.slice(0, limit).map(row => `${row.model} (${tokenAmount(row.tokens)})`);
  const rest = models.length - shown.length;
  return shown.join(", ") + (rest > 0 ? translate(" and {0} more", ` i ${rest} więcej`, [rest]) : "");
}

/** The status bar's alert: which models lack a price (the largest `limit`) and where to enter it. */
export function missingRateAlert(summary: MissingRateSummary | null | undefined, limit = 3): { title: string; detail: string } | null {
  if (!summary?.models.length) return null;
  return {
    title: summary.models.length === 1 ? translate("New model without a price", "Nowy model bez ceny")
      : translate("New models without a price", "Nowe modele bez ceny"),
    detail: `${missingRateModelsText(summary.models, limit)} — ${translate("enter the price in Settings → Price lists → Models",
      "wpisz cenę w Ustawieniach → Cenniki → Modele")}`,
  };
}

/** Tooltip of an amount that leaves out missing-rate tokens. */
export function missingRateAmountTitle(models: readonly UnpricedModel[]): string {
  return `${translate("Incomplete amount. No price in the rate card for", "Kwota niepełna. Brak ceny w cenniku dla")}: ${missingRateModelsText(models)}. `
    + translate("These tokens are not included and no price is estimated for them. Enter the price in Settings → Price lists → Models.",
      "Te tokeny nie są wliczone i nie szacujemy ich ceny. Wpisz cenę w Ustawieniach → Cenniki → Modele.");
}

/** "+ no price: gpt-6.1-sol" beside an amount that leaves those models out. */
export function missingRateNote(models: readonly UnpricedModel[]): string {
  return `+ ${translate("no price", "brak ceny")}: ${models.map(row => row.model).join(", ")}`;
}
