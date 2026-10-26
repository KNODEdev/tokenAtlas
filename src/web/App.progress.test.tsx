import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bustApiMemo } from "./lib/api";
import { findByAttribute, installTestDom, invoke } from "./lib/test-dom-harness";

test("Overview exposes persisted rebuild progress while account and report reads remain pending", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const originalFetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: document.location });
  globalThis.innerWidth = 1920;
  globalThis.cancelAnimationFrame = () => {};
  bustApiMemo();
  globalThis.fetch = (async input => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/analysis/rebuild") return Response.json({ job: {
      generation: 42, scope: "all", range: null, state: "running", phase: "reports",
      completed: 17, total: 40, error: null,
    } });
    if (pathname === "/api/setup") return Response.json({ configured: true });
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    await act(async () => root.render(<App />));
    expect(dom.host.textContent).toContain("Overview");
    // The permanent status bar carries the rebuild; the view itself keeps its loading state.
    expect(dom.host.textContent).toContain("Data rebuild · 3/3 Reports");
    expect(dom.host.textContent).toContain("17 / 40 reports");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
    bustApiMemo(); dom.restore();
  }
});

test("indexed Codex history starts without waiting for roster and switching accounts exposes a scoped loader", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const originalFetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: document.location });
  globalThis.innerWidth = 1920;
  globalThis.cancelAnimationFrame = () => {};
  const requested: string[] = [];
  bustApiMemo();
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    if (url.pathname === "/api/analysis/rebuild") return Response.json({ job: null });
    if (url.pathname === "/api/setup") return Response.json({ configured: true });
    if (url.pathname === "/api/accounts") return Response.json({ subscriptions: [
      { id: "codex1", vendor: "codex", plan: "pro", has_gauge: true, homes: [] },
      { id: "codex2", vendor: "codex", plan: "plus", has_gauge: true, homes: [] },
      { id: "claude", vendor: "claude", plan: "pro", has_gauge: true, homes: [] },
    ] });
    if (url.pathname === "/api/usage-series") requested.push(url.searchParams.get("account")!);
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    await act(async () => root.render(<App />));
    expect(requested).toEqual(["codex1"]);
    expect(dom.host.textContent).toContain("Loading subscription history and charts");
    // The loader starts quiet (no elapsed time yet) but is exposed as busy with an indeterminate progress bar.
    expect(dom.host.textContent).not.toContain("Elapsed");
    expect(findByAttribute(dom.host, "aria-label", "Loading subscription history and charts")?.getAttribute("role")).toBe("progressbar");
    // The subscription picker opens a listbox; picking an option switches the subscription.
    const pick = async (value: string) => {
      await invoke(findByAttribute(dom.host, "aria-haspopup", "listbox")!, "onClick");
      await invoke(findByAttribute(dom.host, "data-value", value)!, "onClick");
    };
    await pick("codex2");
    expect(requested).toEqual(["codex1", "codex2"]);
    expect(dom.host.textContent).toContain("Loading subscription history and charts");
    await pick("claude");
    expect(requested).toEqual(["codex1", "codex2"]);
    expect(dom.host.textContent).toContain("Loading subscription details");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
    bustApiMemo(); dom.restore();
  }
});
