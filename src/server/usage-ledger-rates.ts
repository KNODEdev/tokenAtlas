import type { RateCard } from "./pricing";
import { configuredSubscriptionModelKey, subscriptionRateSelection, TOKEN_BUCKETS, UNKNOWN_MODE_RATE_RULE,
  type SubscriptionAccountingAdapter, type SubscriptionEvent, type SubscriptionRateEvent, type TokenBucket, type TokenQuantities } from "./subscription-accounting-adapters";
import { femtoPerToken } from "../db/usage-ledger";
import { isAccountingDay, longContextPremium, type CodexAccountingConfig } from "./codex-accounting-pricing";
import { isCodexInternalReview } from "../shared/codex-internal";
import { contextBand } from "../shared/context-tier";

/**
 * Rate keys of the usage ledger. A key names everything the dated rate of one valuation depends
 * on: the rate vendor, the card's model entry, standard or actual mode, the mode the event
 * records, and whether the event falls after the entry's `until`. The rates themselves are read
 * from the card for the key, so a card edit changes the rates of a key without touching facts,
 * and only facts whose key's entry changed are valued again.
 */
/** Femto-dollars per token per bucket; null for a missing rate, "invalid" when not exactly representable. */
export type LedgerRates = Record<TokenBucket, bigint | null | "invalid">;
export interface LedgerRateChoice {
  key: string;
  rates: LedgerRates;
}
type RateAdapter = Pick<SubscriptionAccountingAdapter, "rateVendor" | "speed">;

/**
 * The mode part of a key: what `subscriptionRateSelection` distinguishes, nothing more. An unknown mode
 * also names the rule that values it, so a change of that rule revalues exactly its facts, those
 * without a model rate included (their rates stay empty, only their reason changes).
 */
function modeOf(adapter: RateAdapter, speed: string, standard: boolean): string {
  if (standard) return "-";
  if (speed === "fast") return "fast";
  return adapter.speed && speed !== "standard" ? `unknown:${UNKNOWN_MODE_RATE_RULE}` : "standard";
}

export function ledgerRateChoice(card: RateCard, adapter: RateAdapter,
  event: SubscriptionRateEvent, standard: boolean): LedgerRateChoice {
  const selection = subscriptionRateSelection(card, adapter, event, standard);
  const entry = configuredSubscriptionModelKey(card, adapter.rateVendor, event.model);
  const parts: unknown[] = [adapter.rateVendor, entry, modeOf(adapter, event.speed, standard), selection.after ? 1 : 0];
  // Moving the threshold can split a previously uniform rate-key group.
  if (selection.contextBand !== null) parts.push(selection.contextBand, selection.contextThreshold);
  // A long or unsized request keyed without the premium is valued at base rates: a distinct key, not new rates of the old one.
  if (selection.contextBand !== null && selection.contextBand !== "base" && !selection.contextPremium) parts.push("premium-off");
  const key = JSON.stringify(parts);
  return { key, rates: ledgerRatesOf(selection.rate) };
}

/** The bucket rates of one selected card rate, as `priceSubscriptionEvent` reads them. */
export function ledgerRatesOf(selected: object | undefined): LedgerRates {
  const rate = selected as Record<string, unknown> | undefined;
  const rates = {} as LedgerRates;
  for (const bucket of TOKEN_BUCKETS) {
    const raw = rate?.[bucket === "in_cache_write_unknown" ? "in_cache_write" : bucket];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) { rates[bucket] = null; continue; }
    rates[bucket] = femtoPerToken(raw) ?? "invalid";
  }
  return rates;
}

export interface LedgerValuation {
  /** Null when priced (an unknown mode is priced at Standard); otherwise `invalid_cache_totals`, `missing_rate` or `invalid_valuation`. */
  reason: string | null;
  /** Femto-dollars of every computable bucket: the register's `subtotal`, the amount when priced. */
  subtotal: bigint;
}

/**
 * Exact twin of `priceSubscriptionEvent`: a bucket with no tokens costs exactly zero whatever the
 * card says, a missing rate for a nonzero bucket leaves the event unpriced but keeps the computable
 * buckets in the subtotal, and invalid usage counts nothing.
 */
export function valueLedgerQuantities(quantities: Pick<TokenQuantities, TokenBucket>, usageValid: boolean,
  choice: Pick<LedgerRateChoice, "rates">): LedgerValuation {
  if (!usageValid) return { reason: "invalid_cache_totals", subtotal: 0n };
  let subtotal = 0n, complete = true;
  for (const bucket of TOKEN_BUCKETS) {
    const quantity = quantities[bucket];
    if (quantity === 0) continue;
    const rate = choice.rates[bucket];
    if (rate === "invalid") return { reason: "invalid_valuation", subtotal: 0n };
    if (rate === null) { complete = false; continue; }
    subtotal += BigInt(quantity) * rate;
  }
  return { reason: complete ? null : "missing_rate", subtotal };
}

/** An exact femto rate times a card multiplier, or null when the product is not an integer. */
function scaleExact(value: bigint, multiplier: number): bigint | null {
  const factor = femtoPerToken(multiplier);
  if (factor === null) return null;
  const product = value * factor, divisor = 10n ** 9n;
  return product % divisor === 0n ? product / divisor : null;
}

/**
 * Global usage prices an OpenCode row that names OpenAI by the Codex accounting rules, as
 * `priceCodexEvent` does with the API basis; this is its exact twin. The key names the rule and
 * whether the long-context rates applied, so a rule edit revalues only its rows.
 */
export function codexGlobalValuation(config: CodexAccountingConfig, fact: { model: string | null; speed: string; ts: string;
  quantities: Pick<TokenQuantities, TokenBucket> }): LedgerValuation & { key: string } {
  const q = fact.quantities;
  const write = q.in_cache_write_unknown + q.in_cache_write_5m + q.in_cache_write_1h;
  // The ledger's buckets are disjoint; their sum is the prompt input Codex reports as `in_tok`.
  const input = q.in_uncached + q.in_cache_read + write;
  const absent = (reason: string) => ({ key: JSON.stringify(["codex", null, reason]), reason, subtotal: 0n });
  if (isCodexInternalReview(fact.model)) return absent("missing_rate");
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(input + q.out_total)) return absent("invalid_tokens");
  const day = fact.ts.slice(0, 10);
  if (!isAccountingDay(day) || !Number.isFinite(Date.parse(fact.ts))) return absent("invalid_timestamp");
  if (fact.speed !== "fast" && fact.speed !== "standard") return absent("unknown_speed");
  const rule = config.rules.find(r => r.model === fact.model && r.speed === fact.speed && r.billing_basis === "api_equivalent_usd"
    && day >= r.valid_from && (!r.valid_until || day < r.valid_until));
  if (!rule) return absent("missing_rate");
  const long = longContextPremium(config) && contextBand(rule.long_context, input) === "long";
  const rates = long ? rule.long_context!.rates : rule.rates;
  const key = JSON.stringify(["codex", rule.id, long ? 1 : 0]);
  if (write > 0 && rates.in_cache_write == null) return { key, reason: "missing_cache_write_rate", subtotal: 0n };
  const parts: Array<[number, number | null | undefined]> = [[q.in_uncached, rates.in_uncached], [q.in_cache_read, rates.in_cache_read],
    [write, write === 0 ? 0 : rates.in_cache_write], [q.out_total, rates.out_total]];
  let subtotal = 0n;
  for (const [quantity, rate] of parts) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return { key, reason: "invalid_tokens", subtotal: 0n };
    const femto = femtoPerToken(rate);
    const scaled = femto === null ? null : scaleExact(femto, rule.multiplier);
    if (scaled === null) return { key, reason: "invalid_valuation", subtotal: 0n };
    subtotal += BigInt(quantity) * scaled;
  }
  return { key, reason: null, subtotal };
}
