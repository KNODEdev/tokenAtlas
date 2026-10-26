import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { removeTestFixture } from "../test-cleanup";
import { createCodexSchema, createTestDatabase } from "./test-support";
import { SyncFileQueue } from "./file-queue";
import { bootstrapAtlasIndex, finishAtlasBootstrapRecovery, pendingAtlasBootstrapRecovery, pendingAtlasBootstrapVendors } from "../db/bootstrap";
import type { SyncRunResult } from "./contracts";

const temporary: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of temporary.splice(0))
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function openCodeSource(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file, { create: true });
  try {
    sqlite.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    sqlite.query("INSERT INTO session VALUES (?, ?)").run("session", "C:/fixture");
    sqlite.query("INSERT INTO message VALUES (?, ?, ?)").run("message", "session", JSON.stringify({
      role: "assistant", modelID: "glm-5", providerID: "zai", time: { created: Date.UTC(2026, 7, 10, 11) },
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0.01,
    }));
  } finally { sqlite.close(true); }
}

function initializeEngineSchema(dbPath: string): void {
  createCodexSchema(dbPath);
}

async function run(dbPath: string, request: Record<string, unknown>, env: Record<string, string>): Promise<SyncRunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "runner.ts"), JSON.stringify({ dbPath, rootDir: process.cwd(), request })],
    cwd: process.cwd(), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, stderr).toBe(0);
  const line = stdout.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
  expect(line, stdout + stderr).toBeDefined();
  return JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length)) as SyncRunResult;
}

test("collection precedes archive calculation; a fresh second database reuses the archive while the old queue is acknowledged", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ta-bootstrap-recovery-"));
  temporary.push(directory);
  const archiveRoot = path.join(directory, "archive"), configRoot = path.join(directory, "config");
  const localState = path.join(directory, "state"), home = path.join(directory, "home");
  fs.mkdirSync(archiveRoot); fs.mkdirSync(configRoot); fs.mkdirSync(localState);
  fs.writeFileSync(path.join(configRoot, "accounts.json"), JSON.stringify({version:2,subscriptions:[],sources:[]}));
  fs.writeFileSync(path.join(configRoot, "projects.json"), JSON.stringify({projects:[]}));
  const original = path.join(home, ".local", "share", "opencode", "opencode.db");
  openCodeSource(original);
  const first = createTestDatabase(), second = createTestDatabase();
  temporary.push(first.directory, second.directory);
  initializeEngineSchema(first.dbPath); initializeEngineSchema(second.dbPath);
  const env = {
    TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_CONFIG: configRoot, TOKENATLAS_LOCAL_STATE: localState,
    TOKENATLAS_MACHINE: "BOOTSTRAP-PC", TOKENATLAS_LOGIN: "fixture", TOKENATLAS_FROZEN_CONFIG: "1",
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
  };
  const base = {trigger:"auto",scope:{kind:"vendor",vendor:"opencode"},mode:"incremental"};
  const collected = await run(first.dbPath, {...base,collection:"mirror-only",bootstrapRecoveryId:"database-a"}, env);
  expect(collected.status).toBe("success");
  expect(collected.vendors[0]?.processedInputs).toBeGreaterThan(0);
  const archived = path.join(archiveRoot, "opencode", "BOOTSTRAP-PC", "opencode.sqlite");
  expect(fs.existsSync(archived)).toBe(true);
  const firstImport = await run(first.dbPath, {...base,collection:"archive",bootstrapRecoveryId:"database-a"}, env);
  expect(firstImport.status, JSON.stringify(firstImport)).toBe("success");
  fs.rmSync(archived);
  const recollected = await run(second.dbPath, {...base,collection:"mirror-only",bootstrapRecoveryId:"database-b"}, env);
  expect(recollected.status, JSON.stringify(recollected)).toBe("success");
  expect(recollected.vendors[0]?.processedInputs).toBeGreaterThan(0);
  expect(fs.existsSync(archived)).toBe(true);
  const pending = new Database(second.dbPath);
  try { pending.query("INSERT INTO meta(key,value) VALUES(?,?)").run("atlas_bootstrap_recovery_id", "database-b"); }
  finally { pending.close(true); }
  const disconnected = `${archiveRoot}-disconnected`;
  fs.renameSync(archiveRoot, disconnected);
  for(const collection of ["mirror-only","archive"]) {
    const unavailable = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "runner.ts"), JSON.stringify({
        dbPath: second.dbPath, rootDir: process.cwd(), request: {...base,collection,bootstrapRecoveryId:"database-b"},
      })], cwd: process.cwd(), env: {...process.env,...env}, stdout:"pipe", stderr:"pipe",
    });
    const [unavailableExit, unavailableError] = await Promise.all([unavailable.exited,new Response(unavailable.stderr).text()]);
    expect(unavailableExit).not.toBe(0);
    expect(unavailableError).toContain("Configured source archive is unavailable");
    expect(fs.existsSync(archiveRoot)).toBe(false);
  }
  const stillPending = new Database(second.dbPath,{readonly:true});
  try { expect(stillPending.query("SELECT value FROM meta WHERE key='atlas_bootstrap_recovery_id'").get()).toEqual({value:"database-b"}); }
  finally { stillPending.close(true); }
  fs.renameSync(disconnected, archiveRoot);
  fs.rmSync(original);
  const secondImport = await run(second.dbPath, {...base,collection:"archive",bootstrapRecoveryId:"database-b"}, env);
  expect(secondImport.status, JSON.stringify(secondImport)).toBe("success");
  const sqlite = new Database(second.dbPath, { readonly:true });
  try { expect((sqlite.query("SELECT COUNT(*) AS n FROM oc_events").get() as {n:number}).n).toBe(1); }
  finally { sqlite.close(true); }
  expect((await run(second.dbPath, {...base,collection:"archive",bootstrapRecoveryId:"database-b"}, env)).vendors).toEqual([]);
}, 30_000);

test("stale legacy review resumes two-date Codex archive history and a later restart does not reparse it", async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ta-bootstrap-recovery-"));temporary.push(directory);
  const archiveRoot=path.join(directory,"archive"),configRoot=path.join(directory,"config"),localState=path.join(directory,"state");
  const home=path.join(directory,"absent-home"),profile="BOOTSTRAP-PC-fixture";
  const codexHome=path.join(archiveRoot,"codex",profile);
  fs.mkdirSync(path.join(codexHome,"sessions"),{recursive:true});fs.mkdirSync(configRoot);fs.mkdirSync(localState);
  fs.writeFileSync(path.join(configRoot,"accounts.json"),JSON.stringify({version:2,subscriptions:[{id:"codex1",vendor:"codex"}],sources:[{vendor:"codex",home:codexHome}]}));
  fs.writeFileSync(path.join(configRoot,"projects.json"),JSON.stringify({projects:[]}));
  const rollout=(name:string,ts:string)=>{
    const file=path.join(codexHome,"sessions",`${name}.jsonl`);
    fs.writeFileSync(file,[
      {type:"session_meta",payload:{originator:"codex-tui",thread_source:"user",cwd:"C:/fixture"}},
      {type:"turn_context",payload:{model:"gpt-5",effort:"high",cwd:"C:/fixture"}},
      {timestamp:ts,type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:7,output_tokens:1}}}},
    ].map(row=>JSON.stringify(row)).join("\n")+"\n");return file;
  };
  rollout("recent","2026-09-26T11:00:00.000Z");
  const atlas=createTestDatabase();temporary.push(atlas.directory);initializeEngineSchema(atlas.dbPath);
  const env={TOKENATLAS_ARCHIVE:archiveRoot,TOKENATLAS_CONFIG:configRoot,TOKENATLAS_LOCAL_STATE:localState,
    TOKENATLAS_MACHINE:"BOOTSTRAP-PC",TOKENATLAS_LOGIN:"fixture",TOKENATLAS_FROZEN_CONFIG:"1",
    HOME:home,USERPROFILE:home,APPDATA:path.join(home,"AppData","Roaming")};
  const base={trigger:"auto",scope:{kind:"vendor",vendor:"codex"},mode:"incremental"};
  expect((await run(atlas.dbPath,{...base,collection:"archive",bootstrapRecoveryId:"seed-a"},env)).status).toBe("success");
  const old=rollout("historical","2025-08-10T11:00:00.000Z");
  const queue=new SyncFileQueue(archiveRoot,localState);
  try {queue.acknowledge([queue.observe(old,"codex")]);}finally{queue.close();}
  const partial=new Database(atlas.dbPath);
  try {
    expect((partial.query("SELECT COUNT(*) AS n FROM events").get() as {n:number}).n).toBe(1);
    partial.query(`INSERT INTO sync_runs(run_id,trigger,scope,mode,status,started_at,finished_at,
      before_data_revision,after_data_revision,before_config_revision,after_config_revision,result_json)
      VALUES('failed-full','auto','all','full','partial_success','2026-09-29T10:12:00Z','2026-09-29T11:05:00Z',0,0,0,0,?)`)
      .run(JSON.stringify({status:"partial_success",vendors:[
        {vendor:"codex",status:"failure",processedInputs:0,inputsComplete:false},
        {vendor:"opencode",status:"success",inputsComplete:true},
      ]}));
    partial.query(`INSERT INTO sync_runs(run_id,trigger,scope,mode,status,started_at,finished_at,
      before_data_revision,after_data_revision,before_config_revision,after_config_revision,result_json)
      VALUES('recent-only','auto','vendor','incremental','success','2026-09-29T12:00:00Z','2026-09-29T12:01:00Z',0,0,0,0,?)`)
      .run(JSON.stringify({status:"success",scope:{kind:"vendor",vendor:"codex"},vendors:[
        {vendor:"codex",status:"success",processedInputs:2,inputsComplete:true},
      ]}));
    partial.query("INSERT INTO meta(key,value) VALUES('atlas_bootstrap_legacy_reviewed','1')").run();
  } finally {partial.close(true);}
  expect(bootstrapAtlasIndex({localDbPath:atlas.dbPath,archiveRoot}).catchUpMode).toBe("full");
  expect(pendingAtlasBootstrapVendors(atlas.dbPath)).toEqual(["codex"]);
  const id=pendingAtlasBootstrapRecovery(atlas.dbPath)!;
  expect((await run(atlas.dbPath,{...base,collection:"mirror-only",bootstrapRecoveryId:id},env)).status).toBe("success");
  const recovered=await run(atlas.dbPath,{...base,collection:"archive",bootstrapRecoveryId:id},env);
  expect(recovered.status,JSON.stringify(recovered)).toBe("success");
  const restored=new Database(atlas.dbPath);
  try {
    expect(restored.query("SELECT substr(ts,1,10) AS day FROM events ORDER BY day").all()).toEqual([
      {day:"2025-08-10"},{day:"2026-09-26"},
    ]);
    finishAtlasBootstrapRecovery(restored,id);
  } finally {restored.close(true);}
  expect(bootstrapAtlasIndex({localDbPath:atlas.dbPath,archiveRoot}).catchUpMode).toBeNull();
  const unchanged=await run(atlas.dbPath,{...base,collection:"archive",bootstrapRecoveryId:id},env);
  expect(unchanged.status).toBe("success");expect(unchanged.vendors).toEqual([]);
},30_000);
