import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectCostResponse, RepoHistoryResponse, SubjectRow, SubjectSubscriptionSlice } from "../../lib/api";
import { setLanguage } from "../../lib/i18n";
import { findByAttribute, installTestDom, invoke, type TestNode } from "../../lib/test-dom-harness";
import { ProjectDrawer } from "../ProjectDrawer";

const subject: SubjectRow = {
  kind: "project", id: "alpha", name: "alpha", repos: ["alpha"], tokens: 1000, calls: 2,
  active_seconds: 7200, group: null,
};
const slice: SubjectSubscriptionSlice = {
  tokens: 1000, calls: 2, api_usd: 55, billed_usd: 5.5, share: 1, seat_time: null,
  tokens_by_type: { in_uncached: 1000, cache_read: 0, cache_write: 0, out: 0 }, usd_by_type: null,
  equivalents: {
    full_5h_sessions: { value: null, absent: "no_capacity" },
    weekly_cycles: { value: null, absent: "no_capacity" },
    monthly_subscriptions: { value: null, absent: "no_capacity" },
  },
  cost_at_full_use_usd: null,
  provenance: { capacity: "none", price: "none", cadence: "none", calibration_covers_period: false,
    coverage: "none", measured_share: 0 },
};
const emptyCoverage = { tokens: 0, calls: 0, api_usd: 0, billed_usd: 0 };
function costFor(row = subject, billed: number | null = 5.5): ProjectCostResponse {
  return {
    since: "2026-08-01", until: null, subscriptions: [], notes: [],
    subjects: [{ subject: `${row.kind === "project" ? "p" : "r"}:${row.id}`, kind: row.kind, id: row.id,
      tokens: row.tokens, calls: row.calls, api_usd: 55, billed_usd: billed, billed_complete: billed != null,
      share_of_priced_spend_pct: null, priced_spend_usd: billed ?? 0, by_sub: {},
      subscriptions: { codex1: { ...slice, billed_usd: billed } } }],
    totals: { tokens: row.tokens, calls: row.calls, api_usd: 55, paid_usd: billed ?? 0, billed_usd: billed ?? 0,
      unassigned_billed_usd: 0, unassigned_api_usd: 0, non_tmp_tokens: row.tokens },
    unpriced: { tokens: 0, models: {} },
    coverage: { tmp_bucket: emptyCoverage, unassigned: emptyCoverage,
      unpriced: { ...emptyCoverage, models: {} }, unattributable: { ...emptyCoverage, vendor: "gemini" }, totals: emptyCoverage },
  };
}
function historyFor(url: string, seconds = 3600): RepoHistoryResponse {
  const request = new URL(url);
  return {
    subject: { kind: request.searchParams.has("project") ? "project" : "repo",
      id: request.searchParams.get("project") ?? request.searchParams.get("repo")! },
    repo: null, granularity: request.searchParams.get("granularity") as "day" | "week" | "month", by: "none",
    idle_gap_minutes: Number(request.searchParams.get("idle_gap")), since: request.searchParams.get("since"), until: null,
    vendor_coverage: [], notes: [], points: [],
    totals: { tokens: 1000, calls: 2, active_seconds: seconds, active_by_machine: {}, session_seconds: 7200,
       api_usd: 55, api_complete: true, billed_usd: 5.5, billed_complete: true, by_sub: {} },
  };
}
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

function installDrawerDom() {
  const dom = installTestDom();
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: document.location });
  return { host: dom.host, restore() {
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    dom.restore();
  } };
}

test("cost refresh and failure isolate old amounts while preserving drawer controls and ready history", async () => {
  setLanguage("en");
  const dom = installDrawerDom(), root = createRoot(dom.host as unknown as Element);
  const read = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
    async (input: URL | RequestInfo) => Response.json(historyFor(String(input))), { preconnect() {} },
  ));
  const price = () => findByAttribute(dom.host, "data-main-figure", "")!.textContent;
  const tab = (key: string) => invoke(findByAttribute(dom.host, "data-detail-tab", key)!, "onClick");
  let retries = 0;
  const render = (cost: ProjectCostResponse | null, costLoading = false, costError: string | null = null) =>
    root.render(<ProjectDrawer subject={subject} cost={cost} costLoading={costLoading} costError={costError}
      onCostRetry={() => retries++} since="2026-08-01" rangeDays={30} idleGap={15} onClose={() => {}} />);
  try {
    await act(async () => render(costFor()));
    expect(price()).toBe("$5.50");
    expect(findByAttribute(dom.host, "data-summary", "")!.textContent).toContain("1h 00m of work");
    await tab("cost");
    const more = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "more columns")!;
    await invoke(more, "onClick");
    await tab("summary");

    await act(async () => render(costFor(), true));
    expect(price()).toBe("…");
    expect(findByAttribute(dom.host, "data-summary", "")!.textContent).toContain("1h 00m of work");
    await act(async () => render(costFor(), false, "cost unavailable"));
    expect(price()).toBe("error");
    expect(dom.host.textContent).toContain("cost unavailable");
    const retry = nodes(dom.host).find(node => node.tagName === "BUTTON" && /retry|again/i.test(node.textContent))!;
    await invoke(retry, "onClick");
    expect(retries).toBe(1);

    await act(async () => render(costFor(subject, 9)));
    expect(price()).toBe("$9.00");
    // A choice made on another tab survives the refresh and the tab switch.
    await tab("cost");
    expect(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "more columns")!.getAttribute("aria-pressed")).toBe("true");
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); read.mockRestore(); dom.restore();
  }
});

test("subject and range switches reject unrelated costs and ignore an aborted history answer", async () => {
  setLanguage("en");
  const dom = installDrawerDom(), root = createRoot(dom.host as unknown as Element);
  const pending: Array<{ url: string; signal: AbortSignal; resolve: (response: Response) => void }> = [];
  const read = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: URL | RequestInfo, init?: Parameters<typeof fetch>[1]) => new Promise<Response>(resolve => {
    pending.push({ url: String(input), signal: init!.signal!, resolve });
  }), { preconnect() {} }));
  const beta = { ...subject, id: "beta", name: "beta" };
  const price = () => findByAttribute(dom.host, "data-main-figure", "")!.textContent;
  const render = (row: SubjectRow, cost: ProjectCostResponse, since = "2026-08-01") =>
    root.render(<ProjectDrawer subject={row} cost={cost} since={since} rangeDays={30} idleGap={15} onClose={() => {}} />);
  try {
    await act(async () => render(subject, costFor()));
    await act(async () => render(beta, costFor()));
    expect(price()).toBe("—");
    expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () => pending[0]!.resolve(Response.json(historyFor(pending[0]!.url, 3600))));
    expect(findByAttribute(dom.host, "data-summary", "")!.textContent).not.toContain("of work");
    await act(async () => pending[1]!.resolve(Response.json(historyFor(pending[1]!.url, 1800))));
    await act(async () => render(beta, costFor(beta, 8)));
    expect(price()).toBe("$8.00");
    expect(findByAttribute(dom.host, "data-summary", "")!.textContent).toContain("30m of work");

    await act(async () => render(beta, costFor(beta, 8), "2026-08-10"));
    expect(price()).toBe("…");
    expect(findByAttribute(dom.host, "data-summary", "")!.textContent).not.toContain("of work");
    expect(pending[1]!.signal.aborted).toBe(true);
    const current = { ...costFor(beta, 12), since: "2026-08-10" };
    await act(async () => render(beta, current, current.since!));
    expect(price()).toBe("$12.00");
  } finally {
    await act(async () => root.unmount()); read.mockRestore(); dom.restore();
  }
});
