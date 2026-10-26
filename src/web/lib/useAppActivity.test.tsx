import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useAppActivity } from "./useAppActivity";
import { installTestDom, flushUntil } from "./test-dom-harness";
import { onApiRefresh } from "./api";
import type { AppActivity } from "../../shared/app-activity";

test("status timeout retains data, recovery refreshes once, and polling never overlaps", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const intervals: Array<() => void> = [], deadlines = new Map<number, () => void>();
  let nextId = 0, calls = 0, refreshes = 0;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => { intervals.push(fn); return 1; }) as typeof setInterval);
  const clearIntervalMock = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { deadlines.set(++nextId, fn); return nextId; }) as typeof setTimeout);
  const clearTimeoutMock = spyOn(globalThis, "clearTimeout").mockImplementation(id => { deadlines.delete(Number(id)); });
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | null = null;
  const base: AppActivity = { observedAt: 1000, observationStartedAt: 1000, unavailable: false, busy: true,
    providers: [], reports: { pending: 1, failed: 0, truncated: false, views: [] }, progress: [] };
  globalThis.fetch = (async (_url, options) => {
    calls++;
    if (calls === 2 || calls === 5) return new Promise<Response>((_resolve, reject) => {
      requestSignal = options?.signal ?? null;
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return Response.json({ ...base, busy: calls === 1 });
  }) as typeof fetch;
  const off = onApiRefresh(() => { refreshes++; });
  function Probe() { const state = useAppActivity(); return <div>{JSON.stringify(state)}</div>; }
  const tick = () => act(async () => { intervals[0]!(); });
  try {
    await act(async () => root.render(<Probe />));
    await flushUntil(() => dom.host.textContent.includes('"busy":true'));
    await tick(); await tick();
    expect(calls).toBe(2);
    await act(async () => { for (const deadline of [...deadlines.values()]) deadline(); });
    await flushUntil(() => dom.host.textContent.includes('"unavailable":true'));
    expect(dom.host.textContent).toContain('"busy":true');
    await tick(); await flushUntil(() => dom.host.textContent.includes('"busy":false'));
    expect(refreshes).toBe(1);
    await tick(); expect(refreshes).toBe(1);
    await tick();
    await act(async () => root.unmount());
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(deadlines.size).toBe(0);
  } finally {
    await act(async () => root.unmount()); off(); originalFetch && (globalThis.fetch = originalFetch);
    interval.mockRestore(); clearIntervalMock.mockRestore(); timeout.mockRestore(); clearTimeoutMock.mockRestore(); dom.restore();
  }
});
