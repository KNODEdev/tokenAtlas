import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
import type { SubscriptionModelDetail } from "../../shared/subscription-accounting";
import { api } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { flushUntil, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { ModelUsage } from "./ModelUsage";

type Row = CodexAccountingReport["breakdown"][number];
const coverage = { value: null, priced_subtotal: 1, status: "partial", priced_events: 1, unpriced_events: 0, priced_tokens: 0, unpriced_tokens: 0, reasons: {} } as Row["normalization"]["standard_api_usd"];
const normalization = { standard_api_usd: coverage, normalized_usd: coverage, standard_credits: coverage, extra_credits: coverage };
const codexRow = (model: string | null, tokens: number): Row => ({ day: "2026-10-01", model, speed: "standard", account: "codex1", home: "h",
  events: 1, tokens, amounts: { chatgpt_credits: coverage, api_equivalent_usd: coverage }, normalization });
const detail = (model: string, quantities: Record<string, number>): SubscriptionModelDetail => ({ day: "2026-10-01", model, speed: "standard",
  source: "cli", calls: 1, tokens: 100, quantities, rates: {}, costs: {}, api_standard: 1, api_actual: null, pricing_source: null, pricing_note: "" });
const report = (patch: Partial<CodexAccountingReport>) => ({ breakdown: [], model_details: [], source_home_count: 1, normalization, ...patch }) as unknown as CodexAccountingReport;
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];

test("other providers show cache read over the whole input, cache writes included, without a history link", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<ModelUsage codex={false} account="claude1" since="2026-10-01" until="2026-10-20"
    data={report({ model_details: [detail("claude-opus-5-5", { in_uncached: 10, in_cache_read: 60, in_cache_write_5m: 30 })] })} />);
  expect(html).toContain(">Cache<span");
  expect(html).toContain("60.0%");
  expect(html).toContain("cache read 60 / input 100");
  expect(html).not.toContain("open cache history");
});

test("Codex reads every model of the account once, shows each share and opens that model's history on the selected dates", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const breakdown = spyOn(api, "breakdown").mockImplementation(async () => ({ rows: [] }) as never);
  const read = spyOn(api, "modelCacheHistory").mockImplementation(async range => ({ account: range.account, model: range.model, grain: "day",
    from: "2026-10-01T00:00:00.000Z", until: "2026-10-21T00:00:00.000Z", hours: [
      { model: "gpt-6.1-sol", hour: "2026-10-01T00:00:00.000Z", input: 1000, cached: 970, calls: 3 },
      { model: "gpt-6.1-sol", hour: "2026-10-02T00:00:00.000Z", input: 1000, cached: 990, calls: 3 },
      { model: "?", hour: "2026-10-02T00:00:00.000Z", input: 100, cached: 50, calls: 1 },
    ] }));
  try {
    await act(async () => root.render(<ModelUsage codex account="codex1" since="2026-10-01" until="2026-10-20"
      data={report({ breakdown: [codexRow("gpt-6.1-sol", 2000), codexRow("gpt-6-astra", 10), codexRow(null, 100)] })} />));
    await flushUntil(() => dom.host.textContent.includes("98.0%"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual({ account: "codex1", model: "*", since: "2026-10-01", until: "2026-10-20" });
    expect(dom.host.textContent).toContain("50.0%");
    const link = nodes(dom.host).find(node => node.attributes["aria-label"] === "gpt-6.1-sol: 98.0% · open cache history")!;
    await invoke(link, "onClick", { currentTarget: link });
    await flushUntil(() => dom.host.textContent.includes("Selected dates"));
    // The drawer opens on the table's own dates, so its total matches the column without another read.
    expect(nodes(dom.host).find(node => node.attributes["data-fact"] === "cache-range-share")!.textContent).toContain("98.0%");
    expect(read).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); read.mockRestore(); breakdown.mockRestore(); dom.restore(); }
});

test("a Codex project filter leaves the cache column unread, since stored cache hours carry no project", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const breakdown = spyOn(api, "breakdown").mockImplementation(async () => ({ rows: [] }) as never);
  const read = spyOn(api, "modelCacheHistory");
  try {
    await act(async () => root.render(<ModelUsage codex account="codex1" project="p" since="2026-10-01" until="2026-10-20"
      data={report({ breakdown: [codexRow("gpt-6.1-sol", 2000)] })} />));
    expect(read).not.toHaveBeenCalled();
    expect(nodes(dom.host).some(node => node.attributes["aria-label"]?.includes("open cache history"))).toBe(false);
  } finally { await act(async () => root.unmount()); read.mockRestore(); breakdown.mockRestore(); dom.restore(); }
});

test("models open with newer versions first and header clicks sort exact token counts in both directions", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const rows = [
    { ...detail("gpt-5.6-sol", {}), tokens: 1000.02 },
    { ...detail("gpt-6.1-sol", {}), tokens: 1000.01 },
    { ...detail("gpt-6-astra", {}), tokens: 10 },
  ];
  const table = () => nodes(dom.host).find(node => node.attributes["data-table-id"] === "ModelUsage:0")!;
  const models = () => nodes(table()).find(node => node.tagName === "TBODY")!.children.map(row => row.children[0]!.textContent);
  const tokens = () => nodes(table()).find(node => node.className === "data-table-sort-button" && node.textContent.startsWith("Tokens"))!;
  try {
    await act(async () => root.render(<ModelUsage codex={false} account="test" since="2026-10-01" until="2026-10-20" data={report({ model_details: rows })} />));
    expect(models()).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol"]);
    await invoke(tokens(), "onClick", { stopPropagation() {} });
    expect(models()).toEqual(["gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-astra"]);
    await invoke(tokens(), "onClick", { stopPropagation() {} });
    expect(models()).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-sol"]);
  } finally { await act(async () => root.unmount()); dom.restore(); }
});

test("daily model rows sort the whole result and return to the first page", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const breakdown = spyOn(api, "breakdown").mockImplementation(async () => ({ rows: [] }) as never);
  const rows = Array.from({ length: 51 }, (_, index) => codexRow(`model-${index + 1}`, index + 1));
  const table = () => nodes(dom.host).find(node => node.attributes["data-table-id"] === "ModelUsage:1")!;
  try {
    await act(async () => root.render(<ModelUsage codex account="test" project="test" since="2026-10-01" until="2026-10-20" data={report({ breakdown: rows })} />));
    await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent === "Next")!, "onClick");
    expect(nodes(table()).find(node => node.tagName === "TBODY")!.children).toHaveLength(1);
    const tokens = nodes(table()).find(node => node.className === "data-table-sort-button" && node.textContent.startsWith("Tokens"))!;
    await invoke(tokens, "onClick", { stopPropagation() {} });
    const body = nodes(table()).find(node => node.tagName === "TBODY")!;
    expect(body.children).toHaveLength(50);
    expect(body.children[0]!.textContent).toContain("model-51");
    expect(body.children[49]!.textContent).toContain("model-2");
  } finally { await act(async () => root.unmount()); breakdown.mockRestore(); dom.restore(); }
});

test("All combines Codex and other providers' cache counts before dividing their totals", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const read = spyOn(api, "modelCacheHistory").mockResolvedValue({ hours: [{ model: "gpt-6.1-sol", input: 100, cached: 50, calls: 1, hour: "2026-10-01" }] } as never);
  try {
    await act(async () => root.render(<ModelUsage codex={false} account="all" aggregateCodexAccounts={["codex1"]} since="2026-10-01" until="2026-10-20"
      data={report({ provider: { id: "all" } as never,
        breakdown: [codexRow("gpt-6.1-sol", 100), { ...codexRow("gpt-6.1-sol", 100), account: "claude1" }],
        model_details: [detail("gpt-6.1-sol", { in_uncached: 10, in_cache_read: 90 })] })} />));
    await flushUntil(() => dom.host.textContent.includes("70.0%"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0].account).toBe("codex1");
    expect(dom.host.textContent).not.toContain("open cache history");
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});
