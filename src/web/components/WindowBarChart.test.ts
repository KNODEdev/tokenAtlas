import { describe, expect, it } from "bun:test";
import { fittingLabel, spacedTicks, windowAxis } from "./WindowBarChart";

describe("end label in the chart gutter", () => {
  it("draws the longest label that fits, or none", () => {
    const candidates = ["#70 · 17% · in progress", "#70 · 17%", "17%"];
    expect(fittingLabel(candidates, 200, 11)).toBe("#70 · 17% · in progress");
    expect(fittingLabel(candidates, 86, 11)).toBe("#70 · 17%");
    expect(fittingLabel(candidates, 30, 11)).toBe("17%");
    expect(fittingLabel(candidates, 10, 11)).toBeNull();
  });
});

describe("window axis ticks", () => {
  it("keeps a month tick only when it clears the one kept before it", () => {
    const { center } = windowAxis(700, 70);
    const ticks = [0, 1, 2, 30, 31, 60].map((i) => ({ center: center(i), text: i === 2 ? null : "Jul" }));
    // Slots are 8 px apart, so "Jul" (18 px) at slot 1 would run into slot 0's.
    expect(spacedTicks(ticks)).toEqual([true, false, false, true, false, true]);
  });
  it("shares one slot geometry between charts drawn under each other", () => {
    const axis = windowAxis(1000, 10);
    expect(axis.center(0)).toBeCloseTo(axis.x0 + axis.step / 2);
    expect(axis.center(9)).toBeCloseTo(axis.x1 - axis.step / 2);
  });
});
