import { expect, test, spyOn } from "bun:test";
import { Database } from "../../db/sqlite";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { buildSubscriptionAccountingReport } from "../../server/subscription-accounting";
import { emptyPreparedDatabase } from "../../server/subscription-reader.fixture";
import type { RateCard } from "../../server/pricing";
const EMPTY_RATES = { version: 1, currency: "USD", unit: "per 1M", vendors: {} } as unknown as RateCard;
import { emptyWindowUsage } from "../../server/subscription-window-comparison";
import { emptyWindowEvidence } from "../../server/subscription-evidence";
import { api, bustApiMemo, type ApiAccount, type SyncStatus } from "../lib/api";
import { emptyModel } from "../lib/cycle";
import { setLanguage } from "../lib/i18n";
import { installTestDom, flushUntil, findByAttribute, invoke } from "../lib/test-dom-harness";
import type { RosterCard } from "../lib/roster";
import type { ScreenProps } from "../lib/screens";
import { Capacity } from "./Capacity";
import { App } from "../App";

test("Capacity loads its prepared report while the shell's cycle history is still pending",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as Element),db=emptyPreparedDatabase(EMPTY_RATES);
  globalThis.requestAnimationFrame=(()=>0) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame=()=>{};
  const mocks=[
    spyOn(api,"accounts").mockResolvedValue({subscriptions:[{id:"codex1",vendor:"codex",plan:"pro",homes:[],windows:[],limit_ids:[]}]} as any),
    spyOn(api,"projects").mockResolvedValue({projects:[]} as any),
    spyOn(api,"setupStatus").mockResolvedValue({configured:true} as any),
    spyOn(api,"roster").mockResolvedValue({window_minutes:10080,count:1,accounts:[{
      id:"codex1",vendor:"codex",plan:"pro",label:"codex1",
      capabilities:{hasGaugeSeries:true,hasTokenDetail:true,hasCalibration:false,hasSecondWindow:true,reportsSide:"used",unit:"token"},
      has_gauge:false,active:true,vendor_account:null,vendor_account_source:null,
      first_seen:null,last_seen:null,cycle_count:0,probe:null,live:null,live_other:[],
      basis:"gauge",note:null,gauge_age_hours:null,empty_reason:null,cycles:[],
      shadow:null,claude:null,gemini:null,grok:null,glm:null,
    }]}),
    spyOn(api,"syncStatus").mockResolvedValue({running:false} as any),
    spyOn(api,"usageSeries").mockImplementation(()=>new Promise(()=>{})),
    spyOn(api,"codexTimelineMarkers").mockResolvedValue({revision:"empty",markers:[],automatic:[]}),
  ];
  const accounting=spyOn(api,"codexAccounting").mockImplementation(async options=>{
    const result=buildSubscriptionAccountingReport({sqlite:db,rateCards:{version:1,currency:"USD",unit:"per 1M",vendors:{}},plans:{},plansCatalog:{provider_groups:[]}},"claude",{...options,account:"codex1"});
    result.provider={...result.provider!,id:"codex"};return result;
  });
  setLanguage("en");bustApiMemo();
  try {
    await act(async()=>root.render(<App/>));
    await invoke(findByAttribute(dom.host,"aria-label","Capacity")!,"onClick");
    await flushUntil(()=>accounting.mock.calls.length===1 && !dom.host.textContent.includes("Loading subscription analysis"));
    expect(dom.host.textContent).toContain("codex1");
    expect(dom.host.textContent).toContain("No cycles with a usable meter reading");
    expect(dom.host.textContent).not.toContain("Loading…");
    expect(api.usageSeries).toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());accounting.mockRestore();for(const mock of mocks)mock.mockRestore();bustApiMemo();db.close();dom.restore();}
});

for (const global of [false, true]) test(`${global ? "global" : "selected"} capacity refreshes a running cycle after a data commit while synchronization continues`, async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as Element), db = emptyPreparedDatabase(EMPTY_RATES);
  Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost" } });
  const originalFetch = globalThis.fetch;
  let published = false, accountingReads = 0;
  let finishRefresh!: () => void;
  const refreshing = new Promise<void>(resolve => { finishRefresh = resolve; });
  const account: ApiAccount = { id: "a", vendor: "codex", plan: "pro", login: "a", machine: null, note: null, homes: [], ratelimit_rows: 0, event_rows: 0, windows: [], limit_ids: [], first_event_ts: null, last_event_ts: null, has_gauge: true, has_events: true };
  const card = { id: "a", active: true, group: "codex" } as RosterCard;
  const props: ScreenProps = { model: emptyModel("a", 10080), account: global ? "all" : "a", accounts: [account], card, capabilities: null,
    project: "", projects: [], unit: "percent", chosen: null, compare: [], windowRailInShell: false, sync: null,
    setUnit() {}, setProject() {}, selectAccount() {}, selectCycle() {}, openDrawer() {}, goto() {}, setCompare() {}, triggerSync() {} };
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    if (url.pathname.includes("timeline-markers")) return Response.json({ revision: "empty", markers: [], automatic: [] });
    const usage = published ? { ...emptyWindowUsage(), events: 20, tokens: 100_000, input: 90_000, output: 10_000, priced_tokens: 100_000, api_standard: 396, credits_low: 9900, credits_high: 9900 } : emptyWindowUsage();
    const window = { id: "running", account: "a", plan: "pro", window_minutes: 10080,
      start: "2099-09-12T00:00:00Z", end: "2099-09-12T08:00:00Z", reset: "2099-09-19T00:00:00Z",
      start_percent: 0, end_percent: 36, observed_pp: 36, probes: 20, max_gap_hours: 0.25,
      usage, sources: [], models: [], plan_detail: { status: "resolved" as const, label: "Pro", multiplier: 20 },
      promotion: { status: "configured" as const, factor: 1, regime_ids: [], notes: [], sources: [] },
      evidence: { ...emptyWindowEvidence(), imports: { stored_runs: 1, inspected_runs: 1, unreadable_runs: 0, truncated: false, related_count: 1,
        related: [{ id: "sync", started: "2099-09-12T00:00:00Z", status: published ? "success" : "pending", has_error: false, warnings: 0, relation: "run_time" as const }] } } };
    // The global comparison reads every subscription's stored cycles in one request.
    if (global && url.pathname === "/api/capacity-cycles") {
      accountingReads++;
      if (published) await refreshing;
      return Response.json({ since: url.searchParams.get("since"), until: url.searchParams.get("until"), window_minutes: 10080,
        accounts: [{ account: "a", provider: "codex", counter: "weekly", counter_label: "Weekly", windows: [window] }] });
    }
    if (global || url.pathname !== "/api/codex-accounting") throw new Error("Unexpected request " + url.pathname);
    accountingReads++;
    if (published) await refreshing;
    const scope = { since: url.searchParams.get("since")!, until: url.searchParams.get("until")!, account: url.searchParams.get("account") ?? undefined };
    const report = buildSubscriptionAccountingReport({ sqlite: db, rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} }, plans: {}, plansCatalog: { provider_groups: [] } }, "claude", { ...scope, account: "a" });
    report.scope = scope;
    report.provider = { ...report.provider!, id: "codex", counter: "weekly", counters: [{ id: "weekly", label: "Weekly" }] };
    report.windows = [window];
    return Response.json(report);
  }) as typeof fetch;
  const render = (revision: number) => root.render(<Capacity {...props} cards={[card]} sync={{ running: true, revisions: { data: revision, config: 1, derived: 1 } } as SyncStatus} />);
  setLanguage("en"); bustApiMemo();
  try {
    await act(async () => render(10));
    await flushUntil(() => dom.host.textContent.includes(global ? "Codex · a" : "Meter available · traffic import in progress"));
    expect(accountingReads).toBe(1);
    if (!global) expect(dom.host.textContent).toContain("36%");
    published = true;
    await act(async () => render(11));
    await flushUntil(() => accountingReads === 2);
    if (!global) {
      expect(dom.host.textContent).toContain("36%");
      expect(dom.host.textContent).toContain("Meter available · traffic import in progress");
      expect(dom.host.textContent).not.toContain("Loading subscription analysis");
    }
    await act(async () => finishRefresh());
    await flushUntil(() => accountingReads === 2 && dom.host.textContent.includes("1,100"));
    expect(dom.host.textContent).not.toContain("Meter available · traffic import in progress");
    expect(dom.host.textContent).not.toContain("No eligible measurements");
    await act(async () => render(11));
    expect(accountingReads).toBe(2);
  } finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; bustApiMemo(); db.close(); dom.restore(); }
});
