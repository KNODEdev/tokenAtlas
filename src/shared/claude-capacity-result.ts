import type { CodexComparisonWindow, WindowUsage } from "./codex-accounting";
import { claudeShareNeverReported, type ClaudeCodeCapacitySummary, type ClaudeCodeCoverage } from "./claude-code-capacity";

export const CLAUDE_CAPACITY_RESULT_VERSION = 1;
export type ClaudeCapacityAmount = { value: number; absent: null; relation?: "≥" } | { value: null; absent: string; relation?: never };

/** Stored Standard valuations in exactly the selected meter sample. */
export interface ClaudeCapacityModelUsage {
  model: string; events: number; tokens: number; fresh: number;
  api_standard: number; unpriced_events: number;
}

export interface ClaudeCapacityModelResult {
  model: string;
  observed: boolean;
  price_index: number | null;
  usd_per_1m_gross: number | null;
  gross_tokens_per_point: number | null;
  fresh_tokens_per_point: number | null;
  calls_per_point: number | null;
  window: { calls: number; usd: number; gross: number; fresh: number; unpriced_calls: number };
  points_used: number | null;
  share_of_points: number | null;
  basis: "measured";
  low_sample: boolean;
  /** Model equivalents assume that meter burden follows Standard API value. */
  conditional: true;
  absent: string | null;
}

/** One serializable result, shared by Overview, Capacity, History and comparisons. */
export interface ClaudeCapacityResult {
  version: typeof CLAUDE_CAPACITY_RESULT_VERSION;
  account: string;
  window_id: string;
  window_minutes: number;
  api_value_basis: "standard" | "actual";
  basis: "code_share" | "local_meter" | "manual" | null;
  conditional: true;
  coverage: ClaudeCodeCoverage | null;
  reason: string | null;
  sample: { from: string; through: string; start_inclusive: boolean; end_inclusive: boolean;
    start_percent: number; end_percent: number; observed_pp: number } | null;
  capacity_tokens: ClaudeCapacityAmount;
  capacity_api_usd: ClaudeCapacityAmount;
  token_parts?: { fresh: number; cached: number; output: number };
  models: ClaudeCapacityModelResult[];
  price_reference_model: string | null;
  usage: { events: number; tokens: number; fresh: number; api_usd: number; unpriced_events: number };
}

type Window = Pick<CodexComparisonWindow, "id" | "account" | "window_minutes" | "start" | "end" | "start_percent"
  | "end_percent" | "observed_pp" | "usage" | "models" | "manual_measurement" | "claude_code_capacity" | "start_basis">;

/** Explicit markers prevent an unavailable or foreign estimate inheriting local arithmetic. */
export function claudeCodeCapacityForWindow(window: Pick<Window, "id" | "account" | "window_minutes" | "claude_code_capacity">): ClaudeCodeCapacitySummary | null | undefined {
  const summary = window.claude_code_capacity;
  if (summary === undefined) return undefined;
  if (!summary || summary.window_id !== window.id || (window.window_minutes ?? 10080) !== 10080
    || typeof summary.account !== "string" || summary.account.trim().toLowerCase() !== window.account.trim().toLowerCase()
    || summary.api_value_basis !== "standard" || summary.conditional !== true) return null;
  const share = summary.share_percent, utilization = summary.utilization_percent;
  return typeof share === "number" && Number.isFinite(share) && share > 0 && share <= 100
    && typeof utilization === "number" && Number.isFinite(utilization) && utilization > 0 && utilization <= 100 ? summary : null;
}

const absent = (reason: string): ClaudeCapacityAmount => ({ value: null, absent: reason });
const amount = (value: number, partial = false): ClaudeCapacityAmount => !Number.isFinite(value) || value < 0
  ? absent("unsafe_total") : { value, absent: null, ...(partial ? { relation: "≥" as const } : {}) };

export function claudeCapacityPerPoint(result: ClaudeCapacityResult, metric: "tokens" | "api_standard"): number | null {
  const value = metric === "tokens" ? result.capacity_tokens.value : result.capacity_api_usd.value;
  return value === null ? null : value / 100;
}

function modelResults(usage: readonly ClaudeCapacityModelUsage[], result: Omit<ClaudeCapacityResult, "models" | "price_reference_model" | "usage">) {
  const completeRate = (row: ClaudeCapacityModelUsage) => row.tokens > 0 && row.api_standard > 0 && row.unpriced_events === 0
    ? row.api_standard / row.tokens : null;
  const reference = [...usage].filter(row => /(?:^|-)opus(?:-|$)/.test(row.model) && completeRate(row) !== null)
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))[0];
  const referenceRate = reference ? completeRate(reference) : null;
  const point = result.capacity_api_usd.value === null ? null : result.capacity_api_usd.value / 100;
  const models = usage.map((row): ClaudeCapacityModelResult => {
    const rate = completeRate(row);
    const reason = result.reason ?? (row.unpriced_events > 0 || result.capacity_api_usd.relation === "≥" ? "unpriced"
      : rate === null || point === null || point <= 0 ? "no_priced_traffic" : null);
    const equivalent = reason === null ? point! / rate! : null;
    const points = reason === null ? row.api_standard / point! : null;
    return { model: row.model, observed: true, conditional: true, absent: reason, basis: "measured",
      price_index: rate !== null && referenceRate ? rate / referenceRate : null,
      usd_per_1m_gross: rate === null ? null : rate * 1e6,
      gross_tokens_per_point: equivalent,
      fresh_tokens_per_point: equivalent === null ? null : equivalent * row.fresh / row.tokens,
      calls_per_point: points !== null && points > 0 ? row.events / points : null,
      window: { calls: row.events, usd: row.api_standard, gross: row.tokens, fresh: row.fresh, unpriced_calls: row.unpriced_events },
      points_used: points,
      share_of_points: points !== null && result.sample && result.sample.observed_pp > 0 ? points / result.sample.observed_pp * 100 : null,
      low_sample: row.events < 100 || points !== null && points < 0.5 };
  });
  return { ...result, models: models.sort((a, b) => a.model.localeCompare(b.model)), price_reference_model: reference?.model ?? null,
    usage: usage.reduce((sum, row) => ({ events: sum.events + row.events, tokens: sum.tokens + row.tokens,
      fresh: sum.fresh + row.fresh, api_usd: sum.api_usd + row.api_standard, unpriced_events: sum.unpriced_events + row.unpriced_events }),
      { events: 0, tokens: 0, fresh: 0, api_usd: 0, unpriced_events: 0 }) };
}

export function claudeModelsFromWindow(models: Array<WindowUsage & { name: string }>): ClaudeCapacityModelUsage[] {
  // Claude input includes cache writes and reads; output is separate.
  return models.map(row => ({ model: row.name, events: row.events, tokens: row.tokens,
    fresh: Math.max(0, row.input - row.cached - (row.cache_write_5m ?? 0) - (row.cache_write_1h ?? 0) - (row.cache_write_unknown ?? 0)) + row.output,
    api_standard: row.api_standard, unpriced_events: row.unpriced_events }));
}

export function claudeCapacityResult(window: Window): ClaudeCapacityResult {
  const shared = claudeCodeCapacityForWindow(window);
  const base = { version: CLAUDE_CAPACITY_RESULT_VERSION as 1, account: window.account.toLowerCase(), window_id: window.id,
    window_minutes: window.window_minutes ?? 10080,
    coverage: null,
    api_value_basis: "standard" as const, conditional: true as const };
  if (shared && shared.source_from && shared.source_through && shared.sample_meter) {
    return claudeCapacityResultFromSummary(shared);
  }
  const local = window.manual_measurement || claudeShareNeverReported(window);
  const reason = !local ? window.claude_code_capacity?.reason ?? "window_mismatch"
    : !Number.isFinite(window.observed_pp) || window.observed_pp <= 0 ? "delta_nonpositive"
      : window.usage.events <= 0 ? "no_code_tokens" : null;
  const partial = window.usage.unpriced_events > 0;
  return modelResults(claudeModelsFromWindow(window.models), { ...base,
    basis: local ? window.manual_measurement ? "manual" : "local_meter" : null, reason,
    sample: { from: window.start, through: window.end, start_inclusive: window.start_basis === "reset",
      end_inclusive: true, start_percent: window.start_percent, end_percent: window.end_percent, observed_pp: window.observed_pp },
    ...(local && !reason ? { token_parts: {
      fresh: Math.max(0, window.usage.input - window.usage.cached - (window.usage.cache_write_5m ?? 0)
        - (window.usage.cache_write_1h ?? 0) - (window.usage.cache_write_unknown ?? 0)) / window.observed_pp * 100,
      cached: window.usage.cached / window.observed_pp * 100, output: window.usage.output / window.observed_pp * 100 } } : {}),
    capacity_tokens: reason ? absent(reason) : amount(window.usage.tokens / window.observed_pp * 100),
    capacity_api_usd: reason ? absent(reason) : window.usage.events <= window.usage.unpriced_events ? absent("unpriced")
      : amount(window.usage.api_standard / window.observed_pp * 100, partial) });
}

/** A selected share sample carries everything a range consumer needs. */
export function claudeCapacityResultFromSummary(summary: ClaudeCodeCapacitySummary): ClaudeCapacityResult {
  const reason = summary.reason ?? (!summary.source_from || !summary.source_through || !summary.sample_meter ? "window_mismatch" : null);
  return modelResults(summary.observed_models ?? [], { version: CLAUDE_CAPACITY_RESULT_VERSION,
    account: summary.account.toLowerCase(), window_id: summary.window_id ?? "", window_minutes: 10080, api_value_basis: "standard", conditional: true,
    coverage: summary.coverage,
    basis: reason ? null : "code_share", reason,
    sample: summary.source_from && summary.source_through && summary.sample_meter ? { from: summary.source_from,
      through: summary.source_through, start_inclusive: summary.basis === "cumulative", end_inclusive: true, ...summary.sample_meter } : null,
    capacity_tokens: reason ? absent(reason) : summary.weekly_capacity_tokens,
    capacity_api_usd: reason ? absent(reason) : summary.weekly_capacity_api_usd });
}

/** Gauge intervals retain their actual-mode valuation and exclusive cutoff. */
export function manualClaudeCapacityResult(input: { account: string; window_id: string; from: string; through: string; percent: number;
  models: ClaudeCapacityModelUsage[]; window_minutes?: number }): ClaudeCapacityResult {
  const tokens = input.models.reduce((sum, row) => sum + row.tokens, 0), usd = input.models.reduce((sum, row) => sum + row.api_standard, 0);
  const partial = input.models.some(row => row.unpriced_events > 0);
  const reason = input.percent > 0 && input.percent < 100 ? null : "delta_nonpositive";
  return modelResults(input.models, { version: CLAUDE_CAPACITY_RESULT_VERSION, account: input.account.toLowerCase(), window_id: input.window_id, window_minutes: input.window_minutes ?? 10080,
    api_value_basis: "actual", conditional: true, coverage: null, basis: "manual", reason,
    sample: { from: input.from, through: input.through, start_inclusive: true, end_inclusive: false, start_percent: 0, end_percent: input.percent, observed_pp: input.percent },
    capacity_tokens: reason ? absent(reason) : amount(tokens / input.percent * 100),
    capacity_api_usd: reason ? absent(reason) : amount(usd / input.percent * 100, partial) });
}
