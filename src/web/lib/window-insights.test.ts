import { describe, expect, it } from "bun:test";
import { buildWindowInsights, sampleCurveAt, TYPICAL_WINDOW_LIMIT } from "./window-insights";
import type { RailWindow } from "./windows";

function windowRow(overrides: Partial<RailWindow> = {}): RailWindow {
  return {
    key: "current",
    counterKey: "claude:weekly_all",
    counterLabel: "7d",
    label: "7d",
    dateLabel: "2026-08-28 → 2026-09-04",
    source: "probe",
    isCurrent: true,
    usedPercent: 51,
    percentBasis: "measured",
    elapsedPercent: 40,
    ppAhead: 11,
    windowHours: 168,
    startIso: "2026-08-28T00:00:00.000Z",
    resetIso: "2026-09-04T00:00:00.000Z",
    shape: [{ t: 10, pct: 8 }, { t: 40, pct: 51 }],
    regimeKey: "claude:weekly_all:pro:168h",
    sampledAtIso: "2026-09-03T12:00:00.000Z",
    sampleMachine: "EXAMPLE-MAIN",
    tokensTotal: null,
    usd: null,
    note: null,
    scope: null,
    sublimits: [],
    ...overrides,
  };
}

function closed(index: number, at40: number, end: number, overrides: Partial<RailWindow> = {}): RailWindow {
  return windowRow({
    key: `closed-${index}`,
    dateLabel: `closed ${index}`,
    isCurrent: false,
    usedPercent: end,
    elapsedPercent: 100,
    startIso: `2026-0${Math.max(1, index)}-01T00:00:00.000Z`,
    resetIso: `2026-0${Math.max(1, index)}-08T00:00:00.000Z`,
    shape: [{ t: 0, pct: 0 }, { t: 40, pct: at40 }, { t: 100, pct: end }],
    sampledAtIso: null,
    sampleMachine: null,
    ...overrides,
  });
}

describe("window insights", () => {
  it("uses a selected closed window without relabeling it as current or using future windows", () => {
    const selected = closed(2, 36, 80);
    const futureClosed = closed(9, 42, 90);
    const [insight] = buildWindowInsights(
      [windowRow(), selected, closed(1, 40, 84), futureClosed],
      Date.parse("2026-09-03T12:10:00.000Z"),
      selected.key,
    );
    expect(insight?.current.windowKey).toBe(selected.key);
    expect(insight?.current.isCurrent).toBe(false);
    expect(insight?.current.usedPercent).toBe(80);
    expect(insight?.comparableClosedCount).toBe(1);
    expect(insight?.forecastPercent).toBeNull();
  });

  it("uses the median of comparable windows and typical remaining usage for the forecast", () => {
    const [insight] = buildWindowInsights(
      [windowRow(), closed(1, 36, 80), closed(2, 40, 84)],
      Date.parse("2026-09-03T12:10:00.000Z")
    );
    expect(insight?.typicalAtElapsed).toBe(38);
    expect(insight?.typicalEndPercent).toBe(82);
    expect(insight?.deviationPp).toBe(13);
    expect(insight?.forecastPercent).toBe(95);
    expect(insight?.risk).toBe("warning");
  });

  it("builds history until two measured, same-regime closed windows overlap the current point", () => {
    const [insight] = buildWindowInsights([
      windowRow(),
      closed(1, 36, 80),
      closed(2, 40, 84, { regimeKey: "claude:weekly_all:max:168h" }),
      closed(3, 42, 90, { percentBasis: "counterfactual" }),
    ]);
    expect(insight?.comparableClosedCount).toBe(1);
    expect(insight?.buildingHistory).toBe(true);
    expect(insight?.forecastPercent).toBeNull();
  });

  it("never extrapolates outside the measured portion of a historical curve", () => {
    expect(sampleCurveAt([{ t: 20, pct: 7 }, { t: 60, pct: 30 }], 10)).toBeNull();
    expect(sampleCurveAt([{ t: 20, pct: 7 }, { t: 60, pct: 30 }], 80)).toBeNull();
    expect(sampleCurveAt([{ t: 20, pct: 7 }, { t: 60, pct: 30 }], 40)).toBeNull();
  });

  it("uses cumulative token activity when it is available between real percentage samples", () => {
    const sampled = sampleCurveAt(
      [{ t: 20, pct: 10 }, { t: 60, pct: 50 }],
      40,
      [{ t: 20, amount: 100 }, { t: 35, amount: 175 }, { t: 40, amount: 200 }, { t: 60, amount: 500 }]
    );
    expect(sampled).toEqual({ value: 20, basis: "activity-interpolated" });
  });

  it("keeps a scoped counter separate from the parent and never sums their percentages", () => {
    const current = windowRow({
      sublimits: [{
        counterKey: "claude:weekly_scoped:fable",
        label: "Fable",
        usedPercent: 43,
        percentBasis: "measured",
        shape: [{ t: 0, pct: 0 }, { t: 40, pct: 43 }],
        regimeKey: "claude:weekly_scoped:fable:pro:168h",
        sampledAtIso: "2026-09-03T12:00:00.000Z",
        sampleMachine: "EXAMPLE-LAPTOP-A",
        tokensTotal: null,
        usd: null,
        note: null,
      }],
    });
    const insights = buildWindowInsights([current]);
    expect(insights.map((item) => [item.label, item.current.usedPercent])).toEqual([
      ["7d", 51],
      ["Fable", 43],
    ]);
  });

  it("limits the baseline to the ten newest comparable windows", () => {
    const rows = Array.from({ length: TYPICAL_WINDOW_LIMIT + 2 }, (_, index) => closed(index + 1, 30 + index, 70 + index));
    const [insight] = buildWindowInsights([windowRow(), ...rows]);
    expect(insight?.comparableClosedCount).toBe(TYPICAL_WINDOW_LIMIT);
  });

  it("does not treat an early last probe as the end of a closed window", () => {
    const incomplete = closed(1, 36, 60, {
      shape: [{ t: 0, pct: 0 }, { t: 40, pct: 36 }, { t: 60, pct: 60 }],
    });
    const [insight] = buildWindowInsights([windowRow(), incomplete, closed(2, 40, 84)]);
    expect(insight?.comparableClosedCount).toBe(1);
    expect(insight?.buildingHistory).toBe(true);
    expect(insight?.forecastPercent).toBeNull();
  });

  it("does not treat a merely late reading as the complete end of a window", () => {
    const incompleteA = closed(1, 36, 70, {
      shape: [{ t: 0, pct: 0 }, { t: 40, pct: 36 }, { t: 99, pct: 70 }],
    });
    const incompleteB = closed(2, 40, 74, {
      shape: [{ t: 0, pct: 0 }, { t: 40, pct: 40 }, { t: 99, pct: 74 }],
    });

    const [insight] = buildWindowInsights([windowRow(), incompleteA, incompleteB]);

    expect(insight?.comparableClosedCount).toBe(0);
    expect(insight?.baselineCount).toBe(0);
    expect(insight?.forecastPercent).toBeNull();
  });

  it("never uses a counterfactual current percentage in measured baseline calculations", () => {
    const [insight] = buildWindowInsights([
      windowRow({ percentBasis: "counterfactual", source: "declared" }),
      closed(1, 36, 80),
      closed(2, 40, 84),
    ]);

    expect(insight?.comparableClosedCount).toBe(0);
    expect(insight?.baselineCount).toBe(0);
    expect(insight?.typicalAtElapsed).toBeNull();
    expect(insight?.typicalEndPercent).toBeNull();
    expect(insight?.deviationPp).toBeNull();
    expect(insight?.forecastPercent).toBeNull();
    expect(insight?.risk).toBe("neutral");
  });

  it("does not combine historical windows with missing regime provenance", () => {
    const [insight] = buildWindowInsights([
      windowRow({ regimeKey: undefined }),
      closed(1, 36, 80, { regimeKey: undefined }),
      closed(2, 40, 84, { regimeKey: undefined }),
    ]);

    expect(insight?.comparableClosedCount).toBe(0);
    expect(insight?.buildingHistory).toBe(true);
  });

  it("isolates legacy regime keys that only say the plan is unknown", () => {
    const [insight] = buildWindowInsights([
      windowRow({ regimeKey: "claude:weekly:unknown-plan" }),
      closed(1, 36, 80, { regimeKey: "claude:weekly:unknown-plan" }),
      closed(2, 40, 84, { regimeKey: "claude:weekly:unknown-plan" }),
    ]);

    expect(insight?.comparableClosedCount).toBe(0);
  });
});
