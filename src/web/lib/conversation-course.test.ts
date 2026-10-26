import { describe, expect, test } from "bun:test";
import type { ConversationCall, ConversationCourse } from "../../shared/conversation-course";
import { conversationApiValue, conversationCacheShare, conversationInput, conversationSummary } from "./conversation-course";

const call = (n: number): ConversationCall => ({ key: String(n), ts: `2026-10-20T10:${String(n).padStart(2, "0")}:00Z`,
  model: "test", tokens: { input: n, cache_read: n * 3, cache_write: n, output: n * 2 }, api_usd: n / 10000, price_partial: false });
const course = (count = 10): ConversationCourse => ({ vendor: "claude", identity: "one", basis: "conversation", unit: "call",
  calls: Array.from({ length: count }, (_, i) => call(i + 1)), excluded: 0, truncated: false, approximate_order: false });

describe("conversation edge comparisons", () => {
  test("per-entry cache percentage includes all input, excludes output, and keeps zero distinct from missing", () => {
    const item = call(1);
    expect(conversationInput(item)).toBe(5);
    expect(conversationCacheShare(item)).toBe(60);
    expect(conversationCacheShare({ ...item, tokens: { ...item.tokens!, output: 999999 } })).toBe(60);
    expect(conversationCacheShare({ ...item, tokens: { input: 10, cache_read: 0, cache_write: 10, output: 50 } })).toBe(0);
    expect(conversationCacheShare({ ...item, tokens: { input: 0, cache_read: 10, cache_write: 0, output: 50 } })).toBe(100);
    expect(conversationCacheShare({ ...item, tokens: { input: 0, cache_read: 0, cache_write: 0, output: 50 } })).toBeNull();
    expect(conversationCacheShare({ ...item, tokens: null })).toBeNull();
  });
  test("uses disjoint five-entry medians, includes writes in input, and weights cache by input", () => {
    const result = conversationSummary(course())!;
    expect(result.input).toEqual([15, 40]);
    expect(result.api).toEqual([0.0003, 0.0008]);
    expect(result.cacheShare).toBe(60);
  });
  test("does not compare short, truncated, excluded or unordered samples", () => {
    expect(conversationSummary(course(9))).toBeNull();
    for (const patch of [{ truncated: true }, { excluded: 1 }, { approximate_order: true }])
      expect(conversationSummary({ ...course(), ...patch })).toBeNull();
  });
  test("retains missing and zero independently, without shrinking either edge cohort", () => {
    const data = course(); data.calls[0]!.tokens = null; data.calls[9]!.api_usd = null;
    expect(conversationSummary(data)).toEqual({ input: [null, 40], api: [0.0003, null], cacheShare: null });
    data.calls = data.calls.map(item => ({ ...item, tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0 }, api_usd: 0 }));
    expect(conversationSummary(data)).toEqual({ input: [0, 0], api: [0, 0], cacheShare: null });
  });
  test("context preview uses the shared saved split and never adds an included uplift twice", () => {
    const data = course(); data.calls = data.calls.map(item => ({ ...item, context_price: { base: item.api_usd!, stored: item.api_usd!, extra: item.api_usd!, included: false } }));
    expect(conversationSummary(data, true)!.api[0]).toBeCloseTo(0.0006, 12);
    expect(conversationSummary(data, true)!.api[1]).toBeCloseTo(0.0016, 12);
    expect(conversationSummary(data, false)!.api).toEqual([0.0003, 0.0008]);
    expect(conversationApiValue({ ...data.calls[0]!, context_price: { base: 0.00005, stored: 0.0001, extra: 0.00005, included: true } }, true)).toBe(0.0001);
  });
});
