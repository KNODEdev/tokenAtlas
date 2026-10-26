import { describe, expect, test } from "bun:test";
import { priceCodexEvent as legacyPrice } from "../src/server/codex-accounting-pricing";
import { add, subtract, multiply, divide, decimal, decimalText, rational, serializeRational, serializeCounter,
  compileReferenceConfig, priceCodexEventExact, referenceCodexEvent, mergeCounters, auditBandProportionality,
  VARIANTS, type Event, type ReferenceConfig, type Rates, type Rule, type Reason } from "./lib/price-ledger-reference";

const rates = (factor = 1): Rates => ({ in_uncached: factor, in_cache_read: factor / 2, out_total: factor * 2 });
function config(): ReferenceConfig {
  const rules: Rule[] = (["cs", "cf", "as", "af"] as const).map((id, index) => ({
    id, model: "synthetic", billing_basis: index < 2 ? "chatgpt_credits" : "api_equivalent_usd",
    speed: index % 2 ? "fast" : "standard", valid_from: index < 2 ? "2026-04-02" : "2026-01-01",
    multiplier: id === "cf" ? 2 : 1, rates: rates(index < 2 ? 1 : id === "as" ? 2 : 4),
    long_context: { above_input_tokens: 10, rates: rates(index < 2 ? 2 : id === "as" ? 4 : 8) },
  }));
  return { version: 1, long_context_premium: true, rules };
}
const event = (patch: Partial<Event> = {}): Event => ({
  model: "synthetic", speed: "standard", ts: "2026-04-02T12:00:00Z",
  in_tok: 10, cached_in: 2, cache_write: 0, out_tok: 3, ...patch,
});
const ref = (patch: Partial<Event> = {}, c = config()) => referenceCodexEvent(compileReferenceConfig(c), event(patch))!;
const text = (value: ReturnType<typeof decimal> | null) => value === null ? null : decimalText(value);
const reason = (counter: ReturnType<typeof ref>["counts"][typeof VARIANTS[number]]) => Object.keys(counter.reasons)[0];

describe("exact independent P0 arithmetic", () => {
  test("decimal evidence, signed arithmetic and explicit fractions", () => {
    expect(text(decimal(1.7999999999999998))).toBe("1.7999999999999998");
    expect(text(multiply(decimal("1.0000001"), decimal("0.000001")))).toBe("0.0000010000001");
    expect(text(add(decimal("1e-7"), decimal(".2")))).toBe("0.2000001");
    expect(text(subtract(decimal("1"), decimal("2")))).toBe("-1");
    expect(serializeRational(divide(decimal("1"), decimal("3")))).toEqual({
      numerator: "1", denominator: "3", decimal: null,
    });
    expect(serializeRational(rational(-2n, -4n))).toEqual({ numerator: "1", denominator: "2", decimal: "0.5" });
    for (const invalid of ["", " ", "0x10", "NaN", "Infinity", "1e", "1e1001", "1e-1001", "1".repeat(2049), Number.NaN, Infinity]) {
      expect(() => decimal(invalid)).toThrow();
    }
    expect(() => divide(decimal(1), decimal(0))).toThrow();
  });
  test("audit detects decimal artifacts without tolerance or corrections", () => {
    expect(auditBandProportionality(rates(), rates(), 1, "1.0000001").proportional).toBe(true);
    const audit = auditBandProportionality({ in_uncached: 1, in_cache_read: 1, out_total: 1 },
      { in_uncached: "1.8", in_cache_read: "1.8", out_total: 1.7999999999999998 });
    expect(audit.proportional).toBe(false);
    expect(text(audit.components.out_total!)).toBe("1.7999999999999998");
    expect(audit.issues).toEqual(["out_total: unequal exact ratio"]);
  });
});

describe("event pricing and contribution semantics", () => {
  test("all four bases independently match synthetic legacy pricing", () => {
    const c = config(), compiled = compileReferenceConfig(c);
    const legacyConfig = { ...c, rules: c.rules.map(rule => ({ ...rule, verified_at: "2026-09-30",
      sources: ["https://example.org/synthetic"], confidence: "user" as const })) } as Parameters<typeof legacyPrice>[0];
    for (const [basis, speed, expected] of [
      ["chatgpt_credits", "standard", "0.000015"], ["chatgpt_credits", "fast", "0.00003"],
      ["api_equivalent_usd", "standard", "0.00003"], ["api_equivalent_usd", "fast", "0.00006"],
    ] as const) {
      const input = event({ speed }), exact = priceCodexEventExact(compiled, input, basis);
      expect(text(exact.amount)).toBe(expected);
      expect(legacyPrice(legacyConfig, input, basis).amount!).toBeCloseTo(Number(expected), 14);
    }
    const row = ref({ speed: "fast" });
    expect(Object.keys(row.counts)).toHaveLength(11);
    expect(text(row.counts.normalized_usd.value)).toBe("0.00006");
    expect(text(row.counts.extra_credits.value)).toBe("0.000015");
    for (const variant of VARIANTS) expect(row.counts[variant].pricedTokens).toBe(13n);
  });
  test("strict threshold, disabled premium, exclusive dates and resolved default", () => {
    expect(ref().prices[0].long_context).toBe(false);
    expect(text(ref({ in_tok: 11 }).prices[0].amount)).toBe("0.000032");
    expect(ref({ in_tok: 11 }).prices[0].long_context).toBe(true);
    const disabled = { ...config(), long_context_premium: false };
    expect(text(ref({ in_tok: 11 }, disabled).prices[0].amount)).toBe("0.000016");
    const unresolved = config(); delete unresolved.long_context_premium;
    expect(() => compileReferenceConfig(unresolved)).toThrow("Resolve");
    expect(compileReferenceConfig(unresolved, true).premium).toBe(true);
    const bounded = config(); bounded.rules[0]!.valid_until = "2026-04-03";
    expect(priceCodexEventExact(bounded, event({ ts: "2026-04-03T00:00:00Z" }), "chatgpt_credits").reason).toBe("missing_rate");
  });
  test("an omitted service tier is Standard for every actual valuation and quality measure", () => {
    const row = ref({ speed: null, service_tier: null });
    expect(row.speed).toBe("standard");
    expect(row.quality.unknown_speed_tokens).toBe(0n);
    expect(row.counts.api_actual).toEqual(row.counts.api_standard);
    expect(text(row.counts.normalized_usd.value)).toBe(text(row.counts.api_standard.value));
    expect(row.counts.window_credits_low).toEqual(row.counts.window_credits_high);
    expect(text(row.counts.extra_credits.value)).toBe("0");
  });
  test("an unmapped recorded tier keeps actual speed unknown while hypothetical prices survive", () => {
    for (const speed of [null, "turbo"]) {
      const row = ref({ speed, service_tier: "future-unmapped" });
      expect(row.speed).toBe("unknown"); expect(row.quality.unknown_speed_tokens).toBe(13n);
      expect(reason(row.counts.api_actual)).toBe("unknown_speed");
      expect(reason(row.counts.normalized_usd)).toBe("unknown_speed");
      expect(row.counts.credits_standard.pricedEvents).toBe(1n);
      expect(text(row.counts.window_credits_low.value)).toBe("0.000015");
      expect(text(row.counts.window_credits_high.value)).toBe("0.00003");
      expect(text(row.counts.window_normalized.value)).toBe("0.00003");
    }
    expect(priceCodexEventExact(config(), event({ speed: null }), "chatgpt_credits").reason).toBe("unknown_speed");
  });
  test("blocker precedence and reported counters remain independent", () => {
    const checks: [Partial<Event>, Reason][] = [
      [{ model: "codex-auto-review", in_tok: -1 }, "missing_rate"],
      [{ cached_in: 11, usage_status: "incomplete" }, "invalid_tokens"],
      [{ cache_write_status: "invalid", usage_status: "unknown" }, "invalid_tokens"],
      [{ usage_status: "incomplete", ts: "bad", speed: null }, "incomplete_usage"],
      [{ ts: "2026-04-02Tbad", speed: null }, "invalid_timestamp"],
      [{ model: null }, "missing_rate"],
      [{ cache_write: 1, model: null }, "cache_write_semantics_unknown"],
    ];
    for (const [patch, expected] of checks) {
      expect(priceCodexEventExact(config(), event(patch), "chatgpt_credits").reason).toBe(expected);
    }
    expect(referenceCodexEvent(config(), event({ ts: "2026-02-30T00:00:00Z" }))).toBeNull();
    const malformed = ref({ ts: "2026-04-02Tbad" });
    expect(reason(malformed.counts.api_standard)).toBe("invalid_timestamp");
    const invalid = ref({ cached_in: 11, speed: null });
    expect(invalid.reported).toBe(13n); expect(invalid.tokens.in_uncached).toBe(0n);
    expect(reason(invalid.counts.api_standard)).toBe("invalid_tokens");
    expect(reason(invalid.counts.api_actual)).toBe("invalid_tokens");
    expect(ref({ in_tok: Number.MAX_SAFE_INTEGER, out_tok: 1 }).reported).toBe(0n);
    expect(ref({ cached_in: 0.5 }).quality.invalid_token_events).toBe(0n);
    expect(ref({ cached_in: 0.5 }).tokens.in_cache_read).toBe(0n);
    expect(priceCodexEventExact(config(), event(), "chatgpt_credits", "bad").reason).toBe("invalid_timestamp");
  });
  test("cache-write uncertainty, API missing rate and joint window blockers", () => {
    const row = ref({ cache_write: 1 });
    expect(reason(row.counts.credits_standard)).toBe("cache_write_semantics_unknown");
    expect(reason(row.counts.api_standard)).toBe("missing_cache_write_rate");
    expect(reason(row.counts.api_standard_credited)).toBe("cache_write_semantics_unknown");
    for (const name of VARIANTS.filter(name => name.startsWith("window_"))) {
      expect(reason(row.counts[name])).toBe("missing_cache_write_rate");
    }
    const c = config(); c.rules[2]!.rates.in_cache_write = 0;
    const priced = ref({ cache_write: 1 }, c);
    expect(priced.counts.api_standard.pricedEvents).toBe(1n);
    expect(reason(priced.counts.window_api)).toBe("cache_write_semantics_unknown");
  });
  test("credit start date changes the entire shared cohort", () => {
    const early = ref({ ts: "2026-04-01T23:59:59Z", speed: null });
    expect(reason(early.counts.credits_standard)).toBe("missing_rate");
    expect(text(early.counts.window_credits_low.value)).toBe("0");
    expect(text(early.counts.window_credits_high.value)).toBe("0");
    expect(text(early.counts.window_normalized.value)).toBe("0.00003");
    const c = config(); c.rules = c.rules.filter(rule => rule.id !== "cf");
    expect(ref({ speed: null }, c).counts.window_credits_high.pricedEvents).toBe(1n);
    const late = ref({ speed: null, service_tier: "future-unmapped" }, c);
    for (const name of VARIANTS.filter(name => name.startsWith("window_"))) {
      expect(late.counts[name].unpricedEvents).toBe(1n);
      expect(reason(late.counts[name])).toBe("missing_rate");
    }
  });
  test("zero ratios, signed extra, nonterminating normalization and missing standard", () => {
    const c = config(); c.rules = c.rules.map(rule => ({ ...rule, long_context: undefined,
      multiplier: 1, rates: { in_uncached: rule.id === "cs" ? 3 : 1, in_cache_read: 0, out_total: 0 } }));
    const row = ref({ in_tok: 1, cached_in: 0, out_tok: 0, speed: "fast" }, c);
    expect(text(row.counts.extra_credits.value)).toBe("-0.000002");
    expect(serializeRational(row.counts.normalized_usd.value!)).toEqual({
      numerator: "1", denominator: "3000000", decimal: null,
    });
    c.rules = c.rules.map(rule => ({ ...rule, rates: { in_uncached: 0, in_cache_read: 0, out_total: 0 } }));
    const zero = ref({ speed: "fast" }, c);
    expect(text(zero.multiplier)).toBe("1"); expect(text(zero.counts.normalized_usd.value)).toBe("0");
    c.rules[1]!.rates.in_uncached = 1;
    const undefinedRatio = ref({ speed: "fast" }, c);
    expect(reason(undefinedRatio.counts.normalized_usd)).toBe("unknown_speed");
    expect(reason(undefinedRatio.counts.window_normalized)).toBe("missing_rate");
    c.rules = c.rules.filter(rule => rule.id !== "cs");
    expect(reason(ref({ speed: "fast" }, c).counts.normalized_usd)).toBe("unknown_speed");
  });
  test("mixed coverage preserves subtotal and exact reason/event/token counts", () => {
    const merged = mergeCounters(ref().counts.api_standard, ref({ usage_status: "unknown" }).counts.api_standard);
    expect(text(merged.subtotal)).toBe("0.00003"); expect(merged.value).toBeNull();
    expect(serializeCounter(merged).reasons).toEqual({ incomplete_usage: { events: "1", tokens: "13" } });
    expect(merged.pricedTokens).toBe(13n); expect(merged.unpricedTokens).toBe(13n);
  });
  test("overlap rejected, adjacency allowed, rates and multipliers validated", () => {
    const c = config(), first = c.rules[0]!;
    c.rules = [...c.rules, { ...first, id: "overlap", valid_from: "2026-04-03" }];
    expect(() => compileReferenceConfig(c)).toThrow("Overlapping");
    c.rules = [...config().rules, { ...first, id: "adjacent", valid_from: "2026-01-01", valid_until: "2026-04-02" }];
    expect(() => compileReferenceConfig(c)).not.toThrow();
    for (const invalid of [-1, Infinity, Number.NaN, "nope"]) {
      const bad = config(); bad.rules[0]!.rates.in_uncached = invalid;
      expect(() => compileReferenceConfig(bad)).toThrow();
    }
    const fractional = config(); fractional.rules[1]!.multiplier = "1.0000001";
    expect(text(ref({ speed: "fast" }, fractional).prices[1].amount)).toBe("0.0000150000015");
  });
});
