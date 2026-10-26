import { expect, test } from "bun:test";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { deferredScreen } from "./deferred-screen";
import { installTestDom } from "./test-dom-harness";

test("secondary screen code loads on entry and preserves the shell while pending", async () => {
  let loads = 0;
  let ready!: (module: { default: ComponentType<{ value: string }> }) => void;
  const code = new Promise<{ default: ComponentType<{ value: string }> }>(resolve => { ready = resolve; });
  const Screen = deferredScreen(() => { loads++; return code; });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  try {
    await act(async () => root.render(<main><nav>shell</nav></main>));
    expect(loads).toBe(0);
    await act(async () => root.render(<main><nav>shell</nav><Screen value="report" /></main>));
    expect(loads).toBe(1);
    expect(dom.host.textContent).toContain("shell");
    expect(dom.host.textContent).toContain("Loading view");
    await act(async () => { ready({ default: ({ value }) => <article>{value}</article> }); await code; });
    expect(dom.host.textContent).toBe("shellreport");
    await act(async () => root.render(<main><nav>shell</nav></main>));
    await act(async () => root.render(<main><nav>shell</nav><Screen value="reopened" /></main>));
    expect(loads).toBe(1);
    expect(dom.host.textContent).toBe("shellreopened");
  } finally { await act(async () => root.unmount()); dom.restore(); }
});

test("failed screen download leaves navigation and a retry visible", async () => {
  const Screen = deferredScreen(async () => { throw new Error("chunk unavailable"); });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const originalError = console.error;
  console.error = () => {};
  try {
    await act(async () => root.render(<main><nav>shell</nav><Screen /></main>));
    expect(dom.host.textContent).toContain("shell");
    expect(dom.host.textContent).toContain("Unable to load view");
    expect(dom.host.textContent).toContain("Retry");
  } finally { console.error = originalError; await act(async () => root.unmount()); dom.restore(); }
});
