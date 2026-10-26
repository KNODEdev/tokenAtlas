import { CONTEXT_USAGE_KEYS } from "../shared/codex-accounting";
import type { ContextRunningUsage, ModelSpend } from "./window-usage-contracts";
import type { TokenVector } from "./plans-catalog";
import type { ClaudeGaugeConfig } from "./claude-gauge";

export const runningKeys = ["events", "tokens", "priced_tokens", "unpriced_events", "api_standard", "credits_low", "credits_high", "api_normalized", ...CONTEXT_USAGE_KEYS] as const;

export const emptyRunning = (): ContextRunningUsage => ({ events: 0, tokens: 0, priced_tokens: 0, unpriced_events: 0, api_standard: 0, credits_low: 0, credits_high: 0, api_normalized: 0 });

export const emptyTokens = (): TokenVector => ({ in_uncached: 0, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 0 });

export const emptySpend = (model: string | null): ModelSpend => ({ model, events: 0, tokens: 0, fresh: 0,
  standard: 0, standard_unpriced: 0, actual: 0, actual_unpriced: 0 });

export const spendList = (spend: Map<string, ModelSpend>) => [...spend.values()].sort((a, b) => (a.model ?? "").localeCompare(b.model ?? ""));

/** Models of the Claude scoped (Fable) sublimit, lower-cased. */
export const claudeScopeModels = (gauge: ClaudeGaugeConfig) => (gauge.limits?.fable?.models ?? []).map(model => model.toLowerCase()).sort();
