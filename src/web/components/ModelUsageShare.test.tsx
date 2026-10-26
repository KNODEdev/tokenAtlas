import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, spyOn, test } from "bun:test";
import type { ModelUsageShareResponse } from "../../shared/model-usage-share";
import { api } from "../lib/api";
import { flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { ModelUsageShare } from "./ModelUsageShare";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const response = (detail: string): ModelUsageShareResponse => ({
  provider: "codex", account: "a", counter: '["codex","codex",10080]', since: "2026-09-01", until: "2026-09-30", preparing_windows: 0,
  models: ["gpt-big", "gpt-small"],
  windows: [
    { window_id: "w1", start: "2026-09-10T00:00:00.000Z", end: "2026-09-17T00:00:00.000Z", plan: "pro", current: false, preparing: false,
      meter: 60, pct: [45, 15], api_usd: [900, 300], unattributed_pct: 0 },
    { window_id: "w2", start: "2026-09-17T00:00:00.000Z", end: "2026-09-24T00:00:00.000Z", plan: "pro", current: true, preparing: false,
      meter: 20, pct: [10, 6], api_usd: [200, 100], unattributed_pct: 4 },
  ],
  detail: { window_id: detail, points: [
    { t: "2026-09-17T00:00:00.000Z", meter: 0, pct: [0, 0], api_usd: [0, 0], unattributed: 0 },
    { t: "2026-09-17T01:00:00.000Z", meter: 20, pct: [10, 6], api_usd: [200, 100], unattributed: 4 },
  ] },
});

test("cycles stack by model, a click loads that cycle's hours, and the legend and unit change what is drawn", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const load = spyOn(api, "modelUsageShare").mockImplementation(async params => response(params.window ?? "w2"));
  try {
    await act(async () => { root.render(<ModelUsageShare provider="codex" account="a" since="2026-09-01" until="2026-09-30" />); });
    await flushUntil(() => dom.host.textContent.includes("gpt-big"));
    const columns = () => nodes(dom.host).filter(node => node.getAttribute("role") === "button");
    expect(columns()).toHaveLength(2);
    // Two models plus the unattributed rest of the current cycle; its total equals the meter.
    expect(nodes(columns()[1]!).filter(node => node.tagName === "RECT" && node.getAttribute("class") === "mus-segment")).toHaveLength(3);
    expect(columns()[1]!.textContent).toContain("20%");
    expect(nodes(dom.host).some(node => node.getAttribute("class") === "mus-rest")).toBe(true);

    await act(async () => { await invoke(columns()[0]!, "onClick"); });
    await flushUntil(() => load.mock.calls.some(([params]) => params.window === "w1"));
    expect(columns()[0]!.getAttribute("aria-pressed")).toBe("true");

    const legend = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "gpt-small")!;
    await act(async () => { await invoke(legend, "onClick"); });
    expect(legend.getAttribute("aria-pressed")).toBe("false");
    expect(nodes(columns()[0]!).filter(node => node.getAttribute("class") === "mus-segment")).toHaveLength(1);
    const allToggle = () => nodes(dom.host).find(node => node.getAttribute("class") === "ui-legend-all")!;
    expect(allToggle().textContent).toBe("show all");
    await act(async () => { await invoke(allToggle(), "onClick"); });
    expect(legend.getAttribute("aria-pressed")).toBe("true");
    expect(allToggle().textContent).toBe("hide all");
    await act(async () => { await invoke(allToggle(), "onClick"); });
    const legendGroup = nodes(dom.host).find(node => node.getAttribute("class") === "mus-legend")!;
    expect(legendGroup.children.filter(node => node.getAttribute("aria-pressed") === "false")).toHaveLength(2);
    await act(async () => { await invoke(allToggle(), "onClick"); });

    const apiUnit = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "API $")!;
    await act(async () => { await invoke(apiUnit, "onClick"); });
    expect(columns()[0]!.textContent).toContain("$900");
    expect(nodes(dom.host).some(node => node.getAttribute("class") === "mus-rest")).toBe(false);
  } finally {
    load.mockRestore();
    await act(async () => root.unmount());
    dom.restore();
  }
});
