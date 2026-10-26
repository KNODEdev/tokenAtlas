import { codexTokenCost } from "../shared/codex-token-cost";
import { isCodexInternalReview } from "../shared/codex-internal";
import { contextBand, disjointPromptInput, selectContextRates, type ContextTier } from "../shared/context-tier";
import { vendorContextPremium } from "./vendor-context-premium";
export interface AnthropicModelRate {
  in_uncached: number | null;
  in_cache_read: number | null;
  in_cache_write_5m: number | null;
  in_cache_write_1h: number | null;
  out_total: number | null;
  long_context?: ContextTier<EffectiveAnthropicRate>;
  until?: string;
  fast?: EffectiveAnthropicRate & { long_context?: ContextTier<EffectiveAnthropicRate> };
  after?: EffectiveAnthropicRate & { long_context?: ContextTier<EffectiveAnthropicRate> };
}

export interface OpenAIModelRate {
  in_uncached: number | null;
  in_cache_read: number | null;
  in_cache_write?: number | null;
  out_total: number | null;
  confidence?: string;
  proxy_for?: string;
  note?: string;

  until?: string;
  after?: {
    in_uncached: number;
    in_cache_read: number;
    in_cache_write?: number;
    out_total: number;
  };
}

export interface ModelRateAny {
  in_uncached?: number | null;
  in_cache_read?: number | null;
  in_cache_write?: number | null;
  in_cache_write_5m?: number | null;
  in_cache_write_1h?: number | null;
  out_total?: number | null;
  long_context?: ContextTier<RateValues>;
  until?: string;
  after?: RateBlock;
  fast?: RateBlock;
  confidence?: string;
  proxy_for?: string;
  note?: string;
}

/** Per-million token rates of one block; any field may be absent. */
export type RateValues = Partial<Record<"in_uncached" | "in_cache_read" | "in_cache_write" | "in_cache_write_5m"
  | "in_cache_write_1h" | "out_total", number | null>>;
/** A dated (`after`) or mode (`fast`) variant: its own rates and, optionally, its own context tier. */
export type RateBlock = RateValues & { long_context?: ContextTier<RateValues> };

export interface VendorCard {
  verified?: boolean;
  source?: string;
  notes?: string[];
  /** True applies the models' long-context rates as the paid API bills them; absent or false values at base rates. */
  long_context_premium?: boolean;
  models?: Record<string, ModelRateAny>;
}

export interface SubscriptionRate {
  plan?: string;
  usd_per_month?: number | null;
  confidence?: string;
}

export interface RateCard {
  codex_credits?: {
    unit: string;
    basis: string;
    verified_at: string;
    source: string;
    models: Record<string, { input: number; cached_input: number; output: number }>;
  };
  codex_accounting?: import("./codex-accounting-pricing").CodexAccountingConfig;
  codex_ledger_policy?: import("./codex-ledger-settings").CodexLedgerSettingsPolicy;
  version: number;
  currency: string;
  unit: string;
  vendors: {
    anthropic?: {
      verified?: boolean;
      source?: string;
      notes?: string[];
      long_context_premium?: boolean;
      models?: Record<string, AnthropicModelRate>;
    };
    openai?: {
      verified?: boolean;
      source?: string;
      notes?: string[];
      models?: Record<string, OpenAIModelRate>;
    };

    [vendor: string]: VendorCard | undefined;
  };
  subscriptions?: Record<string, SubscriptionRate>;
}

export interface EffectiveAnthropicRate {
  in_uncached: number;
  in_cache_read: number;
  in_cache_write_5m: number;
  in_cache_write_1h: number;
  out_total: number;
}

export interface EffectiveOpenAIRate {
  in_uncached: number;
  in_cache_read: number;
  in_cache_write: number | null;
  out_total: number;
}

export interface CodexPriceGroup {
  price_day?: string;
  context_input?: number;
  cache_write_status?: string | null;
  usage_status?: string | null;
  in_tok?: number | null;
  cached_in?: number | null;
  cache_write?: number | null;
  out_tok?: number | null;
}

/** Group only requests sharing a date, context size and source quality. */
export function codexPriceGroupSql(sqlite: import("bun:sqlite").Database, alias = "") {
  const columns = new Set((sqlite.query("PRAGMA table_info(events)").all() as { name: string }[]).map(c => c.name));
  const prefix = alias ? `${alias}.` : "";
  const status = (name: string) => columns.has(name) ? `${prefix}${name}` : "NULL";
  return {
    write: columns.has("cache_write") ? `${prefix}cache_write` : "0",
    select: `substr(${prefix}ts,1,10) AS price_day, ${prefix}in_tok AS context_input, ${status("cache_write_status")} AS cache_write_status, ${status("usage_status")} AS usage_status`,
    group: `substr(${prefix}ts,1,10), ${prefix}in_tok${["cache_write_status", "usage_status"].filter(n => columns.has(n)).map(n => `, ${prefix}${n}`).join("")}`,
  };
}

export function getCodexGroupRate(card: RateCard, model: string | null, group: CodexPriceGroup): (EffectiveOpenAIRate & { in_cache_write: number }) | null {
  if ((group.usage_status != null && group.usage_status !== "valid") || group.cache_write_status === "invalid") return null;
  // An unknown context size matters only while the long-context premium applies.
  if (group.context_input == null && card.codex_accounting?.long_context_premium !== false
    && card.codex_accounting?.rules.some(rule => rule.model === model
    && rule.billing_basis === "api_equivalent_usd" && rule.speed === "standard" && rule.long_context
    && (!group.price_day || (group.price_day >= rule.valid_from && (!rule.valid_until || group.price_day < rule.valid_until))))) return null;
  const rate = getCodexRate(card, model, group.price_day, group.context_input);
  // An absent counter reads as zero writes, exactly as priceCodexEvent treats it.
  if (!rate || ((group.cache_write ?? 0) > 0 && rate.in_cache_write == null)) return null;
  if (group.in_tok != null && !codexTokenCost(group.in_tok, group.cached_in ?? 0, group.cache_write ?? 0, group.out_tok ?? 0, rate)) return null;
  return { ...rate, in_cache_write: rate.in_cache_write ?? 0 };
}

export function getClaudeRate(
  card: RateCard,
  model: string | null,
  day: string,
  speed: string | null,
  contextInput?: number,
): EffectiveAnthropicRate | null {
  const models = card.vendors.anthropic?.models;
  if (!models) return null;
  const r = models[model || ""];
  if (!r || r.in_uncached === null || r.in_uncached === undefined) return null;

  // A variant replaces the base block; the context tier then picks within the chosen block.
  const variant = speed === "fast" && r.fast && typeof r.fast === "object" ? r.fast
    : r.until && day.slice(0, 10) > r.until && r.after && typeof r.after === "object" ? r.after : null;
  const block: EffectiveAnthropicRate = variant ?? {
    in_uncached: r.in_uncached,
    in_cache_read: r.in_cache_read ?? 0,
    in_cache_write_5m: r.in_cache_write_5m ?? 0,
    in_cache_write_1h: r.in_cache_write_1h ?? 0,
    out_total: r.out_total ?? 0,
  };
  // Without the premium every request is at the block's base rates, whatever its prompt size.
  if (!vendorContextPremium(card, "anthropic")) return block;
  return selectContextRates(block, variant ? variant.long_context : r.long_context, r.long_context, contextInput).rates ?? null;
}

export function getClaudeGroupRate(card: RateCard, model: string | null, day: string, speed: string | null,
  usage: { in_uncached?: number | null; in_cache_read?: number | null; in_cache_write?: number | null; cache_write_5m?: number | null; cache_write_1h?: number | null }) {
  if ((usage.in_cache_write ?? 0) !== (usage.cache_write_5m ?? 0) + (usage.cache_write_1h ?? 0)) return null;
  const input = disjointPromptInput([usage.in_uncached, usage.in_cache_read, usage.in_cache_write]) ?? undefined;
  return getClaudeRate(card, model, day, speed, input);
}

export function getCodexRate(
  card: RateCard,
  model: string | null,
  day?: string,
  contextInput?: number,
): EffectiveOpenAIRate | null {
  if (isCodexInternalReview(model)) return null;
  // Day sums use the same dated Standard reference as event accounting.
  // Legacy-only private cards retain their own rates and until/after behavior.
  const dated = card.codex_accounting?.rules.filter(rule => rule.model === model
    && rule.billing_basis === "api_equivalent_usd" && rule.speed === "standard");
  if (dated) {
    const date = (day ?? new Date().toISOString()).slice(0, 10);
    const rule = dated.find(rule => date >= rule.valid_from && (!rule.valid_until || date < rule.valid_until));
    // An absent size keeps the base rates here; getCodexGroupRate refuses it while the premium applies.
    const long = card.codex_accounting?.long_context_premium !== false && contextBand(rule?.long_context, contextInput) === "long";
    const rates = long ? rule!.long_context!.rates : rule?.rates;
    return rates ? { ...rates, in_cache_write: rates.in_cache_write ?? null } : null;
  }
  const models = card.vendors.openai?.models;
  if (!models) return null;
  const r = models[model || ""];
  if (!r || r.in_uncached === null || r.in_uncached === undefined) return null;

  if (day && r.until && day.slice(0, 10) > r.until && r.after) {
    return {
      in_uncached: r.after.in_uncached,
      in_cache_read: r.after.in_cache_read,
      in_cache_write: r.after.in_cache_write ?? null,
      out_total: r.after.out_total,
    };
  }

  return {
    in_uncached: r.in_uncached,
    in_cache_read: r.in_cache_read ?? 0,
    in_cache_write: r.in_cache_write ?? null,
    out_total: r.out_total ?? 0,
  };
}

export function normalizeRateVendor(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const p = provider.trim().toLowerCase();
  if (p === "zai" || p === "zhipuai" || p === "zai-coding-plan" || p === "zhipuai-coding-plan") {
    return "zai";
  }
  if (p === "google" || p === "gemini" || p === "antigravity") {
    return "google";
  }
  if (p === "openai" || p === "codex") {
    return "openai";
  }
  if (p === "anthropic" || p === "claude") {
    return "anthropic";
  }
  if (p === "xai" || p === "grok") {
    return "xai";
  }
  return p;
}

/** Resolve the configured model family without filling absent rates or discarding dated rules. */
export function getVendorModelRate(
  card: RateCard,
  vendor: string,
  model: string | null
): ModelRateAny | null {
  const normVendor = normalizeRateVendor(vendor) || vendor;
  const vendorCard = card.vendors[normVendor];
  const models = vendorCard?.models;
  if (!models || !model) return null;

  let r = models[model];

  if (!r || r.in_uncached === null || r.in_uncached === undefined) {
    let bestKey: string | null = null;
    for (const [k, candidate] of Object.entries(models)) {
      if (candidate && candidate.in_uncached != null && model.startsWith(k)) {
        if (bestKey === null || k.length > bestKey.length) {
          bestKey = k;
          r = candidate;
        }
      }
    }
  }

  if (!r || r.in_uncached === null || r.in_uncached === undefined) return null;
  return r;
}

/**
 * A model the rate card declares as intentionally unpriced: an entry with confidence UNKNOWN and no input
 * rate (e.g. Codex's internal review). Its traffic stays unpriced without a missing-price alert.
 */
export function isKnownUnpriced(card: RateCard, vendor: string, model: string | null): boolean {
  if (!model) return false;
  const normalized = normalizeRateVendor(vendor) ?? vendor;
  if (normalized === "openai" && isCodexInternalReview(model)) return true;
  const entry = card.vendors?.[normalized]?.models?.[model] as ModelRateAny | undefined;
  return entry != null && String(entry.confidence ?? "").toUpperCase() === "UNKNOWN" && entry.in_uncached == null;
}

/**
 * A model explicitly marked free: by its vendor's model id (OpenRouter's `:free`, OpenCode's `-free` suffix) or by
 * its rate-card entry (`"free": true`). It costs nothing, so its unpriced traffic is not a missing price.
 */
export function isMarkedFree(card: RateCard, vendor: string, model: string | null): boolean {
  if (!model) return false;
  if (/[:-]free$/i.test(model)) return true;
  const entry = card.vendors?.[normalizeRateVendor(vendor) ?? vendor]?.models?.[model] as (ModelRateAny & { free?: unknown }) | undefined;
  return entry?.free === true;
}

export function getVendorRate(
  card: RateCard,
  vendor: string,
  model: string | null
): (EffectiveOpenAIRate & { in_cache_write: number }) | null {
  const r = getVendorModelRate(card, vendor, model);
  // One rate without the request's prompt size cannot price a model with a context tier.
  if (!r || r.in_uncached == null || r.long_context) return null;
  return {
    in_uncached: r.in_uncached,
    in_cache_read: r.in_cache_read ?? 0,
    in_cache_write: r.in_cache_write ?? r.in_cache_write_5m ?? 0,
    out_total: r.out_total ?? 0,
  };
}

export function calculateCodexUsd(
  rate: EffectiveOpenAIRate | null,
  inTok: number,
  cachedIn: number,
  cacheWrite: number,
  outTok: number
): number | null {
  return rate ? codexTokenCost(inTok, cachedIn, cacheWrite, outTok, rate)?.total ?? null : null;
}

export function calculateClaudeUsd(
  rate: EffectiveAnthropicRate | null,
  inUncached: number, inCacheRead: number, cacheWrite5m: number, cacheWrite1h: number,
  inCacheWrite: number, outTotal: number,
): number | null {
  if (!rate || ![inUncached, inCacheRead, cacheWrite5m, cacheWrite1h, inCacheWrite, outTotal].every(n => Number.isSafeInteger(n) && n >= 0)
    || inCacheWrite !== cacheWrite5m + cacheWrite1h) return null;
  return (inUncached * rate.in_uncached + inCacheRead * rate.in_cache_read
    + cacheWrite5m * rate.in_cache_write_5m + cacheWrite1h * rate.in_cache_write_1h + outTotal * rate.out_total) / 1e6;
}

export function calculateVendorUsd(
  rate: EffectiveOpenAIRate | null,
  inTok: number,
  cacheRead: number,
  cacheWrite: number,
  outTok: number
): number {
  if (!rate) return 0;
  return (
    (inTok / 1e6) * rate.in_uncached +
    (cacheRead / 1e6) * rate.in_cache_read +
    (cacheWrite / 1e6) * (rate.in_cache_write ?? 0) +
    (outTok / 1e6) * rate.out_total
  );
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Reference Standard credits are independent of API dollars and observed quota. */
export function codexCreditEquivalent(card: RateCard, model: string | null, input: number, cached: number, output: number, cacheWrite = 0): number | null {
  const rate = card.codex_credits?.models[model ?? ""];
  if (!rate || cacheWrite > 0 || ![input, cached, output, cacheWrite, rate.input, rate.cached_input, rate.output].every(v => Number.isFinite(v) && v >= 0) || cached > input) return null;
  return ((input - cached) * rate.input + cached * rate.cached_input + output * rate.output) / 1e6;
}

export function allocateCents(exact: number[]): number[] {
  if (exact.length === 0) return [];
  const target = Math.round(exact.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0) * 100);
  const scaled = exact.map((n) => (Number.isFinite(n) ? n : 0) * 100);
  const cents = scaled.map((c) => Math.floor(c));
  let rest = target - cents.reduce((sum, c) => sum + c, 0);
  const byRemainder = scaled
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byRemainder.length && rest > 0; k++, rest--) {
    const idx = byRemainder[k]?.i;
    if (idx === undefined) break;
    cents[idx] = (cents[idx] ?? 0) + 1;
  }
  if (rest < 0) {
    for (let k = byRemainder.length - 1; k >= 0 && rest < 0; k--) {
      const idx = byRemainder[k]?.i;
      if (idx === undefined) break;
      if ((cents[idx] ?? 0) <= 0) continue;
      cents[idx] = (cents[idx] ?? 0) - 1;
      rest++;
    }
  }
  return cents.map((c) => c / 100);
}

export function allocatePaidAcrossSubjects(
  subjectApiUsd: Iterable<[string, number]>,
  paidUsd: number
): Map<string, number> {
  const entries = Array.from(subjectApiUsd).sort((a, b) => a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, n]) => sum + (Number.isFinite(n) ? n : 0), 0);
  const exact = entries.map(([, n]) => (total > 0 && Number.isFinite(n) ? (n / total) * paidUsd : 0));
  const alloc = allocateCents(exact);
  return new Map(entries.map(([k], i) => [k, alloc[i] ?? 0]));
}

