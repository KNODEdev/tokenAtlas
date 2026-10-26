import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexComparisonWindow as Window } from "../../shared/codex-accounting";
import { SubscriptionRevaluation, selectRevaluationPair } from "./SubscriptionRevaluation";
import { setLanguage } from "../lib/i18n";
import { referenceComparisonIssue } from "../../shared/subscription-revaluation";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { chooseOption, dropdowns, installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import type { DataSettingsTarget } from "../lib/data-settings";

const first: Window = {
  id: "a", account: "account", plan: "pro", plan_detail: { status: "resolved", label: "Pro", multiplier: 1 }, window_minutes: 300,
  start: "2026-08-01T01:00:00Z", end: "2026-08-01T03:00:00Z", reset: "2026-08-01T06:00:00Z",
  observed_pp: 50, start_percent: 0, end_percent: 50, probes: 3, max_gap_hours: 1, models: [], sources: [],
  usage: { events: 2, tokens: 100, input: 100, cached: 20, output: 0, fast_tokens: 0, unknown_tokens: 10, unpriced_events: 1, priced_tokens: 50,
    api_standard: 10, credits_low: 0, credits_high: 0, revaluation_events: 1, revaluation_tokens: 50, paired_historical_api: 10, paired_reference_api: 5 },
};
const second: Window = { ...first, id: "b", start: "2026-08-02T01:00:00Z", end: "2026-08-02T03:00:00Z", reset: "2026-08-02T06:00:00Z", usage: { ...first.usage, paired_historical_api: 5 } };
function render(windows: Window[] | null = [first, second]) {
  setLanguage("en");
  return renderToStaticMarkup(<SubscriptionRevaluation windows={windows} referenceDay="2026-08-12" />);
}

test("renders same-cohort price-only change, measured coverage, time and confounders", () => {
  const html = render();
  for (const text of ["2026-08-12", "2026-08-01 01:00 UTC", "Historical USD / 100 pp", "1 / 2 (50%)", "50 / 100 (50%)", "$20.00", "$10.00", "$0.00", "remaining work difference", "Cycle quality", "Model share", "nominal allowance reduction", "actual bills"]) expect(html).toContain(text);
  expect(html).not.toContain("Comparison unavailable");
});
test("missing rates retain independent evidence and a specific rejection; valid zero stays zero", () => {
  const missing = { ...second, usage: { ...second.usage, revaluation_events: 0 } };
  expect(render([first, missing])).toContain("no requests priced by both");
  expect(render([first, missing])).toContain("$20.00");
  expect(render([first, { ...second, usage: { ...second.usage, paired_historical_api: 0, paired_reference_api: 0 } }])).toContain("$0.00");
});
test("unresolved plans, multiplier, duration, overlap and small samples have explicit reasons", () => {
  for (const [patch, issue] of [
    [{ plan_detail: { status: "mixed", label: "Mixed", multiplier: null } }, "unresolved_plan"],
    [{ plan_detail: { status: "resolved", label: "Pro", multiplier: 5 } }, "different_multiplier"],
    [{ window_minutes: 10080 }, "different_duration"], [{ account: "other" }, "different_account"],
    [{ reset: first.reset }, "same_reset"], [{ start: first.start }, "overlapping_cycles"], [{ observed_pp: 2 }, "small_sample"],
  ] as const) {
    const changed = { ...second, ...patch } as Window;
    expect(referenceComparisonIssue(first, changed)).toBe(issue);
    expect(render([first, changed])).toContain("Comparison unavailable");
  }
});
test("default pair skips invalid cycles, retained IDs resolve current objects, stale IDs fall back", () => {
  const invalid = { ...first, id: "invalid", plan_detail: undefined };
  const selection = selectRevaluationPair([invalid, second, first], "stale", "stale");
  expect(selection.first?.id).toBe("a"); expect(selection.second?.id).toBe("b");
  const refreshed = { ...first, observed_pp: 75 };
  expect(selectRevaluationPair([refreshed, second], "a", "b").first).toBe(refreshed);
  expect(selectRevaluationPair([second], "a", "b").first).toBe(second);
});
test("null and empty scopes explain missing cycles and Polish text is localized", () => {
  expect(render(null)).toContain("without a project filter");
  expect(render([])).toContain("No cycles remain");
  setLanguage("pl");
  const html = renderToStaticMarkup(<SubscriptionRevaluation windows={[first, second]} referenceDay="2026-08-12" />);
  expect(html).toContain("Wspólnie wycenione"); expect(html).toContain("wpływ cen");
  setLanguage("en");
});

test("correction links retain ordered cycle dates and route plan differences to subscription settings", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const targets: DataSettingsTarget[] = [];
  const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
  const selects = () => dropdowns(dom.host);
  const review = () => nodes(dom.host).find(n => n.tagName === "BUTTON" && n.textContent === "Review comparison data")!;
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionRevaluation windows={[first, second]} referenceDay="2026-08-12" openDataSettings={target => targets.push(target)} />));
    await chooseOption(selects()[0]!, "b");
    await chooseOption(selects()[1]!, "a");
    expect(dom.host.textContent).toContain("chronological order");
    await invoke(review(), "onClick", {});
    expect(targets.at(-1)).toMatchObject({ area: "data", since: "2026-08-01", until: "2026-08-02" });
    await act(async () => root.render(<SubscriptionRevaluation windows={[first, { ...second, plan: "plus", plan_detail: { status: "resolved", label: "Plus", multiplier: 1 } }]} referenceDay="2026-08-12" openDataSettings={target => targets.push(target)} />));
    await invoke(review(), "onClick", {});
    expect(targets.at(-1)).toMatchObject({ area: "subscriptions", since: "2026-08-01", until: "2026-08-02" });
  } finally { await act(async () => root.unmount()); dom.restore(); }
});
