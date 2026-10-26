import {afterEach,expect,test} from "bun:test";
import {Database} from "../db/sqlite";
import fs from "node:fs";
import {removeTestFixture} from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import {createTestDatabase} from "./test-support";
import {ensureArchiveIdentity} from "./archive-inventory";
import {prepareArchiveCleanupPlan} from "./archive-relocation-cleanup";
import {relocationOptions} from "../../scripts/archive-relocation";

const temporary:string[]=[];
afterEach(()=>{
  Bun.gc(true);
  for(const root of temporary.splice(0)) {
    if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith("tokenatlas-sync-test-"))throw new Error("Unsafe fixture cleanup path");
    removeTestFixture(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
});
async function fixture() {
  const created=createTestDatabase();temporary.push(created.directory);
  const source=path.join(created.directory,"source"),destination=path.join(created.directory,"destination"),stateDirectory=path.join(created.directory,"jobs");
  fs.mkdirSync(path.join(source,"data"),{recursive:true});
  fs.writeFileSync(path.join(source,"data","evidence.jsonl"),'original evidence\n');
  const archiveId=ensureArchiveIdentity(source);
  const db=new Database(created.dbPath);
  try {db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");db.query("INSERT INTO meta VALUES('archive:identity',?)").run(archiveId);}
  finally {db.close(true);}
  const env={...process.env,TOKENATLAS_LOCAL_STATE:path.join(created.directory,"local"),TOKENATLAS_DB:created.dbPath,
    TOKENATLAS_ARCHIVE:undefined,TOKENATLAS_CONFIG:undefined,TOKENATLAS_STORE_ASUS:undefined,TOKENATLAS_STORE_HUB:undefined,
    TOKENATLAS_STORE_LIVE:undefined,TOKENATLAS_STORE_DESKTOP:undefined};
  const run=async(args:string[])=>{
    const proc=Bun.spawn([process.execPath,"--no-env-file",...args],{env,stdout:"pipe",stderr:"pipe"});
    const watchdog=setTimeout(()=>proc.kill(),20000);
    const [exit,stdout,stderr]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]).finally(()=>clearTimeout(watchdog));
    expect({exit,stderr}).toEqual({exit:0,stderr:""});return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  };
  const activated=await run([path.join(import.meta.dir,"archive-relocation-verification-worker.ts"),"activate",source,destination,stateDirectory,created.dbPath,archiveId]);
  const jobId=activated.state.jobId as string;
  const cli=(command:string,...extra:string[])=>run([path.join(import.meta.dir,"../../scripts/archive-relocation.ts"),command,"--job",jobId,"--state-dir",stateDirectory,...extra]);
  return {...created,source,destination,stateDirectory,env,jobId,cli};
}
async function local<T>(env:Record<string,string|undefined>,work:()=>Promise<T>):Promise<T> {
  const previous=process.env.TOKENATLAS_LOCAL_STATE;process.env.TOKENATLAS_LOCAL_STATE=env.TOKENATLAS_LOCAL_STATE;
  try{return await work();}finally{if(previous===undefined)delete process.env.TOKENATLAS_LOCAL_STATE;else process.env.TOKENATLAS_LOCAL_STATE=previous;}
}

test("cleanup proposal requires real restart receipt, persists bounded pages and never approves or removes files",async()=>{
  const f=await fixture();
  await expect(prepareArchiveCleanupPlan(f.jobId,{stateDirectory:f.stateDirectory,env:f.env})).rejects.toThrow("verification is required");
  const verified=await f.cli("verify");expect(verified.readWriteVerified).toBe(true);
  const foreign=path.join(f.source,"foreign.txt");fs.writeFileSync(foreign,"not part of relocation");
  await local(f.env,async()=>{
    const first=await prepareArchiveCleanupPlan(f.jobId,{stateDirectory:f.stateDirectory,env:f.env,maxFiles:1});
    expect(first.files).toHaveLength(1);expect(first.next).toBeString();
    expect(first.deletionAuthorized).toBe(false);
    expect(first.blockingReasons).toContain("other-machines-and-jobs-not-confirmed");
    expect(JSON.parse(fs.readFileSync(first.reportFile,"utf8"))).toEqual(first);
    const remaining=await prepareArchiveCleanupPlan(f.jobId,{stateDirectory:f.stateDirectory,env:f.env,after:first.next!});
    expect(remaining.next).toBeNull();
    expect([...first.files,...remaining.files].map(file=>file.relative)).not.toContain("foreign.txt");
    expect(remaining.files.every(file=>file.matchingCopies)).toBe(true);
    await expect(prepareArchiveCleanupPlan(f.jobId,{stateDirectory:f.stateDirectory,env:f.env,after:`${"0".repeat(64)}:1`})).rejects.toThrow("checkpoint");
    const budget=await prepareArchiveCleanupPlan(f.jobId,{stateDirectory:f.stateDirectory,env:f.env,maxBytes:1});
    expect(budget.files.some(file=>file.source.status==="deferred-budget")).toBe(true);
    expect(budget.deletionAuthorized).toBe(false);
  });
  const cliPage=await f.cli("cleanup-plan");expect(cliPage.deletionAuthorized).toBe(false);
  expect(fs.readFileSync(foreign,"utf8")).toBe("not part of relocation");
  expect(fs.readFileSync(path.join(f.source,"data","evidence.jsonl"),"utf8")).toBe("original evidence\n");
},60000);

test("cleanup reports changed copies and refuses path aliases without reading foreign content",async()=>{
  const f=await fixture();await f.cli("verify");
  await local(f.env,async()=>{
    fs.writeFileSync(path.join(f.source,"data","evidence.jsonl"),"changed source\n");
    const changed=await prepareArchiveCleanupPlan(f.jobId,{stateDirectory:f.stateDirectory,env:f.env});
    expect(changed.files.find(file=>file.relative==="data/evidence.jsonl")!.source.status).toBe("changed");
    expect(changed.blockingReasons).toContain("recorded-copies-differ-or-are-unavailable");
    const moved=path.join(f.directory,"foreign-directory");fs.renameSync(path.join(f.source,"data"),moved);
    fs.symlinkSync(moved,path.join(f.source,"data"),process.platform==="win32"?"junction":"dir");
    const aliased=await prepareArchiveCleanupPlan(f.jobId,{stateDirectory:f.stateDirectory,env:f.env});
    expect(aliased.files.find(file=>file.relative==="data/evidence.jsonl")!.source.status).toBe("unsafe-path");
    expect(fs.readFileSync(path.join(moved,"evidence.jsonl"),"utf8")).toBe("changed source\n");
  });
},60000);

test("cleanup checkpoint is restricted to its CLI command",()=>{
  expect(relocationOptions(["cleanup-plan","--job","test","--state-dir",os.tmpdir(),"--after","checkpoint"]).after).toBe("checkpoint");
  expect(()=>relocationOptions(["verify","--job","test","--state-dir",os.tmpdir(),"--after","checkpoint"])).toThrow("only valid");
});
