import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { setLanguage } from "../lib/i18n";
import { installTestDom, type TestNode } from "../lib/test-dom-harness";
import { CapacityCycleList } from "./CapacityCycleList";

const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const cycle: CodexComparisonWindow = {
  id: "claude-week", account: "claude-ea41a81ab8dcf86d", plan: "max-20x", plan_detail: { label: "Max · ×20", multiplier: 20, status: "resolved" },
  start: "2026-10-18T10:59:59Z", end: "2026-10-25T10:59:59Z", reset: "2026-10-25T10:59:59Z",
  start_percent: 0, end_percent: 84, observed_pp: 84, probes: 400, max_gap_hours: 1,
  usage: { events: 100, unpriced_events: 0, tokens: 100, input: 90, cached: 80, output: 10, fast_tokens: 0,
    unknown_tokens: 0, priced_tokens: 100, api_standard: 2323.53, credits_low: 0, credits_high: 0 }, sources: [], models: [],
};

test("a cycle's promotional credit is a deviation with its calls and time span in the tooltip", async () => {
  setLanguage("pl");
  for (const [funded, shown] of [
    [{ calls: 1875, tokens: 9, api_standard: 236.19, api_unpriced: 0, first: "2026-10-18T22:26:53.329Z", last: "2026-10-20T00:17:13.198Z" }, true],
    [{ calls: 3, tokens: 9, api_standard: 0.1792, api_unpriced: 0, first: "2026-10-02T06:47:29.382Z", last: "2026-10-02T06:47:35.405Z" }, true],
    [undefined, false],
  ] as const) {
    const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
    try {
      await act(async () => root.render(<CapacityCycleList windows={[{ ...cycle, ...(funded ? { credit_funded: funded } : {}) }]} markers={[]}
        basis="observed" creditsAvailable={false} referenceScope="credit-test" measuresKey="credit-test" defaultMeasures={["api_standard"]}
        empty="" subtitle="" />));
      const flag = nodes(dom.host).find(n => n.getAttribute("class") === "capacity-flag" && n.textContent.startsWith("z kredytu promocyjnego"));
      expect(!!flag).toBe(shown);
      if (flag) {
        expect(flag.textContent).toBe(funded!.calls === 3 ? "z kredytu promocyjnego: 0,18 USD" : "z kredytu promocyjnego: 236 USD");
        expect(flag.getAttribute("title")).toBe(funded!.calls === 3 ? "3 wywołania · 02.10 06:47 → 02.10 06:47 UTC"
          : "1875 wywołań · 18.10 22:26 → 20.10 00:17 UTC");
        expect(flag.getAttribute("data-warn")).toBeNull();
      }
    } finally { await act(async () => root.unmount()); dom.restore?.(); }
  }
});
