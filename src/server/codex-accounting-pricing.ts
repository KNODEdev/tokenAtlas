import type { CodexTokenRates, CodexAccountingRule, CodexBillingBasis, CodexSpeed } from "../shared/codex-accounting";
export type { CodexTokenRates, CodexAccountingRule, CodexBillingBasis, CodexSpeed } from "../shared/codex-accounting";
import shippedCard from "../../rate-cards.json";
import type { RateCard } from "./pricing";
import { codexTokenCost } from "../shared/codex-token-cost";
import { isCodexInternalReview } from "../shared/codex-internal";
import { contextBand, validContextThreshold } from "../shared/context-tier";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export const CODEX_BILLING_BASES = ["chatgpt_credits", "api_equivalent_usd"] as const;

export interface CodexAccountingConfig {
  version: 1;
  notes?: string[];
  rules: CodexAccountingRule[];
  /**
   * False prices every request at its rule's base rates, ignoring `long_context`. The premium is
   * an API billing term; absent means true, so an older card keeps its valuations and digests.
   */
  long_context_premium?: boolean;
}
/** Marks rule inputs priced without the long-context premium; absent while the premium applies. */
const LONG_CONTEXT_PREMIUM_OFF = "long-context-premium-off";
export const longContextPremium = (config: Pick<CodexAccountingConfig, "long_context_premium">): boolean =>
  config.long_context_premium !== false;
/**
 * The rule input a dated dependency depends on. Only rules with long-context rates change
 * meaning with the setting, so toggling it revisits only the models and days that have them.
 */
export function codexRuleDependency(config: CodexAccountingConfig, rules: CodexAccountingRule[]): unknown {
  return longContextPremium(config) || !rules.some(rule => rule.long_context) ? rules : [rules, LONG_CONTEXT_PREMIUM_OFF];
}
const preparedRules = new WeakMap<CodexAccountingConfig, Map<string, CodexAccountingRule[]>>();
const preparedDays = new WeakMap<CodexAccountingConfig, Map<string, boolean>>();
const preparedKeys = new WeakMap<CodexAccountingConfig, string>();
const valuation = Symbol("codex-valuation");
const valuationFields = ["model", "ts", "in_tok", "cached_in", "cache_write", "out_tok", "cache_write_status", "usage_status"] as const;
export type CodexEventValuation = [CodexEventPrice, CodexEventPrice, CodexEventPrice, CodexEventPrice];
type ValuedEvent = CodexAccountingEvent & { [valuation]?: { key:string; facts:unknown[]; prices:CodexEventValuation } };
/**
 * Bumped whenever the derivation below changes, so the durable valuation register cannot
 * keep amounts computed under superseded semantics. v1 reads an absent cache-write counter
 * as zero writes: the published Codex price list establishes no separate cache-write price,
 * and no recorded event in the archive has ever carried a nonzero counter. A counter that is
 * present and positive is still evidence and still refuses a credit valuation.
 */
export const CODEX_PRICING_RULE = "codex-cache-write-absent-as-zero-v1";
/**
 * First day Codex charged subscription usage in credits per token. Before it, usage was
 * billed per message, so no model had a credit rate and a missing credit valuation is not
 * a gap in this card. Sources:
 * https://learn.chatgpt.com/docs/pricing, https://uibakery.io/blog/openai-codex-pricing
 */
export const CODEX_CREDIT_BILLING_START = "2026-04-02";
export function codexPricingKey(config:CodexAccountingConfig):string {
  return preparedKeys.get(config) ?? createHash("sha256").update(JSON.stringify([CODEX_PRICING_RULE,config.rules,
    ...(longContextPremium(config) ? [] : [LONG_CONTEXT_PREMIUM_OFF])])).digest("hex");
}
/** Stored prices computed on first use; spreads of the event share it without computing. */
class LazyValuation {
  private computed?: CodexEventValuation;
  constructor(readonly key: string, readonly facts: unknown[], private readonly compute: () => CodexEventValuation) {}
  get prices(): CodexEventValuation { return this.computed ??= this.compute(); }
}
/**
 * Attaches the stored prices of a published event for `priceCodexEvent` to reuse, valid for the facts the
 * event has now. They are computed on first use, so readers that never price through them skip their cost.
 */
export function attachCodexValuation(config:CodexAccountingConfig,event:CodexAccountingEvent,prices:()=>CodexEventValuation):void {
  (event as ValuedEvent)[valuation]=new LazyValuation(codexPricingKey(config),valuationFields.map(field=>event[field]),prices);
}
export function valueCodexEvent(config:CodexAccountingConfig,event:CodexAccountingEvent):CodexEventValuation {
  const standard={...event,speed:"standard"},fast={...event,speed:"fast"};
  return [priceCodexEvent(config,standard,"chatgpt_credits"),priceCodexEvent(config,fast,"chatgpt_credits"),
    priceCodexEvent(config,standard,"api_equivalent_usd"),priceCodexEvent(config,fast,"api_equivalent_usd")];
}



/** A request-local index: later edits to the source configuration cannot stale it. */
export function prepareCodexPricing(config: CodexAccountingConfig): CodexAccountingConfig {
  const prepared = structuredClone(config);
  const index = new Map<string, CodexAccountingRule[]>();
  for (const rule of prepared.rules) {
    const key = JSON.stringify([rule.model, rule.speed, rule.billing_basis]);
    const rules = index.get(key) ?? [];
    rules.push(rule); index.set(key, rules);
  }
  preparedRules.set(prepared, index);
  preparedDays.set(prepared, new Map());
  preparedKeys.set(prepared, codexPricingKey(prepared));
  return prepared;
}
export interface CodexAccountingEvent {
  model: string | null;
  billing_mode?: string | null;
  meter_reset?: number | null;
  plan_type?: string | null;
  account_id?: string | null;
  speed: string | null;
  ts: string;
  in_tok: number;
  cached_in: number;
  cache_write: number;
  cache_write_status?: string | null;
  usage_status?: string | null;
  out_tok: number;
}
export type CodexPriceReason = "unknown_speed" | "missing_rate" | "invalid_tokens"
  | "invalid_timestamp" | "cache_write_semantics_unknown" | "missing_cache_write_rate" | "incomplete_usage";
export interface CodexEventPrice {
  amount: number | null;
  reason: CodexPriceReason | null;
  rule_id: string | null;
  long_context: boolean;
}

export function isAccountingDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateCodexAccountingConfig(value: unknown): asserts value is CodexAccountingConfig {
  const fail = (message: string): never => { throw new Error(`Invalid codex_accounting: ${message}`); };
  if (!value || typeof value !== "object") fail("expected an object");
  const config = value as CodexAccountingConfig;
  if (config.version !== 1 || !Array.isArray(config.rules)) fail("expected version 1 and rules array");
  if (config.long_context_premium !== undefined && typeof config.long_context_premium !== "boolean") fail("long_context_premium must be a boolean");
  const ids = new Set<string>();
  const ratesValid = (rates: CodexTokenRates): boolean => !!rates &&
    [rates.in_uncached, rates.in_cache_read, rates.out_total].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
    && (rates.in_cache_write == null || (typeof rates.in_cache_write === "number" && Number.isFinite(rates.in_cache_write) && rates.in_cache_write >= 0));
  for (const rule of config.rules) {
    if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || !rule.id.trim()
      || ids.has(rule.id)) fail("missing or duplicate rule id");
    ids.add(rule.id);
    if (rule.included_usage !== undefined && !["proportional", "unchanged", "unknown"].includes(rule.included_usage)) fail(`${rule.id}: invalid included-usage effect`);
    if (rule.note !== undefined && (typeof rule.note !== "string" || rule.note.length > 2000)) fail(`${rule.id}: invalid note`);
    if (typeof rule.model !== "string" || !rule.model.trim()) fail(`${rule.id}: missing model`);
    if (!CODEX_BILLING_BASES.includes(rule.billing_basis)
      || !["standard", "fast"].includes(rule.speed)) fail(`${rule.id}: invalid basis or speed`);
    if (!isAccountingDay(rule.valid_from) || !isAccountingDay(rule.verified_at)
      || (rule.valid_until !== undefined && (!isAccountingDay(rule.valid_until) || rule.valid_until <= rule.valid_from))) {
      fail(`${rule.id}: invalid dates (valid_until is exclusive)`);
    }
    if (!Array.isArray(rule.sources) || rule.sources.length === 0
      || !rule.sources.every(source => typeof source === "string" && /^https:\/\//.test(source))
      || !["official", "user"].includes(rule.confidence)) fail(`${rule.id}: missing provenance`);
    if (!ratesValid(rule.rates) || !Number.isFinite(rule.multiplier) || rule.multiplier <= 0) fail(`${rule.id}: invalid rates`);
    if (rule.billing_basis === "chatgpt_credits" && (rule.rates.in_cache_write != null || rule.long_context?.rates.in_cache_write != null)) fail(`${rule.id}: cache-write API prices cannot be used as credit prices`);
    if (rule.billing_basis === "api_equivalent_usd" && rule.multiplier !== 1) fail(`${rule.id}: API rules need explicit tier rates`);
    if (rule.long_context && (!validContextThreshold(rule.long_context.above_input_tokens)
      || !ratesValid(rule.long_context.rates))) fail(`${rule.id}: invalid long-context rates`);
    for (const other of config.rules) {
      if (other === rule || other?.model !== rule.model || other.billing_basis !== rule.billing_basis || other.speed !== rule.speed) continue;
      if (rule.valid_from < (other.valid_until ?? "9999-12-31")
        && other.valid_from < (rule.valid_until ?? "9999-12-31")) fail(`${rule.id}: overlapping periods with ${other.id}`);
    }
  }
}

/** A private legacy card inherits only this new section, never different legacy USD prices. */
export function resolveCodexAccountingConfig(card: Pick<RateCard, "codex_accounting">): CodexAccountingConfig {
  const value: unknown = card.codex_accounting === undefined ? shippedCard.codex_accounting : card.codex_accounting;
  validateCodexAccountingConfig(value);
  return value;
}

/** One token event at a time: summed daily input cannot establish a request's context band. */
export function priceCodexEvent(
  config: CodexAccountingConfig, event: CodexAccountingEvent, basis: CodexBillingBasis, referenceDay?: string,
): CodexEventPrice {
  const saved=(event as ValuedEvent)[valuation];
  // Spreads that change only speed retain the valuation; changed facts or reference dates cannot reuse it.
  if(saved && preparedKeys.get(config)===saved.key && (referenceDay===undefined || referenceDay===event.ts.slice(0,10))
    && (event.speed==="standard" || event.speed==="fast")
    && valuationFields.every((field,index)=>event[field]===saved.facts[index])) {
    return saved.prices[(basis==="api_equivalent_usd"?2:0)+(event.speed==="fast"?1:0)]!;
  }
  const absent = (reason: CodexPriceReason): CodexEventPrice => ({ amount: null, reason, rule_id: null, long_context: false });
  if (isCodexInternalReview(event.model)) return absent("missing_rate");
  if (![event.in_tok, event.cached_in, event.cache_write, event.out_tok].every(n => Number.isSafeInteger(n) && n >= 0)
    || event.cached_in + event.cache_write > event.in_tok || !Number.isSafeInteger(event.in_tok + event.out_tok)
    || event.usage_status === "invalid" || event.cache_write_status === "invalid") return absent("invalid_tokens");
  if (event.usage_status === "unknown" || event.usage_status === "incomplete") return absent("incomplete_usage");
  const day = referenceDay ?? event.ts.slice(0, 10);
  const days = preparedDays.get(config);
  let validDay = days?.get(day);
  if (validDay === undefined) { validDay = isAccountingDay(day); days?.set(day, validDay); }
  if (!validDay || !isAccountingDay(event.ts.slice(0, 10)) || !Number.isFinite(Date.parse(event.ts))) return absent("invalid_timestamp");
  if (event.speed !== "fast" && event.speed !== "standard") return absent("unknown_speed");
  // The published credit card does not establish a price for positive write counters.
  if (basis === "chatgpt_credits" && event.cache_write > 0) return absent("cache_write_semantics_unknown");
  const index = preparedRules.get(config);
  const candidates = index ? index.get(JSON.stringify([event.model, event.speed, basis])) ?? [] : config.rules;
  const rule = candidates.find(r => r.model === event.model && r.speed === event.speed
    && r.billing_basis === basis && day >= r.valid_from && (!r.valid_until || day < r.valid_until));
  if (!rule) return absent("missing_rate");
  // Codex counts cache inside `in_tok`, so it is already the whole prompt input.
  const long = longContextPremium(config) && contextBand(rule.long_context, event.in_tok) === "long";
  const rates = long ? rule.long_context!.rates : rule.rates;
  if (event.cache_write > 0 && rates.in_cache_write == null) return absent("missing_cache_write_rate");
  const cost = codexTokenCost(event.in_tok, event.cached_in, event.cache_write, event.out_tok, rates);
  if (!cost) return absent("invalid_tokens");
  const amount = cost.total * rule.multiplier;
  if (!Number.isFinite(amount)) throw new Error(`Invalid codex_accounting: ${rule.id} produces a non-finite amount`);
  return { amount, reason: null, rule_id: rule.id, long_context: long };
}

/** Standard-price work weighted by the credit burden, not by the API tier premium. */
export function normalizeCodexEvent(config: CodexAccountingConfig, event: CodexAccountingEvent) {
  const actual = priceCodexEvent(config, event, "chatgpt_credits");
  const standardEvent = { ...event, speed: "standard" };
  const standard = priceCodexEvent(config, standardEvent, "chatgpt_credits");
  const api = priceCodexEvent(config, standardEvent, "api_equivalent_usd");
  const ratio = actual.amount != null && standard.amount != null && standard.amount > 0
    ? actual.amount / standard.amount : actual.amount === 0 && standard.amount === 0 ? 1 : null;
  return {
    credits: actual.amount, standard_credits: standard.amount,
    extra_credits: actual.amount != null && standard.amount != null ? actual.amount - standard.amount : null,
    standard_api_usd: api.amount,
    normalized_usd: ratio != null && api.amount != null ? api.amount * ratio : null,
    multiplier: ratio,
    reason: actual.reason ?? standard.reason ?? api.reason,
    rule_ids: [actual.rule_id, standard.rule_id, api.rule_id].filter((id): id is string => id != null),
  };
}

export interface CodexSpeedEdit { credit_multiplier: number; api_multiplier?: number; valid_from: string }

/** Split dated rules so a new setting cannot silently rewrite earlier usage. */
export function editCodexSpeed(card: RateCard, model: string, edit: CodexSpeedEdit): void {
  if (!edit || !isAccountingDay(edit.valid_from)
    || ![edit.credit_multiplier, ...(edit.api_multiplier === undefined ? [] : [edit.api_multiplier])].every(n => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 100)) {
    throw new Error("Speed: wymagane mnożniki > 0 i ≤ 100 oraz data YYYY-MM-DD");
  }
  const config = structuredClone(resolveCodexAccountingConfig(card));
  for (const basis of CODEX_BILLING_BASES) {
    if (basis === "api_equivalent_usd" && edit.api_multiplier === undefined) continue;
    const standard = config.rules.find(r => r.model === model && r.speed === "standard" && r.billing_basis === basis
      && r.valid_from <= edit.valid_from && (!r.valid_until || edit.valid_from < r.valid_until));
    if (!standard) throw new Error(`Speed: brak stawki Standard ${basis} dla ${model} na ${edit.valid_from}`);
    const active = config.rules.find(r => r.model === model && r.speed === "fast" && r.billing_basis === basis
      && r.valid_from <= edit.valid_from && (!r.valid_until || edit.valid_from < r.valid_until));
    const nextStart = config.rules.filter(r => r.model === model && r.speed === "fast" && r.billing_basis === basis
      && r.valid_from > edit.valid_from).map(r => r.valid_from).sort()[0];
    const ends = [standard.valid_until, active?.valid_until, nextStart].filter((v): v is string => !!v).sort();
    config.rules = config.rules.filter(r => r !== active || r.valid_from < edit.valid_from);
    if (active && active.valid_from < edit.valid_from) active.valid_until = edit.valid_from;
    const multiplier = basis === "chatgpt_credits" ? edit.credit_multiplier : edit.api_multiplier!;
    const scale = (rates: CodexTokenRates) => Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, typeof v === "number" ? v * multiplier : v])) as unknown as CodexTokenRates;
    config.rules.push({ ...structuredClone(standard), id: `${model}-${basis}-fast-user-${edit.valid_from}`,
      speed: "fast", valid_from: edit.valid_from, valid_until: ends[0], confidence: "user",
      verified_at: new Date().toISOString().slice(0, 10),
      multiplier: basis === "chatgpt_credits" ? standard.multiplier * multiplier : 1,
      rates: basis === "api_equivalent_usd" ? scale(standard.rates) : standard.rates,
      long_context: standard.long_context && { ...standard.long_context,
        rates: basis === "api_equivalent_usd" ? scale(standard.long_context.rates) : standard.long_context.rates },
    });
  }
  validateCodexAccountingConfig(config);
  card.codex_accounting = config;
}

export function codexModelSpeed(card: RateCard, model: string, day: string) {
  const config = resolveCodexAccountingConfig(card);
  const rule = (basis: CodexBillingBasis, speed: CodexSpeed) => config.rules.find(r => r.model === model
    && r.billing_basis === basis && r.speed === speed && r.valid_from <= day && (!r.valid_until || day < r.valid_until));
  const cs = rule("chatgpt_credits", "standard"), cf = rule("chatgpt_credits", "fast");
  const as = rule("api_equivalent_usd", "standard"), af = rule("api_equivalent_usd", "fast");
  return { credit_multiplier: cs && cf ? cf.multiplier / cs.multiplier : null,
    api_multiplier: as && af && as.rates.in_uncached > 0 ? af.rates.in_uncached / as.rates.in_uncached : null,
    editable: !!cs, api_editable: !!as, valid_from: cf?.valid_from ?? null, confidence: cf?.confidence ?? null,
    rules: config.rules.filter(r => r.model === model) };
}

/** Keep the model editor and the dated accounting API rates on the same source. */
export function editCodexStandardRates(card: RateCard, model: string, values: Record<string, number | null>, day: string): void {
  const config = structuredClone(resolveCodexAccountingConfig(card));
  const active = config.rules.filter(r => r.model === model && r.billing_basis === "api_equivalent_usd"
    && r.valid_from <= day && (!r.valid_until || day < r.valid_until));
  const standard = active.find(r => r.speed === "standard");
  if (!standard) return;
  for (const rule of active) {
    const updated = structuredClone(rule);
    updated.id = `${model}-api-${rule.speed}-user-${day}`;
    updated.valid_from = day; updated.verified_at = day; updated.confidence = "user";
    let unpriced = false;
    for (const key of ["in_uncached", "in_cache_read", "in_cache_write", "out_total"] as const) {
      if (!(key in values)) continue;
      if (key === "in_cache_write" && values[key] == null) {
        updated.rates.in_cache_write = null;
        if (updated.long_context) updated.long_context.rates.in_cache_write = null;
        continue;
      }
      if (values[key] == null) { unpriced = true; continue; }
      const base = standard.rates[key] ?? standard.rates.in_uncached;
      const current = rule.rates[key] ?? rule.rates.in_uncached;
      const ratio = base > 0 ? current / base : 1;
      const longRatio = current > 0 && rule.long_context ? (rule.long_context.rates[key] ?? rule.long_context.rates.in_uncached) / current : 1;
      updated.rates[key] = values[key]! * ratio;
      if (updated.long_context) updated.long_context.rates[key] = updated.rates[key] * longRatio;
    }
    config.rules = config.rules.filter(r => r !== rule || r.valid_from < day);
    if (rule.valid_from < day) rule.valid_until = day;
    // A null rate disables pricing, never converts missing money to zero.
    if (!unpriced) config.rules.push(updated);
  }
  validateCodexAccountingConfig(config); card.codex_accounting = config;
}
