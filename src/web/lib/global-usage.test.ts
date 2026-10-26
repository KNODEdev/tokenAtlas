import { describe, expect, test } from "bun:test";
import type { GlobalUsageRow } from "../../shared/global-usage";
import { ALL_USAGE_FILTERS, filterUsageRows, isUsageReviewRow, OTHER_USAGE_KEY, topUsageModels, usageAccountKey, usageBucket, usageDateRange,
  usageModelKey, usagePeriods, usageSeries, usageTotals, usageValue } from "./global-usage";

const row = (patch: Partial<GlobalUsageRow> = {}): GlobalUsageRow => ({ day: "2026-09-08", provider: "openai", source: "codex", account: "main", model: "m1",
  tokens: 100, calls: 1, input: 40, cache_read: 30, cache_write: 10, output: 20,
  api_usd: { subtotal: 2, priced_calls: 1, unpriced_calls: 0 }, credits: { subtotal: 0, priced_calls: 0, unpriced_calls: 1 }, credit_unit: null, ...patch });

describe("global usage presentation", () => {
  test("internal review stays visible but is excluded from user-work totals and chart shares", () => {
    const rows = [row(), row({ model: "codex-auto-review", tokens: 200 })];
    const totals = usageTotals(rows);
    expect(totals.tokens).toBe(300);
    expect(totals.internal_tokens).toBe(200);
    expect(usageValue(totals, "user_tokens")).toBe(100);
    const period = usagePeriods(rows, "2026-09-08", "2026-09-08", "day", "model", "user_tokens")[0]!;
    expect(usageValue(period, "user_tokens")).toBe(100);
    expect([...period.segments.values()].reduce((sum, n) => sum + n, 0)).toBe(100);
    expect(usageValue(row({ source: "opencode", model: "codex-auto-review" }), "user_tokens")).toBe(100);
    expect(usageValue(row({ internal_tokens: 40 }), "user_tokens")).toBe(60);
  });
  test("only rows made entirely of review traffic count as review rows", () => {
    expect(isUsageReviewRow(row({ model: "codex-auto-review" }))).toBe(true);
    expect(isUsageReviewRow(row({ model: null, internal_tokens: 100 }))).toBe(true);
    expect(isUsageReviewRow(row({ internal_tokens: 40 }))).toBe(false);
    expect(isUsageReviewRow(row())).toBe(false);
    expect(isUsageReviewRow(row({ source: "opencode", model: "codex-auto-review" }))).toBe(false);
  });
  test("the model split keeps the top models by the measure and folds the rest into one series", () => {
    const rows = ["a", "b", "c"].map((model, index) => row({ model, tokens: 100 * (index + 1), calls: 3 - index }));
    const byTokens = topUsageModels(rows, "user_tokens", 2);
    expect([...byTokens]).toEqual([usageModelKey(rows[2]!), usageModelKey(rows[1]!)]);
    expect([...topUsageModels(rows, "calls", 1)]).toEqual([usageModelKey(rows[0]!)]);
    const period = usagePeriods(rows, "2026-09-08", "2026-09-08", "day", "model", "user_tokens", byTokens)[0]!;
    expect(period.segments.get(OTHER_USAGE_KEY)).toBe(100);
    expect([...period.segments.values()].reduce((sum, n) => sum + n, 0)).toBe(600);
    const series = usageSeries(rows, "model", byTokens, "Other");
    expect(series.map(item => item.key)).toEqual([usageModelKey(rows[1]!), usageModelKey(rows[2]!), OTHER_USAGE_KEY]);
    expect(usageSeries(rows, "model", new Set(rows.map(usageModelKey)), "Other").some(item => item.key === OTHER_USAGE_KEY)).toBe(false);
  });
  test("all differs from none, account/model keys cannot collide across providers", () => {
    const first = row(), second = row({ provider: "anthropic", source: "opencode" });
    const rows = [first, second];
    expect(filterUsageRows(rows, ALL_USAGE_FILTERS)).toHaveLength(2);
    expect(filterUsageRows(rows, { ...ALL_USAGE_FILTERS, provider: [] })).toHaveLength(0);
    expect(filterUsageRows(rows, { ...ALL_USAGE_FILTERS, account: [usageAccountKey(second)] })).toEqual([second]);
    expect(filterUsageRows(rows, { ...ALL_USAGE_FILTERS, model: [usageModelKey(first)] })).toEqual([first]);
    expect(filterUsageRows(rows, { ...ALL_USAGE_FILTERS, source: ["opencode"] })).toEqual([second]);
  });
  test("chart and table share exact sums and preserve absent valuations and gap days", () => {
    const rows = [row(), row({ model: "m2", tokens: 200, api_usd: { subtotal: 0, priced_calls: 0, unpriced_calls: 1 } })];
    const periods = usagePeriods(rows, "2026-09-08", "2026-09-10", "day", "model", "user_tokens");
    expect(periods).toHaveLength(3);
    expect(periods[0]!.tokens).toBe(usageTotals(rows).tokens);
    expect([...periods[0]!.segments.values()].reduce((a,b) => a+b,0)).toBe(300);
    expect(periods[1]!.observed).toBe(false);
    expect(usageTotals(rows).api_usd).toEqual({ subtotal: 2, priced_calls: 1, unpriced_calls: 1 });
  });
  test("calendar buckets use UTC Mondays and calendar month boundaries", () => {
    expect(usageBucket("2026-09-13", "week")).toBe("2026-09-07");
    expect(usageBucket("2026-09-14", "week")).toBe("2026-09-14");
    expect(usageBucket("2026-09-30", "month")).toBe("2026-09-01");
    expect(usageDateRange(7, new Date("2026-09-12T23:59:59Z"))).toEqual({ since: "2026-09-06", until: "2026-09-12" });
  });
  test("model shades remain stable across periods and filtering", () => {
    const rows = [row(), row({ model: "m2" })];
    expect(usageSeries(rows, "model")[0]!.color).toBe(usageSeries([rows[0]!], "model")[0]!.color);
    expect(usageSeries(rows, "provider")).toHaveLength(1);
  });
});
