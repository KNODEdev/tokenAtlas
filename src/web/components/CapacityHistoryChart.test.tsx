import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import type { CodexComparisonWindow, TimelineMarker } from "../../shared/codex-accounting";
import { setLanguage } from "../lib/i18n";
import { CapacityHistoryChart, capacityChartValue, markerDays, markerLaneLayout, markerShortLabel, separatedLabels, textWidth } from "./CapacityHistoryChart";

const astra: TimelineMarker = { id: "model:gpt-6-astra", day: "2026-08-05", observed_at: "2026-08-05T13:00:00Z", label: "6-astra", note: "", color: "accent", visible: true };
const astraPrice: TimelineMarker = { id: "price:configured:gpt-6-astra:2026-08-05", day: "2026-08-05", label: "gpt-6-astra · configured price change", note: "Zmiana wynikająca z okresów cennika.", color: "warn", visible: true };
const miniPrice: TimelineMarker = { ...astraPrice, id: "price:configured:gpt-6-mini:2026-08-05", label: "gpt-6-mini · configured price change" };

const cycle = (id: string, start: string, reset: string): CodexComparisonWindow => ({
  id, account: "codex1", plan: "pro", plan_detail: { label: "Pro (20x)", multiplier: 20, status: "resolved" }, start, end: start, reset,
  start_percent: 0, end_percent: 70, observed_pp: 70, probes: 10, max_gap_hours: 1,
  usage: { events: 100, unpriced_events: 0, tokens: 100, input: 90, cached: 80, output: 10, fast_tokens: 0, unknown_tokens: 50,
    priced_tokens: 100, api_standard: 1400, credits_low: 35000, credits_high: 70000 }, sources: [], models: [],
});
const chart = (windows: CodexComparisonWindow[], markers: TimelineMarker[] = []) => renderToStaticMarkup(<CapacityHistoryChart windows={windows} unit="api_standard" basis="observed"
  median={{ value: null, plan: "Pro ×20", count: 0, reason: "too_few" }} markers={markers} since="2026-08-01" until="2026-08-24" title="Capacity" subtitle="cycles" />);

it("measures its full container when data arrives after an empty first render and keeps measuring resizes", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  let measured: Element | null = null;
  let resize!: (width: number) => void;
  let disconnected = false;
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
      resize = width => callback([{ contentRect: { width } }]);
    }
    observe(element: Element) { measured = element; resize(1900); }
    disconnect() { disconnected = true; }
  } });
  const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
  const render = (windows: CodexComparisonWindow[]) => root.render(<CapacityHistoryChart windows={windows} unit="api_standard" basis="observed"
    median={{ value: null, plan: null, count: 0, reason: "too_few" }} markers={[]} since="2026-08-01" until="2026-08-24" title="Capacity" subtitle="cycles" />);
  try {
    await act(async () => render([]));
    expect(measured).not.toBeNull();
    await act(async () => render([cycle("a", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z")]));
    const svg = () => nodes(dom.host).find(node => node.tagName === "SVG")!;
    expect(svg().getAttribute("width")).toBe("1900");
    await act(async () => resize(1650));
    expect(svg().getAttribute("width")).toBe("1650");
    expect(nodes(dom.host).find(node => node.className === "capacity-chart")).toBe(measured as unknown as TestNode);
  } finally {
    await act(async () => root.unmount());
    if (previous) Object.defineProperty(globalThis, "ResizeObserver", previous); else Reflect.deleteProperty(globalThis, "ResizeObserver");
    dom.restore();
  }
  expect(disconnected).toBe(true);
});

describe("capacity chart markers", () => {
  it("filters each event type before grouping, clears its tooltip, and remembers hide/show choices", async () => {
    setLanguage("en");
    const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
    const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
    const markers: TimelineMarker[] = [astra, astraPrice,
      { ...astra, id: "reset:confirmed", day: "2026-08-06", observed_at: undefined, label: "Global reset", color: "crit" },
      { ...astra, id: "promotion:offer", day: "2026-08-07", observed_at: undefined, label: "Promotion" },
      { ...astra, id: "custom:context", day: "2026-08-08", observed_at: undefined, label: "Context increased" },
    ];
    const render = (key: string) => root.render(<CapacityHistoryChart key={key}
      windows={[cycle("a", "2026-08-01T00:00:00Z", "2026-08-10T00:00:00Z")]}
      unit="api_standard" basis="observed" median={{ value: null, plan: null, count: 0, reason: "too_few" }}
      markers={markers} since="2026-08-01" until="2026-08-24" title="Capacity" subtitle="cycles" />);
    const points = () => nodes(dom.host).filter(node => node.getAttribute("class") === "capacity-marker");
    const open = async () => act(async () => { await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.includes("Events ·"))!, "onClick"); });
    const toggle = async (label: string, checked: boolean) => act(async () => {
      const option = nodes(dom.host).find(node => node.tagName === "LABEL" && node.textContent === label)!;
      await invoke(nodes(option).find(node => node.tagName === "INPUT")!, "onChange", { target: { checked } });
    });
    const all = async () => act(async () => { await invoke(nodes(dom.host).find(node => node.getAttribute("class") === "ui-legend-all")!, "onClick"); });
    const sampleTitle = () => nodes(dom.host).find(node => node.tagName === "TITLE" && node.textContent.includes("0→70%"))?.textContent;
    try {
      await act(async () => render("first"));
      expect(points()).toHaveLength(4);
      const originalSample = sampleTitle();
      expect(originalSample).toBeTruthy();
      await open();
      await act(async () => { await invoke(points()[0]!, "onFocus"); });
      expect(nodes(dom.host).some(node => node.getAttribute("role") === "tooltip")).toBe(true);
      await toggle("Models", false);
      expect(points()[0]!.getAttribute("aria-label")).toBe("gpt-6-astra · configured price change");
      expect(nodes(dom.host).some(node => node.getAttribute("role") === "tooltip")).toBe(false);
      await toggle("Price changes", false);
      expect(points()).toHaveLength(3);
      await toggle("Global resets", false);
      expect(points()).toHaveLength(2);
      await toggle("Promotions", false);
      expect(points()).toHaveLength(1);
      await toggle("Other events", false);
      expect(points()).toHaveLength(0);
      expect(nodes(dom.host).filter(node => node.getAttribute("class") === "is-event")).toHaveLength(0);
      expect(sampleTitle()).toBe(originalSample);
      await act(async () => render("remounted"));
      expect(points()).toHaveLength(0);
      await open();
      await all();
      expect(points()).toHaveLength(4);
      await all();
      expect(points()).toHaveLength(0);
      await toggle("Models", true);
      expect(points()).toHaveLength(1);
      expect(points()[0]!.getAttribute("aria-label")).toBe("6-astra");
      expect(sampleTitle()).toBe(originalSample);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      if (storage) Object.defineProperty(globalThis, "localStorage", storage); else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("keeps a global reset separate from model and price points on the same UTC day", () => {
    setLanguage("en");
    const reset: TimelineMarker = { id: "reset:codex-confirmed", day: astra.day, observed_at: "2026-08-05T15:31:00Z", reset_boundary: { cycle_id: "new", at: "2026-08-05T15:31:00Z" }, label: "Global reset", note: "Completion source", color: "crit", visible: true };
    const days = markerDays([astraPrice, reset, astra]);
    expect(days).toHaveLength(2);
    expect(days[1]!.time).toBe(Date.parse(reset.observed_at!));
    expect(days[1]!.markers).toEqual([reset]);
    expect(days[1]!.short).toBe("↻ Global reset");
    const html = chart([cycle("a", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z")], [astraPrice, reset, astra]);
    expect(html.match(/class="capacity-marker"/g)).toHaveLength(2);
    const resetLine = html.match(/<line[^>]+stroke="var\(--crit\)"[^>]*>/)![0];
    expect(resetLine).toContain('stroke-width="1.5"');
    expect(resetLine).not.toContain("stroke-dasharray");
    expect(html).toContain("border-color:var(--crit);border-left-style:solid");
    expect(html).toContain("↻ global reset");
  });
  it("draws one line and one label per day, with configured price changes in the interface language", () => {
    setLanguage("en");
    expect(markerDays([astraPrice, astra, miniPrice]).map(day => day.label)).toEqual(["6-astra + price change"]);
    expect(markerDays([astraPrice]).map(day => day.label)).toEqual(["gpt-6-astra · configured price change"]);
    setLanguage("pl");
    expect(markerDays([astraPrice]).map(day => day.label)).toEqual(["gpt-6-astra · skonfigurowana zmiana cen"]);
    expect(markerDays([{ ...astraPrice, label: "Własny opis" }]).map(day => day.label)).toEqual(["Własny opis"]);
    const html = chart([cycle("a", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z")], [astra, astraPrice]);
    // One short label per day; the full names are the line's accessible name and its hover card.
    expect(html.match(/>\+\$ 6-astra<\/text>/g)).toHaveLength(1);
    expect(html).toContain('aria-label="6-astra, gpt-6-astra · skonfigurowana zmiana cen"');
    expect(html).not.toContain("configured price change");
    expect(html).not.toContain("Zmiana wynikająca");
    setLanguage("en");
  });
  it("names a day by glyphs and its first name, counting the rest", () => {
    setLanguage("en");
    expect(markerShortLabel([astra, astraPrice])).toBe("+$ 6-astra");
    expect(markerShortLabel([astra, astraPrice, miniPrice])).toBe("+$ 6-astra +1");
    expect(markerShortLabel([miniPrice])).toBe("$ gpt-6-mini");
    expect(markerShortLabel([{ ...astra, id: "event:sol", label: "Sol promotion · API changed" }])).toBe("Sol promotion · API changed");
  });
  it("puts each label in the lowest free lane and leaves out one that fits none", () => {
    const layout = markerLaneLayout([
      { left: 100, text: "+ gpt-5.5" },
      { left: 110, text: "$ gpt-5.4" },
      { left: 170, text: "+ far-away" },
      { left: 120, text: "+$ third" },
      { left: 125, text: "+ fourth" },
      { left: 130, text: "+ fifth" },
    ], 1000, 4);
    expect(layout.map(item => item?.lane ?? null)).toEqual([0, 1, 0, 2, 3, null]);
    // A label at the right edge is pulled left so it stays inside the chart.
    expect(markerLaneLayout([{ left: 995, text: "+ edge" }], 1000)[0]).toEqual({ lane: 0, text: "+ edge", start: 1000 - textWidth("+ edge", 10) });
  });
  it("reserves lower lanes for resets, middle lanes for promotions and higher lanes for other information", () => {
    const labels = markerLaneLayout([
      { left: 100, text: "Other info", level: 2 },
      { left: 110, text: "Global reset", level: 0 },
      { left: 115, text: "Promotion", level: 1 },
      { left: 120, text: "Another reset", level: 0 },
    ], 1000);
    expect(labels.map(label => label?.lane)).toEqual([4, 0, 2, 1]);
  });
});

describe("capacity chart value labels", () => {
  it("keeps labels in priority order and drops those that would overlap", () => {
    const box = (left: number, top = 0) => ({ left, right: left + textWidth("$2,000", 11), top, bottom: top + 11 });
    expect(separatedLabels([box(0), box(30), box(60), box(30, 20)])).toEqual([true, false, true, true]);
    expect(separatedLabels([box(0)], [box(20)])).toEqual([false]);
  });
  it("labels the newest cycle and leaves out a neighbour's colliding label", () => {
    setLanguage("en");
    // About 41px per day: one-day cycles are labelled, but equal values side by side collide.
    const html = chart([
      cycle("a", "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"),
      cycle("b", "2026-08-02T00:00:00Z", "2026-08-03T00:00:00Z"),
      cycle("c", "2026-08-10T00:00:00Z", "2026-08-11T00:00:00Z"),
    ]);
    expect(html.match(/>\$2,000<\/text>/g)).toHaveLength(2);
    expect(html.match(/font-weight="600"[^>]*>\$2,000<\/text>/g)).toHaveLength(1);
  });
  it("leaves out a segment's 100% mark under a neighbour's value label", () => {
    setLanguage("en");
    const full = { ...cycle("full", "2026-08-01T00:00:00Z", "2026-08-04T00:00:00Z"), end_percent: 100, observed_pp: 100 };
    full.usage = { ...full.usage, api_standard: 2000 };
    expect(chart([full]).match(/>100%<\/text>/g)).toHaveLength(1);
    // The newest cycle's label ($1,777) sits just below the full cycle's line, where its 100% mark is.
    const next = cycle("next", "2026-08-04T00:00:00Z", "2026-08-04T12:00:00Z");
    next.usage = { ...next.usage, api_standard: 1244 };
    const html = chart([full, next]);
    expect(html).toContain(">$1,777</text>");
    expect(html).not.toContain(">100%</text>");
  });
});

describe("capacity chart scale", () => {
  const pro = cycle("a", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
  const plus = { ...cycle("b", "2026-08-08T00:00:00Z", "2026-08-15T00:00:00Z"), plan: "plus", plan_detail: { label: "Plus", multiplier: 1, status: "resolved" as const } };
  const unknown = { ...cycle("c", "2026-08-15T00:00:00Z", "2026-08-22T00:00:00Z"), plan: null, plan_detail: undefined };
  it("plots capacity at 100%, per 1 pp, or per 1 pp divided by the tier", () => {
    expect(capacityChartValue(pro, "api_standard", "observed", "full")).toBe(2000);
    expect(capacityChartValue(pro, "api_standard", "observed", "point")).toBe(20);
    expect(capacityChartValue(pro, "api_standard", "observed", "tier")).toBe(1);
    expect(capacityChartValue(plus, "api_standard", "observed", "tier")).toBe(20);
    expect(capacityChartValue(unknown, "api_standard", "observed", "tier")).toBeNull();
  });
  it("offers the three scales and lists every tier colour", () => {
    setLanguage("en");
    const html = chart([pro, plus]);
    for (const label of ["At 100%", "Per 1%", "Per 1% as ×1"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain("×1 · Plus");
    expect(html).toContain("×5</span>");
    expect(html).toContain("×20 · Pro");
  });
});

describe("capacity chart context impact", () => {
  const long = (id: string, start: string, reset: string): CodexComparisonWindow => {
    const window = cycle(id, start, reset);
    return { ...window, usage: { ...window.usage, context_known_tokens: 100, context_long_tokens: 40, context_long_events: 3,
      context_priced_tokens: 100, context_api_base: 1000, context_api_extra: 400 } };
  };
  const render = (unit: "api_standard" | "tokens", contextImpact: boolean) => renderToStaticMarkup(<CapacityHistoryChart windows={[long("a", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z")]}
    unit={unit} basis="observed" median={{ value: null, plan: null, count: 0, reason: "too_few" }} markers={[]} since="2026-08-01" until="2026-08-24"
    title="Capacity" subtitle="cycles" contextImpact={contextImpact} />);

  it("hatches the long-context top of each segment only while the switch is on", () => {
    setLanguage("en");
    for (const unit of ["api_standard", "tokens"] as const) {
      const on = render(unit, true);
      expect(on).toMatch(/fill="url\(#capacity-hatch-[^"]*-context-0\)"/);
      expect(on).toContain("context impact</span>");
      const off = render(unit, false);
      expect(off).not.toContain("-context-0");
      expect(off).not.toContain("context impact</span>");
    }
  });
});
