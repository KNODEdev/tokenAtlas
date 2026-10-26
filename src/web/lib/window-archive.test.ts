import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RailWindow } from "./windows";
import { getLocale, setLanguage, type Language } from "./i18n";
import {
  comparedCycles,
  courseAt,
  medianCourse,
  toggleCompared,
  windowCounters,
  windowHoursCourse,
  windowPlanKey,
  windowPlanLabel,
  windowResult,
  windowResultLabel,
} from "./window-archive";

let previousLanguage: Language = "en";
beforeEach(() => {
  previousLanguage = getLocale() === "pl-PL" ? "pl" : "en";
  setLanguage("en");
});
afterEach(() => setLanguage(previousLanguage));

function window(patch: Partial<RailWindow>): RailWindow {
  return {
    key: "w", counterKey: "claude:kind=value(weekly_all):group=none:scope=none", counterLabel: "7d", label: "7d", dateLabel: "w",
    source: "probe", isCurrent: false, usedPercent: 50, percentBasis: "measured", elapsedPercent: 100, ppAhead: null,
    windowHours: 168, startIso: "2026-09-13T11:00:00.000Z", resetIso: "2026-09-20T11:00:00.000Z", shape: null,
    tokensTotal: null, usd: null, note: null, scope: null, sublimits: [], ...patch,
  };
}

describe("window result (decision 12)", () => {
  test("uses one threshold set, exhausted from 100%", () => {
    expect(windowResult(100, false, 40, 168)).toBe("exhausted");
    expect(windowResult(99.9, false, 168, 168)).toBe("near");
    expect(windowResult(70, false, 168, 168)).toBe("normal");
    expect(windowResult(12, true, 2, 168)).toBe("current");
  });
  test("separates an unused window from one reset before its end", () => {
    expect(windowResult(37, false, 168, 168)).toBe("unused");
    expect(windowResult(37, false, 166, 168)).toBe("unused");
    expect(windowResult(37, false, 33, 168)).toBe("early");
    expect(windowResult(37, false, null, 168)).toBe("unused");
    expect(windowResultLabel("early")).toBe("reset early");
    expect(windowResultLabel("unused")).toBe("unused");
    setLanguage("pl");
    expect(windowResultLabel("early")).toBe("reset wcześniej");
    expect(windowResultLabel("unused")).toBe("niewykorzystane");
  });
});

describe("usage course in hours since the window start", () => {
  test("a cycle runs to its reset at its measured end percent", () => {
    const cycle = window({ source: "cycle", usedPercent: 100, elapsedPercent: 25, shape: [{ t: 0, pct: 5 }, { t: 10, pct: 60 }] });
    expect(windowHoursCourse(cycle)).toEqual([[0, 5], [16.8, 60], [42, 100]]);
  });
  test("other windows stop at their last reading", () => {
    const probe = window({ usedPercent: 42, shape: [{ t: 50, pct: 30 }, { t: 0, pct: 0 }, { t: 80, pct: 42 }] });
    expect(windowHoursCourse(probe)).toEqual([[0, 0], [84, 30], [134.4, 42]]);
  });
  test("is empty without a window length", () => {
    expect(windowHoursCourse(window({ windowHours: null, shape: [{ t: 0, pct: 1 }] }))).toEqual([]);
  });
  test("samples readings and values between two of them, never beyond", () => {
    const course = [[1, 10], [3, 30]] as const;
    expect(courseAt(course, 3)).toEqual({ value: 30, exact: true });
    expect(courseAt(course, 2)).toEqual({ value: 20, exact: false });
    expect(courseAt(course, 0.5)).toBeNull();
    expect(courseAt(course, 4)).toBeNull();
  });
  test("the median course keeps each window's end after it ended", () => {
    const course = medianCourse([[[0, 0], [2, 100]], [[0, 0], [4, 40]], [[0, 0], [4, 60]]], 1);
    expect(course.at(-1)).toEqual([4, 60]);
    expect(course[2]).toEqual([2, 30]);
    expect(medianCourse([], 1)).toEqual([]);
  });
});

describe("plan of a window", () => {
  test("reads the plan part of the regime key", () => {
    const counterKey = "claude:kind=value(weekly_all):group=none:scope=none";
    expect(windowPlanKey({ counterKey, regimeKey: `${counterKey}:max-20x:168h:origin:allowance=vendor-percent:boost=1` })).toBe("max-20x");
    expect(windowPlanKey({ counterKey, regimeKey: `${counterKey}:unknown-plan@2026-09-20T11:00:00.000Z:168h` })).toBe("unknown-plan");
    expect(windowPlanKey({ counterKey, regimeKey: `${counterKey}:mixed-plan@2026-09-12T13:35:00.000Z:168h` })).toBe("mixed-plan");
    expect(windowPlanKey({ counterKey, regimeKey: "other:max-20x" })).toBeNull();
    expect(windowPlanKey({ counterKey, regimeKey: null })).toBeNull();
  });
  test("labels unknown and mixed plans", () => {
    expect(windowPlanLabel("claude", "unknown-plan")).toBe("plan ?");
    expect(windowPlanLabel("claude", null)).toBe("plan ?");
    expect(windowPlanLabel("claude", "mixed-plan")).toBe("plan change");
  });
});

describe("window counters", () => {
  const fable = { counterKey: "claude:scoped", label: "Fable", usedPercent: 9, percentBasis: "measured" as const, tokensTotal: null, usd: null, note: null };
  const measured = window({ key: "m", counterKey: "claude:kind=value(weekly_all):group=value(weekly):scope=none", sublimits: [fable] });
  const cadence = window({ key: "c", counterKey: "claude:kind=value(weekly_all):group=none:scope=none", source: "declared", percentBasis: null, usedPercent: null,
    startIso: "2026-09-06T11:00:00.000Z", resetIso: "2026-09-13T11:00:00.000Z", sublimits: [{ ...fable, counterKey: "claude:declared-scoped", usedPercent: null, percentBasis: null }] });
  const session = window({ key: "s", counterKey: "claude:five_hour", counterLabel: "5h", label: "5h", windowHours: 5,
    startIso: "2026-09-26T16:09:00.000Z", resetIso: "2026-09-26T21:09:00.000Z" });

  test("read and reconstructed windows of one meter share a counter with a distinct label", () => {
    const counters = windowCounters([measured, cadence, session], "longest");
    expect(counters.map((counter) => counter.label)).toEqual(["Week 7d", "↳ Fable 7d", "Session 5h"]);
    expect(counters[0]!.rows.map((row) => row.key)).toEqual(["m", "c"]);
    expect(counters[1]!.rows.map((row) => row.usedPercent)).toEqual([9, null]);
    expect(windowCounters([measured, cadence, session], "shortest").map((counter) => counter.label)).toEqual(["Session 5h", "Week 7d", "↳ Fable 7d"]);
    setLanguage("pl");
    expect(windowCounters([session], "longest")[0]!.label).toBe("Sesja 5h");
  });
  test("an unattached sublimit window joins its sublimit counter", () => {
    const orphan = window({ key: "o", scope: "Fable", label: "7d · Fable" });
    expect(windowCounters([measured, orphan], "longest").map((counter) => [counter.label, counter.rows.length])).toEqual([["Week 7d", 1], ["↳ Fable 7d", 2]]);
  });
});

describe("compare selection", () => {
  const cycles = [{ index: 70, isActive: true }, { index: 69, isActive: false }, { index: 68, isActive: false }, { index: 67, isActive: false }, { index: 66, isActive: false }];
  test("defaults to the three newest closed cycles and ignores the current or unknown ones", () => {
    expect(comparedCycles(cycles, [])).toEqual([69, 68, 67]);
    expect(comparedCycles(cycles, [70, 12, 66])).toEqual([66]);
  });
  test("toggles up to four windows beside the current one and never drops the last", () => {
    expect(toggleCompared([69, 68, 67], 66)).toEqual([69, 68, 67, 66]);
    expect(toggleCompared([69, 68, 67, 66], 65)).toEqual([69, 68, 67, 66]);
    expect(toggleCompared([69, 68], 69)).toEqual([68]);
    expect(toggleCompared([68], 68)).toEqual([68]);
  });
});
