import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "bun:test";
import type { RateCardsResponse } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import { RateCardsPanel } from "./RateCardsPanel";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const data = { version: 2, currency: "USD", unit: "1M", subscriptions: [], monthly_total_usd: 0,
  vendors: [{ vendor: "openai", models: [], notes: [] }, { vendor: "xai", models: [], notes: [] }] } as unknown as RateCardsResponse;

test("an unpriced Codex model opens the dated price-period editor from its first day; other vendors keep the quick form", async () => {
  setLanguage("en");
  const dom = installTestDom();
  const root = createRoot(dom.host as unknown as Element);
  const opened: Array<[string, string | undefined]> = [];
  try {
    await act(async () => root.render(<RateCardsPanel data={data} onPriceCodexModel={(model, since) => opened.push([model, since])} unpriced={{
      tokens: 12,
      items: [
        { model: "gpt-new-sol", observed_provider: "openai", rate_vendor: "openai", tokens: 10, reason: "missing_rate", first_day: "2026-09-30" },
        { model: "grok-new", observed_provider: "xai", rate_vendor: "xai", tokens: 2, reason: "missing_rate", first_day: "2026-10-01" },
        { model: "stealth/x", observed_provider: "openrouter", rate_vendor: null, tokens: 5, reason: "no_rate_card" },
      ],
    }} />));
    expect(dom.host.textContent).toContain("no rate in rate-cards.json");
    expect(dom.host.textContent).toContain("no rate card for openrouter");
    const buttons = nodes(dom.host).filter(node => node.tagName === "BUTTON" && node.textContent.includes("price model"));
    expect(buttons.length).toBe(2);
    await invoke(buttons[0]!, "onClick");
    expect(opened).toEqual([["gpt-new-sol", "2026-09-30"]]);
    await invoke(buttons[1]!, "onClick");
    expect(opened.length).toBe(1);
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});
