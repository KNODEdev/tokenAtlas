import { expect, test } from "bun:test";
import shipped from "../../rate-cards.json";
import { getClaudeRate, type RateCard } from "./pricing";
import { priceSubscriptionEvent, subscriptionAccountingAdapter, type SubscriptionEvent } from "./subscription-accounting-adapters";
import { withContextRates } from "./rate-cards-file";

const card = withContextRates(shipped as unknown as RateCard);
const q = { in_uncached: 1000, in_cache_read: 1000, in_cache_write_5m: 1000, in_cache_write_1h: 1000, in_cache_write_unknown: 0, out_total: 1000, out_thinking: 0 };

test("Claude Fable 5.2 and Mythos 5.2 have standard and fast rates", () => {
  for (const model of ["claude-fable-5-2", "claude-mythos-5-2"]) {
    expect(getClaudeRate(card, model, "2026-11-09", "standard"))
      .toEqual({ in_uncached: 8, in_cache_read: 0.2, in_cache_write_5m: 10, in_cache_write_1h: 16, out_total: 40 });
    expect(getClaudeRate(card, model, "2026-11-09", "fast"))
      .toEqual({ in_uncached: 16, in_cache_read: 0.4, in_cache_write_5m: 20, in_cache_write_1h: 32, out_total: 80 });
  }
  const claude = subscriptionAccountingAdapter("claude");
  const event: SubscriptionEvent = { account: null, account_key: null, source: "claude/fixture", identity: "fixture", eligible: true,
    vendor: "anthropic", home: "fixture", ts: "2026-11-09T12:00:00.000Z", model: "claude-fable-5-2", speed: "standard",
    usage_valid: true, precise_time: true, quantities: q };
  expect(priceSubscriptionEvent(card, claude, event).amount).toBeCloseTo((8 + 0.2 + 10 + 16 + 40) / 1000, 12);
});

test("Gemini 4 Hydrogen uses its paid tier and Argon and Carbon change rates on 2026-12-01", () => {
  const gemini = subscriptionAccountingAdapter("gemini");
  const call = (model: string, ts: string): SubscriptionEvent => ({ account: null, account_key: null, source: "gemini/fixture", identity: "fixture",
    eligible: true, vendor: gemini.modelRateVendor!(model), home: "fixture", ts, model, speed: "standard", usage_valid: true, precise_time: true,
    quantities: { ...q, in_cache_write_5m: 0, in_cache_write_1h: 0 } });
  for (const model of ["gemini-4-argon", "gemini-4-carbon"]) {
    expect(priceSubscriptionEvent(card, gemini, call(model, "2026-11-30T23:59:59.000Z")).amount).toBeCloseTo((2 + 0.1 + 10) / 1000, 12);
    expect(priceSubscriptionEvent(card, gemini, call(model, "2026-12-01T00:00:00.000Z")).amount).toBeCloseTo((4 + 0.2 + 20) / 1000, 12);
  }
  for (const day of ["2026-11-12", "2026-12-01"]) {
    expect(priceSubscriptionEvent(card, gemini, call("gemini-4-hydrogen", day + "T12:00:00Z")).amount)
      .toBeCloseTo((1.5 + 0.075 + 7.5) / 1000, 12);
  }
});
