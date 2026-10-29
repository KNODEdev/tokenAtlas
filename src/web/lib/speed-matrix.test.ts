import { expect, test } from "bun:test";
import { defaultHidden, effortColumn, executionStroke, fastHidden, isNewRow, matrixLayout, modelInks, orderEfforts } from "./speed-matrix";
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

test("many series start as the busiest standard ones and every fast one", () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`s${i}`, `m${i}`, "standard", "high", 100 - i));
  expect(defaultHidden(items).size).toBe(0);
  items.push(item("f", "fast", "fast", "high", 1));
  expect([...defaultHidden(items)].sort()).toEqual(["s10", "s11", "s8", "s9"]);
  expect(defaultHidden(items.slice(0, 9), 0)).toEqual(new Set(["s8"]));
  expect(fastHidden(items).has("f")).toBe(false);
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
});
