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

/** Shown by default when a scope has nothing stored and more series than this: the busiest standard ones and every fast one. */
export const DEFAULT_VISIBLE = 8, DEFAULT_PRESET_FROM = 12;
export function defaultHidden(items: readonly Pick<MatrixSeries, "key" | "series" | "calls">[], from = DEFAULT_PRESET_FROM): Set<string> {
  if (items.length <= from) return new Set();
  const shown = new Set([...items].filter(item => speedSection(item.series) === "standard").sort((a, b) => b.calls - a.calls)
    .slice(0, DEFAULT_VISIBLE).map(item => item.key));
  for (const item of items) if (item.series.speed === "fast") shown.add(item.key);
  return new Set(items.filter(item => !shown.has(item.key)).map(item => item.key));
}
export function fastHidden(items: readonly Pick<MatrixSeries, "key" | "series">[]): Set<string> {
  return new Set(items.filter(item => item.series.speed !== "fast").map(item => item.key));
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
/** Colour and dash per series: the model's ink, lighter for shallow and darker for deep effort; fast dashed, other modes dotted. */
export function executionStroke(ink: string, series: Pick<ModelSpeedSeries, "speed" | "effort">): { color: string; dash: string | undefined } {
  const column = effortColumn(series);
  const step = EFFORT_LIGHTNESS[column] ?? 0, muted = column === UNKNOWN_EFFORT;
  const color = step === 0 && !muted ? ink : `oklch(from ${ink} clamp(0.32, calc(l ${signed(step)}), 0.92) ${muted ? "calc(c * 0.35)" : "c"} h)`;
  const section = speedSection(series);
  return { color, dash: section === "standard" ? undefined : section === "fast" ? FAST_DASH : OTHER_MODE_DASH };
}
