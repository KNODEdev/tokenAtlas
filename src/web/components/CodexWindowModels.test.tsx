import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import type { CycleBreakdownResponse } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import type { CodexWindowDetail, CodexWindowModelRow, WindowPriceParts } from "../../shared/codex-window-detail";
import { CodexModelsHelp, CodexWindowModels, CostSplit, ModelRates } from "./CodexWindowModels";

function prices(multiplier: number, source: string): WindowPriceParts {
  const rates = { in_uncached: 1_000 * multiplier, in_cache_read: 500 * multiplier, out_total: 2_000 * multiplier };
  return {
    rates,
    input: 0.6 * multiplier,
    cached: 0.2 * multiplier,
    output: 0.6 * multiplier,
    total: 1.4 * multiplier,
    rule_id: `rule-${multiplier}`,
    sources: [source],
    confidence: "official",
  };
}

function row(overrides: Partial<CodexWindowModelRow> = {}): CodexWindowModelRow {
  return {
    model: "model-a",
    speed: "standard",
    first: "2026-08-16T10:00:00Z",
    last: "2026-08-16T11:00:00.123Z",
    calls: 2,
    input: 1_000,
    cached: 400,
    cache_write: 50,
    cache_write_complete: true,
    output: 300,
    reasoning: 80,
    tokens: 1_300,
    long_context: false,
    api: prices(1, "https://example.test/pricing"),
    credits: prices(2, "https://example.test/credits"),
    actual_api: 1.4,
    actual_credits: 2.8,
    unpriced_reason: null,
    ...overrides,
  };
}

function response(rows: CodexWindowModelRow[]): CycleBreakdownResponse {
  const model_detail: CodexWindowDetail = {
    basis: "dated-standard-reference",
    rows,
    excluded_mirror_events: 1,
    excluded_counter_events: 0,
    unknown_speed_tokens: 300,
    invalid_token_events: 2,
  };
  return { model_detail } as unknown as CycleBreakdownResponse;
}

describe("CodexWindowModels", () => {
  it("keeps common facts while the model drawer switches between costs, cache history and dated rates", async () => {
    setLanguage("pl");
    const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
    const data = response([row(), row({ model: "model-b" })]);
    data.model_detail!.cache_timeline = { from: "2026-08-16T10:00:00Z", until: "2026-08-16T12:00:00Z", hours: [
      { model: "model-a", hour: "2026-08-16T10:00:00Z", calls: 2, input: 1000, cached: 400 },
      { model: "model-b", hour: "2026-08-16T10:00:00Z", calls: 2, input: 1000, cached: 950 },
    ] };
    const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
    const all = () => nodes(dom.host);
    const tab = (name: string) => all().find(node => node.getAttribute("role") === "tab" && node.textContent === name)!;
    try {
      await act(async () => root.render(<CodexWindowModels data={data} loading={false} error={null} cycleLabel="selected cycle" />));
      const model = all().find(node => node.tagName === "BUTTON" && node.textContent.includes("model-a"))!;
      await invoke(model, "onClick", { stopPropagation() {}, currentTarget: model });
      expect(["Koszty", "Cache", "Stawki"].map(name => tab(name).textContent)).toEqual(["Koszty", "Cache", "Stawki"]);
      expect(tab("Koszty").getAttribute("aria-selected")).toBe("true");
      expect(dom.host.textContent).toContain("Na co poszedł API Standard");
      await invoke(tab("Cache"), "onClick");
      expect(all().find(node => node.tagName === "SVG")?.getAttribute("aria-label")).toBe("Udział odczytu cache w czasie");
      const point = all().find(node => node.getAttribute("role") === "img")!;
      expect(point.getAttribute("aria-label")).toContain("40,0%");
      expect(point.getAttribute("aria-label")).not.toContain("95,0%");
      expect(dom.host.textContent).not.toContain("Na co poszedł API Standard");
      expect(dom.host.textContent).toContain("selected cycle");
      await invoke(tab("Stawki"), "onClick");
      expect(dom.host.textContent).toContain("USD/M");
      expect(all().some(node => node.tagName === "SVG")).toBe(false);
      await invoke(tab("Stawki"), "onKeyDown", { key: "Home", preventDefault() {} });
      expect(tab("Koszty").getAttribute("aria-selected")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      setLanguage("en");
    }
  });

  it("renders complete arithmetic and partial priced totals in the table, dated rates and sources in the drawer body", () => {
    setLanguage("en");
    const rows = [
      row(),
      row({ model: "model-a", speed: "unknown", calls: 1, input: 200, cached: 50, cache_write: 5, output: 100, reasoning: 20, tokens: 300, api: null, credits: null, actual_api: null, actual_credits: null, unpriced_reason: "cache_write_semantics_unknown" }),
    ];
    const html = renderToStaticMarkup(<CodexWindowModels data={response(rows)} loading={false} error={null} cycleLabel="Aug 16–23 2026" />);

    expect(html).toContain("1,600"); // input + output, with no double-counting
    expect(html).toContain("37.5%"); // cache read 450 of input 1,200
    expect(html).toContain("400"); // output including reasoning
    expect(html).toContain("≥ $1.40");
    expect(html).toContain("≥ 2.8");
    expect(html).toContain("$1,076.92"); // API Standard per priced million: 1.40 / 1,300 tokens
    expect(html).toContain("81.3% of tokens have a dated rate");
    expect(html).toContain("300 without one (model-a)");
    expect(html).toContain("1,300 / 1,600"); // coverage counts in the tooltip
    expect(html).toContain("In total");
    expect(html).toContain("Fresh In");
    expect(html).toContain("1,200"); // all input
    expect(html).toContain("695"); // fresh input excludes both cache reads and writes
    expect(html).toContain("450"); // cache reads
    expect(html).toContain("55"); // cache writes
    expect(html).toContain("Invalid token events");
    expect(html).not.toContain("Show dated rates"); // the rates open in a drawer, not a fold
    expect(html).toContain('aria-haspopup="dialog"');

    const rates = renderToStaticMarkup(<ModelRates rows={rows} />);
    // Exact UTC timestamps, the reference-scenario caveat and official confidence live in tooltips, not on screen.
    expect(rates).toContain('title="2026-08-16 10:00:00 UTC → 2026-08-16 11:00:00 UTC"');
    expect(rates).toContain("USD/M");
    expect(rates).toContain("Credits/M");
    expect(rates.match(/href="https:\/\/example\.test\/pricing"/g)?.length).toBe(1); // sources once per drawer
    expect(rates).not.toContain("official");
    expect(rates).not.toContain("Observed from");
    expect(rates).toContain("Unknown speed");
    expect(rates).toContain('title="Standard is a reference scenario, not an actual bill"');
    expect(rates).toContain("cache write semantics unknown");
    expect(rates).toContain("reasoning 80"); // reasoning stands beside output instead of a row of dashes

    const help = renderToStaticMarkup(<CodexModelsHelp data={response(rows)} />);
    expect(help).toContain("cache write is not a separate output stream");
    expect(help).toContain("Reasoning is shown inside output");
  });

  it("splits the API Standard by priced piece", () => {
    setLanguage("en");
    const split = renderToStaticMarkup(<CostSplit rows={[row()]} />);
    expect(split).toContain("Where the API Standard went");
    expect(split).toContain("$0.60"); // fresh input and output
    expect(split).toContain("$0.20"); // cache read
    expect(split).toContain("42.9%");
    expect(split).toContain("14.3%");
    expect(renderToStaticMarkup(<CostSplit rows={[row({ api: null })]} />)).toBe("");
  });

  it("names a model without any dated rate instead of showing a dash", () => {
    setLanguage("en");
    const html = renderToStaticMarkup(<CodexWindowModels data={response([row(), row({ model: "model-b", api: null, credits: null })])} loading={false} error={null} cycleLabel="w" />);
    expect(html).toContain("no rate");
  });

  it("leaves out rate pieces without tokens", () => {
    setLanguage("en");
    const rates = renderToStaticMarkup(<ModelRates rows={[row({ cache_write: 0 })]} />);
    expect(rates).not.toContain("Cache write input");
    expect(rates).toContain("Cache read input");
  });

  it("keeps every model in the summary instead of collapsing the tail", () => {
    setLanguage("en");
    const rows = Array.from({ length: 10 }, (_, index) => row({
      model: `model-${index + 1}`,
      input: 100 + index,
      cached: 10,
      output: 20,
      reasoning: 0,
      tokens: 120 + index,
    }));
    const html = renderToStaticMarkup(<CodexWindowModels data={response(rows)} loading={false} error={null} cycleLabel="selected cycle" />);
    for (let index = 1; index <= 10; index += 1) expect(html).toContain(`model-${index}`);
    expect(html).not.toContain("other");
  });
});
