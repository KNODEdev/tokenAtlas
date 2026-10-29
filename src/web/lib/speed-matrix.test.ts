import { expect, test } from "bun:test";
import {
  compareChoices, compareSeries, effortColumn, executionStroke, fastPairPicks, fastestPicks, isNewRow, matrixLayout, modelInks, orderEfforts, topPicks,
} from "./speed-matrix";
import type { ModelSpeedSeries } from "./model-speed";

const series = (speed: string | undefined, effort: string | null = null) =>
  ({ model: "m", total: {} as ModelSpeedSeries["total"], points: [], ...(speed === undefined ? {} : { speed, effort }) }) as ModelSpeedSeries;
const item = (key: string, name: string, speed: string | undefined, effort: string | null, calls: number) =>
  ({ key, name, model: name, series: series(speed, effort), calls });

test("efforts run from shallow to deep, then unknown and unrecorded", () => {
  expect(orderEfforts(["max", "?", "ultra", "low", "-", "xhigh", "medium"])).toEqual(["low", "medium", "xhigh", "max", "ultra", "?", "-"]);
  expect(effortColumn(series(undefined))).toBe("-");
  expect(effortColumn(series("fast", null))).toBe("?");
});

test("the matrix groups series into model rows per speed mode, standard first, busiest rows first", () => {
  const layout = matrixLayout([item("a", "sol", "standard", "high", 10), item("b", "sol", "standard", "max", 5), item("c", "sol", "fast", "high", 3),
    item("d", "luna", "standard", "low", 40), item("e", "claude", undefined, null, 1)]);
  expect(layout.columns).toEqual(["low", "high", "max", "-"]);
  expect(layout.sections.map(group => [group.section, group.rows.map(row => `${row.name}:${[...row.cells.keys()].join(",")}`)])).toEqual([
    ["standard", ["luna:low", "sol:high,max", "claude:-"]], ["fast", ["sol:high"]]]);
});

test("the top preset takes the busiest series of the four busiest models and the busiest fast one", () => {
  const items = [item("a1", "sol", "standard", "high", 50), item("a2", "sol", "standard", "low", 60), item("b", "luna", "standard", "high", 100),
    item("c", "astra", "standard", "high", 30), item("d", "terra", "standard", "high", 20), item("e", "reserve", "standard", "high", 5),
    item("f1", "sol", "fast", "high", 9), item("f2", "luna", "fast", "high", 3)];
  expect([...topPicks(items)]).toEqual(["a2", "b", "c", "d", "f1"]);
  expect([...topPicks(items.slice(0, 2))]).toEqual(["a2"]);
});

test("the fastest preset follows the metric's direction and fast pairs keep their standard twin", () => {
  const items = [item("a", "sol", "standard", "high", 1), item("b", "sol", "fast", "high", 1), item("c", "luna", "standard", "low", 1), item("d", "luna", "fast", "high", 1)];
  const values: Record<string, number | null> = { a: 30, b: 70, c: 50, d: null };
  expect([...fastestPicks(items, key => values[key]!, true)]).toEqual(["b", "c", "a"]);
  expect([...fastestPicks(items, key => values[key]!, false)]).toEqual(["a", "c", "b"]);
  expect([...fastPairPicks(items)]).toEqual(["b", "a", "d"]);
});

test("a comparison shows one model's executions or one effort across models", () => {
  const items = [item("a", "sol", "standard", "high", 9), item("b", "sol", "fast", "high", 1), item("c", "sol", "standard", "low", 1), item("d", "luna", "standard", "high", 20),
    item("u", "sol", "unknown:old", "high", 4)];
  expect(compareSeries(items, "model", "sol", true).map(entry => entry.key)).toEqual(["a", "b", "c"]);
  expect(compareSeries(items, "effort", "high", false).map(entry => entry.key)).toEqual(["a", "d"]);
  expect(compareChoices(items.slice(0, 4))).toEqual({ models: ["luna", "sol"], efforts: ["low", "high"] });
});

test("a row is new within a week of its first call", () => {
  expect(isNewRow("2026-10-24", "2026-10-29")).toBe(true);
  expect(isNewRow("2026-10-22", "2026-10-29")).toBe(false);
  expect(isNewRow(null, "2026-10-29")).toBe(false);
});

test("models of one vendor take turned hues; effort sets lightness and the speed mode the pattern", () => {
  const inks = modelInks(["gpt-a", "gpt-b", "gpt-a"]);
  expect(inks.get("gpt-a")).toBe("var(--codex)");
  expect(inks.get("gpt-b")).toBe("oklch(from var(--codex) l c calc(h + 150))");
  // Vendors mixed: models stay near their vendor's hue.
  expect(modelInks(["gpt-a", "gpt-b", "claude-x"]).get("gpt-b")).toBe("oklch(from var(--codex) l c calc(h - 24))");
  expect(executionStroke("var(--codex)", series("standard", "high"))).toEqual({ color: "var(--codex)", dash: undefined });
  expect(executionStroke("var(--codex)", series("fast", "max"))).toEqual({ color: "oklch(from var(--codex) clamp(0.32, calc(l - 0.16), 0.92) c h)", dash: "5 3" });
  expect(executionStroke("var(--codex)", series("mixed", null)).color).toContain("calc(c * 0.35)");
  expect(executionStroke("var(--codex)", series("mixed", null)).dash).toBe("1.5 3");
  // One model alone on the chart: wider steps.
  expect(executionStroke("var(--codex)", series("standard", "max"), 1.8).color).toContain("calc(l - 0.288)");
});
