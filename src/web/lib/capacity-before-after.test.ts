import { describe, expect, it } from "bun:test";
import type { CodexComparisonWindow as Window, TimelineMarker } from "../../shared/codex-accounting";
import { beforeAfterLayout, defaultEventIds, eligibleCycles, eventSplit, markerTone, median, projectionValue, recentMedian, relativeChange } from "./capacity-before-after";
import { capacityFull } from "./codex-capacity";

/** One weekly cycle starting on `day` whose capacity at 100% is `full` API dollars, measured on `pp` of the meter. */
function cycle(day: string, full: number, pp = 100, overrides: Partial<Window> = {}): Window {
  const api = full * pp / 100;
  return { id: day, account: "codex1", plan: "pro", start: `${day}T07:00:00Z`, end: `${day}T20:00:00Z`, reset: `${day}T23:00:00Z`,
    cycle_start: `${day}T07:00:00Z`, window_minutes: 10080, start_percent: 0, end_percent: pp, observed_pp: pp, probes: 10, max_gap_hours: 1,
    usage: { events: 100, unpriced_events: 0, tokens: 1e8, input: 9e7, cached: 8e7, output: 1e7, fast_tokens: 0, unknown_tokens: 0,
      priced_tokens: 1e8, api_standard: api, credits_low: api * 25, credits_high: api * 50 },
    sources: [], models: [], ...overrides };
}
function marker(id: string, day: string, overrides: Partial<TimelineMarker> = {}): TimelineMarker {
  return { id, day, label: id, note: "", color: "warn", visible: true, ...overrides };
}
const price = (id: string, day: string) => marker(`price:${id}`, day, { pricing: [{} as never] });

const WINDOWS = [
  cycle("2026-08-13", 2826), cycle("2026-08-16", 2685), cycle("2026-08-24", 1960, 71), cycle("2026-08-25", 2022, 86),
  cycle("2026-08-29", 1982, 40), cycle("2026-08-31", 2012), cycle("2026-09-07", 1205, 76), cycle("2026-09-08", 1458),
  cycle("2026-09-12", 900, 39), cycle("2026-09-17", 1394), cycle("2026-09-26", 1561), cycle("2026-10-03", 1108, 70),
  cycle("2026-10-07", 1116, 99), cycle("2026-10-26", 1197), cycle("2026-10-28", 1169),
];

describe("before / after cycles", () => {
  it("uses the Cycles table's own capacity and drops samples under 40 pp and other counters", () => {
    const cycles = eligibleCycles([...WINDOWS, cycle("2026-10-29", 3000, 100, { window_minutes: 300 })], "api_standard");
    expect(cycles.map(item => item.window.id)).not.toContain("2026-09-12");
    expect(cycles).toHaveLength(14);
    for (const item of cycles) expect(item.value).toBe(capacityFull(item.window, "api_standard")!);
    expect(cycles[2]!.value).toBeCloseTo(1960, 6);
  });

  it("counts a cycle as before an event only when it starts before the event's day", () => {
    const cycles = eligibleCycles(WINDOWS, "api_standard");
    expect(eventSplit(cycles, marker("a", "2026-08-24"))).toBe(2);
    expect(eventSplit(cycles, marker("b", "2026-08-25"))).toBe(3);
  });

  it("draws two cycles on each side, a marker between them, and the latest two as now", () => {
    const cycles = eligibleCycles(WINDOWS, "api_standard");
    const events = [price("sol", "2026-08-21"), price("astra", "2026-09-04"), marker("promotion:codex-pro-200-usage-cut-20260929:announcement", "2026-09-29")];
    const layout = beforeAfterLayout(cycles, events);
    expect(layout.runs.map(run => run.bars.map(bar => `${bar.role}:${bar.cycle.window.id.slice(5)}`))).toEqual([
      ["before:08-13", "before:08-16", "after:08-24", "after:08-25"],
      ["before:08-29", "before:08-31", "after:09-07", "after:09-08"],
      ["before:09-17", "before:09-26", "after:10-03", "after:10-07"],
      ["now:10-26", "now:10-28"],
    ]);
    expect(layout.runs.map(run => [...run.markers.keys()])).toEqual([[2], [2], [2], []]);
    expect(layout.events.map(event => event.tone)).toEqual(["warn", "warn", "crit"]);
    // Headline: the first event's after cycles (1960, 2022) → the latest two (1197, 1169).
    expect(layout.headline.after).toBeCloseTo(1991, 6);
    expect(layout.headline.now).toBeCloseTo(1183, 6);
    expect(Math.round(layout.headline.change!)).toBe(-41);
  });

  it("never draws a cycle twice when events are close, and merges events between the same cycles", () => {
    const cycles = eligibleCycles(WINDOWS, "api_standard");
    const layout = beforeAfterLayout(cycles, [price("a", "2026-09-04"), marker("b", "2026-09-05"), price("c", "2026-09-08")]);
    const ids = layout.runs.flatMap(run => run.bars.map(bar => bar.cycle.window.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(layout.events).toHaveLength(2);
    expect(layout.events[0]!.markers.map(item => item.id)).toEqual(["price:a", "b"]);
    const joined = layout.runs[0]!;
    expect(joined.bars.map(bar => bar.cycle.window.id.slice(5))).toEqual(["08-29", "08-31", "09-07", "09-08", "09-17"]);
    expect([...joined.markers.keys()]).toEqual([2, 3]);
    expect(joined.bars.map(bar => bar.role)).toEqual(["before", "before", "after", "after", "after"]);
  });

  it("skips events without a cycle on both sides and folds now into the last event's run", () => {
    const cycles = eligibleCycles(WINDOWS, "api_standard");
    const layout = beforeAfterLayout(cycles, [marker("early", "2026-08-01"), price("late", "2026-10-27")]);
    expect(layout.events.map(event => event.markers[0]!.id)).toEqual(["price:late"]);
    expect(layout.runs).toHaveLength(1);
    expect(layout.runs[0]!.bars.map(bar => bar.role)).toEqual(["before", "before", "after"]);
    // Without events there is no comparison, only the current median.
    const plain = beforeAfterLayout(cycles, []);
    expect(plain.headline).toMatchObject({ after: null, change: null, event: null });
    expect(plain.runs[0]!.bars.every(bar => bar.role === "now")).toBe(true);
  });

  it("offers plan changes first, then price changes, one per position, at most four", () => {
    const cycles = eligibleCycles(WINDOWS, "api_standard");
    const markers = [
      marker("model:6-astra", "2026-09-04", { color: "violet" }), price("sol", "2026-08-21"), price("astra", "2026-09-04"),
      price("reserve", "2026-09-19"), marker("reset:x", "2026-09-07", { color: "crit" }), marker("promotion:codex-pro-200-usage-cut-20260929:announcement", "2026-09-29"),
      price("same-gap", "2026-09-20"), price("before-any", "2026-08-01"),
    ];
    expect(defaultEventIds(markers, cycles)).toEqual(["promotion:codex-pro-200-usage-cut-20260929:announcement", "price:sol", "price:astra", "price:reserve"]);
    expect(markerTone(markers[4]!)).toBe("crit");
    expect(markerTone(markers[1]!)).toBe("warn");
  });

  it("projects half of the latest cycle and takes another subscription's median of the last month", () => {
    const cycles = eligibleCycles(WINDOWS, "api_standard");
    expect(projectionValue(cycles)).toBeCloseTo(584.5, 6);
    expect(projectionValue([])).toBeNull();
    const claude = [cycle("2026-09-20", 9999), cycle("2026-10-01", 2476), cycle("2026-10-08", 2596, 91), cycle("2026-10-15", 2648),
      cycle("2026-10-22", 2752, 30), cycle("2026-10-25", 2820)];
    const result = recentMedian(claude, "api_standard", "2026-10-29");
    expect(result.count).toBe(4);
    expect(result.value).toBeCloseTo(2622, 6);
    expect(median([3, 1, 2])).toBe(2);
    expect(relativeChange(0, 5)).toBeNull();
  });
});
