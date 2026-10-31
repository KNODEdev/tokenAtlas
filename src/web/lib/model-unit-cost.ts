import type { CodexAccountingReport } from "../../shared/codex-accounting";
import { modelVersionSortValue } from "./table-sort";

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

/* ---- Models on the price ladder (the Speed chart's chips and drawer, approved 2026-10-29) ---- */

export const COST_PICKED_KEY = "tokenatlas.cost.picked.v1";
export const COST_PRESET_SIZE = 5, COST_BUSIEST = 8;
/** Named models with a positive cost: a $0 model has no place on a log scale and says nothing about price. */
export const ladderRows = (rows: readonly ModelUnitCost[]) => rows.filter(row => row.model !== null && row.perMillion !== null && row.perMillion > 0);
/** The drawer's presets over ladder rows: the busiest by tokens, and the dearest and cheapest per 1M. */
export function costPresets(rows: readonly ModelUnitCost[]): { busiest: Set<string>; dearest: Set<string>; cheapest: Set<string> } {
  const ladder = ladderRows(rows), keys = (list: readonly ModelUnitCost[]) => new Set(list.map(row => row.model!));
  const byCost = [...ladder].sort((a, b) => b.perMillion! - a.perMillion!);
  return { busiest: keys([...ladder].sort((a, b) => b.tokens - a.tokens).slice(0, COST_BUSIEST)),
    dearest: keys(byCost.slice(0, COST_PRESET_SIZE)), cheapest: keys(byCost.slice(-COST_PRESET_SIZE)) };
}

/* ---- Lines of one model across versions (the bar chart's family order, approved 2026-10-30) ---- */

export const COST_ORDER_KEY = "tokenatlas.cost.order.v1";
/** Below this many priced tokens a model's mix is too thin to measure a price change by. */
export const THIN_SAMPLE_TOKENS = 100_000;

/** A model without its version numbers and dated snapshot: gpt-5.6-terra and gpt-6.1-terra are both gpt-terra. */
export function modelLine(model: string): string {
  const name = model.toLowerCase().replace(/\[[^\]]*\]$/, "");
  return name.split("-").filter(part => !/^\d+(?:\.\d+)*$/.test(part)).join("-") || name;
}

/** The version a line's bracket leaves to say: 4.7 for claude-opus-4-7, 6.1 for gpt-6.1-sol; dated snapshots drop the date. */
export function modelVersion(model: string): string {
  const parts = model.toLowerCase().replace(/\[[^\]]*\]$/, "").split("-").filter(part => /^\d+(?:\.\d+)*$/.test(part) && part.length < 8);
  return parts.join(".") || model;
}

export interface LineBar {
  row: ModelUnitCost;
  /** The oldest version with enough tokens; the others in its line are measured against it. */
  base: boolean;
  /** Too few priced tokens for a change to mean anything; only marked in a line of several versions. */
  thin: boolean;
  /** perMillion against the base minus 1 (−0.77 is 77% cheaper); null for the base, a thin sample or a lone model. */
  change: number | null;
}
export interface CostLine { key: string; label: string; bars: LineBar[] }

/**
 * Ladder rows grouped by model line, oldest version first. Lines with several versions come first, dearest
 * first; lone models close the chart, also dearest first.
 */
export function costLines(rows: readonly ModelUnitCost[]): CostLine[] {
  const groups = new Map<string, ModelUnitCost[]>();
  for (const row of ladderRows(rows)) {
    const key = modelLine(row.model!);
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const lines = [...groups].map(([key, members]): CostLine => {
    members.sort((a, b) => modelVersionSortValue(a.model)!.localeCompare(modelVersionSortValue(b.model)!));
    const several = members.length > 1;
    const base = several ? members.find(row => row.pricedTokens >= THIN_SAMPLE_TOKENS) : undefined;
    const from = base ? members.indexOf(base) : members.length;
    const bars = members.map((row, index) => {
      const thin = several && row.pricedTokens < THIN_SAMPLE_TOKENS;
      return { row, base: row === base, thin, change: base && index > from && !thin ? row.perMillion! / base.perMillion! - 1 : null };
    });
    // The vendor prefix is the same for every version and the hue already says it.
    const parts = key.split("-");
    return { key, label: parts.length > 1 ? parts.slice(1).join("-") : key, bars };
  });
  const peak = (line: CostLine) => Math.max(...line.bars.map(bar => bar.row.perMillion!));
  return lines.sort((a, b) => Number(b.bars.length > 1) - Number(a.bars.length > 1) || peak(b) - peak(a));
}

/* ---- The price table: list prices beside our average (UR-014 REQ-058) ---- */

/** Tokens one $1,000 of API value buys at this cost per 1M; null without a positive cost (no rate, or free). */
export function tokensPerThousandUsd(perMillion: number | null): number | null {
  return perMillion !== null && Number.isFinite(perMillion) && perMillion > 0 ? 1e9 / perMillion : null;
}

/** Rows the table picks out: the dearest priced model on our mix, and the two priced models with the most tokens. */
export function costTableEmphasis(rows: readonly ModelUnitCost[]): { dearest: string | null; busiest: Set<string> } {
  // An unpriced model has no average to colour, so it never takes a busiest place.
  const named = rows.filter(row => row.model !== null && row.perMillion !== null);
  const dearest = ladderRows(named).reduce<ModelUnitCost | null>((top, row) => !top || row.perMillion! > top.perMillion! ? row : top, null);
  return { dearest: dearest?.model ?? null, busiest: new Set([...named].sort((a, b) => b.tokens - a.tokens).slice(0, 2).map(row => row.model!)) };
}

const FAMILY_PROVIDER: Readonly<Record<string, string>> = { anthropic: "claude", openai: "codex", google: "gemini", xai: "grok", zai: "glm" };
/** The provider a model's name belongs to (claude, codex, …), as the capacity screens name them; null when unknown. */
export function modelProvider(family: string | null): string | null {
  return family ? FAMILY_PROVIDER[family] ?? null : null;
}
