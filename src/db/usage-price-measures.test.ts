import { describe, expect, test } from "bun:test";
import {
  decodeCounts, decodeQuality, decodeTokens, encodeCounts, encodeQuality, encodeTokens,
  USAGE_PRICE_QUALITY_KEYS, USAGE_PRICE_TOKEN_KEYS, type StoredAmount, type StoredCounts,
} from "./usage-price-measures";

const amount = (patch: Partial<StoredAmount> = {}): StoredAmount => ({ subtotal: "0", pricedSubtotal: "0",
  pricedEvents: "0", unpricedEvents: "0", pricedTokens: "0", unpricedTokens: "0", reasons: {}, ...patch });
const priced = amount({ subtotal: "0.005967699999999999", pricedSubtotal: "0.005967699999999999", pricedEvents: "1", pricedTokens: "19379" });
const unpriced = amount({ unpricedEvents: "1", unpricedTokens: "24868", reasons: { unknown_speed: { events: "1", tokens: "24868" } } });
const zeros = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, "0"]));

describe("usage price measure encoding", () => {
  test("the compact form decodes to the identical counts, keys in producer order", () => {
    const cases: StoredCounts[] = [
      { api_standard: priced, api_standard_credited: priced, api_actual: unpriced, credits_standard: priced,
        credits_fast: amount({ subtotal: "4.0472", pricedSubtotal: "4.0472", pricedEvents: "1", pricedTokens: "24868" }),
        normalized_usd: unpriced, extra_credits: amount({ subtotal: "-0.5", pricedSubtotal: "-0.5", pricedEvents: "1" }) },
      { api_standard: priced, api_actual: priced, api_global: priced },
      { api_global: amount({ pricedEvents: "1" }) },
      // Partially rated events: a computable subtotal whose priced part is smaller, or nothing.
      { api_standard: amount({ subtotal: "1.25", pricedSubtotal: "0.75", pricedEvents: "2", unpricedEvents: "1",
        pricedTokens: "9007199254740993", unpricedTokens: "7", reasons: { missing_rate: { events: "1", tokens: "7" } } }),
        api_actual: amount({ subtotal: "1.25", unpricedEvents: "1", reasons: { missing_rate: { events: "1", tokens: "0" } } }) },
      {},
    ];
    for (const counts of cases) {
      const stored = encodeCounts(counts, true);
      expect(decodeCounts(stored)).toEqual(counts);
      expect(Object.keys(decodeCounts(stored))).toEqual(Object.keys(counts));
      expect(stored.length).toBeLessThan(JSON.stringify(counts).length + 3);
    }
    expect(encodeCounts({ api_global: amount({ pricedEvents: "1" }) }, true)).toBe("[null,null,null,[0,0,1]]");
  });

  test("quality and tokens drop zeros and decode to every key", () => {
    const quality = { ...zeros(USAGE_PRICE_QUALITY_KEYS), unknown_speed_tokens: "24868" };
    const tokens = { ...zeros(USAGE_PRICE_TOKEN_KEYS), in_uncached: "13902", out_total: "34", reasoning_out: "18446744073709551616" };
    expect(encodeQuality(zeros(USAGE_PRICE_QUALITY_KEYS), true)).toBe("[]");
    expect(decodeQuality(encodeQuality(quality, true))).toEqual(quality);
    expect(decodeTokens(encodeTokens(tokens, true))).toEqual(tokens);
  });

  test("rows written in the named form still decode, and unknown names are refused", () => {
    const counts = { api_standard: priced };
    expect(decodeCounts(JSON.stringify(counts))).toEqual(counts);
    expect(decodeQuality(JSON.stringify({ duplicates: "2" }))).toEqual({ duplicates: "2" });
    expect(() => encodeCounts({ invented: priced }, true)).toThrow("Unknown usage price variant");
    expect(() => encodeQuality({ invented: "1" }, true)).toThrow("Unknown usage price measure");
  });
});
