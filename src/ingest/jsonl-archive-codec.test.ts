import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createTestDatabase } from "../sync/test-support";
import { Database } from "../db/sqlite";
import { ingestGrokAsync } from "./grok";
import { ingestClaude } from "./claude";
import { archiveSourceIdentity } from "../shared/archive-codec-path";
import { parseClaudeFixture } from "./native-test-support";
import { claudeAccountKey } from "./claude-identity";

const line=(value:unknown)=>JSON.stringify(value)+"\n";
const assistant=(id="call")=>({type:"assistant",sessionId:"4b486c27-4f4f-486a-a380-ba9072412f01",timestamp:"2026-09-08T12:00:00Z",
  message:{id,model:"fixture",usage:{input_tokens:10,output_tokens:1}}});

test("corrupt compressed Grok discovered without an explicit file list preserves accepted facts and bookmarks",async()=>{
  const f=createTestDatabase();
  try {
    const root=path.join(f.directory,"sessions"),file=path.join(root,"repo","session","updates.jsonl");
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,line({params:{sessionId:"session",_meta:{agentTimestampMs:Date.parse("2026-09-08T12:00:00Z")},
      update:{prompt_id:"call",usage:{modelUsage:{grok:{inputTokens:10,outputTokens:1}}}}}}));
    await ingestGrokAsync(root,"grok",{atlasPath:f.dbPath});
    const db=new Database(f.dbPath),before=db.query("SELECT * FROM grok_events").all(),bookmarks=db.query("SELECT * FROM grok_files").all();
    try {
      expect(before).toHaveLength(1);fs.unlinkSync(file);fs.writeFileSync(file+".zst","bad-frame");
      await expect(ingestGrokAsync(root,"grok",{atlasPath:f.dbPath})).rejects.toThrow();
      fs.writeFileSync(file+".zst",Bun.zstdCompressSync("{invalid}\n"));
      await expect(ingestGrokAsync(root,"grok",{atlasPath:f.dbPath})).rejects.toThrow("Invalid JSONL");
      expect(db.query("SELECT * FROM grok_events").all()).toEqual(before);expect(db.query("SELECT * FROM grok_files").all()).toEqual(bookmarks);
    } finally {db.close();}
  } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("Claude queued single name selects the longest compatible sibling in both orders without duplicate identity",async()=>{
  for(const longer of ["plain","compressed"]) {
    const f=createTestDatabase();
    try {
      const file=path.join(f.directory,"session.jsonl"),short=line(assistant("one")),long=short+line(assistant("two"));
      fs.writeFileSync(file,longer==="plain"?long:short);fs.writeFileSync(file+".zst",Bun.zstdCompressSync(longer==="compressed"?long:short));
      const selected=longer==="plain"?file+".zst":file;
      const options={dbPath:f.dbPath,files:[selected],skipMigrations:true,logicalPath:archiveSourceIdentity};
      expect(await ingestClaude(options)).toMatchObject({processed:1,writtenRows:2});
      const db=new Database(f.dbPath);try {
        expect(db.query("SELECT DISTINCT path FROM claude_events").all()).toEqual([{path:file}]);
        expect(db.query("SELECT COUNT(*) n FROM claude_files").get()).toEqual({n:1});
      }finally{db.close();}
      expect(await ingestClaude(options)).toMatchObject({processed:0,skipped:1,writtenRows:0});
      fs.writeFileSync(file+".zst",Bun.zstdCompressSync(line(assistant("different"))));
      await expect(ingestClaude(options)).rejects.toThrow("Conflicting");
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
  }
});

test("compressed Claude subagents inherit compressed parent identity; conflicting cloud parent is refused",async()=>{
  const f=createTestDatabase();
  try {
    const session=assistant().sessionId,parent=path.join(f.directory,session)+".jsonl",child=path.join(f.directory,session,"subagents","agent.jsonl");
    const account="6deed05f-c0a9-41d1-8e7f-fd5baaa36db2",org="bd47f8bf-640e-4156-ad4a-4d6650376a59";
    const owner=line({type:"bridge-session",sessionId:session,ownerAccountUuid:account,ownerOrganizationUuid:org});
    fs.mkdirSync(path.dirname(child),{recursive:true});fs.writeFileSync(parent+".zst",Bun.zstdCompressSync(owner));
    fs.writeFileSync(child+".zst",Bun.zstdCompressSync(line(assistant())));
    expect((await parseClaudeFixture("live",child+".zst"))[0]?.account_key).toBe(claudeAccountKey(account,org));
    fs.writeFileSync(parent,"{}");
    await expect(parseClaudeFixture("live",child+".zst")).rejects.toThrow("Conflicting");
  }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});
