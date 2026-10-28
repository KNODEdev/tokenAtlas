import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, type ApiAccount } from "../lib/api";
import { aggregateModelReports } from "../lib/all-model-reports";
import { setLanguage } from "../lib/i18n";
import { flushUntil, installTestDom, type TestNode } from "../lib/test-dom-harness";
import type { ScreenProps } from "../lib/screens";
import { Models } from "./Models";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

test("both All model tabs use the subscription layout and read the real accounts instead of requesting an All capacity counter", async () => {
  setLanguage("en");
  const scope = { since: "2026-10-01", until: "2026-10-28" };
  const report = aggregateModelReports([], { ...scope, account: "codex1" });
  const amount = { ...report.normalization.standard_api_usd, value: 1, priced_subtotal: 1, priced_events: 1, priced_tokens: 1000, status: "complete" as const };
  const normalization = { ...report.normalization, standard_api_usd: amount };
  const accounts = [{ id: "codex1", vendor: "codex", has_events: true }, { id: "claude1", vendor: "claude", has_events: true }] as ApiAccount[];
  const make = (provider: string, account: string) => ({ ...report, provider: { ...report.provider!, id: provider }, scope: { ...scope, account },
    events: 1, tokens: 1000, known_speed_events: 1, known_speed_tokens: 1000, normalization,
    breakdown: [{ day: "2026-10-20", model: "gpt-6.1-sol", speed: "standard", account, home: "test", events: 1, tokens: 1000, amounts: report.amounts, normalization }] });
  const codex = spyOn(api, "codexAccounting").mockResolvedValue(make("codex", "codex1"));
  const claude = spyOn(api, "subscriptionAccounting").mockResolvedValue(make("claude", "claude1"));
  const cache = spyOn(api, "modelCacheHistory").mockResolvedValue({ hours: [] } as never);
  const codexMarkers = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "", markers: [], automatic: [] });
  const claudeMarkers = spyOn(api, "subscriptionTimelineMarkers").mockResolvedValue({ revision: "", markers: [], automatic: [] });
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const props = { account: "all", accounts, project: "", analysisRange: scope, goto() {} } as unknown as ScreenProps;
  try {
    await act(async () => root.render(<Models key="usage" {...props} />));
    await flushUntil(() => !!nodes(dom.host).find(node => node.attributes["data-table-id"] === "ModelUsage:0"));
    expect(dom.host.textContent).toContain("All subscriptions");
    expect(dom.host.textContent).toContain("2k");
    expect(dom.host.textContent).not.toContain("model ranking of all subscriptions");
    expect(codex.mock.calls[0]![0].account).toBe("codex1");
    expect(claude.mock.calls[0]![0].account).toBe("claude1");
    await act(async () => root.render(<Models key="trends" {...props} view="trends" />));
    await flushUntil(() => dom.host.textContent.includes("Traffic by recorded UTC day"));
    const chart = nodes(dom.host).find(node => node.tagName === "svg" || node.tagName === "SVG");
    expect(chart).toBeDefined();
    expect(dom.host.textContent).not.toContain("Limit windows belong to one subscription");
    expect(codex.mock.calls.every(([scope]) => scope.account === "codex1")).toBe(true);
    expect(claude.mock.calls.every(([scope]) => scope.account === "claude1")).toBe(true);
  } finally {
    await act(async () => root.unmount()); dom.restore();
    for (const mock of [codex, claude, cache, codexMarkers, claudeMarkers]) mock.mockRestore();
  }
});
