import {afterEach,expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import fs from "node:fs";
import {removeTestFixture} from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {createTestDatabase} from "./test-support";

const temporary:string[]=[];
afterEach(()=>{
  Bun.gc(true);
  for(const root of temporary.splice(0)) {
    if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith("tokenatlas-sync-test-"))
      throw new Error("Refusing cleanup outside synthetic temporary fixture");
    removeTestFixture(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
});
function fixture() {
  const created=createTestDatabase();temporary.push(created.directory);
  const base=created.directory,source=path.join(base,"source"),destination=path.join(base,"destination");
  const stateDirectory=path.join(base,"relocation-state"),localState=path.join(base,"local-state"),archiveId=randomUUID();
  fs.mkdirSync(path.join(source,".archive-inventory"),{recursive:true});
  fs.writeFileSync(path.join(source,".archive-inventory","identity.json"),JSON.stringify({schema:1,archiveId}));
  fs.mkdirSync(path.join(source,"codex","fixture"),{recursive:true});
  fs.writeFileSync(path.join(source,"codex","fixture","events.jsonl"),'{"tokens":7}\n');
  const db=new Database(created.dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.query("INSERT INTO meta VALUES('archive:identity',?)").run(archiveId);
    db.exec("INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest,revision) VALUES ('claude',1,'reconcile','ready',0,'','rules',7)");
  } finally {db.close(true);}
  const env={...process.env,TOKENATLAS_LOCAL_STATE:localState,TOKENATLAS_DB:created.dbPath,
    TOKENATLAS_ARCHIVE:undefined,TOKENATLAS_CONFIG:undefined,TOKENATLAS_STORE_ASUS:undefined,
    TOKENATLAS_STORE_HUB:undefined,TOKENATLAS_STORE_LIVE:undefined,TOKENATLAS_STORE_DESKTOP:undefined};
  return {base,source,destination,stateDirectory,localState,database:created.dbPath,archiveId,env};
}
type Fixture=ReturnType<typeof fixture>;
async function child(f:Fixture,mode:string,jobId="",overrides:Record<string,string|undefined>={}) {
  const worker=path.join(import.meta.dir,"archive-relocation-verification-worker.ts");
  const proc=Bun.spawn([process.execPath,"--no-env-file",worker,mode,f.source,f.destination,f.stateDirectory,f.database,f.archiveId,jobId],{
    env:{...f.env,...overrides},stdout:"pipe",stderr:"pipe"});
  const timeout=setTimeout(()=>proc.kill(),20000);
  const [exit,stdout,stderr]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()])
    .finally(()=>clearTimeout(timeout));
  return {exit,stdout,stderr};
}
function stored(f:Fixture,jobId:string) {return JSON.parse(fs.readFileSync(path.join(f.stateDirectory,`${jobId}.json`),"utf8"));}
test("startup worker discovers local relocation and verifies without a caller-supplied job",async()=>{
  const f=fixture(),before=databaseContents(f),jobId=await activated(f);
  const stale=await child(f,"startup-stale");
  expect(stale.exit).toBe(0);
  expect(JSON.parse(stale.stdout).result).toMatchObject({status:"pending",jobId});
  expect(stored(f,jobId).postActivation).toBeUndefined();
  const result=await child(f,"startup");
  expect({exit:result.exit,stderr:result.stderr}).toEqual({exit:0,stderr:""});
  expect(JSON.parse(result.stdout).result).toEqual({status:"verified",jobId});
  const receipt=stored(f,jobId).postActivation;
  expect(receipt.status).toBe("verified");
  const again=await child(f,"startup");
  expect(again.exit).toBe(0);
  expect(JSON.parse(again.stdout).result).toEqual({status:"verified",jobId});
  expect(stored(f,jobId).postActivation).toEqual(receipt);
  expect(databaseContents(f)).toEqual(before);
  expect(fs.existsSync(path.join(f.source,"codex","fixture","events.jsonl"))).toBe(true);
});
test("startup link never guesses missing jobs and retains failure for a later restart",async()=>{
  const f=fixture(),jobId=await activated(f),file=path.join(f.stateDirectory,`${jobId}.json`);
  fs.renameSync(file,`${file}.saved`);
  const failed=await child(f,"startup");
  expect(failed.exit).toBe(0);
  expect(JSON.parse(failed.stdout).result).toMatchObject({status:"pending",jobId});
  fs.renameSync(`${file}.saved`,file);
  const recovered=await child(f,"startup");
  expect(recovered.exit).toBe(0);
  expect(JSON.parse(recovered.stdout).result).toEqual({status:"verified",jobId});
  for(const name of fs.readdirSync(f.localState).filter(name=>/^archive-relocation-.*\.json$/.test(name)))fs.unlinkSync(path.join(f.localState,name));
  const legacy=await child(f,"startup");
  expect(legacy.exit).toBe(0);
  expect(JSON.parse(legacy.stdout).result).toEqual({status:"not-applicable"});
});
function databaseContents(f:Fixture) {
  const db=new Database(f.database,{readonly:true});
  try {return {totals:db.query("SELECT * FROM usage_ledger_state").all(),revisions:db.query("SELECT * FROM sync_revisions").all()};}
  finally {db.close(true);}
}
async function activated(f:Fixture) {
  const result=await child(f,"activate-and-refuse-old");
  expect({exit:result.exit,stderr:result.stderr}).toEqual({exit:0,stderr:""});
  const parsed=JSON.parse(result.stdout);
  expect(parsed.oldProcessError).toBeString();
  expect(parsed.oldProcessError).toMatch(/new process|Running process still uses/);
  expect(parsed.startupRoot).toBe(f.source);
  expect(parsed.state.phase).toBe("activated");
  expect(parsed.state.postActivation).toBeUndefined();
  return parsed.state.jobId as string;
}

test("fresh process verifies activated archive durably and repeated verification preserves receipt and aggregates",async()=>{
  const f=fixture(),before=databaseContents(f),jobId=await activated(f);
  const result=await child(f,"verify",jobId);
  expect({exit:result.exit,stderr:result.stderr}).toEqual({exit:0,stderr:""});
  const verified=JSON.parse(result.stdout);
  expect(verified.startupRoot).toBe(f.destination);
  expect(verified.state).toMatchObject({phase:"activated",postActivation:{status:"verified"}});
  const receipt=verified.state.postActivation;
  for(const evidence of [receipt.read,receipt.write]) {
    const bytes=fs.readFileSync(path.join(f.destination,evidence.relative));
    expect(bytes.byteLength).toBe(evidence.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(evidence.digest);
  }
  expect(Date.parse(receipt.processStartedAt)).toBeGreaterThan(Date.parse(verified.state.activation.completedAt));
  expect(receipt.processInstance).not.toBe(verified.state.activation.provenance.processInstance);
  expect(stored(f,jobId).postActivation).toEqual(verified.state.postActivation);
  const repeated=await child(f,"verify",jobId);
  expect({exit:repeated.exit,stderr:repeated.stderr}).toEqual({exit:0,stderr:""});
  expect(JSON.parse(repeated.stdout).state.postActivation).toEqual(verified.state.postActivation);
  const staleOverride=await child(f,"verify",jobId,{TOKENATLAS_ARCHIVE:f.source});
  expect(staleOverride.exit).not.toBe(0);
  expect(stored(f,jobId).postActivation).toEqual(receipt);
  expect(databaseContents(f)).toEqual(before);
  expect(fs.readFileSync(path.join(f.source,"codex","fixture","events.jsonl"),"utf8")).toBe('{"tokens":7}\n');
},60000);

test("verification rejects stale overrides, replaced and disconnected destinations without inventing receipt",async()=>{
  for(const kind of ["archive-override","store-override","replaced","directory-replaced","disconnected"] as const) {
    const f=fixture(),jobId=await activated(f);
    let overrides:Record<string,string|undefined>={};
    if(kind==="archive-override")overrides={TOKENATLAS_ARCHIVE:f.source};
    if(kind==="store-override") {
      // A canonical old logical path rebases safely; an external alias into the retiring tree does not.
      const alias=path.join(f.base,"source-alias");
      fs.symlinkSync(f.source,alias,process.platform==="win32"?"junction":"dir");
      overrides={TOKENATLAS_STORE_LIVE:path.join(alias,"codex","fixture")};
    }
    if(kind==="replaced")fs.writeFileSync(path.join(f.destination,".archive-inventory","identity.json"),JSON.stringify({schema:1,archiveId:randomUUID()}));
    if(kind==="directory-replaced") {
      const retired=path.join(f.base,"replaced-destination");
      fs.renameSync(f.destination,retired);fs.cpSync(retired,f.destination,{recursive:true});
    }
    if(kind==="disconnected")fs.renameSync(f.destination,path.join(f.base,"disconnected"));
    const result=await child(f,"verify",jobId,overrides);
    expect({kind,exit:result.exit}).not.toEqual({kind,exit:0});
    expect(stored(f,jobId).postActivation).toBeUndefined();
    expect(fs.existsSync(f.source)).toBe(true);
    if(kind==="disconnected")expect(fs.existsSync(f.destination)).toBe(false);
  }
},60000);

test("failed or terminated control check before receipt resumes in another process",async()=>{
  for(const mode of ["fail-before-receipt","crash-before-receipt"]) {
    const f=fixture(),jobId=await activated(f);
    const failed=await child(f,mode,jobId);
    expect(failed.exit).not.toBe(0);
    if(mode==="fail-before-receipt")expect(failed.stderr).toContain("synthetic failure before verification receipt");
    else expect(failed.exit).toBe(87);
    expect(stored(f,jobId).postActivation).toBeUndefined();
    const resumed=await child(f,"verify",jobId);
    expect({exit:resumed.exit,stderr:resumed.stderr}).toEqual({exit:0,stderr:""});
    expect(stored(f,jobId)).toMatchObject({phase:"activated",postActivation:{status:"verified"}});
  }
},60000);

test("verification preserves foreign control files and refuses control-path aliases",async()=>{
  for(const alias of [false,true]) {
    const f=fixture(),jobId=await activated(f);
    const control=path.join(f.destination,".archive-inventory",`post-activation-${jobId}.json`);
    const foreign=path.join(f.base,"foreign-control");
    fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,"retained.txt"),"unrelated evidence");
    if(alias)fs.symlinkSync(foreign,control,process.platform==="win32"?"junction":"dir");
    else fs.writeFileSync(control,JSON.stringify({schema:1,kind:"unrelated-document",retained:true}));
    const before=alias?null:fs.readFileSync(control,"utf8");
    const result=await child(f,"verify",jobId);
    expect(result.exit).not.toBe(0);
    expect(stored(f,jobId).postActivation).toBeUndefined();
    expect(fs.readFileSync(path.join(foreign,"retained.txt"),"utf8")).toBe("unrelated evidence");
    if(alias)expect(fs.lstatSync(control).isSymbolicLink()).toBe(true);
    else expect(fs.readFileSync(control,"utf8")).toBe(before!);
  }
},60000);
