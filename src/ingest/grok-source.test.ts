import { afterAll, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "../sync/test-support";
import { ensureArchiveIdentity } from "../sync/archive-inventory";
import { ingestGrokAsync } from "./grok";
import { grokSourceIdentity } from "./grok-source";

const directories:string[]=[];
afterAll(() => { Bun.gc(true); for(const directory of directories) if(path.dirname(directory)===os.tmpdir())fs.rmSync(directory,{recursive:true,force:true,maxRetries:5}); });
function fixture() { const f=createTestDatabase(); directories.push(f.directory); return f; }
function transcript(root:string,tokens=10) {
  const file=path.join(root,"repo","session","updates.jsonl"); fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({params:{sessionId:"s",_meta:{agentTimestampMs:1768042800000},update:{prompt_id:"p",usage:{modelUsage:{grok:{inputTokens:tokens,outputTokens:1}}}}}})+"\n"); return file;
}
test("Grok source collisions remain distinct and legacy exact-path reparse preserves annotations",async ()=>{
  const {directory,dbPath}=fixture(); const a=path.join(directory,"a"),b=path.join(directory,"b"); transcript(a);transcript(b,20);
  (await ingestGrokAsync(a,"grok",{atlasPath:dbPath}));
  const db=new Database(dbPath); db.exec("UPDATE grok_events SET project_id=123");
  (await ingestGrokAsync(a,"grok",{atlasPath:dbPath,sourceId:"source-a"}));
  (await ingestGrokAsync(b,"grok",{atlasPath:dbPath,sourceId:"source-b"}));
  expect(db.query("SELECT source_id,in_tok,project_id FROM grok_events ORDER BY source_id").all()).toEqual([{source_id:"source-a",in_tok:10,project_id:"123"},{source_id:"source-b",in_tok:20,project_id:null}]);
  expect((await ingestGrokAsync(a,"grok",{atlasPath:dbPath,sourceId:"source-a"})).skipped).toBe(1); db.close(true);
});
test("proven Grok replicas deduplicate exact content and reject conflicting evidence atomically",async ()=>{
  const {directory,dbPath}=fixture(); const a=path.join(directory,"a"),b=path.join(directory,"b");transcript(a);transcript(b);
  (await ingestGrokAsync(a,"grok",{atlasPath:dbPath,sourceId:"declared"}));
  (await ingestGrokAsync(b,"grok",{atlasPath:dbPath,sourceId:"declared"}));
  transcript(b,90);
  await expect(ingestGrokAsync(b,"grok",{atlasPath:dbPath,sourceId:"declared",force:true})).rejects.toThrow("Conflicting Grok replicas");
  const db=new Database(dbPath); expect(db.query("SELECT COUNT(*) AS n,SUM(in_tok) AS tokens FROM grok_events").get()).toEqual({n:1,tokens:10});db.close(true);
});
test("retained Grok profile identity survives archive relocation",async ()=>{
  const {directory,dbPath}=fixture();const before=path.join(directory,"archive"),after=path.join(directory,"moved");const root=path.join(before,"grok","profile","sessions");transcript(root);
  const archiveId=ensureArchiveIdentity(before);const sourceId=grokSourceIdentity(root,{archiveRoot:before,archiveId})!;
  (await ingestGrokAsync(root,"grok",{atlasPath:dbPath,sourceId}));fs.renameSync(before,after);
  const moved=path.join(after,"grok","profile","sessions");expect(grokSourceIdentity(moved,{archiveRoot:after,archiveId:ensureArchiveIdentity(after)})).toBe(sourceId);
  (await ingestGrokAsync(moved,"grok",{atlasPath:dbPath,sourceId}));const db=new Database(dbPath);expect(db.query("SELECT COUNT(*) AS n FROM grok_events").get()).toEqual({n:1});db.close(true);
});
