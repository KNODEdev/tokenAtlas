import type { TimelineMarker } from "../../shared/codex-accounting";

export const CAPACITY_MARKER_TYPES = ["reset", "promotion", "price", "model", "event"] as const;
export type CapacityMarkerType = typeof CAPACITY_MARKER_TYPES[number];

const STORAGE_KEY = "tokenAtlas.capacityChartMarkers.v1";

/** Classify individual markers before same-day chart points are grouped. */
export function capacityMarkerType(marker: TimelineMarker): CapacityMarkerType {
  if (marker.id.startsWith("reset:")) return "reset";
  if (marker.id.startsWith("promotion:")) return "promotion";
  if (marker.id.startsWith("model:")) return "model";
  return marker.id.startsWith("price") || marker.pricing?.length ? "price" : "event";
}

export function readCapacityMarkerTypes(): readonly CapacityMarkerType[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (Array.isArray(value) && value.every(type => CAPACITY_MARKER_TYPES.includes(type)))
      return CAPACITY_MARKER_TYPES.filter(type => value.includes(type));
  } catch { /* Browser storage is optional; show every type by default. */ }
  return CAPACITY_MARKER_TYPES;
}

export function writeCapacityMarkerTypes(types: readonly CapacityMarkerType[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(types)); }
  catch { /* The current chart still keeps its choice in memory. */ }
}
