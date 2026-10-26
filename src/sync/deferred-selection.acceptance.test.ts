import {expect,test} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Database} from "../db/sqlite";
import {ensureCodexSchema} from "../ingest/codex";
import {createTestDatabase} from "./test-support";
import {ensureArchiveIdentity} from "./archive-inventory";
import {SyncFileQueue} from "./file-queue";
import {removeTestFixture} from "../test-cleanup";

test("the production runner publishes each provider before selecting the next and preserves pending recovery",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"atlas-vendor-selection-"));
  const created=createTestDatabase(),archive=path.join(root,"archive"),state=path.join(root,"state"),config=path.join(root,"config"),home=path.join(root,"home");
  const dbPath=created.dbPath;
  for(const directory of [archive,config,home])fs.mkdirSync(directory,{recursive:true});
  ensureArchiveIdentity(archive);
  fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,subscriptions:[],sources:[]}));
  const setup=new Database(dbPath);ensureCodexSchema(setup);setup.close();
  const codex=path.join(archive,"codex","PC","sessions","rollout-early.jsonl");
  const claude=path.join(archive,"claude","PC","project","late.jsonl");
  fs.mkdirSync(path.dirname(codex),{recursive:true});fs.mkdirSync(path.dirname(claude),{recursive:true});
  const line=(value:unknown)=>JSON.stringify(value)+"\n";
  const usage=(id:string,tokens:number,minute:number)=>line({timestamp:`2026-09-08T00:0${minute}:00Z`,type:"token_usage_record",
    payload:{thread_id:"early",response_id:id,usage:{input_tokens:tokens,cached_input_tokens:2,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:1}}});
  const claudeLine=(id:string,tokens:number)=>line({type:"assistant",sessionId:id,timestamp:"2026-09-08T00:00:00Z",
    message:{id,model:"claude-sonnet",usage:{input_tokens:tokens,output_tokens:1}}});
  fs.writeFileSync(codex,line({type:"session_meta",payload:{id:"early",originator:"Codex Desktop",cwd:root}})
    +line({type:"turn_context",payload:{model:"m",service_tier:"default"}})+usage("seed",100,0));
  fs.writeFileSync(claude,claudeLine("late",10));
  const runner=new URL("./runner.ts",import.meta.url).href,queueModule=new URL("./file-queue.ts",import.meta.url).href;
  const databaseModule=new URL("../db/sqlite.ts",import.meta.url).href,wrapper=path.join(root,"run.ts"),trace=path.join(root,"trace.jsonl");
  fs.writeFileSync(wrapper,`import fs from "node:fs";
    import {SyncFileQueue} from ${JSON.stringify(queueModule)};
    import {Database} from ${JSON.stringify(databaseModule)};
    const take=SyncFileQueue.prototype.take;
    SyncFileQueue.prototype.take=function(vendor,...args){
      const db=new Database(process.env.TOKENATLAS_DB,{readonly:true});
      let codexRows;try{codexRows=db.query("SELECT COUNT(*) n FROM events").get().n;}finally{db.close();}
      fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({vendor,codexRows})+"\\n");
      if(vendor==="claude"&&process.argv[3]==="interrupt")process.exit(73);
      if(vendor==="codex"&&process.argv[3]==="selection-failure")throw new Error("Injected selection failure");
      if(vendor==="claude"&&process.argv[3]==="late-correction"){
        fs.writeFileSync(${JSON.stringify(claude)},${JSON.stringify(claudeLine("late",45))});
        const arrived=${JSON.stringify(path.join(path.dirname(claude),"arrived.jsonl"))};
        fs.writeFileSync(arrived,${JSON.stringify(claudeLine("arrived",55))});
        const queue=new SyncFileQueue(process.env.TOKENATLAS_ARCHIVE,process.env.TOKENATLAS_LOCAL_STATE);
        try{queue.enqueue(arrived,"claude");}finally{queue.close();}
      }
      return Reflect.apply(take,this,[vendor,...args]);
    };
    await import(${JSON.stringify(runner)});`);
  const env={...process.env,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_DB:dbPath,TOKENATLAS_LOCAL_STATE:state,
    TOKENATLAS_TEMP_DIR:path.join(root,"scratch"),TOKENATLAS_FROZEN_CONFIG:"1",TOKENATLAS_MACHINE:"fixture-pc",TOKENATLAS_LOGIN:"fixture",
    USERPROFILE:home,HOME:home,APPDATA:path.join(home,"AppData","Roaming"),LOCALAPPDATA:path.join(home,"AppData","Local")};
  const request={trigger:"manual",mode:"incremental",collection:"archive",scope:{kind:"vendors",vendors:["codex","claude"]}};
  const run=async(mode="normal",selected=dbPath,full=false)=>{
    fs.writeFileSync(trace,"");
    const child=Bun.spawn([process.execPath,wrapper,JSON.stringify({dbPath:selected,rootDir:process.cwd(),request:full?{...request,mode:"full"}:request}),mode],{
      cwd:process.cwd(),env:{...env,TOKENATLAS_DB:selected,...(full?{TOKENATLAS_LOCAL_STATE:path.join(root,"reference-state")}:{})},stdout:"pipe",stderr:"pipe"});
    const watchdog=setTimeout(()=>child.kill(),60_000);
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(watchdog);
    if(mode==="interrupt"){expect({exit,stderr}).toEqual({exit:73,stderr:""});return null;}
    expect({exit,stderr,stdout}).toMatchObject({exit:0});
    const result=stdout.split(/\r?\n/).find(value=>value.startsWith("TOKENATLAS_SYNC_RESULT:"));expect(result).toBeDefined();
    return JSON.parse(result!.slice("TOKENATLAS_SYNC_RESULT:".length));
  };
  const hints=(...files:string[])=>{const queue=new SyncFileQueue(archive,state);
    try{for(const file of files)queue.enqueue(file,file===codex?"codex":"claude");}finally{queue.close();}};
  const readTrace=()=>fs.readFileSync(trace,"utf8").trim().split("\n").filter(Boolean).map(row=>JSON.parse(row));
  const rows=(selected=dbPath)=>{const db=new Database(selected,{readonly:true});try{return {
    codex:db.query("SELECT * FROM events ORDER BY home,path,source_offset").all() as Array<Record<string,unknown>>,
    claude:db.query("SELECT * FROM claude_events ORDER BY store,call_id").all() as Array<Record<string,unknown>>,
  };}finally{db.close();}};
  let reference:ReturnType<typeof createTestDatabase>|undefined;
  try {
    expect((await run()).status).toBe("success");
    fs.appendFileSync(codex,usage("next",110,1));
    const peers=Array.from({length:80},(_,index)=>{const file=path.join(path.dirname(claude),`peer-${index}.jsonl`);fs.writeFileSync(file,claudeLine(`peer-${index}`,index+20));return file;});
    hints(codex,...peers);
    const changed=await run();expect(changed.status).toBe("success");
    expect(readTrace()).toEqual([{vendor:"codex",codexRows:1},{vendor:"claude",codexRows:2}]);
    expect(changed.vendors.map((vendor:any)=>vendor.vendor)).toEqual(["codex","claude"]);
    for(const vendor of changed.vendors)expect(vendor.timings.steps.queueSelectionMs).toBeGreaterThanOrEqual(0);
    const unchangedRows=rows();hints(codex,claude);
    const noChange=await run();expect(noChange.afterRevisions).toEqual(changed.afterRevisions);expect(rows()).toEqual(unchangedRows);
    expect(noChange.vendors).toEqual([]);
    fs.appendFileSync(codex,usage("before-crash",120,2));fs.writeFileSync(claude,claudeLine("late",30));hints(codex,claude);
    await run("interrupt");expect(rows().codex).toHaveLength(3);expect(rows().claude.find(row=>row.call_id==="late")!.in_uncached).toBe(10);
    const pending=new SyncFileQueue(archive,state);try{expect(pending.hasPending("codex")).toBe(false);expect(pending.hasPending("claude",claude)).toBe(true);}finally{pending.close();}
    const restarted=await run();expect(restarted.status).toBe("success");expect(readTrace()).toEqual([{vendor:"claude",codexRows:3}]);
    expect(rows().claude.find(row=>row.call_id==="late")!.in_uncached).toBe(30);
    fs.appendFileSync(codex,usage("after-failure",130,3));fs.writeFileSync(claude,claudeLine("late",40));hints(codex,claude);
    const partial=await run("selection-failure");expect(partial.status).toBe("partial_success");
    expect(partial.vendors[0].error).toBe("Injected selection failure");expect(rows().codex).toHaveLength(3);
    expect(rows().claude.find(row=>row.call_id==="late")!.in_uncached).toBe(40);
    expect((await run()).status).toBe("success");expect(rows().codex).toHaveLength(4);
    hints(claude);const reconcile=new SyncFileQueue(archive,state);try{reconcile.reconcileLater();}finally{reconcile.close();}
    expect((await run("late-correction")).status).toBe("success");
    expect(rows().claude.find(row=>row.call_id==="late")!.in_uncached).toBe(45);
    expect(rows().claude.find(row=>row.call_id==="arrived")!.in_uncached).toBe(55);
    fs.appendFileSync(codex,usage("before-missing",140,4));fs.unlinkSync(claude);hints(codex,claude);
    expect((await run()).status).toBe("partial_success");expect(rows().codex).toHaveLength(5);
    expect(rows().claude.find(row=>row.call_id==="late")!.in_uncached).toBe(45);
    fs.writeFileSync(claude,claudeLine("late",46));hints(claude);expect((await run()).status).toBe("success");
    const saved=rows();expect((await run()).vendors).toEqual([]);expect(rows()).toEqual(saved);
    reference=createTestDatabase();const db=new Database(reference.dbPath);ensureCodexSchema(db);db.close();
    expect((await run("normal",reference.dbPath,true)).status).toBe("success");
    const semantic=(value:ReturnType<typeof rows>)=>({codex:value.codex.map(({id,...row})=>row),claude:value.claude.map(({id,...row})=>row)});
    expect(semantic(rows(reference.dbPath))).toEqual(semantic(saved));
  }finally{
    if(reference)removeTestFixture(reference.directory,{recursive:true,force:true});
    removeTestFixture(created.directory,{recursive:true,force:true});removeTestFixture(root,{recursive:true,force:true});
  }
},180_000);
