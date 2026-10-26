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
import type {RateCard} from "./pricing";
import {buildEraIndex,type EraDeclaration} from "./eras";
import {createAnalysisRebuildReport,finalizeAnalysisRebuildReport} from "./analysis-rebuild-report";
import {analysisRebuildStatus,queueAnalysisRebuild,resumeAnalysisRebuild,updateAnalysisRebuild,completeAnalysisRebuild} from "./analysis-rebuild";

const subscriptions:EraDeclaration[]=[{id:"selected",vendor:"claude"},{id:"foreign",vendor:"claude"}];
const rateCards:RateCard={version:1,currency:"USD",unit:"per 1M",vendors:{anthropic:{models:{"claude-fixture":{in_uncached:1,in_cache_read:0,in_cache_write_5m:0,in_cache_write_1h:0,out_total:3}}}}};
const context={subscriptions,sources:[],eras:buildEraIndex(subscriptions),rateCards};
const now=new Date("2026-09-18T12:00:00Z");
const accounts=[{vendor:"claude" as const,account:"selected"}];
function fixture(file=":memory:") {
  const db=new Database(file);applyDrizzleMigrations(drizzle(db));
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  installAnalysisTracking(db);
  db.exec(`INSERT INTO claude_events(store,call_id,path,ts,subscription_id,model,in_uncached,out_total) VALUES
    ('pc','one','one','2026-09-01T12:00:00Z','selected','claude-fixture',9007199254740991,3),
    ('pc','two','two','2026-09-02T12:00:00Z','selected','claude-fixture',2,4),
    ('foreign','other','other','2026-09-02T12:00:00Z','foreign','claude-fixture',999,2)`);
  for(const account of ["selected","foreign"]) {
    db.query("UPDATE claude_events SET path=? WHERE subscription_id=?").run(join(ARCHIVE_LOGICAL_ROOT,"claude",account,"one.jsonl"),account);
    db.query("INSERT INTO account_periods(provider,source,from_ts,account,origin,evidence) VALUES('claude',?,'2020-01-01',?,'declared','test')").run(`claude/${account}`,account);
  }
  return db;
}
/** The usage ledger in one-row steps, as the background producer advances it. */
function prepare(db:Database) {
  fillUsageLedger(db,"claude",rateCards,ARCHIVE_LOGICAL_ROOT,1);
}
const FOREIGN_DAYS="SELECT d.* FROM usage_ledger_days d JOIN usage_ledger_dims m ON m.id=d.dim_id WHERE d.provider='claude' AND m.source='claude/foreign'";
const job=()=>({generation:1,scope:"all" as const,range:null,accounts,state:"queued"});

test("account report freezes exact before across failure/restart and persists selected correction delta",()=>{
  const root=mkdtempSync(join(tmpdir(),"atlas-account-totals-")),file=join(root,"fixture.sqlite");
  let db=fixture(file);
  try {
    prepare(db);
    const foreign=db.query(FOREIGN_DAYS).all();
    const queued=queueAnalysisRebuild(db,{scope:"all",accounts},now,true,subscriptions,context.eras,rateCards);
    const before=queued.report!.accountTotals!.before;
    expect(before.accounts).toHaveLength(1);
    expect(before.accounts[0]).toMatchObject({account:"selected",status:"available",calls:"2",
      buckets:{in_uncached:"9007199254740993",out_total:"7"},quality:{complete:true}});
    updateAnalysisRebuild(db,queued.generation,{state:"error",error:"synthetic pause"});
    db.close(true);db=new Database(file);
    db.exec("UPDATE claude_events SET in_uncached=CASE call_id WHEN 'one' THEN 4 ELSE 6 END WHERE subscription_id='selected'");
    prepare(db);resumeAnalysisRebuild(db);
    expect(analysisRebuildStatus(db)!.report!.accountTotals!.before).toEqual(before);
    updateAnalysisRebuild(db,queued.generation,{state:"running",phase:"reports",completed:3,total:3});
    expect(completeAnalysisRebuild(db,queued.generation,context)).toBe(true);
    const report=analysisRebuildStatus(db)!.report!;
    expect(report.accountTotals!.after!.accounts[0]).toMatchObject({calls:"2",buckets:{in_uncached:"10",out_total:"7"}});
    expect(report.accountTotals!.delta).toEqual([{vendor:"claude",account:"selected",status:"available",reason:null,calls:"0",
      buckets:{in_uncached:"-9007199254740983",in_cache_read:"0",in_cache_write_5m:"0",in_cache_write_1h:"0",in_cache_write_unknown:"0",out_total:"0"}}]);
    expect(db.query(FOREIGN_DAYS).all()).toEqual(foreign);
    db.close(true);db=new Database(file);
    expect(analysisRebuildStatus(db)!.report!.accountTotals).toEqual(report.accountTotals);
  } finally {db.close(true);Bun.gc(true);rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
});

test("missing and legacy before boundaries remain unknown after preparation; capture does not scan or write facts",()=>{
  const db=fixture();
  try {
    const report=createAnalysisRebuildReport(db,job(),now,context);
    expect(report.accountTotals!.before.accounts[0]).toMatchObject({status:"unavailable",reason:"usage-price-register-absent",buckets:null});
    prepare(db);
    db.exec("PRAGMA query_only=ON");
    const query=db.query.bind(db),sql:string[]=[];
    const spy=spyOn(db,"query").mockImplementation(((text:string)=>{sql.push(text);return query(text);}) as typeof db.query);
    try {
      const finished=finalizeAnalysisRebuildReport(db,report,0,0,now,context);
      expect(finished.accountTotals!.before).toEqual(report.accountTotals!.before);
      expect(finished.accountTotals!.after!.accounts[0]!.status).toBe("available");
      expect(finished.accountTotals!.delta![0]!.reason).toBe("totals-not-available-at-both-boundaries");
      const legacy={...report};delete legacy.accountTotals;
      const adopted=finalizeAnalysisRebuildReport(db,legacy,0,0,now,context);
      expect(adopted.accountTotals!.before).toMatchObject({capturedAt:null,accounts:[{status:"unavailable",reason:"legacy-job-adopted-after-queue-boundary"}]});
      expect(adopted.accountTotals!.delta![0]!.status).toBe("unavailable");
    } finally {spy.mockRestore();}
    expect(sql.some(text=>/usage_ledger_facts|FROM claude_events|\b(?:INSERT|UPDATE|DELETE)\b/i.test(text))).toBe(false);
  } finally {db.close(true);}
});

test("unrelated declarations preserve account comparison; conflicting canonical usage stays unknown",()=>{
  const db=fixture();
  try {
    prepare(db);
    const report=createAnalysisRebuildReport(db,job(),now,context);
    const changedSubscriptions=[...subscriptions,{id:"third",vendor:"claude"}];
    const changedContext={...context,subscriptions:changedSubscriptions,eras:buildEraIndex(changedSubscriptions)};
    expect(finalizeAnalysisRebuildReport(db,report,0,0,now,changedContext).accountTotals!.delta![0]!.calls).toBe("0");
    db.exec(`INSERT INTO claude_events(store,call_id,path,ts,subscription_id,model,in_uncached,out_total)
      VALUES ('copy','one','copy','2026-09-03T12:00:00Z','selected','claude-fixture',10,3)`);
    db.query("UPDATE claude_events SET path=? WHERE store='copy'").run(join(ARCHIVE_LOGICAL_ROOT,"claude/selected/copy.jsonl"));
    prepare(db);
    const conflict=finalizeAnalysisRebuildReport(db,report,0,0,now,context);
    expect(conflict.accountTotals!.after!.accounts[0]!.quality).toMatchObject({complete:false,conflictedIdentityDays:"2"});
    expect(conflict.accountTotals!.delta![0]!.reason).toBe("quality-not-complete-at-both-boundaries");
  } finally {db.close(true);}
});
