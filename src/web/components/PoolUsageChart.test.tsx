import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WindowChart } from "./WindowStatusCard";
import { creditPoolsInRange, type CreditPoolState } from "../../shared/credit-pools";
import { codexPoolEvidence, poolUsage } from "../../shared/pool-usage";
import { windowPoolSeries } from "../lib/pool-series";
import { setLanguage } from "../lib/i18n";
import type { UnitInput } from "../lib/window-units";

const start = Date.parse("2026-10-18T00:00:00Z"), day = 86400000, end = start + day * 7;
afterEach(() => setLanguage("en"));
const range = (unit: "usd" | "credits") => {
  const pool = (used: number): CreditPoolState => ({ key: "same-pool", kind: "grant", unit, granted: 250, used, remaining: 250 - used,
    remaining_text: null, unlimited: false, granted_at: null, expires_at: null, items: null });
  return creditPoolsInRange([{ ts: new Date(start).toISOString(), pools: [pool(0)] },
    { ts: new Date(start + 2 * day).toISOString(), pools: [pool(20)] },
    { ts: new Date(start + 3 * day).toISOString(), pools: [pool(25)] }], start, end)!;
};
const input = (unit: "usd" | "credits"): UnitInput => ({ pools: range(unit), startMs: start, spanMs: end-start, usedPercent: 50,
  blocks: [{ start_ts: new Date(start).toISOString(), end_ts: new Date(start+day).toISOString(), tokens: 10000, usd: 100, credits: 100 }],
  atLimit: null, creditFunded: null, windowTokens: 10000, nowMs: end });
const render = (unit: "usd" | "credits") => renderToStaticMarkup(<WindowChart startMs={start} spanMs={end-start} endMs={end}
  active={false} reading={{t:50,pct:50}} insight={null} linearEnd={null} exhaustionIso={null} tokensByDay={null} units={{input:input(unit)}} />);

test("both pool currencies share one plot and percentage axis, each additional curve starting at zero", () => {
  const dollars = render("usd"), credits = render("credits");
  for (const html of [dollars, credits]) {
    expect(html.match(/<svg\b/g)).toHaveLength(1);
    expect(html).toContain('data-pool-usage-chart');
    expect(html).toContain('points="44.0,244.0');
    expect(html).toContain("≈ 13%");
  }
  const points = (html: string) => [...html.matchAll(/<polyline points="([^"]+)"/g)].map(match => match[1]);
  expect(points(dollars)).toEqual(points(credits));
});

test("current measured mix supplies approximate equivalents, not a new funding attribution", () => {
  const data = input("usd"), pools = poolUsage(data.pools);
  const percent = windowPoolSeries(pools,"pct",data)[0]!;
  expect(percent.value).toBe(12.5); expect(percent.points.at(-1)!.pct).toBe(12.5);
  expect(percent.estimate).toBe(true); expect(percent.nativeValue).toBe(25);
  expect(windowPoolSeries(pools,"tokens",data)[0]!.value).toBe(2500);
  expect(windowPoolSeries(pools,"credits",data)[0]!.value).toBe(25);
  const native = windowPoolSeries(pools,"usd",data)[0]!;
  expect(native.value).toBe(25); expect(native.estimate).toBe(false);
  expect(pools[0]!.funded).toBeNull();
  expect(render("usd")).toContain("does not identify which calls the pool funded");
});

test("missing history, insufficient percentage and unpriced denominators never become invented curves", () => {
  const data = input("usd");
  const older = range("usd"); delete older.timelines;
  expect(windowPoolSeries(poolUsage(older),"pct",data)[0]).toMatchObject({points:[],value:null,unavailable:"history",nativeValue:25});
  for (const changed of [{...data,usedPercent:2}, {...data,blocks:data.blocks!.map(block=>({...block,usd_partial:true}))}, {...data,blocks:null}]) {
    expect(windowPoolSeries(poolUsage(data.pools),"pct",changed)[0]).toMatchObject({points:[],value:null,unavailable:"conversion",nativeValue:25});
  }
});

test("already counted current totals supply the conversion without fabricating detailed blocks", () => {
  const data = {...input("usd"),blocks:null,counted:{tokens:10000,usd:100}};
  const row=windowPoolSeries(poolUsage(data.pools),"pct",data)[0]!;
  expect(row.value).toBe(12.5); expect(row.estimate).toBe(true);
  expect(data.blocks).toBeNull();
});

test("grant day bars share the existing chart while remaining observed debits with unknown call funding", () => {
  const data=input("usd");
  const html=renderToStaticMarkup(<WindowChart startMs={start} spanMs={end-start} endMs={end} active={false}
    reading={{t:50,pct:50}} insight={null} linearEnd={null} exhaustionIso={null} tokensByDay={new Map()} units={{input:data}} />);
  expect(html.match(/<svg\b/g)).toHaveLength(1);
  expect(html.match(/data-observed-pool-bar/g)).toHaveLength(2);
  expect(html).toContain("observed account spend / day");
  expect(html).not.toContain("paid from credits");
});

test("known funded calls keep their exact saved units and the approved percentage bar denominator", () => {
  const data = input("credits");
  const funded = {poolKey:"same-pool",unit:"credits" as const,native:10,nativeUnpriced:0,apiUnpriced:0,calls:2,tokens:1000,apiUsd:5,
    buckets:[{from:new Date(start+day).toISOString(),until:new Date(start+day+3600000).toISOString(),native:10,calls:2,tokens:1000,apiUsd:5}]};
  const pools = poolUsage(data.pools,funded);
  for (const [mode,expected] of [["pct",10],["tokens",1000],["usd",5],["credits",10]] as const) {
    const row=windowPoolSeries(pools,mode,data).find(row=>row.basis==="funded")!;
    expect(row.value).toBe(expected); expect(row.points[0]!.pct).toBe(0);
    expect(row.estimate).toBe(mode==="pct");
  }
  expect(windowPoolSeries(pools,"usd",data).find(row=>row.basis==="observed")!.value).toBe(25);
});

test("the plot selects known funded calls once; observed account debits remain independent facts", () => {
  const data=input("credits");
  data.creditFunded={calls:1,tokens:1000,credits:10,credits_unpriced:0,api_standard:5,api_unpriced:0,
    first:new Date(start+day).toISOString(),last:new Date(start+day).toISOString(),hours:[[new Date(start+day).toISOString(),1,1000,10,5]]};
  const html=renderToStaticMarkup(<WindowChart startMs={start} spanMs={end-start} endMs={end} active={false}
    reading={{t:50,pct:50}} insight={null} linearEnd={null} exhaustionIso={null} tokensByDay={new Map()} units={{input:data}} />);
  // Use a matching pool identity, as the Codex adapter does in the application.
  expect(codexPoolEvidence(data.creditFunded)!.poolKey).toBe("codex:credits");
  expect(html.match(/data-pool-basis="funded"/g)).toHaveLength(1);
  const codexData={...data,pools:{...data.pools!,pools:data.pools!.pools.map(p=>({...p,key:"codex:credits",kind:"balance" as const})),
    timelines:data.pools!.timelines!.map(t=>({...t,key:"codex:credits",kind:"balance" as const})),flows:data.pools!.flows.map(f=>({...f,key:"codex:credits"}))}};
  const one=renderToStaticMarkup(<WindowChart startMs={start} spanMs={end-start} endMs={end} active={false}
    reading={{t:50,pct:50}} insight={null} linearEnd={null} exhaustionIso={null} tokensByDay={new Map()} units={{input:codexData}} />);
  expect(one.match(/data-pool-series=/g)).toHaveLength(1);
  expect(one).not.toContain('data-pool-basis="observed"');
  expect(poolUsage(codexData.pools,codexPoolEvidence(data.creditFunded))[0]!.observedSpend).toBe(25);
});
