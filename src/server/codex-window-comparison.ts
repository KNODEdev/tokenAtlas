import { CODEX_CREDIT_BILLING_START, type CodexAccountingConfig } from "./codex-accounting-pricing";
import { normalizePublishedCodexTier, pricePublishedCodexEvent as priceCodexEvent,
  getPublishedCodexLedgerGroup, publishedCodexContext } from "./codex-priced-events";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { addReferenceValuation } from "./subscription-revaluation";
import type { CalibrationEvent } from "./codex-calibration";
import { emptyWindowUsage as empty, type WindowAccountingAdapter } from "./subscription-window-comparison";
export type { CodexComparisonWindow, WindowUsage } from "../shared/codex-accounting";

/**
 * Models that do not draw on the weekly allowance. Spark answers to a separate counter, and the
 * reserve tier is offered beside the subscription for use once the allowance is spent. Recorded
 * readings agree: the meter stays flat across reserve traffic. Counting either would add tokens
 * to a cycle without the matching meter movement and understate the value of one point.
 */
export const CODEX_RESERVE_MODEL = "gpt-reserve";
/** The reserve pool's own counter; the engine stores reserve turns' readings under it. */
export const CODEX_RESERVE_LIMIT_ID = "base_model_inference";
const OUTSIDE_WEEKLY_ALLOWANCE = new Set(["gpt-5.3-codex-spark", CODEX_RESERVE_MODEL]);
type Funded = { model: string | null; billing_mode?: string | null };
const drawsOnAllowance = (event: Funded): boolean => !OUTSIDE_WEEKLY_ALLOWANCE.has(event.model ?? "")
  && event.billing_mode !== "business_credits" && event.billing_mode !== "credits";
const outsideReason = (event: Funded): "counter" | "funding" => event.model === "gpt-5.3-codex-spark" ? "counter" : "funding";

/**
 * The canonical Codex admission and valuation of window traffic: Spark, the reserve tier and
 * credit-funded calls are left out with their reason, a weekly event pairs only with its own
 * recorded reset, and the window_* amounts are one jointly priced cohort of stored prices.
 */
export function codexWindowAdapter(config: CodexAccountingConfig, windowMinutes: number,
  referenceDay?: string): WindowAccountingAdapter<CalibrationEvent> {
  return {
    windowMinutes,
    // The importer stores the weekly slot in events.meter_reset, even when a 5h slot coexists.
    meterReset: event => windowMinutes === 10080 ? event.meter_reset : null,
    include: drawsOnAllowance,
    exclusionReason: outsideReason,
    detail: event => {
      const known = getPublishedCodexLedgerGroup(event)?.tier != null;
      const normalized = normalizePublishedCodexTier(event, known ? event.speed : "standard");
      return { cache_write: event.cache_write_status === "missing" || event.cache_write_status === "invalid" ? null : event.cache_write, cache_write_in_input: false,
        pricing_issue: normalized.reason ?? (known ? null : priceCodexEvent(config, { ...event, speed: "fast" }, "chatgpt_credits").reason) };
    },
    usage: event => {
      // A cohort's token fields are its calls' sums; its prices are the stored sums of the same calls.
      const calls = event.calls ?? 1;
      const item = empty(); item.events = calls;
      if ([event.in_tok, event.out_tok, event.cached_in].every(n => Number.isSafeInteger(n) && n >= 0) && event.cached_in <= event.in_tok) {
        item.input = event.in_tok; item.cached = event.cached_in; item.output = event.out_tok; item.tokens = item.input + item.output;
      }
      const known = getPublishedCodexLedgerGroup(event)?.tier != null;
      item.fast_tokens = known && event.speed !== "standard" ? item.tokens : 0;
      item.unknown_tokens = known ? 0 : item.tokens;
      const normalized = normalizePublishedCodexTier(event, known ? event.speed : "standard");
      const api = normalized.standard_api_usd, low = normalized.credits;
      const context = publishedCodexContext(event);
      if (context) {
        item.context_known_tokens = Number(context.knownTokens);
        item.context_long_tokens = Number(context.longTokens);
        item.context_long_events = Number(context.longCalls);
        item.context_api_base = 0; item.context_api_extra = 0; item.context_priced_tokens = 0;
      }
      const addContextPrice = () => {
        if (!context || context.base === null || context.extra === null || api === null || item.api_normalized === undefined) return;
        const weight = api === 0 ? 1 : item.api_normalized / api;
        item.context_api_base = ledgerPresentationNumber(context.base) * weight;
        item.context_api_extra = ledgerPresentationNumber(context.extra) * weight;
        item.context_priced_tokens = item.tokens;
      };
      if (referenceDay !== undefined) addReferenceValuation(item, api, priceCodexEvent(config, { ...event, speed: "standard" }, "api_equivalent_usd", referenceDay).amount);
      const high = known ? low : priceCodexEvent(config, { ...event, speed: "fast" }, "chatgpt_credits").amount;
      item.api_normalized = 0;
      // Before credit billing began there was no credit burden to weight the API value by,
      // and no credit rate to miss: such an event is fully priced on its API value alone.
      if (event.ts.slice(0, 10) < CODEX_CREDIT_BILLING_START) {
        if (api !== null) {
          item.api_standard = api; item.api_normalized = api; item.priced_tokens = item.tokens;
          item.credits_unavailable_events = calls;
          addContextPrice();
        } else item.unpriced_events = calls;
        return item;
      }
      // All three columns use the same priced cohort so their denominators are comparable.
      if (api !== null && low !== null && high !== null && normalized.normalized_usd !== null) {
        item.api_standard = api; item.credits_low = low; item.credits_high = high; item.priced_tokens = item.tokens;
        item.api_normalized = normalized.normalized_usd;
        addContextPrice();
      } else item.unpriced_events = calls;
      return item;
    },
  };
}
