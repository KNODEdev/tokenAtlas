import {expect,test,spyOn} from "bun:test";
import {Database} from "../db/sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {applyDrizzleMigrations} from "../db/migrate";
import {installAnalysisTracking} from "../db/analysis";
import {fillUsageLedger} from "./usage-ledger.fixture";
import {ARCHIVE_LOGICAL_ROOT} from "../config/paths";
import {buildEraIndex} from "./eras";
import type {RateCard} from "./pricing";
import {currentSubscriptionHomes} from "./capacity-equivalents";
import {prepareCodexLedgerFixture} from "./codex-ledger.fixture";
import {accountPriceDelta,captureAccountPrices} from "./rebuild-account-prices";
import {createAnalysisRebuildReport,finalizeAnalysisRebuildReport} from "./analysis-rebuild-report";
import {analysisRebuildStatus,queueAnalysisRebuild,resumeAnalysisRebuild,updateAnalysisRebuild,completeAnalysisRebuild} from "./analysis-rebuild";

const subscriptions=[{id:"selected",vendor:"claude"},{id:"foreign",vendor:"claude"}];
const rateCards:RateCard={version:1,currency:"USD",unit:"per 1M",vendors:{anthropic:{models:{fixture:{in_uncached:1,in_cache_read:0.1,in_cache_write_5m:1.25,in_cache_write_1h:2,out_total:3}}}}};
const context={subscriptions,sources:[],eras:buildEraIndex(subscriptions),rateCards};
const accounts=[{vendor:"claude" as const,account:"selected"}],now=new Date("2026-09-18T12:00:00Z");
const job=()=>({generation:1,scope:"all" as const,range:null,accounts,state:"queued"});
const FOREIGN_DAYS="SELECT d.* FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE d.provider='claude' AND m.source='claude/foreign'";
function fixture(file=":memory:") {
  const db=new Database(file);applyDrizzleMigrations(drizzle(db));
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");installAnalysisTracking(db);
  db.exec(`INSERT INTO claude_events(store,call_id,path,ts,subscription_id,model,in_uncached,out_total) VALUES
    ('pc','one','one','2026-09-01T12:00:00Z','selected','fixture',1000000,0),
    ('foreign','other','other','2026-09-01T12:00:00Z','foreign','fixture',9000000,0)`);
  for(const account of ["selected","foreign"]) {
    db.query("UPDATE claude_events SET path=? WHERE subscription_id=?").run(join(ARCHIVE_LOGICAL_ROOT,"claude",account,"one.jsonl"),account);
    db.query("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('claude',?,'2020-01-01',?,'declared','test')").run(`claude/${account}`,account);
  }
  return db;
}
test("price boundaries survive restart and correction, preserve unrelated account and compare registered decimals",async()=>{
  const root=mkdtempSync(join(tmpdir(),"atlas-price-boundary-")),file=join(root,"fixture.sqlite");let db=fixture(file);
  try {
    fillUsageLedger(db,"claude",rateCards,ARCHIVE_LOGICAL_ROOT);
    const foreign=db.query(FOREIGN_DAYS).all();
    const queued=queueAnalysisRebuild(db,{scope:"all",accounts},now,true,subscriptions,context.eras,rateCards);
    const before=queued.report!.accountPrices!.before;
    expect(before.accounts[0]).toMatchObject({status:"available",totals:{standard:{value:"1"}}});
    updateAnalysisRebuild(db,queued.generation,{state:"error",error:"synthetic interruption"});
    db.close(true);db=new Database(file);
    db.exec("UPDATE claude_events SET in_uncached=1500000 WHERE subscription_id='selected'");
    fillUsageLedger(db,"claude",rateCards,ARCHIVE_LOGICAL_ROOT);
    resumeAnalysisRebuild(db);
    expect(analysisRebuildStatus(db)!.report!.accountPrices!.before).toEqual(before);
    updateAnalysisRebuild(db,queued.generation,{state:"running",phase:"reports",completed:3,total:3});
    expect(completeAnalysisRebuild(db,queued.generation,context)).toBe(true);
    const report=analysisRebuildStatus(db)!.report!;
    expect(report.accountPrices!.delta![0]).toMatchObject({standard:{status:"available",value:"0.5"}});
    // The rows record no mode, which is Standard: the actual price equals the Standard one.
    expect(report.accountPrices!.delta![0]!.actual).toMatchObject({status:"available",value:"0.5"});
    expect(db.query(FOREIGN_DAYS).all()).toEqual(foreign);
    db.close(true);db=new Database(file);
    expect(analysisRebuildStatus(db)!.report!.accountPrices).toEqual(report.accountPrices);
  } finally {db.close(true);Bun.gc(true);rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});
test("missing baselines, changed rules and missing prices cannot become confirmed differences; reads never prepare",async()=>{
  const db=fixture();
  try {
    const report=createAnalysisRebuildReport(db,job(),now,context);
    fillUsageLedger(db,"claude",rateCards,ARCHIVE_LOGICAL_ROOT);
    const priced=createAnalysisRebuildReport(db,job(),now,context);
    db.exec("PRAGMA query_only=ON");
    const sql:string[]=[],query=db.query.bind(db),spy=spyOn(db,"query").mockImplementation(((text:string)=>{sql.push(text);return query(text);}) as typeof db.query);
    try {
      const result=finalizeAnalysisRebuildReport(db,report,0,0,now,context);
      expect(result.accountPrices!.before).toEqual(report.accountPrices!.before);
      expect(result.accountPrices!.delta![0]!.standard.status).toBe("unavailable");
      const legacy={...priced};delete legacy.accountPrices;
      expect(finalizeAnalysisRebuildReport(db,legacy,0,0,now,context).accountPrices!.before.capturedAt).toBeNull();
    } finally {spy.mockRestore();db.exec("PRAGMA query_only=OFF");}
    expect(sql.some(text=>/usage_ledger_facts|FROM claude_events|\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))).toBe(false);
    const changed=structuredClone(rateCards);changed.vendors.anthropic!.models!.fixture!.in_uncached=2;
    fillUsageLedger(db,"claude",changed,ARCHIVE_LOGICAL_ROOT);
    expect(finalizeAnalysisRebuildReport(db,priced,0,0,now,{...context,rateCards:changed}).accountPrices!.delta![0]!.standard.reason).toBe("account-price-basis-changed");
    const missing=structuredClone(rateCards);delete missing.vendors.anthropic!.models!.fixture;
    fillUsageLedger(db,"claude",missing,ARCHIVE_LOGICAL_ROOT);
    const after=finalizeAnalysisRebuildReport(db,priced,0,0,now,{...context,rateCards:missing});
    expect(after.accountPrices!.after!.accounts[0]!.totals!.standard!.value).toBeNull();
    expect(after.accountPrices!.delta![0]!.standard.status).toBe("unavailable");
  }finally{db.close(true);}
});

test("Codex price snapshots use the declared source homes but unknown identity quality forbids an exact delta",()=>{
  const db=new Database(":memory:");applyDrizzleMigrations(drizzle(db));
  db.exec(`CREATE TABLE events(home TEXT NOT NULL,path TEXT NOT NULL,source_offset INTEGER NOT NULL,ts TEXT NOT NULL,model TEXT,speed TEXT,
      in_tok INTEGER NOT NULL,cached_in INTEGER NOT NULL,cache_write INTEGER NOT NULL,out_tok INTEGER NOT NULL,
      cache_write_status TEXT,usage_status TEXT,billing_mode TEXT,PRIMARY KEY(home,path,source_offset))`);
  installAnalysisTracking(db);
  const codexSubscriptions=[{id:"selected",vendor:"codex"}];
  const codexSources=[{vendor:"codex",home:join(ARCHIVE_LOGICAL_ROOT,"codex/pc"),source_home:"live"}];
  const eras=buildEraIndex(codexSubscriptions);
  db.exec("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('codex','codex/pc','2020-01-01','selected','declared','test')");
  const codexRates:RateCard={version:1,currency:"USD",unit:"per 1M",vendors:{},codex_accounting:{version:1,rules:[{
    id:"fixture",model:"fixture",speed:"standard",billing_basis:"api_equivalent_usd",valid_from:"2026-01-01",verified_at:"2026-01-01",
    sources:["https://example.test/rate"],confidence:"user",multiplier:1,
    rates:{in_uncached:1,in_cache_read:1,in_cache_write:1,out_total:1},
  }]}};
  const codexContext={subscriptions:codexSubscriptions,sources:codexSources,eras,rateCards:codexRates,sourceHomes:["live"]};
  const selected=[{vendor:"codex" as const,account:"selected"}];
  // Publishes the Codex price ledger for the declared source, as its producer would.
  const finish=()=>prepareCodexLedgerFixture(db,codexRates,currentSubscriptionHomes(codexSources.map(source=>({id:"selected",...source}))));
  try {
    db.exec(`INSERT INTO events(home,path,source_offset,ts,model,speed,in_tok,cached_in,cache_write,out_tok,cache_write_status,usage_status)
      VALUES('live','live/sessions/one.jsonl',1,'2026-09-01T12:00:00Z','fixture','standard',1000000,0,0,0,'known','complete')`);
    finish();
    const sql:string[]=[],query=db.query.bind(db);db.exec("PRAGMA query_only=ON");
    const querySpy=spyOn(db,"query").mockImplementation(((text:string)=>{sql.push(text);return query(text);}) as typeof db.query);
    let before!:ReturnType<typeof captureAccountPrices>;
    try{before=captureAccountPrices(db,selected,null,now.toISOString(),codexContext);}
    finally{querySpy.mockRestore();db.exec("PRAGMA query_only=OFF");}
    expect(sql.some(text=>/FROM\s+events\b|event:valuation|\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))).toBe(false);
    expect(before.accounts[0]).toMatchObject({status:"available",totals:{standard:{value:"1"},quality:{complete:false}}});
    expect(captureAccountPrices(db,selected,null,now.toISOString(),{...codexContext,sourceHomes:undefined}).accounts[0])
      .toMatchObject({status:"unavailable",reason:"codex-source-homes-not-provided"});
    db.query("UPDATE events SET in_tok=2000000 WHERE home='live'").run();
    finish();
    const after=captureAccountPrices(db,selected,null,now.toISOString(),codexContext);
    expect(after.accounts[0]).toMatchObject({status:"available",totals:{standard:{value:"2"},quality:{complete:false}}});
    expect(accountPriceDelta(before,after)[0]!.standard).toEqual({status:"unavailable",reason:"price-quality-not-complete-at-both-boundaries",value:null});
  }finally{db.close(true);}
});
