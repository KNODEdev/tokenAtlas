import { useEffect, useState } from "react";
import type { AppActivity } from "../../shared/app-activity";
import { refreshApiData } from "./api";

export function useAppActivity() {
  const [state, setState] = useState<{ data: AppActivity | null; unavailable: boolean }>({ data: null, unavailable: false });
  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    let previouslyBusy = false;
    const poll = async () => {
      if (request) return;
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        // Status must not enter the prepared-report retry loop it is observing.
        const response = await fetch("/api/app-activity", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Activity unavailable");
        const data: AppActivity = await response.json();
        if (!active) return;
        setState({ data, unavailable: false });
        if (!data.unavailable) {
          if (previouslyBusy && !data.busy) refreshApiData();
          previouslyBusy = data.busy;
        }
      } catch {
        if (active) setState(previous => ({ ...previous, unavailable: true }));
      } finally {
        clearTimeout(timeout);
        request = null;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { active = false; clearInterval(timer); request?.abort(); };
  }, []);
  return state;
}
