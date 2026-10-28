import { describe, expect, test } from "bun:test";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
import type { SubscriptionModelDetail } from "../../shared/subscription-accounting";
import { modelUnitCosts } from "./model-unit-cost";
import { modelColorsByTokens, vendorShade } from "./model-colors";

type Row = CodexAccountingReport["breakdown"][number];
type Coverage = Row["normalization"]["standard_api_usd"];
const coverage = (priced: number, pricedEvents: number, pricedTokens: number, unpricedEvents = 0): Coverage =>
  ({ value: null, priced_subtotal: priced, status: "partial", priced_events: pricedEvents, unpriced_events: unpricedEvents, priced_tokens: pricedTokens, unpriced_tokens: 0, reasons: {} });
const codexRow = (model: string | null, tokens: number, api: Coverage): Row => ({ day: "2026-10-01", model, speed: "standard", account: "codex1", home: null,
  events: 1, tokens, amounts: { chatgpt_credits: api, api_equivalent_usd: api }, normalization: { standard_api_usd: api, normalized_usd: api, standard_credits: api, extra_credits: api } });
const rule = (model: string, from: string, input: number, extra: Partial<CodexAccountingReport["applied_rules"][number]> = {}): CodexAccountingReport["applied_rules"][number] => ({
  id: `${model}:${from}`, model, billing_basis: "api_equivalent_usd", speed: "standard", valid_from: from, verified_at: from, sources: [], confidence: "official",
  rates: { in_uncached: input, in_cache_read: input / 10, in_cache_write: input * 1.25, out_total: input * 5 }, multiplier: 1, ...extra });
const report = (patch: Partial<CodexAccountingReport>) => ({ breakdown: [], applied_rules: [], model_details: [], ...patch }) as unknown as CodexAccountingReport;
const detail = (model: string, day: string, speed: string, tokens: number, api: number | null, input: number | null): SubscriptionModelDetail => ({
  day, model, speed, source: "cli", calls: 1, tokens, quantities: {}, costs: {}, api_standard: api, api_actual: api, pricing_source: null, pricing_note: "",
  rates: { in_uncached: input, in_cache_read: input === null ? null : input / 10, in_cache_write_5m: input === null ? null : input * 1.25, in_cache_write_1h: null, out_total: input === null ? null : input * 5 } });

describe("cost per 1M tokens", () => {
  test("Codex divides the Standard value by priced tokens only and takes the latest list prices", () => {
    const summary = modelUnitCosts(report({
      breakdown: [
        codexRow("gpt-6-sol", 2_000_000, coverage(1, 1, 2_000_000)),
        codexRow("gpt-6-sol", 1_000_000, coverage(0, 0, 0, 1)),
        codexRow("gpt-6-astra", 1_000_000, coverage(4, 1, 1_000_000)),
      ],
      applied_rules: [rule("gpt-6-sol", "2026-09-01", 4), rule("gpt-6-sol", "2026-09-22", 2), rule("gpt-6-sol", "2026-09-22", 9, { long_context: { above_input_tokens: 1, rates: { in_uncached: 9, in_cache_read: 1, out_total: 45 } } }),
        rule("gpt-6-astra", "2026-09-08", 10), rule("gpt-6-astra", "2026-09-08", 20, { speed: "fast" })],
    }), true);
    expect(summary.rows.map(row => [row.model, row.perMillion, row.partial])).toEqual([["gpt-6-astra", 4, false], ["gpt-6-sol", 0.5, true]]);
    expect(summary.rows[1]!.rates).toEqual({ cacheRead: 0.2, input: 2, cacheWrite: 2.5, output: 10, changed: true });
    expect(summary.rows[0]!.rates).toMatchObject({ input: 10, changed: false });
    expect(summary.perMillion).toBeCloseTo(5 / 3);
  });

  test("other providers read their detail rows; Speed rates are not list prices and unpriced rows stay out", () => {
    const summary = modelUnitCosts(report({ model_details: [
      detail("claude-opus-5-5", "2026-10-01", "standard", 1_000_000, 3, 5),
      detail("claude-opus-5-5", "2026-10-02", "fast", 1_000_000, 6, 10),
      detail("claude-opus-5-5", "2026-10-03", "unknown", 500_000, null, null),
    ] }), false);
    expect(summary.rows[0]).toMatchObject({ tokens: 2_500_000, pricedTokens: 2_000_000, apiUsd: 9, perMillion: 4.5, partial: true,
      rates: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25, changed: false } });
  });

  test("colours follow tokens, so a model keeps its shade whatever a view sorts by", () => {
    const colors = modelColorsByTokens([{ model: "claude-a", tokens: 1 }, { model: "claude-b", tokens: 5 }, { model: "gpt-6", tokens: 2 }]);
    expect(colors.get("claude-b")).toBe("var(--claude)");
    expect(colors.get("claude-a")).toBe(vendorShade("var(--claude)", 1));
    expect(colors.get("gpt-6")).toBe("var(--codex)");
    expect(modelColorsByTokens([{ model: "auto", tokens: 1 }], "gemini").get("auto")).toBe("var(--gemini)");
  });
});
