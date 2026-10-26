import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, onApiRefresh, type AnalysisRebuildJob } from "./api";
import { installTestDom } from "./test-dom-harness";
import { useRebuildStatus } from "./useRebuildStatus";

test("rebuild polling restores progress, survives a failed poll, and refreshes completed data once", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let tick = () => {};
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return 1; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let resolve!: (value: {job: AnalysisRebuildJob | null}) => void;
  let reject!: (cause: Error) => void;
  let signal: AbortSignal | undefined;
  const status = spyOn(api, "analysisRebuildStatus").mockImplementation(nextSignal => {
    signal = nextSignal;
    return new Promise((yes, no) => { resolve = yes; reject = no; });
  });
  let refreshes = 0;
  const unsubscribe = onApiRefresh(() => { refreshes++; });
  function View() {
    const state = useRebuildStatus();
    return <div>{JSON.stringify(state)}</div>;
  }
  const job: AnalysisRebuildJob = { generation: 9, state: "running", phase: "reports", completed: 4, total: 10,
    scope: "all", range: null, error: null };
  try {
    await act(async () => root.render(<View />));
    await act(async () => { tick(); tick(); });
    expect(status).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ job }));
    expect(dom.host.textContent).toContain('"completed":4');
    await act(async () => tick());
    await act(async () => reject(new Error("offline")));
    expect(dom.host.textContent).toContain('"unavailable":true');
    expect(dom.host.textContent).toContain('"completed":4');
    await act(async () => tick());
    await act(async () => resolve({ job: { ...job, state: "complete", completed: 10 } }));
    expect(dom.host.textContent).toContain('"unavailable":false');
    expect(refreshes).toBe(1);
    await act(async () => tick());
    await act(async () => resolve({ job: { ...job, state: "complete", completed: 10 } }));
    expect(refreshes).toBe(1);
    await act(async () => tick());
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
  } finally {
    await act(async () => root.unmount());
    unsubscribe(); status.mockRestore();
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
    dom.restore();
  }
});
