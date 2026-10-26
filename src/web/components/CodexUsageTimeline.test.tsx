import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CodexAccountingReport, CodexComparisonWindow } from "../../shared/codex-accounting";
import { api } from "../lib/api";
import { setContextPreview } from "../lib/context-premium";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdowns, installTestDom, type TestNode } from "../lib/test-dom-harness";
import { CodexUsageTimeline } from "./CodexUsageTimeline";

test("Traffic history previews window API per point while daily traffic retains its stored amount", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const window: CodexComparisonWindow = { id: "context", account: "codex1", plan: "pro", window_minutes: 10080,
    start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z", reset: "2026-10-08T00:00:00Z",
    start_percent: 0, end_percent: 50, observed_pp: 50, probes: 2, max_gap_hours: 1, sources: [], models: [],
    usage: { events: 2, tokens: 100, input: 90, cached: 50, output: 10, fast_tokens: 0, unknown_tokens: 0,
      priced_tokens: 100, unpriced_events: 0, api_standard: 100, credits_low: 10, credits_high: 10,
      context_api_base: 100, context_api_extra: 20, context_priced_tokens: 100 } };
  const data: Pick<CodexAccountingReport, "scope" | "events" | "breakdown" | "windows" | "traffic_periods"> = {
    scope: { since: "2026-10-01", until: "2026-10-08" }, events: 2, breakdown: [], windows: [window],
    traffic_periods: [{ account: "codex1", start: window.start, end: window.end, start_reset: true, end_reset: true,
      events: 2, tokens: 100, fast_tokens: 0, unknown_tokens: 0, api: 7, credits: 10, priced_tokens: 100, priced_events: 2, models: {} }],
  };
  const markers = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const all = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(all)];
  const bar = () => all(dom.host).find(node => node.tagName === "G" && node.attributes.role === "button")!;
  setLanguage("en");
  setContextPreview(false);
  try {
    await act(async () => root.render(<CodexUsageTimeline data={data as CodexAccountingReport} />));
    const traffic = bar().attributes["aria-label"];
    expect(traffic).toContain(" · 7 · ");
    await act(async () => setContextPreview(true));
    expect(bar().attributes["aria-label"]).toBe(traffic);
    await chooseOption(dropdowns(dom.host)[0]!, "apiPP");
    expect(bar().attributes["aria-label"]).toContain(" · 2.4 · ");
    await act(async () => setContextPreview(false));
    expect(bar().attributes["aria-label"]).toContain(" · 2 · ");
    expect(window.usage.api_standard).toBe(100);
  } finally { await act(async () => root.unmount()); setContextPreview(false); markers.mockRestore(); dom.restore(); }
});
