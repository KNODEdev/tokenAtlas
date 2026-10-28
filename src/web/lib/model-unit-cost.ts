import type { CodexAccountingReport } from "../../shared/codex-accounting";

/** List API prices of one model in USD per 1M tokens; null where the card names no rate. */
export interface ListRates {
  cacheRead: number | null;
  input: number | null;
  cacheWrite: number | null;
  output: number | null;
  /** The card changed this model's prices within the selected dates; the latest prices are shown. */
  changed: boolean;
}

/** One model's Standard API value per 1M of its priced tokens, beside its list prices. */
export interface ModelUnitCost {
  model: string | null;
  tokens: number;
  pricedTokens: number;
  /** Standard API value of the priced tokens; null when nothing of the model is priced. */
  apiUsd: number | null;
  /** `apiUsd` per 1M priced tokens; unpriced tokens stay out of both sides of the ratio. */
  perMillion: number | null;
  /** Some tokens of the model have no rate, so the ratio covers only its priced part. */
  partial: boolean;
  rates: ListRates | null;
}

export interface UnitCostSummary {
  rows: ModelUnitCost[];
  tokens: number;
  pricedTokens: number;
  apiUsd: number | null;
  perMillion: number | null;
}

const MILLION = 1e6;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const rateKey = (rates: Omit<ListRates, "changed">) => JSON.stringify([rates.cacheRead, rates.input, rates.cacheWrite, rates.output]);

interface DatedRates { day: string; rates: Omit<ListRates, "changed"> }

/** Latest dated prices per model; a second distinct price set in the range marks the model as changed. */
function latestRates(candidates: Map<string | null, DatedRates[]>, model: string | null): ListRates | null {
  const list = candidates.get(model);
  if (!list?.length) return null;
  const latest = [...list].sort((a, b) => b.day.localeCompare(a.day))[0]!;
  return { ...latest.rates, changed: new Set(list.map(item => rateKey(item.rates))).size > 1 };
}

function collectRates(data: CodexAccountingReport): Map<string | null, DatedRates[]> {
  const byModel = new Map<string | null, DatedRates[]>();
  const add = (model: string | null, day: string, rates: Omit<ListRates, "changed">) => {
    if (rates.input === null && rates.output === null) return;
    byModel.set(model, [...byModel.get(model) ?? [], { day, rates }]);
  };
  // Other providers carry the applied rate on every detail row; a Speed row's rate is not the Standard list price.
  for (const row of data.model_details ?? []) {
    if (row.speed === "fast") continue;
    add(row.model || null, row.day, {
      cacheRead: finite(row.rates.in_cache_read), input: finite(row.rates.in_uncached),
      cacheWrite: finite(row.rates.in_cache_write_5m) ?? finite(row.rates.in_cache_write_unknown) ?? finite(row.rates.in_cache_write_1h),
      output: finite(row.rates.out_total),
    });
  }
  // Codex describes its Standard API bands once; the long-context band is an uplift, not the list price.
  for (const rule of data.applied_rules) {
    if (rule.billing_basis !== "api_equivalent_usd" || rule.speed !== "standard" || rule.long_context) continue;
    add(rule.model, rule.valid_from, {
      cacheRead: finite(rule.rates.in_cache_read), input: finite(rule.rates.in_uncached),
      cacheWrite: finite(rule.rates.in_cache_write), output: finite(rule.rates.out_total),
    });
  }
  return byModel;
}

interface Part { model: string | null; tokens: number; pricedTokens: number; api: number | null; unpriced: boolean }

/**
 * Cost per 1M tokens of every model over the selected dates: its Standard API value divided by its priced tokens,
 * with the list prices of each token type. Codex and "All" read the day × model rows, other providers their details.
 */
export function modelUnitCosts(data: CodexAccountingReport, useBreakdown: boolean): UnitCostSummary {
  const parts: Part[] = useBreakdown
    ? data.breakdown.map(row => {
      const api = row.normalization.standard_api_usd;
      // A fully priced row that reports no priced tokens is priced as a whole.
      const priced = api.priced_tokens > 0 ? api.priced_tokens : api.priced_events > 0 && api.unpriced_events === 0 ? row.tokens : 0;
      return { model: row.model, tokens: row.tokens, pricedTokens: priced, api: api.priced_events > 0 ? api.priced_subtotal : null, unpriced: api.unpriced_events > 0 };
    })
    : (data.model_details ?? []).map(row => {
      const api = finite(row.api_standard);
      return { model: row.model || null, tokens: row.tokens, pricedTokens: api === null ? 0 : row.tokens, api, unpriced: api === null && row.tokens > 0 };
    });
  const byModel = new Map<string | null, Omit<ModelUnitCost, "perMillion" | "rates">>();
  for (const part of parts) {
    const row = byModel.get(part.model) ?? { model: part.model, tokens: 0, pricedTokens: 0, apiUsd: null, partial: false };
    row.tokens += part.tokens;
    row.pricedTokens += part.pricedTokens;
    if (part.api !== null) row.apiUsd = (row.apiUsd ?? 0) + part.api;
    row.partial ||= part.unpriced;
    byModel.set(part.model, row);
  }
  const rates = collectRates(data);
  const perMillion = (api: number | null, tokens: number) => api !== null && tokens > 0 ? api / tokens * MILLION : null;
  // Dearest first; models without a ratio follow by tokens, and traffic without a model name closes the list.
  const rows = [...byModel.values()].filter(row => row.tokens > 0)
    .map(row => ({ ...row, perMillion: perMillion(row.apiUsd, row.pricedTokens), rates: latestRates(rates, row.model) }))
    .sort((a, b) => Number(a.model == null) - Number(b.model == null) || Number(a.perMillion == null) - Number(b.perMillion == null)
      || (b.perMillion ?? 0) - (a.perMillion ?? 0) || b.tokens - a.tokens);
  const priced = rows.filter(row => row.apiUsd !== null);
  const apiUsd = priced.length ? priced.reduce((sum, row) => sum + row.apiUsd!, 0) : null;
  const pricedTokens = rows.reduce((sum, row) => sum + row.pricedTokens, 0);
  return { rows, tokens: rows.reduce((sum, row) => sum + row.tokens, 0), pricedTokens, apiUsd, perMillion: perMillion(apiUsd, pricedTokens) };
}
