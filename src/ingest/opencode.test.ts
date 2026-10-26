import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestOpencodeAsync } from "./opencode";
import { createTestDatabase } from "../sync/test-support";
import { removeTestFixture } from "../test-cleanup";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-opencode-"));
const snapshotPath = path.join(tempDir, "opencode.sqlite");
const atlasPath = path.join(tempDir, "atlas.sqlite");

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function createFixture(): void {
  const source = new Database(snapshotPath);
  source.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
  source.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
  source.run("INSERT INTO session VALUES (?, ?)", ["s1", "H:/repo/tokenAtlas"]);
  source.run("INSERT INTO message VALUES (?, ?, ?)", [
    "m1",
    "s1",
    JSON.stringify({
      role: "assistant",
      modelID: "glm-5",
      providerID: "zai",
      time: { created: Date.UTC(2026, 7, 28) },
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      cost: 0.01,
    }),
  ]);
  source.close();

  const atlas = new Database(atlasPath);
  atlas.exec(`CREATE TABLE oc_events (
    store TEXT NOT NULL, message_id TEXT NOT NULL, session_id TEXT, ts TEXT NOT NULL,
    model TEXT, provider TEXT, agent TEXT, mode TEXT, project TEXT NOT NULL,
    directory TEXT, in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL,
    reasoning INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    cost REAL NOT NULL, project_id TEXT,
    PRIMARY KEY (store, message_id)
  )`);
  atlas.close();
}

describe("ingestOpencodeAsync", () => {
  test("uses the same incremental/force contract as the file-based vendors", async () => {
    createFixture();

    const dirtyRange = {
      from: "2026-08-28T00:00:00.000Z",
      to: "2026-08-28T00:00:00.000Z",
    };
    expect((await ingestOpencodeAsync(snapshotPath, "pc-a", { archivedInput: true, atlasPath }))).toEqual({
      rows: 1,
      skipped: false,
      dirtyRange,
    });
    expect((await ingestOpencodeAsync(snapshotPath, "pc-a", { archivedInput: true, atlasPath }))).toEqual({
      rows: 1,
      skipped: true,
      dirtyRange: null,
    });
    const source = new Database(snapshotPath);
    source.run("UPDATE message SET data = ? WHERE id = 'm1'", [
      JSON.stringify({
        role: "assistant",
        modelID: "glm-5",
        providerID: "zai",
        time: { created: Date.UTC(2026, 1, 5) },
        tokens: { input: 10, output: 4 },
      }),
    ]);
    source.close();
    expect((await ingestOpencodeAsync(snapshotPath, "pc-a", { archivedInput: true, atlasPath, force: true }))).toEqual({
      rows: 1,
      skipped: false,
      dirtyRange: {
        from: "2026-02-05T00:00:00.000Z",
        to: "2026-08-28T00:00:00.000Z",
      },
    });

    // Production intentionally stays in WAL mode. The fixture switches back
    // before Windows removes its temporary directory.
    const cleanup = new Database(atlasPath);
    cleanup.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
    cleanup.close();
  });
});

test("snapshot reconciliation changes only changed messages and preserves annotations and rowids", async () => {
  const f=createTestDatabase(),snapshot=path.join(f.directory,"snapshot.sqlite");
  const source=new Database(snapshot),atlas=new Database(f.dbPath);
  source.exec("CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); INSERT INTO session VALUES('s','fixture')");
  const message=(tokens:number)=>JSON.stringify({role:"assistant",modelID:"glm-5",time:{created:Date.UTC(2026,7,28)},tokens:{input:tokens,output:1}});
  const insert=source.query("INSERT INTO message VALUES(?,'s',?)");
  try {
    for(const id of ["m1","m2","m3"])insert.run(id,message(10));
    (await ingestOpencodeAsync(snapshot,"pc",{ archivedInput: true,atlasPath:f.dbPath,force:true}));
    atlas.exec("UPDATE oc_events SET project_id='annotation' WHERE message_id='m1'; CREATE TABLE writes(kind TEXT,message_id TEXT)");
    for(const [kind,ref] of [["INSERT","NEW"],["UPDATE","NEW"],["DELETE","OLD"]])
      atlas.exec(`CREATE TRIGGER track_${kind} AFTER ${kind} ON oc_events BEGIN INSERT INTO writes VALUES('${kind}',${ref}.message_id); END`);
    const before=atlas.query("SELECT rowid,message_id FROM oc_events ORDER BY message_id").all();
    source.query("UPDATE message SET data=? WHERE id='m1'").run(message(20));
    source.exec("DELETE FROM message WHERE id='m3'");insert.run("m4",message(30));
    (await ingestOpencodeAsync(snapshot,"pc",{ archivedInput: true,atlasPath:f.dbPath,force:true}));
    expect(atlas.query("SELECT kind,message_id FROM writes ORDER BY kind").all())
      .toEqual([{kind:"DELETE",message_id:"m3"},{kind:"INSERT",message_id:"m4"},{kind:"UPDATE",message_id:"m1"}]);
    expect(atlas.query("SELECT rowid,message_id FROM oc_events WHERE message_id IN ('m1','m2') ORDER BY message_id").all()).toEqual(before.slice(0,2));
    expect(atlas.query("SELECT project_id,in_tok FROM oc_events WHERE message_id='m1'").get()).toEqual({project_id:"annotation",in_tok:20});
    atlas.exec("DELETE FROM writes");
    (await ingestOpencodeAsync(snapshot,"pc",{ archivedInput: true,atlasPath:f.dbPath,force:true}));
    expect(atlas.query("SELECT * FROM writes").all()).toEqual([]);
  } finally {source.close();atlas.close();removeTestFixture(f.directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
