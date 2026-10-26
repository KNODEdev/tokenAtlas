import { createContext, useContext, useEffect, useId, useState } from "react";
import { apiReadsAffected, onApiRefresh, trackApiReads } from "./api/transport";
import { hasContextCompanion, hasContextCompanionPath, readContextCompanion } from "./context-companion";
import { contextPreviewAppliesTo, useContextPreview, visibleContextCoverage } from "./context-premium";
import { responseWithContextPreview } from "../../shared/context-preview";
import { markReportStale, staleReportTime } from "./report-freshness";
import type { ScreenId } from "./screens";

export const ContextReportScreen = createContext<ScreenId | null>(null);
const PARTIAL_SCREENS = new Set<ScreenId>(["overview", "projects", "settings"]);
/** Lazy companion reads have their own signal/cache dependency; the stored report is never refetched by the switch. */
export function useContextCompanion<T>(stored: T): { data: T; loading: boolean; error: string | null } {
  const on = useContextPreview(), screen = useContext(ContextReportScreen), id = useId();
  const enabled = on && screen !== null && (contextPreviewAppliesTo(screen) || PARTIAL_SCREENS.has(screen)) && hasContextCompanion(stored)
    && (screen !== "settings" || hasContextCompanionPath(stored, "/api/plan-capacity"));
  const [answer, setAnswer] = useState<{ stored: T; body?: T; error?: string; loading: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(), stop = trackApiReads(controller.signal);
    const unsubscribe = onApiRefresh(change => {
      if (apiReadsAffected(controller.signal, change)) setNonce(n => n + 1);
    });
    setAnswer({ stored, loading: true });
    readContextCompanion(stored, controller.signal).then(body => {
      if (controller.signal.aborted) return;
      setAnswer({ stored, body, loading: false });
    }, error => {
      if (!controller.signal.aborted) setAnswer({ stored, error: error instanceof Error ? error.message : String(error), loading: false });
    });
    return () => { unsubscribe(); stop(); controller.abort(); };
  }, [enabled, stored, nonce]);
  const current = enabled && answer?.stored === stored ? answer : null;
  const loading = enabled && (!current || current.loading);
  const body = current?.body;
  useEffect(() => {
    // A context projection can finish independently of the default report's dependencies.
    if (!enabled || !contextPreparing(body)) return;
    const timer = setTimeout(() => setNonce(n => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [enabled, body]);
  useEffect(() => {
    visibleContextCoverage(id, enabled ? body ?? { context_preview_status: { ready: false, revision: 0, missing_groups: 0 } } : null);
    return () => visibleContextCoverage(id, null);
  }, [id, enabled, body]);
  const data = enabled && body ? responseWithContextPreview(body, true) : stored;
  const preparedAt = staleReportTime(stored);
  if (preparedAt !== null && data !== stored) markReportStale(data, preparedAt);
  return { data, loading, error: current?.error ?? null };
}
function contextPreparing(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if(body instanceof Map)return [...body.values()].some(contextPreparing);
  if ("context_preview_status" in body) return !(body.context_preview_status as { ready: boolean }).ready;
  return Object.entries(body).some(([key, child]) => (Array.isArray(body) || ["value", "data", "payload", "report", "samples"].includes(key)) && contextPreparing(child));
}
