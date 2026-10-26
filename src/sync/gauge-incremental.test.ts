import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createTestDatabase, emptyAccountsDocument } from "./test-support";
import { removeTestFixture } from "../test-cleanup";

test("a sparse gauge stage resolves an appended compact reference from an earlier run", async () => {
  const f = createTestDatabase();
  const archive = path.join(f.directory, "archive"), config = path.join(f.directory, "config");
  fs.mkdirSync(config); fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify(emptyAccountsDocument()));
  const module = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  const script = path.join(f.directory, "compact-gauge-queue.ts");
  fs.writeFileSync(script, `
    import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
    import { Database } from ${module("../db/sqlite.ts")};
    import { SyncCoordinator } from ${module("./coordinator.ts")};
    import { SyncFileQueue } from ${module("./file-queue.ts")};
    import { syncFileRoots } from ${module("./mirror.ts")};
    import { createProbeCollection } from ${module("../db/probe-facts.ts")};
    import { compactProbeLine } from ${module("../providers/core/journal-compact.ts")};
    const archive=process.env.TOKENATLAS_ARCHIVE!, dbPath=process.env.TOKENATLAS_DB!;
    const file=path.join(archive,"gauges","target","probe_windows.2026-09-21.jsonl");
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const row={provider:"codex",subject:"target",ts:"2026-09-21T10:00:00Z",kind:"primary",reported_percent_side:"used",used_percent:42,window_minutes:300,machine:"fixture",ok:1};
    const base=createProbeCollection([row])[0]!, next=createProbeCollection([{...row,ts:"2026-09-21T10:01:00Z",used_percent:43}])[0]!;
    const first=compactProbeLine(crypto.randomUUID(),base,null).line+"\\n";
    const reference=compactProbeLine(crypto.randomUUID(),next,base); assert.equal(reference.full,false);
    fs.writeFileSync(file,first);
    let initial=-1, after=-1;
    const run=async()=>{const coordinator=new SyncCoordinator({dbPath,rootDir:process.cwd(),refreshDerived:()=>{}});
      const gauge=coordinator.adapters.gauges;
      coordinator.adapters.gauges=async context=>{
        const before=new Database(context.stageDbPath,{readonly:true});
        initial=(before.query("SELECT count(*) n FROM probe_counters").get() as {n:number}).n; before.close();
        const result=await gauge(context);
        const stage=new Database(context.stageDbPath,{readonly:true});
        after=(stage.query("SELECT count(*) n FROM probe_counters").get() as {n:number}).n; stage.close(); return result;
      };
      try{return await coordinator.enter({trigger:"manual",scope:{kind:"vendor",vendor:"gauges"},mode:"incremental"}).completion;}
      finally{coordinator.close();}
    };
    assert.equal((await run()).status,"success");
    const db=new Database(dbPath);
    const acceptedBase=db.query("SELECT * FROM probe_counters WHERE id=?").get(base.counter_id);
    assert.ok(acceptedBase);
    fs.appendFileSync(file,reference.line+"\\n");
    const queue=new SyncFileQueue(archive);try{queue.signal(file,syncFileRoots());}finally{queue.close();}
    const result=await run(); assert.equal(result.status,"success",JSON.stringify(result));
    assert.equal(initial,0,"the stage starts without historical base facts");
    assert.equal(after,2,"only the required base and new counter enter the stage");
    assert.deepEqual(result.vendors[0].diagnostics.files.map(item=>({fromOffset:item.fromOffset,readLines:item.readLines})),
      [{fromOffset:Buffer.byteLength(first),readLines:1}]);
    assert.deepEqual(db.query("SELECT * FROM probe_counters WHERE id=?").get(base.counter_id),acceptedBase);
    const published=db.query("SELECT payload FROM probe_counters WHERE id=?").get(next.counter_id) as {payload:string};
    assert.deepEqual(JSON.parse(published.payload),next.payload);
    assert.deepEqual(db.query("SELECT used_percent FROM probe_windows ORDER BY ts").all(),[{used_percent:42},{used_percent:43}]);
    assert.equal((db.query("SELECT count(*) n FROM gauge_journal_receipts").get() as {n:number}).n,2);
    db.close(); console.log("COMPACT_GAUGE_QUEUE_PASS");
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { cwd: process.cwd(), env: { ...process.env,
      TOKENATLAS_DB: f.dbPath, TOKENATLAS_ARCHIVE: archive, TOKENATLAS_CONFIG: config, TOKENATLAS_LOCAL_STATE: path.join(f.directory, "state"),
      USERPROFILE: path.join(f.directory, "missing"), HOME: path.join(f.directory, "missing"),
      APPDATA: path.join(f.directory, "missing-appdata"), LOCALAPPDATA: path.join(f.directory, "missing-local"),
    }, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, err }).toEqual({ exit: 0, err: "" }); expect(out).toContain("COMPACT_GAUGE_QUEUE_PASS");
  } finally { removeTestFixture(f.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 30000);

test("production queue stages gauge cursors: append parses one line, restart is quiet, correction retains accepted facts", async () => {
  const f = createTestDatabase();
  const archive = path.join(f.directory,"archive"), config = path.join(f.directory,"config");
  fs.mkdirSync(config); fs.writeFileSync(path.join(config,"accounts.json"),JSON.stringify(emptyAccountsDocument()));
  const module = (name:string) => new URL(name,import.meta.url).href;
  const script = path.join(f.directory,"gauge-queue.ts");
  fs.writeFileSync(script,`
    import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
    import { randomUUID } from "node:crypto";
    import { Database } from ${JSON.stringify(module("../db/sqlite.ts"))};
    import { SyncCoordinator } from ${JSON.stringify(module("./coordinator.ts"))};
    import { SyncFileQueue } from ${JSON.stringify(module("./file-queue.ts"))};
    import { syncFileRoots } from ${JSON.stringify(module("./mirror.ts"))};
    import { createProbeCollection, acceptProbeFact } from ${JSON.stringify(module("../db/probe-facts.ts"))};
    const archive=process.env.TOKENATLAS_ARCHIVE!, dbPath=process.env.TOKENATLAS_DB!;
    const file=path.join(archive,"gauges","target","probe_windows.jsonl"), other=path.join(archive,"gauges","unselected","probe_windows.jsonl");
    for(const p of [file,other])fs.mkdirSync(path.dirname(p),{recursive:true});
    const line=(ts:string,subject:string)=>JSON.stringify({provider:"codex",subject,ts,kind:"primary",reported_percent_side:"used",used_percent:42,window_minutes:300,machine:"fixture",ok:1,journal_version:2,journal_entry_id:randomUUID()})+"\\n";
    const first=line("2026-09-01T10:00:00Z","target");
    fs.writeFileSync(file,first);fs.writeFileSync(other,line("2026-09-01T10:00:00Z","unselected"));
    let stageCounts=[];
    const run=async(mode="incremental")=>{stageCounts=[];const c=new SyncCoordinator({dbPath,rootDir:process.cwd(),refreshDerived:()=>{}});
      const adapters=c.adapters,gauge=adapters.gauges;
      adapters.gauges=async context=>{const before=new Database(context.stageDbPath,{readonly:true});
        const initial=before.query("SELECT count(*) n FROM probe_counters").get().n;before.close();
        const result=await gauge(context);const after=new Database(context.stageDbPath,{readonly:true});
        stageCounts.push({initial,counters:after.query("SELECT count(*) n FROM probe_counters").get().n});after.close();return result;};
      try{return await c.enter({trigger:"manual",scope:{kind:"vendor",vendor:"gauges"},mode}).completion;}finally{c.close();}};
    const signal=(selected=file)=>{const q=new SyncFileQueue(archive);try{q.signal(selected,syncFileRoots());}finally{q.close();}};
    assert.equal((await run()).status,"success");
    const db=new Database(dbPath);
    db.transaction(()=>{for(let i=0;i<1000;i++)acceptProbeFact(db,createProbeCollection([{provider:"codex",subject:"historical",ts:new Date(Date.UTC(2025,0,1,0,i)).toISOString(),kind:"primary",reported_percent_side:"used",used_percent:i%100}])[0]);})();
    const otherBefore=db.query("SELECT * FROM gauge_files WHERE store='unselected'").get();
    const oldFacts=db.query("SELECT * FROM probe_windows ORDER BY id").all();
    fs.appendFileSync(file,line("2026-09-01T10:01:00Z","target"));signal();
    let historicalDecodes=0;
    const originalParse=JSON.parse;
    JSON.parse=function(text,reviver){if(typeof text==="string"&&text.trim()===first.trim())historicalDecodes++;return originalParse(text,reviver);};
    let appended;
    try{appended=await run();}finally{JSON.parse=originalParse;}
    assert.equal(historicalDecodes,0,"the production wrapper must not decode accepted journal records");
    assert.equal(appended.status,"success",JSON.stringify(appended));
    assert.deepEqual(stageCounts,[{initial:0,counters:1}],"unrelated thousand-counter history must not enter the stage");
    assert.equal(appended.vendors[0].diagnostics.probeShadowScope,"not-evaluated-global-history");
    const details=appended.vendors[0].diagnostics.files;
    assert.equal(details.length,1);assert.equal(details[0].fromOffset,Buffer.byteLength(first));assert.equal(details[0].readLines,1);
    assert.deepEqual(db.query("SELECT * FROM gauge_files WHERE store='unselected'").get(),otherBefore);
    assert.deepEqual(db.query("SELECT * FROM probe_windows ORDER BY id LIMIT 2").all(),oldFacts);
    const sparseFacts=db.query("SELECT * FROM probe_counters ORDER BY id").all();
    const sparseRows=db.query("SELECT * FROM probe_windows ORDER BY id").all();
    const fullReference=await run("full");assert.equal(fullReference.status,"success",JSON.stringify(fullReference));
    assert.deepEqual(db.query("SELECT * FROM probe_counters ORDER BY id").all(),sparseFacts);
    assert.deepEqual(db.query("SELECT * FROM probe_windows ORDER BY id").all(),sparseRows);
    const checkpoint=db.query("SELECT * FROM gauge_files WHERE store='target'").get();
    const noop=await run();assert.equal(noop.vendors.length,0);assert.deepEqual(db.query("SELECT * FROM gauge_files WHERE store='target'").get(),checkpoint);
    const accepted=db.query("SELECT * FROM probe_windows ORDER BY id").all();
    const acceptedContent=fs.readFileSync(file,"utf8");
    fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace('"used_percent":42','"used_percent":43'));signal();
    const failed=await run();assert.equal(failed.status,"partial_success",JSON.stringify(failed));
    assert.ok(failed.vendors.find(v=>v.vendor==="gauges").diagnostics.pendingInputs.length>0);
    assert.deepEqual(db.query("SELECT * FROM probe_windows ORDER BY id").all(),accepted);
    assert.deepEqual(db.query("SELECT * FROM gauge_files WHERE store='target'").get(),checkpoint);
    const q=new SyncFileQueue(archive);try{assert.ok(q.take("gauges",syncFileRoots()).some(row=>row.path===file));}finally{q.close();}
    // One broken appended file cannot roll back an unrelated valid journal in the same vendor batch.
    fs.writeFileSync(file,acceptedContent+'{"broken":\\n');signal();
    fs.appendFileSync(other,line("2026-09-01T10:02:00Z","unselected"));signal(other);
    const partial=await run();assert.equal(partial.status,"partial_success",JSON.stringify(partial));
    assert.ok(partial.vendors[0].diagnostics.pendingInputs.some(item=>item.path===file));
    assert.deepEqual(db.query("SELECT * FROM gauge_files WHERE store='target'").get(),checkpoint);
    assert.deepEqual(db.query("SELECT * FROM probe_windows WHERE subject='target' ORDER BY id").all(),accepted.filter(row=>row.subject==='target'));
    assert.equal(db.query("SELECT count(*) n FROM probe_windows WHERE subject='unselected'").get().n,2);
    const pending=new SyncFileQueue(archive);try{assert.ok(pending.take("gauges",syncFileRoots()).some(row=>row.path===file));}finally{pending.close();}
    // An old offset without a digest does not prove that historical bytes remain unchanged.
    db.query("UPDATE gauge_files SET prefix_sha256=NULL WHERE store='target'").run();
    const untrustedBookmark=db.query("SELECT * FROM gauge_files WHERE store='target'").get();
    fs.writeFileSync(file,'{"broken":\\n'+acceptedContent);signal();
    fs.appendFileSync(other,line("2026-09-01T10:03:00Z","unselected"));signal(other);
    const untrusted=await run();assert.equal(untrusted.status,"partial_success",JSON.stringify(untrusted));
    assert.ok(untrusted.vendors[0].diagnostics.pendingInputs.some(item=>item.path===file));
    assert.deepEqual(db.query("SELECT * FROM gauge_files WHERE store='target'").get(),untrustedBookmark);
    assert.deepEqual(db.query("SELECT * FROM probe_windows WHERE subject='target' ORDER BY id").all(),accepted.filter(row=>row.subject==='target'));
    assert.equal(db.query("SELECT count(*) n FROM probe_windows WHERE subject='unselected'").get().n,3);
    const untrustedPending=new SyncFileQueue(archive);try{assert.ok(untrustedPending.take("gauges",syncFileRoots()).some(row=>row.path===file));}finally{untrustedPending.close();}
    db.close();console.log("GAUGE_QUEUE_PASS");
  `);
  try {
    const child=Bun.spawn([process.execPath,script],{cwd:process.cwd(),env:{...process.env,
      TOKENATLAS_DB:f.dbPath,TOKENATLAS_ARCHIVE:archive,TOKENATLAS_CONFIG:config,TOKENATLAS_LOCAL_STATE:path.join(f.directory,"state"),
      USERPROFILE:path.join(f.directory,"missing"),HOME:path.join(f.directory,"missing"),
      APPDATA:path.join(f.directory,"missing-appdata"),LOCALAPPDATA:path.join(f.directory,"missing-local")},stdout:"pipe",stderr:"pipe"});
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,err}).toEqual({exit:0,err:""});expect(out).toContain("GAUGE_QUEUE_PASS");
  } finally {removeTestFixture(f.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},30000);
