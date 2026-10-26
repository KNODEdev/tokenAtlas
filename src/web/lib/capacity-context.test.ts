import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CapacityCycleList } from "../components/CapacityCycleList";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { capacityContextParts, capacityWithContext, capacityWithoutContext, contextPremiumIncluded, usageWithContext } from "./capacity-context";
import { setLanguage } from "./i18n";

const window: CodexComparisonWindow = { id: "context", account: "codex1", plan: "pro", window_minutes: 10080,
  start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z", reset: "2026-09-08T00:00:00Z",
  start_percent: 0, end_percent: 50, observed_pp: 50, probes: 2, max_gap_hours: 1, sources: [], models: [],
  usage: { events: 10, tokens: 1000, input: 900, cached: 800, output: 100, fast_tokens: 0, unknown_tokens: 0,
    priced_tokens: 800, unpriced_events: 2, api_standard: 200, api_normalized: 300, credits_low: 0, credits_high: 0,
    context_known_tokens: 800, context_long_tokens: 400, context_long_events: 4,
    context_priced_tokens: 800, context_api_base: 240, context_api_extra: 60 } };

test("one usage row toggles the uplift without losing model/source fields or changing other measures", () => {
  const row = { ...window.usage, name: "model-a", machine: "desktop" };
  const off = usageWithContext(row, false);
  expect(off).toEqual({ ...row, api_standard: 160, api_normalized: 240 });
  expect(usageWithContext(off, true)).toEqual(row);
  expect(usageWithContext(row, true)).toBe(row);
  expect(usageWithContext(off, false)).toBe(off);
});

test("a usage row without a complete split or valuation keeps its stored amount", () => {
  for (const patch of [{ context_priced_tokens: 700 }, { context_api_extra: undefined }, { context_api_extra: 20 },
    { events: 2, unpriced_events: 2 }]) {
    const row = { ...window.usage, ...patch };
    expect(usageWithContext(row, true)).toBe(row);
    expect(usageWithContext(row, false)).toBe(row);
  }
});
test("API split follows the displayed normalized/promotion basis; tokens are a subset, including unknown coverage", () => {
  expect(capacityContextParts(window, "api_standard", 600)).toEqual({ base: 480, extra: 120, longTokens: 400,
    longEvents: 4, share: 40, unknownTokens: 200 });
  expect(capacityContextParts(window, "api_standard", 300)!.extra).toBe(60);
  expect(capacityContextParts(window, "tokens", 2000)).toMatchObject({ base: 1200, extra: 800, share: 40 });
  expect(capacityContextParts(window, "credits_low", 100)).toBeNull();
});
test("absent, inconsistent and partial price splits stay unavailable; known disabled uplift is zero", () => {
  for (const patch of [{ context_known_tokens: undefined }, { context_api_extra: undefined }, { context_api_extra: 20 },
    { context_priced_tokens: 700 }, { context_long_tokens: 900 }, { context_known_tokens: 0, context_long_tokens: 0 }]) {
    expect(capacityContextParts({ ...window, usage: { ...window.usage, ...patch } }, "api_standard", 600)).toBeNull();
  }
  expect(capacityContextParts({ ...window, usage: { ...window.usage, context_api_base: 300, context_api_extra: 0 } }, "api_standard", 600)!.extra).toBe(0);
});
test("the screen's preview exposes two hatched segments, totals and explicit missing classification", () => {
  // The screen prices the windows for its preview and tells the list which one it chose.
  const render = (enabled: boolean) => renderToStaticMarkup(createElement(CapacityCycleList, { windows: [capacityWithContext(window, enabled).window],
    basis: "observed", creditsAvailable: true, contextImpact: enabled,
    referenceScope: "context-test", measuresKey: "context-test", defaultMeasures: ["api_standard", "tokens"], empty: "", subtitle: "" }));
  {
    setLanguage("en");
    const off = render(false), on = render(true);
    expect(off).not.toContain("data-context-segment");
    // Off: API capacity at normal-context rates (240 of 300 normalized → $480 of $600); tokens unchanged.
    expect(off).toContain(">≥ $480</b>");
    expect(off).toContain("Normal-context rates, without the context price uplift");
    expect(off).not.toContain("Hatching:");
    expect(on).toContain('data-context-segment="api-uplift"');
    expect(on).toContain('data-context-segment="tokens"');
    expect(on).toContain("Normal-context rates: $480 + context price uplift: $120");
    expect(on).toContain("Context not classified: 200");
    expect(on).toContain("minimum");
    expect(on).toContain("Context impact");
    expect(on).toContain(">≥ $600</b>");
    expect(on).not.toContain("NaN");
  }
});

test("context-free values scale standard and normalized API by the base share and keep incomplete splits", () => {
  const free = capacityWithoutContext({ ...window, cycle_usage: { ...window.usage, api_standard: 400, api_normalized: 600, context_api_base: 480, context_api_extra: 120 } });
  expect(free.complete).toBe(true);
  // The split stays, so the same cycle can be shown with the uplift again.
  expect(free.window.usage).toMatchObject({ api_standard: 160, api_normalized: 240, tokens: 1000, credits_low: 0, context_api_base: 240, context_api_extra: 60 });
  expect(capacityWithContext(free.window, true).window.usage).toMatchObject({ api_standard: 200, api_normalized: 300 });
  expect(free.window.cycle_usage).toMatchObject({ api_standard: 320, api_normalized: 480 });
  const partial = capacityWithoutContext({ ...window, usage: { ...window.usage, context_priced_tokens: 700 } });
  expect(partial.complete).toBe(false);
  expect(partial.window.usage.api_normalized).toBe(300);
});

test("a provider setting without the premium stores normal values; the uplift is still measured and can be previewed", () => {
  // Premium off: the total is the normal-context value (240) and the measured uplift (60) is not in it.
  const off: CodexComparisonWindow = { ...window, usage: { ...window.usage, api_standard: 160, api_normalized: 240 } };
  expect(contextPremiumIncluded([off])).toBe(false);
  expect(contextPremiumIncluded([window])).toBe(true);
  expect(contextPremiumIncluded([{ ...window, usage: { ...window.usage, context_api_base: 300, context_api_extra: 0 } }])).toBeNull();
  // Nothing to hatch while the value is without the uplift.
  expect(capacityContextParts(off, "api_standard", 480)).toBeNull();
  expect(capacityContextParts(off, "tokens", 2000)).toMatchObject({ extra: 800 });
  const previewed = capacityWithContext(off, true);
  expect(previewed.complete).toBe(true);
  expect(previewed.window.usage).toMatchObject({ api_standard: 200, api_normalized: 300 });
  expect(capacityContextParts(previewed.window, "api_standard", 600)).toMatchObject({ base: 480, extra: 120 });
  expect(capacityWithContext(off, false).window).toEqual(off);
});
