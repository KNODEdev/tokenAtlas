import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { ensureCodexSchema } from "../ingest/codex";
import { createTestDatabase } from "./test-support";
import { ensureArchiveIdentity } from "./archive-inventory";
import { SyncFileQueue, type SyncFileRoot } from "./file-queue";
import { removeTestFixture } from "../test-cleanup";

test("the production runner resumes a dead mirror process without reselecting completed originals", async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-mirror-resume-")),created=createTestDatabase();
  let reference:ReturnType<typeof createTestDatabase>|undefined;
  const home=path.join(root,"profiles","fixture"),archive=path.join(root,"archive"),config=path.join(root,"config"),state=path.join(root,"state");
  const source=path.join(home,".codex","sessions"),retained=path.join(archive,"codex","PC","sessions");
  const dbPath=created.dbPath;
  const setup=new Database(dbPath);ensureCodexSchema(setup);setup.close();
  for(const folder of [source,archive,config])fs.mkdirSync(folder,{recursive:true});ensureArchiveIdentity(archive);
  fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[],sources:[
    {vendor:"codex",home:path.join(archive,"codex","PC"),source_home:path.join(home,".codex"),machine:"fixture-pc"}]}));
  const line=(value:unknown)=>JSON.stringify(value)+"\n";
  const usage=(session:string,id:string,tokens:number,minute:number)=>line({timestamp:`2026-09-08T00:0${minute}:00Z`,type:"token_usage_record",
    payload:{thread_id:session,response_id:id,usage:{input_tokens:tokens,cached_input_tokens:2,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:1}}});
  const content=(session:string,tokens:number,minute:number)=>line({type:"session_meta",payload:{id:session,originator:"Codex Desktop",cwd:root}})
    +line({type:"turn_context",payload:{model:"m",service_tier:"default"}})+usage(session,session,tokens,minute);
  const seed=path.join(source,"rollout-0-seed.jsonl"),done=path.join(source,"rollout-1-done.jsonl.zst"),remaining=path.join(source,"rollout-2-pending.jsonl");
  const doneArchive=path.join(retained,path.basename(done));
  const request={trigger:"manual",mode:"incremental",scope:{kind:"vendor",vendor:"codex"}};
  const env={...process.env,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_DB:dbPath,TOKENATLAS_LOCAL_STATE:state,
    TOKENATLAS_TEMP_DIR:path.join(root,"scratch"),TOKENATLAS_FROZEN_CONFIG:"1",TOKENATLAS_MACHINE:"fixture-pc",TOKENATLAS_LOGIN:"fixture",
    USERPROFILE:home,HOME:home,APPDATA:path.join(home,"AppData","Roaming"),LOCALAPPDATA:path.join(home,"AppData","Local")};
  const runner=new URL("./runner.ts",import.meta.url).href,wrapper=path.join(root,"run.ts");
  fs.writeFileSync(wrapper,`import fs from "node:fs";
    if(process.argv[3]==="interrupt"){
      const open=fs.openSync;fs.openSync=(file,...args)=>{
        if(String(file)===${JSON.stringify(remaining)}&&fs.existsSync(${JSON.stringify(doneArchive)}))process.exit(73);
        return Reflect.apply(open,fs,[file,...args]);
      };
    }
    await import(${JSON.stringify(runner)});`);
  const run=async(interrupt=false,selected=dbPath,archiveOnly=false)=>{
    const child=Bun.spawn([process.execPath,wrapper,JSON.stringify({dbPath:selected,rootDir:process.cwd(),
      request:archiveOnly?{...request,mode:"full",collection:"archive"}:request}),interrupt?"interrupt":"normal"],{
      cwd:process.cwd(),env:{...env,TOKENATLAS_DB:selected,...(archiveOnly?{TOKENATLAS_LOCAL_STATE:path.join(root,"reference-state")}:{})},stdout:"pipe",stderr:"pipe"});
    const watchdog=setTimeout(()=>child.kill(),60_000);
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    clearTimeout(watchdog);
    if(interrupt){expect({exit,stderr}).toEqual({exit:73,stderr:""});return null;}
    expect({exit,stderr,stdout}).toMatchObject({exit:0});
    const resultLine=stdout.split(/\r?\n/).find(value=>value.startsWith("TOKENATLAS_SYNC_RESULT:"));
    expect(resultLine).toBeDefined();
    const result=JSON.parse(resultLine!.slice("TOKENATLAS_SYNC_RESULT:".length));
    expect(result.status,JSON.stringify(result.vendors)).toBe("success");return result;
  };
  const rows=(selected=dbPath)=>{const db=new Database(selected,{readonly:true});
    try{return db.query("SELECT * FROM events ORDER BY home,path,source_offset").all() as Array<Record<string,unknown>>;}finally{db.close();}};
  const semantic=(selected=dbPath)=>rows(selected).map(({id,...row})=>row);
  const enqueue=(...files:string[])=>{const queue=new SyncFileQueue(archive,state);
    try{for(const file of files)queue.enqueue(file,"codex");}finally{queue.close();}};
  try{
    fs.writeFileSync(seed,content("seed",100,0));await run();
    const accepted=rows();expect(accepted).toHaveLength(1);
    const completedText=content("completed",110,1);
    fs.writeFileSync(done,Bun.zstdCompressSync(completedText));fs.writeFileSync(remaining,content("pending",120,2));
    enqueue(done,remaining);await run(true);
    expect(rows()).toEqual(accepted);
    const queue=new SyncFileQueue(archive,state);
    const roots:SyncFileRoot[]=[{path:source,vendor:"codex",kind:"source"},{path:path.join(archive,"codex"),vendor:"codex",kind:"archive"}];
    try{
      expect(queue.hasPending("codex",done)).toBe(false);expect(queue.hasPending("codex",doneArchive)).toBe(true);
      const selected=queue.take("codex",roots);
      expect(selected.filter(row=>row.kind==="source").map(row=>row.path)).toEqual([remaining]);
    }finally{queue.close();}
    const resumed=await run();
    expect(resumed.vendors[0].diagnostics.mirror).toMatchObject({copied:1,skipped:0,errors:[]});
    expect(rows()).toHaveLength(3);expect(rows().find(row=>row.path===accepted[0]!.path)).toEqual(accepted[0]);
    const replay=await run();expect(replay.vendors).toEqual([]);
    const pendingQueue=new SyncFileQueue(archive,state);
    try{expect(pendingQueue.hasPending("codex")).toBe(false);}finally{pendingQueue.close();}
    fs.writeFileSync(done,Bun.zstdCompressSync(completedText+usage("completed","appended",130,3)));enqueue(done);await run();
    expect(rows()).toHaveLength(4);expect(rows().find(row=>row.path===accepted[0]!.path)).toEqual(accepted[0]);
    reference=createTestDatabase();const db=new Database(reference.dbPath);ensureCodexSchema(db);db.close();
    await run(false,reference.dbPath,true);
    expect(semantic(reference.dbPath)).toEqual(semantic());
  }finally{
    if(reference)removeTestFixture(reference.directory,{recursive:true,force:true});
    removeTestFixture(created.directory,{recursive:true,force:true});removeTestFixture(root,{recursive:true,force:true});
  }
},180_000);
