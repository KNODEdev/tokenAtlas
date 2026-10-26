import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, valueCodexLedgerBand, rebuildCodexLedgerDay, CodexLedgerNotReady } from "./codex-price-ledger";
import { readCodexLedgerStoredSnapshot, readCodexLedgerSeries, withCodexLedgerStoredSnapshot } from "./codex-price-ledger-read";
import { codexLedgerReadContext, codexLedgerReadStamp } from "./codex-ledger-adapters";
import type { RateCard } from "../server/pricing";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";
import { overrideProjectRules } from "../projects/resolve";

const day="2026-09-01",evidence={verified_at:day,sources:["https://example.test/rates"],confidence:"official" as const};
const card:RateCard={version:2,currency:"USD",unit:"per million",vendors:{},codex_ledger_policy:{version:1,tiers:["standard"],
  mappings:[{id:"default",raw_value:"default",tier:"standard"}],tier_rules:[],base_rules:["api_equivalent_usd","chatgpt_credits"].map(basis=>({
    id:basis,model:"m",billing_basis:basis as "api_equivalent_usd"|"chatgpt_credits",valid_from:"2026-01-01",multiplier:"1",...evidence,
    rates:{in_uncached:"1",in_cache_read:"0.1",out_total:"5"}}))}};
const context=codexLedgerReadContext(card),apiRange={dependencyBases:["api_equivalent_usd"] as const};
function seed(db:Database,count=1){
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,
      cache_write ANY,out_tok ANY,reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT) STRICT`);
  const insert=db.query("INSERT INTO events VALUES ('archive','archive/sessions/x',?,'m',?,100,0,0,0,0,'valid','missing',?,'unknown')");
  db.transaction(()=>{for(let index=0;index<count;index++)insert.run(index*100,`${day}T12:00:00Z`,count===1?"default":`unknown-${index}`);})();
  createCodexLedgerSchema(db);fillCodexLedgerFixture(db,{bands:context.policy.baseBands,
    policy:context.policy.policy,rulesRevision:context.rulesRevision!,factsRevision:0,sourceOf:()=>"codex/main"});
}
function correction(db:Database){
  db.transaction(()=>{
    db.exec("UPDATE codex_price_ledger_events SET in_tok=in_tok+1,uncached=uncached+1,reported=reported+1,window_input=window_input+1");
    for(const band of context.policy.baseBands)valueCodexLedgerBand(db,band);
    for (const { day } of db.query("SELECT DISTINCT day FROM codex_price_ledger_events").all() as Array<{ day: string }>) rebuildCodexLedgerDay(db, day);
    db.exec("UPDATE usage_ledger_state SET covered=covered+1 WHERE provider='codex'");
  })();
}
const read=(db:Database)=>readCodexLedgerSeries(db,context.policy,{range:apiRange,requestedVariants:["api_standard"] as const});
const groupLookups=(queries:ReturnType<typeof spyOn>)=>queries.mock.calls.filter((call:unknown[])=>typeof call[0]==="string"&&call[0].startsWith("SELECT g.day"));

test("model-only dependency checks skip project history but retain price readiness and correction fences",()=>{
  const db=new Database(":memory:");try{
    seed(db);
    const range={dependencyProjects:false as const},queries=spyOn(db,"query");
    let original:string;
    try{
      original=codexLedgerReadStamp(db,context,range);
      expect(queries.mock.calls.some(([sql])=>/codex_price_ledger_file_models|account_periods/.test(String(sql)))).toBe(false);
      expect(groupLookups(queries).length).toBe(0);
    }finally{queries.mockRestore();}
    const attributed=codexLedgerReadStamp(db,context);
    overrideProjectRules(db,{projects:[{id:"changed",name:"changed",matches:[{cwd:"/changed"}]}]});
    expect(codexLedgerReadStamp(db,context,range)).toBe(original!);
    expect(codexLedgerReadStamp(db,context)).not.toBe(attributed);
    correction(db);
    expect(codexLedgerReadStamp(db,context,range)).not.toBe(original!);
    db.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"m\",\"basis\":\"api_equivalent_usd\",\"fromDay\":\"2026-01-01\",\"untilDay\":null,\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
    expect(()=>codexLedgerReadStamp(db,context,range)).toThrow(CodexLedgerNotReady);
  }finally{db.close(true);}
});

test("cold whole stamp reads only price dependencies; the body retains its immutable cohort snapshot",()=>{
  const db=new Database(":memory:");try{
    seed(db);const queries=spyOn(db,"query");
    try{
      const whole=codexLedgerReadStamp(db,context,apiRange);
      expect(groupLookups(queries).length).toBe(0);
      const groups=read(db);
      expect(groupLookups(queries).length).toBe(1);
      expect(groups[0]!.calls).toBe(1n);
      const bounded=codexLedgerReadStamp(db,context,{...apiRange,since:day,until:day});
      expect(whole).toBe(bounded);
      const rows=readCodexLedgerStoredSnapshot(db,apiRange);
      expect(Object.isFrozen(rows)).toBe(true);expect(Object.isFrozen(rows[0])).toBe(true);
      expect(Reflect.set(rows[0]!,"calls","999")).toBe(false);
      expect(Reflect.set(rows,"0",{calls:"999"})).toBe(false);
      expect(read(db)[0]!.calls).toBe(1n);
    }finally{queries.mockRestore();}
  }finally{db.close(true);}
});

test("own committed writes invalidate cohorts; caller-owned rollback cannot publish uncommitted rows",()=>{
  const db=new Database(":memory:");try{
    seed(db);const initial=read(db)[0]!.variants.api_standard.pricedSubtotal;
    correction(db);const committed=read(db)[0]!.variants.api_standard.pricedSubtotal;
    expect(committed).not.toEqual(initial);
    expect(()=>db.transaction(()=>{
      correction(db);expect(read(db)[0]!.variants.api_standard.pricedSubtotal).not.toEqual(committed);throw new Error("rollback");
    })()).toThrow("rollback");
    expect(read(db)[0]!.variants.api_standard.pricedSubtotal).toEqual(committed);
    const queries=spyOn(db,"query");try{read(db);expect(groupLookups(queries).length).toBe(0);}finally{queries.mockRestore();}
  }finally{db.close(true);}
});

test("an owned snapshot callback that writes or fails never publishes its cache candidate",()=>{
  const db=new Database(":memory:");try{
    seed(db);const baseline=read(db)[0]!.tokensReported;
    expect(()=>withCodexLedgerStoredSnapshot(db,()=>{correction(db);readCodexLedgerStoredSnapshot(db,apiRange);throw new Error("failed snapshot");})).toThrow("failed snapshot");
    expect(read(db)[0]!.tokensReported).toBe(baseline);
    withCodexLedgerStoredSnapshot(db,()=>{correction(db);readCodexLedgerStoredSnapshot(db,apiRange);});
    expect(read(db)[0]!.tokensReported).toBe(baseline+1n);
  }finally{db.close(true);}
});

test("external WAL commits refresh outside reads while a current read transaction keeps its old snapshot",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"codex-ledger-snapshot-")),file=path.join(dir,"x.sqlite");
  const writer=new Database(file);writer.exec("PRAGMA journal_mode=WAL");seed(writer);
  const reader=new Database(file,{readonly:true});
  try{
    const baseline=read(reader)[0]!.tokensReported;
    const stamp=codexLedgerReadStamp(reader,context);
    reader.transaction(()=>{
      expect(read(reader)[0]!.tokensReported).toBe(baseline);
      correction(writer);
      expect(read(reader)[0]!.tokensReported).toBe(baseline);
      expect(codexLedgerReadStamp(reader,context)).toBe(stamp);
    })();
    expect(read(reader)[0]!.tokensReported).toBe(baseline+1n);
    const correctedStamp=codexLedgerReadStamp(reader,context);
    expect(correctedStamp).not.toBe(stamp);
    const fresh=new Database(file,{readonly:true});try{
      expect(codexLedgerReadStamp(fresh,context)).toBe(correctedStamp);
      fresh.transaction(()=>{
        expect(read(fresh)[0]!.tokensReported).toBe(baseline+1n);
        correction(writer);expect(read(fresh)[0]!.tokensReported).toBe(baseline+1n);
      })();
      expect(read(fresh)[0]!.tokensReported).toBe(baseline+2n);
    }finally{fresh.close(true);}
  }finally{
    reader.close(true);writer.close(true);
    const resolved=fs.realpathSync(dir),root=fs.realpathSync(os.tmpdir());
    if(path.dirname(resolved)!==root||!path.basename(resolved).startsWith("codex-ledger-snapshot-"))throw new Error("Unexpected fixture cleanup path");
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});

test("readiness precedes cache hits and an API-only full snapshot remains independent of credit work",()=>{
  const db=new Database(":memory:");try{
    seed(db);read(db);
    db.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','{\"model\":\"m\",\"basis\":\"chatgpt_credits\",\"fromDay\":\"2026-01-01\",\"untilDay\":null,\"inputAbove\":null,\"inputUntil\":null,\"after\":-1}')");
    expect(read(db)[0]!.calls).toBe(1n);
    expect(()=>readCodexLedgerStoredSnapshot(db,{})).toThrow(CodexLedgerNotReady);
    db.exec("UPDATE usage_ledger_state SET status='pending' WHERE provider='codex'");
    expect(()=>read(db)).toThrow(CodexLedgerNotReady);
  }finally{db.close(true);}
});

test("history beyond the row bound uses actual uncached cohorts without truncation or fake zero",()=>{
  const db=new Database(":memory:");try{
    seed(db,30_001);const queries=spyOn(db,"query");try{
      const first=readCodexLedgerStoredSnapshot(db,apiRange),second=readCodexLedgerStoredSnapshot(db,apiRange);
      expect(first.length).toBe(30_001);expect(second.length).toBe(30_001);expect(first).not.toBe(second);
      expect(first.reduce((sum,row)=>sum+BigInt(row.calls),0n)).toBe(30_001n);
      expect(groupLookups(queries).length).toBe(2);
    }finally{queries.mockRestore();}
  }finally{db.close(true);}
});
