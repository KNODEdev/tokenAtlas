import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { installAnalysisTracking } from "../db/analysis";
import { fillUsageLedgerFixture } from "../server/usage-ledger.fixture";
import type { RateCard } from "../server/pricing";
import { createTestDatabase } from "./test-support";
import { ensureArchiveIdentity } from "./archive-inventory";
import {
  activateArchiveRelocation,
  advanceArchiveRelocation,
  readArchiveRelocation,
  startArchiveRelocation,
  type ArchiveRelocationState,
} from "./archive-relocation";
import { ARCHIVE_RELOCATION_OWNER_FILE, ARCHIVE_WRITERS_DIRECTORY, initializeArchiveWriterIdentity } from "./archive-writers";
import { atomicArchiveWrite } from "./archive-publication";
import {
  persistLocalArchiveSelection,
  readLocalArchiveSelection,
} from "../config/archive-locator";

const temporary:string[]=[];
afterEach(()=>{for(const root of temporary.splice(0))removeTestFixture(root,{recursive:true,force:true});});

function fixture() {
  const created=createTestDatabase();temporary.push(created.directory);
  const base=created.directory,source=path.join(base,"source"),destination=path.join(base,"destination");
  const stateDirectory=path.join(base,"relocation-state"),localState=path.join(base,"local-state");
  fs.mkdirSync(path.join(source,"codex","fixture"),{recursive:true});
  fs.writeFileSync(path.join(source,"codex","fixture","events.jsonl"),'{"tokens":7}\n');
  const archiveId=ensureArchiveIdentity(source);
  const db=new Database(created.dbPath);
  try {
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.query("INSERT INTO meta(key,value) VALUES('archive:identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(archiveId);
  db.exec(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached,out_total)
    VALUES('fixture','one','logical-source','2026-09-10T12:00:00.000Z',7,3)`);
  // Prepared aggregates: the usage ledger, as the maintenance worker fills it.
  installAnalysisTracking(db);fillUsageLedgerFixture(db,JSON.parse(fs.readFileSync(path.resolve(import.meta.dir,"../../rate-cards.json"),"utf8")) as RateCard);
  } finally {db.close();}
  const env={...process.env,TOKENATLAS_LOCAL_STATE:localState,TOKENATLAS_ARCHIVE:undefined,TOKENATLAS_CONFIG:undefined};
  return {base,source,destination,stateDirectory,localState,database:created.dbPath,archiveId,env};
}
async function ready(f:ReturnType<typeof fixture>):Promise<ArchiveRelocationState> {
  let state=startArchiveRelocation(f.source,f.destination,{stateDirectory:f.stateDirectory});
  for(let step=0;state.phase!=="ready-to-switch" && step<100;step++)
    state=await advanceArchiveRelocation(state.jobId,{stateDirectory:f.stateDirectory,maxFiles:2,maxBytes:1024});
  expect(state.phase).toBe("ready-to-switch");return state;
}
function stateBytes(f:ReturnType<typeof fixture>,jobId:string):Buffer {
  return fs.readFileSync(path.join(f.stateDirectory,`${jobId}.json`));
}
async function environment<T>(f:ReturnType<typeof fixture>,operation:()=>T|Promise<T>):Promise<T> {
  const prior=process.env.TOKENATLAS_LOCAL_STATE;process.env.TOKENATLAS_LOCAL_STATE=f.localState;
  try {initializeArchiveWriterIdentity();return await operation();}
  finally {if(prior===undefined)delete process.env.TOKENATLAS_LOCAL_STATE;else process.env.TOKENATLAS_LOCAL_STATE=prior;}
}
async function child(f:ReturnType<typeof fixture>,state:ArchiveRelocationState,exitAt?:string) {
  const cli=exitAt==="cli-activate";
  const worker=path.join(import.meta.dir,cli?"../../scripts/archive-relocation.ts":"archive-relocation-activation-worker.ts");
  const args=cli?["activate","--job",state.jobId,"--state-dir",f.stateDirectory]
    :[state.jobId,f.stateDirectory,f.database,...(exitAt?[exitAt]:[])];
  const proc=Bun.spawn([process.execPath,"--no-env-file",worker,...args],{
    env:{...f.env,TOKENATLAS_LOCAL_STATE:f.localState,TOKENATLAS_DB:f.database},stdout:"pipe",stderr:"pipe",
  });
  const [exit,stdout,stderr]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
  return {exit,stdout,stderr};
}

for(const point of ["destination-marker-removed","locator-committed","source-relocated"] as const) {
  test(`fresh process resumes the durable ${point} crash window`,async()=>{
    const f=fixture(),state=await ready(f);
    const crashed=await child(f,state,point);expect(crashed.exit).toBe(86);
    expect(readArchiveRelocation(f.stateDirectory,state.jobId).phase).toBe("activating");
    expect(fs.existsSync(f.source)).toBe(true);
    expect(()=>atomicArchiveWrite(path.join(f.destination,"blocked.json"),"wrong")).toThrow();
    const resumed=await child(f,state);
    expect({exit:resumed.exit,stderr:resumed.stderr}).toEqual({exit:0,stderr:""});
    const completed=readArchiveRelocation(f.stateDirectory,state.jobId);
    expect(completed).toMatchObject({phase:"activated",activation:{phase:"complete",contract:"local-shared-filesystem-writers-only",remoteProcessExclusion:"not-proven"}});
    expect(readLocalArchiveSelection(f.env)).toEqual({root:path.resolve(f.destination),archiveId:f.archiveId});
    expect(()=>atomicArchiveWrite(path.join(f.source,"stale.json"),"wrong")).toThrow("Archive moved");
    atomicArchiveWrite(path.join(f.destination,"active.json"),"right");
    expect((await child(f,state)).exit).toBe(0);
  });
}

test("pure refusals preserve copying and activated jobs byte-for-byte and never recreate a destination marker",async()=>{
  const copying=fixture();
  const unfinished=startArchiveRelocation(copying.source,copying.destination,{stateDirectory:copying.stateDirectory});
  const beforeCopying=stateBytes(copying,unfinished.jobId);
  await expect(environment(copying,()=>activateArchiveRelocation(unfinished.jobId,{stateDirectory:copying.stateDirectory,database:copying.database,env:copying.env})))
    .rejects.toThrow("finish copying");
  expect(stateBytes(copying,unfinished.jobId)).toEqual(beforeCopying);

  const malformed=fixture(),staged=await ready(malformed),beforeMalformed=stateBytes(malformed,staged.jobId);
  await expect(environment(malformed,()=>activateArchiveRelocation(staged.jobId,{stateDirectory:malformed.stateDirectory,database:malformed.database,
    env:{...malformed.env,TOKENATLAS_ARCHIVE:"bad\0root"}}))).rejects.toThrow("Invalid TOKENATLAS_ARCHIVE");
  expect(stateBytes(malformed,staged.jobId)).toEqual(beforeMalformed);

  const completedFixture=fixture(),readyState=await ready(completedFixture);
  await child(completedFixture,readyState);
  const completedBytes=stateBytes(completedFixture,readyState.jobId);
  const unrelated=path.join(completedFixture.base,"unrelated");fs.mkdirSync(unrelated);const unrelatedId=ensureArchiveIdentity(unrelated);
  persistLocalArchiveSelection({root:unrelated,archiveId:unrelatedId},completedFixture.env);
  await expect(environment(completedFixture,()=>activateArchiveRelocation(readyState.jobId,{stateDirectory:completedFixture.stateDirectory,
    database:completedFixture.database,env:completedFixture.env}))).rejects.toThrow("no longer matches");
  expect(stateBytes(completedFixture,readyState.jobId)).toEqual(completedBytes);
  expect(fs.existsSync(path.join(completedFixture.destination,ARCHIVE_RELOCATION_OWNER_FILE))).toBe(false);
});

test("missing unproven marker, unrelated locator and unknown remote writer refuse without promotion",async()=>{
  const missing=fixture(),missingState=await ready(missing);
  fs.appendFileSync(path.join(missing.source,"codex","fixture","events.jsonl"),'{"tokens":9}\n');
  fs.unlinkSync(path.join(missing.destination,ARCHIVE_RELOCATION_OWNER_FILE));
  const before=stateBytes(missing,missingState.jobId);
  await expect(environment(missing,()=>activateArchiveRelocation(missingState.jobId,{stateDirectory:missing.stateDirectory,database:missing.database,env:missing.env})))
    .rejects.toThrow("marker is missing");
  expect(stateBytes(missing,missingState.jobId)).toEqual(before);
  expect(readLocalArchiveSelection(missing.env)).toBeNull();

  const foreign=fixture(),foreignState=await ready(foreign);
  const other=path.join(foreign.base,"other");fs.mkdirSync(other);const otherId=ensureArchiveIdentity(other);
  persistLocalArchiveSelection({root:other,archiveId:otherId},foreign.env);
  const foreignBefore=stateBytes(foreign,foreignState.jobId);
  await expect(environment(foreign,()=>activateArchiveRelocation(foreignState.jobId,{stateDirectory:foreign.stateDirectory,database:foreign.database,env:foreign.env})))
    .rejects.toThrow("unrelated");
  expect(stateBytes(foreign,foreignState.jobId)).toEqual(foreignBefore);

  const remote=fixture(),remoteState=await ready(remote);
  const writers=path.join(remote.source,ARCHIVE_WRITERS_DIRECTORY);fs.mkdirSync(writers,{recursive:true});
  const token=randomUUID();fs.writeFileSync(path.join(writers,`${token}.json`),JSON.stringify({schema:1,token,host:"unknown-remote",pid:42}));
  await expect(environment(remote,()=>activateArchiveRelocation(remoteState.jobId,{stateDirectory:remote.stateDirectory,database:remote.database,env:remote.env})))
    .rejects.toThrow("writer still active");
  expect(fs.existsSync(path.join(writers,`${token}.json`))).toBe(true);
  expect(readArchiveRelocation(remote.stateDirectory,remoteState.jobId).phase).toBe("ready-to-switch");
});

test("database admission blocks a competing rebuild write through final decision and prepared aggregates survive fresh reopen",async()=>{
  const f=fixture(),state=await ready(f);
  fs.appendFileSync(path.join(f.source,"codex","fixture","events.jsonl"),'{"tokens":9}\n');
  const beforeDb=new Database(f.database,{readonly:true});
  const before={rollups:beforeDb.query("SELECT * FROM usage_ledger_days ORDER BY provider,day,dim_id").all(),
    revisions:beforeDb.query("SELECT * FROM sync_revisions").all(),facts:beforeDb.query("SELECT * FROM claude_events").all()};beforeDb.close();
  let competingBusy=false;
  await environment(f,()=>activateArchiveRelocation(state.jobId,{stateDirectory:f.stateDirectory,database:f.database,env:f.env,hooks:{
    async onPhase(phase){
      if(phase!=="writers-drained")return;
      const code=`import {Database} from ${JSON.stringify(new URL("../db/sqlite.ts", import.meta.url).href)};
        const db=new Database(process.argv[1]);db.exec("PRAGMA busy_timeout=0");
        try {
          const rollups=db.query("SELECT * FROM usage_ledger_days ORDER BY provider,day,dim_id").all();
          let busy=false;
          try {db.exec("BEGIN IMMEDIATE");db.exec("ROLLBACK");}
          catch(error){busy=/locked|busy/i.test(String(error));}
          console.log(JSON.stringify({rollups,busy}));
        } finally {db.close();}`;
      const competing=Bun.spawn([process.execPath,"--no-env-file","-e",code,f.database],{
        env:f.env,stdout:"pipe",stderr:"pipe",
      });
      const timeout=setTimeout(()=>competing.kill(),5000);
      const [exit,stdout,stderr]=await Promise.all([
        competing.exited,new Response(competing.stdout).text(),new Response(competing.stderr).text(),
      ]).finally(()=>clearTimeout(timeout));
      expect({exit,stderr}).toEqual({exit:0,stderr:""});
      const result=JSON.parse(stdout);
      expect(result.rollups).toEqual(before.rollups);
      competingBusy=result.busy;
    },
  }}));
  expect(competingBusy).toBe(true);
  expect(fs.readFileSync(path.join(f.destination,"codex","fixture","events.jsonl"),"utf8"))
    .toBe('{"tokens":7}\n{"tokens":9}\n');
  const reopened=new Database(f.database,{readonly:true});
  expect({rollups:reopened.query("SELECT * FROM usage_ledger_days ORDER BY provider,day,dim_id").all(),
    revisions:reopened.query("SELECT * FROM sync_revisions").all(),facts:reopened.query("SELECT * FROM claude_events").all()}).toEqual(before);
  reopened.close();
},30000);

test("uncertain post-commit failure and failed decision proof retain both guards until a fresh process proves the locator",async()=>{
  const f=fixture(),state=await ready(f);
  const failed=await child(f,state,"uncertain-commit");
  expect(failed.exit).not.toBe(0);
  expect(failed.stderr).toContain("simulated uncertain post-commit failure");
  expect(readArchiveRelocation(f.stateDirectory,state.jobId)).toMatchObject({phase:"activating",activation:{phase:"destination-unsealed"}});
  expect(()=>atomicArchiveWrite(path.join(f.source,"old.json"),"wrong")).toThrow();
  expect(()=>atomicArchiveWrite(path.join(f.destination,"new.json"),"wrong")).toThrow();
  expect(readLocalArchiveSelection(f.env)).toEqual({root:path.resolve(f.destination),archiveId:f.archiveId});
  const resumed=await child(f,state);
  expect({exit:resumed.exit,stderr:resumed.stderr}).toEqual({exit:0,stderr:""});
  expect(readArchiveRelocation(f.stateDirectory,state.jobId).phase).toBe("activated");
});

test("a failed final recopy after an unsealed crash leaves a valid resumable copying job",async()=>{
  const f=fixture(),state=await ready(f);
  expect((await child(f,state,"destination-marker-removed")).exit).toBe(86);
  // Model an external byte correction between attempts; the recovered fence
  // cannot use the previous final-verification phase as proof of these bytes.
  fs.appendFileSync(path.join(f.source,"codex","fixture","events.jsonl"),'{"tokens":11}\n');
  const copy=spyOn(fsp,"copyFile").mockRejectedValueOnce(new Error("simulated final copy ENOSPC"));
  try {
    await expect(environment(f,()=>activateArchiveRelocation(state.jobId,{
      stateDirectory:f.stateDirectory,database:f.database,env:f.env,
    }))).rejects.toThrow("simulated final copy ENOSPC");
  } finally {copy.mockRestore();}
  expect(readArchiveRelocation(f.stateDirectory,state.jobId).phase).toBe("copying");
  expect(readLocalArchiveSelection(f.env)).toBeNull();
  expect(fs.existsSync(path.join(f.destination,ARCHIVE_RELOCATION_OWNER_FILE))).toBe(true);
  let resumed=readArchiveRelocation(f.stateDirectory,state.jobId);
  for(let step=0;resumed.phase!=="ready-to-switch" && step<100;step++)
    resumed=await advanceArchiveRelocation(state.jobId,{stateDirectory:f.stateDirectory});
  expect(resumed.phase).toBe("ready-to-switch");
  expect((await child(f,state)).exit).toBe(0);
  expect(fs.readFileSync(path.join(f.destination,"codex","fixture","events.jsonl"),"utf8"))
    .toBe('{"tokens":7}\n{"tokens":11}\n');
});

test("working databases inside either archive, including directory aliases, are refused before mutation",async()=>{
  for(const rootName of ["source","destination"] as const) {
    const f=fixture(),state=await ready(f),before=stateBytes(f,state.jobId);
    const protocol=()=>[f.source,f.destination].map(root=>{
      const directory=path.join(root,ARCHIVE_WRITERS_DIRECTORY);
      return fs.existsSync(directory)?fs.readdirSync(directory).sort():null;
    });
    const protocolBefore=protocol();
    const database=path.join(f[rootName],"active.sqlite");
    fs.copyFileSync(f.database,database);
    const alias=path.join(f.base,`${rootName}-alias`);
    fs.symlinkSync(f[rootName],alias,process.platform==="win32"?"junction":"dir");
    try {
      for(const selected of [database,path.join(alias,"active.sqlite")]) {
        await expect(environment(f,()=>activateArchiveRelocation(state.jobId,{
          stateDirectory:f.stateDirectory,database:selected,env:f.env,
        }))).rejects.toThrow("outside both relocation archive roots");
        expect(stateBytes(f,state.jobId)).toEqual(before);
        expect(readLocalArchiveSelection(f.env)).toBeNull();
        expect(protocol()).toEqual(protocolBefore);
      }
    } finally {fs.unlinkSync(alias);}
  }
});

test("the explicit activate CLI uses the selected local database and publishes durable progress",async()=>{
  const f=fixture(),state=await ready(f);
  const result=await child(f,state,"cli-activate");
  expect({exit:result.exit,stderr:result.stderr}).toEqual({exit:0,stderr:""});
  expect(JSON.parse(result.stdout)).toMatchObject({jobId:state.jobId,phase:"activated",switched:true});
  expect(readLocalArchiveSelection(f.env)).toEqual({root:f.destination,archiveId:f.archiveId});
  const repeated=await child(f,state,"cli-activate");
  expect({exit:repeated.exit,stderr:repeated.stderr}).toEqual({exit:0,stderr:""});
  expect(JSON.parse(repeated.stdout)).toMatchObject({jobId:state.jobId,phase:"activated",switched:true});
});
