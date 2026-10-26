import { expect, test } from "bun:test";
import shipped from "../../rate-cards.json";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { getClaudeGroupRate, getClaudeRate, type RateCard } from "./pricing";
import { priceSubscriptionEvent, subscriptionAccountingAdapter, type SubscriptionEvent } from "./subscription-accounting-adapters";
import { ledgerRateChoice, valueLedgerQuantities } from "./usage-ledger-rates";
import { createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { stepUsageLedger } from "./usage-ledger-producer";
import { referenceFingerprint } from "./window-usage";
import { loadRateCard, rateCardsFileReader, withContextRates } from "./rate-cards-file";
import { subscriptionWindowAdapter } from "./subscription-window-adapter";
import { subscriptionRulesDigest } from "../db/usage-price-totals";

/** The premium mechanics below apply its tiers, so these cards turn the vendors' premium on (default off). */
const withPremium = (c: RateCard) => { for (const v of ["anthropic", "google"]) c.vendors[v]!.long_context_premium = true; return c; };
const offCard = withContextRates(shipped as unknown as RateCard);
const card = withPremium(withContextRates(shipped as unknown as RateCard));
const adapter = subscriptionAccountingAdapter("claude");
const base = { in_uncached: 0.1, in_cache_read: 0.01, in_cache_write_5m: 0.125, in_cache_write_1h: 0.2, out_total: 0.5 };
const long = { in_uncached: 0.5, in_cache_read: 0.05, in_cache_write_5m: 0.625, in_cache_write_1h: 1, out_total: 2.5 };
function event(input: number, cached = 0, write5 = 0, write1 = 0, output = 1000): SubscriptionEvent {
  return { account: null, account_key: null, source: "claude/fixture", identity: "haiku", eligible: true, vendor: "anthropic",
    home: "fixture", ts: "2026-10-10T12:00:00.000Z", model: "claude-haiku-5-5", speed: "standard", usage_valid: true, precise_time: true,
    quantities: { in_uncached: input, in_cache_read: cached, in_cache_write_5m: write5, in_cache_write_1h: write1,
      in_cache_write_unknown: 0, out_total: output, out_thinking: 0 } };
}

test("tiered catalog is loaded only by supporting code, preserves explicit overrides and stable reader memo", () => {
  expect(shipped).not.toHaveProperty("long_context");
  expect(shipped.vendors.anthropic.models).not.toHaveProperty("claude-haiku-5-5");
  const loaded = loadRateCard(`${import.meta.dir}/../../rate-cards.json`);
  expect(loaded.vendors.anthropic!.models!["claude-haiku-5-5"]!.long_context!.above_input_tokens).toBe(100000);
  const read = rateCardsFileReader(() => `${import.meta.dir}/../../rate-cards.json`);
  const first = read();
  expect(read()).toEqual({ rates: first.rates, changed: false });
  expect(read().rates).toBe(first.rates);
  const overridden = structuredClone(card);
  overridden.vendors.anthropic!.models!["claude-haiku-5-5"]!.in_uncached = 9;
  expect(withContextRates(overridden).vendors.anthropic!.models!["claude-haiku-5-5"]!.in_uncached).toBe(9);
  // A card entry overrides fields, keeps the catalog tier unless it removes it explicitly.
  const flat = structuredClone(shipped) as unknown as RateCard;
  flat.vendors.anthropic!.models!["claude-haiku-5-5"] = { ...base, in_uncached: 0.2 } as never;
  const merged = withContextRates(flat).vendors.anthropic!.models!["claude-haiku-5-5"]!;
  expect(merged.in_uncached).toBe(0.2);
  expect(merged.long_context!.above_input_tokens).toBe(100000);
  (flat.vendors.anthropic!.models!["claude-haiku-5-5"] as Record<string, unknown>).long_context = null;
  expect(withContextRates(flat).vendors.anthropic!.models!["claude-haiku-5-5"]).not.toHaveProperty("long_context");
});

test("Haiku's exact 100K boundary includes cache reads/writes and excludes output", () => {
  for (const e of [event(100000), event(1000, 97000, 1000, 1000, 200000), event(0, 100000), event(0, 0, 100000)]) {
    const rate = priceSubscriptionEvent(card, adapter, e);
    expect(rate.rates.in_uncached).toBe(base.in_uncached);
    expect(rate.amount).toBeCloseTo(Object.entries(base).reduce((sum, [k, r]) => sum + e.quantities[k as keyof typeof base] * r / 1e6, 0), 12);
  }
  for (const e of [event(100001), event(1, 100000), event(0, 0, 100001), event(0, 0, 0, 100001)]) {
    const rate = priceSubscriptionEvent(card, adapter, e);
    expect(rate.rates.in_uncached).toBe(long.in_uncached);
    expect(rate.amount).toBeCloseTo(Object.entries(long).reduce((sum, [k, r]) => sum + e.quantities[k as keyof typeof long] * r / 1e6, 0), 12);
    const choice = ledgerRateChoice(card, adapter, e, false);
    expect(valueLedgerQuantities(e.quantities, true, choice).subtotal).toBe(BigInt(Math.round(rate.amount! * 1e15)));
  }
});

test("legacy single-request pricing uses the same band; absent context and unknown cache duration remain unpriced", () => {
  expect(getClaudeRate(card, "claude-haiku-5-5", "2026-10-10", "standard")).toBeNull();
  expect(getClaudeRate(card, "claude-haiku-5-5", "2026-10-10", "standard", 100000)).toEqual(base);
  expect(getClaudeGroupRate(card, "claude-haiku-5-5", "2026-10-10", "standard",
    { in_uncached: 1, in_cache_read: 99999, in_cache_write: 1, cache_write_5m: 1, cache_write_1h: 0 })).toEqual(long);
  const unknown = event(100000);
  unknown.quantities.in_cache_write_unknown = 1;
  expect(priceSubscriptionEvent(card, adapter, unknown).amount).toBeNull();
  expect(priceSubscriptionEvent(card, adapter, unknown).rates.in_uncached).toBe(0.5);
  expect(priceSubscriptionEvent(card, adapter, { ...event(100001), speed: "fast" }).amount).toBeNull();
});

test("reference windows distinguish long prices and threshold changes", () => {
  const next = structuredClone(card);
  const before = referenceFingerprint(card, "claude", "2026-10-10");
  next.vendors.anthropic!.models!["claude-haiku-5-5"]!.long_context!.rates.out_total = 3;
  expect(referenceFingerprint(next, "claude", "2026-10-10")).not.toBe(before);
  next.vendors.anthropic!.models!["claude-haiku-5-5"]!.long_context!.above_input_tokens = 110000;
  expect(referenceFingerprint(next, "claude", "2026-10-10")).not.toBe(referenceFingerprint(card, "claude", "2026-10-10"));
});

test("stored ledger prices each request before summing; correction, threshold edit, restart and full refill agree", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    let rates = structuredClone(f.rates);
    const add = f.db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,in_uncached,in_cache_read,in_cache_write,cache_write_5m,out_total)
      VALUES('fixture-primary',?,'haiku-session',?,'2026-10-10T12:00:00.000Z','claude-haiku-5-5',?,?,?, ?,1000)`);
    for (const [id, input, cached, write] of [["short", 20000, 70000, 0], ["edge", 1000, 98000, 1000], ["long", 1000, 99000, 1]] as const)
      add.run(id, `${ARCHIVE_LOGICAL_ROOT}/claude/account-a/${id}.jsonl`, input, cached, write, write);
    // Establish the pre-fix state: Haiku is present but unpriced.
    fillUsageLedger(f.db, "claude", rates, ARCHIVE_LOGICAL_ROOT);
    const rows = () => f.db.query(`SELECT row_id,model,std_usd,std_nano,std_femto,act_usd,act_nano,act_femto,std_reason,act_reason
      FROM usage_ledger_facts WHERE provider='claude' ORDER BY row_id`).all();
    const unrelated = rows().filter((r: any) => r.model !== "claude-haiku-5-5");
    rates = structuredClone(rates);
    rates.vendors.anthropic!.models!["claude-haiku-5-5"] = structuredClone(card.vendors.anthropic!.models!["claude-haiku-5-5"]!);
    rates.vendors.anthropic!.long_context_premium = true;
    fillUsageLedger(f.db, "claude", rates, ARCHIVE_LOGICAL_ROOT);
    expect(rows().filter((r: any) => r.model !== "claude-haiku-5-5")).toEqual(unrelated);
    const amounts = () => f.db.query(`SELECT e.call_id, f.act_usd+f.act_nano/1e9+f.act_femto/1e15 amount,f.act_reason reason
      FROM usage_ledger_facts f JOIN claude_events e ON e.id=f.row_id WHERE f.provider='claude' AND f.model='claude-haiku-5-5' ORDER BY e.call_id`).all();
    expect(amounts()).toEqual([{ call_id: "edge", amount: 0.001705, reason: null },
      { call_id: "long", amount: 0.007950625, reason: null }, { call_id: "short", amount: 0.0032, reason: null }]);
    // A threshold edit splits the two former base-band rows; checking one representative is insufficient.
    rates = structuredClone(rates);
    rates.vendors.anthropic!.models!["claude-haiku-5-5"]!.long_context!.above_input_tokens = 95000;
    fillUsageLedger(f.db, "claude", rates, ARCHIVE_LOGICAL_ROOT);
    expect((amounts()[0] as any).amount).toBeCloseTo(0.008525, 12);
    f.db.query("UPDATE claude_events SET in_cache_read=80000 WHERE call_id='long'").run();
    fillUsageLedger(f.db, "claude", rates, ARCHIVE_LOGICAL_ROOT);
    const corrected = amounts();
    f.reopen();
    // A fresh connection and card retain completed valuations without reprocessing.
    expect(stepUsageLedger(f.db, "claude", structuredClone(rates), ARCHIVE_LOGICAL_ROOT)).toEqual({ complete: true, processed: 0 });
    expect(amounts()).toEqual(corrected);
    for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_day_reasons", "usage_ledger_dirty", "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_state", "usage_ledger_source_days"])
      f.db.query(`DELETE FROM ${table} WHERE provider='claude'`).run();
    fillUsageLedger(f.db, "claude", rates, ARCHIVE_LOGICAL_ROOT);
    expect(amounts()).toEqual(corrected);
  } finally { f.teardown(); }
}, 60000);

const tier = (scale: number, rates: Record<string, number>) => Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v * scale]));
test("any provider and model may carry a tier; a model without one keeps its single rates", () => {
  const next = structuredClone(card);
  const flash = next.vendors.google!.models!["gemini-3.8-flash"]!;
  const flashBase = { in_uncached: flash.in_uncached!, in_cache_read: flash.in_cache_read!, out_total: flash.out_total! };
  flash.long_context = { above_input_tokens: 200000, rates: tier(2, flashBase) };
  const gemini = subscriptionAccountingAdapter("gemini");
  const call = (fresh: number, cached: number): SubscriptionEvent => ({ ...event(0), vendor: "google", model: "gemini-3.8-flash",
    quantities: { in_uncached: fresh, in_cache_read: cached, in_cache_write_5m: 0, in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: 10, out_thinking: 0 } });
  expect(priceSubscriptionEvent(next, gemini, call(150000, 50000)).rates.in_uncached).toBe(flashBase.in_uncached);
  expect(priceSubscriptionEvent(next, gemini, call(150000, 50001)).rates.in_uncached).toBe(flashBase.in_uncached * 2);
  // Untiered models price exactly as before, whatever the prompt size.
  for (const vendorCard of [card, next]) {
    const sonnet = { ...event(500000), model: "claude-sonnet-5-5" };
    expect(priceSubscriptionEvent(vendorCard, adapter, sonnet).rates.in_uncached).toBe(2);
    expect(ledgerRateChoice(vendorCard, adapter, sonnet, false).key).toBe(ledgerRateChoice(shipped as unknown as RateCard, adapter, sonnet, false).key);
  }
});

test("dated and fast variants use their own tier; a variant without one prices only base-band calls", () => {
  const next = structuredClone(card);
  const haiku = next.vendors.anthropic!.models!["claude-haiku-5-5"]!;
  haiku.fast = tier(3, base) as never;
  expect(priceSubscriptionEvent(next, adapter, { ...event(100000), speed: "fast" }).rates.in_uncached).toBeCloseTo(0.3, 12);
  expect(priceSubscriptionEvent(next, adapter, { ...event(100001), speed: "fast" }).amount).toBeNull();
  expect(getClaudeRate(next, "claude-haiku-5-5", "2026-10-10", "fast", 100001)).toBeNull();
  haiku.fast = { ...tier(3, base), long_context: { above_input_tokens: 100000, rates: tier(3, long) } } as never;
  expect(priceSubscriptionEvent(next, adapter, { ...event(100001), speed: "fast" }).rates.in_uncached).toBeCloseTo(1.5, 12);
  expect(getClaudeRate(next, "claude-haiku-5-5", "2026-10-10", "fast", 100001)!.in_uncached).toBeCloseTo(1.5, 12);
  // Standard valuation of a fast call stays on the base block and its tier.
  expect(ledgerRateChoice(next, adapter, { ...event(100001), speed: "fast" }, true).rates.in_uncached).toBe(500000000n);
  haiku.until = "2026-10-09";
  haiku.after = { ...tier(2, base), long_context: { above_input_tokens: 50000, rates: tier(4, base) } } as never;
  expect(priceSubscriptionEvent(next, adapter, event(50000)).rates.in_uncached).toBeCloseTo(0.2, 12);
  expect(priceSubscriptionEvent(next, adapter, event(50001)).rates.in_uncached).toBeCloseTo(0.4, 12);
  expect(referenceFingerprint(next, "claude", "2026-10-10")).not.toBe(referenceFingerprint(card, "claude", "2026-10-10"));
});

test("without the vendor's premium (the default) long and unsized requests use base rates, keyed apart", () => {
  expect(offCard.vendors.anthropic).not.toHaveProperty("long_context_premium");
  const longCall = event(100001);
  expect(priceSubscriptionEvent(offCard, adapter, longCall).rates).toMatchObject(base);
  expect(priceSubscriptionEvent(card, adapter, longCall).rates).toMatchObject(long);
  // An unsized request no longer needs the band to be priced.
  const unsized = { ...longCall, quantities: { ...longCall.quantities, in_uncached: Number.NaN } };
  expect(getClaudeRate(offCard, "claude-haiku-5-5", "2026-10-10", "standard")).toEqual(base);
  expect(getClaudeRate(offCard, "claude-haiku-5-5", "2026-10-10", "standard", 100001)).toEqual(base);
  expect(priceSubscriptionEvent(offCard, adapter, unsized).rates.in_uncached).toBe(0.1);
  // Base-band keys are shared; a long key without the premium is a distinct key, so the ledger revalues it.
  expect(ledgerRateChoice(offCard, adapter, event(1000), false).key).toBe(ledgerRateChoice(card, adapter, event(1000), false).key);
  expect(ledgerRateChoice(offCard, adapter, longCall, false).key).not.toBe(ledgerRateChoice(card, adapter, longCall, false).key);
  expect(subscriptionRulesDigest(offCard, "claude")).not.toBe(subscriptionRulesDigest(card, "claude"));
  expect(subscriptionRulesDigest(offCard, "grok")).toBe(subscriptionRulesDigest(card, "grok"));
});

test("Claude windows carry the context split: the uplift is measured with the premium off and on", () => {
  const ledgerEvent = (e: SubscriptionEvent, amount: number) => ({ ...e, prices: { standard: { amount, subtotal: amount, reason: null, costs: {} } } }) as never;
  const value = (rates: Record<string, number>, e: SubscriptionEvent) => Object.entries(rates)
    .reduce((sum, [k, v]) => sum + (e.quantities as Record<string, number>)[k]! * v / 1e6, 0);
  const longCall = event(100001), shortCall = event(1000);
  const baseValue = value(base, longCall), longValue = value(long, longCall);
  for (const [rateCard, stored] of [[offCard, baseValue], [card, longValue]] as const) {
    const usage = subscriptionWindowAdapter(adapter, "weekly", 10080, rateCard).usage(ledgerEvent(longCall, stored));
    expect(usage).toMatchObject({ context_known_tokens: usage.tokens, context_long_tokens: usage.tokens, context_long_events: 1,
      context_priced_tokens: usage.tokens });
    expect(usage.context_api_base).toBeCloseTo(baseValue, 12);
    expect(usage.context_api_extra).toBeCloseTo(longValue - baseValue, 12);
  }
  const short = subscriptionWindowAdapter(adapter, "weekly", 10080, offCard).usage(ledgerEvent(shortCall, value(base, shortCall)));
  expect(short).toMatchObject({ context_long_tokens: 0, context_api_extra: 0 });
  // A vendor without tiers carries no split, so no context option appears for it.
  const grok = subscriptionAccountingAdapter("grok");
  expect(subscriptionWindowAdapter(grok, "weekly", 10080, offCard).usage(ledgerEvent({ ...shortCall, vendor: "grok", model: "grok-5" }, 1))).not.toHaveProperty("context_known_tokens");
});
