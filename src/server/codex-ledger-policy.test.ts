import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { compileCodexLedgerPolicy, convertLegacyCodexLedgerPolicy, validateCodexLedgerPolicy,
  ledgerTierMultiplier, type CodexLedgerPolicy, type LedgerBaseRule, type LedgerTierRule } from "./codex-ledger-policy";
import type { CodexAccountingConfig, CodexAccountingRule } from "./codex-accounting-pricing";
import { add, multiply, nanoValuationSql, rational, readNanoParts, type NanoParts } from "../db/price-ledger-exact";
import { compileReferenceConfig, equal, priceCodexEventExact, type ReferenceConfig } from "../../scripts/lib/price-ledger-reference";
import shippedCard from "../../rate-cards.json";

const proof = { verified_at: "2026-01-01", sources: ["https://example.com/prices"], confidence: "official" as const };
function legacyRule(id: string, overrides: Partial<CodexAccountingRule> = {}): CodexAccountingRule {
  return { id, model: "m", billing_basis: "api_equivalent_usd", speed: "standard", valid_from: "2026-01-01",
    rates: { in_uncached: 3, in_cache_read: 0.3, in_cache_write: 0, out_total: 6 }, multiplier: 1, ...proof, ...overrides };
}
const legacyConfig = (...rules: CodexAccountingRule[]): CodexAccountingConfig => ({ version: 1, rules, long_context_premium: true });
function policy(): CodexLedgerPolicy {
  return convertLegacyCodexLedgerPolicy(legacyConfig(legacyRule("base"), legacyRule("fast", {
    speed: "fast", rates: { in_uncached: 6, in_cache_read: 0.6, in_cache_write: 0, out_total: 12 } })));
}

test("legacy adapter preserves decimals, standard multiplier and independent normal/long valuations", () => {
  const credits = legacyRule("credits", { billing_basis: "chatgpt_credits", multiplier: 1.25,
    rates: { in_uncached: 1.875, in_cache_read: 0.125, out_total: 1.7999999999999998 },
    long_context: { above_input_tokens: 100, rates: { in_uncached: 3.75, in_cache_read: 0.25, out_total: 3.5999999999999996 } } });
  const creditsFast = { ...credits, id: "credits-fast", speed: "fast" as const, multiplier: 2.5 };
  const api = legacyRule("api", { long_context: { above_input_tokens: 100,
    rates: { in_uncached: 6, in_cache_read: 0.6, in_cache_write: 0, out_total: 12 } } });
  const apiFast = legacyRule("api-fast", { speed: "fast", rates: { in_uncached: 6, in_cache_read: 0.6, in_cache_write: 0, out_total: 12 },
    long_context: { above_input_tokens: 100, rates: { in_uncached: 12, in_cache_read: 1.2, in_cache_write: 0, out_total: 24 } } });
  const config = legacyConfig(credits, creditsFast, api, apiFast), converted = convertLegacyCodexLedgerPolicy(config);
  const compiled = compileCodexLedgerPolicy(converted);
  expect(converted.base_rules.find(rule => rule.id === "credits")!.rates.out_total).toBe("1.7999999999999998");
  expect(converted.base_rules.find(rule => rule.id === "credits")!.multiplier).toBe("1.25");
  expect(compiled.baseBands).toHaveLength(4);
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE tokens(in_uncached INTEGER,in_cache_read INTEGER,in_cache_write INTEGER,out_total INTEGER) STRICT");
  try {
    for (const input of [100, 101, 447105]) for (const speed of ["standard", "fast"] as const)
      for (const basis of ["api_equivalent_usd", "chatgpt_credits"] as const) {
        const event = { model: "m", ts: "2026-01-02T12:00:00Z", speed, in_tok: input, cached_in: 10, cache_write: 0, out_tok: 7 };
        const expected = priceCodexEventExact(config as ReferenceConfig, event, basis);
        const band = compiled.baseBands.find(candidate => candidate.basis === basis
          && candidate.band === (input > 100 ? "long" : "normal"))!;
        db.exec("DELETE FROM tokens");
        db.query("INSERT INTO tokens VALUES(?,?,0,?)").run(input - 10, 10, 7);
        const base = readNanoParts(db.query(nanoValuationSql("tokens", band.coefficients)).get() as NanoParts, band.coefficients.denominator);
        const result = multiply(base, compiled.multiplier("m", basis, speed, "2026-01-02")!);
        expect(equal(result, expected.amount!)).toBe(true);
      }
  } finally { db.close(); }
  expect(JSON.parse(JSON.stringify(converted))).toEqual(converted);
});

test("legacy intersections split at both boundaries and retain exact nonterminating ratios", () => {
  const base1 = legacyRule("b1", { valid_until: "2026-03-01", rates: { in_uncached: 3, in_cache_read: 3, out_total: 3 } });
  const base2 = legacyRule("b2", { valid_from: "2026-03-01", rates: { in_uncached: 6, in_cache_read: 6, out_total: 6 } });
  const fast1 = legacyRule("f1", { speed: "fast", valid_from: "2026-02-01", valid_until: "2026-04-01",
    rates: { in_uncached: 1, in_cache_read: 1, out_total: 1 } });
  const fast2 = { ...fast1, id: "f2", valid_from: "2026-04-01", valid_until: undefined };
  const converted = convertLegacyCodexLedgerPolicy(legacyConfig(base1, base2, fast1, fast2));
  const fast = converted.tier_rules.filter(rule => rule.tier === "fast");
  expect(fast.map(rule => [rule.valid_from, rule.valid_until])).toEqual([
    ["2026-02-01", "2026-03-01"], ["2026-03-01", "2026-04-01"], ["2026-04-01", undefined] ]);
  expect(fast[0]!.multiplier).toEqual({ numerator: "1", denominator: "3" });
  expect(fast[1]!.multiplier).toEqual({ numerator: "1", denominator: "6" });
  const compiled = compileCodexLedgerPolicy(converted);
  expect(compiled.multiplier("m", "api_equivalent_usd", "fast", "2026-01-31")).toBeNull();
  expect(compiled.multiplier("m", "api_equivalent_usd", "fast", "2026-03-01")).toEqual(rational(1n, 6n));
});

test("legacy conversion refuses proportionality, zero-base, cache and context mismatches", () => {
  const base = legacyRule("b"), fast = legacyRule("f", { speed: "fast" });
  for (const modified of [
    { ...fast, rates: { ...fast.rates, out_total: 12 } },
    { ...fast, rates: { ...fast.rates, in_cache_write: undefined } },
    { ...fast, long_context: { above_input_tokens: 100, rates: fast.rates } },
  ]) expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(base, modified))).toThrow();
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig({ ...base, rates: { ...base.rates, in_uncached: 0 } }, fast)))
    .toThrow("zero base");
  const longBase = { ...base, long_context: { above_input_tokens: 100, rates: base.rates } };
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(longBase, { ...fast,
    long_context: { above_input_tokens: 101, rates: fast.rates } }))).toThrow("classification");
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(longBase, { ...fast,
    long_context: { above_input_tokens: 100, rates: { ...fast.rates, out_total: 12 } } }))).toThrow("non-proportional");
});

test("zero rates stay priced while all-zero proportionality is explicit one", () => {
  const rates = { in_uncached: 0, in_cache_read: 0, out_total: 0 };
  const compiled = compileCodexLedgerPolicy(convertLegacyCodexLedgerPolicy(legacyConfig(
    legacyRule("b", { rates }), legacyRule("f", { speed: "fast", rates }))));
  expect(compiled.baseBands[0]!.coefficients.buckets.in_uncached).toEqual({ whole: 0n, remainder: 0n });
  expect(compiled.baseBands[0]!.coefficients.buckets.in_cache_write).toBeNull();
  expect(compiled.multiplier("m", "api_equivalent_usd", "fast", "2026-01-01")).toEqual(rational(1n));
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(
    legacyRule("b"), legacyRule("f", { speed: "fast", rates: { ...rates, in_cache_write: 0 } }))))
    .toThrow("zero tier factor");
});

test("Fast-only or interrupted Standard coverage fails without losing periods", () => {
  const fast = legacyRule("f", { speed: "fast" });
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(fast))).toThrow("Standard coverage");
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(legacyRule("b", { valid_from: "2026-02-01" }), fast))).toThrow("Standard base");
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(legacyRule("b", { valid_until: "2026-02-01" }), fast))).toThrow("Standard coverage");
  expect(() => convertLegacyCodexLedgerPolicy(legacyConfig(legacyRule("b", { valid_until: "2026-02-01" }),
    legacyRule("b2", { valid_from: "2026-03-01" }), fast))).toThrow("Standard base");
});

test("raw mapping is dated, open to ultrafast, and never infers a NULL tier", () => {
  const input = policy(); input.tiers.push("ultrafast");
  input.mappings.push({ id: "raw:ultra", raw_value: "turbo", tier: "ultrafast", valid_from: "2026-02-01", valid_until: "2026-03-01" });
  input.tier_rules.push({ ...input.tier_rules[1]!, id: "ultra", tier: "ultrafast", multiplier: "3.000000000000000000000000001" });
  const compiled = compileCodexLedgerPolicy(input);
  expect(compiled.classify(null, "2026-02-01")).toBeNull();
  expect(compiled.classify("standard", "2026-02-01")).toBeNull();
  expect(compiled.classify("default", "2026-02-01")).toBe("standard");
  expect(compiled.classify("priority", "2026-02-01")).toBe("fast");
  expect(compiled.classify("turbo", "2026-01-31")).toBeNull();
  expect(compiled.classify("turbo", "2026-02-01")).toBe("ultrafast");
  expect(compiled.classify("turbo", "2026-03-01")).toBeNull();
  expect(compiled.multiplier("m", "api_equivalent_usd", "ultrafast", "2026-02-01")!.d).toBe(10n ** 27n);
  expect(compiled.multiplier("missing", "api_equivalent_usd", "fast", "2026-02-01")).toBeNull();
  expect(compiled.multiplier("m", "chatgpt_credits", "fast", "2026-02-01")).toBeNull();
  expect(compiled.multiplier("m", "api_equivalent_usd", "unknown", "2026-02-01")).toBeNull();
  expect(compiled.resolveBaseRule(null, "api_equivalent_usd", "2026-02-01")).toBeNull();
  expect(compiled.resolveBaseRule("m", "api_equivalent_usd", "2026-02-30")).toBeNull();
  expect(compiled.classify("default", "invalid")).toBeNull();
});

test("tier-only high precision edits preserve stored base coefficients and compilation snapshots", () => {
  const input = policy(), before = compileCodexLedgerPolicy(input);
  input.tier_rules[1]!.multiplier = "1.000000000000000000000000000000001";
  const after = compileCodexLedgerPolicy(input);
  expect(after.baseBands).toEqual(before.baseBands);
  expect(before.multiplier("m", "api_equivalent_usd", "fast", "2026-01-01")).toEqual(rational(2n));
  expect(after.multiplier("m", "api_equivalent_usd", "fast", "2026-01-01")!.d).toBe(10n ** 33n);
  expect(equal(add(multiply(rational(3n), rational(1n, 3n)), rational(1n)), rational(2n))).toBe(true);
});

test("date validation checks adjacent endpoints and genuinely unbounded year 9999", () => {
  const input = policy(), base = input.base_rules[0]!;
  base.valid_until = "2026-02-01";
  input.base_rules.push({ ...base, id: "base2", valid_from: "2026-02-01", valid_until: undefined });
  const compiled = compileCodexLedgerPolicy(input);
  expect(compiled.resolveBaseRule("m", "api_equivalent_usd", "2026-01-31")!.id).toBe("base");
  expect(compiled.resolveBaseRule("m", "api_equivalent_usd", "2026-02-01")!.id).toBe("base2");
  expect(compiled.resolveBaseRule("m", "api_equivalent_usd", "9999-12-31")!.id).toBe("base2");
  input.base_rules.push({ ...base, id: "future", valid_from: "9999-12-31", valid_until: undefined });
  expect(() => validateCodexLedgerPolicy(input)).toThrow("overlapping");
  const maps = policy();
  maps.mappings[0]!.valid_until = "2026-02-01";
  maps.mappings.push({ id: "mapping2", raw_value: "default", tier: "fast", valid_from: "2026-02-01" });
  const remapped = compileCodexLedgerPolicy(maps);
  expect(remapped.classify("default", "0000-01-01")).toBe("standard");
  expect(remapped.classify("default", "2026-02-01")).toBe("fast");
  maps.mappings[2]!.valid_from = "2026-01-31";
  expect(() => validateCodexLedgerPolicy(maps)).toThrow("overlapping");
});

test("policy rejects invalid dates, overlaps, provenance, decimals and rational denominators", () => {
  const badBase: Partial<LedgerBaseRule>[] = [
    { valid_from: "2026-02-30" }, { valid_until: "2026-01-01" }, { multiplier: "0" }, { multiplier: "2" },
    { rates: { in_uncached: "-1", in_cache_read: "0", out_total: "0" } },
    { rates: { in_uncached: "1e-100", in_cache_read: "0", out_total: "0" } },
    { sources: [] }, { long_context: { above_input_tokens: 0, rates: { in_uncached: "1", in_cache_read: "0", out_total: "0" } } },
  ];
  for (const change of badBase) { const p = policy(); Object.assign(p.base_rules[0]!, change); expect(() => validateCodexLedgerPolicy(p)).toThrow(); }
  const invalidTiers: Partial<LedgerTierRule>[] = [{ multiplier: "-1" }, { multiplier: "0" }, { multiplier: "2" },
    { multiplier: { numerator: "0", denominator: "3" } }, { multiplier: { numerator: "1", denominator: "0" } },
    { multiplier: { numerator: "1", denominator: "-3" } }, { tier: "missing" }, { multiplier: 1 as unknown as string }];
  for (const change of invalidTiers) { const p = policy(); Object.assign(p.tier_rules[0]!, change); expect(() => validateCodexLedgerPolicy(p)).toThrow(); }
  const duplicate = policy(); duplicate.tier_rules.push({ ...duplicate.tier_rules[0]!, id: "another" });
  expect(() => validateCodexLedgerPolicy(duplicate)).toThrow("overlapping");
  const numbers = policy(); numbers.base_rules[0]!.rates.out_total = 1 as unknown as string;
  expect(() => validateCodexLedgerPolicy(numbers)).toThrow("decimal text");
  expect(ledgerTierMultiplier({ numerator: "6", denominator: "9" })).toEqual(rational(2n, 3n));
  expect(() => ledgerTierMultiplier({ numerator: "1".repeat(2049), denominator: "1" })).toThrow();
});

test("premium-off keeps ordinary rates and missing Fast coverage remains missing", () => {
  const rule = legacyRule("b", { long_context: { above_input_tokens: 10, rates: { in_uncached: 6, in_cache_read: 0.6, in_cache_write: 0, out_total: 12 } } });
  const converted = convertLegacyCodexLedgerPolicy({ version: 1, long_context_premium: false, rules: [rule] });
  const compiled = compileCodexLedgerPolicy(converted);
  expect(compiled.baseBands).toHaveLength(1); expect(compiled.baseBands[0]!.threshold).toBeUndefined();
  expect(compiled.multiplier("m", "api_equivalent_usd", "fast", "2026-01-01")).toBeNull();
  expect(compiled.multiplier("m", "api_equivalent_usd", "standard", "2026-01-01")).toEqual(rational(1n));
  expect(converted.base_rules[0]!.long_context).toBeDefined();
  expect(convertLegacyCodexLedgerPolicy({ version: 1, rules: [] }).base_rules).toEqual([]);
});

test("unchanged shipped policy converts every legacy band with exact oracle agreement", () => {
  const config = shippedCard.codex_accounting as CodexAccountingConfig;
  const compiled = compileCodexLedgerPolicy(convertLegacyCodexLedgerPolicy(config));
  const reference = compileReferenceConfig(config as ReferenceConfig, true);
  expect(compiled.policy.base_rules).toHaveLength(config.rules.filter(rule => rule.speed === "standard").length);
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE tokens(in_uncached INTEGER,in_cache_read INTEGER,in_cache_write INTEGER,out_total INTEGER) STRICT");
  try {
    for (const rule of config.rules) {
      for (const input of [1, rule.long_context?.above_input_tokens ?? 100,
        rule.long_context ? rule.long_context.above_input_tokens + 1 : 100001]) {
        const event = { model: rule.model, speed: rule.speed, ts: `${rule.valid_from}T12:00:00Z`,
          in_tok: input, cached_in: Math.min(input, 10), cache_write: 0, out_tok: 31 };
        const expected = priceCodexEventExact(reference, event, rule.billing_basis);
        const bands = compiled.baseBands.filter(band => band.model === rule.model && band.basis === rule.billing_basis
          && rule.valid_from >= band.validFrom && (!band.validUntil || rule.valid_from < band.validUntil));
        const band = bands.find(candidate => candidate.band === (candidate.threshold !== undefined && input > candidate.threshold ? "long" : "normal"))!;
        db.exec("DELETE FROM tokens");
        db.query("INSERT INTO tokens VALUES (?,?,0,?)").run(input - event.cached_in, event.cached_in, event.out_tok);
        const base = readNanoParts(db.query(nanoValuationSql("tokens", band.coefficients)).get() as NanoParts, band.coefficients.denominator);
        const actual = multiply(base, compiled.multiplier(rule.model, rule.billing_basis, rule.speed, rule.valid_from)!);
        expect(equal(actual, expected.amount!)).toBe(true);
      }
    }
  } finally { db.close(); }
});
