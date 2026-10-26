import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { prepareGlobalFixture } from "./global-usage.fixture";
import { loadAccountResolver } from "./account-resolver";
import {ACCOUNT_PERIODS,replaceDeclaredPeriods} from "../db/period-store";
import {test,expect} from "bun:test";
import {Database} from "../db/sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {applyDrizzleMigrations} from "../db/migrate";
import {installAnalysisTracking} from "../db/analysis";
import {buildCodexAccountingReport} from "./codex-accounting";
import {buildGlobalUsage} from "./global-usage";
import {buildEraIndex} from "./eras";
import {indexSubscriptionHomes} from "./capacity-equivalents";
import type {RateCard} from "./pricing";

test("period corrections refresh Codex/global accounts while copy selection and valuations stay unchanged",()=>{
  const db=new Database(":memory:");
  try {
    applyDrizzleMigrations(drizzle(db));
    db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT,model TEXT,speed TEXT,
      in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,billing_mode TEXT);
      CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT,plan_type TEXT);
      INSERT INTO events VALUES
        (1,'archive/a','archive/a/sessions/shared.jsonl','2026-09-08T12:00:00Z','gpt-6-astra','standard',100000,80000,0,10000,NULL),
        (2,'live/a','live/a/sessions/shared.jsonl','2026-09-08T12:00:00Z','gpt-6-astra','standard',100000,80000,0,10000,NULL);`);
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
    installAnalysisTracking(db);
    const assign=(value:string)=>replaceDeclaredPeriods(db,ACCOUNT_PERIODS,[{provider:"codex",subject:"codex/fixture",value,from:"2020-01-01T00:00:00Z",until:null,origin:"declared",firstSeen:null,lastSeen:null,readings:0,evidence:"test"}]);
    assign("codex1");
    const declarations=["archive/a","live/a"].map(source_home=>({id:"codex1",vendor:"codex",home:`${ARCHIVE_LOGICAL_ROOT}/codex/fixture`,source_home,from:"2026-01-01"}));
    const eras=buildEraIndex(declarations),fingerprint=eras.fingerprint;
    expect(fingerprint).toBeTruthy();
    const homes=indexSubscriptionHomes(declarations);
    const card:RateCard={version:2,currency:"USD",unit:"per 1M",vendors:{}};
    prepareGlobalFixture(db,card,declarations);
    const range={since:"2026-09-08",until:"2026-09-08"};
    const codex=()=>buildCodexAccountingReport(db,card,range,homes,eras,false,undefined,undefined,undefined,loadAccountResolver(db),declarations);
    const global=()=>buildGlobalUsage({sqlite:db,rateCards:card,homeToSubId:homes,eras,accounts:{subscriptions:declarations}},range);
    const valuations=()=>db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const verify=(copies:number)=>{
      const accounting=codex(),usage=global();
      expect(accounting.events).toBe(copies);
      expect(accounting.tokens).toBe(copies*110000);
      expect(accounting.amounts.api_equivalent_usd.value).toBeCloseTo(copies*.78,10);
      expect(accounting.amounts.chatgpt_credits.value).toBeCloseTo(copies*19.5,10);
      expect(usage.rows.reduce((sum,row)=>sum+row.calls,0)).toBe(copies);
      expect(usage.rows.reduce((sum,row)=>sum+row.tokens,0)).toBe(copies*110000);
      expect(usage.rows.reduce((sum,row)=>sum+row.api_usd.subtotal,0)).toBeCloseTo(copies*.78,10);
      expect(usage.excluded_duplicates).toBe(2-copies);
      expect(codex()).toEqual(accounting);
      expect(global()).toEqual(usage);
      expect(eras.fingerprint).toBe(fingerprint);
    };
    verify(1);
    const retained=valuations();
    expect(retained).toHaveLength(2);
    assign("codex2");
    expect(global().rows[0]!.account).toBe("codex2");
    expect(codex().breakdown[0]!.account).toBe("codex2");
    expect(valuations()).toEqual(retained);
    assign("codex1");
    verify(1);
    expect(valuations()).toEqual(retained);
  } finally {Bun.gc(true);db.close(true);}
});

