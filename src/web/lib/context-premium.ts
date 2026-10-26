import { useSyncExternalStore } from "react";
import type { ScreenId } from "./screens";
import type { ContextPreviewStatus } from "../../shared/context-preview";

const CONTEXT_PREVIEW_SCREENS: ReadonlySet<ScreenId> = new Set(["capacity", "plans", "model-traffic", "history",
  "usage", "usage-history", "usage-pace", "structure", "structure-models", "events", "models", "periods", "shares"]);

export function contextPreviewAppliesTo(screen: ScreenId): boolean {
  return CONTEXT_PREVIEW_SCREENS.has(screen);
}

/**
 * The app-wide "OpenAI context in price" preview (user, 2026-10-21): on, supported screens' API values add OpenAI's
 * long-context uplift, so charts show what the paid API would have charged next to the recorded value. It is a view
 * only: nothing is saved, no setting changes and nothing is recalculated. It always starts off and is not remembered.
 */
let previewOn = false;
const listeners = new Set<() => void>();

export function setContextPreview(on: boolean): void {
  if (previewOn === on) return;
  previewOn = on;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => previewOn;

export function useContextPreview(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

type Coverage = "preparing" | "missing" | null;
const coverageByView = new Map<string, Coverage>();
const coverageListeners = new Set<() => void>();
let coverage: Coverage = null;
/** Only the report or its transport envelope; never walk event/window details to discover status. */
function coverageOf(body: unknown): Coverage {
  if (!body || typeof body !== "object") return null;
  const status = (body as {context_preview_status?:ContextPreviewStatus}).context_preview_status;
  if (status) return !status.ready ? "preparing" : status.missing_groups > 0 ? "missing" : null;
  const children = body instanceof Map ? [...body.values()] : Array.isArray(body) ? body : Object.entries(body).filter(([key]) => ["value", "data", "payload", "report", "samples"].includes(key)).map(([, value]) => value);
  const values = children.map(coverageOf);
  return values.includes("preparing") ? "preparing" : values.includes("missing") ? "missing" : null;
}
export function visibleContextCoverage(id: string, body: unknown): void {
  const value = coverageOf(body);
  if (value === null) coverageByView.delete(id); else coverageByView.set(id, value);
  const values = [...coverageByView.values()];
  const next = values.includes("preparing") ? "preparing" : values.includes("missing") ? "missing" : null;
  if (next === coverage) return;
  coverage = next; for (const listener of coverageListeners) listener();
}
export function useContextPreviewCoverage(): Coverage {
  return useSyncExternalStore(listener => { coverageListeners.add(listener); return () => { coverageListeners.delete(listener); }; }, () => coverage, () => null);
}
