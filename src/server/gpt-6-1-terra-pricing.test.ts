import { expect, test } from "bun:test";
import shipped from "../../rate-cards.json";
import { priceCodexEvent, resolveCodexAccountingConfig, type CodexAccountingEvent } from "./codex-accounting-pricing";
import { getVendorModelRate, isKnownUnpriced, type RateCard } from "./pricing";
import { priceSubscriptionEvent, subscriptionAccountingAdapter, type SubscriptionEvent } from "./subscription-accounting-adapters";
import { withContextRates } from "./rate-cards-file";

const card = shipped as unknown as RateCard;
const config = resolveCodexAccountingConfig(card);
const event = (patch: Partial<CodexAccountingEvent> = {}): CodexAccountingEvent => ({
  model: "gpt-6.1-terra", speed: "standard", ts: "2026-10-26T22:00:00Z",
  in_tok: 100000, cached_in: 80000, cache_write: 0, out_tok: 10000, ...patch,
});

test("GPT-6.1 Terra is priced from its 2026-10-26 launch in API and credit bases", () => {
  // Codex input includes its cached part: 20K fresh + 80K cached + 10K output.
  expect(priceCodexEvent(config, event(), "api_equivalent_usd").amount).toBeCloseTo(0.02 + 0.004 + 0.05, 12);
  expect(priceCodexEvent(config, event({ speed: "fast" }), "api_equivalent_usd").amount).toBeCloseTo(0.148, 12);
  expect(priceCodexEvent(config, event(), "chatgpt_credits").amount).toBeCloseTo(0.5 + 0.1 + 1.25, 12);
  expect(priceCodexEvent(config, event({ speed: "fast" }), "chatgpt_credits").amount).toBeCloseTo(1.85 * 2.5, 12);
  // No rule before the launch day: unpriced, not zero.
  expect(priceCodexEvent(config, event({ ts: "2026-10-25T23:59:59Z" }), "api_equivalent_usd").amount).toBeNull();
  expect(getVendorModelRate(card, "openai", "gpt-6.1-terra")).toMatchObject({ in_uncached: 1, in_cache_read: 0.05, out_total: 5 });
});

test("Antigravity variants price in the shared ledger; unidentifiable models stay deliberately unpriced", () => {
  const gemini = subscriptionAccountingAdapter("gemini");
  const call = (model: string): SubscriptionEvent => ({ account: null, account_key: null, source: "gemini/fixture", identity: "fixture", eligible: true,
    vendor: gemini.modelRateVendor!(model), home: "fixture", ts: "2026-07-01T12:00:00.000Z", model, speed: "standard", usage_valid: true, precise_time: true,
    quantities: { in_uncached: 1000, in_cache_read: 1000, in_cache_write_5m: 0, in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: 1000, out_thinking: 0 } });
  const ledgerCard = withContextRates(card);
  // Claude models seen through Antigravity price from their Google-card proxies.
  expect(priceSubscriptionEvent(ledgerCard, gemini, call("claude-opus-4-6-thinking")).amount).toBeCloseTo((5 + 0.5 + 25) / 1000, 12);
  for (const model of ["gemini-3-flash-a", "gemini-3-flash-e", "gemini-3-flash-medium-control"])
    expect(priceSubscriptionEvent(ledgerCard, gemini, call(model)).amount).toBeCloseTo((0.5 + 0.05 + 3) / 1000, 12);
  for (const model of ["gpt-oss-120b-medium", "gemini-pro-b"]) {
    expect(getVendorModelRate(card, "google", model)).toBeNull();
    expect(isKnownUnpriced(card, "google", model)).toBe(true);
  }
});
