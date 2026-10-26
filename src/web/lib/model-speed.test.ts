import { expect, test } from "bun:test";
import {
  chartBuckets, joined, latestWeek, modelTotals, outlierSeries, rankedModels, readHiddenModels, speedBuckets, speedScaleMax, weekStart,
  accountSelected, accountState, modelSelected, setAccounts, readHiddenModels as readHidden, mergeSpeedParts, readSpeedSelection, selectedParts, seriesStroke, speedModels, speedSubscriptions, toggleAccount, toggleModel,
  writeHiddenModels, writeSpeedSelection, entriesSince, rangeStart, HIDDEN_MODELS_KEY, SPEED_SELECTION_KEY, EMPTY_SELECTION, type ModelSpeedPoint, type ModelSpeedSeries,
} from "./model-speed";

const day = (at: string, sums: Partial<ModelSpeedPoint>): ModelSpeedPoint => ({ at, calls: 0, timed_calls: 0, timed_out: 0, timed_ms: 0, speed: null,
  long_calls: 0, long_out: 0, long_ms: 0, long_speed: null, coverage: null, ...sums });
const series = (model: string, points: ModelSpeedPoint[]): ModelSpeedSeries => {
  const total = points.reduce((sum, point) => day("total", {
    calls: sum.calls + point.calls, timed_calls: sum.timed_calls + point.timed_calls, timed_out: sum.timed_out + point.timed_out,
    timed_ms: sum.timed_ms + point.timed_ms, long_calls: sum.long_calls + point.long_calls, long_out: sum.long_out + point.long_out,
    long_ms: sum.long_ms + point.long_ms }), day("total", {}));
  return { model, total, points };
};

test("weeks start on Monday in UTC", () => {
  expect(weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday
  expect(weekStart("2026-10-05")).toBe("2026-10-05"); // Monday
  expect(weekStart("2026-10-07")).toBe("2026-10-05");
});

test("a week's speed is the ratio of its summed tokens and time, never the average of daily speeds", () => {
  // Monday: 10 calls at 100 tok/s; Tuesday: 90 calls at 10 tok/s. The daily average would be 55 tok/s.
  const points = [day("2026-10-05", { calls: 10, timed_calls: 10, timed_out: 10_000, timed_ms: 100_000, long_calls: 10, long_out: 10_000, long_ms: 100_000 }),
    day("2026-10-06", { calls: 100, timed_calls: 90, timed_out: 9_000, timed_ms: 900_000, long_calls: 5, long_out: 2_000, long_ms: 40_000 })];
  const [week] = speedBuckets(points, "week", "all");
  expect(week).toMatchObject({ at: "2026-10-05", calls: 110, timed: 100, n: 100, out: 19_000, ms: 1_000_000 });
  expect(week!.speed).toBeCloseTo(19);
  const [long] = speedBuckets(points, "week", "long");
  expect(long).toMatchObject({ n: 15, out: 12_000, ms: 140_000 });
  expect(long!.speed).toBeCloseTo(12_000 * 1000 / 140_000);
  expect(speedBuckets(points, "day", "all").map(bucket => bucket.speed)).toEqual([100, 10]);
});

test("a bucket is drawn only from 5 calls of the kind, and lines skip gaps longer than 1.5 buckets", () => {
  const points = [day("2026-10-01", { timed_calls: 4, timed_out: 400, timed_ms: 4000 }), day("2026-10-02", { timed_calls: 5, timed_out: 500, timed_ms: 5000 })];
  expect(chartBuckets(points, "day", "all").map(bucket => bucket.at)).toEqual(["2026-10-02"]);
  expect(chartBuckets(points, "day", "long")).toEqual([]);
  expect(joined("2026-10-01", "2026-10-02", "day")).toBe(true);
  expect(joined("2026-10-01", "2026-10-03", "day")).toBe(false);
  expect(joined("2026-09-28", "2026-10-05", "week")).toBe(true);
  expect(joined("2026-09-21", "2026-10-05", "week")).toBe(false);
});

test("a model whose median is more than 2.5 times the next one's is drawn above the scale", () => {
  const spark = { key: "spark", values: [290, 300, 310] };
  expect(outlierSeries([{ key: "a", values: [40, 42] }, spark, { key: "b", values: [30] }])).toEqual({ key: "spark", median: 300 });
  // 2.5 times exactly is still on the scale; one model alone is never an outlier.
  expect(outlierSeries([{ key: "a", values: [100] }, { key: "b", values: [40] }])).toBeNull();
  expect(outlierSeries([spark])).toBeNull();
  // The scale is set by the others, at least 20 tok/s.
  expect(speedScaleMax([40, 42, 30])).toBe(50);
  expect(speedScaleMax([])).toBe(20);
});

test("only models with 50 calls of the kind are ranked; the latest week sums every model", () => {
  const fast = series("fast", [day("2026-10-06", { calls: 60, timed_calls: 60, timed_out: 6000, timed_ms: 60_000, long_calls: 49, long_out: 49_000, long_ms: 98_000 })]);
  const slow = series("slow", [day("2026-09-28", { calls: 60, timed_calls: 60, timed_out: 600, timed_ms: 60_000, long_calls: 50, long_out: 5000, long_ms: 500_000 }),
    day("2026-10-07", { calls: 10, timed_calls: 10, timed_out: 100, timed_ms: 10_000 })]);
  const rows = [fast, slow].map(item => ({ model: item.model, totals: modelTotals(item) }));
  expect(rankedModels(rows, "long").map(row => row.model)).toEqual(["slow"]);
  expect(rankedModels(rows, "all").map(row => row.model)).toEqual(["fast", "slow"]);
  expect(latestWeek([fast, slow], "all")).toEqual({ week: "2026-10-05", calls: 70, speed: 6100 * 1000 / 70_000 });
});

test("hidden models are kept per subscription and the page works when storage fails", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeHiddenModels("codex1", new Set(["gpt-5.3-codex-spark"]), storage);
  writeHiddenModels("codex2", new Set(["gpt-5.5"]), storage);
  expect([...readHiddenModels("codex1", storage)]).toEqual(["gpt-5.3-codex-spark"]);
  writeHiddenModels("codex1", new Set(), storage);
  expect(JSON.parse(values.get(HIDDEN_MODELS_KEY)!)).toEqual({ codex2: ["gpt-5.5"] });
  values.set(HIDDEN_MODELS_KEY, "{not json");
  expect(readHiddenModels("codex2", storage).size).toBe(0);
  const failing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  expect(readHiddenModels("codex1", failing).size).toBe(0);
  expect(() => writeHiddenModels("codex1", new Set(["x"]), failing)).not.toThrow();
  expect(readHiddenModels("codex1", null).size).toBe(0);
});

test("Claude Code's <synthetic> placeholder and calls without a model are not models on the screen", () => {
  const named = series("claude-opus-5", [day("2026-10-05", { calls: 10, timed_calls: 10, timed_out: 1000, timed_ms: 10_000 })]);
  const synthetic = series("<synthetic>", [day("2026-10-05", { calls: 350, timed_calls: 320, timed_out: 0, timed_ms: 5_000 })]);
  const unnamed = { ...series("x", [day("2026-10-05", { calls: 3 })]), model: null };
  expect(speedModels([named, synthetic, unnamed]).map(item => item.model)).toEqual(["claude-opus-5"]);
  // The placeholder's zero output would otherwise drag the latest week down.
  expect(latestWeek(speedModels([named, synthetic, unnamed]), "all")!.speed).toBe(100);
});

test("after the palette's colours run out, a model's line is dashed, then dotted, in the same colour order", () => {
  const palette = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const strokes = Array.from({ length: 19 }, (_, index) => seriesStroke(index, palette));
  expect(strokes.slice(0, 8).every(stroke => stroke.dash === undefined)).toBe(true);
  expect(strokes[8]).toEqual({ color: "a", dash: "6 4" });
  expect(strokes[15]).toEqual({ color: "h", dash: "6 4" });
  expect(strokes[16]).toEqual({ color: "a", dash: "1.5 3" });
  // No two models share both colour and pattern.
  expect(new Set(strokes.map(stroke => `${stroke.color}|${stroke.dash}`)).size).toBe(19);
});

test("All sums a model's day rows across subscriptions and takes its speed from the sums, or keeps each subscription apart", () => {
  // codex1: 10 calls at 100 tok/s; codex2: 90 calls at 10 tok/s. The average of the two speeds would be 55 tok/s.
  const parts = [{ account: "codex1", models: [series("gpt", [day("2026-10-05", { calls: 10, timed_calls: 10, timed_out: 10_000, timed_ms: 100_000 })])] },
    { account: "codex2", models: [series("gpt", [day("2026-10-05", { calls: 90, timed_calls: 90, timed_out: 9_000, timed_ms: 900_000 }),
      day("2026-10-06", { calls: 5, timed_calls: 5, timed_out: 500, timed_ms: 50_000 })]),
      series("<synthetic>", [day("2026-10-05", { calls: 7 })])] }];
  const [merged, ...rest] = mergeSpeedParts(parts, false);
  expect(rest).toEqual([]);
  expect(merged).toMatchObject({ key: "gpt", model: "gpt", accounts: ["codex1", "codex2"] });
  expect(merged!.series.total).toMatchObject({ calls: 105, timed_calls: 105, timed_out: 19_500, timed_ms: 1_050_000 });
  expect(merged!.series.points.map(point => [point.at, point.calls, point.speed])).toEqual([["2026-10-05", 100, 19], ["2026-10-06", 5, 10]]);
  const split = mergeSpeedParts(parts, true);
  expect(split.map(entry => [entry.accounts, entry.series.total.calls, entry.series.total.speed])).toEqual([[["codex2"], 95, 10], [["codex1"], 10, 100]]);
});

test("All lists the active Claude and Codex subscriptions, then the inactive ones, each once; a pool is its own scope", () => {
  const cards = [{ id: "__all__", group: "all", active: true, vendorAccount: null },
    { id: "codex1::business", group: "codex", active: false, vendorAccount: null },
    { id: "codex1", group: "codex", active: true, vendorAccount: "a@x" }, { id: "CODEX1", group: "codex", active: true, vendorAccount: "a@x" },
    { id: "claude-a", group: "claude", active: true, vendorAccount: "a@x" }, { id: "Codex1::Business", group: "codex", active: true, vendorAccount: null },
    { id: "claude-old", group: "claude", active: false, vendorAccount: null }, { id: "agy1", group: "gemini", active: true, vendorAccount: null }];
  expect(speedSubscriptions(cards, "__all__").map(sub => [sub.id, sub.provider, sub.active])).toEqual([
    ["codex1", "codex", true], ["claude-a", "claude", true], ["Codex1::Business", "codex", true],
    ["claude-old", "claude", false]]);
  // The pool and its account are separate scopes: their calls merge once each, never the pool's twice.
  const parts = [{ account: "codex1", models: [series("gpt", [day("2026-10-05", { calls: 10 })])] },
    { account: "Codex1::Business", models: [series("gpt", [day("2026-10-05", { calls: 3 })])] }];
  expect(mergeSpeedParts(parts, false)[0]!.series.total.calls).toBe(13);
});

test("an inactive subscription is off unless turned on; once active it is on unless it was turned off", () => {
  const inactive = new Set(["old"]);
  expect(accountSelected(EMPTY_SELECTION, "old", inactive)).toBe(false);
  expect(accountState(EMPTY_SELECTION, "old", ["gpt"], inactive)).toBe("none");
  const on = toggleAccount(EMPTY_SELECTION, "old", ["gpt"], inactive);
  expect(on).toMatchObject({ optIn: ["old"], accounts: [] });
  expect(accountSelected(on, "old", inactive)).toBe(true);
  // Active again: untouched means on, explicitly off stays off.
  expect(accountSelected(EMPTY_SELECTION, "old")).toBe(true);
  const off = toggleAccount(on, "old", ["gpt"], inactive);
  expect(off).toMatchObject({ optIn: [], accounts: ["old"] });
  expect(accountSelected(off, "old")).toBe(false);
  // Select all includes inactive subscriptions; a model ticked under an inactive one turns it on with that model.
  expect(accountSelected(setAccounts(EMPTY_SELECTION, ["new", "old"], true, inactive), "old", inactive)).toBe(true);
  const single = toggleModel(EMPTY_SELECTION, "old", "gpt", ["gpt", "luna"], inactive);
  expect([accountState(single, "old", ["gpt", "luna"], inactive), modelSelected(single, "old", "gpt", inactive)]).toEqual(["some", true]);
  const parts = [{ account: "old", models: [series("gpt", [day("2026-10-05", { calls: 1 })])] }];
  expect(selectedParts(parts, EMPTY_SELECTION, inactive)).toEqual([]);
  expect(selectedParts(parts, on, inactive).map(part => part.account)).toEqual(["old"]);
  // Stored as payload version 2; a version 1 payload reads with nothing opted in; throwing storage falls back.
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeSpeedSelection(on, storage);
  expect(JSON.parse(values.get(SPEED_SELECTION_KEY)!)).toMatchObject({ v: 2, optIn: ["old"] });
  expect(readSpeedSelection(storage)).toEqual(on);
  values.set(SPEED_SELECTION_KEY, JSON.stringify({ accounts: ["x"], models: {}, split: true }));
  expect(readSpeedSelection(storage)).toEqual({ accounts: ["x"], optIn: [], models: {}, split: true });
  const failing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  expect(readSpeedSelection(failing)).toEqual(EMPTY_SELECTION);
  expect(() => writeSpeedSelection(on, failing)).not.toThrow();
});

test("the drawer's choice: whole subscriptions, single models and the mixed state; it is kept when storage works", () => {
  const models = ["gpt", "luna"];
  let selection = toggleModel(EMPTY_SELECTION, "codex2", "gpt", models);
  expect(accountState(selection, "codex2", models)).toBe("some");
  selection = toggleAccount(selection, "codex2", models);
  expect(accountState(selection, "codex2", models)).toBe("all");
  selection = toggleAccount(selection, "codex2", models);
  expect(accountState(selection, "codex2", models)).toBe("none");
  // A model ticked in a left-out subscription becomes its only chosen model.
  selection = toggleModel(selection, "codex2", "luna", models);
  expect(accountState(selection, "codex2", models)).toBe("some");
  const parts = [{ account: "codex2", models: models.map(name => series(name, [day("2026-10-05", { calls: 1 })])) }];
  expect(selectedParts(parts, selection).map(part => part.models.map(item => item.model))).toEqual([["luna"]]);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeSpeedSelection({ ...selection, split: true }, storage);
  expect(readSpeedSelection(storage)).toEqual({ ...selection, split: true });
  values.set(SPEED_SELECTION_KEY, "[not json");
  expect(readSpeedSelection(storage)).toEqual(EMPTY_SELECTION);
  const failing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  expect(readSpeedSelection(failing)).toEqual(EMPTY_SELECTION);
  expect(() => writeSpeedSelection(selection, failing)).not.toThrow();
});

test("subscription IDs that name inherited properties are ordinary keys in the choice and the hidden models", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    const models = ["gpt", "luna"];
    expect(modelSelected(EMPTY_SELECTION, id, "gpt")).toBe(true);
    expect(accountState(EMPTY_SELECTION, id, models)).toBe("all");
    const partly = toggleModel(EMPTY_SELECTION, id, "gpt", models);
    expect(Object.getPrototypeOf(partly.models)).toBe(Object.prototype);
    expect(accountState(partly, id, models)).toBe("some");
    expect(accountState(toggleAccount(partly, id, models), id, models)).toBe("all");
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeSpeedSelection(partly, storage);
    expect(accountState(readSpeedSelection(storage), id, models)).toBe("some");
    expect(readHidden(id, storage).size).toBe(0);
    writeHiddenModels(id, new Set(["gpt"]), storage);
    writeHiddenModels("codex1", new Set(["luna"]), storage);
    expect([...readHidden(id, storage)]).toEqual(["gpt"]);
    expect([...readHidden("codex1", storage)]).toEqual(["luna"]);
  }
});

test("a model first seen after the choice was saved is chosen by default", () => {
  const saved = toggleModel(EMPTY_SELECTION, "codex1", "gpt", ["gpt", "luna"]);
  const parts = [{ account: "codex1", models: ["gpt", "luna", "new-model"].map(name => series(name, [day("2026-10-05", { calls: 1 })])) },
    { account: "codex9", models: [series("other", [day("2026-10-05", { calls: 1 })])] }];
  expect(selectedParts(parts, saved).map(part => [part.account, part.models.map(item => item.model)]))
    .toEqual([["codex1", ["luna", "new-model"]], ["codex9", ["other"]]]);
});

test("a period ends today and counts today among its days; the whole history has no start", () => {
  expect(rangeStart("30d", "2026-10-07")).toBe("2026-09-08");
  expect(rangeStart("90d", "2026-10-07")).toBe("2026-07-10");
  expect(rangeStart("180d", "2026-10-07")).toBe("2026-04-11");
  for (const days of [7, 14, 30, 60, 90, 180, 360] as const) {
    for (const today of ["2026-01-01", "2024-03-01"]) {
      const start = rangeStart(`${days}d`, today)!;
      expect((Date.parse(today) - Date.parse(start)) / 86_400_000 + 1).toBe(days);
    }
  }
  expect(rangeStart("all", "2026-10-07")).toBeNull();
});

test("a period sums each model's totals again from its kept days and drops a model without calls in it", () => {
  const fast = { calls: 10, timed_calls: 10, timed_out: 10_000, timed_ms: 100_000, long_calls: 10, long_out: 10_000, long_ms: 100_000 };
  const slow = { calls: 20, timed_calls: 10, timed_out: 1_000, timed_ms: 100_000, long_calls: 0, long_out: 0, long_ms: 0 };
  const entries = mergeSpeedParts([{ account: "a", models: [
    series("new", [day("2026-08-01", fast), day("2026-10-01", slow)]),
    series("old", [day("2026-08-01", fast)]),
  ] }], false);
  const [kept, ...rest] = entriesSince(entries, "2026-09-08");
  expect(rest).toEqual([]);
  expect(kept!.series.points.map(point => point.at)).toEqual(["2026-10-01"]);
  expect(kept!.series.total).toMatchObject({ calls: 20, timed_calls: 10, coverage: 0.5, long_speed: null });
  expect(kept!.series.total.speed).toBeCloseTo(10);
  expect(modelTotals(kept!.series)).toMatchObject({ calls: 20, first: "2026-10-01", last: "2026-10-01" });
  // The whole history keeps the entries untouched.
  expect(entriesSince(entries, null)).toEqual(entries);
});
