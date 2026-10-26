import type { ContextPreviewResponse } from "./context-preview";
/** Stored single-model measurements; no inferred zero or allocation of a mixed meter. */
export const MODEL_CAPACITY_VERSION = 1;
export const MODEL_CAPACITY_MIN_PP = 20;

export interface ModelCapacityUsage {
  model: string | null;
  events: number;
  tokens: number;
  api_usd: number;
  unpriced_events: number;
  unknown_mode_tokens: number;
  fast_tokens: number;
}
export interface ModelCapacityReading {
  ts: string;
  percent: number;
  models: ModelCapacityUsage[];
}
export interface ModelCapacitySample extends Omit<ModelCapacityUsage, "model"> {
  model: string;
  from: string;
  through: string;
  observed_pp: number;
  max_gap_minutes: number;
  reaches_100: boolean;
}
export interface ModelCapacityWindow {
  version: typeof MODEL_CAPACITY_VERSION;
  models: string[];
  single_model_intervals: number;
  samples: ModelCapacitySample[];
  uncertain_events?: number;
}
export interface ModelCapacitySpread {
  median: number;
  p25: number;
  p75: number;
}
export interface ModelCapacityRow {
  key: string;
  model: string;
  plan: string | null;
  mode: "standard" | "fast" | "unknown" | "mixed";
  terms: "configured" | "unknown" | "mixed" | "uncertain" | "invalid";
  allowance_factor: number | null;
  samples: number;
  small_samples: number;
  priced_samples: number;
  windows: number;
  observed_pp: number;
  events: number;
  from: string | null;
  through: string | null;
  tokens: ModelCapacitySpread | null;
  api_usd: ModelCapacitySpread | null;
  tentative: boolean;
  reasons: string[];
}
export interface ModelCapacityResponse extends ContextPreviewResponse<ModelCapacityResponse> {
  provider: "codex" | "claude";
  account: string;
  counter: string;
  since: string;
  until: string;
  minimum_pp: number;
  preparing_windows: number;
  rows: ModelCapacityRow[];
}

const emptyUsage = (): Omit<ModelCapacityUsage, "model"> => ({ events: 0, tokens: 0, api_usd: 0,
  unpriced_events: 0, unknown_mode_tokens: 0, fast_tokens: 0 });

/** Consecutive disjoint blocks within one homogeneous run, including traffic on a flat rounded meter. */
export function modelCapacitySamples(readings: readonly ModelCapacityReading[]): ModelCapacityWindow {
  const result: ModelCapacityWindow = { version: MODEL_CAPACITY_VERSION, models: [], single_model_intervals: 0, samples: [] };
  const observed = new Set<string>();
  let block: ModelCapacitySample | null = null;
  const close = () => {
    if (block && block.observed_pp > 0 && block.tokens > 0) result.samples.push(block);
    block = null;
  };
  // The first reading's traffic predates the explicit start and cannot establish a sample.
  for (let i = 0; i < readings.length; i++) {
    if (i > 0 && readings[i - 1]!.percent >= 100) break;
    const reading = readings[i]!;
    const models = reading.models.filter(row => row.tokens > 0 || row.api_usd > 0
      || row.events > 0 && row.model !== "<synthetic>");
    for (const row of models) if (row.model && !row.model.startsWith("<")) observed.add(row.model);
    if (i === 0) continue;
    const previous = readings[i - 1]!;
    const pp = reading.percent - previous.percent;
    const gap = (Date.parse(reading.ts) - Date.parse(previous.ts)) / 60_000;
    if (gap === 0 && pp === 0 && models.length === 0) continue;
    if (!Number.isFinite(gap) || gap <= 0 || !Number.isFinite(pp) || pp < 0 || previous.percent < 0 || reading.percent > 100) {
      close(); continue;
    }
    if (!models.length) {
      if (pp > 0) close();
      else if (block) { block.through = reading.ts; block.max_gap_minutes = Math.max(block.max_gap_minutes, gap); }
      continue;
    }
    const model = models[0]!.model;
    if (models.length !== 1 || !model || model === "?" || model.startsWith("<")) { close(); continue; }
    const usage = models[0]!;
    if (![usage.tokens, usage.events, usage.api_usd, usage.unpriced_events, usage.unknown_mode_tokens, usage.fast_tokens]
      .every(value => Number.isFinite(value) && value >= 0)) { close(); continue; }
    if (![usage.tokens, usage.events, usage.unpriced_events, usage.unknown_mode_tokens, usage.fast_tokens].every(Number.isSafeInteger)) { close(); continue; }
    if (pp > 0) result.single_model_intervals++;
    if (block && block.model !== model) close();
    block ??= { ...emptyUsage(), model, from: previous.ts, through: reading.ts, observed_pp: 0, max_gap_minutes: 0, reaches_100: false };
    block.through = reading.ts;
    block.observed_pp += pp;
    block.max_gap_minutes = Math.max(block.max_gap_minutes, gap);
    block.reaches_100 = reading.percent >= 100;
    for (const field of Object.keys(emptyUsage()) as Array<keyof ReturnType<typeof emptyUsage>>) block[field] += usage[field];
    if (!Number.isSafeInteger(block.tokens) || !Number.isSafeInteger(block.events) || !Number.isFinite(block.api_usd)) { block = null; continue; }
    if (block.observed_pp >= MODEL_CAPACITY_MIN_PP) close();
  }
  close();
  result.models = [...observed].sort();
  return result;
}

export function modelCapacitySpread(values: readonly number[]): ModelCapacitySpread | null {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const quantile = (p: number) => {
    const at = (sorted.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
  };
  return { median: quantile(0.5), p25: quantile(0.25), p75: quantile(0.75) };
}
