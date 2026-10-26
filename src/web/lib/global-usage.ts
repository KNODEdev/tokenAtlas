import type { GlobalUsageRow, UsageAmount } from "../../shared/global-usage";
import { isCodexInternalReview } from "../../shared/codex-internal";
import { usageModelLabel } from "./format";

/** User-work tokens, API-eq, calls and estimated ChatGPT credits; internal review is a caption, not a measure. */
export type UsageMetric = "user_tokens" | "api_usd" | "calls" | "credits";
export type UsageGrouping = "day" | "week" | "month";
export type UsageSplit = "provider" | "model";
export type UsageFilters = Record<"provider" | "account" | "source" | "model", string[] | null>;
export const ALL_USAGE_FILTERS: UsageFilters = { provider: null, account: null, source: null, model: null };
export const UNKNOWN_USAGE_KEY = "\u0000unknown";
/** Chart segment of the models outside the top of the model breakdown. */
export const OTHER_USAGE_KEY = "\u0000other";
export const USAGE_TOP_MODELS = 6;
export const usageModelKey = (row: Pick<GlobalUsageRow, "provider" | "model">) => JSON.stringify([row.provider, row.model]);
export const usageAccountKey = (row: Pick<GlobalUsageRow, "provider" | "account">) => JSON.stringify([row.provider, row.account ?? UNKNOWN_USAGE_KEY]);

export function filterUsageRows(rows: GlobalUsageRow[], filters: UsageFilters): GlobalUsageRow[] {
  const sets = Object.fromEntries(Object.entries(filters).map(([key, values]) => [key, values === null ? null : new Set(values)])) as Record<keyof UsageFilters, Set<string> | null>;
  return rows.filter(row => (sets.provider === null || sets.provider.has(row.provider))
    && (sets.account === null || sets.account.has(usageAccountKey(row)))
    && (sets.source === null || sets.source.has(row.source))
    && (sets.model === null || sets.model.has(usageModelKey(row))));
}

export function usageBucket(day: string, group: UsageGrouping): string {
  if (group === "month") return day.slice(0, 7) + "-01";
  if (group === "day") return day;
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

export function usageDateRange(days: number, now = new Date()) {
  const until = now.toISOString().slice(0, 10);
  return { since: new Date(Date.parse(until) - (days - 1) * 86400000).toISOString().slice(0, 10), until };
}

export function usageValue(row: Pick<GlobalUsageRow, "tokens" | "calls" | "api_usd" | "credits"> & Partial<Pick<GlobalUsageRow, "internal_tokens" | "source" | "model">>, metric: UsageMetric): number {
  if (metric === "user_tokens") return row.tokens - internalTokens(row);
  return metric === "calls" ? row.calls : row[metric].subtotal;
}

function internalTokens(row: { tokens: number; internal_tokens?: number; source?: string; model?: string | null }): number {
  return row.internal_tokens ?? (row.source === "codex" && isCodexInternalReview(row.model) ? row.tokens : 0);
}

/**
 * Rows made only of internal review traffic. The server keys rows by model, so review rows stand
 * apart from user work; a row mixing both keeps its calls and prices with user work and only its
 * review tokens are subtracted by `usageValue`.
 */
export function isUsageReviewRow(row: GlobalUsageRow): boolean {
  const internal = internalTokens(row);
  return internal > 0 && internal >= row.tokens;
}

export function emptyUsageTotals() {
  return { tokens: 0, internal_tokens: 0, calls: 0, input: 0, cache_read: 0, cache_write: 0, output: 0,
    api_usd: { subtotal: 0, priced_calls: 0, unpriced_calls: 0 } as UsageAmount,
    credits: { subtotal: 0, priced_calls: 0, unpriced_calls: 0 } as UsageAmount };
}
export type UsageTotals = ReturnType<typeof emptyUsageTotals>;
export function addUsageTotals(total: UsageTotals, row: Omit<UsageTotals, "internal_tokens"> & Partial<Pick<GlobalUsageRow, "internal_tokens" | "source" | "model">>) {
  total.internal_tokens += internalTokens(row);
  for (const key of ["tokens", "calls", "input", "cache_read", "cache_write", "output"] as const) total[key] += row[key];
  for (const key of ["api_usd", "credits"] as const) {
    total[key].subtotal += row[key].subtotal;
    total[key].priced_calls += row[key].priced_calls;
    total[key].unpriced_calls += row[key].unpriced_calls;
  }
}
export function usageTotals(rows: GlobalUsageRow[]) {
  const totals = emptyUsageTotals();
  for (const row of rows) addUsageTotals(totals, row);
  return totals;
}

export interface UsagePeriod extends UsageTotals { day: string; segments: Map<string, number>; observed: boolean }
/** `models` limits the model split to those keys; every other model lands in `OTHER_USAGE_KEY`. */
export function usagePeriods(rows: GlobalUsageRow[], since: string, until: string, group: UsageGrouping, split: UsageSplit, metric: UsageMetric, models?: ReadonlySet<string>): UsagePeriod[] {
  const periods = new Map<string, UsagePeriod>();
  for (let time = Date.parse(since); time <= Date.parse(until); time += 86400000) {
    const day = usageBucket(new Date(time).toISOString().slice(0, 10), group);
    if (!periods.has(day)) periods.set(day, { ...emptyUsageTotals(), day, segments: new Map(), observed: false });
  }
  for (const row of rows) {
    const period = periods.get(usageBucket(row.day, group));
    if (!period) continue;
    period.observed = true;
    addUsageTotals(period, row);
    const model = usageModelKey(row);
    const key = split === "provider" ? row.provider : !models || models.has(model) ? model : OTHER_USAGE_KEY;
    period.segments.set(key, (period.segments.get(key) ?? 0) + usageValue(row, metric));
  }
  return [...periods.values()];
}

/** The largest models by the measure, largest first. */
export function topUsageModels(rows: GlobalUsageRow[], metric: UsageMetric, limit = USAGE_TOP_MODELS): Set<string> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(usageModelKey(row), (totals.get(usageModelKey(row)) ?? 0) + usageValue(row, metric));
  return new Set([...totals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key]) => key));
}

export const USAGE_PROVIDER_LABELS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", xai: "xAI", zai: "Z.ai", unknown: "?" };
export const USAGE_SOURCE_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude Code", gemini: "Antigravity", grok: "Grok", opencode: "OpenCode" };
export function usageProviderColor(provider: string): string {
  return ({ openai: "var(--codex)", anthropic: "var(--claude)", google: "var(--gemini)", xai: "var(--grok)", zai: "var(--glm)" } as Record<string, string>)[provider] ?? "var(--muted)";
}
export interface UsageSeriesItem { key: string; label: string; color: string }
/** Chart series; with `models`, the model split keeps only those models plus one "other" series. */
export function usageSeries(rows: GlobalUsageRow[], split: UsageSplit, models?: ReadonlySet<string>, otherLabel = "…"): UsageSeriesItem[] {
  const byProvider = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byProvider.get(row.provider) ?? new Set<string>();
    set.add(row.model ?? ""); byProvider.set(row.provider, set);
  }
  const series = [...byProvider].sort(([a], [b]) => a.localeCompare(b)).flatMap(([provider, names]) => {
    const label = USAGE_PROVIDER_LABELS[provider] ?? provider;
    const base = usageProviderColor(provider);
    if (split === "provider") return [{ key: provider, label, color: base }];
    return [...names].sort().map(model => ({ key: usageModelKey({ provider, model: model || null }),
      label: `${label} / ${usageModelLabel(model || "?")}`,
      color: usageModelColor(provider, model) }));
  });
  if (split === "provider" || !models) return series;
  const kept = series.filter(item => models.has(item.key));
  return kept.length < series.length ? [...kept, { key: OTHER_USAGE_KEY, label: otherLabel, color: "var(--line2)" }] : kept;
}

/** A stable shade of the provider colour per model, the same in the chart and the table. */
export function usageModelColor(provider: string, model: string | null): string {
  return `color-mix(in oklab, ${usageProviderColor(provider)} ${modelShade(model ?? "")}%, var(--surface))`;
}

function modelShade(model: string): number {
  let hash = 0;
  for (const character of model) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return 45 + (hash % 6) * 11;
}
