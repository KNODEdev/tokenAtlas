import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { verifySourceSqliteRead } from "../ingest/source-sqlite";
import { ingestOpencodeAsync } from "../ingest/opencode";
import { createTestDatabase } from "./test-support";
import { removeTestFixture } from "../test-cleanup";
import { ingestGeminiTargetsAsync, type AdapterContext } from "./adapters";

test("archived Gemini and OpenCode databases with a WAL header are read without sidecars in the archive", async () => {
  const f = createTestDatabase();
  const oldState=process.env.TOKENATLAS_LOCAL_STATE,oldTemp=process.env.TOKENATLAS_TEMP_DIR;
  process.env.TOKENATLAS_LOCAL_STATE=path.join(f.directory,'state');
  process.env.TOKENATLAS_TEMP_DIR=path.join(f.directory,'scratch');
  try {
    const archive = path.join(f.directory, "archive");
    const gemini = path.join(archive,"gemini","fixture","conversations","chat.db");
    const opencode = path.join(archive,"opencode","fixture","opencode.sqlite");
    for (const file of [gemini,opencode]) {
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const db = new Database(file);
      db.exec("PRAGMA journal_mode=WAL");
      if (file===gemini) {
        db.exec("CREATE TABLE gen_metadata(idx INTEGER,data BLOB)");
        db.query("INSERT INTO gen_metadata VALUES(0,?)").run(new Uint8Array([10,4,34,2,16,123]));
      } else {
        db.exec("CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)");
        db.query("INSERT INTO session VALUES('s','fixture')").run();
        db.query("INSERT INTO message VALUES('m','s',?)").run(JSON.stringify({role:"assistant",modelID:"glm-5",time:{created:Date.UTC(2026,8,1)},tokens:{input:10,output:4}}));
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");db.close();
      expect(fs.readFileSync(file)[18]).toBe(2);
    }
    // A rebuild reads the immutable archive directly without creating scratch or sidecars.
    const context:AdapterContext={activeDbPath:f.dbPath,stageDbPath:f.dbPath,mode:"full",rootDir:f.directory,rebuild:true};
    expect((await ingestGeminiTargetsAsync(context,[{profile:'fixture',store:'fixture',dir:path.dirname(gemini)}])).writtenRows).toBe(1);
    expect((await ingestOpencodeAsync(opencode,'fixture',{ archivedInput: true,atlasPath:f.dbPath,force:true})).rows).toBe(1);
    for(const file of [gemini,opencode])for(const suffix of ['-wal','-shm'])expect(fs.existsSync(file+suffix)).toBe(false);
    expect(fs.existsSync(path.join(f.directory,'scratch'))).toBe(false);
    const malformed=new Database(opencode);
    malformed.query("INSERT INTO message VALUES('bad','s','{broken')").run();malformed.close();
    await expect(ingestOpencodeAsync(opencode,'fixture',{ archivedInput: true,atlasPath:f.dbPath,force:true})).rejects.toThrow('Invalid archived OpenCode message JSON');
    expect(fs.existsSync(path.join(f.directory,'scratch'))).toBe(false);
    const check=new Database(f.dbPath,{readonly:true});
    try {expect(check.query("SELECT fresh_in,conversation_id,ts FROM gemini_events").get()).toEqual({fresh_in:123,conversation_id:'chat',ts:new Date(fs.statSync(gemini).mtimeMs).toISOString()});}
    finally {check.close();}
  } finally {
    if(oldState===undefined)delete process.env.TOKENATLAS_LOCAL_STATE;else process.env.TOKENATLAS_LOCAL_STATE=oldState;
    if(oldTemp===undefined)delete process.env.TOKENATLAS_TEMP_DIR;else process.env.TOKENATLAS_TEMP_DIR=oldTemp;
    removeTestFixture(f.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

test("native archive verification rejects changes even when metadata is unchanged", async () => {
  const f = createTestDatabase(), file = path.join(f.directory, "stable-metadata.db");
  const writer = new Database(file);
  writer.exec("CREATE TABLE records(value INTEGER); INSERT INTO records VALUES(42)"); writer.close();
  const before = fs.lstatSync(file, { bigint: true }), original = fs.lstatSync;
  try {
    await expect(verifySourceSqliteRead(file, async () => {
      const changed = new Database(file);
      try { changed.exec("UPDATE records SET value=43"); } finally { changed.close(); }
      fs.lstatSync = ((...args: Parameters<typeof original>) => args[0] === file ? before : original(...args)) as typeof original;
    })).rejects.toThrow("changed during read");
  } finally { fs.lstatSync = original; removeTestFixture(f.directory, { recursive: true, force: true }); }
});
