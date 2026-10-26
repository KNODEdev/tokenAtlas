import { expect, test } from "bun:test";
import shipped from "../../rate-cards.json";
import type { RateCard } from "./pricing";
import { subscriptionAccountingAdapter, subscriptionEventFromRow, type SubscriptionEvent } from "./subscription-accounting-adapters";
import { subscriptionWindowAdapter } from "./subscription-window-adapter";
import { subscriptionWindowTraffic } from "./window-usage-traffic";
import type { LedgerEvent } from "../db/usage-ledger-events";

// Calls a Claude cloud session billed from the promotional credit (`billing_mode = 'grant'`) are recorded usage
// that the plan windows leave out as funded, as they do Codex credits (docs/cloud-sessions-import-2026-10-23.md).
const card = shipped as unknown as RateCard;
const adapter = subscriptionAccountingAdapter("claude");
const call = (funding?: "grant", precise = true): LedgerEvent => ({
  account: null, account_key: null, source: "claude/pc-cloud", identity: "msg_1", eligible: true, vendor: "anthropic", home: "live",
  ts: "2026-10-19T12:00:00.000Z", model: "claude-opus-5-5", speed: "standard", usage_valid: true, precise_time: precise,
  quantities: { in_uncached: 10, in_cache_read: 100, in_cache_write_5m: 0, in_cache_write_1h: 5, in_cache_write_unknown: 0, out_total: 0, out_thinking: 0 },
  ...(funding ? { funding } : {}),
  prices: { standard: { amount: 1, subtotal: 1, reason: null, costs: {} as never }, actual: null,
    global: { amount: 1, subtotal: 1, reason: null, costs: {} as never } },
} as LedgerEvent);

test("a granted call is read from its row and left out of the plan window as funded", () => {
  const row = { id: 1, store: "live", call_id: "msg_1", ts: "2026-10-19T12:00:00.000Z", model: "claude-opus-5-5", path: "x",
    in_uncached: 10, in_cache_read: 100, in_cache_write: 5, cache_write_5m: 0, cache_write_1h: 5, out_total: 0, out_thinking: 0 };
  expect((subscriptionEventFromRow(adapter, { ...row, billing_mode: "grant" }, "C:/archive") as SubscriptionEvent).funding).toBe("grant");
  expect(subscriptionEventFromRow(adapter, row, "C:/archive")).not.toHaveProperty("funding");

  const window = subscriptionWindowAdapter(adapter, "weekly", 10080, card);
  expect(window.include(call())).toBe(true);
  expect(window.include(call("grant"))).toBe(false);
  expect(window.exclusionReason!(call("grant"))).toBe("funding");
  expect(window.exclusionReason!(call(undefined, false))).toBe("imprecise_time");
  expect(window.exclusionReason!(call("grant", false))).toBe("funding");
});

test("every span variant keeps granted calls out and marks them credit-funded", () => {
  for (const options of [{}, { approximateTime: true }, { allModels: true }]) {
    const traffic = subscriptionWindowTraffic("claude", "claude:weekly_all:weekly:10080", card, undefined, options);
    expect(traffic.adapter.include(call("grant"))).toBe(false);
    expect(traffic.facts(call("grant")).credit_funded).toBe(true);
    expect(traffic.facts(call())).not.toHaveProperty("credit_funded");
  }
});
