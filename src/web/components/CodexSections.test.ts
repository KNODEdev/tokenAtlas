import { describe, expect, it } from "bun:test";
import { costPerUsedPercent, liveWindowApiCost, ownershipGapText } from "./CodexSections";

describe("cost per used window percentage", () => {
  it("divides current window dollars and credits by percentage points used", () => {
    expect(costPerUsedPercent(27.12, 13)).toBeCloseTo(2.0861538);
    expect(costPerUsedPercent(650, 13)).toBe(50);
    expect(costPerUsedPercent(0, 13)).toBe(0);
    expect(costPerUsedPercent(2, 0.5)).toBe(4);
  });
  it("does not invent a rate when usage or pricing is unavailable", () => {
    for (const percent of [0, -1, NaN, Infinity]) expect(costPerUsedPercent(27.12, percent)).toBeNull();
    for (const total of [null, undefined, -1, NaN, Infinity]) expect(costPerUsedPercent(total, 13)).toBeNull();
  });
});

describe("ownershipGapText", () => {
  it("keeps a genuinely unattributable sample visible with its count and reason", () => {
    expect(
      ownershipGapText({
        unowned_samples: 3,
        reasons: [{ reason: "ambiguous-era", samples: 3 }],
      })
    ).toBe(
      "Unassigned: 3 samples. Reason: overlapping eras: 3. These samples are excluded from charts and totals."
    );
  });

  it("does not warn when every sample is attributed", () => {
    expect(ownershipGapText({ unowned_samples: 0, reasons: [] })).toBeNull();
  });
});

describe("live-window API equivalent", () => {
  it("prices calls even when the live window has no gauge samples", () => {
    expect(liveWindowApiCost({ totals: { calls: 2, tokens: 100, tokens_fresh: 100, usd: 1.25 }, unpriced: { tokens: 0, models: {} } })).toBe(1.25);
  });
  it("does not turn missing calls or missing pricing into a zero dollar cost", () => {
    expect(liveWindowApiCost(null)).toBeNull();
    expect(liveWindowApiCost({ totals: { calls: 0, tokens: 0, tokens_fresh: 0, usd: 0 }, unpriced: { tokens: 0, models: {} } })).toBeNull();
    expect(liveWindowApiCost({ totals: { calls: 1, tokens: 100, tokens_fresh: 100, usd: 0 }, unpriced: { tokens: 100, models: { unknown: 100 } } })).toBeNull();
  });
});
