import {expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {buildDataView,presentDataView,dataConfigurationStamp,DATA_VIEWS,readsWindowSums,type DataEnvelope} from "./data-views";
import {clockBoundaryMs,preparedAtMs,presentClockFields,PREPARED_AT_HEADER} from "./data-clock";
import {buildEraIndex} from "./eras";
import type {AppContext} from "./api";
import {installAnalysisTracking} from "../db/analysis";
import {dataVersion} from "./data-version";
import {ensureUsageLedgerSchema} from "../db/usage-ledger";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";

const MINUTE=60000,HOUR=3600000;
const T0=Date.parse("2026-09-18T10:00:00.000Z");
const round2=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-view-clock-")),dbPath=path.join(dir,"data.sqlite");
  const sqlite=new Database(dbPath);
  sqlite.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE events(id INTEGER PRIMARY KEY,ts TEXT,home TEXT,path TEXT,model TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER);
    INSERT INTO events VALUES(1,'2026-09-17T12:00:00Z','pc1','a','m',10,0,0,0,0);
    CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,ts TEXT,home TEXT,path TEXT);
    CREATE TABLE sync_revisions(id INTEGER PRIMARY KEY,data_revision INTEGER,config_revision INTEGER);
    INSERT INTO sync_revisions VALUES(1,1,1);
    CREATE TABLE vendor_sync_revisions(vendor TEXT PRIMARY KEY,data_revision INTEGER);`);
  createAnalysisSourceRevisions(sqlite);
  sqlite.exec(fs.readFileSync(new URL("../../drizzle/0040_account_periods.sql",import.meta.url),"utf8")
    .replaceAll("--> statement-breakpoint", ""));
  installAnalysisTracking(sqlite);
  const ctx={sqlite,dbPath,accounts: { version: 2, subscriptions: [], sources: [] },homeToSubId:new Map(),subIdToHomes:new Map(),eras:buildEraIndex([]),eraErrors:[],homeConflict:null,
    rateCards:{version:2,currency:"USD",unit:"per 1M",vendors:{}},claudeGauge:{},grokGauge:{},cycles:{},plans:{},plansCatalog:{provider_groups:[]},
    rootDir:process.cwd(),attribution:null} as AppContext;
  return {ctx,dir,close(){sqlite.close();Bun.gc(true);fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}};
}

/** Build one view through the same path the worker uses, with a stubbed builder. */
async function prepare(ctx:AppContext,pathname:string,body:unknown,nowMs:number):Promise<DataEnvelope> {
  const view=DATA_VIEWS[pathname]!;
  const original=view.build;
  (view as {build:typeof original}).build=()=>Response.json(body);
  try { return await buildDataView(ctx,new URL(`http://local${pathname}`),nowMs); }
  finally { (view as {build:typeof original}).build=original; }
}
/** A kept answer as it is presented at `nowMs`. */
function read(pathname:string,envelope:DataEnvelope,nowMs:number):DataEnvelope {
  return presentDataView(DATA_VIEWS[pathname]!,envelope,nowMs);
}

test("restart notification counters keep kept answers, while real discovery changes replace them",()=>{
  const {ctx,close}=fixture();
  try {
    ctx.identityRevision=7;
    const before=dataConfigurationStamp(ctx,false);
    ctx.identityRevision=0;
    expect(dataConfigurationStamp(ctx,false)).toBe(before);
    ctx.codexDiscovery={accounts:[],profiles:[]} as unknown as NonNullable<AppContext["codexDiscovery"]>;
    expect(dataConfigurationStamp(ctx,false)).not.toBe(before);
  } finally {close();}
});

test("a client rewriting its profile files keeps kept answers, a new sign-in replaces them",()=>{
  const {ctx,close}=fixture();
  const profile=(revision:string,key="claude:1")=>({vendor:"claude",home:"C:/Users/a/.claude",login:"a",machine:"PC",key,email:"a@x",
    plan:"max-20x",error:null,surface:"claude-code",revision}) as NonNullable<AppContext["vendorDiscovery"]>["profiles"][number];
  const discovery=(revision:string,key?:string):NonNullable<AppContext["vendorDiscovery"]>=>{const p=profile(revision,key);
    return {profiles:[p],accounts:[{id:"claude-1",vendor:"claude",key:p.key!,email:"a@x",plan:"max-20x",current:true,profiles:[p]}]};};
  try {
    ctx.vendorDiscovery=discovery("100:5");
    const before=dataConfigurationStamp(ctx,false);
    ctx.vendorDiscovery=discovery("200:6");
    expect(dataConfigurationStamp(ctx,false)).toBe(before);
    ctx.vendorDiscovery=discovery("200:6","claude:2");
    expect(dataConfigurationStamp(ctx,false)).not.toBe(before);
  } finally {close();}
});

test("the version kept answers are keyed by follows a register publication without a raw source revision",()=>{
  const {ctx,close}=fixture();
  try {
    // Non-Codex views follow the usage ledger; after migration 0047 no usage_price_scopes table exists.
    ensureUsageLedgerSchema(ctx.sqlite);
    ctx.sqlite.exec(`INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest,revision)
      VALUES('gemini',1,'backfill','pending',0,'','rules',0);`);
    const version=dataVersion(ctx.sqlite);
    const raw=()=>(ctx.sqlite.query("SELECT revision FROM analysis_source_revisions WHERE source='gemini_events' AND bucket='*'").get() as {revision:number}|null)?.revision;
    const before=raw();
    ctx.sqlite.exec("UPDATE usage_ledger_state SET phase='reconcile',covered=10,status='ready',revision=revision+1 WHERE provider='gemini'");
    expect(raw()).toBe(before);
    expect(dataVersion(ctx.sqlite)).not.toBe(version);
  } finally {close();}
});

test("window-sum publications move the data version only of views that read window sums", () => {
  const sqlite=new Database(":memory:");
  try {
    createAnalysisSourceRevisions(sqlite);
    sqlite.exec("INSERT INTO analysis_source_revisions(source,bucket,revision) VALUES ('window-usage','*',1)");
    const reader=dataVersion(sqlite),other=dataVersion(sqlite,{windowSums:false});
    sqlite.exec("UPDATE analysis_source_revisions SET revision=revision+1 WHERE source='window-usage'");
    expect(dataVersion(sqlite)).not.toBe(reader);
    expect(dataVersion(sqlite,{windowSums:false})).toBe(other);
    // Declared readers follow window sums; every other exception view does not; an undeclared route is assumed to.
    expect(["/api/codex-accounting","/api/claude-limit","/api/plan-capacity","/api/project-cost","/api/cycle-breakdown"].map(readsWindowSums)).toEqual([true,true,true,true,true]);
    expect(["/api/accounts","/api/planhealth","/api/gauge","/api/health"].map(readsWindowSums)).toEqual([false,false,false,false]);
  } finally {sqlite.close();}
});

const gaugeBody=(nowMs:number)=>({
  window_start:new Date(nowMs-HOUR).toISOString(),
  reset_at:new Date(nowMs+HOUR).toISOString(),
  elapsed_hours:1,
  remaining_hours:1,
  elapsed_percent:50,
  pp_ahead:20,
  used_percent:70,
  usd:12.5,
  tokens:987654321,
  probe:{provider:"codex",subject:"codex1",state:"fresh",fresh_minutes:15,
    reading:{ts:new Date(nowMs-2*MINUTE).toISOString(),age_minutes:2,machine:"pc1"},machines:[]},
  live:{ts:new Date(nowMs-30*MINUTE).toISOString(),age_minutes:30,used_percent:70},
  gauge_age_hours:0.5,
});

test("historical window elapsed values remain measured, while current Claude forecasts advance",()=>{
  const historical={isCurrent:false,startIso:new Date(T0-2*HOUR).toISOString(),resetIso:new Date(T0-HOUR).toISOString(),
    elapsedPercent:40,ppAhead:10,usedPercent:50};
  const current={window_start:new Date(T0-HOUR).toISOString(),reset_at:new Date(T0+HOUR).toISOString(),
    percent_all_measured:50,percent_all_est:null,elapsed_percent:50,projected_end_percent:100,eta_100_iso:null as string|null};
  const result=presentClockFields({historical,current},T0+30*MINUTE,T0);
  expect(result.historical).toEqual(historical);
  expect(result.current.elapsed_percent).toBe(75);
  expect(result.current.projected_end_percent).toBe(66.7);
  expect(result.current.eta_100_iso).toBe(new Date(T0+2*HOUR).toISOString());
  expect(result.current.percent_all_measured).toBe(50);
});

test("a kept clock view ages honestly across minute boundaries",async()=>{
  const {ctx,close}=fixture();
  try {
    const built=await prepare(ctx,"/api/gauge",gaugeBody(T0),T0);
    expect(preparedAtMs(read("/api/gauge",built,T0).headers)).toBe(T0);

    for(const minutes of [1,2,7,59]) {
      const body=read("/api/gauge",built,T0+minutes*MINUTE).body as ReturnType<typeof gaugeBody>;
      // Ages advance from the original observations, never reset to zero.
      expect(body.live.age_minutes).toBe(30+minutes);
      expect(body.gauge_age_hours).toBe(round2(0.5+minutes/60));
      expect(body.remaining_hours).toBe(round2(1-minutes/60));
      expect(body.elapsed_hours).toBe(round2(1+minutes/60));
      expect(body.elapsed_percent).toBe(round2(50+minutes/1.2));
      // pp_ahead is used-minus-elapsed and stays consistent with the pace it reports.
      expect(body.pp_ahead).toBeCloseTo(body.used_percent-body.elapsed_percent,6);
      // Valued facts never move with the clock.
      expect(body.usd).toBe(12.5);
      expect(body.tokens).toBe(987654321);
    }
  } finally { close(); }
});

test("a probe is never presented as fresh once its own sample ages past the threshold",async()=>{
  const {ctx,close}=fixture();
  try {
    const built=await prepare(ctx,"/api/gauge",gaugeBody(T0),T0);
    const before=read("/api/gauge",built,T0+12*MINUTE).body as ReturnType<typeof gaugeBody>;
    expect(before.probe.state).toBe("fresh");
    expect(before.probe.reading.age_minutes).toBe(14);
    const after=read("/api/gauge",built,T0+20*MINUTE).body as ReturnType<typeof gaugeBody>;
    expect(after.probe.state).toBe("stale");
    expect(after.probe.reading.age_minutes).toBe(22);
    expect(after.probe.reading.ts).toBe(gaugeBody(T0).probe.reading.ts);
  } finally { close(); }
});

test("presentation leaves unknown and missing values alone",()=>{
  const body={age_minutes:null,remaining_hours:null,elapsed_percent:null,note:"brak odczytu",
    probe:{state:"none",fresh_minutes:15,reading:null},percent:null,samples:0};
  expect(presentClockFields(body,T0+2*HOUR,T0)).toEqual(body);
  const withoutSource={age_hours:1.5,tokens:5};
  expect(presentClockFields(withoutSource,T0+30*MINUTE,T0)).toEqual({age_hours:2,tokens:5});
});

test("presentDataView is a pure read: the stored envelope is never mutated",()=>{
  const envelope:DataEnvelope={status:200,body:{age_minutes:5,ts:new Date(T0-5*MINUTE).toISOString()},
    headers:[[PREPARED_AT_HEADER,new Date(T0).toISOString()]]};
  const presented=presentDataView(DATA_VIEWS["/api/gauge"]!,envelope,T0+10*MINUTE);
  expect((presented.body as {age_minutes:number}).age_minutes).toBe(15);
  expect((envelope.body as {age_minutes:number}).age_minutes).toBe(5);
});

test("boundaries come from published instants, never from the wall clock alone",()=>{
  const body={reset_at:"2026-09-18T11:00:00.000Z",eta_100_iso:"2026-09-18T10:30:00.000Z",
    past:{reset_at:"2026-09-18T09:00:00.000Z"},segments:[{from:"2026-09-20",period_hours:168}],
    nested:[{anchor:Date.parse("2026-09-18T10:40:00.000Z")/1000}]};
  expect(clockBoundaryMs(body,T0)).toBe(Date.parse("2026-09-18T10:40:00.000Z"));
  expect(clockBoundaryMs({...body,nested:[]},T0)).toBe(Date.parse("2026-09-18T11:00:00.000Z"));
  expect(clockBoundaryMs({segments:[{from:"2026-09-20"}]},T0)).toBe(Date.parse("2026-09-20T00:00:00.000Z"));
  // An estimate reaching 100% changes nothing that was measured.
  expect(clockBoundaryMs({eta_100_iso:"2026-09-18T10:30:00.000Z"},T0)).toBeNull();
  expect(clockBoundaryMs({totals:{usd:12}},T0)).toBeNull();
});
