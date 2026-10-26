import type { LedgerEvent } from "../db/usage-ledger-events";
import type { RateCard } from "./pricing";
import { addReferenceValuation } from "./subscription-revaluation";
import { emptyWindowUsage, type WindowAccountingAdapter } from "./subscription-window-comparison";
import { TOKEN_BUCKETS, priceSubscriptionEvent, subscriptionRateSelection, type SubscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import type { RateValues } from "./pricing";
import { vendorHasContextTier } from "./vendor-context-premium";

/**
 * The canonical admission and valuation of a provider's window traffic: the counter's own traffic with
 * a precise instant, valued at the ledger's stored Standard price (never priced here).
 */
export function subscriptionWindowAdapter(adapter: SubscriptionAccountingAdapter, counterGroup: string, counterMinutes: number,
  rateCards: RateCard, referenceDay?: string): WindowAccountingAdapter<LedgerEvent> {
  const tokensOf = (event: LedgerEvent) => TOKEN_BUCKETS.reduce((sum, key) => sum + event.quantities[key], 0);
  // Only a vendor with long-context tiers carries the context split (Claude Haiku above 100K), as Codex does.
  const contextTiers = vendorHasContextTier(rateCards, adapter.rateVendor);
  const valueAt = (event: LedgerEvent, rates: RateValues | undefined): number | null => {
    let total = 0;
    for (const key of TOKEN_BUCKETS) {
      const quantity = event.quantities[key];
      if (quantity === 0) continue;
      const rate = rates?.[key === "in_cache_write_unknown" ? "in_cache_write" : key];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return null;
      total += quantity * rate / 1e6;
    }
    return total;
  };
  return {
    windowMinutes: counterMinutes,
    // A call the provider billed from a promotional credit is outside the plan's window, as Codex credits are.
    include: event => event.precise_time && !event.funding && adapter.counterIncludes(counterGroup, event),
    exclusionReason: event => !adapter.counterIncludes(counterGroup, event) ? "counter" : event.funding ? "funding"
      : !event.precise_time ? "imprecise_time" : "counter",
    detail: event => ({ cache_write: event.quantities.in_cache_write_5m + event.quantities.in_cache_write_1h + event.quantities.in_cache_write_unknown, cache_write_in_input: true,
      pricing_issue: event.prices.standard!.reason ?? null }),
    usage: event => {
      const item = emptyWindowUsage(), standard = event.prices.standard!;
      item.events = 1; item.tokens = tokensOf(event); item.output = event.quantities.out_total;
      item.input = item.tokens - item.output; item.cached = event.quantities.in_cache_read;
      item.cache_write_5m = event.quantities.in_cache_write_5m; item.cache_write_1h = event.quantities.in_cache_write_1h; item.cache_write_unknown = event.quantities.in_cache_write_unknown;
      item.fast_tokens = event.speed === "fast" ? item.tokens : 0; item.unknown_tokens = event.speed === "unknown" ? item.tokens : 0;
      if (standard.amount !== null) { item.api_standard = standard.amount; item.priced_tokens = item.tokens; } else item.unpriced_events = 1;
      if (contextTiers) {
        // The stored value is with the uplift while the vendor's premium is on, at base rates while off; the other
        // side is measured from the same Standard block, so a preview can show both.
        const selection = subscriptionRateSelection(rateCards, adapter, event, true);
        if (selection.contextBand !== "unknown") {
          const long = selection.contextBand === "long";
          item.context_known_tokens = item.tokens; item.context_long_tokens = long ? item.tokens : 0; item.context_long_events = long ? 1 : 0;
          item.context_api_base = 0; item.context_api_extra = 0; item.context_priced_tokens = 0;
          const other = !long || standard.amount === null ? null
            : valueAt(event, selection.contextPremium ? selection.baseRates : selection.longRates);
          if (standard.amount !== null && (!long || other !== null)) {
            const base = !long || !selection.contextPremium ? standard.amount : other!;
            item.context_api_base = base;
            item.context_api_extra = !long ? 0 : selection.contextPremium ? Math.max(0, standard.amount - other!) : Math.max(0, other! - standard.amount);
            item.context_priced_tokens = item.tokens;
          }
        }
      }
      if (referenceDay !== undefined) addReferenceValuation(item, standard.amount, priceSubscriptionEvent(rateCards, adapter, event, true, referenceDay).amount);
      return item;
    },
  };
}
