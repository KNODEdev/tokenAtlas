/** Synthetic real-process checks for the application window-answer path; no installation settings. */
import "./test-environment";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../src/db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyDrizzleMigrations } from "../src/db/migrate";
import { declareCodexEraPeriods } from "../src/server/codex-periods.fixture";
import { createFetchHandler, handleCycleBreakdown, type AppContext } from "../src/server/api";
import { indexSubscriptionHomes } from "../src/server/capacity-equivalents";
import { buildEraIndex } from "../src/server/eras";
import { fixtureCodexRateCard, prepareCodexLedgerFixture, repriceCodexLedgerFixture } from "../src/server/codex-ledger.fixture";
import { prepareProbeReaderFixture } from "../src/server/probe-reader.fixture";
import { ARCHIVE_LOGICAL_ROOT, MACHINE, LOGIN } from "../src/config/paths";
import { persistProbeWindows } from "../src/providers/core/probe";
import type { WindowReading } from "../src/providers/types";
import { ensureWindowAnswersSchema, markWindowAnswersDirty, readWindowAnswer, storeWindowAnswers } from "../src/db/window-answers";
import { storedAnswerConfiguration } from "../src/server/data-read";
import { saveProjects } from "../src/projects/remap";
import { overrideProjectRules } from "../src/projects/resolve";
import { cacheKey } from "../src/server/cache";

export const FROM = "2026-03-29T00:30:00.000Z", UNTIL = "2026-03-29T01:30:00.000Z";
export const SELECTED = `/api/cycle-breakdown?account=a&since_ts=${FROM}&until_ts=${UNTIL}&limit_id=codex&session_window=37&valuation=dated`;
const selectedUrl = () => new URL(SELECTED, "http://localhost");
const source = () => ({ id: "a", vendor: "codex", machine: MACHINE, login: LOGIN,
  home: `${ARCHIVE_LOGICAL_ROOT}/codex/A`, source_home: "A" });
export function reading(): WindowReading {
  return { kind: "primary", group: "codex", scope: "subscription", plan: "pro", reportedPercentSide: "used",
    usedPercent: 30, remainingPercent: null, vendorPercent: 30, windowMinutes: 37, allowance: null, used: null,
    remaining: null, resetsAt: UNTIL, rateLimitReached: false, resetCredits: 0, profile: LOGIN, ok: true,
    error: null, extra: { home: "A" } };
}
const metadataFile = (file: string) => `${file}.fixture.json`;
export function createPublicationFixture(file: string): AppContext {
  assert.equal(path.dirname(path.resolve(file)),path.resolve(process.env.TOKENATLAS_TEST_ROOT!));
  assert.equal(path.basename(file),"fixture.sqlite"); assert.equal(fs.existsSync(file),false,"Fixture initialization never replaces an existing database");
  const initial = new Database(file); applyDrizzleMigrations(drizzle(initial)); initial.close();
  const sqlite=new Database(file);
  sqlite.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,project_id TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER);
    CREATE INDEX events_ts ON events(home,ts); CREATE INDEX events_path ON events(home,path);
    CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,window_minutes INTEGER,limit_id TEXT,used_percent REAL,resets_at INTEGER);
    CREATE INDEX ratelimit_ts ON ratelimit(home,ts);`);
  declareCodexEraPeriods(sqlite,[source()]);
  const ctx={sqlite,accounts:{version:2,subscriptions:[{id:"a",vendor:"codex"}],sources:[source()]},
    rateCards:{version:1,currency:"USD",unit:"per 1M",vendors:{openai:{models:{gpt:{in_uncached:2,in_cache_read:0.5,in_cache_write:0,out_total:8}}}}}} as unknown as AppContext;
  ctx.sqlite.exec("PRAGMA journal_mode=WAL; CREATE INDEX ratelimit_range_sources ON ratelimit(ts,home); DELETE FROM events; DELETE FROM ratelimit");
  const put = ctx.sqlite.query("INSERT INTO events(home,path,ts,model,project_id,in_tok,cached_in,cache_write,out_tok) VALUES ('A','p',?,'gpt','alpha',1000,100,0,200)");
  for (const at of [Date.parse(FROM)-1,Date.parse(FROM),Date.parse(FROM)+1_200_000,Date.parse(UNTIL),Date.parse(UNTIL)+1])
    put.run(new Date(at).toISOString());
  ctx.sqlite.query("INSERT INTO ratelimit VALUES ('A','p',?,10080,'codex',20,?)").run(FROM,Date.parse(UNTIL)/1000);
  ctx.sqlite.query("INSERT INTO ratelimit VALUES ('A','p',?,10080,'codex',30,?)").run(UNTIL,Date.parse(UNTIL)/1000);
  ctx.accounts.sources = [source()];
  ctx.homeToSubId = indexSubscriptionHomes([{ id: "a", home: "A" }], [source()]);
  ctx.subIdToHomes = new Map([["a", ["A"]]]);
  ctx.rateCards = fixtureCodexRateCard(ctx.rateCards);
  Object.assign(ctx, { dbPath:file, eras:buildEraIndex([]), eraErrors:[], homeConflict:null,
    claudeGauge:{},grokGauge:{},cycles:{},plans:{},plansCatalog:{provider_groups:[]},rootDir:path.resolve(import.meta.dir,"..") });
  persistProbeWindows(ctx.sqlite,"codex","a",new Date(Date.parse(FROM)+1_800_000).toISOString(),[reading()]);
  prepareProbeReaderFixture(ctx.sqlite,[source()]);
  prepareCodexLedgerFixture(ctx.sqlite,ctx.rateCards,ctx.homeToSubId,ctx.accounts.sources);
  ensureWindowAnswersSchema(ctx.sqlite);
  const {sqlite: _connection,homeToSubId,subIdToHomes,...rest}=ctx;
  fs.writeFileSync(metadataFile(file),JSON.stringify({...rest,homeToSubId:[...homeToSubId],subIdToHomes:[...subIdToHomes]}));
  return ctx;
}
export function openPublicationFixture(file: string): AppContext {
  const { homeToSubId, subIdToHomes, ...rest } = JSON.parse(fs.readFileSync(metadataFile(file),"utf8"));
  const sqlite=new Database(file); sqlite.exec("PRAGMA journal_mode=WAL");
  return {...rest,sqlite,dbPath:file,homeToSubId:indexSubscriptionHomes([{id:"a",home:"A"}],[source()]),subIdToHomes:new Map(subIdToHomes),eras:buildEraIndex([])} as AppContext;
}
/** Only the explicitly clock-presented age is omitted from full-body equality. */
export function stableBody(body: any): unknown {
  const copy=structuredClone(body);
  for(const row of [copy.short_counter?.live,...copy.short_counter?.other??[]])if(row)delete row.age_minutes;
  return copy;
}
export async function nativeRead(ctx: AppContext, expected: "prepare"|"stored"|"stale", selected = SELECTED, calls = 2) {
  const url = new URL(selected, "http://localhost");
  let workers=0;
  const NativeWorker=globalThis.Worker;
  globalThis.Worker=class extends NativeWorker {
    constructor(url: string|URL, options?: WorkerOptions) { super(url,options); if(String(url).includes("data-worker")) { workers++; this.addEventListener("message",event=>{if(event.data?.error)console.error("native worker diagnostic",event.data);}); } }
  } as typeof Worker;
  const handler=createFetchHandler(ctx), server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:handler});
  const before=(ctx.sqlite.query("SELECT total_changes() n").get() as {n:number}).n;
  const start=performance.now();
  try {
    const response=await fetch(`http://127.0.0.1:${server.port}${selected}`), first=await response.json();
    const httpMs=performance.now()-start;
    assert.equal(response.status,expected==="prepare"?202:200);
    assert.equal(response.headers.get("X-Analysis"),expected==="prepare"?"preparing":expected);
    await ctx.analysisReader!.whenIdle();
    const changes=(ctx.sqlite.query("SELECT total_changes() n").get() as {n:number}).n-before;
    assert.equal(changes,0,"HTTP reader and native worker must write nothing");
    const pending=ctx.analysisReader!.takeAnswersToStore(); if(expected!=="stored" && !pending.length) { const failed=await fetch(`http://127.0.0.1:${server.port}${selected}`); console.error("producer diagnostic",failed.status,await failed.text(),ctx.analysisReader!.activity()); }
    if(expected==="stored") { assert.equal(workers,0); assert.equal(pending.length,0); }
    else {
      assert.equal(workers,1); assert.equal(pending.length,1);
      const old=readWindowAnswer(ctx.sqlite,url.pathname,cacheKey(url));
      const beforeCommit=await fetch(`http://127.0.0.1:${server.port}${selected}`);
      assert.equal(beforeCommit.headers.get("X-Analysis"),expected==="prepare"?"preparing":"stale");
      if(old)assert.deepEqual(stableBody(await beforeCommit.json()),stableBody(JSON.parse(old.body)));
      // A real publisher error must retain the same public state and the last committed generation.
      ctx.sqlite.exec("CREATE TEMP TRIGGER reject_answer BEFORE INSERT ON window_answers BEGIN SELECT RAISE(ABORT,'injected publication failure'); END");
      try {assert.throws(()=>storeWindowAnswers(ctx.sqlite,pending),/injected publication failure/);}
      finally {ctx.sqlite.exec("DROP TRIGGER reject_answer");}
      ctx.analysisReader!.returnAnswersToStore(pending);
      const failed=await fetch(`http://127.0.0.1:${server.port}${selected}`);
      assert.equal(failed.headers.get("X-Analysis"),expected==="prepare"?"preparing":"stale");
      assert.deepEqual(readWindowAnswer(ctx.sqlite,url.pathname,cacheKey(url)),old);
      const retry=ctx.analysisReader!.takeAnswersToStore();
      assert.deepEqual(retry,pending);storeWindowAnswers(ctx.sqlite,retry);
    }
    const stored=await fetch(`http://127.0.0.1:${server.port}${selected}`);
    const body=await stored.json();assert.equal(stored.status,200);assert.equal(stored.headers.get("X-Analysis"),"stored");
    assert.deepEqual(stableBody(body),stableBody(await handleCycleBreakdown(ctx,url).json()));
    assert.equal(body.totals.calls,calls);assert.equal(body.totals.tokens,calls*1200);
    return {first,body,workers,httpMs,readerChanges:changes,published:pending.length};
  } finally {
    server.stop(true);await ctx.analysisReader?.close();await ctx.directReader?.close();globalThis.Worker=NativeWorker;ctx.analysisReader=undefined;ctx.directReader=undefined;
  }
}


/** Conservative fallback is bounded to requested answers, never an eager all-window rebuild. */
export async function verifyConfigurationFallbacks(ctx: AppContext) {
  const base=await nativeRead(ctx,"stored");
  const accounting=structuredClone(ctx.rateCards!.codex_accounting!);
  const rule=accounting.rules.find(rule=>rule.id==="fixture-api-gpt")!;
  assert.ok(rule);
  accounting.rules.push({...structuredClone(rule),id:"unused-model-rule",model:"absent-model"});
  ctx.rateCards={...ctx.rateCards!,codex_accounting:accounting};
  repriceCodexLedgerFixture(ctx.sqlite,ctx.rateCards);
  const unused=await nativeRead(ctx,"stale");
  assert.deepEqual(stableBody(unused.body),stableBody(base.body));
  assert.equal(unused.published,1);assert.equal((await nativeRead(ctx,"stored")).workers,0);
  rule.rates!.in_uncached!*=2;
  repriceCodexLedgerFixture(ctx.sqlite,ctx.rateCards);
  const priced=await nativeRead(ctx,"stale");
  assert.notDeepEqual(stableBody(priced.body),stableBody(base.body));
  assert.equal(priced.published,1);assert.equal((await nativeRead(ctx,"stored")).workers,0);
  overrideProjectRules(ctx.sqlite,null);
  const projects={projects:[{id:"alpha",name:"Alpha",matches:[{project:"fixture:alpha"}]}]};
  saveProjects(projects);
  const selected=SELECTED+"&project_id=alpha";
  const project=await nativeRead(ctx,"prepare",selected);
  projects.projects.push({id:"beta",name:"Beta",matches:[{project:"unrelated-project"}]});
  saveProjects(projects);
  const other=await nativeRead(ctx,"stale",selected);
  assert.deepEqual(stableBody(other.body),stableBody(project.body));
  assert.equal(other.published,1);assert.equal((await nativeRead(ctx,"stored",selected)).workers,0);
  // The unfiltered answer does not read project rules.
  assert.equal((await nativeRead(ctx,"stored")).workers,0);
  projects.projects[0]!.matches=[{project:"no-longer-alpha"}];saveProjects(projects);
  const moved=await nativeRead(ctx,"stale",selected,0);
  assert.equal(moved.published,1);assert.equal((await nativeRead(ctx,"stored",selected,0)).workers,0);
  assert.equal((await nativeRead(ctx,"stored")).body.totals.calls,2);
  return {unusedRule:unused.published,relevantRate:priced.published,otherProject:other.published,relevantProject:moved.published};
}

export async function verifyPublicationProcesses(cleanup = false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"tokenatlas-tests-publication-"));
  const env={...process.env,NODE_ENV:"test",TOKENATLAS_TEST_ROOT:root,TOKENATLAS_DB:path.join(root,"fixture.sqlite"),
    TOKENATLAS_CONFIG:path.join(root,"config"),TOKENATLAS_ARCHIVE:path.join(root,"archive"),TOKENATLAS_LOCAL_STATE:path.join(root,"state"),
    TOKENATLAS_SNAPSHOT_DIR:path.join(root,"snapshots"),TOKENATLAS_SYNC_MINUTES:"0",TOKENATLAS_PROBE_MINUTES:"0"};
  for(const name of ["config","archive","state","snapshots"])fs.mkdirSync(path.join(root,name));
  const results: Array<{mode:string;workers:number;published:number;readerChanges:number;httpMs:number;totalMs:number;calls:number;latest:boolean}>=[];
  const run=(mode:string)=>{
    const output=path.join(root,mode+".json");
    const child=Bun.spawnSync([process.execPath,import.meta.filename,mode,env.TOKENATLAS_DB,output],
      {cwd:path.resolve(import.meta.dir,".."),env,stdout:"pipe",stderr:"pipe",timeout:60000});
    fs.writeFileSync(path.join(root,mode+".log"),child.stdout.toString()+child.stderr.toString());
    assert.equal(child.exitCode,0,child.stderr.toString());
    const result=JSON.parse(fs.readFileSync(output,"utf8"));
    results.push({mode,workers:result.workers,published:result.published,readerChanges:result.readerChanges,
      httpMs:result.httpMs,totalMs:result.totalMs,calls:result.body.totals.calls,latest:result.body.short_counter.live!==null});
  };
  try {
    run("init");run("restart");run("unrelated");
    const armed=path.join(root,"armed");
    const holder=Bun.spawn([process.execPath,import.meta.filename,"hold",env.TOKENATLAS_DB,armed],{env,stdout:"pipe",stderr:"pipe"});
    try {
      for(let n=0;!fs.existsSync(armed)&&n<500;n++)await Bun.sleep(10);
      assert.ok(fs.existsSync(armed),"Child did not reach the real replacement transaction");
    } finally {holder.kill(9);await holder.exited;}
    run("after-kill");run("advance-probe");run("restart-after-probe");
    const fallback=Bun.spawnSync([process.execPath,import.meta.filename,"fallbacks",env.TOKENATLAS_DB,path.join(root,"fallbacks.json")],{env,stdout:"pipe",stderr:"pipe",timeout:60000});
    assert.equal(fallback.exitCode,0,fallback.stderr.toString());
    const fallbacks=JSON.parse(fs.readFileSync(path.join(root,"fallbacks.json"),"utf8"));
    return {root,entry:"createFetchHandler HTTP -> data-worker; storeWindowAnswers publication",mode:"synthetic isolated, fresh process per row",
      sample:"five boundary calls and a real probe correction",excludes:"full import/startup; UI timing; production performance",results,fallbacks};
  } finally {
    if(cleanup){
      const real=fs.realpathSync(root),parent=fs.realpathSync(os.tmpdir());
      assert.equal(path.dirname(real).toLowerCase(),parent.toLowerCase());assert.ok(path.basename(real).startsWith("tokenatlas-tests-publication-"));
      fs.rmSync(real,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    }
  }
}

if(import.meta.main && process.argv.length === 2) { console.log(JSON.stringify(await verifyPublicationProcesses())); }
else if(import.meta.main) {
  const [mode,file,result]=process.argv.slice(2);
  assert.ok(file&&result,"mode, synthetic database and result file required");
  assert.ok(["init","restart","unrelated","hold","after-kill","advance-probe","restart-after-probe","fallbacks"].includes(mode!));
  const isolated=path.resolve(process.env.TOKENATLAS_TEST_ROOT!);
  assert.equal(path.dirname(path.resolve(file)),isolated); assert.equal(path.basename(file),"fixture.sqlite");
  assert.equal(path.dirname(path.resolve(result)),isolated);
  if(fs.existsSync(file))assert.equal(fs.lstatSync(file).isSymbolicLink(),false);
  if(mode==="hold") {
    const ctx=openPublicationFixture(file);
    const old=readWindowAnswer(ctx.sqlite,"/api/cycle-breakdown",cacheKey(selectedUrl()));assert.ok(old);
    ctx.sqlite.exec("BEGIN IMMEDIATE");
    markWindowAnswersDirty(ctx.sqlite,{provider:"codex",account:"a",fromMs:Date.parse(FROM),untilMs:Date.parse(UNTIL)});
    // Actual replacement writes are inside the transaction the parent kills before commit.
    storeWindowAnswers(ctx.sqlite,[{...old,checked:old.checked+1,builtAt:Date.now()+1,body:JSON.stringify({incomplete:true})}]);
    fs.writeFileSync(result,"armed");await new Promise(()=>{ setInterval(()=>{},1000); });
  } else {
    const ctx=mode==="init"?createPublicationFixture(file):openPublicationFixture(file);
    try {
      if(mode==="fallbacks") {fs.writeFileSync(result,JSON.stringify(await verifyConfigurationFallbacks(ctx)));process.exit(0);}
      if(mode==="advance-probe") {
        persistProbeWindows(ctx.sqlite,"codex","a","2026-04-02T12:00:00.000Z",[reading()]);
        prepareProbeReaderFixture(ctx.sqlite,[source()]);
      }
      if(mode==="unrelated") ctx.claudeGauge={unrelated:"changed"} as never;
      const start=performance.now();
      const proof=await nativeRead(ctx,mode==="init"?"prepare":mode==="advance-probe"?"stale":"stored");
      if(mode==="advance-probe")assert.equal(proof.body.short_counter.live,null);
      if(mode==="init")assert.ok(proof.body.short_counter.live,"fixture exercises latest-state dependency");
      fs.writeFileSync(result,JSON.stringify({mode,entry:"createFetchHandler HTTP -> createDataRead -> data-worker; storeWindowAnswers writer publication",sample:"5 synthetic calls; one exact window; real process",excludes:"full import/startup, UI timing, production speed",...proof,totalMs:performance.now()-start}));
    } finally {ctx.sqlite.close();}
  }
}
