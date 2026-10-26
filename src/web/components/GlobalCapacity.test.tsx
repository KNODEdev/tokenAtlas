import { renderToStaticMarkup } from "react-dom/server";
import { AttachList, CapacityBattle, PlanCell } from "./CapacityBattle";
import type { CapacityAccount } from "../lib/global-capacity";
import { capacityUnitFormat } from "../lib/codex-capacity";
import { test, expect, spyOn } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import type { CapacityCyclesEntry, CapacityCyclesResponse } from "../../shared/capacity-cycles";
import { emptyWindowUsage } from "../../server/subscription-window-comparison";
import { emptyWindowEvidence } from "../../server/subscription-evidence";
import { api, refreshApiData, type ApiAccount, type HistoryCoverageResponse } from "../lib/api";
import { setLanguage } from "../lib/i18n";
import { chooseOption, installTestDom, flushUntil, invoke, type TestNode } from "../lib/test-dom-harness";
import type { RosterCard } from "../lib/roster";
import { GlobalCapacity, CycleTable } from "./GlobalCapacity";
import { setContextPreview } from "../lib/context-premium";
import { markReportStale, useStaleReportTime } from "../lib/report-freshness";
/** Reads the stale-report store the header activity shows. */
function ReportFreshness(){return useStaleReportTime()===null?null:<span>Showing the last consistent result</span>;}
function find(node: TestNode, predicate: (node: TestNode) => boolean): TestNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) { const result = find(child, predicate); if (result) return result; }
}
function findAll(node: TestNode, predicate: (node: TestNode) => boolean): TestNode[] {
  return [...predicate(node) ? [node] : [], ...node.children.flatMap(child => findAll(child, predicate))];
}
const apiAccount = (id: string, vendor: string) => ({ id, vendor, plan: "pro", login: id, machine: null, note: null, homes: [], ratelimit_rows: 0, event_rows: 0, windows: [],
  limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: true, has_events: true }) as unknown as ApiAccount;
function cycle(account: string, counter: string, day: number, usd: number): CodexComparisonWindow {
  const start = `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`, reset = `2026-09-${String(day + 7).padStart(2, "0")}T00:00:00Z`;
  return { id: JSON.stringify([account, counter, start]), account, plan: "pro", window_minutes: 10080, start, end: reset, reset, cycle_start: start, cycle_end: reset,
    start_percent: 0, end_percent: 50, observed_pp: 50, probes: 20, max_gap_hours: 0.25,
    usage: { ...emptyWindowUsage(), events: 20, tokens: 500_000, input: 400_000, cached: 300_000, output: 100_000, priced_tokens: 500_000, api_standard: usd, credits_low: usd * 20, credits_high: usd * 20 },
    sources: [], models: [], plan_detail: { status: "resolved", label: "Pro", multiplier: 20 }, evidence: emptyWindowEvidence(),
    promotion: { status: "configured", factor: 1, regime_ids: [], notes: [], sources: [] } } as CodexComparisonWindow;
}

test("battle distinguishes pending and failed reads from missing plans, then retries and attaches the dated variant", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const account = apiAccount("codex1", "codex");
  const window = { ...cycle(account.id, "weekly", 1, 100), plan: "prolite",
    plan_detail: { status: "resolved" as const, label: "Pro", multiplier: 5 } };
  let publication: "pending" | "failed" | "ready" = "pending";
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const read = spyOn(api, "capacityCycles").mockImplementation(async options => {
    if (publication === "pending") await delayed;
    if (publication === "failed") throw new Error("Cycle read failed");
    return { ...options, accounts: [{ account: account.id, provider: "codex", counter: "weekly", counter_label: "weekly",
      windows: publication === "ready" ? [window] : [], ...(publication === "pending" ? { preparing: true as const } : {}) }] };
  });
  setLanguage("en");
  try {
    await act(async () => root.render(<CapacityBattle accounts={[account]} cards={[]} />));
    await flushUntil(() => read.mock.calls.length === 1);
    expect(dom.host.textContent).toContain("Loading cycles…");
    const row = find(dom.host, node => node.tagName === "TR" && node.textContent.includes("×5"))!;
    await invoke(find(row, node => node.tagName === "BUTTON" && node.textContent === "attach")!, "onClick");
    expect(dom.host.textContent).toContain("Loading cycles…");
    expect(dom.host.textContent).not.toContain("0 cycles of this tier");
    expect(dom.host.textContent).not.toContain("Try a longer history");
    await act(async () => release());
    await flushUntil(() => dom.host.textContent.includes("Preparing cycles…"));
    expect(dom.host.textContent).toContain("Preparing cycles…");
    expect(dom.host.textContent).not.toContain("Try a longer history");
    publication = "failed";
    await act(async () => refreshApiData());
    await flushUntil(() => dom.host.textContent.includes("Cycle read failed"));
    expect(dom.host.textContent).not.toContain("Try a longer history");
    publication = "ready";
    await invoke(find(dom.host, node => node.tagName === "BUTTON" && node.textContent === "Retry")!, "onClick");
    await flushUntil(() => dom.host.textContent.includes("1 cycles of this tier"));
    expect(dom.host.textContent).not.toContain("Cycle read failed");
    expect(dom.host.textContent).not.toContain("Preparing cycles…");
    await invoke(find(dom.host, node => node.tagName === "BUTTON" && node.textContent === "attach solid · 1")!, "onClick");
    expect(dom.host.textContent).toContain("1 cycles of this tier · 1 attached");
    expect(dom.host.textContent).toContain("attached · 1");
    expect(read).toHaveBeenCalledTimes(3);
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("battle shows an empty range only after loading finishes in either language", () => {
  try {
    for (const language of ["en", "pl"] as const) {
      setLanguage(language);
      const props = { subjects: [], cycles: [], tier: 5, unit: "api_standard" as const, basis: "observed" as const,
        chosen: new Set<string>(), onChange: () => {} };
      const loading = renderToStaticMarkup(<AttachList {...props} reading />);
      const ready = renderToStaticMarkup(<AttachList {...props} reading={false} />);
      expect(loading).toContain(language === "en" ? "Loading cycles…" : "Wczytywanie cykli…");
      const empty = language === "en" ? "Try a longer history" : "Wybierz dłuższą historię";
      expect(loading).not.toContain(empty);
      expect(ready).toContain(empty);
    }
  } finally { setLanguage("en"); }
});

test("battle preserves available choices while another subscription is preparing or failed", () => {
  const subject: CapacityAccount = { id: "codex1", provider: "codex", active: true, label: "Codex" };
  const window = cycle(subject.id, "weekly", 1, 100);
  setLanguage("en");
  const html = renderToStaticMarkup(<AttachList subjects={[subject]} cycles={[{ subject, window }]} tier={20}
    reading={false} preparing errors={["Other subscription failed"]} unit="api_standard" basis="observed"
    chosen={new Set([window.id])} onChange={() => {}} />);
  expect(html).toContain("1 cycles of this tier · 1 attached");
  expect(html).toContain("Preparing cycles…");
  expect(html).toContain("Other subscription failed");
  expect(html).not.toContain("Try a longer history");
});

test("All previews only Codex complete splits, preserves provider pricing when off, and does not fetch again", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const accounts = [apiAccount("context-codex", "codex"), apiAccount("context-claude", "claude")];
  const cards = accounts.map(account => ({ id: account.id, active: true, group: account.vendor })) as RosterCard[];
  const split = (window: CodexComparisonWindow) => ({ ...window, usage: { ...window.usage,
    context_priced_tokens: window.usage.priced_tokens, context_api_base: 1000, context_api_extra: 200,
    context_known_tokens: window.usage.tokens, context_long_tokens: 100_000, context_long_events: 4 } });
  const codex = split(cycle(accounts[0]!.id, "weekly", 1, 1000));
  const included = { ...split(cycle(accounts[0]!.id, "weekly", 8, 1200)), id: "already-included" };
  const incomplete = { ...codex, id: "incomplete", usage: { ...codex.usage, context_priced_tokens: 1 } };
  const claude = split(cycle(accounts[1]!.id, "weekly", 1, 1000));
  const read = spyOn(api, "capacityCycles").mockImplementation(async options => ({ ...options, accounts: [
    { account: accounts[0]!.id, provider: "codex", counter: "weekly", counter_label: "weekly", windows: [codex, included, incomplete] },
    { account: accounts[1]!.id, provider: "claude", counter: "weekly", counter_label: "weekly", windows: [claude] },
  ] }));
  setLanguage("en");
  setContextPreview(false);
  try {
    await act(async () => root.render(<GlobalCapacity accounts={accounts} cards={cards} />));
    await flushUntil(() => dom.host.textContent.includes("4 cycles"));
    const before = dom.host.textContent;
    const rows = () => findAll(dom.host, node => node.tagName === "ARTICLE");
    expect(rows().filter(row => row.textContent.includes("$2,400"))).toHaveLength(1);
    await act(async () => setContextPreview(true));
    expect(rows().filter(row => row.textContent.includes("$2,400"))).toHaveLength(2);
    expect(rows().filter(row => row.textContent.includes("$2,000"))).toHaveLength(2);
    expect(findAll(dom.host, node => node.attributes["data-context-segment"] === "api-uplift").length).toBeGreaterThan(0);
    await act(async () => setContextPreview(false));
    expect(dom.host.textContent).toBe(before);
    expect(read).toHaveBeenCalledTimes(1);
    expect(codex.usage.api_standard).toBe(1000);
  } finally { await act(async () => root.unmount()); setContextPreview(false); read.mockRestore(); dom.restore(); }
});

test("global capacity retries a stale history and aborts polling with freshness cleanup when closed", async () => {
  const dom=installTestDom(),root=createRoot(dom.host as unknown as Element);
  const account={id:"stale-account",vendor:"claude",has_events:true} as ApiAccount;
  const cards=[{id:account.id,active:true,group:"claude"}] as RosterCard[];
  const old:CapacityCyclesResponse={since:"",until:"",window_minutes:10080,accounts:[]};
  markReportStale(old,1789732800000);
  const signals:AbortSignal[]=[];
  const read=spyOn(api,"capacityCycles").mockImplementation((_options,signal)=>{
    signals.push(signal!);
    return signals.length===1?Promise.resolve(old):new Promise(()=>{});
  });
  setLanguage("en");
  try {
    await act(async()=>root.render(<><ReportFreshness/><GlobalCapacity accounts={[account]} cards={cards}/></>));
    await flushUntil(()=>dom.host.textContent.includes("Showing the last consistent result"));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,2100));});
    expect(read).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    await act(async()=>root.render(<ReportFreshness/>));
    expect(signals[1]!.aborted).toBe(true);
    expect(dom.host.textContent).not.toContain("Showing the last consistent result");
  } finally {await act(async()=>root.unmount());read.mockRestore();dom.restore();}
});

test("All keeps its chart mounted through delayed metadata and pending cycle publication, then accepts a completed empty result", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const account = apiAccount("codex1", "codex");
  const coverage = { generated_at: "2026-10-16", subscriptions: [{ subscription: account.id,
    usage: { first_day: "2025-09-16", last_day: "2026-10-16" }, gauge: { first_at: null, last_at: null } }] } as HistoryCoverageResponse;
  const bounds = spyOn(api, "historyCoverage").mockResolvedValue(coverage);
  const accounts = spyOn(api, "accounts").mockResolvedValue({ count: 1, subscriptions: [account] });
  let publication: "ready" | "pending" | "empty" = "ready";
  const read = spyOn(api, "capacityCycles").mockImplementation(async options => ({ ...options, accounts: [{
    account: account.id, provider: "codex", counter: "weekly", counter_label: "weekly",
    windows: publication === "ready" ? [cycle(account.id, "weekly", 1, 1400)] : [], ...(publication === "pending" ? { preparing: true as const } : {}),
  }] }));
  setLanguage("en");
  try {
    await act(async () => root.render(<GlobalCapacity accounts={[account]} cards={[{ id: account.id, active: true, group: "codex" } as RosterCard]} />));
    await flushUntil(() => dom.host.textContent.includes("1 cycles"));
    await chooseOption(find(dom.host, node => node.attributes["aria-label"] === "History")!, "0");
    await flushUntil(() => read.mock.calls.length === 2);
    const svg = find(dom.host, node => node.attributes["aria-label"] === "Estimated capacity at 100% by cycle")!;
    expect(svg).toBeDefined();
    let release!: (value: HistoryCoverageResponse) => void;
    bounds.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    publication = "pending";
    await act(async () => refreshApiData());
    await flushUntil(() => read.mock.calls.length === 3);
    expect(find(dom.host, node => node.attributes["aria-label"] === "Estimated capacity at 100% by cycle")).toBe(svg);
    expect(dom.host.textContent).toContain("1 cycles");
    expect(dom.host.textContent).not.toContain("No cycles to compare");
    await act(async () => release(coverage));
    expect(find(dom.host, node => node.attributes["aria-label"] === "Estimated capacity at 100% by cycle")).toBe(svg);
    publication = "empty";
    await act(async () => refreshApiData());
    await flushUntil(() => dom.host.textContent.includes("No cycles to compare"));
    expect(find(dom.host, node => node.attributes["aria-label"] === "Estimated capacity at 100% by cycle")).toBeUndefined();
  } finally { await act(async () => root.unmount()); bounds.mockRestore(); accounts.mockRestore(); read.mockRestore(); dom.restore(); }
});

test("cycles of active subscriptions of different providers share one list in their colours, without a median; the drawer leaves cycles out", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element);
  const accounts = [apiAccount("codex1", "codex"), apiAccount("claude-a", "claude"), apiAccount("claude-old", "claude")];
  const cards = accounts.map(account => ({ id: account.id, active: account.id !== "claude-old", group: account.vendor, vendorAccount: account.id })) as RosterCard[];
  const weekly = JSON.stringify(["weekly_all", "weekly", 10080]);
  const entry = (account: string, provider: string, counter: string, windows: CodexComparisonWindow[]): CapacityCyclesEntry =>
    ({ account, provider, counter, counter_label: counter, windows });
  const read = spyOn(api, "capacityCycles").mockImplementation(async options => ({ ...options, accounts: [
    entry("codex1", "codex", "weekly", [cycle("codex1", "weekly", 1, 1400), cycle("codex1", "weekly", 8, 1500)]),
    entry("claude-a", "claude", weekly, [cycle("claude-a", weekly, 2, 2000)]),
    entry("claude-old", "claude", weekly, [cycle("claude-old", weekly, 3, 900)]),
  ] }));
  setLanguage("en");
  try {
    await act(async () => root.render(<GlobalCapacity accounts={accounts} cards={cards} />));
    await flushUntil(() => dom.host.textContent.includes("3 cycles"));
    // Every subscription's stored cycles arrive in one read; the inactive one is listed but not chosen.
    expect(read).toHaveBeenCalledTimes(1);
    const rows = findAll(dom.host, node => node.tagName === "ARTICLE");
    expect(rows.map(row => find(row, node => node.className === "capacity-subject")?.textContent)).toEqual(["Codex · codex1", "Claude · claude-a", "Codex · codex1"]);
    expect(dom.host.textContent).not.toContain("vs median");
    const fills = findAll(dom.host, node => node.className === "capacity-bar-fill").map(node => node.style.background);
    expect(new Set(fills)).toEqual(new Set(["var(--codex)", "var(--claude)"]));

    await invoke(find(dom.host, node => node.tagName === "BUTTON" && node.textContent.startsWith("Subscriptions and cycles"))!, "onClick");
    await flushUntil(() => dom.host.textContent.includes("claude-old"));
    // Opening the drawer reads nothing more.
    expect(read).toHaveBeenCalledTimes(1);
    // A subscription opens its cycles; opening chooses nothing.
    const switches = () => findAll(dom.host, node => node.getAttribute("role") === "switch" && node.getAttribute("aria-label")?.startsWith("codex1 · ") === true);
    expect(switches()).toHaveLength(0);
    await invoke(find(dom.host, node => node.tagName === "BUTTON" && node.getAttribute("aria-label") === "Codex · codex1")!, "onClick");
    await flushUntil(() => switches().length === 2);
    expect(dom.host.textContent).toContain("3 cycles");
    expect(switches().map(node => node.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    const choice = switches()[0]!;
    const stopPropagation = spyOn({ stop() {} }, "stop");
    await invoke(choice, "onClick", { stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    await flushUntil(() => dom.host.textContent.includes("2 cycles"));
    expect(findAll(dom.host, node => node.tagName === "ARTICLE")).toHaveLength(2);
    expect(switches().map(node => node.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    await invoke(choice, "onClick", { stopPropagation });
    expect(switches().map(node => node.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(findAll(dom.host, node => node.tagName === "ARTICLE")).toHaveLength(3);

    await invoke(find(dom.host, node => node.getAttribute("aria-label") === "Clear · Codex")!, "onClick");
    expect(switches().map(node => node.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(findAll(dom.host, node => node.tagName === "ARTICLE")).toHaveLength(1);
    await invoke(switches()[0]!, "onClick", { stopPropagation });
    expect(switches().map(node => node.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(findAll(dom.host, node => node.tagName === "ARTICLE")).toHaveLength(2);
    await invoke(find(dom.host, node => node.getAttribute("aria-label") === "Select all · Codex")!, "onClick");
    expect(switches().map(node => node.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(findAll(dom.host, node => node.tagName === "ARTICLE")).toHaveLength(3);
  } finally { await act(async () => root.unmount()); read.mockRestore(); dom.restore(); }
});

test("100% cells show missing-estimate reasons and battle plans name missing price and estimate", () => {
  const subject: CapacityAccount = { id: "codex1", provider: "codex", active: true, label: "Codex" };
  const small = { ...cycle("codex1", "weekly", 1, 1), observed_pp: 1 };
  const noTraffic = { ...cycle("codex1", "weekly", 8, 0), usage: emptyWindowUsage() };
  try {
    for (const language of ["en", "pl"] as const) {
      setLanguage(language);
      const smallText = language === "en" ? "sample too small" : "za mała próbka";
      const missingText = language === "en" ? "Meter only · no matched traffic" : "Sam licznik · brak dopasowanego ruchu";
      const global = renderToStaticMarkup(<CycleTable subject={subject} cycles={[small, noTraffic]} unit="api_standard" basis="observed"
        checked={() => true} onToggle={() => {}} />);
      const battle = renderToStaticMarkup(<AttachList subjects={[subject]} cycles={[small, noTraffic].map(window => ({ subject, window }))}
        tier={20} reading={false} unit="api_standard" basis="observed" chosen={new Set()} onChange={() => {}} />);
      for (const html of [global, battle]) {
        expect(html).toContain(`ui-missing">${smallText}</span>`);
        expect(html).toContain(`ui-missing">${missingText}</span>`);
        expect(html.match(/title="[^"]*"/g)?.some(title => title.includes(smallText))).toBe(true);
        expect(html).not.toContain('class="is-num">—</td>');
      }
      const plan = renderToStaticMarkup(<PlanCell cell={{ provider: "codex", tier: 20, label: "Pro", usdPerMonth: null,
        attached: [], counted: 0, value: null, source: "empty", from: null, perDollar: null }} sources={[]}
        format={capacityUnitFormat("api_standard", language)} showRatio onAttach={() => {}} onDerive={() => {}} />);
      expect(plan).toContain(language === "en" ? "no price" : "brak ceny");
      expect(plan).toContain(language === "en" ? "no estimate" : "brak szacunku");
    }
  } finally { setLanguage("en"); }
});
