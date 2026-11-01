import { useEffect, useState } from "react";
export type Breakpoint = "mobile" | "tablet" | "desktop";
const TABLET_MAX = 1180;
const MOBILE_MAX = 820;
function read(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth;
  if (w <= MOBILE_MAX) return "mobile";
  if (w <= TABLET_MAX) return "tablet";
  return "desktop";
}
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(read);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBp(read()));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return bp;
}
export const NAV_W = 204;
export const NAV_W_COLLAPSED = 60;
export const SUBS_RAIL_W = 296;
/** The subscription rail on a smaller desktop screen: name, account, percentage, pace and meter only. */
export const SUBS_RAIL_COMPACT_W = 208;
export const WINDOW_RAIL_W = 176;
const CONTENT_MIN = 900;
const RAIL_MIN = 1400;
// Below this the subscription is picked in the screen header's selector alone.
const RAIL_COMPACT_MIN = 1100;
export type RailMode = "full" | "compact" | "none";
/** How much of the subscription rail fits: the full rail, its compact form, or none. */
export function useRailMode(): RailMode {
  const width = useViewportWidth();
  return width >= RAIL_MIN ? "full" : width >= RAIL_COMPACT_MIN ? "compact" : "none";
}
export type RailPreference = "full" | "compact";
const RAIL_PREFERENCE_KEY = "tokenatlas.subscription-rail.v1";
/**
 * The user's choice wins only where the window has room for both forms (TALK-001 D8): a narrower window
 * still compacts or hides the rail, and widening it brings the saved choice back.
 */
export function resolveRailMode(viewport: RailMode, preferred: RailPreference): RailMode {
  return viewport === "full" && preferred === "compact" ? "compact" : viewport;
}
function readRailPreference(): RailPreference {
  try { return localStorage.getItem(RAIL_PREFERENCE_KEY) === "compact" ? "compact" : "full"; } catch { return "full"; }
}
/** The saved full/compact choice of the subscription rail on this computer. */
export function useRailPreference(): [RailPreference, (next: RailPreference) => void] {
  const [preferred, setPreferred] = useState<RailPreference>(readRailPreference);
  const save = (next: RailPreference) => {
    setPreferred(next);
    try { localStorage.setItem(RAIL_PREFERENCE_KEY, next); } catch { /* Storage can be unavailable. */ }
  };
  return [preferred, save];
}
export function useRailRoom(): boolean {
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= RAIL_MIN));
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWide(window.innerWidth >= RAIL_MIN));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return wide;
}
export function splitColumns(bp: Breakpoint, wide = "1.55fr"): string {
  return bp === "desktop" ? `minmax(0,${wide}) minmax(0,1fr)` : "minmax(0,1fr)";
}
export function useWindowRailRoom(navWidth: number, subsWidth: number): boolean {
  const width = useViewportWidth();
  return width - navWidth - subsWidth - WINDOW_RAIL_W >= CONTENT_MIN;
}
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1920 : window.innerWidth));
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return width;
}
