import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installTestDom, type TestNode } from "../lib/test-dom-harness";
import { LoadingScope, LoadingStatus } from "./LoadingStatus";

test("pending selection names elapsed time once slow, resets on account or stage change, and releases its timer", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  let now = Date.parse("2026-09-18T10:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const intervals = new Map<number, () => void>();
  let id = 0;
  const start = spyOn(globalThis, "setInterval").mockImplementation(((tick: () => void) => {
    intervals.set(++id, tick); return id;
  }) as typeof setInterval);
  const stop = spyOn(globalThis, "clearInterval").mockImplementation(handle => { intervals.delete(Number(handle)); });
  const render = (scope: string, label = "Loading subscription history and charts") => act(async () => {
    root.render(<LoadingScope.Provider value={scope}><LoadingStatus label={label} /></LoadingScope.Provider>);
  });
  const tick = async () => act(async () => { for (const fn of intervals.values()) fn(); });
  try {
    await render("account-a:weekly");
    // A short wait stays quiet: the label only.
    expect(dom.host.textContent).toBe("Loading subscription history and charts");
    now += 61000; await tick();
    expect(dom.host.textContent).toContain("Elapsed: 1:01");
    expect(dom.host.textContent).toContain("still preparing this data");
    expect(dom.host.textContent).not.toContain("Time remaining");
    await render("account-a:weekly");
    expect(dom.host.textContent).toContain("Elapsed: 1:01");
    await render("account-b:weekly");
    expect(dom.host.textContent).not.toContain("Elapsed");
    now += 2000; await tick();
    expect(dom.host.textContent).not.toContain("Elapsed");
    now += 1000; await tick();
    expect(dom.host.textContent).toContain("Elapsed: 0:03");
    expect(dom.host.textContent).not.toContain("still preparing");
    await render("account-b:weekly", "Loading report");
    expect(dom.host.textContent).toBe("Loading report");
    const find = (node: TestNode): TestNode | undefined => node.attributes.role === "progressbar" ? node : node.children.map(find).find(Boolean);
    expect(find(dom.host)?.attributes["aria-valuenow"]).toBeUndefined();
    expect(intervals.size).toBe(1);
    await act(async () => root.unmount());
    expect(intervals.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    clock.mockRestore(); start.mockRestore(); stop.mockRestore(); dom.restore();
  }
});
