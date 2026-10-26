import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { ingestClaude } from "./claude";
import { ingestGrokAsync } from "./grok";
import { ingestGeminiAsync } from "./gemini";
import { ingestGaugesAsync } from "./gauges";

const directories: string[] = [];
afterAll(() => { Bun.gc(true); for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
test("exact-file importers do not enumerate unrelated directories and match full reference after correction", async () => {
  const target = createTestDatabase(), reference = createTestDatabase();
  directories.push(target.directory, reference.directory);
  const root = path.join(target.directory, "sources");
  const claude = path.join(root, "claude", "session.jsonl");
  const grok = path.join(root, "grok", "repo", "session", "updates.jsonl");
  const gemini = path.join(root, "gemini", "conversation.db");
  const gauge = path.join(root, "gauges", "remote", "probe_windows.jsonl");
  for (const file of [claude, grok, gemini, gauge]) fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (tokens: number) => {
    fs.writeFileSync(claude, JSON.stringify({type:"assistant",sessionId:"session",timestamp:"2025-01-10T10:00:00Z",message:{id:"call",model:"claude-sonnet",usage:{input_tokens:tokens,output_tokens:1}}})+"\n");
    fs.writeFileSync(grok, JSON.stringify({params:{sessionId:"s",_meta:{agentTimestampMs:1736503200000},update:{prompt_id:"p",usage:{modelUsage:{grok:{inputTokens:tokens,outputTokens:1}}}}}})+"\n");
    const db = new Database(gemini, { create: true });
    db.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    db.query("INSERT OR REPLACE INTO gen_metadata VALUES (0, ?)").run(Buffer.from([10,4,34,2,16,tokens]));
    db.close(true);
  };
  fs.writeFileSync(gauge, JSON.stringify({provider:"codex",subject:"fixture",ts:"2025-01-10T10:00:00Z",kind:"primary",reported_percent_side:"used",used_percent:7,machine:"remote"})+"\n");
  const run = async (dbPath: string, selected: boolean, force = false) => {
    const c = await ingestClaude({dbPath,skipMigrations:true,path:path.dirname(claude),files:selected?[claude]:undefined,force});
    const g = (await ingestGrokAsync(path.join(root,"grok"),"fixture",{atlasPath:dbPath,files:selected?[grok]:undefined,force}));
    const m = (await ingestGeminiAsync(path.dirname(gemini),"fixture",{ archivedInput: true,atlasPath:dbPath,files:selected?[gemini]:undefined,force}));
    const p = (await ingestGaugesAsync({atlasPath:dbPath,archiveRoot:root,ownStore:"local",files:selected?[gauge]:undefined,force}));
    return [c.processed,g.files,m.files,p.rows];
  };
  write(10);
  const readdir = spyOn(fs,"readdirSync").mockImplementation(() => { throw new Error("Unexpected source directory scan"); });
  try {
    expect(await run(target.dbPath,true)).toEqual([1,1,1,1]);
    expect(await run(target.dbPath,true)).toEqual([0,0,0,0]);
    write(20);
    expect(await run(target.dbPath,true,true)).toEqual([1,1,1,0]);
    await ingestClaude({dbPath:target.dbPath,skipMigrations:true,files:[]});
    (await ingestGrokAsync("unavailable","fixture",{atlasPath:target.dbPath,files:[]}));
    (await ingestGeminiAsync("unavailable","fixture",{ archivedInput: true,atlasPath:target.dbPath,files:[]}));
    (await ingestGaugesAsync({atlasPath:target.dbPath,archiveRoot:"unavailable",force:false,files:[]}));
    expect(readdir).not.toHaveBeenCalled();
  } finally { readdir.mockRestore(); }
  fs.copyFileSync(claude, claude.replace(".jsonl", `.conflict-${"a".repeat(64)}.jsonl`));
  fs.copyFileSync(gemini, gemini.replace(".db", `.conflict-${"a".repeat(64)}.db`));
  await run(reference.dbPath,false);
  const a = new Database(target.dbPath), b = new Database(reference.dbPath);
  try {
    for (const sql of ["SELECT call_id,ts,in_uncached,out_total FROM claude_events", "SELECT session_id,ts,in_tok,out_tok FROM grok_events", "SELECT conversation_id,ts,fresh_in FROM gemini_events",
      "SELECT provider,subject,ts,kind,used_percent FROM probe_windows",
      "SELECT store,path,size,offset FROM gauge_files ORDER BY store,path"])
      expect(a.query(sql).all()).toEqual(b.query(sql).all());
    const before = a.query("SELECT * FROM grok_files").all();
    fs.unlinkSync(grok);
    await expect(ingestGrokAsync(path.join(root,"grok"),"fixture",{atlasPath:target.dbPath,files:[grok]})).rejects.toThrow();
    expect(a.query("SELECT * FROM grok_files").all()).toEqual(before);
  } finally { a.close(true); b.close(true); }
});

test("queued Claude archives infer desktop and live stores without discovery", async () => {
  const fixture = createTestDatabase(); directories.push(fixture.directory);
  const archiveRoot = path.join(fixture.directory, "archive");
  const files = ["PC", "PC-desktop"].map(profile => {
    const file = path.join(archiveRoot,"claude",profile,"session.jsonl");
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({type:"assistant",sessionId:"s",timestamp:"2025-01-10T10:00:00Z",message:{id:profile,model:"claude-sonnet",usage:{input_tokens:10,output_tokens:1}}})+"\n");
    return file;
  });
  const script = `import fs from "node:fs"; const {ingestClaude}=await import(${JSON.stringify(path.resolve(import.meta.dir,"claude.ts"))}); fs.readdirSync=()=>{throw new Error("Unexpected discovery")}; await ingestClaude({dbPath:${JSON.stringify(fixture.dbPath)},files:${JSON.stringify(files)},skipMigrations:true});`;
  const child = Bun.spawn([process.execPath,"--eval",script],{env:{...process.env,TOKENATLAS_ARCHIVE:archiveRoot},stdout:"pipe",stderr:"pipe"});
  const [code,,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stderr}).toEqual({code:0,stderr:""});
  const db = new Database(fixture.dbPath);
  try { expect(db.query("SELECT store,call_id FROM claude_events ORDER BY store").all()).toEqual([{store:"desktop",call_id:"PC-desktop"},{store:"live",call_id:"PC"}]); } finally {db.close(true);}
});
