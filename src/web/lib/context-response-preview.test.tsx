import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { findByAttribute, installTestDom } from "./test-dom-harness";
import { useAsync } from "./useAsync";
import { setContextPreview } from "./context-premium";
import { responseWithContextPreview } from "../../shared/context-preview";
import type { ContextPreviewResponse } from "../../shared/context-preview";
import { previewContextAmount } from "../../shared/context-price";
import { AppHeader } from "../components/AppHeader";
import { ContextReportScreen } from "./use-context-companion";
import { registerContextCompanion } from "./context-companion";
import { get, bustApiMemo, refreshApiData } from "./api/transport";
import { setLanguage } from "./i18n";
import { CONTEXT_RESPONSE_PATHS } from "../../shared/context-preview";

test.each([...CONTEXT_RESPONSE_PATHS])("%s transport keeps default reads separate and fetches context only while ON", async path => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement), originalFetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: document.location });
  const requests: URL[] = [];
  globalThis.fetch = (async input => {
    const url = new URL(String(input)); requests.push(url);
    return Response.json(url.searchParams.get("context") === "1"
      ? { usd: 2, context_preview: { usd: 3 }, context_preview_status: { ready: true, revision: 1, missing_groups: 0 } }
      : { usd: 2 });
  }) as typeof fetch;
  function Screen() {
    const state = useAsync(signal => get<{usd:number}>(path, { account: "same-scope", since: "2026-10-01", ...(path==="/api/plan-capacity"?{provider:"codex"}:{}),
      ...(path === "/api/repo-history" ? { project: "a" } : {}) }, signal), []);
    return <span>{state.data?.usd}{state.loading ? " reading" : ""}</span>;
  }
  try {
    bustApiMemo(); setContextPreview(false);
    await act(async () => root.render(<ContextReportScreen.Provider value={path==="/api/plan-capacity"?"settings":path==="/api/billing-cycles"?"periods":path==="/api/subscription-rate"?"shares":path==="/api/project-plan"?"projects":"usage"}><Screen /></ContextReportScreen.Provider>));
    expect(dom.host.textContent).toBe("2"); expect(requests).toHaveLength(1); expect(requests[0]!.searchParams.has("context")).toBe(false);
    await act(async () => setContextPreview(true));
    expect(dom.host.textContent).toBe("3"); expect(requests).toHaveLength(2);
    expect(requests[1]!.searchParams.get("context")).toBe("1");
    expect(requests[1]!.searchParams.get("account")).toBe("same-scope");
    expect(requests[1]!.searchParams.get("since")).toBe("2026-10-01");
    await act(async () => setContextPreview(false));
    expect(dom.host.textContent).toBe("2"); expect(requests).toHaveLength(2);
  } finally {
    await act(async () => root.unmount()); setContextPreview(false); globalThis.fetch = originalFetch; bustApiMemo();
    if (location) Object.defineProperty(globalThis, "location", location); else Reflect.deleteProperty(globalThis, "location"); dom.restore();
  }
});

test("context publication refreshes only the companion, and OFF unsubscribes it", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement), originalFetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: document.location });
  let defaults = 0, previews = 0;
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    if (url.searchParams.get("context") === "1") {
      previews++; return Response.json({ usd: 2, context_preview: { usd: 2 + previews }, context_preview_status: { ready: true, revision: previews, missing_groups: 0 } });
    }
    defaults++; return Response.json({ usd: 2 });
  }) as typeof fetch;
  function Screen() { const state = useAsync(signal => get<{usd:number}>("/api/summary", undefined, signal), []); return <span>{state.data?.usd}</span>; }
  try {
    bustApiMemo(); setContextPreview(true);
    await act(async () => root.render(<ContextReportScreen.Provider value="usage"><Screen /></ContextReportScreen.Provider>));
    expect(dom.host.textContent).toBe("3"); expect(defaults).toBe(1); expect(previews).toBe(1);
    await act(async () => refreshApiData({ unchanged: ["/api/summary"] }));
    expect(dom.host.textContent).toBe("4"); expect(defaults).toBe(1); expect(previews).toBe(2);
    await act(async () => setContextPreview(false));
    await act(async () => refreshApiData({ unchanged: ["/api/summary"] }));
    expect(dom.host.textContent).toBe("2"); expect(defaults).toBe(1); expect(previews).toBe(2);
  } finally {
    await act(async () => root.unmount()); setContextPreview(false); globalThis.fetch = originalFetch; bustApiMemo();
    if (location) Object.defineProperty(globalThis, "location", location); else Reflect.deleteProperty(globalThis, "location"); dom.restore();
  }
});

test("a pending companion keeps stored data visible, cancels on OFF and ignores late completion", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  let reads = 0, resolve!: (body: unknown) => void, signal: AbortSignal | undefined;
  const base = { usd: 2 };
  registerContextCompanion(base, new URL("http://test/api/summary"), incoming => {
    reads++; signal = incoming; return new Promise(done => { resolve = done; });
  });
  function Screen() { const state = useAsync(async () => base, []); return <span>{state.data?.usd}{state.loading ? " reading" : ""}</span>; }
  try {
    setContextPreview(true);
    await act(async () => root.render(<ContextReportScreen.Provider value="settings"><Screen /></ContextReportScreen.Provider>));
    expect(reads).toBe(0); expect(dom.host.textContent).toBe("2");
    await act(async () => root.render(<ContextReportScreen.Provider value="usage"><Screen /></ContextReportScreen.Provider>));
    expect(reads).toBe(1); expect(dom.host.textContent).toBe("2 reading");
    await act(async () => setContextPreview(false));
    expect(signal?.aborted).toBe(true); expect(dom.host.textContent).toBe("2"); expect(reads).toBe(1);
    await act(async () => resolve({ usd: 2, context_preview: { usd: 8 }, context_preview_status: { ready: true, revision: 1, missing_groups: 0 } }));
    expect(dom.host.textContent).toBe("2"); expect(reads).toBe(1);
  } finally { await act(async () => root.unmount()); setContextPreview(false); dom.restore(); }
});

test("unfinished projection polling advances only the companion and stops when ready", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  let defaults = 0, previews = 0;
  const base = { usd: 2 };
  registerContextCompanion(base, new URL("http://test/api/summary"), async () => ++previews === 1
    ? { usd: 2, context_preview_status: { ready: false, revision: 0, missing_groups: 0 } }
    : { usd: 2, context_preview: { usd: 3 }, context_preview_status: { ready: true, revision: 1, missing_groups: 0 } });
  function Screen() { const state = useAsync(async () => { defaults++; return base; }, []); return <span>{state.data?.usd}</span>; }
  try {
    setContextPreview(true);
    await act(async () => root.render(<ContextReportScreen.Provider value="usage"><Screen /></ContextReportScreen.Provider>));
    expect(dom.host.textContent).toBe("2"); expect(previews).toBe(1); expect(defaults).toBe(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
    expect(dom.host.textContent).toBe("3"); expect(previews).toBe(2); expect(defaults).toBe(1);
    await act(async () => setContextPreview(false));
    expect(dom.host.textContent).toBe("2"); expect(previews).toBe(2); expect(defaults).toBe(1);
  } finally { await act(async () => root.unmount()); setContextPreview(false); dom.restore(); }
});

test("off is identity, on uses the prepared fold, leaves other providers and payments unchanged", () => {
  const other = { provider: "claude", usd: 7 }, paid = { paid_usd: 20, catalog_usd: 30 };
  type MoneyReport = { rows: {provider:string;usd:number}[]; paid_usd:number; catalog_usd:number };
  const report: MoneyReport & ContextPreviewResponse<MoneyReport> = { rows: [{ provider: "codex", usd: 2 }, other], ...paid,
    context_preview_status: { ready: true, revision: 1, missing_groups: 0 },
    context_preview: { rows: [{ provider: "codex", usd: 3 }, other], ...paid } };
  const original = JSON.stringify(report);
  expect(responseWithContextPreview(report, false)).toBe(report);
  const on = responseWithContextPreview(report, true);
  expect(on.rows[0]!.usd).toBe(3); expect(on.rows[1]).toBe(other);
  expect(on.paid_usd).toBe(20); expect(on.catalog_usd).toBe(30);
  expect(JSON.stringify(report)).toBe(original);
  expect(responseWithContextPreview([report], true)[0]).toBe(report.context_preview);
  expect(responseWithContextPreview({ generation: 4, payload: report }, true).payload).toBe(report.context_preview!);
});

test("preparing, incomplete and old-server responses retain their stored values, including zeros", () => {
  for (const status of [{ ready: false, revision: 1, missing_groups: 0 }, { ready: true, revision: 2, missing_groups: 1 }]) {
    const response = { usd: 0, context_preview: { usd: 9 }, context_preview_status: status };
    expect(responseWithContextPreview(response, true)).toBe(response);
  }
  const legacy = { usd: null }; expect(responseWithContextPreview(legacy, true)).toBe(legacy);
});

test("switching ON reads only the lazy companion; OFF immediately restores the retained default", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  let reads = 0, companions = 0;
  const response = { usd: 2, context_preview: { usd: 3 }, context_preview_status: { ready: true, revision: 1, missing_groups: 0 } };
  const base = { usd: 2 };
  registerContextCompanion(base, new URL("http://test/api/summary"), async () => { companions++; return response; });
  function Screen() { const state = useAsync(async () => { reads++; return base; }, []); return <span>{state.data?.usd}</span>; }
  try {
    setContextPreview(false);
    await act(async () => root.render(<ContextReportScreen.Provider value="usage"><Screen /></ContextReportScreen.Provider>)); expect(dom.host.textContent).toBe("2"); expect(companions).toBe(0);
    await act(async () => setContextPreview(true)); expect(dom.host.textContent).toBe("3"); expect(reads).toBe(1); expect(companions).toBe(1);
    await act(async () => setContextPreview(false)); expect(dom.host.textContent).toBe("2"); expect(reads).toBe(1); expect(companions).toBe(1);
  } finally { await act(async () => root.unmount()); setContextPreview(false); dom.restore(); }
});

test("explicit request splits add only uplift and handle included and zero stored values", () => {
  expect(previewContextAmount(2 as number, { base: 99, extra: 3, stored: 2, included: false }, true)).toBe(5);
  expect(previewContextAmount(2, { base: 99, extra: 3, stored: 2, included: true }, true)).toBe(2);
  expect(previewContextAmount(0 as number, { base: 0, extra: 3, stored: 0, included: false }, true)).toBe(3);
});

test("incomplete projection coverage is visible in the existing header tooltip without replacing stored values", async () => {
  const dom = installTestDom(), root = createRoot(dom.host as unknown as HTMLElement);
  const base = { usd: 2 };
  registerContextCompanion(base, new URL("http://test/api/summary"), async () => ({ usd: 2, context_preview_status: { ready: false, revision: 1, missing_groups: 0 } }));
  function Screen() {
    const state = useAsync(async () => base, []);
    return <><AppHeader account="" accounts={[]} theme="light" onToggleTheme={()=>{}} onOpenPalette={()=>{}} goto={()=>{}} contextPreviewApplies />
      <span>{state.data?.usd}</span></>;
  }
  try {
    setLanguage("en"); setContextPreview(true);
    await act(async () => root.render(<ContextReportScreen.Provider value="usage"><Screen /></ContextReportScreen.Provider>));
    expect(dom.host.textContent).toContain("2");
    const toggle = findByAttribute(dom.host, "role", "switch")!;
    expect(toggle.getAttribute("title")).toContain("Context prices are being prepared; stored amounts are retained.");
    expect(toggle.hasAttribute("data-unsupported")).toBe(true);
  } finally { await act(async () => root.unmount()); setContextPreview(false); dom.restore(); }
});

test("Overview historical sample envelopes load detail companions only on ON and restore their own defaults",async()=>{
  const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement);let reads=0,previews=0;
  const base={totals:{usd:2}},history={key:"history",samples:[{index:1,data:base}]};
  registerContextCompanion(base,new URL("http://test/api/cycle-breakdown"),async()=>{previews++;return {...base,
    context_preview:{totals:{usd:3}},context_preview_status:{ready:true,revision:1,missing_groups:0}};});
  function Screen(){const state=useAsync(async()=>{reads++;return history;},[]);return <span>{state.data?.samples[0]?.data.totals.usd}</span>;}
  try{
    setContextPreview(false);await act(async()=>root.render(<ContextReportScreen.Provider value="overview"><Screen/></ContextReportScreen.Provider>));
    expect(dom.host.textContent).toBe("2");expect(previews).toBe(0);
    await act(async()=>setContextPreview(true));expect(dom.host.textContent).toBe("3");expect(previews).toBe(1);expect(reads).toBe(1);
    await act(async()=>setContextPreview(false));expect(dom.host.textContent).toBe("2");expect(previews).toBe(1);expect(reads).toBe(1);
  }finally{await act(async()=>root.unmount());setContextPreview(false);dom.restore();}
});

test("Settings capacity maps lazily load plan companions and OFF restores the original map without reads",async()=>{
 const dom=installTestDom(),root=createRoot(dom.host as unknown as HTMLElement);let reads=0;
 const base={api_usd_per_1pct:2},map=new Map([["plan",base]]);
 registerContextCompanion(base,new URL("http://test/api/plan-capacity?provider=codex"),async()=>{reads++;return {...base,context_preview:{api_usd_per_1pct:3},context_preview_status:{ready:true,revision:1,missing_groups:0}};});
 function Screen(){const state=useAsync(async()=>map,[]);return <span>{state.data?.get("plan")?.api_usd_per_1pct}</span>;}
 try{setContextPreview(false);await act(async()=>root.render(<ContextReportScreen.Provider value="settings"><Screen/></ContextReportScreen.Provider>));expect(dom.host.textContent).toBe("2");expect(reads).toBe(0);
 await act(async()=>setContextPreview(true));expect(dom.host.textContent).toBe("3");expect(reads).toBe(1);
 await act(async()=>setContextPreview(false));expect(dom.host.textContent).toBe("2");expect(reads).toBe(1);expect(map.get("plan")).toBe(base);
 }finally{await act(async()=>root.unmount());setContextPreview(false);dom.restore();}
});
