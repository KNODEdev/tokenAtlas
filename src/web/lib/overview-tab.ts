/**
 * The Overview reopens the tab stored under this key (VendorOverview.tsx, TAB_KEY). Writing it
 * before navigating is how another screen opens a given tab without changing the approved Overview.
 */
export const OVERVIEW_TAB_KEY = "tokenatlas.overview-tab.v1";

export function chooseOverviewTab(tab: "forecast" | "models" | "projects" | "history" | "data"): void {
  try { localStorage.setItem(OVERVIEW_TAB_KEY, tab); } catch { /* Storage may be unavailable; the Overview then opens its default tab. */ }
}
