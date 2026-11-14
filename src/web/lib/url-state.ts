import { useEffect } from "react";
import { isScreenId, type ScreenId } from "./screens";

/** What the address keeps: the open view and the selected subscription (`#/usage?account=codex1`). */
export interface UrlState { screen: ScreenId | null; account: string | null }

export function parseHash(hash: string): UrlState {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const account = new URLSearchParams(query).get("account");
  return { screen: isScreenId(path) ? path : null, account: account?.trim() ? account : null };
}

export function formatHash(screen: ScreenId, account: string): string {
  return `#/${screen}${account ? `?${new URLSearchParams({ account })}` : ""}`;
}

/** False outside a browser and in a test DOM without an address or a history. */
function hasAddress(): boolean {
  return typeof location !== "undefined" && typeof location.hash === "string"
    && typeof history !== "undefined" && typeof history.replaceState === "function";
}

/** The address the page was opened with; empty outside a browser. */
export function initialUrlState(): UrlState {
  return hasAddress() ? parseHash(location.hash) : { screen: null, account: null };
}

/**
 * Keeps the address in step with the open view and subscription, so a reload returns to the same place and
 * Back/Forward move between views. A new view is a history step; another subscription on the same view is not.
 */
export function useUrlState(screen: ScreenId, account: string, apply: (state: UrlState) => void): void {
  useEffect(() => {
    if (!hasAddress()) return;
    const next = formatHash(screen, account);
    if (location.hash === next) return;
    const current = parseHash(location.hash);
    // The first address of a visit and a change of subscription replace the entry instead of adding one.
    if (current.screen === null || current.screen === screen) history.replaceState(history.state, "", next);
    else history.pushState(history.state, "", next);
  }, [screen, account]);
  useEffect(() => {
    if (!hasAddress()) return;
    const onChange = () => apply(parseHash(location.hash));
    window.addEventListener("popstate", onChange);
    window.addEventListener("hashchange", onChange);
    return () => { window.removeEventListener("popstate", onChange); window.removeEventListener("hashchange", onChange); };
  }, [apply]);
}
