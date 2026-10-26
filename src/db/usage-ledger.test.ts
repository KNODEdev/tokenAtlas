import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Database } from "./sqlite";
import { ensureUsageLedgerSchema, femtoPerToken, ledgerMoneyDecimal, splitFemto } from "./usage-ledger";
import { ledgerRateChoice, valueLedgerQuantities } from "../server/usage-ledger-rates";
import { priceSubscriptionEvent, subscriptionAccountingAdapter, TOKEN_BUCKETS,
  type SubscriptionEvent, type TokenQuantities } from "../server/subscription-accounting-adapters";
import type { RateCard } from "../server/pricing";

test("card rates become exact femto-dollars per token, and an inexact rate is refused, never rounded", () => {
  expect(femtoPerToken(3)).toBe(3_000_000_000n);
  expect(femtoPerToken(0.075)).toBe(75_000_000n);
  expect(femtoPerToken(12.5)).toBe(12_500_000_000n);
  expect(femtoPerToken("0.000000001")).toBe(1n);
  expect(femtoPerToken("0.0000000001")).toBeNull();
  expect(femtoPerToken(1e-10)).toBeNull();
  expect(femtoPerToken(2e3)).toBe(2_000_000_000_000n);
  expect(splitFemto(1_234_567_890_123n)).toEqual({ usd: 0n, nano: 1_234_567n, femto: 890_123n });
  expect(splitFemto(4_503_599_627_370_496n * 3_000_000_000n)).toEqual({ usd: 13_510_798_882n, nano: 111_488_000n, femto: 0n });
  expect(ledgerMoneyDecimal(0n, 1_234_567n, 890_123n)).toBe("0.001234567890123");
  expect(ledgerMoneyDecimal(3n, 0n, 0n)).toBe("3");
  // Summed lower limbs past their radix still print the exact total.
  expect(ledgerMoneyDecimal(0n, 1n, 2_500_000n)).toBe("0.0000000035");
  expect(ledgerMoneyDecimal(1n, 1_500_000_000n, 0n)).toBe("2.5");
});

test("ledger valuation equals the per-event pricing on the shipped card, exactly where floats only approximate", () => {
  const card = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../rate-cards.json"), "utf8")) as RateCard;
  const quantities: TokenQuantities[] = [
    { in_uncached: 0, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: 0, out_thinking: 0 },
    { in_uncached: 1234, in_cache_read: 98765, in_cache_write_5m: 0, in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: 321, out_thinking: 12 },
    { in_uncached: 7, in_cache_read: 3, in_cache_write_5m: 1111, in_cache_write_1h: 2222, in_cache_write_unknown: 0, out_total: 9, out_thinking: 0 },
    { in_uncached: 3, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, in_cache_write_unknown: 4567, out_total: 1, out_thinking: 0 },
    { in_uncached: 987_654_321, in_cache_read: 0, in_cache_write_5m: 0, in_cache_write_1h: 0, in_cache_write_unknown: 0, out_total: 123_456_789, out_thinking: 0 },
  ];
  let compared = 0;
  for (const provider of ["claude", "gemini", "grok", "glm"]) {
    const adapter = subscriptionAccountingAdapter(provider);
    const models = [...Object.keys(card.vendors[adapter.rateVendor]?.models ?? {}), "unknown-model", null];
    for (const model of models) for (const speed of ["standard", "fast", "unknown"]) for (const day of ["2025-01-01", "2026-09-30"])
      for (const q of quantities) for (const valid of [true, false]) for (const standard of [true, false]) {
        const event = { model, speed, ts: `${day}T12:00:00.000Z`, quantities: q, usage_valid: valid } as SubscriptionEvent;
        const float = priceSubscriptionEvent(card, adapter, event, standard);
        const choice = ledgerRateChoice(card, adapter, event, standard);
        const exact = valueLedgerQuantities(q, valid, choice);
        expect(exact.reason).toBe(float.reason);
        const value = Number(ledgerMoneyDecimal(0n, 0n, exact.subtotal));
        expect(Math.abs(value - float.subtotal)).toBeLessThanOrEqual(1e-9 * Math.max(1, float.subtotal));
        if (float.amount !== null) expect(Math.abs(value - float.amount)).toBeLessThanOrEqual(1e-9 * Math.max(1, float.amount));
        // The exact amount is the rational sum of quantity x rate / 10^6, with no rounding.
        if (exact.reason === null) {
          const rational = TOKEN_BUCKETS.reduce((sum, bucket) => {
            const rate = float.rates[bucket];
            return q[bucket] === 0 || rate == null ? sum : sum + BigInt(q[bucket]) * femtoPerToken(rate)!;
          }, 0n);
          expect(exact.subtotal).toBe(rational);
        }
        compared++;
      }
  }
  expect(compared).toBeGreaterThan(1000);
});

test("a call of unknown mode is valued at the Standard rate in actual mode, a lower bound, under its own rate key", () => {
  const card = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../rate-cards.json"), "utf8")) as RateCard;
  const adapter = subscriptionAccountingAdapter("claude");
  const quantities: TokenQuantities = { in_uncached: 1200, in_cache_read: 340_000, in_cache_write_5m: 5000, in_cache_write_1h: 700,
    in_cache_write_unknown: 0, out_total: 2500, out_thinking: 100 };
  const event = (speed: string, model = "claude-opus-5-5", day = "2026-10-05") =>
    ({ model, speed, ts: `${day}T12:00:00.000Z`, quantities, usage_valid: true }) as SubscriptionEvent;
  const unknown = priceSubscriptionEvent(card, adapter, event("unknown"));
  const standard = priceSubscriptionEvent(card, adapter, event("standard"));
  const fast = priceSubscriptionEvent(card, adapter, event("fast"));
  expect(unknown).toMatchObject({ reason: null, amount: standard.amount, rates: standard.rates });
  expect(unknown.note).toContain("lower bound");
  expect(fast.amount!).toBeGreaterThan(unknown.amount!);
  // The ledger's twin: Standard rates under a key of its own, so the rule's change revalues only these facts.
  const choice = ledgerRateChoice(card, adapter, event("unknown"), false);
  const standardChoice = ledgerRateChoice(card, adapter, event("standard"), false);
  expect(choice.rates).toEqual(standardChoice.rates);
  expect(JSON.parse(choice.key)[2]).toBe("unknown:unknown-mode-standard-lower-bound-v1");
  expect(choice.key).not.toBe(standardChoice.key);
  expect(valueLedgerQuantities(quantities, true, choice)).toEqual(valueLedgerQuantities(quantities, true, standardChoice));
  // A model without a configured rate stays unpriced for its rate, not for its mode.
  expect(priceSubscriptionEvent(card, adapter, event("unknown", "claude-not-configured")).reason).toBe("missing_rate");
  expect(valueLedgerQuantities(quantities, true, ledgerRateChoice(card, adapter, event("unknown", "claude-not-configured"), false)).reason)
    .toBe("missing_rate");
});

test("the migrated ledger schema matches the schema the code creates", () => {
  const schema = (db: Database) => (db.query("SELECT name,sql FROM sqlite_master WHERE name LIKE 'usage_ledger_%' ORDER BY name").all() as
    Array<{ name: string; sql: string }>).map(({ name, sql }) => ({ name, sql: sql.replace(/IF NOT EXISTS\s+/gi, "").replace(/\s+/g, " ").replace(/ ([,)])/g, "$1").trim() }));
  const migrated = new Database(":memory:"), created = new Database(":memory:");
  try {
    migrate(drizzle(migrated), { migrationsFolder: path.resolve(import.meta.dir, "../../drizzle") });
    ensureUsageLedgerSchema(created);
    ensureUsageLedgerSchema(created);
    expect(schema(migrated)).toEqual(schema(created));
    expect((created.query("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'usage_ledger_%' AND type='table'").get() as { n: number }).n).toBe(10);
  } finally { migrated.close(); created.close(); }
});
