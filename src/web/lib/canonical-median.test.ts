import { describe, expect, test } from "bun:test";
import { canonicalMedian, type MedianSample } from "./canonical-median";

const sample = (value: number | null, patch: Partial<MedianSample> = {}): MedianSample =>
  ({ value, plan: "Pro ×20", samplePp: 40, confidence: "medium", ...patch });

describe("canonical median", () => {
  test("uses only same-plan samples of at least 20 pp with medium or high confidence", () => {
    const result = canonicalMedian([
      sample(100), sample(300, { confidence: "high" }), sample(200),
      sample(9000, { plan: "Plus ×1" }), sample(9000, { samplePp: 19.9 }), sample(9000, { confidence: "low" }),
      sample(9000, { confidence: "none" }), sample(null), sample(Number.NaN), sample(250, { samplePp: 20 }),
    ], "Pro ×20");
    expect(result).toEqual({ value: 225, plan: "Pro ×20", count: 4, values: [100, 200, 250, 300] });
  });
  test("an odd count takes the middle value", () => {
    expect(canonicalMedian([sample(3), sample(1), sample(2)], "Pro ×20").value).toBe(2);
  });
  test("reports why there is no median", () => {
    expect(canonicalMedian([sample(1), sample(2)], null)).toEqual({ value: null, plan: null, count: 0, reason: "no_plan" });
    expect(canonicalMedian([sample(1), sample(2, { samplePp: 5 })], "Pro ×20")).toEqual({ value: null, plan: "Pro ×20", count: 1, reason: "too_few" });
    expect(canonicalMedian([], "Pro ×20")).toMatchObject({ value: null, count: 0, reason: "too_few" });
  });
});
