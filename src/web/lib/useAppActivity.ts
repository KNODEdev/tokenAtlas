import { useSyncExternalStore } from "react";
import type { AppActivity } from "../../shared/app-activity";
import { refreshApiData } from "./api";

interface ActivityState { data: AppActivity | null; unavailable: boolean }
const INITIAL: ActivityState = { data: null, unavailable: false };

// One poll for every reader (the status bar and the cards that mark their figures as updating).
let state = INITIAL;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let request: AbortController | null = null;
let previouslyBusy = false;

function publish(next: ActivityState) {
  state = next;
  for (const listener of listeners) listener();
}

async function poll() {
  if (request) return;
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    // Status must not enter the prepared-report retry loop it is observing.
    const response = await fetch("/api/app-activity", { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("Activity unavailable");
    const data: AppActivity = await response.json();
    if (!listeners.size) return;
    publish({ data, unavailable: false });
    if (!data.unavailable) {
      if (previouslyBusy && !data.busy) refreshApiData();
      previouslyBusy = data.busy;
    }
  } catch {
    if (listeners.size) publish({ ...state, unavailable: true });
  } finally {
    clearTimeout(timeout);
    if (request === controller) request = null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void poll();
    timer = setInterval(() => void poll(), 2000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    // The last reader left: stop polling and forget the state, as an unmounted hook did.
    if (timer) clearInterval(timer);
    timer = null;
    request?.abort();
    request = null;
    previouslyBusy = false;
    state = INITIAL;
  };
}

const snapshot = () => state;

export function useAppActivity(): ActivityState {
  return useSyncExternalStore(subscribe, snapshot, () => INITIAL);
}
