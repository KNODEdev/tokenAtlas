import { describe, expect, it } from "bun:test";
import { clipAtLimit, shapeAt, typicalBand, typicalForecastPath, windowDays } from "./window-status";

const course = (points: [number, number][]) => points.map(([t, pct]) => ({ t, pct }));

describe("window status chart geometry", () => {
  it("reads a shape between samples and never outside the measured span", () => {
    const shape = course([[10, 5], [50, 45], [100, 90]]);
    expect(shapeAt(shape, 30)).toBe(25);
    expect(shapeAt(shape, 50)).toBe(45);
    expect(shapeAt(shape, 5)).toBeNull();
    expect(shapeAt(course([[10, 5], [60, 40]]), 80)).toBeNull();
  });
  it("draws the typical band only where two windows were measured", () => {
    expect(typicalBand([course([[0, 0], [100, 80]])])).toEqual([]);
    const band = typicalBand([course([[0, 0], [100, 80]]), course([[0, 0], [50, 30]]), null], 4);
    expect(band.map((p) => p.t)).toEqual([0, 25, 50]);
    expect(band[2]).toEqual({ t: 50, low: 32.5, mid: 35, high: 37.5 });
  });
  it("ends the typical forecast at the computed value and cuts courses at the limit", () => {
    const band = typicalBand([course([[0, 0], [100, 100]]), course([[0, 0], [100, 100]])], 4);
    const path = typicalForecastPath(band, { t: 25, pct: 31 }, 87);
    expect(path[0]).toEqual({ t: 25, pct: 31 });
    expect(path.at(-1)).toEqual({ t: 100, pct: 87 });
    expect(typicalForecastPath([], { t: 25, pct: 31 }, 87)).toEqual([{ t: 25, pct: 31 }, { t: 100, pct: 87 }]);
    const cut = clipAtLimit(course([[20, 30], [100, 170]]));
    expect(cut.crossing).toEqual({ t: 60, pct: 100 });
    expect(cut.path.at(-1)).toEqual({ t: 60, pct: 100 });
    expect(clipAtLimit(course([[20, 30], [100, 87]])).crossing).toBeNull();
  });
  it("splits a window into local calendar days clipped to its bounds", () => {
    const start = new Date(2026, 8, 25, 10, 0).getTime();
    const days = windowDays(start, start + 168 * 3_600_000);
    expect(days).toHaveLength(8);
    expect(days[0]).toEqual({ key: "2026-09-25", startMs: start, endMs: new Date(2026, 8, 26).getTime() });
    expect(days.at(-1)!.key).toBe("2026-10-02");
    expect(days.at(-1)!.endMs).toBe(start + 168 * 3_600_000);
    expect(windowDays(start, start)).toEqual([]);
  });
});
