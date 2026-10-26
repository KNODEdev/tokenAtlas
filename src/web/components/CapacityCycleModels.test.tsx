import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapacityCycleModel } from "../../shared/capacity-cycle";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdownOptions, dropdowns, installTestDom, type TestNode } from "../lib/test-dom-harness";
import { CapacityCycleModels } from "./CapacityCycleModels";

const priced: CapacityCycleModel = { name: "model-a", events: 2, tokens: 150, input: 100, cached: 60, cache_write: 10, output: 50,
  fast_tokens: 0, unknown_tokens: 100, priced_tokens: 150, unpriced_events: 0, api_standard: 1, credits_low: 25, credits_high: 50, cache_write_in_input: true, pricing_issues: {} };
const unknown = { ...priced, name: "codex-auto-review", unpriced_events: 2, priced_tokens: 0, tokens: 300, input: 250, cache_write: 0,
  api_standard: 0, credits_low: 0, pricing_issues: { missing_rate: { events: 2, tokens: 300 } } };

test("model comparison changes metrics, keeps unpriced traffic and separates cache quantities", async () => {
  setLanguage("en");
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
  const find = (predicate: (node: TestNode) => boolean) => nodes(dom.host).find(predicate)!;
  try {
    await act(async () => root.render(<CapacityCycleModels models={[priced, unknown]} creditsAvailable />));
    expect(dom.host.textContent).toContain("No valuation");
    expect(dom.host.textContent).toContain("300 tokens without valuation");
    const select = dropdowns(dom.host)[0]!;
    await chooseOption(select, "tokens");
    const bars = nodes(dom.host).filter(node => node.attributes.role === "img");
    expect(bars.some(node => node.attributes["aria-label"]?.startsWith("Codex internal review · 300"))).toBe(true);
    const pricedBar = bars.find(node => node.attributes["aria-label"]?.startsWith("model-a"))!;
    expect(pricedBar.children[0]!.children.map(node => node.attributes.title)).toEqual(["Input without cache: 30", "Cache read: 60", "Cache write: 10", "Output: 50"]);
    await chooseOption(select, "credits_low");
    expect(find(node => node.attributes.role === "img" && !!node.attributes["aria-label"]?.startsWith("model-a")).attributes["aria-label"]).toContain("model-a · 25");
    await act(async () => root.render(<CapacityCycleModels models={[priced]} creditsAvailable={false} />));
    expect((await dropdownOptions(dropdowns(dom.host)[0]!)).map(option => option.label)).toEqual(["API · USD", "Tokens"]);
    expect(dom.host.textContent).not.toContain("Credits");
  } finally { await act(async () => root.unmount()); dom.restore(); }
});

test("partial monetary totals remain lower bounds and empty cycles stay explicit", () => {
  const html = renderToStaticMarkup(<CapacityCycleModels models={[{ ...priced, unpriced_events: 1, priced_tokens: 75 }]} creditsAvailable />);
  expect(html).toContain("≥ $1.00");
  expect(html).toContain("≥ 25");
  expect(html).toContain("75 tokens without valuation");
  expect(renderToStaticMarkup(<CapacityCycleModels models={[]} creditsAvailable />)).toContain("No recorded model usage in this cycle.");
});

test("model rows preview complete splits and retain stored prices for incomplete rows", () => {
  setLanguage("en");
  const row = { ...priced, context_api_base: 1, context_api_extra: 2, context_priced_tokens: priced.priced_tokens };
  const render = (contextImpact: boolean) => renderToStaticMarkup(<CapacityCycleModels models={[row,
    { ...row, name: "incomplete", context_priced_tokens: 1 }]} creditsAvailable contextImpact={contextImpact} />);
  const off = render(false), on = render(true);
  expect(off).toContain("model-a · $1.00");
  expect(on).toContain("model-a · $3.00");
  expect(on).toContain("incomplete · $1.00");
  expect(render(false)).toBe(off);
  expect(row.api_standard).toBe(1);
});

test("model table shows API per 1M priced tokens, cache share and a total row", () => {
  setLanguage("pl");
  const other = { ...priced, name: "model-b", events: 43, tokens: 1_000_000, input: 900_000, cached: 450_000, output: 100_000, priced_tokens: 500_000,
    unpriced_events: 3, api_standard: 2, pricing_issues: { missing_rate: { events: 3, tokens: 500_000 } } };
  const html = renderToStaticMarkup(<CapacityCycleModels models={[priced, other]} creditsAvailable={false} />).replace(/ /g, " ");
  expect(html).toContain("6666,67 USD"); // 1 USD over 150 priced tokens
  expect(html).toContain("4,00 USD"); // 2 USD over 500 000 priced tokens, unpriced half left out
  expect(html).toContain("60,0%");
  expect(html).toContain("50,0%");
  expect(html).toContain("Razem");
  expect(html).toContain("45 żądań");
  expect(html).toContain("≥ 3,00 USD");
  expect(html).toContain("43 żądania");
  expect(html).toContain("(3 żądania)");
  expect(html).toContain("2 modele · Od największego zużycia");
  setLanguage("en");
});

test("polish plural follows the 2-4 rule except the teens", async () => {
  const { polishPlural } = await import("../lib/format");
  expect([1, 2, 4, 5, 12, 14, 22, 43, 112, 1445, 21549].map(n => polishPlural(n, "a", "b", "c")).join("")).toBe("abbcccbbccc");
});
