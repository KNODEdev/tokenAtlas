import type { CodexAccountingConfig } from "./codex-accounting-pricing";
import type { CalibrationEvent } from "./codex-calibration";
import { codexWindowAdapter } from "./codex-window-comparison";
import { getPublishedCodexLedgerGroup, normalizePublishedCodexTier } from "./codex-priced-events";
import type { WindowTraffic, ClaudeWindowDetail } from "./window-usage-contracts";
import type { RateCard } from "./pricing";
import type { LedgerEvent } from "../db/usage-ledger-events";
import { parseCapacityCounter } from "../shared/manual-capacity";
import { subscriptionAccountingAdapter } from "./subscription-accounting-adapters";
import { subscriptionWindowAdapter } from "./subscription-window-adapter";

/** Codex traffic: the canonical adapter and the stored Standard API value of each call. */
export function codexWindowTraffic(config: CodexAccountingConfig, windowMinutes: number, referenceDay?: string): WindowTraffic<CalibrationEvent> {
  return {
    adapter: codexWindowAdapter(config, windowMinutes, referenceDay),
    units: true,
    facts: event => {
      const group = getPublishedCodexLedgerGroup(event);
      const standard = normalizePublishedCodexTier(event, "standard");
      return { model: event.model, speed: event.speed ?? "unknown", surface: group?.stored.surface ?? null,
        tokens: { in_uncached: Math.max(0, event.in_tok - event.cached_in), in_cache_read: event.cached_in,
          in_cache_write_5m: Math.max(0, event.cache_write || 0), in_cache_write_1h: 0, out_total: event.out_tok },
        reasoning: Number(group?.tokens.reasoning_out ?? 0n),
        api_standard: standard.standard_api_usd,
        // The ledger's Standard credit price, the basis of the window's credit equivalent (codex-window-detail.ts).
        credits_standard: standard.standard_credits,
        credit_funded: event.billing_mode === "credits" };
    },
  };
}

/**
 * Another provider's traffic on one counter, valued at the usage ledger's stored Standard price. A manual
 * measurement that accepts approximate times also counts traffic whose instant is only a file date.
 */
export function subscriptionWindowTraffic(provider: string, counter: string, rateCards: RateCard, referenceDay?: string,
  options: { approximateTime?: boolean; allModels?: boolean; claude?: ClaudeWindowDetail } = {}): WindowTraffic<LedgerEvent> {
  const [, group, minutes] = parseCapacityCounter(counter) ?? ["", "", 0];
  const accounting = subscriptionAccountingAdapter(provider);
  const adapter = subscriptionWindowAdapter(accounting, group, minutes, rateCards, referenceDay);
  return {
    adapter: options.approximateTime ? { ...adapter, include: event => !event.funding && accounting.counterIncludes(group, event) }
      // A span that is not one counter's (a gauge observation, a fallback) holds all the account's traffic by its recorded
      // instant: such a span is itself an approximation, and Gemini records conversation times only. Funded calls stay out.
      : options.allModels ? { ...adapter, include: event => !event.funding } : adapter,
    facts: event => ({ model: event.model, speed: event.speed, surface: null, reasoning: event.quantities.out_thinking,
      tokens: { in_uncached: event.quantities.in_uncached, in_cache_read: event.quantities.in_cache_read,
        in_cache_write_5m: event.quantities.in_cache_write_5m, in_cache_write_1h: event.quantities.in_cache_write_1h,
        out_total: event.quantities.out_total },
      api_standard: event.prices.standard?.amount ?? null,
      ...(event.funding ? { credit_funded: true } : {}),
      ...(event.reported ? { reported: event.reported.usd } : {}),
      ...(accounting.windowSession ? { session: accounting.windowSession(event) } : {}),
      ...(options.claude ? { api_actual: event.prices.actual?.amount ?? null, product: event.product ?? null } : {}) }),
    ...(options.claude ? { claude: options.claude } : {}),
  };
}
