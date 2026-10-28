import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { api, type AccountHistoryResponse, type BreakdownRow } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import type { RosterCard } from "../lib/roster";
import { findByText, flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { AllAggregate } from "./AllAggregate";

function historyFor(group = "month"): AccountHistoryResponse {
  const slice = { tokens: 1000, calls: 2, usd: 5 };
  const second = { tokens: 500, calls: 1, usd: 2 };
  return { group, since: null, until: null,
    accounts: [{ id: "codex1", vendor: "codex", ...slice, first_ts: null, last_ts: null },
      { id: "claude", vendor: "claude", ...second, first_ts: null, last_ts: null }],
    points: [1, 2, 3].map(day => ({ bucket: group === "month" ? `2026-0${day + 6}` : `2026-09-0${day}`,
      tokens: 1500, calls: 3, usd: 7, split: { codex1: slice, claude: second } })),
    totals: { tokens: 4500, calls: 9, usd: 21 }, unpriced: { tokens: 0, models: {} }, notes: [],
  };
}
const models: BreakdownRow[] = [
  { name: "model-tokens", vendor: "codex", tokens: 900, calls: 4, usd: 4, token_details: { cached_in: 100 } },
  { name: "model-cost", vendor: "claude", tokens: 500, calls: 2, usd: 15, token_details: { in_cache_read: 200 } },
  { name: "model-unit", vendor: "codex", tokens: 100, calls: 1, usd: 8, token_details: { cached_in: 0, in_cache_read: 75 } },
  { name: "model-empty", vendor: "codex", tokens: 0, calls: 1, usd: 100 },
];
const surfaces: BreakdownRow[] = [
  { name: "cli", vendor: "codex", tokens: 1000, calls: 5, usd: 12 },
  { name: "ide", vendor: "claude", tokens: 500, calls: 2, usd: 15 },
];
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const button = (host: TestNode, label: string) => findByText(host, "BUTTON", label)!;
const bodyRows = (host: TestNode) => nodes(host).filter(node => node.tagName === "TR" && node.parentNode?.tagName === "TBODY");

test("aggregate screens retain disclosure state and read only the endpoint scopes affected by controls", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const history = spyOn(api, "accountHistory").mockImplementation(async params => historyFor(params?.group));
  const splits = spyOn(api, "claudeAccountSplits").mockImplementation(async params => ({ ...params, pending: false, windows: [] }));
  const render = (screen: "analytics" | "compare" | "history", unit: "usd" | "percent" = "usd", cards: RosterCard[] = []) =>
    root.render(<AllAggregate screen={screen} unit={unit} cards={cards} />);
  try {
    await act(async () => render("analytics"));
    await flushUntil(() => dom.host.textContent.includes("Last closed period"));
    // Detail blocks start open (owner decision 20.10, IA-43); folding and reopening keep working.
    const disclosure = nodes(dom.host).find(node => node.tagName === "BUTTON" && node.getAttribute("aria-expanded") === "true" && node.textContent.includes("hide"))!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(bodyRows(dom.host).length).toBe(2);
    await invoke(disclosure, "onClick");
    expect(bodyRows(dom.host).length).toBe(0);
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.includes("show 2 rows"))!, "onClick");
    expect(bodyRows(dom.host).length).toBe(2);
    expect(history.mock.calls.length).toBe(1);
    expect(splits.mock.calls.length).toBe(0);
    await invoke(button(dom.host, "Week"), "onClick");
    expect(history.mock.calls.map(([params]) => params?.group)).toEqual(["month", "week"]);
    expect(history.mock.calls[0]![1]!.aborted).toBe(true);

    await act(async () => render("compare"));
    expect(history.mock.calls.map(([params]) => params?.group)).toEqual(["month", "week", "month"]);
    expect(splits.mock.calls.length).toBe(1);
    await invoke(button(dom.host, "Day"), "onClick");
    expect(history.mock.calls.length).toBe(3);
    await act(async () => render("analytics"));
    expect(history.mock.calls.map(([params]) => params?.group)).toEqual(["month", "week", "month", "day"]);
    // The table was left open, which is also the default, so it returns open.
    expect(bodyRows(dom.host).length).toBe(2);
    const cards = [{ id: "codex1", group: "codex", vendorAccount: "renamed-account" }] as RosterCard[];
    await act(async () => render("analytics", "percent", cards));
    expect(dom.host.textContent).toContain("renamed-account");
    expect(dom.host.textContent).toContain("Tokens in total");
    expect(history.mock.calls.length).toBe(4);
    expect(splits.mock.calls.length).toBe(1);
    await act(async () => render("history", "percent", cards));
    expect(button(dom.host, "Day").getAttribute("aria-pressed")).toBe("true");
    expect(bodyRows(dom.host).length).toBe(2);
    expect(history.mock.calls.length).toBe(4);
    expect(splits.mock.calls.length).toBe(2);
  } finally {
    await act(async () => root.unmount()); history.mockRestore(); splits.mockRestore(); dom.restore();
  }
});

test("all-models retry loads both breakdowns and mounted sorting survives a unit change without rereading", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const history = spyOn(api, "accountHistory");
  const splits = spyOn(api, "claudeAccountSplits");
  let fail = true;
  const breakdown = spyOn(api, "breakdown").mockImplementation(async params => {
    if (params.dim === "model" && fail) { fail = false; throw new Error("models unavailable"); }
    return { rows: params.dim === "model" ? models : surfaces };
  });
  const before = JSON.stringify({ models, surfaces });
  try {
    await act(async () => root.render(<AllAggregate screen="models" unit="usd" cards={[]} />));
    await flushUntil(() => dom.host.textContent.includes("models unavailable"));
    const retry = nodes(dom.host).find(node => node.tagName === "BUTTON" && /try again|retry/i.test(node.textContent))!;
    await invoke(retry, "onClick");
    await flushUntil(() => bodyRows(dom.host).length === 3);
    expect(breakdown.mock.calls.map(([params]) => params.dim)).toEqual(["model", "surface", "model", "surface"]);
    expect(bodyRows(dom.host)[0]!.textContent).toContain("model-unit");
    expect(dom.host.textContent).not.toContain("model-empty");
    await act(async () => root.render(<AllAggregate screen="models" unit="tokens" cards={[]} />));
    expect(bodyRows(dom.host)[0]!.textContent).toContain("model-unit");
    await invoke(button(dom.host, "Tokens"), "onClick");
    expect(bodyRows(dom.host)[0]!.textContent).toContain("model-tokens");
    await invoke(button(dom.host, "$/M"), "onClick");
    expect(bodyRows(dom.host)[0]!.textContent).toContain("model-unit");
    expect(breakdown.mock.calls.length).toBe(4);
    expect(history.mock.calls.length).toBe(0);
    expect(splits.mock.calls.length).toBe(0);
    expect(JSON.stringify({ models, surfaces })).toBe(before);
  } finally {
    await act(async () => root.unmount()); history.mockRestore(); splits.mockRestore(); breakdown.mockRestore(); dom.restore();
  }
});
