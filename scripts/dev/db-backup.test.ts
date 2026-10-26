import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../../src/db/sqlite";
import { backupSqlite } from "./db-backup";

test("OpenCode backup retains vanished rows, corrects stable IDs and skips unchanged snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-backup-"));
  const archiveRoot = path.join(root,"archive"), source = path.join(root,"source.sqlite"), destination = path.join(archiveRoot,"opencode","PC","opencode.sqlite");
  const env = {TOKENATLAS_LOCAL_STATE:path.join(root,"state"),TOKENATLAS_CONFIG:path.join(root,"config"),TOKENATLAS_TEMP_DIR:path.join(root,"temp")};
  const db = new Database(source);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); INSERT INTO session VALUES ('s','repo'); INSERT INTO message VALUES ('a','s','old'),('b','s','retained');");
    expect(backupSqlite(source,destination,{archiveRoot,env})).toMatchObject({status:"created",stable:true});
    db.exec("UPDATE message SET data='corrected' WHERE id='a'; DELETE FROM message WHERE id='b'; INSERT INTO message VALUES ('c','s','new');");
    expect(backupSqlite(source,destination,{archiveRoot,env}).status).toBe("created");
    expect(backupSqlite(source,destination,{archiveRoot,env,force:true}).status).toBe("unchanged");
    fs.rmSync(env.TOKENATLAS_TEMP_DIR,{recursive:true});
    expect(backupSqlite(source,destination,{archiveRoot,env}).status).toBe("unchanged");
    expect(fs.existsSync(env.TOKENATLAS_TEMP_DIR)).toBeFalse();
    const archived = new Database(destination,{readonly:true});
    try {expect(archived.query("SELECT id,data FROM message ORDER BY id").values()).toEqual([["a","corrected"],["b","retained"],["c","new"]]);} finally {archived.close(true);}
    expect(fs.existsSync(path.join(archiveRoot,".source-versions"))).toBeFalse();
    db.close(true); fs.unlinkSync(source);
    expect(backupSqlite(source,destination,{archiveRoot,env})).toMatchObject({status:"unchanged",stable:false});
  } finally {try {db.close(true);} catch {} fs.rmSync(root,{recursive:true,force:true,maxRetries:5});}
});
