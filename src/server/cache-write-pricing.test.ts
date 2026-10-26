import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import shipped from "../../rate-cards.json";
import { calculateCodexUsd, calculateClaudeUsd, codexPriceGroupSql, getCodexGroupRate, getCodexRate, type RateCard } from "./pricing";
import { editCodexStandardRates, priceCodexEvent, resolveCodexAccountingConfig, validateCodexAccountingConfig } from "./codex-accounting-pricing";
import { readCycleEventGroups } from "./cycle-event-groups.fixture";

// These cases price the long-context premium, which the shipped card leaves off (owner decision 2026-10-20).
const card = { ...shipped, codex_accounting: { ...shipped.codex_accounting, long_context_premium: true } } as RateCard;
const config = resolveCodexAccountingConfig(card);
const event = { model: "gpt-6-astra", speed: "standard", ts: "2026-09-13T00:00:00Z",
  in_tok: 100000, cached_in: 80000, cache_write: 15000, out_tok: 10000, cache_write_status: "reported", usage_status: "valid" };

test("internal review remains unpriced even with stale private proxy rates", () => {
  const legacy = structuredClone(card);
  delete legacy.codex_accounting;
  legacy.vendors.openai!.models!["codex-auto-review"] = { in_uncached: 5, in_cache_read: .5, in_cache_write: 0, out_total: 30 };
  expect(getCodexRate(legacy, "codex-auto-review")).toBeNull();
  const stale = structuredClone(config);
  stale.rules = stale.rules.map(rule => ({ ...rule, model: "codex-auto-review" }));
  for (const basis of ["api_equivalent_usd", "chatgpt_credits"] as const) {
    expect(priceCodexEvent(stale, { ...event, model: "codex-auto-review" }, basis).amount).toBeNull();
  }
});

test("writes replace ordinary input: four categories, Fast, long context and legacy calculator agree", () => {
  expect(priceCodexEvent(config, event, "api_equivalent_usd").amount).toBe(.8175);
  expect(calculateCodexUsd(getCodexRate(card, event.model, event.ts), 100000, 80000, 15000, 10000)).toBe(.8175);
  expect(priceCodexEvent(config, { ...event, speed: "fast" }, "api_equivalent_usd").amount).toBe(1.635);
  const long = { ...event, in_tok: 272001 };
  expect(priceCodexEvent(config, long, "api_equivalent_usd").amount).toBe(4.82502);
  expect(calculateCodexUsd(getCodexRate(card, event.model, event.ts, long.in_tok), long.in_tok, 80000, 15000, 10000)).toBe(4.82502);
  expect(priceCodexEvent(config, event, "chatgpt_credits").reason).toBe("cache_write_semantics_unknown");
});

test("reported zero, absent counter, unavailable price and invalid overlap have different outcomes", () => {
  const zero = { ...event, cache_write: 0 };
  expect(priceCodexEvent(config, zero, "api_equivalent_usd").amount).toBe(.78);
  // An absent counter reads as zero writes, so it prices identically to a reported zero.
  const absent = { ...zero, cache_write_status: "missing" };
  expect(priceCodexEvent(config, absent, "api_equivalent_usd").amount).toBe(.78);
  expect(priceCodexEvent(config, absent, "chatgpt_credits").amount).toBe(19.5);
  // A counter that is present and positive is evidence, and still has no credit price.
  expect(priceCodexEvent(config, event, "chatgpt_credits").reason).toBe("cache_write_semantics_unknown");
  expect(priceCodexEvent(config, { ...event, cache_write: 20001 }, "api_equivalent_usd").reason).toBe("invalid_tokens");
  expect(priceCodexEvent(config, { ...zero, usage_status: "unknown" }, "api_equivalent_usd").reason).toBe("incomplete_usage");
  const privateConfig = structuredClone(config);
  for (const rule of privateConfig.rules) delete rule.rates.in_cache_write;
  expect(priceCodexEvent(privateConfig, event, "api_equivalent_usd").reason).toBe("missing_cache_write_rate");
  expect(priceCodexEvent(privateConfig, zero, "api_equivalent_usd").amount).toBe(.78);
});

test("pre-5.6 writes have no additional API charge and API rates cannot become credit rates", () => {
  const old = { ...event, model: "gpt-5.5" };
  const withWrites = priceCodexEvent(config, old, "api_equivalent_usd").amount;
  expect(withWrites).toBe(priceCodexEvent(config, { ...old, cache_write: 0 }, "api_equivalent_usd").amount);
  expect(withWrites).not.toBeNull();
  const invalid = structuredClone(config);
  invalid.rules.find(r => r.billing_basis === "chatgpt_credits")!.rates.in_cache_write = 12.5;
  expect(() => validateCodexAccountingConfig(invalid)).toThrow("API prices cannot be used as credit prices");
});

test("Sol write prices follow historical tariff boundaries and disabling periods does not revive legacy prices", () => {
  expect(getCodexRate(card, "gpt-5.6-sol", "2026-08-20")?.in_cache_write).toBe(6.25);
  expect(getCodexRate(card, "gpt-5.6-sol", "2026-08-21")?.in_cache_write).toBe(5);
  const disabled: RateCard = { ...card, codex_accounting: { version: 1, rules: [] } };
  expect(getCodexRate(disabled, "gpt-6-astra", "2026-09-13")).toBeNull();
  const edited = structuredClone(card);
  const creditsBefore = JSON.stringify(edited.codex_accounting!.rules.filter(r => r.billing_basis === "chatgpt_credits"));
  editCodexStandardRates(edited, "gpt-6-astra", { in_cache_write: 15 }, "2026-09-15");
  expect(getCodexRate(edited, "gpt-6-astra", "2026-09-14")?.in_cache_write).toBe(12.5);
  expect(getCodexRate(edited, "gpt-6-astra", "2026-09-15")?.in_cache_write).toBe(15);
  expect(getCodexRate(edited, "gpt-6-astra", "2026-09-15", 272001)?.in_cache_write).toBe(30);
  expect(JSON.stringify(edited.codex_accounting!.rules.filter(r => r.billing_basis === "chatgpt_credits"))).toBe(creditsBefore);
});

test("SQL aggregation preserves per-request context and prices an absent counter as zero writes", () => {
  expect(getCodexGroupRate(card, event.model, { price_day: "2026-09-13", in_tok: 400000, cached_in: 0, cache_write: 0, out_tok: 1 })).toBeNull();
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE events(model TEXT,ts TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,cache_write_status TEXT,usage_status TEXT)");
    const insert = db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)");
    for (const input of [200000, 200000, 272001]) insert.run(event.model,event.ts,input,80000,15000,10000,"reported","valid");
    insert.run(event.model,event.ts,100000,80000,0,10000,"missing","valid");
    const dims = codexPriceGroupSql(db);
    const rows = db.query(`SELECT model,${dims.select},SUM(in_tok) AS in_tok,SUM(cached_in) AS cached_in,SUM(cache_write) AS cache_write,SUM(out_tok) AS out_tok FROM events GROUP BY model,${dims.group}`).all() as any[];
    const costs = rows.map(r => calculateCodexUsd(getCodexGroupRate(card, r.model, r),r.in_tok,r.cached_in,r.cache_write,r.out_tok));
    // The absent-counter group prices as zero writes, matching the single-event path.
    expect(costs.filter(v => v === null)).toHaveLength(0);
    expect(costs.reduce<number>((a,v) => a + (v ?? 0),0)).toBeCloseTo(2 * 1.8175 + 4.82502 + .78, 10);
  } finally { db.close(); }
});

test("Claude uses separate input and TTL buckets; unknown TTL and conflicting source totals stay unpriced", () => {
  const rate = { in_uncached: 3, in_cache_read: .3, in_cache_write_5m: 3.75, in_cache_write_1h: 6, out_total: 15 };
  expect(calculateClaudeUsd(rate, 1000, 8000, 4000, 6000, 10000, 1000)).toBe(.0714);
  expect(calculateClaudeUsd(rate, 2, 219388, 0, 4868, 0, 184)).toBeNull();
  expect(calculateClaudeUsd(rate, 1000, 8000, 0, 0, 10000, 1000)).toBeNull();
});

test("a legacy session crossing a tariff date keeps both prices", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE events(model,ts,in_tok,cached_in,cache_write,out_tok)");
    db.exec("INSERT INTO events VALUES('legacy','2026-08-20T23:59:00Z',1000000,0,0,0),('legacy','2026-08-21T00:01:00Z',1000000,0,0,0)");
    const legacy: RateCard = { version: 1, currency: "USD", unit: "per 1M tokens", vendors: { openai: { models: { legacy: { in_uncached: 5, in_cache_read: .5, out_total: 30,
      until: '2026-08-20', after: { in_uncached: 4, in_cache_read: .4, out_total: 20 } } } } } };
    const rows = readCycleEventGroups(db, ["1=1"], [], Date.parse("2026-08-20T23:00:00Z") / 1000, 18000, true).filter(r => r.kind === "session");
    expect(rows).toHaveLength(2);
    expect(rows.reduce((total, r) => total + (calculateCodexUsd(getCodexRate(legacy, r.model, r.price_day), r.in_tok!, 0, 0, 0) ?? 0), 0)).toBe(9);
  } finally { db.close(); }
});
