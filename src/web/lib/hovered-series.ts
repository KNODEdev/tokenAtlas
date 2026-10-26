import { useSyncExternalStore } from "react";

// One hovered series per chart scope, so a table row lights up its series in every chart of the same window,
// even when the charts sit in different parts of the screen.
let current: { scope: string; key: string } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

const publish = (next: typeof current) => {
  if (next?.scope === current?.scope && next?.key === current?.key) return;
  current = next;
  listeners.forEach(listener => listener());
};
export const setHoveredSeries = (scope: string, key: string) => publish({ scope, key });
/** Clears the hover only while it is still this one (or any in the scope without a key), so a late blur keeps a newer hover. */
export function clearHoveredSeries(scope: string, key?: string) {
  if (current?.scope === scope && (key === undefined || current.key === key)) publish(null);
}

export function useHoveredSeries(scope: string): string | null {
  return useSyncExternalStore(subscribe, () => current?.scope === scope ? current.key : null, () => null);
}

/** Pointer and keyboard focus handlers that mark one series as hovered while they last. */
export function hoverSeries(scope: string, key: string) {
  const enter = () => setHoveredSeries(scope, key), leave = () => clearHoveredSeries(scope, key);
  return { onMouseEnter: enter, onMouseLeave: leave, onFocus: enter, onBlur: leave };
}
