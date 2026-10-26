import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { constants } from "bun:sqlite";
import { Database } from "../src/db/sqlite";
import { frozenLedgerCopy } from "./lib/price-ledger-copy";
import { createFetchHandler, rebuildSubscriptionMaps, type AppContext } from "../src/server/api";
import { loadAccountResolver } from "../src/server/account-resolver";
import { readCodexLedgerState } from "../src/db/codex-ledger-state";
import type { RateCard } from "../src/server/pricing";
import { sourceDependencyFiles } from "./lib/source-dependencies";

const [mode, input, contextInput, countText="5", background="System load/OS cache uncontrolled"] = process.argv.slice(2);
assert(process.env.TOKENATLAS_FROZEN_CONFIG === "1" && process.env.TOKENATLAS_CONFIG, "Set an isolated frozen config before process startup");
assert.equal(Bun.version,"1.4.2");
const runtimeFiles=sourceDependencyFiles(path.resolve(import.meta.dir,".."),
  ["src/server/api.ts","src/server/api-codex-ledger.ts","src/db/codex-ledger-adapters.ts","src/db/codex-price-ledger-read.ts"]);
const runtimeHashes=()=>Object.fromEntries(runtimeFiles.map(file=>[file,createHash("sha256").update(fs.readFileSync(path.resolve(import.meta.dir,"..",file))).digest("hex")]));
const hashes=runtimeHashes();
async function child() {
  const frozen=frozenLedgerCopy(input!),context=frozenLedgerCopy(contextInput!);
  const directory=path.dirname(frozen.copy),policy=JSON.parse(fs.readFileSync(path.join(directory,"policy.json"),"utf8"));
  const selected=JSON.parse(fs.readFileSync(path.join(directory,"selected-report.json"),"utf8"));
  const expected=selected.results.find((row:any)=>row.name==="whole_history").groups.total;
  const db=new Database(pathToFileURL(frozen.copy).href+"?mode=ro&immutable=1",constants.SQLITE_OPEN_READONLY|constants.SQLITE_OPEN_URI);
  const setup=performance.now();
  db.exec("PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=3000");
  db.query("ATTACH DATABASE ? AS report_context").run(pathToFileURL(context.copy).href+"?mode=ro&immutable=1");
  db.exec("CREATE TEMP VIEW account_periods AS SELECT * FROM report_context.account_periods; CREATE TEMP VIEW plan_periods AS SELECT * FROM report_context.plan_periods");
  const head=readCodexLedgerState(db); assert.equal(head?.status,"ready");assert.equal(head?.rules_digest,selected.rulesRevision);
  assert.equal(head?.rules_json,JSON.stringify(policy));assert.equal(fs.realpathSync(selected.candidate),frozen.copy);
  assert.equal(selected.candidateBytes,frozen.before.size);assert.equal(selected.mismatches,0);
  const rates:RateCard={version:2,currency:"USD",unit:"per million",vendors:{},codex_ledger_policy:policy};
  const accounts={version:2 as const,subscriptions:[],sources:[]};
  const ctx={sqlite:db,dbPath:":memory:",rateCards:rates,accounts,
    get resolver(){return loadAccountResolver(db,accounts.subscriptions);},homeToSubId:new Map(),subIdToHomes:new Map(),
    rootDir:path.resolve(import.meta.dir,".."),plans:{},plansCatalog:{provider_groups:[]},cycles:{},claudeGauge:{},grokGauge:{}} as unknown as AppContext;
  // Same configuration initialization as createAppContext/rebuildSubscriptionMaps; no price or report read.
  rebuildSubscriptionMaps(ctx);
  const fetch=createFetchHandler(ctx),setupMs=performance.now()-setup;
  const results:any[]=[];
  let sqlActive:Map<string,{calls:number;ms:number;cpuMs:number}>|null=null;
  const query=db.query.bind(db),wrapped=new WeakSet<object>();
  (db as any).query=(sql:string,...args:any[])=>{
    const statement=(query as any)(sql,...args);
    if(!wrapped.has(statement)){
      wrapped.add(statement);
      for(const method of ["get","all","run"]){const original=statement[method];statement[method]=function(...params:any[]){
        const start=performance.now(),cpu=process.cpuUsage();try{return original.apply(this,params);}finally{if(sqlActive){
          const row=sqlActive.get(sql)??{calls:0,ms:0,cpuMs:0},used=process.cpuUsage(cpu);
          row.calls++;row.ms+=performance.now()-start;row.cpuMs+=(used.user+used.system)/1000;sqlActive.set(sql,row);}}
      };}
    }
    return statement;
  };
  try {
    const stampBefore=ctx.responseCache!.stamp(db);
    for(let trial=0;trial<2;trial++){
      sqlActive=new Map();const started=performance.now();
      const response=await fetch(new Request("http://local/api/summary?vendor=codex"));const body=await response.json() as any;
      const elapsedMs=performance.now()-started,queries=[...sqlActive].map(([query,row])=>({query:query.replace(/\s+/g," "),...row}));sqlActive=null;
      assert.equal(response.status,200);assert.equal(body.totals.calls,Number(expected.calls));
      assert.equal(body.totals.usd,Math.round(Number(expected.variants.api_standard.pricedSubtotal.decimal)*100)/100);
      assert.equal(body.unpriced.tokens,Number(expected.variants.api_standard.unpricedTokens));
      results.push({trial,kind:trial===0?"cold":"second",elapsedMs,cache:response.headers.get("X-Cache"),sqlMs:queries.reduce((sum,row)=>sum+row.ms,0),sqlCpuMs:queries.reduce((sum,row)=>sum+row.cpuMs,0),
        sqlCalls:queries.reduce((sum,row)=>sum+row.calls,0),queries:queries.sort((a,b)=>b.ms-a.ms),totals:body.totals,unpriced:body.unpriced});
    }
    const stampAfter=ctx.responseCache!.stamp(db);
    console.log(JSON.stringify({bun:Bun.version,pid:process.pid,config:process.env.TOKENATLAS_CONFIG,setupMs,configurationBootstrap:"rebuildSubscriptionMaps, dated resolver getter before fetch installation",
      noPremeasurementPriceRead:true,stampStable:stampBefore===stampAfter,pragmas:{mmap:db.query("PRAGMA mmap_size").get(),cache:db.query("PRAGMA cache_size").get(),temp:db.query("PRAGMA temp_store").get()},
      independentCounterMatch:true,sourceHashesAtStart:hashes,sourceHashesAtEnd:runtimeHashes(),results}));
  }finally{ctx.analysisReader?.close();db.close(true);frozen.assertUnchanged();context.assertUnchanged();}
}
if(mode==="--child")await child();
else{
  assert.equal(mode,"--run");const count=Number(countText);assert(Number.isInteger(count)&&count>=3&&count<=10);
  const rows:any[]=[];
  for(let index=0;index<count;index++){
    const process=Bun.spawn([globalThis.process.execPath,import.meta.path,"--child",input!,contextInput!],{env:globalThis.process.env,stdout:"pipe",stderr:"pipe"});
    const [output,error]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text()]);
    assert.equal(await process.exited,0,error);rows.push(JSON.parse(output));
  }
  const cold=rows.map(row=>row.results[0].elapsedMs).sort((a,b)=>a-b),second=rows.map(row=>row.results[1].elapsedMs).sort((a,b)=>a-b);
  const report={runtime:Bun.version,background,count,medianColdMs:cold[Math.floor(count/2)],worstColdMs:cold.at(-1),medianSecondMs:second[Math.floor(count/2)],worstSecondMs:second.at(-1),
    coldOneSecondGoal:cold.every(ms=>ms<=1000),limits:["Closed readonly immutable candidate and context","OS cache uncontrolled; first response/report/stamp is cold in each fresh process","Empty account declarations with actual frozen dated periods and server configuration bootstrap","SQL instrumentation adds diagnostic overhead; no pricing/preflight/report warmup"],rows};
  const target=path.resolve(import.meta.dir,"../TMP",`price-ledger-fresh-cold-${Date.now()}.json`);fs.writeFileSync(target,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:target,...report,rows:undefined}));
}
