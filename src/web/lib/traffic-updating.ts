import type { ActivityProviderId } from "../../shared/app-activity";
import type { ProgressEntry } from "../../shared/progress";
import { useAppActivity } from "./useAppActivity";

/**
 * True while a background producer is changing the indexed traffic of this provider's windows: its usage ledger
 * is applying changes, or the window sums that follow the ledgers are being counted. A running synchronization
 * alone does not count: it mostly finds nothing new.
 */
export function trafficUpdating(progress: readonly Pick<ProgressEntry, "scope">[] | null | undefined, provider: ActivityProviderId): boolean {
  return (progress ?? []).some(({ scope }) => scope === `usage-ledger:${provider}` || scope === "window-usage"
    || (provider === "codex" && scope === "codex-ledger"));
}

/** The window card's figures for this provider are still being brought up to date. */
export function useTrafficUpdating(provider: ActivityProviderId): boolean {
  return trafficUpdating(useAppActivity().data?.progress, provider);
}
