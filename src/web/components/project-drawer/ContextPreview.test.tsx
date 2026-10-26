import { ContextReportScreen } from "../../lib/use-context-companion";
import { registerContextCompanion } from "../../lib/context-companion";
import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installTestDom } from "../../lib/test-dom-harness";
import { setContextPreview } from "../../lib/context-premium";
import { ProjectDrawer } from "../ProjectDrawer";
import * as historyRead from "./history";
import * as chart from "./ProjectMixChart";
import type { RepoHistoryResponse } from "../../lib/api";

test("the drawer's own history request lazily fetches its companion only while ON", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: document.location });
  const base: RepoHistoryResponse = { subject: { kind: "project", id: "context-fixture" }, repo: null, granularity: "week", by: "none",
    idle_gap_minutes: 15, since: null, until: null, vendor_coverage: [], notes: [], points: [],
    totals: { tokens: 10, calls: 1, active_seconds: 0, active_by_machine: {}, session_seconds: 0, api_usd: 1,
      api_complete: true, billed_usd: 0, billed_complete: true, by_sub: { codex: { api_usd: 1, billed_usd: 0 } } } };
  const paired: RepoHistoryResponse = { ...base, context_preview_status: { ready: true, revision: 1, missing_groups: 0 },
    context_preview: { ...base, totals: { ...base.totals, api_usd: 2, by_sub: { codex: { api_usd: 2, billed_usd: 0 } } } } };
  let companions = 0;
  const read = spyOn(historyRead, "fetchRepoHistory").mockImplementation(async url => {
    registerContextCompanion(base, url, async () => { companions++; return paired; });
    return base;
  });
  const renderChart = spyOn(chart, "ProjectMixChart").mockImplementation(props => <span>preview total {props.totalsBySub?.codex?.api_usd}</span>);
  try {
    setContextPreview(false);
    await act(async () => root.render(<ContextReportScreen.Provider value="projects"><ProjectDrawer subject={{ kind: "project", id: "context-fixture", name: "Context fixture", group: null,
      tokens: 10, calls: 1, active_seconds: 0, repos: [] }} cost={null} rangeDays={1} idleGap={15} onClose={()=>{}} /></ContextReportScreen.Provider>));
    expect(dom.host.textContent).toContain("preview total 1");
    await act(async () => setContextPreview(true)); expect(dom.host.textContent).toContain("preview total 2");
    await act(async () => setContextPreview(false)); expect(dom.host.textContent).toContain("preview total 1");
    expect(read.mock.calls).toHaveLength(1); expect(companions).toBe(1);
  } finally {
    await act(async () => root.unmount()); setContextPreview(false); read.mockRestore(); renderChart.mockRestore();
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    dom.restore();
  }
});
