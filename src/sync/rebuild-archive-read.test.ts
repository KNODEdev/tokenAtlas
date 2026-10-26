import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { createCodexSchema, createTestDatabase } from "./test-support";
import { subscriptionEventFromRow, subscriptionAccountingAdapter } from "../server/subscription-accounting-adapters";
import { buildAccountResolver } from "../server/account-resolver";

const dirs:string[]=[];
afterEach(()=>{Bun.gc(true);for(const dir of dirs.splice(0))removeTestFixture(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});

const claudeLine=(id:string,timestamp:string,input:number,output=1)=>JSON.stringify({type:"assistant",sessionId:"session",timestamp,
  message:{id,model:"claude-sonnet",usage:{input_tokens:input,output_tokens:output}}})+"\n";
const codexUsage=(timestamp:string,input:number)=>JSON.stringify({timestamp,type:"event_msg",
  payload:{type:"token_count",info:{last_token_usage:{input_tokens:input,output_tokens:1}}}})+"\n";

function fixture() {
  const f=createTestDatabase();dirs.push(f.directory);
  createCodexSchema(f.dbPath);
  const archiveRoot=path.join(f.directory,"archive"),config=path.join(f.directory,"config");
  fs.mkdirSync(archiveRoot);fs.mkdirSync(config);
  const file=path.join(archiveRoot,"claude","PC-user","project","session.jsonl");fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,claudeLine("call","2026-01-10T10:00:00Z",12,5));
  const codexHome=path.join(archiveRoot,"codex","PC-user"),codexPath=path.join(codexHome,"sessions","rollout.jsonl");fs.mkdirSync(path.dirname(codexPath),{recursive:true});
  fs.writeFileSync(codexPath,[{type:"session_meta",payload:{originator:"codex-tui",thread_source:"user",cwd:"C:/fixture"}},
    {type:"turn_context",payload:{model:"gpt-test",effort:"high",cwd:"C:/fixture"}}].map(row=>JSON.stringify(row)).join("\n")+"\n"
    +codexUsage("2026-01-10T10:00:00Z",7));
  fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify({version:2,
    subscriptions:[{id:"claude",vendor:"claude"},{id:"codex",vendor:"codex"}],
    sources:[{vendor:"claude",home:path.join(archiveRoot,"claude","PC-user")},{vendor:"codex",home:codexHome}]}));
  fs.writeFileSync(path.join(config,"projects.json"),'{"projects":[]}');fs.writeFileSync(path.join(config,"rate-cards.json"),'{"vendors":{}}');
  const request={trigger:"manual",scope:{kind:"all"},mode:"incremental",reparse:{},rebuildGeneration:1,collection:"archive"} as const;
  // No provider folders exist: every read must come from the archive.
  const env={TOKENATLAS_ARCHIVE:archiveRoot,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(f.directory,"local"),
    TOKENATLAS_TEMP_DIR:path.join(f.directory,"temp"),USERPROFILE:path.join(f.directory,"absent-home"),HOME:path.join(f.directory,"absent-home")};
  return {...f,archiveRoot,config,file,request,codexHome,codexPath,env};
}
type Fixture=ReturnType<typeof fixture>;

async function runChild(cmd:string[],env:Record<string,string>):Promise<string> {
  const proc=Bun.spawn({cmd,cwd:process.cwd(),env:{...process.env,...env},stdout:"pipe",stderr:"pipe"});
  const watchdog=setTimeout(()=>proc.kill(),90_000);
  const [exit,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()])
    .finally(()=>clearTimeout(watchdog));
  if(exit!==0)throw new Error(`child exited ${exit}: ${err}`);
  return out;
}
const tagged=(out:string,tag:string)=>JSON.parse(out.split(/\r?\n/).find(line=>line.startsWith(tag))!.slice(tag.length));
type VendorOutcome={vendor:string;status:string;error:string|null;startedAt:string;processedInputs:number;
  inputsComplete?:boolean;diagnostics:{reparse?:{unavailable?:Array<Record<string,unknown>>}}};
const unavailable=(result:RunResult,vendor:string)=>result.vendors.find(entry=>entry.vendor===vendor)!.diagnostics.reparse?.unavailable??[];
type RunResult={status:string;error:string|null;vendors:VendorOutcome[]};

/** The production runner, exactly as the server starts a rebuild's source phase. */
async function rebuild(f:Fixture,request:Record<string,unknown>=f.request):Promise<RunResult> {
  const out=await runChild([process.execPath,path.join(import.meta.dir,"runner.ts"),JSON.stringify({dbPath:f.dbPath,rootDir:process.cwd(),request})],f.env);
  return tagged(out,"TOKENATLAS_SYNC_RESULT:");
}

/**
 * Ordinary incremental reads of the fixture with the real Claude and Codex parsers. `--append` appends to
 * each source right before the rebuild publishes that vendor, i.e. after the rebuild has read it.
 * Vendors are read and published one after another: Codex first, then Claude.
 */
function syncScript(f:Fixture):string {
  const script=path.join(f.directory,"sync-child.ts");
  fs.writeFileSync(script,`
    import fs from "node:fs";
    import { SyncCoordinator } from ${JSON.stringify(path.join(import.meta.dir,"coordinator.ts"))};
    import { noMirror, successfulNoop } from ${JSON.stringify(path.join(import.meta.dir,"test-support.ts"))};
    import { createProductionAdapters } from ${JSON.stringify(path.join(import.meta.dir,"adapters.ts"))};
    const absent=async()=>successfulNoop();
    const append=process.argv.includes("--append");
    let published=0;
    const instance=new SyncCoordinator({dbPath:process.argv[2]!,rootDir:process.argv[3]!,mirror:noMirror,
      adapters:{...createProductionAdapters(),opencode:absent,grok:absent,gemini:absent,gauges:absent},
      beforeIncrementalPublish:()=>{
        if(!append)return;
        if(++published===1)fs.appendFileSync(${JSON.stringify(f.codexPath)},${JSON.stringify(codexUsage("2026-01-15T10:00:00Z",40))});
        if(published===2)fs.appendFileSync(${JSON.stringify(f.file)},${JSON.stringify(claudeLine("later","2026-01-15T10:00:00Z",30,9))});
      }});
    try {
      const initialize=process.argv.includes("--initialize");
      const request=process.argv.includes("--rebuild")
        ? ${JSON.stringify(f.request)}
        : {trigger:"manual",scope:{kind:"all"},mode:initialize?"full":"incremental"};
      const result=await instance.enter(request).completion;
      console.log("TOKENATLAS_CHILD:"+JSON.stringify({status:result.status,error:result.error,
        vendors:Object.fromEntries(result.vendors.map(v=>[v.vendor,{status:v.status,error:v.error,processed:v.processedInputs,skipped:v.skippedInputs}]))}));
    } finally {instance.close();}
  `);
  return script;
}
async function child(f:Fixture,...flags:string[]) {
  return tagged(await runChild([process.execPath,syncScript(f),f.dbPath,process.cwd(),...flags],f.env),"TOKENATLAS_CHILD:");
}
function state(f:Fixture) {
  const db=new Database(f.dbPath,{readonly:true});
  try {return {
    claudeBookmark:db.query("SELECT * FROM claude_files").get() as Record<string,unknown>|null,
    claudeEvents:db.query("SELECT call_id,path,in_uncached FROM claude_events ORDER BY call_id").all(),
    codexBookmark:db.query("SELECT * FROM files").get() as Record<string,unknown>|null,
    codexEvents:db.query("SELECT ts,path,in_tok FROM events ORDER BY ts").all(),
  };} finally {db.close(true);}
}
function filesUnder(root:string):string[] {
  if(!fs.existsSync(root))return [];
  return fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())
    .map(entry=>path.join(entry.parentPath,entry.name));
}

test("a rebuild restores an empty index by reading the archive in place and copies no source bytes",async()=>{
  const f=fixture();
  // A reference left by the retired copying rebuild names a copy that no longer exists.
  const legacy=new Database(f.dbPath);
  legacy.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  legacy.query("INSERT INTO meta VALUES('rebuild_frozen_input:1',?)").run(JSON.stringify({manifestId:"deleted-copy",changeCursor:0,
    archiveRoot:f.archiveRoot,inventoryStateRoot:path.join(f.directory,"sync-staging","archive-jobs")}));
  legacy.close(true);
  const first=await rebuild(f);
  expect({status:first.status,error:first.error}).toEqual({status:"success",error:null});
  // Facts keep the archive paths they came from.
  expect(state(f).claudeEvents).toEqual([{call_id:"call",path:f.file,in_uncached:12}]);
  expect(state(f).codexEvents).toEqual([{ts:"2026-01-10T10:00:00.000Z",path:f.codexPath,in_tok:7}]);
  expect(state(f).claudeBookmark).toMatchObject({path:f.file,size:fs.statSync(f.file).size});
  expect(state(f).codexBookmark).toMatchObject({path:f.codexPath,size:fs.statSync(f.codexPath).size});
  // Nothing outside the archive holds a source file: no copy store, no leftover stage input.
  const sources=new Set([path.basename(f.file),path.basename(f.codexPath)]);
  expect(filesUnder(f.directory).filter(file=>!file.startsWith(f.archiveRoot+path.sep)&&sources.has(path.basename(file)))).toEqual([]);
  expect(fs.existsSync(path.join(f.directory,"sync-staging","archive-jobs"))).toBe(false);
  // Repeating the generation neither duplicates nor loses facts.
  const second=await rebuild(f);
  expect(second.status).toBe("success");
  expect(state(f).claudeEvents).toHaveLength(1);
  expect(state(f).codexEvents).toHaveLength(1);
},120000);

test("a missing archive file is reported by path, keeps its facts, and the same generation completes after restore",async()=>{
  const f=fixture();
  await child(f,"--initialize");
  const accepted=state(f);
  const original=fs.readFileSync(f.file);
  fs.unlinkSync(f.file);
  const first=await rebuild(f);
  const claude=first.vendors.find(vendor=>vendor.vendor==="claude")!;
  // The source phase reports the gap; the server turns it into the rebuild's error (api.ts).
  expect(unavailable(first,"claude")).toEqual([{store:"live",path:f.file}]);
  expect(claude.inputsComplete).toBe(false);
  // The previously recognised facts and their reading position stand.
  expect(state(f).claudeEvents).toEqual(accepted.claudeEvents);
  expect(state(f).claudeBookmark).toEqual(accepted.claudeBookmark);
  const codex=first.vendors.find(vendor=>vendor.vendor==="codex")!;
  expect(codex.status).toBe("success");
  fs.writeFileSync(f.file,original);
  // The same generation after a restart: the complete vendor is not read again, the gap is.
  const resumed=await rebuild(f);
  expect({status:resumed.status,error:resumed.error}).toEqual({status:"success",error:null});
  expect(unavailable(resumed,"claude")).toEqual([]);
  expect(resumed.vendors.find(vendor=>vendor.vendor==="claude")!.startedAt).not.toBe(claude.startedAt);
  expect(resumed.vendors.find(vendor=>vendor.vendor==="codex")!.startedAt).toBe(codex.startedAt);
  expect(state(f).claudeEvents).toEqual(accepted.claudeEvents);
},180000);

test("a registered source outside the archive is refused and never read from its original folder",async()=>{
  const f=fixture();
  const original=path.join(f.directory,"provider","projects","old.jsonl");
  fs.mkdirSync(path.dirname(original),{recursive:true});
  fs.writeFileSync(original,claudeLine("original","2026-01-11T10:00:00Z",99));
  // Registered by an index built before the archive existed.
  const db=new Database(f.dbPath);
  db.query("INSERT INTO claude_events(store,call_id,ts,path,in_uncached,out_total) VALUES('live','original','2026-01-11T10:00:00Z',?,3,1)").run(original);
  db.query("INSERT INTO claude_files(store,path,size,mtime,ingested_at) VALUES('live',?,1,1,'2026-01-11T10:00:00Z')").run(original);
  db.close(true);
  const result=await rebuild(f,{...f.request,scope:{kind:"vendor",vendor:"claude"}});
  const claude=result.vendors.find(vendor=>vendor.vendor==="claude")!;
  expect(claude.status).toBe("failure");
  expect(claude.error).toContain("Source was not reread; previous data kept");
  expect(claude.error).toContain("old.jsonl");
  const check=new Database(f.dbPath,{readonly:true});
  try {expect(check.query("SELECT call_id,in_uncached FROM claude_events").all()).toEqual([{call_id:"original",in_uncached:3}]);}
  finally {check.close(true);}
},120000);

test("only the selected vendors and dates require their archive files",async()=>{
  const f=fixture();const march=path.join(path.dirname(f.file),"march.jsonl");
  const db=new Database(f.dbPath);
  const insert=db.query("INSERT INTO claude_events(store,call_id,ts,path,in_uncached) VALUES('live',?,?,?,?)");
  insert.run("call","2026-01-10T10:00:00Z",f.file,12);insert.run("march","2026-03-02T10:00:00Z",march,4);
  const register=db.query("INSERT INTO claude_files(store,path,size,mtime,ingested_at) VALUES('live',?,1,1,'2026-03-02T10:00:00Z')");
  register.run(f.file);register.run(march);
  db.close(true);
  // march.jsonl is registered but not in the archive; only a scope that covers it may demand it.
  const january=await rebuild(f,{...f.request,scope:{kind:"vendor",vendor:"claude"},reparse:{from:"2026-01-01",until:"2026-01-31"}});
  expect({status:january.status,error:january.error}).toEqual({status:"success",error:null});
  const codex=await rebuild(f,{...f.request,scope:{kind:"vendor",vendor:"codex"},rebuildGeneration:2});
  expect({status:codex.status,error:codex.error}).toEqual({status:"success",error:null});
  expect(unavailable(january,"claude")).toEqual([]);
  const whole=await rebuild(f,{...f.request,scope:{kind:"vendor",vendor:"claude"},rebuildGeneration:3});
  expect(unavailable(whole,"claude")).toEqual([{store:"live",path:march}]);
  const check=new Database(f.dbPath,{readonly:true});
  try {expect(check.query("SELECT call_id,in_uncached FROM claude_events WHERE call_id='march'").get()).toEqual({call_id:"march",in_uncached:4});}
  finally {check.close(true);}
},180000);

test("a file appended while the rebuild runs is read as it was, and the next ordinary sync reads the rest once",async()=>{
  const f=fixture();
  await child(f,"--initialize");
  const before={claude:fs.statSync(f.file).size,codex:fs.statSync(f.codexPath).size};
  const rebuilt=await child(f,"--rebuild","--append");
  expect({status:rebuilt.status,error:rebuilt.error}).toEqual({status:"success",error:null});
  expect(fs.statSync(f.file).size).toBeGreaterThan(before.claude);
  expect(fs.statSync(f.codexPath).size).toBeGreaterThan(before.codex);
  // The published position describes the bytes the rebuild read, not the grown file.
  expect(state(f).claudeBookmark).toMatchObject({size:before.claude});
  expect(state(f).codexBookmark).toMatchObject({size:before.codex});
  expect(state(f).claudeEvents).toEqual([{call_id:"call",path:f.file,in_uncached:12}]);
  const ordinary=await child(f);
  expect(ordinary.vendors.claude).toMatchObject({status:"success",processed:1});
  expect(ordinary.vendors.codex).toMatchObject({status:"success",processed:1});
  const after=state(f);
  expect(after.claudeEvents).toEqual([{call_id:"call",path:f.file,in_uncached:12},{call_id:"later",path:f.file,in_uncached:30}]);
  expect(after.codexEvents).toEqual([{ts:"2026-01-10T10:00:00.000Z",path:f.codexPath,in_tok:7},{ts:"2026-01-15T10:00:00.000Z",path:f.codexPath,in_tok:40}]);
  expect(after.claudeBookmark).toMatchObject({size:fs.statSync(f.file).size});
  // Nothing is left to read, so nothing can be counted twice.
  const reopened=await child(f);
  expect(reopened.status).toBe("success");
  for(const vendor of ["claude","codex"])expect(reopened.vendors[vendor]?.processed??0).toBe(0);
  expect(state(f)).toEqual(after);
},180000);

test("completed source progress survives a rebuild and unchanged sources are not read again",async()=>{
  const f=fixture();
  await child(f,"--initialize");
  const accepted=state(f);
  expect(accepted.claudeEvents).toEqual([{call_id:"call",path:f.file,in_uncached:12}]);
  expect(accepted.codexBookmark).toMatchObject({events:1});
  const result=await rebuild(f);
  expect({status:result.status,error:result.error}).toEqual({status:"success",error:null});
  // The same bytes give the same position, including the exact REAL mtime and the codex resume context;
  // only the time of reading is new.
  const published=state(f);
  const readAt=(value:ReturnType<typeof state>)=>({...value,claudeBookmark:{...value.claudeBookmark,ingested_at:"read"}});
  expect(readAt(published)).toEqual(readAt(accepted));
  const reopened=await child(f);
  expect(reopened.vendors.claude).toMatchObject({status:"success",processed:0,skipped:1});
  expect(reopened.vendors.codex).toMatchObject({status:"success",processed:0});
  expect(state(f)).toEqual(published);
},180000);

for (const noUsage of [false,true]) test(`a rebuild of an empty index establishes reading positions the next ordinary sync accepts (no usage: ${noUsage})`,async()=>{
  const f=fixture();
  if(noUsage) fs.writeFileSync(f.codexPath, JSON.stringify({type:"message",content:"synthetic old-format record"})+"\n");
  const result=await rebuild(f);
  expect({status:result.status,error:result.error}).toEqual({status:"success",error:null});
  const published=state(f);
  expect(published.claudeEvents).toEqual([{call_id:"call",path:f.file,in_uncached:12}]);
  expect(published.codexEvents).toEqual(noUsage ? [] : [{ts:"2026-01-10T10:00:00.000Z",path:f.codexPath,in_tok:7}]);
  // The bookmark keeps the file's time in seconds; the skip rule compares within 1 µs.
  expect(Math.abs(Number(published.codexBookmark!.mtime) - fs.statSync(f.codexPath).mtimeMs / 1000)).toBeLessThan(1e-6);
  expect(published.codexBookmark!.offset).toBe(noUsage ? 0 : fs.statSync(f.codexPath).size);
  const ordinary=await child(f);
  expect(ordinary.vendors.claude).toMatchObject({status:"success",processed:0,skipped:1});
  expect(ordinary.vendors.codex).toMatchObject({status:"success",processed:0});
  expect(state(f)).toEqual(published);
},180000);

test("collection before an archive rebuild copies originals into the archive; an archive rebuild does not collect",async()=>{
  const {SyncCoordinator}=await import("./coordinator");
  const {adaptersWith}=await import("./test-support");
  const f=createTestDatabase();dirs.push(f.directory);
  const collected:string[]=[];
  const coordinator=new SyncCoordinator({dbPath:f.dbPath,rootDir:f.directory,adapters:adaptersWith({}),
    sourceFingerprint:()=>"unchanged",configFingerprint:()=>"config",refreshDerived:()=>{},
    mirror:async vendor=>{collected.push(vendor);return {copied:0,skipped:0,warnings:[],errors:[]};}});
  try {
    const base={trigger:"manual",scope:{kind:"vendor",vendor:"claude"},mode:"incremental",reparse:{}} as const;
    expect((await coordinator.enter({...base,rebuildGeneration:1,collection:"archive"}).completion).status).toBe("success");
    expect(collected).toEqual([]);
    expect((await coordinator.enter({...base,rebuildGeneration:2,collection:"collect-archive"}).completion).status).toBe("success");
    expect(collected).toEqual(["claude"]);
  } finally {coordinator.close();}
},30000);

test("unmapped Gemini SQLite in the archive keeps its source without an account period",async()=>{
  const f=fixture();const conversation=path.join(f.archiveRoot,"gemini","unmapped","conversations","one.db");fs.mkdirSync(path.dirname(conversation),{recursive:true});
  const source=new Database(conversation);source.exec("CREATE TABLE gen_metadata(idx INTEGER,data BLOB)");source.query("INSERT INTO gen_metadata VALUES(0,?)").run(new Uint8Array([10,4,34,2,16,123]));source.close(true);
  const result=await rebuild(f);
  expect(result.vendors.find(vendor=>vendor.vendor==="gemini")!.status).toBe("success");
  // The shared archive gains no SQLite sidecars from the read.
  for(const suffix of ["-wal","-shm"])expect(fs.existsSync(conversation+suffix)).toBe(false);
  const check=new Database(f.dbPath,{readonly:true});try{
    const row=check.query("SELECT * FROM gemini_events").get() as Record<string,string|number|null>;
    expect(row).toMatchObject({store:"source:gemini:unmapped",fresh_in:123});
    const event=subscriptionEventFromRow(subscriptionAccountingAdapter("gemini"),row,f.archiveRoot)!;
    expect(event.source).toBe("gemini/unmapped");
    expect(event.account).toBeNull();
    expect(buildAccountResolver([]).resolve("gemini",event.source,event.account_key,event.ts).account).toBeNull();
  }finally{check.close();}
},120000);

test("Grok events and bookmarks keep logical source paths when read through another physical root", async()=>{
  const {ingestGrokAsync}=await import("../ingest/grok");
  const f=createTestDatabase();dirs.push(f.directory);
  const physical=path.join(f.directory,"physical"),logical=path.join(f.directory,"logical"),relative="grok/profile/sessions/C%3A%2Fwork/session/updates.jsonl";
  const file=path.join(physical,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({params:{sessionId:"same-session",_meta:{agentTimestampMs:Date.parse("2026-01-10T10:00:00Z")},update:{prompt_id:"p1",usage:{modelUsage:{"grok-code":{inputTokens:9,outputTokens:3}}}}}})+"\n");
  const options={atlasPath:f.dbPath,force:true,logicalPath:(source:string)=>path.join(logical,path.relative(physical,source))};
  (await ingestGrokAsync(path.join(physical,"grok/profile/sessions"),"grok",options));(await ingestGrokAsync(path.join(physical,"grok/profile/sessions"),"grok",options));
  const db=new Database(f.dbPath);try{expect(db.query("SELECT store,path,in_tok FROM grok_events").all()).toEqual([{store:"grok",path:path.join(logical,relative),in_tok:9}]);expect(db.query("SELECT path FROM grok_files").all()).toEqual([{path:path.join(logical,relative)}]);}finally{db.close(true);}
},30000);
