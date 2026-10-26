import { expect, test } from "bun:test";
import type { RateCard } from "./pricing";
import { codexPricingSettings, editCodexPricingPeriod } from "./codex-pricing-settings";
import { priceCodexEvent, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { configuredPriceMarkers } from "./codex-timeline-markers";
import type { CodexAccountingRule } from "../shared/codex-accounting";

test("saving a temporary API tariff reprices event dates and generates both boundary events independently of credits", () => {
  const rule: CodexAccountingRule = { id: "api", model: "gpt-test", billing_basis: "api_equivalent_usd", speed: "standard", valid_from: "2026-01-01",
    verified_at: "2026-01-01", sources: ["https://example.com/rates"], confidence: "official", rates: { in_uncached: 10, in_cache_read: 1, out_total: 50 }, multiplier: 1 };
  const card: RateCard = { version: 1, currency: "USD", unit: "per_million_tokens", vendors: {}, codex_accounting: { version: 1, rules: [rule, { ...rule, id: "credits", billing_basis: "chatgpt_credits", multiplier: 25 }] } };
  const next = editCodexPricingPeriod(card, { revision: codexPricingSettings(card).revision,
    rule: { ...rule, id: "discount", valid_from: "2026-07-10", valid_until: "2026-07-17", rates: { in_uncached: 5, in_cache_read: .5, out_total: 25 }, included_usage: "unknown" } });
  const config = resolveCodexAccountingConfig(next);
  const event = { model: "gpt-test", speed: "standard", in_tok: 1_000_000, cached_in: 0, out_tok: 0, cache_write: 0 };
  for (const [day, expected] of [["2026-07-09", 10], ["2026-07-10", 5], ["2026-07-16", 5], ["2026-07-17", 10]] as const) {
    expect(priceCodexEvent(config, { ...event, ts: `${day}T12:00:00Z` }, "api_equivalent_usd").amount).toBe(expected);
    expect(priceCodexEvent(config, { ...event, ts: `${day}T12:00:00Z` }, "chatgpt_credits").amount).toBe(250);
  }
  const changes = configuredPriceMarkers(next).filter(m => m.pricing?.some(p => p.model === "gpt-test"));
  expect(changes.map(m => m.day).sort()).toEqual(["2026-07-10", "2026-07-17"]);
  expect(changes.find(m => m.day === "2026-07-10")!.pricing).toMatchObject([{ basis: "api_equivalent_usd", before: { rates: { in_uncached: 10 } }, after: { confidence: "user", included_usage: "unknown", rates: { in_uncached: 5 } } }]);
  expect(changes.find(m => m.day === "2026-07-17")!.pricing).toMatchObject([{ before: { rates: { in_uncached: 5 } }, after: { rates: { in_uncached: 10 } } }]);
});

test("configured markers expose missing-price boundaries and long-context-only changes", () => {
  const base: CodexAccountingRule = { id: "a", model: "gpt-test", billing_basis: "api_equivalent_usd", speed: "standard", valid_from: "2026-01-01", valid_until: "2026-02-01",
    verified_at: "2026-01-01", sources: ["https://example.com/rates"], confidence: "user", rates: { in_uncached: 0, in_cache_read: 0, out_total: 0 }, multiplier: 1 };
  const rules = [base, { ...base, id: "b", valid_from: "2026-02-01", valid_until: "2026-03-01", long_context: { above_input_tokens: 272000, rates: { in_uncached: 20, in_cache_read: 2, out_total: 75 } } }];
  const card: RateCard = { version: 1, currency: "USD", unit: "per_million_tokens", vendors: {}, codex_accounting: { version: 1, rules } };
  const markers = configuredPriceMarkers(card).filter(m => m.pricing?.some(p => p.model === "gpt-test"));
  expect(markers.find(m => m.day === "2026-01-01")?.pricing?.[0]?.before).toBeNull();
  expect(markers.find(m => m.day === "2026-02-01")?.pricing?.[0]?.after?.long_context?.above_input_tokens).toBe(272000);
  expect(markers.find(m => m.day === "2026-03-01")?.pricing?.[0]?.after).toBeNull();
});
