import { test, expect, spyOn } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Database } from "../../db/sqlite";
import { buildSubscriptionAccountingReport } from "../../server/subscription-accounting";
import { emptyPreparedDatabase } from "../../server/subscription-reader.fixture";
import type { RateCard } from "../../server/pricing";
const EMPTY_RATES = { version: 1, currency: "USD", unit: "per 1M", vendors: {} } as unknown as RateCard;
import { api } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { chooseOption, dropdownOptions, dropdowns, installTestDom, flushUntil, invoke, type TestNode } from "../lib/test-dom-harness";
import { SubscriptionStats } from "./SubscriptionStats";
import { emptyWindowUsage } from "../../server/subscription-window-comparison";
import { emptyWindowEvidence } from "../../server/subscription-evidence";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import type { DataSettingsTarget } from "../lib/data-settings";
import { capacityPreferencesKey } from "../lib/capacity-filter-preferences";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
const capacityOnly = ({ scope, provider, windows, meter_history }: CodexAccountingReport) => ({ projection: true as const, scope, provider, windows, meter_history });

function find(node: TestNode, predicate: (node: TestNode) => boolean): TestNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) { const found = find(child, predicate); if (found) return found; }
}

test("cold Capacity paints the thin register response without an accounting request, including while diagnostics wait", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const read = spyOn(api, "codexCapacity").mockImplementation(async scope => {
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: EMPTY_RATES, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", scope);
    report.provider = { ...report.provider!, id: "codex", counter: "weekly" };
    report.windows = [{ id: "published", account: scope.account, plan: "pro", window_minutes: 10080,
      start: "2026-10-01T00:00:00Z", end: "2026-10-01T01:00:00Z", reset: "2026-10-08T00:00:00Z", start_percent: 0, end_percent: 50, observed_pp: 50,
      probes: 2, max_gap_hours: 1, start_basis: "zero_reading", sources: [], models: [], evidence: emptyWindowEvidence(),
      plan_detail: { status: "resolved", label: "Pro", multiplier: 20 }, usage: { ...emptyWindowUsage(), events: 1, tokens: 100, priced_tokens: 100, api_standard: 10 } }];
    return capacityOnly(report);
  });
  const full = spyOn(api, "codexAccounting").mockImplementation(() => new Promise(() => {}));
  const bounds = spyOn(api, "codexCapacityRange").mockResolvedValue({ range: { since: "2026-08-01", until: "2026-10-19" } });
  const history = spyOn(api, "historyCoverage");
  const markers = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const chart = () => find(dom.host, node => node.attributes["aria-label"] === "Estimated capacity at 100% by cycle");
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionStats account="cold-capacity" openDataSettings={() => {}} />));
    await flushUntil(() => !!chart());
    expect(full).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    const scope = read.mock.calls[0]![0];
    expect((Date.parse(scope.until) - Date.parse(scope.since)) / 86400000 + 1).toBe(30);
    await chooseOption(find(dom.host, node => node.attributes["aria-label"] === "Analysis period")!, "-1");
    await flushUntil(() => read.mock.calls.at(-1)?.[0].since === "2026-08-01");
    expect(bounds).toHaveBeenCalledTimes(1); expect(history).not.toHaveBeenCalled();
    await invoke(find(dom.host, node => node.attributes["aria-label"] === "Advanced filters")!, "onClick", {});
    const table = find(find(dom.host, node => node.tagName === "DIALOG")!, node => node.tagName === "TABLE")!;
    expect(table).toBeDefined();
    for (const column of ["Start · UTC", "End · UTC", "Plan", "Meter Δ", "100% · API $", "Quality"])
      expect(table.textContent).toContain(column);
    expect(table.textContent).toContain("2026-10-01"); expect(table.textContent).toContain("Pro · ×20");
    await invoke(find(dom.host, node => node.attributes["aria-label"] === "Close advanced filters")!, "onClick", {});
    await invoke(find(dom.host, node => node.tagName === "BUTTON" && node.textContent.includes("Data and prices"))!, "onClick", {});
    await flushUntil(() => full.mock.calls.length === 1);
    expect(chart()).toBeDefined();
    expect(read).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); read.mockRestore(); full.mockRestore(); bounds.mockRestore(); history.mockRestore(); markers.mockRestore(); db.close(); dom.restore(); }
});

test("usage and the manual editor remain visible without percentage readings or prices", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const read = spyOn(api, "subscriptionAccounting").mockImplementation(async options => {
    const report = buildSubscriptionAccountingReport({ sqlite: db, manualCapacity: [], rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, plans: {}, plansCatalog: { provider_groups: [] } }, options.provider, options);
    report.events = 7; report.tokens = 1234567;
    return report;
  });
  const markers = spyOn(api, "subscriptionTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionStats provider="grok" account="grok" />));
    await flushUntil(() => dom.host.textContent.includes("Recorded in selected dates"));
    const summary = find(dom.host, node => node.attributes["aria-label"] === "Recorded usage")!;
    expect(summary.textContent).toContain("7 requests");
    expect(summary.textContent).toContain("missing prices");
    expect(summary.textContent).toContain("tokens");
    expect(dom.host.textContent).toContain("Enter / edit %");
  } finally { await act(async () => root.unmount()); read.mockRestore(); markers.mockRestore(); db.close(); dom.restore(); }
});

test("every non-Codex provider separates capacity from model views, diagnostics and provider-scoped transport", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const range = { since: "2026-08-01", until: "2026-09-12" };
  const read = spyOn(api, "subscriptionAccounting").mockImplementation(async options => buildSubscriptionAccountingReport({ sqlite: db,
    rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, plans: {}, plansCatalog: { provider_groups: [] } }, options.provider, options));
  const markers = spyOn(api, "subscriptionTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const codex = spyOn(api, "codexAccounting");
  const codexMarkers = spyOn(api, "codexTimelineMarkers");
  setLanguage("en");
  try {
    for (const provider of ["claude", "grok", "gemini", "glm"]) {
      await act(async () => { root.render(<SubscriptionStats key={provider} provider={provider} account={provider} initialRange={range} />); });
      await flushUntil(() => dom.host.textContent.includes("No supported account meter"));
      expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ provider, account: provider, ...range });
      expect(markers.mock.calls.at(-1)?.[0]).toBe(provider);
      const tabs: TestNode[] = [];
      const collect = (node: TestNode) => { if (node.attributes.role === "tab") tabs.push(node); for (const child of node.children) collect(child); }; collect(dom.host);
      expect(tabs.map(node => node.textContent)).toEqual(["Over time", "Cycles", "Token types", "Comparison", "Before / after", ...(provider === "claude" ? ["By model"] : []), "Measurements", "Methodology"]);
      expect(find(dom.host, node => node.attributes.role === "tab" && node.textContent === "Models & sources")).toBeUndefined();
      await act(async () => { root.render(<SubscriptionStats key={provider + "-models"} section="models" provider={provider} account={provider} initialRange={range} />); });
      await flushUntil(() => dom.host.textContent.includes("Daily details and rates"));
      expect(find(dom.host, node => node.attributes.role === "tab" && node.textContent === "Capacity")).toBeUndefined();
      expect(dom.host.textContent).toContain("Daily details and rates");
      expect(dom.host.textContent).not.toContain("Additional Speed credits");
    }
    expect(codex).not.toHaveBeenCalled(); expect(codexMarkers).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); read.mockRestore(); markers.mockRestore(); codex.mockRestore(); codexMarkers.mockRestore(); db.close(); dom.restore(); }
});

test("Free opens its 30-day counter and sends an independent duration after every counter switch", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const read = spyOn(api, "codexCapacity").mockImplementation(async options => {
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: EMPTY_RATES, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", { ...options, account: "a" });
    report.provider = { ...report.provider!, id: "codex", counter: options.window_minutes === 300 ? "five_hour" : options.window_minutes === 10080 ? "weekly" : "thirty_day",
      counters: [{ id: "weekly", label: "Weekly · 10080m" }, { id: "five_hour", label: "5h · 300m" }, { id: "thirty_day", label: "30d · 43200m" }] };
    return capacityOnly(report);
  });
  const markers = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionStats provider="codex" account="a" />));
    await flushUntil(() => !!find(dom.host, n => n.attributes["aria-label"] === "Subscription counter"));
    const picker = () => find(dom.host, n => n.attributes["aria-label"] === "Subscription counter")!;
    expect(picker().textContent).toContain("30d");
    for (const [counter, minutes] of [["five_hour", 300], ["weekly", 10080], ["thirty_day", 43200]] as const) {
      await chooseOption(picker(), counter);
      await flushUntil(() => read.mock.calls.at(-1)?.[0].window_minutes === minutes);
      expect(read.mock.calls.at(-1)?.[0].window_minutes).toBe(minutes);
    }
  } finally { await act(async () => root.unmount()); read.mockRestore(); markers.mockRestore(); db.close(); dom.restore(); }
});

test("quality filter uses shared evidence without refetching traffic and survives settings context", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const range = { since: "2026-08-01", until: "2026-09-12" };
  const base: CodexComparisonWindow = { id: "good", account: "claude", plan: "max", window_minutes: 300,
    start: "2026-09-01T00:00:00Z", end: "2026-09-01T00:20:00Z", reset: "2026-09-01T05:00:00Z", start_percent: 0, end_percent: 20, observed_pp: 20,
    probes: 2, max_gap_hours: 1/3, start_basis: "zero_reading", usage: { ...emptyWindowUsage(), events: 1, tokens: 100, priced_tokens: 100, api_standard: 1 },
    sources: [], models: [], plan_detail: { status: "resolved", label: "Max", multiplier: 20 }, evidence: emptyWindowEvidence() };
  const read = spyOn(api, "subscriptionAccounting").mockImplementation(async options => {
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", options);
    report.windows = [base, { ...base, id: "weak", usage: { ...base.usage, unknown_tokens: 100 } }];
    return report;
  });
  const markers = spyOn(api, "subscriptionTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const targets: unknown[] = [];
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionStats provider="claude" account="claude" initialRange={range} openDataSettings={target => targets.push(target)} />));
    // Cycle rows (the scope chips above the report were removed, user 2026-10-21).
    const cycleRows = () => { let count = 0; const visit = (node: TestNode) => { if (node.tagName === "ARTICLE") count++; node.children.forEach(visit); }; visit(dom.host); return count; };
    await flushUntil(() => cycleRows() === 2);
    await invoke(find(dom.host, node => node.attributes["aria-label"] === "Advanced filters")!, "onClick", {});
    await chooseOption(find(dom.host, n => n.attributes["aria-label"] === "Measurement quality")!, "comparable");
    expect(cycleRows()).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    await invoke(find(dom.host, n => n.tagName === "BUTTON" && n.textContent === "Complete data / events")!, "onClick", {});
    expect(targets.at(-1)).toMatchObject({ returnRange: { ...range, quality: "comparable" } });
    await chooseOption(find(dom.host, n => n.attributes["aria-label"] === "Measurement quality")!, "insufficient");
    expect(dom.host.textContent).toContain("No cycles meet both the quality");
  } finally { await act(async () => root.unmount()); read.mockRestore(); markers.mockRestore(); db.close(); dom.restore(); }
});

for (const provider of ["codex", "claude"] as const) test(`${provider} plan filter selects the chart and cycles locally and isolates account changes`, async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value),
  } });
  const range = { since: "2026-08-01", until: "2026-09-12" };
  const details: CodexComparisonWindow["plan_detail"][] = [
    { status: "resolved", label: "Plus", multiplier: 1 },
    { status: "resolved", label: "Pro", multiplier: 5 },
    { status: "resolved", label: "Pro", multiplier: 20 },
    { status: "resolved", label: "Pro", multiplier: 20 },
    { status: "mixed", label: "plus → pro-5x", multiplier: null },
    { status: "unknown", label: "?", multiplier: null },
  ];
  const respond = async (options: { since: string; until: string; account?: string }) => {
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: EMPTY_RATES, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", options);
    report.provider = { ...report.provider!, id: provider, counter: "weekly" };
    report.windows = details.map((detail, index) => ({ id: `cycle-${index}`, account: options.account!, plan: index === 5 ? null : index === 0 ? "plus" : "pro",
      window_minutes: 10080, start: `2026-08-0${index + 1}T00:00:00Z`, end: `2026-08-0${index + 1}T01:00:00Z`, reset: `2026-08-0${index + 2}T00:00:00Z`,
      start_percent: 0, end_percent: index === 3 ? 5 : 50, observed_pp: index === 3 ? 5 : 50,
      probes: 2, max_gap_hours: 1, start_basis: "zero_reading", plan_detail: detail, sources: [], models: [], evidence: emptyWindowEvidence(),
      usage: { ...emptyWindowUsage(), events: 1, tokens: 100, priced_tokens: 100, api_standard: 10 },
    }));
    return report;
  };
  const read = provider === "codex" ? spyOn(api, "codexCapacity").mockImplementation(async options => capacityOnly(await respond(options)))
    : spyOn(api, "subscriptionAccounting").mockImplementation(respond);
  const markers = provider === "codex" ? spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] })
    : spyOn(api, "subscriptionTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const picker = () => find(dom.host, node => node.attributes["aria-label"] === "Subscription plan filter")!;
  const articles = (): TestNode[] => {
    const rows: TestNode[] = [];
    const visit = (node: TestNode) => { if (node.tagName === "ARTICLE") rows.push(node); for (const child of node.children) visit(child); };
    visit(dom.host); return rows;
  };
  const chart = () => find(dom.host, node => node.attributes["aria-label"] === "Estimated capacity at 100% by cycle")!;
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionStats provider={provider} account="a" initialRange={range} />));
    await flushUntil(() => !!find(dom.host, node => node.attributes["aria-label"] === "Advanced filters"));
    expect(find(dom.host, node => node.tagName === "DIALOG")).toBeUndefined();
    const openFilters = () => invoke(find(dom.host, node => node.attributes["aria-label"] === "Advanced filters")!, "onClick", {});
    await openFilters();
    await flushUntil(() => !!picker());
    const drawer = () => find(dom.host, node => node.tagName === "DIALOG")!;
    expect(drawer().hasAttribute("open")).toBe(true);
    expect(drawer().textContent).toContain("Advanced filters");
    const options = await dropdownOptions(picker());
    expect(options.map(option => option.label)).toContain("All plans");
    expect(options.filter(option => option.label === "Pro · ×20")).toHaveLength(1);
    expect(articles()).toHaveLength(6);
    await chooseOption(picker(), options.find(option => option.label === "Pro · ×20")!.value);
    expect(articles()).toHaveLength(2);
    expect(articles().every(row => row.textContent.includes("Pro · ×20"))).toBe(true);
    expect(chart().textContent).toContain("Pro · ×20");
    expect(chart().textContent).not.toContain("Plus · ×1");
    expect(chart().textContent).not.toContain("Pro · ×5");
    // The small sample remains in the list; the existing minimum still filters the chart.
    expect(dom.host.textContent).toContain("below minimum");
    const cycle = (id: string) => find(dom.host, node => node.attributes["data-cycle-id"] === id)!;
    await invoke(cycle("cycle-3"), "onChange", { target: { checked: false } });
    expect(articles()).toHaveLength(1);
    expect(dom.host.textContent).not.toContain("below minimum");
    // Plan changes do not forget the visibility of individual windows.
    await chooseOption(picker(), options.find(option => option.label === "Plus · ×1")!.value);
    expect(articles()).toHaveLength(1);
    await chooseOption(picker(), options.find(option => option.label === "Pro · ×20")!.value);
    expect(articles()).toHaveLength(1);
    expect(drawer().textContent).toContain("Windows · 1/2");
    await invoke(find(dom.host, node => node.attributes["aria-label"] === "Close advanced filters")!, "onClick", {});
    expect(drawer()).toBeUndefined();
    expect(articles()).toHaveLength(1);
    await openFilters();
    expect(picker().textContent).toContain("Pro · ×20");
    expect(drawer().textContent).toContain("Windows · 1/2");
    await invoke(drawer(), "onCancel", { preventDefault() {} });
    expect(drawer()).toBeUndefined();
    await openFilters();
    const button = (label: string) => find(dom.host, node => node.tagName === "BUTTON" && (node.textContent === label || node.attributes["aria-label"] === label))!;
    await invoke(button("Show all"), "onClick", {});
    expect(articles()).toHaveLength(2);
    await invoke(button("Hide all"), "onClick", {});
    expect(articles()).toHaveLength(0);
    expect(dom.host.textContent).toContain("All windows hidden");
    await invoke(button("Show all"), "onClick", {});
    const search = () => find(dom.host, node => node.attributes["aria-label"] === "Find a window")!;
    await invoke(search(), "onChange", { target: { value: "2026-08-03" } });
    expect(cycle("cycle-3")).toBeUndefined();
    await invoke(button("Hide matches"), "onClick", {});
    expect(articles()).toHaveLength(1);
    expect(chart()).toBeUndefined();
    await invoke(button("Show matches"), "onClick", {});
    expect(articles()).toHaveLength(2);
    expect(chart()).toBeDefined();
    await invoke(search(), "onChange", { target: { value: "" } });
    await chooseOption(picker(), options.find(option => option.label.includes("plan change"))!.value);
    expect(articles()).toHaveLength(1);
    expect(articles()[0]!.textContent).toContain("plan change");
    await chooseOption(picker(), options.find(option => option.label === "Plan not established")!.value);
    expect(articles()).toHaveLength(1);
    expect(articles()[0]!.textContent).toContain("plan not established");
    await chooseOption(picker(), "all");
    expect(articles()).toHaveLength(6);
    expect(read).toHaveBeenCalledTimes(1);
    await chooseOption(picker(), options.find(option => option.label === "Plus · ×1")!.value);
    await invoke(cycle("cycle-0"), "onChange", { target: { checked: false } });
    await chooseOption(find(dom.host, node => node.attributes["aria-label"] === "Measurement quality")!, "partial");
    await chooseOption(find(dom.host, node => node.attributes["aria-label"] === "Capacity basis")!, "regular");
    await invoke(find(dom.host, node => node.attributes["aria-label"] === "Minimum observed usage percentage")!, "onChange", { target: { value: "55" } });
    await act(async () => root.render(<SubscriptionStats provider={provider} account="b" initialRange={range} />));
    await flushUntil(() => articles().length === 6);
    await openFilters();
    expect(picker().textContent).toContain("All plans");
    expect(read).toHaveBeenCalledTimes(2);
    // A return to A and a complete remount both restore its own selections.
    for (const key of ["return", "reload"]) {
      await act(async () => root.render(<SubscriptionStats key={key} provider={provider} account="a" />));
      await flushUntil(() => !!find(dom.host, node => node.attributes["aria-label"] === "Advanced filters"));
      await openFilters();
      expect(picker().textContent).toContain("Plus · ×1");
      expect(drawer().textContent).toContain("Windows · 0/1");
      expect(find(dom.host, node => node.attributes["aria-label"] === "Measurement quality")!.textContent).toContain("Partial evidence");
      expect(find(dom.host, node => node.attributes["aria-label"] === "Capacity basis")!.textContent).toContain("Without promotions");
      expect(find(dom.host, node => node.attributes["aria-label"] === "Minimum observed usage percentage")!.value).toBe("55");
      expect(read.mock.calls.at(-1)?.[0]).toMatchObject(range);
    }
    expect(read).toHaveBeenCalledTimes(4);
    expect(button("Reset filters").hasAttribute("disabled")).toBe(false);
    await invoke(button("Reset filters"), "onClick", {});
    expect(articles()).toHaveLength(6);
    expect(picker().textContent).toContain("All plans");
    expect(button("Reset filters").hasAttribute("disabled")).toBe(true);
    expect(JSON.parse(stored.get(capacityPreferencesKey(provider, "a"))!).hidden).toEqual({});
    expect(JSON.parse(stored.get(capacityPreferencesKey(provider, "b"))!).minimum).toBe(10);
    await invoke(button("Done"), "onClick", {});
    expect(drawer()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount()); read.mockRestore(); markers.mockRestore(); db.close(); dom.restore();
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
}, 15000);

test("weekly and 5h hidden windows restore independently after counter changes and remount", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value),
  } });
  const read = spyOn(api, "codexCapacity").mockImplementation(async options => {
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: EMPTY_RATES, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", options);
    const minutes = options.window_minutes ?? 10080;
    report.provider = { ...report.provider!, id: "codex", counter: minutes === 300 ? "five_hour" : "weekly",
      counters: [{ id: "weekly", label: "Weekly" }, { id: "five_hour", label: "5h" }] };
    report.windows = ["first", "second"].map(id => ({ id, account: "counter-test", plan: "pro", window_minutes: minutes,
      start: "2026-08-01T00:00:00Z", end: "2026-08-01T01:00:00Z", reset: minutes === 300 ? "2026-08-01T05:00:00Z" : "2026-08-08T00:00:00Z",
      start_percent: 0, end_percent: 50, observed_pp: 50, probes: 2, max_gap_hours: 1, start_basis: "zero_reading",
      plan_detail: { status: "resolved", label: "Pro", multiplier: 20 }, sources: [], models: [], evidence: emptyWindowEvidence(),
      usage: { ...emptyWindowUsage(), events: 1, tokens: 100, priced_tokens: 100, api_standard: 10 } }));
    return capacityOnly(report);
  });
  const markers = spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const button = (label: string) => find(dom.host, node => node.tagName === "BUTTON" && (node.textContent === label || node.attributes["aria-label"] === label))!;
  const cycle = (id: string) => find(dom.host, node => node.attributes["data-cycle-id"] === id)!;
  const count = () => { let count = 0; const visit = (node: TestNode) => { if (node.tagName === "ARTICLE") count++; node.children.forEach(visit); }; visit(dom.host); return count; };
  const close = () => invoke(find(dom.host, node => node.attributes["aria-label"] === "Close advanced filters")!, "onClick", {});
  const picker = () => find(dom.host, node => node.attributes["aria-label"] === "Subscription counter")!;
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionStats account="counter-test" initialRange={{ since: "2026-08-01", until: "2026-09-12" }} />));
    await flushUntil(() => count() === 2);
    await invoke(button("Advanced filters"), "onClick", {});
    await invoke(cycle("first"), "onChange", { target: { checked: false } });
    expect(count()).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    await close();
    await chooseOption(picker(), "five_hour");
    await flushUntil(() => count() === 2);
    await invoke(button("Advanced filters"), "onClick", {});
    await invoke(cycle("second"), "onChange", { target: { checked: false } });
    expect(count()).toBe(1);
    await close();
    await chooseOption(picker(), "weekly");
    await flushUntil(() => picker().textContent.includes("Weekly") && count() === 1);
    expect(JSON.parse(stored.get(capacityPreferencesKey("codex", "counter-test"))!).hidden).toEqual({ weekly: ["first"], five_hour: ["second"] });
    await act(async () => root.render(<SubscriptionStats key="reload" account="counter-test" />));
    await flushUntil(() => count() === 1);
    expect(picker().textContent).toContain("Weekly");
    await invoke(button("Advanced filters"), "onClick", {});
    await invoke(cycle("first"), "onChange", { target: { checked: true } });
    expect(count()).toBe(2);
    expect(read).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount()); read.mockRestore(); markers.mockRestore(); db.close(); dom.restore();
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

for (const provider of ["codex", "claude"] as const) test(`${provider} price-date controls validate, wait for matching data and retain settings context`, async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  const range = { since: "2026-08-01", until: "2026-09-12", counter: provider === "codex" ? "five_hour" : "session", quality: "partial" as const };
  const requests: Array<{ reference_day?: string; window_minutes?: 300 | 10080 | 43200; counter?: string }> = [];
  let release: (() => void) | undefined;
  const respond = async (options: { since: string; until: string; account?: string; counter?: string; reference_day?: string; window_minutes?: 300 | 10080 | 43200 }) => {
    requests.push(options);
    if (options.reference_day === "2026-08-21") await new Promise<void>(resolve => { release = resolve; });
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", { ...options, account: "a", counter: undefined });
    report.provider = { ...report.provider!, id: provider, counter: range.counter };
    report.windows = [1, 2, 3].map(day => ({ id: `cycle-${day}`, account: "a", plan: "pro", window_minutes: 300,
      start: `2026-08-0${day}T00:00:00Z`, end: `2026-08-0${day}T01:00:00Z`, reset: `2026-08-0${day}T05:00:00Z`,
      start_percent: 0, end_percent: 50, observed_pp: 50, probes: 2, max_gap_hours: 1, sources: [], models: [],
      plan_detail: { status: "resolved", label: "Pro", multiplier: 20 },
      usage: { ...emptyWindowUsage(), events: 1, tokens: 100, priced_tokens: 100, api_standard: 10,
        revaluation_events: 1, revaluation_tokens: 100, paired_historical_api: 10, paired_reference_api: 5 } }));
    return report;
  };
  const read = provider === "codex"
    ? spyOn(api, "codexAccounting").mockImplementation(options => respond({ ...range, ...options }))
    : spyOn(api, "subscriptionAccounting").mockImplementation(options => respond({ ...range, ...options }));
  const prepared = provider === "codex" ? spyOn(api, "codexCapacity").mockImplementation(async options => capacityOnly(await respond({ ...range, ...options }))) : null;
  const markers = provider === "codex" ? spyOn(api, "codexTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] })
    : spyOn(api, "subscriptionTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const targets: DataSettingsTarget[] = [];
  const priceInput = () => find(dom.host, n => n.attributes["aria-label"] === "Reference price date")!;
  const priceForm = () => find(dom.host, n => n.tagName === "FORM" && n.attributes["aria-label"] === "Reference price date controls")!;
  const comparison = () => find(dom.host, n => n.tagName === "SECTION" && n.attributes["aria-label"] === "Compare at one price date");
  const firstCycle = () => dropdowns(find(comparison()!, n => n.tagName === "LABEL" && n.textContent.startsWith("Cycle 1"))!)[0]!;
  const firstCycleTime = () => find(comparison()!, n => n.tagName === "TR" && n.textContent.startsWith("Matched time range"))!.children[1]!.textContent;
  setLanguage("en");
  try {
    await act(async () => root.render(<SubscriptionStats provider={provider} account="a" initialRange={range} openDataSettings={target => targets.push(target)} />));
    await flushUntil(() => requests.length === 1 && !!priceInput());
    expect(requests[0]!.reference_day).toBeUndefined();
    await invoke(priceInput(), "onChange", { target: { value: "2026-02-30" } });
    await invoke(priceForm(), "onSubmit", { preventDefault() {} });
    expect(dom.host.textContent).toContain("Enter a valid calendar date");
    expect(requests).toHaveLength(1);
    await invoke(priceInput(), "onChange", { target: { value: "2026-09-11" } });
    expect(requests).toHaveLength(1);
    await invoke(priceForm(), "onSubmit", { preventDefault() {} });
    await flushUntil(() => !!comparison());
    expect(requests.at(-1)!.reference_day).toBe("2026-09-11");
    expect(requests.at(-1)).toMatchObject(provider === "codex" ? { window_minutes: 300 } : { counter: "session" });
    await chooseOption(firstCycle(), "cycle-2");
    await invoke(priceInput(), "onChange", { target: { value: "2026-08-21" } });
    expect(comparison()!.textContent).toContain("2026-09-11");
    await invoke(priceForm(), "onSubmit", { preventDefault() {} });
    await flushUntil(() => !!release);
    expect(comparison()).toBeUndefined();
    await act(async () => release!());
    await flushUntil(() => !!comparison());
    expect(comparison()!.textContent).toContain("2026-08-21");
    expect(firstCycleTime()).toContain("2026-08-02 00:00 UTC");
    await invoke(find(dom.host, n => n.tagName === "BUTTON" && n.textContent === "Complete data / events")!, "onClick", {});
    expect(targets.at(-1)!.returnRange).toEqual({ ...range, reference_day: "2026-08-21", price_cycles: { first: "cycle-2", second: "cycle-3" } });
    release = undefined;
    await act(async () => root.render(<SubscriptionStats key="restored" provider={provider} account="a" initialRange={{ ...range, reference_day: "2026-09-11", price_cycles: targets.at(-1)!.returnRange!.price_cycles }} />));
    await flushUntil(() => !!comparison());
    expect(priceInput().value).toBe("2026-09-11");
    expect(firstCycleTime()).toContain("2026-08-02 00:00 UTC");
    expect(requests.at(-1)!.reference_day).toBe("2026-09-11");
    await invoke(find(dom.host, n => n.tagName === "BUTTON" && n.textContent === "Clear price comparison")!, "onClick", {});
    await flushUntil(() => requests.at(-1)!.reference_day === undefined);
    expect(comparison()).toBeUndefined();
  } finally {
    release?.(); await act(async () => root.unmount()); read.mockRestore(); prepared?.mockRestore(); markers.mockRestore(); db.close(); dom.restore();
  }
});

test("All waits for recorded bounds and retains its ready cycles during a publication refresh", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  let finishBounds!: (value: Awaited<ReturnType<typeof api.historyCoverage>>) => void;
  let finishRefresh!: () => void;
  let refreshing = false;
  const refresh = new Promise<void>(resolve => { finishRefresh = resolve; });
  const bounds = spyOn(api, "historyCoverage").mockImplementation(() => new Promise(resolve => { finishBounds = resolve; }));
  const read = spyOn(api, "subscriptionAccounting").mockImplementation(async options => {
    if (refreshing) await refresh;
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: EMPTY_RATES, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", options);
    report.windows = [{ id: "ready-cycle", account: "claude", plan: "max", window_minutes: 300,
      start: "2026-09-01T00:00:00Z", end: "2026-09-01T00:20:00Z", reset: "2026-09-01T05:00:00Z", start_percent: 0, end_percent: 20, observed_pp: 20,
      probes: 2, max_gap_hours: 1/3, start_basis: "zero_reading", usage: { ...emptyWindowUsage(), events: 1, tokens: 100, priced_tokens: 100, api_standard: 1 },
      sources: [], models: [], plan_detail: { status: "resolved", label: "Max", multiplier: 20 }, evidence: emptyWindowEvidence() }];
    return report;
  });
  const markers = spyOn(api, "subscriptionTimelineMarkers").mockResolvedValue({ revision: "empty", markers: [], automatic: [] });
  const render = (revision: number) => root.render(<SubscriptionStats provider="claude" account="claude" dataRevision={revision} />);
  // The ready cycle shows as one cycle row (the scope chips above the report were removed, user 2026-10-21).
  const cycleRows = () => { let count = 0; const visit = (node: TestNode) => { if (node.tagName === "ARTICLE") count++; node.children.forEach(visit); }; visit(dom.host); return count; };
  setLanguage("en");
  try {
    await act(async () => render(1));
    await flushUntil(() => cycleRows() === 1);
    await chooseOption(find(dom.host, node => node.attributes["aria-label"] === "Analysis period")!, "-1");
    await flushUntil(() => bounds.mock.calls.length === 1);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => finishBounds({ subscriptions: [{ subscription: "claude",
      usage: { first_day: "2025-03-01", last_day: "2026-09-10" },
      gauge: { first_at: "2025-02-01T23:00:00Z", last_at: "2026-10-15T20:00:00Z" } }],
    } as Awaited<ReturnType<typeof api.historyCoverage>>));
    await flushUntil(() => read.mock.calls.length === 2 && cycleRows() === 1);
    expect(read.mock.calls.at(-1)![0]).toMatchObject({ since: "2025-02-01", until: "2026-10-15" });
    refreshing = true;
    await act(async () => render(2));
    await flushUntil(() => read.mock.calls.length === 3);
    expect(cycleRows()).toBe(1);
    expect(dom.host.textContent).not.toContain("Loading subscription analysis");
    expect(read.mock.calls.at(-1)![0]).toMatchObject({ since: "2025-02-01", until: "2026-10-15" });
    await act(async () => finishRefresh());
    await flushUntil(() => cycleRows() === 1);
  } finally {
    finishRefresh(); await act(async () => root.unmount()); bounds.mockRestore(); read.mockRestore(); markers.mockRestore(); db.close(); dom.restore();
  }
});
