import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";

for (const modesOnly of [false, true]) test(modesOnly
  ? "full update and unbounded rebuild still select every source for six providers"
  : "bounded production rebuild selects range, changed and unknown sources and preserves outside history for six providers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-ranged-sources-"));
  const archive = path.join(directory, "archive"), config = path.join(directory, "config");
  fs.mkdirSync(config);
  fs.mkdirSync(path.join(archive, ".archive-inventory"), { recursive: true });
  fs.writeFileSync(path.join(archive, ".archive-inventory", "identity.json"), JSON.stringify({schema:1,archiveId:"bounded-fixture"}));
  for (const [name, value] of Object.entries({"accounts.json":{version:2,subscriptions:[],sources:[]},
    "projects.json":{projects:[]},"rate-cards.json":{vendors:{}}}))
    fs.writeFileSync(path.join(config, name), JSON.stringify(value));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { Database } from './src/db/sqlite';
    import { createTestDatabase, createCodexSchema, noMirror } from './src/sync/test-support';
    import { SyncCoordinator } from './src/sync/coordinator';
    import { createProductionAdapters } from './src/sync/adapters';
    import { remap } from './src/projects/remap';
    const archive=${JSON.stringify(archive)};
    const modesOnly=${modesOnly};
    const fixture=createTestDatabase(); createCodexSchema(fixture.dbPath);
    const db=new Database(fixture.dbPath);
    const vendors=['codex','claude','gemini','grok','opencode','gauges'];
    const files={}; const current={};
    const ts='2026-01-10T10:00:00.000Z', outside='2026-02-10T10:00:00.000Z';
    const line=row=>JSON.stringify(row)+'\\n';
    function source(vendor,name,time,tokens) {
      const profile=vendor==='opencode'||vendor==='gauges'?'PC-'+name:'PC-user';
      const relative={codex:'sessions/'+name+'.jsonl',claude:name+'.jsonl',gemini:'conversations/'+name+'.db',
        grok:'sessions/repo/'+name+'/updates.jsonl',opencode:'opencode.sqlite',gauges:'probe_windows.jsonl'}[vendor];
      const file=path.join(archive,vendor,profile,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
      if(vendor==='codex')fs.writeFileSync(file,line({type:'session_meta',payload:{id:name,originator:'codex-tui',cwd:'C:/fixture'}})
        +line({type:'turn_context',payload:{model:'gpt-test',cwd:'C:/fixture'}})
        +line({timestamp:time,type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:tokens,output_tokens:1}}}}));
      if(vendor==='claude')fs.writeFileSync(file,line({type:'assistant',sessionId:name,timestamp:time,
        message:{id:name,model:'claude-sonnet',usage:{input_tokens:tokens,output_tokens:1}}}));
      if(vendor==='grok')fs.writeFileSync(file,line({params:{sessionId:name,_meta:{agentTimestampMs:Date.parse(time)},
        update:{prompt_id:name,usage:{modelUsage:{grok:{inputTokens:tokens,outputTokens:1}}}}}}));
      if(vendor==='gauges')fs.writeFileSync(file,line({provider:'codex',subject:name,ts:time,kind:'primary',reported_percent_side:'used',used_percent:tokens,machine:profile}));
      if(vendor==='gemini'||vendor==='opencode') {
        const src=new Database(file);
        if(vendor==='gemini') {
          src.exec('CREATE TABLE IF NOT EXISTS gen_metadata(idx INTEGER,data BLOB); DELETE FROM gen_metadata');
          src.query('INSERT INTO gen_metadata VALUES(0,?)').run(new Uint8Array([10,4,34,2,16,tokens]));
        } else {
          src.exec('CREATE TABLE IF NOT EXISTS session(id TEXT,directory TEXT); CREATE TABLE IF NOT EXISTS message(id TEXT,session_id TEXT,data TEXT); DELETE FROM session; DELETE FROM message');
          src.query("INSERT INTO session VALUES('session','C:/fixture')").run();
          src.query("INSERT INTO message VALUES(?,'session',?)").run(name,JSON.stringify({role:'assistant',modelID:'glm-5',providerID:'zai',time:{created:Date.parse(time)},tokens:{input:tokens,output:1},cost:0.01}));
        }
        src.close();
        if(vendor==='gemini')fs.utimesSync(file,new Date(time),new Date(time));
      }
      return file;
    }
    for(const vendor of vendors) {
      files[vendor]={range:source(vendor,'range',ts,10),outside:source(vendor,'outside',outside,20),changed:source(vendor,'changed',outside,30)};
    }
    const facts={codex:['events'],claude:['claude_events','claude_limit_hits'],gemini:['gemini_events'],
      grok:['grok_events'],opencode:['oc_events'],gauges:['probe_windows','probe_observations','probe_counters']};
    const bookmarks={codex:'files',claude:'claude_files',gemini:'gemini_files',grok:'grok_files',gauges:'gauge_files'};
    const production=createProductionAdapters();
    let selection={}; let block=false;
    const adapters=Object.fromEntries(vendors.map(vendor=>[vendor,async context=>{
      selection[vendor]=context.changedFiles;
      const selected=context.changedFiles??[];
      if(block && vendor!=='gauges') {
        assert.deepEqual([...selected].sort(),[files[vendor].range,files[vendor].changed,files[vendor].unknown].sort());
      }
      if(block && vendor==='gauges')assert.deepEqual([...selected].sort(),[files[vendor].changed,files[vendor].unknown].sort());
      return production[vendor](context);
    }]));
    const open=(dbPath=fixture.dbPath,custom=adapters)=>new SyncCoordinator({dbPath,rootDir:process.cwd(),mirror:noMirror,adapters:custom,
      sourceFingerprint:vendor=>vendor,refreshDerived:()=>{}});
    const run=async (request,dbPath=fixture.dbPath,custom=adapters)=>{
      const coordinator=open(dbPath,custom);
      try {const result=await coordinator.enter(request).completion; console.log('Fixture generation '+(request.rebuildGeneration??'full')+': '+result.status); assert.equal(result.status,'success',JSON.stringify(result.vendors.map(v=>[v.vendor,v.error])));return result;}
      finally {coordinator.close();}
    };
    const full={trigger:'manual',scope:{kind:'all'},mode:'full',collection:'archive'};
    const rows=(database,table)=>database.query('SELECT * FROM '+table+' ORDER BY rowid').all().map(({id,ingested_at,...row})=>row);
    let ref;
    try {
      if(modesOnly) {
        const baseline=await run(full);
        for(const vendor of vendors)assert.equal(baseline.vendors.find(v=>v.vendor===vendor).processedInputs,3);
        for(const vendor of vendors)assert.equal(selection[vendor].length,3);
      } else {
        // Seed accepted facts through the real importers; bounded/reference publication below uses the coordinator.
        for(const vendor of vendors) {
          const result=await production[vendor]({activeDbPath:fixture.dbPath,stageDbPath:fixture.dbPath,rootDir:process.cwd(),
            mode:'incremental',reparse:true,rebuild:true,changedFiles:Object.values(files[vendor])});
          assert.equal(result.processedInputs,3);assert.deepEqual(result.failedInputs,[]);
        }
        // The application prepares these columns on the active DB as well as in stages.
        remap(db,{projects:[]});
      }
      if(modesOnly) {
        const unbounded=await run({...full,mode:'incremental',rebuildGeneration:13,reparse:{}});
        for(const vendor of vendors) {assert.equal(selection[vendor],undefined);assert.equal(unbounded.vendors.find(v=>v.vendor===vendor).processedInputs,3);}
      } else {
      const untouched=Object.fromEntries(vendors.map(vendor=>[vendor,facts[vendor].map(table=>rows(db,table).filter(row=>row.ts===outside))]));
      const outsideBookmarks=Object.fromEntries(Object.entries(bookmarks).map(([vendor,table])=>[vendor,db.query('SELECT * FROM '+table+' WHERE path=?').all(vendor==='gauges'?'probe_windows.jsonl':files[vendor].outside).filter(row=>vendor!=='gauges'||row.store==='PC-outside')]));
      const ocBookmark=db.query("SELECT * FROM meta WHERE key='opencode_snapshot:PC-outside'").get();
      // The active copy remains the previous accepted history; changed/unknown inputs may now hold range rows.
      for(const vendor of vendors) {
        source(vendor,'changed',outside,31); files[vendor].unknown=source(vendor,'unknown',ts,40);
        if(vendor==='gemini')fs.utimesSync(files[vendor].changed,new Date(outside),new Date(Date.parse(outside)+1000));
        if(vendor==='gauges') {
          // Journals grow; a changed reading is appended rather than rewriting immutable accepted evidence.
          source(vendor,'changed',outside,30);
          fs.appendFileSync(files[vendor].changed,line({provider:'codex',subject:'changed',ts,kind:'primary',reported_percent_side:'used',used_percent:31,machine:'PC-changed'}));
        }
      }
      const reference=path.join(fixture.directory,'reference.sqlite');
      db.query('VACUUM INTO ?').run(reference);
      const bounded={trigger:'manual',scope:{kind:'all'},mode:'incremental',collection:'archive',rebuildGeneration:11,reparse:{from:'2026-01-10',until:'2026-01-10'}};
      // Emulate the old force-all adapters on an independent copy, while retaining the same ranged publisher.
      const forceAll=Object.fromEntries(vendors.map(vendor=>[vendor,context=>production[vendor]({...context,changedFiles:undefined})]));
      await run(bounded,reference,forceAll);
      ref=new Database(reference,{readonly:true});
      block=true;
      const originals={readFileSync:fs.readFileSync,openSync:fs.openSync};
      const forbidden=new Set(vendors.map(vendor=>files[vendor].outside));
      for(const method of ['readFileSync','openSync']) fs[method]=function(file,...args){
        assert(!forbidden.has(String(file)),'Unselected source opened: '+file);return originals[method].call(fs,file,...args);
      };
      try {await run(bounded);} finally {Object.assign(fs,originals);block=false;}
      for(const vendor of vendors) {
        for(const table of facts[vendor])assert.deepEqual(rows(db,table).filter(row=>row.ts===ts),rows(ref,table).filter(row=>row.ts===ts),table);
        assert.deepEqual(facts[vendor].map(table=>rows(db,table).filter(row=>row.ts===outside)),untouched[vendor],vendor+' outside facts');
        if(bookmarks[vendor])assert.deepEqual(db.query('SELECT * FROM '+bookmarks[vendor]+' WHERE path=?').all(vendor==='gauges'?'probe_windows.jsonl':files[vendor].outside).filter(row=>vendor!=='gauges'||row.store==='PC-outside'),outsideBookmarks[vendor]);
      }
      assert.deepEqual(db.query("SELECT * FROM meta WHERE key='opencode_snapshot:PC-outside'").get(),ocBookmark);
      ref.close(); ref=undefined;
      const accepted=Object.fromEntries(Object.values(facts).flat().map(table=>[table,rows(db,table)]));
      const retry=await run(bounded);
      assert.deepEqual(Object.fromEntries(Object.values(facts).flat().map(table=>[table,rows(db,table)])),accepted);
      assert.deepEqual(retry.afterRevisions,retry.beforeRevisions);
      for(const vendor of retry.vendors)assert.equal(typeof vendor.diagnostics.resumedFromRun,'string');
      const freshRetry=await run({...bounded,rebuildGeneration:12});
      assert.deepEqual(freshRetry.afterRevisions,freshRetry.beforeRevisions);
      for(const vendor of freshRetry.vendors)if(vendor.vendor==='gauges')assert.equal(vendor.writtenRows,0);
        else assert.equal(vendor.diagnostics.changedIdentities,0,vendor.vendor+' fresh-generation retry');
      assert.deepEqual(Object.fromEntries(Object.values(facts).flat().map(table=>[table,rows(db,table)])),accepted);
      }
      console.log('BOUNDED_SOURCES_PASS');
    } finally {ref?.close();db.close();Bun.gc(true);fs.rmSync(fixture.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env,
      TOKENATLAS_ARCHIVE: archive, TOKENATLAS_ARCHIVE_LOGICAL_ROOT: archive, TOKENATLAS_CONFIG: config,
      TOKENATLAS_FROZEN_CONFIG: "1", TOKENATLAS_LOCAL_STATE: path.join(directory, "state"),
      TOKENATLAS_TEMP_DIR: path.join(directory, "temp"), TOKENATLAS_PARSE_WORKERS: "0",
      USERPROFILE: path.join(directory, "absent-home"), HOME: path.join(directory, "absent-home") }, stdout: "pipe", stderr: "pipe" });
    const watchdog = setTimeout(() => child.kill(), 110000);
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      .finally(() => clearTimeout(watchdog));
    if (exit !== 0) throw new Error(stdout + "\n" + stderr);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("BOUNDED_SOURCES_PASS");
  } finally { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 120000);
