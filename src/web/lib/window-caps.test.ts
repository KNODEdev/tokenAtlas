import { describe, expect, it } from "bun:test";
import { historicalWindowCaps, previousCapWindows, type CapSample } from "./window-caps";

const sample = (usedPercent: number, usd: number, credits: number): CapSample => ({
  usedPercent,
  data: {
    totals: { calls: 10, usd, tokens: usd * 1000, tokens_fresh: usd * 100 },
    unpriced: { tokens: 0, models: {} },
    credit_equivalent: { value: credits, priced_credits: credits, unpriced_calls: 0, basis: "Standard" },
  },
});

describe("historical window caps", () => {
  it("normalizes each window to 100% before taking the median, independently for credits", () => {
    const caps = historicalWindowCaps([sample(50, 100, 500), sample(100, 300, 600), sample(25, 1000, 1000)]);
    expect(caps.api).toEqual({ value: 300, count: 3 });
    expect(caps.credits).toEqual({ value: 1000, count: 3 });
    expect(caps.tokens.value).toBe(300000);
  });
  it("excludes missing pricing per metric and windows with no usage", () => {
    const partial = sample(50, 100, 500);
    partial.data.unpriced.tokens = 20;
    partial.data.credit_equivalent!.unpriced_calls = 1;
    const caps = historicalWindowCaps([sample(0, 100, 500), partial]);
    expect(caps.api.value).toBeNull();
    expect(caps.credits.value).toBeNull();
    expect(caps.tokens.count).toBe(1);
    expect(historicalWindowCaps([]).api.value).toBeNull();
  });
  it("averages the middle two caps for an even sample count", () => {
    expect(historicalWindowCaps([sample(50, 100, 500), sample(50, 200, 1000)]).api.value).toBe(300);
  });
});

describe("history window selection", () => {
  const window = (index: number) => ({ index, isActive: false, isShadow: false, windowHours: 168,
    startIso: new Date(Date.UTC(2026, 0, index * 7)).toISOString(),
    resetIso: new Date(Date.UTC(2026, 0, (index + 1) * 7)).toISOString(),
    endIso: new Date(Date.UTC(2026, 0, (index + 1) * 7)).toISOString(), raw: { limit_id: "codex" },
  });
  it("uses at most ten preceding closed windows and excludes future or incompatible windows", () => {
    const selected = window(20);
    const cycles = Array.from({ length: 23 }, (_, i) => window(i));
    cycles[19]!.isActive = true;
    cycles[18]!.isShadow = true;
    cycles[17]!.windowHours = 5;
    cycles[16]!.raw.limit_id = "other";
    expect(previousCapWindows(cycles, selected).map(c => c.index)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  });
});
