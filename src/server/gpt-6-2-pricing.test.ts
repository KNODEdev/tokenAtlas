import { expect, test } from "bun:test";
import shipped from "../../rate-cards.json";
import { priceCodexEvent, resolveCodexAccountingConfig, type CodexAccountingEvent } from "./codex-accounting-pricing";
import { codexCreditEquivalent, getVendorModelRate, type RateCard } from "./pricing";

const card = shipped as unknown as RateCard;
const config = resolveCodexAccountingConfig(card);

test.each([
  { model: "gpt-6.2-astra", input: 8, cached: 0.4, write: 10, output: 40, credits: 1.21 },
  { model: "gpt-6.2-sol", input: 2, cached: 0.1, write: 2.5, output: 10, credits: 0.3025 },
])("$model resolves dated API and credit rates", ({ model, input, cached, write, output, credits }) => {
  const event: CodexAccountingEvent = {
    model, speed: "standard", ts: "2026-11-17T12:00:00Z", in_tok: 2000, cached_in: 1000, cache_write: 0, out_tok: 1000,
  };
  expect(getVendorModelRate(card, "openai", model)).toMatchObject({ in_uncached: input, in_cache_read: cached, out_total: output });
  expect(priceCodexEvent(config, event, "api_equivalent_usd").amount).toBeCloseTo((input + cached + output) / 1000, 12);
  expect(priceCodexEvent(config, { ...event, speed: "fast", in_tok: 3000, cache_write: 1000 }, "api_equivalent_usd").amount)
    .toBeCloseTo(2 * (input + cached + write + output) / 1000, 12);
  expect(priceCodexEvent(config, event, "chatgpt_credits").amount).toBeCloseTo(credits, 12);
  expect(priceCodexEvent(config, { ...event, speed: "fast" }, "chatgpt_credits").amount).toBeCloseTo(2 * credits, 12);
  expect(codexCreditEquivalent(card, model, event.in_tok, event.cached_in, event.out_tok)).toBeCloseTo(credits, 12);
  expect(priceCodexEvent(config, { ...event, ts: "2026-11-16T23:59:59Z" }, "api_equivalent_usd")).toMatchObject({ reason: "missing_rate" });
  expect(priceCodexEvent(config, { ...event, speed: "ultrafast" }, "api_equivalent_usd")).toMatchObject({ reason: "unknown_speed" });

  const premium = { ...config, long_context_premium: true };
  const boundary = { ...event, in_tok: 272000, cached_in: 272000 };
  expect(priceCodexEvent(premium, boundary, "api_equivalent_usd").long_context).toBe(false);
  const above = priceCodexEvent(premium, { ...boundary, in_tok: 272001 }, "api_equivalent_usd");
  expect(above.long_context).toBe(true);
  expect(above.amount).toBeCloseTo((2 * input + 272000 * 2 * cached + 1000 * 1.5 * output) / 1e6, 12);
});
