import type { CodexComparisonWindow, TimelineMarker } from "../../shared/codex-accounting";

/** Match public confirmations to observed zero/reset boundaries, never to a partial sample's first traffic. */
export function alignProviderResetMarkers(markers: TimelineMarker[], windows: readonly CodexComparisonWindow[]): TimelineMarker[] {
  const boundaries = windows.filter(window => !window.manual_measurement && window.cycle_start && window.start_percent === 0
    && (window.start_basis === "reset" || window.start_basis === "zero_reading" && !windows.some(previous => previous.id !== window.id
      && previous.reset === window.reset && Date.parse(previous.cycle_start ?? previous.start) < Date.parse(window.cycle_start!))));
  const candidates = markers.filter(marker => marker.id.startsWith("reset:")).flatMap(marker => {
    const confirmation = Date.parse(marker.observed_at ?? "");
    return boundaries.flatMap(window => {
      const distance = Math.abs(Date.parse(window.cycle_start!) - confirmation);
      return distance <= 12 * 60 * 60 * 1000 ? [{ marker, window, distance }] : [];
    });
  }).sort((a, b) => a.distance - b.distance);
  const matches = new Map<string, CodexComparisonWindow>(), used = new Set<string>();
  for (const { marker, window } of candidates) {
    if (matches.has(marker.id) || used.has(window.id)) continue;
    matches.set(marker.id, window); used.add(window.id);
  }
  return markers.map(marker => {
    if (!marker.id.startsWith("reset:")) return marker;
    const { reset_boundary: _previous, ...original } = marker;
    const window = matches.get(marker.id);
    return window ? { ...original, day: window.cycle_start!.slice(0, 10), reset_boundary: { cycle_id: window.id, at: window.cycle_start! } }
      : { ...original, day: original.observed_at?.slice(0, 10) ?? original.day, reset_boundary: null };
  });
}
