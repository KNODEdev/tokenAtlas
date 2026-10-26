import {expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import {randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {digest} from "../config/canonical-json";
import {OBSERVATION_JOURNAL_FILE} from "../providers/core/journal";
import {installAnalysisTracking} from "../db/analysis";
import {createProbeCollection,type CanonicalProbe} from "../db/probe-facts";
import {ingestGaugesAsync} from "../ingest/gauges";
import {createCodexSchema, createTestDatabase, emptyAccountsDocument} from "./test-support";
import {removeTestFixture} from "../test-cleanup";

test.each([false,true])("an account meter rebuild recovers the account's own readings and preserve foreign transport state (ranged=%s)",async(ranged)=>{
  const {directory,dbPath}=createTestDatabase();
  const archiveRoot=path.join(directory,"archive"),config=path.join(directory,"config");
  const journal=path.join(archiveRoot,"gauges","fixture-pc","probe_windows.jsonl");
  fs.mkdirSync(path.dirname(journal),{recursive:true}); fs.mkdirSync(config);
  const document=emptyAccountsDocument();
  const configFiles=Object.fromEntries(["accounts.json","projects.json","rate-cards.json"].map(name=>[name,path.join(config,name)]));
  fs.writeFileSync(configFiles["accounts.json"]!,JSON.stringify(document));
  fs.writeFileSync(configFiles["projects.json"]!,JSON.stringify({projects:[]}));
  fs.writeFileSync(configFiles["rate-cards.json"]!,JSON.stringify({vendors:{}}));
  const fact=(ts:string,subject:string)=>{
    return createProbeCollection([{provider:"codex",subject,raw_subject:subject,ts,kind:"weekly",reported_percent_side:"used",used_percent:20,
      machine:"fixture-pc",login:"fixture",source_home:"C:/Users/fixture/.codex"}])[0]!;
  };
  const line=(c:CanonicalProbe)=>JSON.stringify({...c.payload,canonical_version:1,canonical_probe:c,journal_version:2,journal_entry_id:randomUUID()})+"\n";
  // The same physical source changes account at the February boundary.
  const a=fact("2026-01-15T12:00:00Z","B"),b=fact("2026-02-15T12:00:00Z","B"),fresh=fact("2026-01-16T12:00:00Z","B");
  const observationJournal=path.join(path.dirname(journal),OBSERVATION_JOURNAL_FILE);
  const observation=(ts:string)=>{
    const observed={ts,vendor:"codex",source:"same-profile",identity_kind:"email",identity:"same-login",raw_source:null,machine:"fixture-pc",login:"fixture"};
    const body={version:1,observation_id:randomUUID(),recorded_at:ts,observed,source_home:null,origin:null};
    return JSON.stringify({...observed,source_evidence:{...body,digest:digest(body)},journal_version:2,journal_entry_id:randomUUID()})+"\n";
  };
  const predecessorTs="2026-01-14T12:00:00Z",newObservationTs="2026-01-16T12:00:00Z";
  const run=async(request:unknown)=>{
    const child=Bun.spawn([process.execPath,path.join(import.meta.dir,"runner.ts"),JSON.stringify({dbPath,rootDir:process.cwd(),request})],{
      env:{...process.env,TOKENATLAS_ARCHIVE:archiveRoot,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(directory,"local"),TOKENATLAS_DB:dbPath,
        APPDATA:path.join(directory,"absent-appdata"),LOCALAPPDATA:path.join(directory,"absent-localappdata"),
        USERPROFILE:path.join(directory,"absent-home"),HOME:path.join(directory,"absent-home"),OneDrive:path.join(directory,"absent-cloud"),TOKENATLAS_MACHINE:"fixture-pc",TOKENATLAS_LOGIN:"fixture"},stdout:"pipe",stderr:"pipe"});
    const timer=setTimeout(()=>child.kill(),30_000);
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]).finally(()=>clearTimeout(timer));
    expect({exit,err}).toEqual({exit:0,err:""});
    const resultLine=out.split(/\r?\n/).find(row=>row.startsWith("TOKENATLAS_SYNC_RESULT:"));
    expect(resultLine).toBeDefined();
    const result=JSON.parse(resultLine!.slice("TOKENATLAS_SYNC_RESULT:".length));
    expect({status:result.status,error:result.error,vendors:result.vendors.filter((v:any)=>v.status!=="success")}).toEqual({status:"success",error:null,vendors:[]});
    return result;
  };
  const snapshot=()=>{
    const db=new Database(dbPath,{readonly:true});
    try {return Object.fromEntries(["probe_windows","probe_counters","probe_observations","probe_fact_legacy_map","probe_fact_deliveries","gauge_journal_receipts","gauge_files"].map(table=>[table,db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));}
    finally {db.close(true);}
  };
  try {
    createCodexSchema(dbPath);
    const db=new Database(dbPath);
    try {
      installAnalysisTracking(db);
      const period=db.query(`INSERT INTO account_periods(provider,source,from_ts,until_ts,account,origin,evidence)
        VALUES ('codex','codex/fixture-pc-fixture',?,?,?,'declared','fixture')`);
      period.run("2026-01-01T00:00:00Z","2026-02-01T00:00:00Z","a");
      period.run("2026-02-01T00:00:00Z",null,"b");
    }finally{db.close(true);}
    fs.writeFileSync(journal,line(a)+line(b));
    fs.writeFileSync(observationJournal,observation(predecessorTs)+observation("2026-02-15T12:00:00Z"));
    (await ingestGaugesAsync({atlasPath:dbPath,archiveRoot,ownStore:"receiver",force:true}));
    await run({trigger:"manual",scope:{kind:"vendor",vendor:"gauges"},mode:"incremental"});
    const accepted=snapshot();
    // Observation segments stay byte-for-byte in the archive and are read past, never imported.
    const oldA=accepted.probe_windows!.find((row:any)=>row.ts===a.payload.ts) as any;
    const oldB=accepted.probe_windows!.find((row:any)=>row.ts===b.payload.ts);
    expect(oldA.subject).toBe("B"); expect((oldB as any).subject).toBe("B");
    const damage=new Database(dbPath);try{
      damage.query("DELETE FROM probe_windows WHERE id=?").run(oldA.id);
    }finally{damage.close(true);}
    fs.appendFileSync(journal,line(fresh));
    fs.appendFileSync(observationJournal,observation(newObservationTs));
    const originalJournal=fs.readFileSync(observationJournal,"utf8");
    const request={trigger:"manual",mode:"incremental",scope:{kind:"accounts",accounts:[{vendor:"codex",account:"a"}],meters:"archive"},reparse:ranged?{from:"2026-01-15",until:"2026-01-31"}:{},collection:"archive",rebuildGeneration:601} as const;
    const result=await run(request);
    const gauge=result.vendors.find((v:any)=>v.vendor==="gauges");
    expect(gauge.diagnostics.reparse).toMatchObject({accountScope:"usage-with-archived-counters",selectedCounters:2,meterDays:[{vendor:"codex",account:"a",day:"2026-01-15"},{vendor:"codex",account:"a",day:"2026-01-16"}]});
    const restored=snapshot();
    // Account recovery reads the readings alone: the retired observation log and its segments stay as they are.
    expect(fs.readFileSync(observationJournal,"utf8")).toBe(originalJournal);
    // The deleted reading returns with its content; its row id is a local projection detail.
    const {id:_oldId,...oldAContent}=oldA;
    expect(restored.probe_windows!.filter((row:any)=>row.ts===a.payload.ts).map(({id:_,...row}:any)=>row)).toEqual([oldAContent]);
    expect(restored.probe_windows!.find((row:any)=>row.ts===b.payload.ts)).toEqual(oldB);
    expect(restored.probe_windows!.filter((row:any)=>row.ts===fresh.payload.ts)).toHaveLength(1);
    expect(restored.probe_counters).toHaveLength(3);
    for(const row of accepted.probe_counters as any[])expect(restored.probe_counters!.find((value:any)=>value.id===row.id)).toEqual(row);
    for(const row of accepted.probe_observations as any[])expect(restored.probe_observations!.find((value:any)=>value.id===row.id)).toEqual(row);
    for(const table of ["probe_fact_legacy_map","probe_fact_deliveries"])
      expect(restored[table]!.filter((row:any)=>row.counter_id===b.counter_id)).toEqual(accepted[table]!.filter((row:any)=>row.counter_id===b.counter_id));
    for(const table of ["gauge_journal_receipts","gauge_files"])expect(restored[table]).toEqual(accepted[table]);
    await run(request); expect(snapshot()).toEqual(restored);
    const next={...request,rebuildGeneration:602};
    await run(next);
    expect(snapshot()).toEqual(restored);
  } finally {Bun.gc(true);removeTestFixture(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
},90_000);
