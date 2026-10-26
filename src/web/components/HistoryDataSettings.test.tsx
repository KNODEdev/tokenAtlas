import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, spyOn, test } from "bun:test";
import type { TimelineMarker, TimelineMarkersResponse } from "../../shared/codex-accounting";
import type { HistoryCoverageResponse } from "../lib/api";
import { api } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdowns, flushUntil, installTestDom, type TestNode } from "../lib/test-dom-harness";
import { HistoryDataSettings } from "./HistoryDataSettings";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

function coverage(): HistoryCoverageResponse {
  const row = (subscription: string, vendor: string) => ({
    subscription,
    vendor,
    usage: { first_day: "2026-09-01", last_day: "2026-09-02", active_days: 2, calls: 1, tokens: 100 },
    gauge: {
      basis: "none" as const,
      first_at: null,
      last_at: null,
      samples: 0,
      reset_samples: 0,
      plan_samples: 0,
      actual_fill_available_from: null,
      history_before_first_gauge: "none" as const,
      gap_days: 0,
      utilization_semantics: "unavailable" as const,
    },
    plan_history: { status: "covered" as const, plan_periods: 1, uncovered_usage_days: 0, uncovered_ranges: [] },
    capacity_history: { declared_regimes: 1, status: "explicit" as const, assumption: null },
    normalized_trend: { available: false, reason: "no-gauge" as const },
    actions: [],
  });
  return {
    generated_at: "2026-09-12T00:00:00.000Z",
    subscriptions: [row("codex-account", "openai"), row("claude-account", "anthropic")],
  };
}

function marker(provider: string): TimelineMarker {
  return { id: `custom:${provider}`, day: "2026-09-01", label: `${provider} marker`, note: "fixture", color: "accent", visible: true };
}

function markers(provider: string): TimelineMarkersResponse {
  const automatic = Array.from({ length: provider === "codex" ? 1 : 2 }, (_, index) => ({
    ...marker(provider),
    id: `custom:${provider}:${index}`,
  }));
  return { revision: `${provider}-revision`, markers: [], automatic };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

test("switches the all-account provider and hides stale markers while the new archive loads", async () => {
  setLanguage("en");
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  const codex = deferred<TimelineMarkersResponse>();
  const claude = deferred<TimelineMarkersResponse>();
  const coverageApi = spyOn(api, "historyCoverage").mockResolvedValue(coverage());
  const markerApi = spyOn(api, "subscriptionTimelineMarkers").mockImplementation((provider) => provider === "codex" ? codex.promise : claude.promise);
  try {
    await act(async () => { root.render(<HistoryDataSettings account="__all__" onNavigate={() => {}} />); });
    await flushUntil(() => markerApi.mock.calls.some(([provider]) => provider === "codex"));

    await act(async () => { codex.resolve(markers("codex")); });
    await flushUntil(() => dom.host.textContent.includes("1 points"));
    expect(dom.host.textContent).toContain("Full provider archive · codex");

    const providerSelect = dropdowns(dom.host)[0];
    if (!providerSelect) throw new Error("Provider selector not found");
    await chooseOption(providerSelect, "claude");

    expect(dom.host.textContent).not.toContain("1 points");
    expect(markerApi.mock.calls.map(([provider]) => provider)).toEqual(["codex", "claude"]);

    await act(async () => { claude.resolve(markers("claude")); });
    await flushUntil(() => dom.host.textContent.includes("2 points"));
    expect(dom.host.textContent).toContain("Full provider archive · claude");
    expect(dom.host.textContent).not.toContain("1 points");
  } finally {
    await act(async () => root.unmount());
    markerApi.mockRestore();
    coverageApi.mockRestore();
    dom.restore();
  }
});

test("maps a selected account vendor to its provider archive", async () => {
  setLanguage("en");
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  const coverageApi = spyOn(api, "historyCoverage").mockResolvedValue(coverage());
  const markerApi = spyOn(api, "subscriptionTimelineMarkers").mockImplementation(async (provider) => markers(provider));
  try {
    await act(async () => { root.render(<HistoryDataSettings account="claude-account" onNavigate={() => {}} />); });
    await flushUntil(() => dom.host.textContent.includes("2 points"));

    expect(markerApi.mock.calls.map(([provider]) => provider)).toEqual(["claude"]);
    expect(dom.host.textContent).toContain("Full provider archive · claude");
    expect(dropdowns(dom.host)).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    markerApi.mockRestore();
    coverageApi.mockRestore();
    dom.restore();
  }
});
