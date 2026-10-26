import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installTestDom, invoke, type TestNode } from "../lib/test-dom-harness";
import type { CodexComparisonWindow, TimelineMarker } from "../../shared/codex-accounting";
import type { ClaudeCodeCapacitySummary } from "../../shared/claude-code-capacity";
import { CodexCapacitySummary } from "./CodexCapacitySummary";
import { CapacityHistoryChart } from "./CapacityHistoryChart";
import { I18nProvider, setLanguage } from "../lib/i18n";
import { alignProviderResetMarkers } from "../lib/capacity-reset-markers";

const pro = { label: "Pro (20x)", multiplier: 20, status: "resolved" as const };
const before: CodexComparisonWindow = {
  id: "before", account: "codex1", plan: "pro", plan_detail: pro, start: "2026-08-01T00:00:00Z", end: "2026-08-03T00:00:00Z", reset: "2026-08-08T00:00:00Z",
  start_percent: 0, end_percent: 70, observed_pp: 70, probes: 10, max_gap_hours: 1,
  usage: { events: 100, unpriced_events: 0, tokens: 100, input: 90, cached: 80, output: 10, fast_tokens: 0, unknown_tokens: 50,
    priced_tokens: 100, api_standard: 1400, credits_low: 35000, credits_high: 70000 }, sources: [], models: [],
};
const after: CodexComparisonWindow = { ...before, id: "after", start: "2026-09-01T00:00:00Z", end: "2026-09-03T00:00:00Z", reset: "2026-09-08T00:00:00Z",
  usage: { ...before.usage, api_standard: 910, credits_low: 25200, credits_high: 37800 } };
const select = () => {};
const render = (windows: CodexComparisonWindow[], props: Partial<Parameters<typeof CodexCapacitySummary>[0]> = {}) =>
  renderToStaticMarkup(<CodexCapacitySummary windows={windows} onBaseline={select} onCurrent={select} {...props} />);
const list = (html: string) => html.slice(html.indexOf("capacity-row-head"), html.indexOf("Token types by cycle"));
const tokenChart = (html: string) => html.slice(html.indexOf("Token types by cycle"), html.indexOf("capacity-detail capacity-comparison"));

describe("capacity cycles", () => {
  it("shares event-type visibility between chart and cycle dividers, including saved choices", async () => {
    setLanguage("en");
    const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    } });
    const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
    const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
    const base: TimelineMarker = { id: "custom:other", day: "2026-08-13", label: "Other notice", note: "", color: "ok", visible: true };
    const markers: TimelineMarker[] = [
      { ...base, id: "reset:confirmed", day: "2026-08-01", label: "Global reset", color: "crit", reset_boundary: { cycle_id: before.id, at: before.start } },
      { ...base, id: "promotion:offer", day: "2026-08-11", label: "Promotion notice" },
      { ...base, id: "price:offer", day: "2026-08-12", label: "Price notice" },
      { ...base, id: "model:example", day: "2026-08-12", label: "Model notice" },
      base,
    ];
    const renderReport = (key: string) => root.render(<CodexCapacitySummary key={key} windows={[before, after]} markers={markers} onBaseline={select} onCurrent={select} />);
    const withClass = (name: string) => nodes(dom.host).filter(node => node.getAttribute("class")?.split(" ").includes(name));
    const points = () => withClass("capacity-marker");
    const dividers = () => withClass("capacity-event");
    const rows = () => withClass("capacity-row").filter(node => !node.getAttribute("class")?.split(" ").includes("capacity-row-head")).map(node => node.textContent);
    const open = async () => act(async () => { await invoke(nodes(dom.host).find(node => node.tagName === "BUTTON" && node.textContent.includes("Events ·"))!, "onClick"); });
    const all = async () => act(async () => { await invoke(nodes(dom.host).find(node => node.getAttribute("class") === "ui-legend-all")!, "onClick"); });
    try {
      await act(async () => renderReport("first"));
      expect(points()).toHaveLength(4);
      expect(dividers()).toHaveLength(4);
      const originalRows = rows();
      expect(originalRows).toHaveLength(2);
      await open();
      for (const [label, hiddenText, remaining] of [
        ["Models", "Model notice", 4], ["Price changes", "Price notice", 3],
        ["Global resets", "Global reset", 2], ["Promotions", "Promotion notice", 1],
        ["Other events", "Other notice", 0],
      ] as const) {
        await act(async () => {
          const option = nodes(dom.host).find(node => node.tagName === "LABEL" && node.textContent === label)!;
          await invoke(nodes(option).find(node => node.tagName === "INPUT")!, "onChange", { target: { checked: false } });
        });
        expect(points()).toHaveLength(remaining);
        expect(dividers()).toHaveLength(remaining);
        expect(dividers().map(node => node.textContent).join(" ")).not.toContain(hiddenText);
        expect(rows()).toEqual(originalRows);
      }
      await act(async () => renderReport("restored"));
      expect(points()).toHaveLength(0);
      expect(dividers()).toHaveLength(0);
      await open();
      await all();
      expect(points()).toHaveLength(4);
      expect(dividers()).toHaveLength(4);
      expect(rows()).toEqual(originalRows);
      await all();
      expect(points()).toHaveLength(0);
      expect(dividers()).toHaveLength(0);
      expect(rows()).toEqual(originalRows);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      if (storage) Object.defineProperty(globalThis, "localStorage", storage); else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  it("renders a 100% Claude cycle using its retained sample, with its own amount and meter bounds", () => {
    setLanguage("en");
    const capacity: ClaudeCodeCapacitySummary = {
      algorithm: 10, rule: "claude-code-local-traffic@3", window_id: "claude-cycle", account: "claude-seat",
      api_value_basis: "standard", basis: "interval", source_from: "2026-09-02T00:00:00Z",
      source_through: "2026-09-03T00:00:00Z", as_of: "2026-09-03T00:00:00Z",
      sample_meter: { start_percent: 20, end_percent: 100, observed_pp: 80 },
      reset_at: "2026-09-08T00:00:00Z", window_started_at: "2026-09-01T00:00:00Z",
      share_percent: 100, utilization_percent: 100, conditional: true, reason: null,
      weekly_capacity_api_usd: { value: 2000, absent: null }, weekly_capacity_tokens: { value: 10000, absent: null },
      account_total_api_usd: { value: null, absent: "not_cumulative" }, account_total_tokens: { value: null, absent: "not_cumulative" },
      observed_code_api_usd: 1600, observed_code_tokens: 8000,
      coverage: { product_rule: "claude-code-local-traffic@3", code_events: 20, other_product_events: 0,
        unknown_events: 0, conflicting_product_events: 0, duplicate_copies: 0, conflicting_usage_identities: 0,
        cross_machine: "unconfirmed", complete_from_window_start: false, assumptions: [] },
    };
    const cycle: CodexComparisonWindow = { ...after, id: "claude-cycle", account: "claude-seat", end_percent: 100,
      observed_pp: 100, end: "2026-09-07T00:00:00Z", claude_code_capacity: capacity,
      usage: { ...after.usage, api_standard: 2600, unpriced_events: 1 },
      cycle_usage: { ...after.usage, api_standard: 3100, unpriced_events: 1 } };
    const rows = list(render([cycle], { creditsAvailable: false }));
    expect(rows).toContain('class="capacity-bar-fill"');
    expect(rows).toContain('>≈ $2,000</b>');
    expect(rows).toContain("Paired with the meter: $1,600 over 80 pp (20 → 100%)");
    expect(rows).toContain("Sep 2, 00:00 → Sep 3, 00:00 UTC");
    expect(rows).toContain("≥ $3,100");
    expect(rows).not.toContain("Meter at 100%");
    const history = renderToStaticMarkup(<CapacityHistoryChart windows={[cycle]} markers={[]} unit="api_standard" basis="observed"
      median={{ value: null, plan: "Pro · ×20", count: 0, reason: "too_few" }}
      since="2026-09-01" until="2026-09-08" title="Capacity" subtitle="cycles" />);
    expect(history).toContain("20→100% · 100% ≈ $2,000");
    expect(history).toContain("2026-09-02T00:00:00Z → 2026-09-03T00:00:00Z");
  });
  it("lists cycles newest first, one line per measure: used, capacity, per 1%, a bar in the measure's colour, reference lines and the deviation", () => {
    setLanguage("en");
    const html = render([before, after]);
    const rows = list(html);
    expect(rows.indexOf("$1,300")).toBeLessThan(rows.indexOf("$2,000"));
    // Capacity and its per-1% value sit in their own aligned columns on the same line as the bar.
    expect(rows).toContain('>≈ $1,300</b><span class="mono capacity-right capacity-faint"');
    expect(rows).toContain(">$13.00</span>");
    expect(rows).toContain("Paired with the meter: $910 over 70 pp (0 → 70%)");
    // Each measure has its own colour, never the plan's.
    expect(rows).toContain("background:var(--measure-api)");
    expect(rows).toContain("background:var(--measure-credits)");
    expect(rows).not.toMatch(/capacity-bar-fill" style="[^"]*var\(--violet\)/);
    expect(rows).toContain("−21%");
    expect(rows).toContain("+21%");
    // API $ and credits by default: one draggable reference line per measure over the bars, no median mark.
    expect(rows).not.toContain('class="capacity-median-tick"');
    expect(rows.match(/class="capacity-reference-line"/g)).toHaveLength(2);
    expect(html.match(/class="capacity-reference-control"/g)).toHaveLength(2);
    expect(rows.match(/<article class="capacity-row"/g)).toHaveLength(2);
    expect(rows).toContain('>09/01 00:00<span class="capacity-faint">→ 09/08 00:00</span></button>');
    expect(rows).toContain('<span class="capacity-plan-name" style="color:var(--violet)">Pro · ×20</span>');
    expect(rows).toContain("≈ 36,000");
    expect(rows).not.toMatch(/#\d/);
    expect(html).toContain("Median · Pro · ×20 · 2 cycles ≥ 20 pp");
    expect(html).toContain("≈ $1,650");
    expect(html).toContain("median ≈ $1,650");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
  it("draws the chart's events as dated dividers between the cycles, newest first", () => {
    setLanguage("en");
    const marker = (id: string, day: string, label: string) => ({ id, day, label, note: "", color: "violet" as const, visible: true });
    const rows = list(render([before, after], { markers: [marker("model:a", "2026-08-05", "GPT-A"), marker("model:b", "2026-08-20", "GPT-B"), marker("event:c", "2026-07-15", "Old event")] }));
    const at = (text: string) => rows.indexOf(text);
    expect(rows.match(/class="capacity-event"/g)).toHaveLength(3);
    // Between the cycles, then inside the older one (above it), then before every listed cycle.
    expect(at("09/01 00:00")).toBeLessThan(at("GPT-B"));
    expect(at("GPT-B")).toBeLessThan(at("GPT-A"));
    expect(at("GPT-A")).toBeLessThan(at("08/01 00:00"));
    expect(at("08/01 00:00")).toBeLessThan(at("Old event"));
    expect(rows).toContain('title="GPT-A · 2026-08-05 00:00:00.000 UTC · model date (edited or manual)"');
  });
  it("shows the full event description in the cycle divider", () => {
    setLanguage("en");
    const label = "GPT-6.1 Sol · context 272k → 500k · no subscription surcharge";
    const marker = { id: "custom:sol-context", day: "2026-08-15", label, note: "Source and exact time", color: "ok" as const, visible: true };
    const rows = list(render([before, after], { markers: [marker] }));
    expect(rows).toContain(`aria-haspopup="dialog">${label}</button>`);
    expect(rows).not.toContain("<span>GPT-6.1 Sol</span>");
  });
  it("places global reset confirmations below the new cycle, before the older cycle", () => {
    setLanguage("en");
    for (const [boundary, confirmation, olderStart] of [
      ["2026-09-26T16:58:00Z", "2026-09-26T18:17:00Z", "2026-09-25T08:00:00Z"],
      ["2026-10-11T05:25:00Z", "2026-10-11T04:01:00Z", "2026-10-07T06:19:00Z"],
    ]) {
      const older = { ...before, start: olderStart!, reset: boundary!, end: boundary! };
      const newer = { ...after, start: boundary!, cycle_start: boundary!, start_basis: "reset" as const, end: boundary!, reset: "2026-10-20T00:00:00Z" };
      const reset = { id: "reset:confirmed", day: confirmation!.slice(0, 10), observed_at: confirmation!, label: "Global reset", note: "Public completion", color: "crit" as const, visible: true };
      const rows = list(render([older, newer], { markers: alignProviderResetMarkers([reset], [older, newer]) }));
      const date = (at: string) => `${at.slice(5, 10).replace("-", "/")} ${at.slice(11, 16)}<span`;
      const event = rows.indexOf(">Global reset</button>");
      expect(rows.indexOf(date(boundary!))).toBeLessThan(event);
      expect(event).toBeLessThan(rows.indexOf(date(olderStart!)));
      expect(rows).toContain(confirmation!.replace("T", " ").replace("Z", " UTC"));
    }
  });
  it("keeps other plans and short samples out of the median and flags them on their rows", () => {
    setLanguage("en");
    const plus = { ...before, id: "plus", start: "2026-07-01T00:00:00Z", end: "2026-07-02T00:00:00Z", reset: "2026-07-08T00:00:00Z",
      plan: "plus", plan_detail: { label: "Plus", multiplier: 1, status: "resolved" as const }, usage: { ...before.usage, api_standard: 70 } };
    const small = { ...before, id: "small", start: "2026-08-15T00:00:00Z", end: "2026-08-16T00:00:00Z", reset: "2026-08-22T00:00:00Z", observed_pp: 5, end_percent: 5, max_gap_hours: 3 };
    const html = render([plus, before, small, after]);
    expect(html).toContain("Median · Pro · ×20 · 2 cycles");
    const rows = list(html);
    expect(rows).toContain(">Plus · ×1</span>");
    expect(rows).not.toContain("outside the median&#x27;s plan</span>");
    expect(rows).toContain('vs median<span class="capacity-faint capacity-median-plan">Pro · ×20</span>');
    expect(rows).toContain("small sample 5 pp");
    expect(rows).toContain("gap in limit readings: 3 h");
    const plusRow = rows.slice(rows.indexOf(">Plus · ×1<"));
    expect(plusRow).toContain("Outside the median&#x27;s plan (Pro · ×20): not compared");
  });
  it("switches the tiles and the chart to the selected unit", () => {
    setLanguage("en");
    const credits = render([before, after], { unit: "credits_low" });
    expect(credits).toContain("Capacity at 100% in successive cycles · Credits");
    // Tile values name the credit unit, as dollars carry "$".
    const tiles = credits.slice(0, credits.indexOf("capacity-section"));
    expect(tiles).toMatch(/≈ 36,000<span[^>]*> credits<\/span>/);
    expect(tiles).toContain("360 credits per 1%");
    expect(tiles).toContain("spread 36,000 – 50,000 credits");
    setLanguage("pl");
    expect(render([before, after], { unit: "credits_low" })).toContain(" kred.</span>");
    setLanguage("en");
    const tokens = render([before, after], { unit: "tokens" });
    expect(tokens).toContain("Capacity at 100% in successive cycles · Tokens");
    const noCredits = render([before, after], { unit: "credits_low", creditsAvailable: false });
    expect(noCredits).toContain("· API $");
    expect(noCredits).not.toContain("50,000");
    expect(noCredits).not.toContain(">Credits</label>");
  });
  it("reads a dashed second reference line of the same measure against the first, with the difference between them", () => {
    setLanguage("en");
    // First line pinned to the $1,300 cycle, the second to the $2,000 one.
    const saved = JSON.stringify({ percent: 50, cycleId: "after", badgePosition: null, compare: { percent: 50, cycleId: "before" } });
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => key.startsWith("tokenatlas:capacity-reference:") && key.endsWith(":api_standard") ? saved : null, setItem: () => {} } });
    try {
      const html = render([before, after]);
      const rows = list(html);
      expect(rows.match(/class="capacity-reference-line"/g)).toHaveLength(2);
      expect(rows.match(/class="capacity-reference-line capacity-reference-line-second"/g)).toHaveLength(1);
      expect(rows).toContain('aria-label="API $ comparison line"');
      // The dashed line's badge carries its own cycle's amount.
      expect(rows).toMatch(/capacity-reference-line-second"[^]*?API \$ · 100%: ≈ \$2,000/);
      expect(rows.match(/class="capacity-reference-difference-bracket[^"]*"/g)).toHaveLength(1);
      expect(rows).toContain("+$700 · +54%");
      expect(html).toContain("Δ +$700 · +54% · 1%: +$7.00");
      expect(html).toContain('style="color:var(--ok)"');
      // Both pinned cycles are marked in the list.
      expect(rows.match(/<article class="capacity-row" data-reference="true"/g)).toHaveLength(2);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
  it("shows the chosen measures in each cycle and moves the token types to their own chart", () => {
    setLanguage("en");
    // A stored choice from before the token-type chart still applies its remaining measures.
    const store = new Map([["tokenatlas.capacity-measures.v1", JSON.stringify(["tokens", "token_types"])]]);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null, setItem: () => {} } });
    try {
      const html = render([before, after]);
      const rows = list(html);
      expect(rows).not.toContain(">API $<");
      expect(rows).toContain("≈ 143");
      expect(rows).toContain("background:var(--measure-tokens)");
      expect(html).toMatch(/aria-pressed="true"><i class="capacity-swatch" style="background:var\(--measure-tokens\)"><\/i>Tokens/);
      expect(html).toMatch(/aria-pressed="false"><i class="capacity-swatch" style="background:var\(--measure-api\)"><\/i>API \$/);
      expect(html).not.toContain(">Token types</label>");
      const chart = tokenChart(html);
      expect(chart.match(/class="capacity-token-row" role="row"/g)).toHaveLength(2);
      // Fresh input = input − cache read (no cache write reported): 90 − 80.
      expect(chart).toContain('title="Fresh input · 10 tokens · 10.0% of this cycle"');
      expect(chart).toContain('title="Output incl. reasoning · 10 tokens · 10.0% of this cycle"');
      expect(chart).toContain("Cache write: not reported by this source");
      expect(chart).toContain("does not yet carry the API value of each token type");
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
  it("gives each reported cache write lifetime its own column and scale", () => {
    setLanguage("en");
    const claude = { ...before, id: "claude", usage: { ...before.usage, tokens: 1_000_000_000, input: 999_000_000, cached: 990_000_000, output: 1_000_000,
      cache_write_5m: 6_000_000, cache_write_1h: 2_000_000, cache_write_unknown: 0 } };
    const chart = tokenChart(render([claude]));
    expect(chart).toContain("Cache write 5m");
    expect(chart).toContain("Cache write 1h");
    expect(chart).not.toContain("TTL unknown");
    expect(chart).not.toContain("not reported by this source");
    // Fresh input 1M next to 990M of cache reads still fills its own column.
    expect(chart).toContain('title="Fresh input · 1,000,000 tokens · 0.10% of this cycle"><span class="capacity-token-track"><span class="capacity-token-fill" style="width:100%');
    expect(chart).toContain(">99.0%</b>");
  });
  it("marks a cycle whose plan is not established instead of calling it another plan", () => {
    setLanguage("en");
    const unknown = { ...before, id: "unknown", start: "2026-07-01T00:00:00Z", end: "2026-07-02T00:00:00Z", reset: "2026-07-08T00:00:00Z",
      plan: null, plan_detail: { label: "?", multiplier: null, status: "unknown" as const } };
    const html = render([unknown, before, after]);
    const unknownRow = list(html).slice(list(html).indexOf("07/01 00:00"));
    expect(unknownRow).toContain("plan not established</span>");
    expect(unknownRow).toContain("Plan not established for this period: not compared with the median");
    expect(unknownRow).toContain("Plan not established for this period: not compared with the median");
    expect(unknownRow).not.toContain("tier unknown");
    // The chart legend names the hatch rather than leaving grey unexplained.
    expect(html).toContain('<i class="is-unknown"></i>plan not established for this period');
  });
  it("shows the estimate's basis when the whole cycle used more than the meter sample", () => {
    setLanguage("en");
    const wider = { ...before, cycle_usage: { ...before.usage, api_standard: 2100, credits_low: 52500 } };
    const rows = list(render([wider]));
    expect(rows).toContain('<span class="mono capacity-used-wider">$2,100</span>');
    expect(rows).toContain("Whole cycle, including traffic outside the meter sample. Paired with the meter: $1,400 over 70 pp (0 → 70%)");
    expect(rows).toContain("Used in the whole cycle: $2,100");
  });
  it("labels promotion-free values while retaining actual usage", () => {
    setLanguage("en");
    const w = { ...before, promotion: { status: "configured" as const, factor: 2, regime_ids: [], notes: [], sources: [] } };
    const rows = list(render([w], { basis: "regular" }));
    expect(rows).toContain("$1,400");
    expect(rows).toContain("$1,000");
    // The promotion is a tag beside the plan, not a deviation flag.
    expect(rows).toMatch(/<span class="ui-tag capacity-plan-promo" title="Promotion 2×">promo 2×<\/span>/);
    expect(rows).not.toMatch(/class="capacity-flag"[^>]*>Promotion/);
    expect(rows).not.toContain("$2,000");
  });
  it("keeps missing pricing, missing traffic and missing cycle starts explicit", () => {
    setLanguage("en");
    const missing = { ...after, start_percent: 34, observed_pp: 36, cycle_start: null,
      usage: { ...after.usage, events: 0, tokens: 0, input: Number.NaN, cached: 0, output: Number.NaN } };
    const unpriced = { ...before, usage: { ...before.usage, unpriced_events: 100 } };
    const rows = list(render([missing, unpriced]));
    expect(rows).toContain("Meter only · no matched traffic");
    expect(rows).toContain("Traffic recorded · missing prices");
    expect(rows).toContain("? uncertain boundary");
    expect(rows).toContain("from 34%");
    expect(rows).toContain("No data");
    expect(rows).not.toContain("NaN");
  });
  it("keeps below-minimum cycles in the list with tentative estimates and warnings", () => {
    setLanguage("en");
    const rows = [9, 10, 90, 92].map((pp, index) => ({ ...before, id: `pp${pp}`, start: `2026-06-0${index + 1}T00:00:00Z`, observed_pp: pp }));
    expect(render(rows, { minObservedPercent: 10 }).match(/<article class="capacity-row"/g)).toHaveLength(4);
    expect(render(rows, { minObservedPercent: 92 }).match(/<article class="capacity-row"/g)).toHaveLength(4);
    const small = { ...after, observed_pp: 4, end_percent: 4, usage: { ...after.usage, api_standard: 40 } };
    const html = render([small], { minObservedPercent: 10 });
    expect(list(html)).toContain('data-warn="true">below minimum 4 &lt; 10 pp · tentative estimate');
    expect(list(html)).toContain('>≈ $1,000</b>');
    expect(list(html)).toContain('>$10.00</span>');
    expect(html).not.toContain("No cycles meet the minimum observed usage filter");
  });
  it("shows the view chosen in the screen's tab row, keeps the others mounted, and leaves the caveats to Methodology", () => {
    setLanguage("en");
    const chart = render([before, after], { mode: "overview" });
    expect(chart).toMatch(/<div class="capacity-history">/);
    expect(chart).toMatch(/<div hidden=""><div class="capacity-section"><div class="capacity-section-head/);
    expect(chart).not.toContain("Estimate uncertainty and meter rounding");
    const cycles = render([before, after], { tab: "cycles" });
    expect(cycles).toMatch(/<div class="capacity-history" hidden="">/);
    expect(cycles).toMatch(/<div><div class="capacity-section"><div class="capacity-section-head/);
    expect(render([before, after], { tab: "compare" })).toMatch(/<div class="capacity-detail capacity-comparison">/);
    const methodology = render([before, after], { mode: "methodology" });
    expect(methodology).toContain("Uncertainty of the last measurement");
    expect(methodology.match(/<li><span>/g)).toHaveLength(5);
    expect(methodology.match(/class="capacity-band-row"/g)).toHaveLength(3);
    expect(methodology).not.toContain("capacity-tab-panel");
    // Comparison: before → after tiles per unit, no table and no paragraph on screen.
    const compared = render([before, after], { mode: "overview", tab: "compare", baseline: before, current: after });
    const panel = compared.slice(compared.indexOf("capacity-detail capacity-comparison"));
    expect(panel.match(/class="ui-kpi-cell"/g)).toHaveLength(3);
    expect(panel).toContain('class="capacity-compare-arrow">→</span>');
    expect(panel).not.toContain("<table");
    expect(panel).not.toContain("<p>");
  });
  it("changing the optional comparison does not change the history", () => {
    const html = (baseline: CodexComparisonWindow) => render([before, after], { baseline, current: after });
    const history = (value: string) => value.split(/<div[^>]*class="capacity-detail capacity-comparison">/)[0]!;
    expect(history(html(before))).toBe(history(html(after)));
    expect(html(before)).toContain("−35%");
  });
});

describe("capacity tiles", () => {
  it("shows the running cycle, the last closed measurement with its rounding band and the median", () => {
    setLanguage("en");
    const now = Date.now();
    const running = { ...before, id: "running", start: new Date(now - 86_400_000).toISOString(), end: new Date(now - 3_600_000).toISOString(),
      reset: new Date(now + 6 * 86_400_000).toISOString(), cycle_end_basis: "scheduled" as const, end_percent: 6, observed_pp: 6 };
    const html = render([before, after], { allWindows: [before, after, running], minObservedPercent: 10 });
    expect(html).toContain("Current cycle · since");
    expect(html).toContain("scheduled reset");
    expect(html).toContain("below minimum · tentative estimate");
    expect(html).toContain("Last measurement · ");
    expect(html).toContain("≈ $1,300");
    expect(html).toContain("$13.00 per 1% · sample 0 → 70% (reset)");
    expect(html).toContain("−21%</span> vs median");
    expect(html).toContain("±1 pp: $1,264–$1,338");
  });
  it("says why there is no median instead of showing one", () => {
    setLanguage("en");
    expect(render([before])).toContain("fewer than 2 cycles of Pro · ×20 with ≥ 20 pp and medium or high confidence");
    expect(render([{ ...before, plan_detail: undefined }])).toContain("the newest cycle&#x27;s plan is not confirmed");
  });
  it("renders Polish copy", () => {
    try {
      setLanguage("pl");
      const html = renderToStaticMarkup(<I18nProvider><CodexCapacitySummary windows={[before, after]} baseline={before} current={after} onBaseline={select} onCurrent={select} /></I18nProvider>);
      expect(html).toContain("Pojemność 100% w kolejnych cyklach");
      expect(html).toContain("Mediana · Pro · ×20 · 2 cykle ≥ 20 p.p.");
      expect(html).toContain("Wcześniejszy cykl");
      expect(html).toContain("najnowsze na górze");
    } finally { setLanguage("en"); }
  });
});
