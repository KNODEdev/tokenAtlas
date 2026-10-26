import { useEffect, useState } from "react";
import { api, onApiRefresh, refreshApiData, type AnalysisRebuildJob } from "./api";

export function useRebuildStatus() {
  const [status, setStatus] = useState<{ job: AnalysisRebuildJob | null; unavailable: boolean }>({
    job: null, unavailable: false,
  });
  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    let observedGeneration: number | null = null;
    const poll = async () => {
      if (request) return;
      const controller = new AbortController();
      request = controller;
      const deadline = setTimeout(() => controller.abort(), 5000);
      try {
        const { job } = await api.analysisRebuildStatus(controller.signal);
        if (!active) return;
        setStatus({ job, unavailable: false });
        if (job?.state === "queued" || job?.state === "running") observedGeneration = job.generation;
        else if (job?.state === "complete" && job.generation === observedGeneration) {
          observedGeneration = null;
          refreshApiData();
        }
      } catch {
        if (active) setStatus(previous => ({ ...previous, unavailable: true }));
      } finally {
        clearTimeout(deadline);
        request = null;
      }
    };
    void poll();
    // Progress must remain observable while report requests are still preparing.
    const timer = setInterval(() => void poll(), 2000);
    const unsubscribe = onApiRefresh(() => void poll());
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe();
      request?.abort();
    };
  }, []);
  return status;
}
