/**
 * The Speed legend as a matrix (docs/design/mockups/speed-legend-matrix.html, approved 2026-10-29): a row per model and
 * speed mode, a column per reasoning effort, one cell per series. Colour says the model, lightness the effort and the
 * line pattern the speed mode, so ~60 execution variants stay readable.
 */
import type { ModelSpeedSeries } from "./model-speed";
import { modelVendor, vendorColor } from "./model-colors";

/** Efforts in increasing depth; anything else follows in name order, then the unknown and the unrecorded column. */
export const EFFORT_ORDER: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/** A recorded execution without an effort. */
export const UNKNOWN_EFFORT = "?";
/** A provider that records no execution settings at all (Claude): its models fill one column. */
export const NO_EXECUTION = "-";

export function effortColumn(series: Pick<ModelSpeedSeries, "speed" | "effort">): string {
  return series.speed === undefined ? NO_EXECUTION : series.effort ?? UNKNOWN_EFFORT;
}
export function orderEfforts(columns: Iterable<string>): string[] {
  const rank = (column: string) => column === NO_EXECUTION ? 1e6 + 1 : column === UNKNOWN_EFFORT ? 1e6
    : EFFORT_ORDER.includes(column) ? EFFORT_ORDER.indexOf(column) : EFFORT_ORDER.length;
  return [...new Set(columns)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
/** The section of a series: standard (or no recorded mode) first, then fast, then mixed and unknown modes. */
export function speedSection(series: Pick<ModelSpeedSeries, "speed">): string {
  return series.speed === undefined || series.speed === "standard" ? "standard" : series.speed;
}
export function orderSections(sections: Iterable<string>): string[] {
  const rank = (section: string) => section === "standard" ? 0 : section === "fast" ? 1 : section === "mixed" ? 2 : 3;
  return [...new Set(sections)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface MatrixSeries { key: string; name: string; model: string; series: ModelSpeedSeries; calls: number }
export interface MatrixRow<T extends MatrixSeries> { id: string; name: string; model: string; section: string; calls: number; cells: Map<string, T> }
export interface MatrixLayout<T extends MatrixSeries> { columns: string[]; sections: { section: string; rows: MatrixRow<T>[] }[] }

/** Rows by name within each section, busiest first; columns are the efforts any row has. */
export function matrixLayout<T extends MatrixSeries>(items: readonly T[]): MatrixLayout<T> {
  const rows = new Map<string, MatrixRow<T>>();
  for (const item of items) {
    const section = speedSection(item.series), id = JSON.stringify([section, item.name]);
    const row = rows.get(id) ?? { id, name: item.name, model: item.model, section, calls: 0, cells: new Map<string, T>() };
    row.cells.set(effortColumn(item.series), item);
    row.calls += item.calls;
    rows.set(id, row);
  }
  const list = [...rows.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  return {
    columns: orderEfforts(items.map(item => effortColumn(item.series))),
    sections: orderSections(list.map(row => row.section)).map(section => ({ section, rows: list.filter(row => row.section === section) })),
  };
}

/*
 * The chart shows a few picked series (docs/design/mockups/speed-series-picker.html, approved 2026-10-29). More than
 * PICK_LIMIT is allowed but warned about; the presets pick PRESET_SIZE.
 */
export const PICK_LIMIT = 8, PRESET_SIZE = 5, TOP_MODELS = 4;
type Pickable = Pick<MatrixSeries, "key" | "name" | "series" | "calls">;
const busiest = <T extends Pickable>(items: readonly T[]) => [...items].sort((a, b) => b.calls - a.calls);
/** Top: the busiest series of each of the busiest standard models, plus the busiest fast series. */
export function topPicks(items: readonly Pickable[]): Set<string> {
  const standard = items.filter(item => speedSection(item.series) === "standard"), byName = new Map<string, number>();
  for (const item of standard) byName.set(item.name, (byName.get(item.name) ?? 0) + item.calls);
  const names = [...byName].sort((a, b) => b[1] - a[1]).slice(0, TOP_MODELS).map(([name]) => name);
  const picks = names.map(name => busiest(standard.filter(item => item.name === name))[0]!.key);
  const fast = busiest(items.filter(item => item.series.speed === "fast"))[0];
  return new Set(fast ? [...picks, fast.key] : picks);
}
/** The fastest series by the shown metric; `higherIsFaster` is true for tok/s, false for first-token seconds. */
export function fastestPicks(items: readonly Pickable[], value: (key: string) => number | null, higherIsFaster: boolean): Set<string> {
  const valued = items.flatMap(item => { const v = value(item.key); return v === null ? [] : [{ key: item.key, v }]; });
  return new Set(valued.sort((a, b) => higherIsFaster ? b.v - a.v : a.v - b.v).slice(0, PRESET_SIZE).map(item => item.key));
}
/** Each fast series beside its standard counterpart (same model and effort), when there is one. */
export function fastPairPicks(items: readonly Pickable[]): Set<string> {
  const picks = new Set<string>();
  for (const fast of items.filter(item => item.series.speed === "fast")) {
    picks.add(fast.key);
    const twin = items.find(item => item.name === fast.name && speedSection(item.series) === "standard" && effortColumn(item.series) === effortColumn(fast.series));
    if (twin) picks.add(twin.key);
  }
  return picks;
}

/**
 * What the chart compares: the picked series, every execution of one model, or one effort across models. Comparisons
 * keep standard and (optionally) fast; older calls of an unknown or mixed mode are picked in the drawer instead.
 */
export type SpeedCompare = "custom" | "model" | "effort";
export function compareSeries<T extends Pickable>(items: readonly T[], compare: Exclude<SpeedCompare, "custom">, choice: string, withFast: boolean): T[] {
  return items.filter(item => (compare === "model" ? item.name === choice : effortColumn(item.series) === choice)
    && (speedSection(item.series) === "standard" || withFast && speedSection(item.series) === "fast"));
}
/** Models in order of calls, and the effort columns present, for the two comparison choices. */
export function compareChoices(items: readonly Pickable[]): { models: string[]; efforts: string[] } {
  const byName = new Map<string, number>();
  for (const item of items) byName.set(item.name, (byName.get(item.name) ?? 0) + item.calls);
  return { models: [...byName].sort((a, b) => b[1] - a[1]).map(([name]) => name), efforts: orderEfforts(items.map(item => effortColumn(item.series))) };
}

/** A row whose first call (in the whole history) is this recent is marked new. */
export const NEW_ROW_DAYS = 7;
export function isNewRow(firstDay: string | null, today: string): boolean {
  return firstDay !== null && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`) < NEW_ROW_DAYS * 86_400_000;
}

// Hue turns per model of one vendor: far apart when one vendor fills the chart, near its own hue when vendors mix.
const SPREAD_TURNS = [0, 150, 60, 210, 270, 30, 110, 320, 180, 240, 90, 300];
const NEAR_TURNS = [0, -24, 24, -48, 48, -12, 12, -36, 36];
// Deeper effort is darker; the clamp keeps grey xAI and the dark theme's light inks apart.
const EFFORT_LIGHTNESS: Readonly<Record<string, number>> = { none: 0.22, minimal: 0.2, low: 0.15, medium: 0.07, high: 0, xhigh: -0.08, max: -0.16 };
const FAST_DASH = "5 3", OTHER_MODE_DASH = "1.5 3";
const signed = (value: number) => `${value < 0 ? "-" : "+"} ${Math.abs(value)}`;

/** The base ink of a model: its vendor's hue turned by the model's rank within that vendor. */
export function modelInks(models: readonly string[]): Map<string, string> {
  const vendors = new Set(models.map(model => modelVendor(model) ?? ""));
  const turns = vendors.size > 1 ? NEAR_TURNS : SPREAD_TURNS, seen = new Map<string, number>(), inks = new Map<string, string>();
  for (const model of models) {
    if (inks.has(model)) continue;
    const vendor = modelVendor(model) ?? "", base = vendorColor(vendor) ?? "var(--violet)";
    const rank = seen.get(vendor) ?? 0;
    seen.set(vendor, rank + 1);
    const turn = turns[rank % turns.length]!;
    inks.set(model, turn === 0 ? base : `oklch(from ${base} l c calc(h ${signed(turn)}))`);
  }
  return inks;
}
/**
 * Colour and dash per series: the model's ink, lighter for shallow and darker for deep effort; fast dashed, other modes
 * dotted. `spread` widens the lightness steps when one model's efforts fill the chart alone.
 */
export function executionStroke(ink: string, series: Pick<ModelSpeedSeries, "speed" | "effort">, spread = 1): { color: string; dash: string | undefined } {
  const column = effortColumn(series);
  const step = +((EFFORT_LIGHTNESS[column] ?? 0) * spread).toFixed(3), muted = column === UNKNOWN_EFFORT;
  const color = step === 0 && !muted ? ink : `oklch(from ${ink} clamp(0.32, calc(l ${signed(step)}), 0.92) ${muted ? "calc(c * 0.35)" : "c"} h)`;
  const section = speedSection(series);
  return { color, dash: section === "standard" ? undefined : section === "fast" ? FAST_DASH : OTHER_MODE_DASH };
}
