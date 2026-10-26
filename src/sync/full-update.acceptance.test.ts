import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTestFixture } from "../test-cleanup";
import { Database } from "../db/sqlite";
import { ingestGrokAsync } from "../ingest/grok";
import { ingestGeminiTargetsAsync } from "./adapters";
import { createTestDatabase } from "./test-support";

test("forced replica stages use active Grok and Gemini history and reject conflicting owners", async () => {
  const active = createTestDatabase(), staged = createTestDatabase();
  const grokFile = (name: string, tokens: number) => {
    const root = path.join(active.directory, name), file = path.join(root, "repo", "session", "updates.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ params: { sessionId: "s", _meta: { agentTimestampMs: 1768039200000 },
      update: { prompt_id: "p", usage: { modelUsage: { grok: { inputTokens: tokens, outputTokens: 1 } } } } } }) + "\n");
    return { root, file };
  };
  const original = grokFile("original", 10), replica = grokFile("replica", 10);
  const db = new Database(active.dbPath), stage = new Database(staged.dbPath);
  try {
    (await ingestGrokAsync(original.root, "grok", { atlasPath: active.dbPath, sourceId: "declared" }));
    db.exec("UPDATE grok_events SET project_id='retained-project'");
    const options = { atlasPath: staged.dbPath, sourceAtlasPath: active.dbPath, sourceId: "declared", force: true, files: [replica.file] };
    (await ingestGrokAsync(replica.root, "grok", options));
    expect(stage.query("SELECT path,in_tok,project_id FROM grok_events").all())
      .toEqual([{ path: original.file, in_tok: 10, project_id: "retained-project" }]);
    const accepted = stage.query("SELECT * FROM grok_events").all();
    grokFile("replica", 90);
    await expect(ingestGrokAsync(replica.root, "grok", options)).rejects.toThrow("Conflicting Grok replicas");
    expect(stage.query("SELECT * FROM grok_events").all()).toEqual(accepted);

    const file = path.join(active.directory, "conversations", "collision.db");
    fs.mkdirSync(path.dirname(file));
    const source = new Database(file);
    source.exec("CREATE TABLE gen_metadata(idx INTEGER,data BLOB)");
    source.query("INSERT INTO gen_metadata VALUES(0,?)").run(new Uint8Array([10, 4, 34, 2, 16, 123]));
    source.close();
    db.query(`INSERT INTO gemini_events(store,conversation_id,gen_idx,ts,ts_basis,path,fresh_in,project_id)
      VALUES('agy1','collision',0,'2026-01-10T10:00:00Z','conversation','unread-owner.db',10,'retained-project')`).run();
    await expect(ingestGeminiTargetsAsync({ activeDbPath: active.dbPath, stageDbPath: staged.dbPath,
      rootDir: process.cwd(), mode: "incremental", reparse: true, changedFiles: [file] },
      [{ profile: "fixture", dir: path.dirname(file), store: "agy1" }])).rejects.toThrow("different conversation path");
    expect(stage.query("SELECT * FROM gemini_events").all()).toEqual([]);
    expect(db.query("SELECT path,fresh_in,project_id FROM gemini_events").get())
      .toEqual({ path: "unread-owner.db", fresh_in: 10, project_id: "retained-project" });
  } finally {
    db.close(); stage.close();
    for (const fixture of [active, staged]) removeTestFixture(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("full update selects all archive inputs, preserves vanished sources and rowids, and publishes only corrections after restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-full-update-"));
  const archive = path.join(directory, "archive"), config = path.join(directory, "config");
  fs.mkdirSync(config);
  fs.mkdirSync(path.join(archive,".archive-inventory"),{recursive:true});
  fs.writeFileSync(path.join(archive,".archive-inventory/identity.json"),JSON.stringify({schema:1,archiveId:"full-update-fixture"}));
  fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
  fs.writeFileSync(path.join(config, "projects.json"), '{"projects":[]}');
  const module = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
  const script = `
    import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
    import { Database } from ${module("../db/sqlite.ts")};
    import { SyncCoordinator } from ${module("./coordinator.ts")};
    import { createTestDatabase, createCodexSchema, noMirror } from ${module("./test-support.ts")};
    import { installAnalysisTracking } from ${module("../db/analysis.ts")};
    const archive=process.env.TOKENATLAS_ARCHIVE!;
    const fixture=createTestDatabase(); createCodexSchema(fixture.dbPath);
    const db=new Database(fixture.dbPath); installAnalysisTracking(db);
    const line=(value:unknown)=>JSON.stringify(value)+"\\n";
    const file=(vendor:string,profile:string,relative:string)=>{
      const result=path.join(archive,vendor,profile,relative);fs.mkdirSync(path.dirname(result),{recursive:true});return result;
    };
    const codex=(name:string,tokens:number)=>{
      const result=file("codex","PC-user","sessions/"+name+".jsonl");
      fs.writeFileSync(result,line({type:"session_meta",payload:{id:name,originator:"codex-tui",thread_source:"user",cwd:"C:/fixture"}})
        +line({timestamp:"2026-01-10T10:00:00Z",type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:tokens,output_tokens:1}}}})
        +line({type:"turn_context",payload:{model:"gpt-late",effort:"high"}}));return result;
    };
    const claude=(name:string,tokens:number)=>{
      const result=file("claude","PC-user",name+".jsonl");
      fs.writeFileSync(result,line({type:"assistant",sessionId:"session",timestamp:"2026-01-10T10:00:00Z",
        message:{id:name,model:"claude-sonnet",usage:{input_tokens:tokens,output_tokens:1}}}));return result;
    };
    const grok=(name:string,tokens:number)=>{
      const result=file("grok","PC-user","sessions/repo/"+name+"/updates.jsonl");
      fs.writeFileSync(result,line({params:{sessionId:name,_meta:{agentTimestampMs:1768039200000},
        update:{prompt_id:name,usage:{modelUsage:{grok:{inputTokens:tokens,outputTokens:1}}}}}}));return result;
    };
    const gemini=(name:string,tokens:number)=>{
      const result=file("gemini","PC-user","conversations/"+name+".db");const source=new Database(result);
      source.exec("CREATE TABLE gen_metadata(idx INTEGER,data BLOB)");
      source.query("INSERT INTO gen_metadata VALUES(0,?)").run(new Uint8Array([10,4,34,2,16,tokens]));source.close();return result;
    };
    const opencode=(profile:string)=>{
      const result=file("opencode",profile,"opencode.sqlite");const source=new Database(result);
      source.exec("CREATE TABLE session(id TEXT,directory TEXT);CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)");
      source.query("INSERT INTO session VALUES('session','C:/fixture')").run();
      source.query("INSERT INTO message VALUES('message','session',?)").run(JSON.stringify({role:"assistant",modelID:"glm-5",providerID:"zai",time:{created:1768039200000},tokens:{input:10,output:1},cost:0.01}));
      source.close();return result;
    };
    const journals=["gone","kept"].map((name,index)=>{
      const result=file("gauges","PC-"+name,"probe_windows.jsonl");
      fs.writeFileSync(result,line({provider:"codex",subject:name,ts:"2026-01-10T10:00:00Z",kind:"primary",reported_percent_side:"used",used_percent:7+index,machine:"PC-"+name}));return result;
    });
    const gone=[codex("gone",10),claude("gone",10),grok("gone",10),gemini("gone",10),opencode("PC-gone"),journals[0]!];
    fs.appendFileSync(gone[1]!,line({type:"assistant",sessionId:"session",timestamp:"2026-01-10T11:00:00Z",message:{id:"orphan",model:"claude-sonnet",usage:{input_tokens:3,output_tokens:2}}})
      +line({type:"assistant",sessionId:"session",timestamp:"2026-01-10T12:00:00Z",error:"rate_limit",isApiErrorMessage:true,quotaLimits:{status:"rejected",rateLimitType:"seven_day",resetsAt:1790506800},message:{id:"refusal",model:"<synthetic>",usage:{input_tokens:0,output_tokens:0},content:[{type:"text",text:"You have hit your weekly limit"}]}}));
    const kept=[codex("kept",20),claude("kept",20),grok("kept",20),gemini("kept",20),opencode("PC-kept"),journals[1]!];
    fs.writeFileSync(file("codex","PC-user","sessions/tool.txt"),"not a calculation input");
    const request={trigger:"manual",scope:{kind:"all"},mode:"full",collection:"archive"} as const;
    const open=()=>new SyncCoordinator({dbPath:fixture.dbPath,rootDir:process.cwd(),mirror:noMirror});
    let coordinator=open();
    const run=async()=>{
      const result=await coordinator.enter(request).completion;
      assert.equal(result.status,"success",JSON.stringify(result.vendors.map(v=>({vendor:v.vendor,status:v.status,error:v.error}))));return result;
    };
    const tables=["events","codex_file_evidence","files","claude_events","claude_limit_hits","claude_files","grok_events","grok_files","gemini_events","gemini_files","oc_events","probe_windows","gauge_files","gauge_journal_receipts"];
    const snapshot=()=>Object.fromEntries(tables.map(table=>[table,(db.query("SELECT rowid,* FROM "+table+" ORDER BY rowid").all() as Record<string,unknown>[]).map(({ingested_at,...row})=>{if(table==="gauge_files")delete row.rowid;return row;})]));
    try {
      const first=await run();
      assert.deepEqual(first.vendors.map(v=>[v.vendor,v.processedInputs]),[["gauges",2],["codex",2],["claude",2],["opencode",2],["grok",2],["gemini",2]]);
      assert.deepEqual(db.query("SELECT DISTINCT model FROM events").all(),[{model:"gpt-late"}]);
      const baseline=snapshot();
      const unchanged=await run();
      assert.deepEqual(unchanged.afterRevisions,unchanged.beforeRevisions);
      assert.equal(unchanged.aggregateWorkRequested,false);
      for(const vendor of unchanged.vendors){assert.equal(vendor.dataChanged,false);if(vendor.vendor!=="gauges")assert.equal(vendor.diagnostics.changedIdentities,0);}
      assert.deepEqual(snapshot(),baseline);
      const vanishedBookmarks=db.query("SELECT * FROM claude_files WHERE path=?").get(gone[1]!);
      const ocProof=db.query("SELECT * FROM meta WHERE key LIKE 'opencode_snapshot:%' ORDER BY key").all();
      for(const source of gone)fs.unlinkSync(source);
      coordinator.close();coordinator=open();
      const absent=await run();
      assert.deepEqual(absent.afterRevisions,absent.beforeRevisions);assert.deepEqual(snapshot(),baseline);
      assert.deepEqual(db.query("SELECT * FROM meta WHERE key LIKE 'opencode_snapshot:%' ORDER BY key").all(),ocProof);
      assert.deepEqual(coordinator.latest()!.mode,"full");assert.deepEqual(db.query("SELECT * FROM claude_files WHERE path=?").get(gone[1]!),vanishedBookmarks);
      // The model is declared after usage: selected force parsing must recover it without a retained-row backfill.
      codex("kept",21);
      const corrected=await run(),changed=corrected.vendors.filter(v=>v.dataChanged);
      assert.deepEqual(changed.map(v=>v.vendor),["codex"]);assert.equal(changed[0]!.diagnostics.changedIdentities,1);
      assert.equal(corrected.afterRevisions.data,corrected.beforeRevisions.data+1);
      const after=snapshot();for(const table of tables.filter(t=>!t.startsWith("codex_")&&!['events','files'].includes(t)))assert.deepEqual(after[table],baseline[table]);
      assert.deepEqual(db.query("SELECT model,in_tok FROM events ORDER BY in_tok").all(),[{model:"gpt-late",in_tok:10},{model:"gpt-late",in_tok:21}]);
      const retry=await run();assert.deepEqual(retry.afterRevisions,retry.beforeRevisions);assert.deepEqual(snapshot(),after);
      // A pruned owner still contributes the strongest Claude call and its sticky identity evidence.
      db.query("UPDATE claude_events SET account_key='retained-account',subscription_conflict=1 WHERE call_id='gone'").run();
      const retained=db.query("SELECT rowid,* FROM claude_events WHERE path=? ORDER BY call_id").all(gone[1]!);
      const retainedLimits=db.query("SELECT * FROM claude_limit_hits WHERE path=?").all(gone[1]!);assert.equal(retainedLimits.length,1);
      fs.appendFileSync(kept[1]!,line({type:"assistant",sessionId:"session",timestamp:"2026-01-10T10:00:00Z",message:{id:"gone",model:"claude-sonnet",usage:{input_tokens:1,output_tokens:1}}}));
      await run();assert.deepEqual(db.query("SELECT rowid,* FROM claude_events WHERE path=? ORDER BY call_id").all(gone[1]!),retained);assert.deepEqual(db.query("SELECT * FROM claude_limit_hits WHERE path=?").all(gone[1]!),retainedLimits);assert.deepEqual(db.query("SELECT * FROM claude_files WHERE path=?").get(gone[1]!),vanishedBookmarks);
      const repeatedMerge=await run();assert.deepEqual(repeatedMerge.afterRevisions,repeatedMerge.beforeRevisions);assert.equal(repeatedMerge.vendors.find(v=>v.vendor==="claude")!.diagnostics.changedIdentities,0);
      console.log("FULL_UPDATE_PASS");
    } finally {coordinator.close();db.close();fs.rmSync(fixture.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(), env: { ...process.env,
      TOKENATLAS_ARCHIVE: archive, TOKENATLAS_ARCHIVE_LOGICAL_ROOT: archive, TOKENATLAS_CONFIG: config,
      TOKENATLAS_FROZEN_CONFIG: "1", TOKENATLAS_LOCAL_STATE: path.join(directory, "state"),
      TOKENATLAS_TEMP_DIR: path.join(directory, "temp"), TOKENATLAS_PARSE_WORKERS: "0",
      USERPROFILE: path.join(directory, "absent-home"), HOME: path.join(directory, "absent-home") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("FULL_UPDATE_PASS");
  } finally { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 120000);
