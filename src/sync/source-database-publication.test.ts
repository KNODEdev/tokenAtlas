import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { publishSourceDatabase, SourceDatabasePublicationConflict } from "./source-database-publication";
import { archivePublicationPaths } from "./archive-publication";
import { SyncFileQueue, acceptedArchiveFingerprint } from "./file-queue";

const roots: string[] = [];
afterAll(() => {Bun.gc(true); for (const root of roots) fs.rmSync(root,{recursive:true,force:true,maxRetries:5});});
function fixture(vendor: "opencode" | "gemini" = "opencode") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"atlas-db-publish-")); roots.push(root);
  const source = path.join(root,"source.sqlite"), archiveRoot = path.join(root,"archive");
  const destination = vendor === "opencode" ? path.join(archiveRoot,"opencode","PC","opencode.sqlite") : path.join(archiveRoot,"gemini","PC","conversations","conversation.db");
  const env = {TOKENATLAS_LOCAL_STATE:path.join(root,"local"),TOKENATLAS_CONFIG:path.join(root,"config"),TOKENATLAS_TEMP_DIR:path.join(root,"scratch")};
  const options = {archiveRoot,env};
  const db = new Database(source);
  db.exec(vendor === "opencode" ? "CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); INSERT INTO session VALUES ('s','repo'); INSERT INTO message VALUES ('m','s','old');" : "CREATE TABLE gen_metadata(idx INTEGER,data BLOB); INSERT INTO gen_metadata VALUES (0,X'00'),(1,X'01');");
  const checkpoint = () => path.join(archivePublicationPaths(archiveRoot,destination,{localStateRoot:env.TOKENATLAS_LOCAL_STATE}).directory,"database-state.json");
  return {root,source,destination,archiveRoot,env,options,db,checkpoint,run:() => publishSourceDatabase(source,destination,vendor,options)};
}

test("Gemini publication appends, retains shrink, and preserves one idempotent ordinary conflict file", () => {
  const f = fixture("gemini");
  try {
    f.run();
    f.db.exec("UPDATE gen_metadata SET data=X'02' WHERE idx=1; INSERT INTO gen_metadata VALUES (2,X'03');");
    expect(f.run().status).toBe("created");
    f.db.exec("DELETE FROM gen_metadata WHERE idx=2;");
    expect(f.run().status).toBe("unchanged");
    const before = fs.readFileSync(f.destination), checkpoint = fs.readFileSync(f.checkpoint());
    f.db.exec("UPDATE gen_metadata SET data=X'09' WHERE idx=0;");
    for (let i=0;i<2;i++) expect(f.run).toThrow(SourceDatabasePublicationConflict);
    expect(fs.readFileSync(f.destination)).toEqual(before);
    expect(fs.readFileSync(f.checkpoint())).toEqual(checkpoint);
    const conflicts = fs.readdirSync(path.dirname(f.destination)).filter(name=>name.includes(".conflict-"));
    expect(conflicts).toHaveLength(1);
    const evidence = new Database(path.join(path.dirname(f.destination),conflicts[0]!),{readonly:true});
    try {expect(evidence.query("SELECT hex(data) FROM gen_metadata WHERE idx=0").values()).toEqual([["09"]]);} finally {evidence.close(true);}
    expect(fs.readdirSync(f.env.TOKENATLAS_TEMP_DIR)).toEqual([]);
  } finally {f.db.close(true);}
});

test("an empty leftover WAL beside the archive does not block publication, a WAL with frames does", () => {
  const f = fixture("gemini");
  try {
    f.run();
    // What a reader that once opened the archive in place leaves, and a cloud client keeps.
    fs.writeFileSync(`${f.destination}-wal`, "");
    fs.writeFileSync(`${f.destination}-shm`, Buffer.alloc(32768));
    expect(f.run().status).toBe("unchanged");
    f.db.exec("INSERT INTO gen_metadata VALUES (2,X'03');");
    expect(f.run().status).toBe("created");
    const accepted = fs.readFileSync(f.destination);
    fs.writeFileSync(`${f.destination}-wal`, Buffer.alloc(4096, 1));
    f.db.exec("INSERT INTO gen_metadata VALUES (3,X'04');");
    expect(f.run).toThrow(/active WAL/);
    expect(fs.readFileSync(f.destination)).toEqual(accepted);
  } finally {f.db.close(true);}
});

test("unknown schema failure preserves both raw evidence and the previous checkpoint", () => {
  const f = fixture();
  try {
    f.run(); const before = fs.readFileSync(f.destination), checkpoint = fs.readFileSync(f.checkpoint());
    f.db.exec("CREATE TABLE new_provider_data(raw BLOB); INSERT INTO new_provider_data VALUES (X'012345');");
    expect(f.run).toThrow("unsupported-schema");
    expect(fs.readFileSync(f.destination)).toEqual(before);
    expect(fs.readFileSync(f.checkpoint())).toEqual(checkpoint);
  } finally {f.db.close(true);}
});

test("a missing accepted source database requires the identical retained snapshot", () => {
  const complete=fixture();
  try {
    complete.run();const accepted=fs.readFileSync(complete.destination);
    fs.rmSync(complete.destination);
    expect(complete.run().status).toBe("created");
    expect(fs.readFileSync(complete.destination)).toEqual(accepted);
  } finally {complete.db.close(true);}

  const truncated=fixture();
  try {
    truncated.run();const checkpoint=fs.readFileSync(truncated.checkpoint());
    fs.rmSync(truncated.destination);
    truncated.db.exec("DELETE FROM message WHERE id='m'");
    expect(truncated.run).toThrow("cannot prove its accepted snapshot");
    expect(fs.existsSync(truncated.destination)).toBe(false);
    expect(fs.readFileSync(truncated.checkpoint())).toEqual(checkpoint);
  } finally {truncated.db.close(true);}
});

test("accepted queue evidence blocks missing SQLite recreation after its local checkpoint is lost", () => {
  const f=fixture();
  try {
    f.run();
    const queue=new SyncFileQueue(f.archiveRoot,f.env.TOKENATLAS_LOCAL_STATE);
    try {queue.acknowledge([queue.observe(f.destination,"opencode")]);}finally{queue.close();}
    const proof=acceptedArchiveFingerprint(f.archiveRoot,f.destination,f.env.TOKENATLAS_LOCAL_STATE);
    expect(proof).toBeTruthy();
    fs.rmSync(f.checkpoint());fs.rmSync(f.destination);
    f.db.exec("DELETE FROM message WHERE id='m'");
    expect(f.run).toThrow("previously accepted bytes have no publication checkpoint");
    expect(fs.existsSync(f.destination)).toBe(false);
    expect(acceptedArchiveFingerprint(f.archiveRoot,f.destination,f.env.TOKENATLAS_LOCAL_STATE)).toBe(proof);
  } finally {f.db.close(true);}
});

test("source changed while snapshotting never publishes or advances its checkpoint", () => {
  const f = fixture();
  try {
    f.run(); const before = fs.readFileSync(f.destination), checkpoint = fs.readFileSync(f.checkpoint());
    f.db.exec("UPDATE message SET data='requested';");
    const spawn = Bun.spawnSync;
    const spy = spyOn(Bun,"spawnSync").mockImplementation(((...args: unknown[]) => {
      const result=Reflect.apply(spawn,Bun,args);
      f.db.exec("UPDATE message SET data='concurrent source writer';");
      return result;
    }) as typeof Bun.spawnSync);
    try {expect(f.run).toThrow("changed during snapshot");} finally {spy.mockRestore();}
    expect(fs.readFileSync(f.destination)).toEqual(before);
    expect(fs.readFileSync(f.checkpoint())).toEqual(checkpoint);
    expect(f.run().status).toBe("created");
  } finally {f.db.close(true);}
});

test("destination changed during merge is never overwritten and remains pending", () => {
  const f = fixture();
  try {
    f.run(); const checkpoint = fs.readFileSync(f.checkpoint());
    f.db.exec("UPDATE message SET data='source correction';");
    const spawn = Bun.spawnSync;
    const spy = spyOn(Bun,"spawnSync").mockImplementation(((...args: unknown[]) => {
      const result=Reflect.apply(spawn,Bun,args);
      const remote = new Database(f.destination); try {remote.exec("UPDATE message SET data='remote writer';");} finally {remote.close(true);}
      return result;
    }) as typeof Bun.spawnSync);
    try {expect(f.run).toThrow("changed during reconciliation");} finally {spy.mockRestore();}
    expect(fs.readFileSync(f.checkpoint())).toEqual(checkpoint);
    const current = new Database(f.destination,{readonly:true});
    try {expect(current.query("SELECT data FROM message").values()).toEqual([["remote writer"]]);} finally {current.close(true);}
  } finally {f.db.close(true);}
});

test("restart uses only local checkpoint metadata for unchanged source, without recreating scratch", async () => {
  const f = fixture();
  try {
    f.run(); f.db.close(true);
    // Closing the source may checkpoint its WAL; establish the final closed-file stamp.
    f.run(); fs.rmSync(f.env.TOKENATLAS_TEMP_DIR,{recursive:true});
    const script = `import {publishSourceDatabase} from ${JSON.stringify(path.resolve(import.meta.dir,"source-database-publication.ts"))}; console.log(JSON.stringify(publishSourceDatabase(${JSON.stringify(f.source)},${JSON.stringify(f.destination)},"opencode",${JSON.stringify(f.options)})));`;
    const child = Bun.spawn([process.execPath,"--eval",script],{stdout:"pipe",stderr:"pipe"});
    const [code,output,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr}).toEqual({code:0,stderr:""});
    expect(JSON.parse(output)).toMatchObject({status:"unchanged",stable:true});
    expect(fs.existsSync(f.env.TOKENATLAS_TEMP_DIR)).toBeFalse();
    expect(fs.existsSync(path.join(f.archiveRoot,".source-versions"))).toBeFalse();
  } finally {try {f.db.close(true);} catch {}}
});

test("conflict evidence is sanitized and credential schema drift never copies source evidence", () => {
  const f = fixture(); const marker = "SYNTHETIC-CREDENTIAL-DO-NOT-ARCHIVE";
  try {
    f.db.exec("CREATE TABLE credential(id TEXT,secret TEXT); CREATE TABLE unknown(raw TEXT);");
    f.db.query("INSERT INTO credential VALUES ('id',?)").run(marker);
    f.run(); expect(fs.readFileSync(f.destination).includes(Buffer.from(marker))).toBeFalse();
    f.db.exec("INSERT INTO unknown VALUES ('unsupported-change');");
    expect(f.run).toThrow(SourceDatabasePublicationConflict);
    const conflicts = fs.readdirSync(path.dirname(f.destination)).filter(name=>name.includes(".conflict-"));
    expect(conflicts).toHaveLength(1);
    for (const file of conflicts) expect(fs.readFileSync(path.join(path.dirname(f.destination),file)).includes(Buffer.from(marker))).toBeFalse();
    f.db.exec("CREATE TABLE new_credentials(id TEXT,access_token TEXT);");
    expect(f.run).toThrow("NEW CHANGES TO THIS SOURCE ARE NOT ARCHIVED");
    expect(fs.readdirSync(path.dirname(f.destination)).filter(name=>name.includes(".conflict-"))).toEqual(conflicts);
  } finally {f.db.close(true);}
});

test("persistent conflicts preserve one immutable evidence file and resume only after accepted content changes", () => {
  const f=fixture();
  try {
    f.run();f.db.exec("CREATE TABLE future(raw TEXT); INSERT INTO future VALUES ('first evidence');");
    expect(f.run).toThrow(SourceDatabasePublicationConflict);
    const files=()=>fs.readdirSync(path.dirname(f.destination)).filter(name=>name.includes('.conflict-'));
    const evidence=path.join(path.dirname(f.destination),files()[0]!);const original=fs.readFileSync(evidence);
    const spawn=spyOn(Bun,"spawnSync");
    try {
      for(let i=0;i<3;i++){f.db.query("UPDATE future SET raw=?").run(`later ${i}`);expect(f.run).toThrow("NEW CHANGES TO THIS SOURCE ARE NOT ARCHIVED");}
      const time=new Date();fs.utimesSync(f.destination,time,time);
      expect(f.run).toThrow(SourceDatabasePublicationConflict);
      expect(spawn).not.toHaveBeenCalled();
    } finally {spawn.mockRestore();}
    expect(files()).toHaveLength(1);expect(fs.readFileSync(evidence)).toEqual(original);
    const accepted=new Database(f.destination);try {accepted.exec("CREATE TABLE future(raw TEXT); INSERT INTO future VALUES ('later 2');");}finally{accepted.close(true);}
    expect(f.run().status).toBe("unchanged");
    expect(fs.existsSync(path.join(path.dirname(f.checkpoint()),'database-conflict.json'))).toBeFalse();
    expect(files()).toHaveLength(1);
  } finally {f.db.close(true);}
});

test("actual SQLite child receives configured temporary environment and cleans scratch on failure", () => {
  const f=fixture();const spawn=Bun.spawnSync;let receipt:Record<string,string>|undefined;
  const spy=spyOn(Bun,"spawnSync").mockImplementation(((...args:unknown[])=>{
    const result=Reflect.apply(spawn,Bun,args);receipt=JSON.parse(result.stdout!.toString()).temporaryEnvironment;return result;
  }) as typeof Bun.spawnSync);
  try {
    f.run();
    expect(Object.keys(receipt!).sort()).toEqual(['SQLITE_TMPDIR','TEMP','TMP','TMPDIR']);
    for(const value of Object.values(receipt!))expect(path.dirname(value)).toBe(f.env.TOKENATLAS_TEMP_DIR);
    const checkpoint=fs.readFileSync(f.checkpoint()),archive=fs.readFileSync(f.destination);
    f.db.exec("CREATE TABLE forbidden(secret TEXT);");
    expect(f.run).toThrow('sensitive-source-schema');
    expect(fs.readFileSync(f.checkpoint())).toEqual(checkpoint);expect(fs.readFileSync(f.destination)).toEqual(archive);
    expect(fs.readdirSync(f.env.TOKENATLAS_TEMP_DIR)).toEqual([]);
  } finally {spy.mockRestore();f.db.close(true);}
});

test("legacy checkpoints revalidate and scrub retained archive credentials before accepting no-op", () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TABLE credential(id TEXT,value TEXT);"); f.run();
    const state = JSON.parse(fs.readFileSync(f.checkpoint(),"utf8")); state.schema = 1;
    fs.writeFileSync(f.checkpoint(),JSON.stringify(state));
    const old = new Database(f.destination); try {old.exec("INSERT INTO credential VALUES ('id','SYNTHETIC-LEGACY-SECRET');");} finally {old.close(true);}
    expect(f.run().status).toBe("created");
    expect(fs.readFileSync(f.destination).includes(Buffer.from("SYNTHETIC-LEGACY-SECRET"))).toBeFalse();
    expect(JSON.parse(fs.readFileSync(f.checkpoint(),"utf8")).schema).toBe(2);
    expect(f.run().status).toBe("unchanged");
  } finally {f.db.close(true);}
});
