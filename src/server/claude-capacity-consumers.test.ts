import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { loadAccountResolver } from "./account-resolver";
import { loadProbeLimitEvidence } from "./probe-limit-windows";
import { createClaudeCodeAcceptanceFixture, measureAnalysis, ACCOUNTS, TIMES } from "./claude-code-capacity.fixture";
import { prepareClaudeReaderFixture } from "./subscription-reader.fixture";
import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { encodeClaudeCodeProductShare, encodeClaudeProductBreakdown } from "../providers/adapters/claude";
import { buildClaudeLimit, claudeAccountId, type ClaudeGaugeConfig } from "./claude-limit";
import { buildSubscriptionCapacities, computeEquivalentsAndProvenance } from "./capacity-equivalents";
import { buildClaudeCodeCapacityReport } from "./claude-code-capacity";
import { handleClaudeAccountSplits, handleClaudeLimit, type AppContext } from "./api";
import { getClaudeRate, type RateCard } from "./pricing";
import { probeReaderFixtureSource, prepareProbeReaderFixture } from "./probe-reader.fixture";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { claudeAccountSplit, OUTSIDE_CODE_PRODUCT_KEY, shareOnlyProductRows, sumClaudeAccountSplits, type ClaudeAccountSplitsResponse } from "../shared/claude-code-capacity";

const START = "2026-09-10T00:00:00.000Z", NOW = "2026-09-13T00:00:00.000Z", RESET = "2026-09-17T00:00:00.000Z";
const rates = { version: 1, currency: "USD", unit: "per 1M", vendors: { anthropic: { source: "test", models: { sonnet: { in_uncached: 1, in_cache_read: 0, in_cache_write: 0, out_total: 0 } } } } } as unknown as RateCard;
const price = (m: string | null, d: string, s: string | null) => getClaudeRate(rates, m, d, s);
const cfg: ClaudeGaugeConfig = { subscription: "seat", plan: "Max", window_hours: 168, observations: [] };
/** The maintenance worker publishes window sums (and the gauge's observation intervals) before a read. */
const publish = (db: Database, gauge: ClaudeGaugeConfig = cfg) => prepareWindowUsageFixture(db, { rateCards: rates, claudeGauge: gauge,
  manualCapacity: () => [], cycles: { windows: [] }, nowMs: Date.parse(NOW) });
function fixture() {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  installAnalysisTracking(db);
  const sources = [probeReaderFixtureSource("claude", "seat"), probeReaderFixtureSource("claude", "other")];
  for (const [account, tokens] of [["seat",120000],["other",240000]] as const) {
    db.query(`INSERT INTO claude_events(store,call_id,ts,path,model,entrypoint,cc_version,subscription_id,in_uncached,speed)
      VALUES('live',?,'2026-09-11T00:00:00.000Z',?,'sonnet','cli','1',?,?,'standard')`)
      .run(account,`${sources.find(source => source.id === account)!.home}/${account}.jsonl`,account,tokens);
  }
  prepareProbeReaderFixture(db, sources);
  prepareClaudeReaderFixture(db,rates);
  const root = mkdtempSync(join(tmpdir(),"claude-consumer-"));
  return {db,root,sources,close(){db.close();rmSync(root,{recursive:true,force:true,maxRetries:5});}};
}
function observe(db: Database, used = 24, share: number | null = 12, account = "seat", scope: string | null = null) {
  const source = probeReaderFixtureSource("claude", account);
  const extra = share == null ? null : JSON.stringify(encodeClaudeCodeProductShare({schema:1,key:"claude_code",percent:share,
    as_of:NOW,window_started_at:START,display_name:"Claude Code"}));
  db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra,machine,reported_percent_side) VALUES('claude',?,?,'weekly_all',?,?,?,?,?,'used')")
    .run(account,NOW,scope,used,RESET,extra,source.machine);
  prepareProbeReaderFixture(db, [probeReaderFixtureSource("claude", "seat"), probeReaderFixtureSource("claude", "other")]);
  publish(db);
}
function capacity(db: Database, root: string, config = cfg) {
  // These fixtures exercise the native calculation, the mode called by the durable producer.
  // Stored-reader equivalence is covered by subscription-rate and project-plan integration tests.
  return buildSubscriptionCapacities(db,rates,new Map(),{fromStored:false,claudeGauge:config,grokGauge:{},rootDir:root}).get(config.subscription!)!;
}
test("limit and capacity consumers use the same unrounded Code reference and retain actual usage",()=>{
  const f=fixture();try {
    observe(f.db);
    const shared=buildClaudeCodeCapacityReport(f.db,"seat",{rateCards:rates},{now:NOW});
    const limit=buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates});
    const cap=capacity(f.db,f.root);
    const expected=shared.weekly_capacity_api_usd.value!;
    expect(expected).toBeCloseTo(4.166666666666667,12);
    expect(limit.calibration?.window_value_usd).toBe(expected);
    expect(cap.weekly_window_value_usd).toBe(expected);
    expect(cap.usd_per_point).toBe(expected/100);
    expect(computeEquivalentsAndProvenance(1.2,cap,{since:"2026-09-10",until:"2026-09-13"}).equivalents.weekly_cycles.absent).toBe("invalid_usage");
    expect(limit.calibration?.api_value_basis).toBe("standard");
    expect(limit.current?.remaining_usd).toBe(expected*76/100);
    expect(limit.current?.spend.gross).toBe(120000);
    expect(limit.models[0]?.window?.gross).toBe(120000);
    expect(limit.models[0]?.gross_tokens_per_point).toBeCloseTo(expected / 100 * 1e6, 8);
    expect(limit.models).toEqual(limit.claude_capacity!.models);
    expect(cap.claude_capacity).toEqual(limit.claude_capacity);
    expect(limit.current?.percent_all_est).toBeNull();
    expect(cap.session_window_value_usd).toBeNull();
    expect(computeEquivalentsAndProvenance(0.12,cap,{since:"2026-09-10",until:"2026-09-13"},0.12).equivalents.monthly_subscriptions.absent).toBe("cadence_uncalibrated");
    expect(limit.calibration?.basis).toBe("code_share");
  } finally {f.close();}
});
for (const [name,used,share,scope] of [["scoped",24,12,"sonnet"]] as const) {
  test(`Claude ${name} cannot fall back to all-traffic/global calibration`,()=>{
    const f=fixture();try {
      observe(f.db,used,share,"seat",scope);
      const limit=buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates});
      expect(limit.calibration).toBeNull();
      expect(limit.current?.remaining_usd ?? null).toBeNull();
      expect(capacity(f.db,f.root).weekly_window_value_usd).toBeNull();
      expect(capacity(f.db,f.root).session_window_value_usd).toBeNull();
    } finally {f.close();}
  });
}

test("Claude first 100% consumers retain the shared Code sample and actual usage",()=>{
  const f=fixture();try {
    observe(f.db,100,12);
    const shared=buildClaudeCodeCapacityReport(f.db,"seat",{rateCards:rates},{now:NOW});
    const limit=buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates});
    const cap=capacity(f.db,f.root);
    expect(shared.weekly_capacity_api_usd.value).toBe(1);
    expect(limit.calibration?.window_value_usd).toBe(shared.weekly_capacity_api_usd.value!);
    expect(limit.calibration?.traffic_scope).toBe("code_calibrated_account_equivalent");
    expect(limit.calibration?.basis).toBe("code_share");
    expect(limit.calibration?.covers_full_account).toBe(false);
    expect(limit.calibration?.source_percent_all).toBe(100);
    expect(limit.current?.remaining_usd).toBe(0);
    expect(limit.current?.spend.gross).toBe(120000);
    expect(cap.weekly_window_value_usd).toBe(shared.weekly_capacity_api_usd.value!);
    expect(cap.session_window_value_usd).toBeNull();
  } finally {f.close();}
});
test("explicit manual observations retain separately labelled local calibration",()=>{
  const f=fixture();try {
    const manual={...cfg,observations:[{ts:NOW,reset_ts:RESET,window_start_ts:START,percent:{all:24},source:"manual user observation"}]};
    publish(f.db,manual);
    const limit=buildClaudeLimit(f.db,manual,price,NOW,{rateCards:rates});
    expect(limit.calibration?.basis).toBe("manual");
    expect(limit.calibration?.traffic_scope).toBe("observed_local_claude_traffic");
    expect(limit.calibration?.window_value_usd).toBe(0.5);
    expect(capacity(f.db,f.root,manual).weekly_window_value_usd).toBe(0.5);
  } finally {f.close();}
});
test("explicit nonweekly manual calibration preserves its configured duration and result in comparisons", () => {
  const f = fixture();
  try {
    const manual = { ...cfg, window_hours: 5,
      observations: [{ ts: NOW, reset_ts: RESET, window_start_ts: START, percent: { all: 24 }, source: "manual user observation" }] };
    publish(f.db, manual);
    const limit = buildClaudeLimit(f.db, manual, price, NOW, { rateCards: rates });
    const cap = capacity(f.db, f.root, manual);
    expect(limit.claude_capacity?.window_minutes).toBe(300);
    expect(cap.claude_capacity).toEqual(limit.claude_capacity!);
    expect(cap.weekly_window_value_usd).toBe(0.5);
    expect(cap.usd_per_point).toBe(limit.claude_capacity!.capacity_api_usd.value! / 100);
    expect(cap.window_hours).toBe(5);
    expect(cap.session_window_value_usd).toBeNull();
  } finally { f.close(); }
});

test("legacy or malformed Claude gauge subscription stays unassigned without changing its observations",async()=>{
  const f=fixture();try {
    const manual={ts:NOW,reset_ts:RESET,window_start_ts:START,percent:{all:24},source:"manual user observation"};
    for (const subscription of [undefined,"","  ","claude"," CLAUDE "]) {
      expect(claudeAccountId(subscription)).toBeNull();
      const gauge:ClaudeGaugeConfig={subscription,plan:"Max",observations:[manual]};
      const original=JSON.stringify(gauge);
      const report=buildClaudeLimit(f.db,gauge,price,NOW,{rateCards:rates});
      expect(report.configured).toBe(false);
      expect(report.observations).toEqual([]);
      expect(report.calibration).toBeNull();
      expect(report.claude_code_capacity).toBeNull();
      expect([...buildSubscriptionCapacities(f.db,rates,new Map(),{fromStored:false,claudeGauge:gauge,grokGauge:{},rootDir:f.root}).values()]
        .filter(row=>row.vendor==="claude")).toEqual([]);
      const selected=buildSubscriptionCapacities(f.db,rates,new Map(),{
        fromStored:false,
        claudeGauge:gauge,claudeAccounts:["seat","other","claude"],grokGauge:{},rootDir:f.root,
      });
      expect([...selected.values()].filter(row=>row.vendor==="claude").map(row=>row.sub_id)).toEqual(["seat","other"]);
      expect(selected.get("seat")?.weekly_window_value_usd).toBeNull();
      expect(selected.get("other")?.weekly_window_value_usd).toBeNull();
      expect(JSON.stringify(gauge)).toBe(original);
      const ctx={sqlite:f.db,rateCards:rates,claudeGauge:gauge,
        accounts:{subscriptions:[]},vendorDiscovery:{accounts:[{id:"seat",vendor:"claude",plan:"Max"}]}} as unknown as AppContext;
      expect((await handleClaudeLimit(ctx,new URL("http://local/api/claude-limit")).json()).configured).toBe(false);
      expect((await handleClaudeLimit(ctx,new URL("http://local/api/claude-limit?account=seat")).json()).observations).toEqual([]);
      expect(handleClaudeLimit(ctx,new URL("http://local/api/claude-limit?account=claude")).status).toBe(404);
    }
  } finally {f.close();}
});
test("selected account API uses that account's shared estimate",async()=>{
  const f=fixture();try {
    observe(f.db);observe(f.db,24,12,"other");
    const ctx={sqlite:f.db,rateCards:rates,claudeGauge:cfg,vendorDiscovery:{accounts:[{id:"other",vendor:"claude",plan:"Max"}]}} as unknown as AppContext;
    const result=await handleClaudeLimit(ctx,new URL("http://local/api/claude-limit?account=other")).json();
    expect(result.claude_code_capacity.account).toBe("other");
    expect(result.calibration.window_value_usd).toBeCloseTo(8.333333333333334,12);
    expect(result.claude_code_capacity.observed_code_tokens).toBe(240000);
  } finally {f.close();}
});

test("weekly Code capacity does not calibrate a differently scoped configured window",()=>{
  const f=fixture();try {
    observe(f.db);
    const scoped={...cfg,window_hours:5};
    expect(buildClaudeLimit(f.db,scoped,price,NOW,{rateCards:rates}).calibration).toBeNull();
    expect(capacity(f.db,f.root,scoped).weekly_window_value_usd).toBeNull();
  } finally {f.close();}
});

test("manual calibration survives a same-window probe with no Code share",()=>{
  const f=fixture();try {
    observe(f.db,24,null);
    const manual={...cfg,observations:[{ts:NOW,reset_ts:RESET,window_start_ts:START,percent:{all:24},source:"manual user observation"}]};
    publish(f.db,manual);
    const report=buildClaudeLimit(f.db,manual,price,NOW,{rateCards:rates});
    expect(report.calibration?.basis).toBe("manual");
    expect(report.calibration?.window_value_usd).toBe(0.5);
    expect(report.current?.percent_all_measured).toBe(24);
    expect(report.observations.map(o=>o.basis)).toEqual(["manual","probe"]);
  } finally {f.close();}
});

test("the Claude limit reads stored window sums: no event or fact reads before or after a share-only change and reopen",()=>{
  const f=createClaudeCodeAcceptanceFixture();
  const readerSources=Object.values(ACCOUNTS).map(account=>({
    ...probeReaderFixtureSource("claude",account), machine:"synthetic", login:LOGIN,
    home:`${ARCHIVE_LOGICAL_ROOT}/claude/${account}`, source_home:`C:/Users/${LOGIN}/.claude/${account}`,
  }));
  const gauge={subscription:ACCOUNTS.a,plan:"Max",window_hours:168,observations:[]};
  const publishSums=()=>prepareWindowUsageFixture(f.db,{rateCards:f.rates,claudeGauge:gauge,manualCapacity:()=>[],cycles:{windows:[]}});
  prepareProbeReaderFixture(f.db,readerSources);publishSums();
  // Readings and refusal ownership are probe evidence the rail loads once per request; only the sums are measured here.
  let resolver=loadAccountResolver(f.db), probeEvidence=loadProbeLimitEvidence(f.db,"claude",ACCOUNTS.a,resolver);
  const build=()=>buildClaudeLimit(f.db,gauge,price,TIMES.asOf,{rateCards:f.rates,resolver,probeEvidence});
  try {
    const first=measureAnalysis(f.db,build);
    expect(first.rawOrFactQueries).toEqual([]);
    expect(first.value.observations.length).toBeGreaterThan(0);
    expect(first.value.current).not.toBeNull();
    const actual=first.value.current!.spend;
    const before=first.value.calibration!.window_value_usd;
    f.changeShare(15);prepareProbeReaderFixture(f.db,readerSources);f.reopen();
    prepareProbeReaderFixture(f.db,readerSources);publishSums();resolver=loadAccountResolver(f.db);probeEvidence=loadProbeLimitEvidence(f.db,"claude",ACCOUNTS.a,resolver);
    const second=measureAnalysis(f.db,build);
    expect(second.rawOrFactQueries).toEqual([]);
    expect(second.value.current!.spend).toEqual(actual);
    expect(second.value.calibration!.window_value_usd).not.toBe(before);
  } finally {f.teardown();}
});

test("project capacities separate verified accounts, preserve missing prices and select the requested dates",()=>{
  const f=fixture();
  const period={since:"2026-09-10",until:"2026-09-13"};
  try {
    observe(f.db);observe(f.db,24,12,"other");
    const cards={...rates,subscriptions:{seat:{usd_per_month:120},claude:{usd_per_month:200}}};
    const caps=buildSubscriptionCapacities(f.db,cards,new Map(),{
      fromStored:false,
      claudeAccounts:["seat","other","other"],period,claudeGauge:cfg,grokGauge:{},rootDir:f.root,
    });
    const first=caps.get("seat")!,second=caps.get("other")!;
    expect(first.weekly_window_value_usd).toBeCloseTo(0.12/(0.12*0.24),12);
    expect(second.weekly_window_value_usd).toBeCloseTo(0.24/(0.12*0.24),12);
    expect(first.usd_per_month).toBe(120);
    expect(second.usd_per_month).toBeNull();
    expect(first.value_basis).toBe("standard_normalized");
    expect(second.value_basis).toBe("standard_normalized");
    expect(computeEquivalentsAndProvenance(0.72,second,period,0.24).equivalents.weekly_cycles.value).toBe(0.0288);
    expect(computeEquivalentsAndProvenance(0.72,second,period).equivalents.weekly_cycles.absent).toBe("invalid_usage");
    const early=buildSubscriptionCapacities(f.db,cards,new Map(),{
      fromStored:false,
      claudeAccounts:["seat"],period:{since:"2026-09-10",until:"2026-09-12"},claudeGauge:cfg,grokGauge:{},rootDir:f.root,
    });
    expect(early.get("seat")!.weekly_window_value_usd).toBeNull();
    const none=buildSubscriptionCapacities(f.db,cards,new Map(),{fromStored:false,claudeAccounts:[],claudeGauge:cfg,grokGauge:{},rootDir:f.root});
    expect([...none.values()].filter(row=>row.vendor==="claude"&&row.capacity_basis!=="none")).toEqual([]);
  } finally {f.close();}
});

test("a project's second Claude account cannot inherit the first account's manual calibration",()=>{
  const f=fixture();
  try {
    const manual={...cfg,observations:[{ts:NOW,reset_ts:RESET,window_start_ts:START,percent:{all:24},source:"manual user observation"}]};
    publish(f.db,manual);
    const caps=buildSubscriptionCapacities(f.db,rates,new Map(),{
      fromStored:false,
      claudeAccounts:["seat","other"],period:{since:"2026-09-10",until:"2026-09-13"},claudeGauge:manual,grokGauge:{},rootDir:f.root,
    });
    expect(caps.get("seat")!.weekly_window_value_usd).toBe(0.5);
    expect(caps.get("other")!.weekly_window_value_usd).toBeNull();
    expect(caps.get("other")!.capacity_basis).toBe("none");
  } finally {f.close();}
});

test("project period includes the final day's sub-millisecond observation and excludes next midnight",()=>{
  const f=fixture();
  try {
    for (const [asOf,used,share] of [["2026-09-13T23:59:59.999500Z",24,12],["2026-09-14T00:00:00.000Z",100,12]] as const) {
      const extra=JSON.stringify(encodeClaudeCodeProductShare({schema:1,key:"claude_code",percent:share,
        as_of:asOf,window_started_at:START,display_name:"Claude Code"}));
      f.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra,reported_percent_side,machine) VALUES('claude','seat',?,'weekly_all',NULL,?,?,?,'used',?)")
        .run(asOf,used,RESET,extra,probeReaderFixtureSource("claude","seat").machine);
    }
    prepareProbeReaderFixture(f.db,[probeReaderFixtureSource("claude","seat"),probeReaderFixtureSource("claude","other")]);
    publish(f.db);
    const caps=buildSubscriptionCapacities(f.db,rates,new Map(),{
      fromStored:false,
      claudeAccounts:["seat"],period:{since:"2026-09-10",until:"2026-09-13"},claudeGauge:{},grokGauge:{},rootDir:f.root,
    });
    expect(caps.get("seat")!.calibration_end_ts).toBe("2026-09-13T23:59:59.9995Z");
    expect(caps.get("seat")!.weekly_window_value_usd).toBeCloseTo(0.12/(0.12*0.24),12);
  } finally {f.close();}
});

test("explicit bounds report exactly that closed window or segment, and broken ones are refused",async()=>{
  const f=fixture();try {
    observe(f.db);
    const ctx={sqlite:f.db,rateCards:rates,claudeGauge:cfg,vendorDiscovery:{accounts:[]}} as unknown as AppContext;
    const query=(from:string,until:string)=>new URL(`http://local/api/claude-limit?from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`);
    const start=new Date(Date.parse(RESET)-168*3600_000).toISOString();
    const whole=await handleClaudeLimit(ctx,query(start,RESET)).json();
    expect(whole.current.window_start).toBe(start);
    expect(whole.current.reset_at).toBe(RESET);
    expect(whole.current.spend.gross).toBe(120000);
    expect(whole.current.counter_reset).toBeNull();
    const earlier=await handleClaudeLimit(ctx,query(new Date(Date.parse(start)-168*3600_000).toISOString(),start)).json();
    // Cadence alone does not establish a meter segment for that earlier week.
    expect(earlier.current).toBeNull();
    expect(handleClaudeLimit(ctx,query("not-a-date",RESET)).status).toBe(400);
    expect(handleClaudeLimit(ctx,query(RESET,start)).status).toBe(400);
    expect(handleClaudeLimit(ctx,new URL(`http://local/api/claude-limit?from=${encodeURIComponent(start)}`)).status).toBe(400);
  } finally {f.close();}
});

test("Claude limit plan and bounds follow the register and dated periods instead of gauge.plan",async()=>{
  const f=fixture();try {
    observe(f.db);
    replaceDeclaredPeriods(f.db,PLAN_PERIODS,[{provider:"claude",subject:"seat",from:START,until:null,
      value:"max-20x",origin:"declared",firstSeen:null,lastSeen:null,readings:0,evidence:"fixture"}]);
    // The maintenance worker re-resolves window plans after the period store queued them.
    prepareLimitWindowsFixture(f.db);
    const ctx={sqlite:f.db,rateCards:rates,claudeGauge:{...cfg,plan:"wrong-plan"},vendorDiscovery:{accounts:[]}} as unknown as AppContext;
    const query=new URL(`http://local/api/claude-limit?from=${encodeURIComponent(START)}&until=${encodeURIComponent(RESET)}`);
    const result=await handleClaudeLimit(ctx,query).json();
    const windowId=result.current?.window_id;
    expect(result.plan).toBe("max-20x");
    expect(result.current).toMatchObject({window_start:START,reset_at:RESET,window_id:expect.any(String)});
    expect(result.claude_code_capacity?.window_id).toBe(windowId);
  } finally {f.close();}
});

test("the reported window carries the account's own split across surfaces",()=>{
  const f=fixture();try {
    const extra={
      ...encodeClaudeCodeProductShare({schema:1,key:"claude_code",percent:12,as_of:NOW,window_started_at:START,display_name:"Claude Code"}),
      ...encodeClaudeProductBreakdown({schema:1,as_of:NOW,window_started_at:START,rows:[
        {key:"claude_code",percent:12,display_name:"Claude Code"},
        {key:"cowork",percent:30,display_name:"Cowork"},
        {key:"other",percent:58,display_name:"Other"},
      ]}),
    };
    f.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra,reported_percent_side,machine) VALUES('claude','seat',?,'weekly_all',NULL,24,?,?,'used',?)")
      .run(NOW,RESET,JSON.stringify(extra),probeReaderFixtureSource("claude","seat").machine);
    prepareProbeReaderFixture(f.db,[probeReaderFixtureSource("claude","seat"),probeReaderFixtureSource("claude","other")]);
    publish(f.db);
    const limit=buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates});
    expect(limit.current?.surface_breakdown?.rows.map(r=>[r.key,r.percent])).toEqual([
      ["other",58],["cowork",30],["claude_code",12],
    ]);
    // 88 pp of this window's used bar were spent where the local index cannot see them.
    const outsideCode=limit.current!.surface_breakdown!.rows
      .filter(r=>r.key!=="claude_code").reduce((sum,r)=>sum+r.percent,0);
    expect(outsideCode).toBe(88);
  } finally {f.close();}
});

test("a window with no reading of its own reports no surface split",()=>{
  const f=fixture();try {
    observe(f.db);
    expect(buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates}).current?.surface_breakdown).toBeNull();
  } finally {f.close();}
});

test("a model without a catalog rate is counted as unpriced instead of silently priced at zero",()=>{
  const f=fixture();try {
    const sourceHome=f.sources.find(source=>source.id==="seat")!.home;
    const insert=f.db.query(`INSERT INTO claude_events(store,call_id,ts,path,model,entrypoint,cc_version,subscription_id,in_uncached,out_total,speed)
      VALUES('live',?,'2026-09-11T01:00:00.000Z',?,?,'cli','1','seat',?,?,'standard')`);
    insert.run("unrated",`${sourceHome}/unrated.jsonl`,"new-model",500,50);
    // Zero-token synthetic turns carry no cost, so they are not a pricing gap.
    insert.run("synthetic",`${sourceHome}/synthetic.jsonl`,"<synthetic>",0,0);
    prepareClaudeReaderFixture(f.db,rates);
    observe(f.db);
    const limit=buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates});
    expect(limit.current?.spend.unpriced_calls).toBe(1);
    expect(limit.current?.spend.calls).toBe(3);
    // The priced sonnet traffic keeps its dollars; the gap is reported, not guessed.
    expect(limit.current?.spend.usd).toBeCloseTo(0.12,6);
  } finally {f.close();}
});

test("the account split keeps Code measured and scales every other surface from the same reading",()=>{
  const f=fixture();try {
    const extra={
      ...encodeClaudeCodeProductShare({schema:1,key:"claude_code",percent:12,as_of:NOW,window_started_at:START,display_name:"Claude Code"}),
      ...encodeClaudeProductBreakdown({schema:1,as_of:NOW,window_started_at:START,rows:[
        {key:"claude_code",percent:12,display_name:"Claude Code"},
        {key:"cowork",percent:30,display_name:"Cowork"},
        {key:"other",percent:58,display_name:"Other"},
      ]}),
    };
    f.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra,reported_percent_side,machine) VALUES('claude','seat',?,'weekly_all',NULL,24,?,?,'used',?)")
      .run(NOW,RESET,JSON.stringify(extra),probeReaderFixtureSource("claude","seat").machine);
    prepareProbeReaderFixture(f.db,[probeReaderFixtureSource("claude","seat"),probeReaderFixtureSource("claude","other")]);
    publish(f.db);
    const limit=buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates});
    const split=claudeAccountSplit(limit.claude_code_capacity)!;
    // 120,000 Code tokens at $1/M are 12% of the account: $1.00 and 1,000,000 tokens in total.
    expect(split.account_api_usd).toBeCloseTo(1,10);
    expect(split.account_tokens).toBeCloseTo(1_000_000,6);
    const byKey=Object.fromEntries(split.rows.map(r=>[r.key,r]));
    expect(byKey.claude_code).toMatchObject({measured:true,tokens:120_000});
    expect(byKey.claude_code!.api_usd).toBeCloseTo(0.12,10);
    expect(byKey.cowork!.measured).toBe(false);
    expect(byKey.cowork!.api_usd).toBeCloseTo(0.30,10);
    expect(byKey.other!.tokens).toBeCloseTo(580_000,6);
  } finally {f.close();}
});

test("a share without surface rows still splits Code from the rest; an interval never splits",()=>{
  const f=fixture();try {
    observe(f.db);
    const limit=buildClaudeLimit(f.db,cfg,price,NOW,{rateCards:rates});
    expect(limit.claude_code_capacity?.product_rows).toEqual(shareOnlyProductRows(12));
    const split=claudeAccountSplit(limit.claude_code_capacity)!;
    expect(split.rows.find(r=>r.key===OUTSIDE_CODE_PRODUCT_KEY)!.api_usd).toBeCloseTo(0.88,10);
    expect(claudeAccountSplit({...limit.claude_code_capacity!,product_rows:null})).toBeNull();
    expect(claudeAccountSplit({...limit.claude_code_capacity!,basis:"interval",product_rows:[{key:"other",percent:88,display_name:null}]})).toBeNull();
  } finally {f.close();}
});

test("account splits list only windows that started in the period, never a cut window",async()=>{
  const f=fixture();try {
    const extra={
      ...encodeClaudeCodeProductShare({schema:1,key:"claude_code",percent:12,as_of:NOW,window_started_at:START,display_name:"Claude Code"}),
      ...encodeClaudeProductBreakdown({schema:1,as_of:NOW,window_started_at:START,rows:[
        {key:"claude_code",percent:12,display_name:"Claude Code"},{key:"other",percent:88,display_name:"Other"}]}),
    };
    f.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,scope,used_percent,resets_at,extra,reported_percent_side,machine) VALUES('claude','seat',?,'weekly_all',NULL,24,?,?,'used',?)")
      .run(NOW,RESET,JSON.stringify(extra),probeReaderFixtureSource("claude","seat").machine);
    prepareProbeReaderFixture(f.db,[probeReaderFixtureSource("claude","seat"),probeReaderFixtureSource("claude","other")]);
    publish(f.db);
    const ctx={sqlite:f.db,rateCards:rates} as unknown as AppContext;
    const read=async(since:string,until:string)=>await handleClaudeAccountSplits(ctx,new URL(`http://x/api/claude-account-splits?since=${since}&until=${until}`)).json() as ClaudeAccountSplitsResponse;
    const inside=await read("2026-09-10","2026-09-13");
    expect(inside.windows.map(w=>[w.account,w.window_started_at])).toEqual([["seat",START]]);
    expect(inside.windows[0]!.split.account_api_usd).toBeCloseTo(1,10);
    // A captured target is evidence, not the current account of the physical source.
    f.db.exec("UPDATE probe_windows SET subject='old-target'");
    prepareProbeReaderFixture(f.db,f.sources,()=>"seat");
    publish(f.db);
    expect((await read("2026-09-10","2026-09-13")).windows).toEqual(inside.windows);
    // The window began on 10.09, so a period from 11.09 cannot claim a slice of it.
    expect((await read("2026-09-11","2026-09-13")).windows).toEqual([]);
    expect(handleClaudeAccountSplits(ctx,new URL("http://x/api/claude-account-splits?since=2026-09-13&until=2026-09-10")).status).toBe(400);
  } finally {f.close();}
});

test("summing splits adds amounts and re-derives each surface's share",()=>{
  const week=(code:number,other:number)=>({as_of:NOW,share_percent:code/(code+other)*100,account_api_usd:code+other,account_tokens:null,
    rows:[{key:"claude_code",percent:code/(code+other)*100,display_name:"Claude Code",measured:true,api_usd:code,tokens:null},
      {key:"other",percent:other/(code+other)*100,display_name:"Other",measured:false,api_usd:other,tokens:null}]});
  const sum=sumClaudeAccountSplits([week(60,40),week(90,10)])!;
  expect(sum.account_api_usd).toBe(200);
  expect(sum.rows.find(r=>r.key==="claude_code")).toMatchObject({api_usd:150,percent:75,measured:true});
  expect(sum.rows.find(r=>r.key==="other")).toMatchObject({api_usd:50,percent:25});
  expect(sum.account_tokens).toBeNull();
  expect(sumClaudeAccountSplits([])).toBeNull();
});
