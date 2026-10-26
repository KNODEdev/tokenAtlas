import { afterAll, expect, spyOn, test } from "bun:test";
import { Statement } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { mergeSourceDatabase, snapshotSourceDatabase, SourceDatabaseConflict, type SourceDatabaseVendor } from "./source-database-merge";

const roots: string[] = [];
afterAll(() => { Bun.gc(true); for (const root of roots) fs.rmSync(root, {recursive: true, force: true, maxRetries: 5}); });
function fixture(vendor: SourceDatabaseVendor, extra = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-raw-merge-")); roots.push(root);
  const source = path.join(root, "source.sqlite"), archive = path.join(root, "archive.sqlite");
  const db = new Database(source, {safeIntegers: true});
  db.exec(vendor === "opencode" ? "CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);" : "CREATE TABLE gen_metadata(idx INTEGER, data BLOB); CREATE TABLE trajectory_metadata_blob(data BLOB);");
  if (extra) db.exec(extra);
  let sequence = 0;
  return {root,source,archive,db, merge(initial = false) {
    const snapshot = path.join(root, `snapshot-${++sequence}.sqlite`), output = path.join(root, `output-${sequence}.sqlite`);
    snapshotSourceDatabase(source, snapshot);
    const result = mergeSourceDatabase({snapshot, archive: initial ? null : archive, output, vendor});
    if (result.status === "updated") fs.copyFileSync(output, archive);
    return {result, output};
  }};
}
function rows(file: string, sql: string): unknown[][] {
  const db = new Database(file, {readonly: true, safeIntegers: true});
  try { return db.query(sql).values(); } finally {db.close(true);}
}

test("OpenCode stable IDs retain vanished rows, accept corrections, and produce no output for semantic no-op", () => {
  const f = fixture("opencode");
  try {
    f.db.exec("INSERT INTO session VALUES ('s1','one'),('s2','two'); INSERT INTO message VALUES ('m1','s1','old'),('m2','s2','retained');");
    expect(f.merge(true).result).toEqual({status:"updated",inserted:4,corrected:0,retained:0});
    const before = fs.statSync(f.archive);
    const noop = f.merge();
    expect(noop.result.status).toBe("unchanged");
    expect(fs.existsSync(noop.output)).toBeFalse();
    expect(fs.statSync(f.archive).mtimeMs).toBe(before.mtimeMs);
    f.db.exec("DELETE FROM session WHERE id='s2'; DELETE FROM message WHERE id='m2'; UPDATE message SET data='corrected' WHERE id='m1'; INSERT INTO message VALUES ('m3','s1','new');");
    expect(f.merge().result).toEqual({status:"updated",inserted:1,corrected:1,retained:2});
    expect(rows(f.archive,"SELECT id,session_id,data FROM message ORDER BY id")).toEqual([["m1","s1","corrected"],["m2","s2","retained"],["m3","s1","new"]]);
    expect(rows(f.archive,"SELECT id FROM session ORDER BY id")).toEqual([["s1"],["s2"]]);
    expect(f.merge().result).toEqual({status:"unchanged",inserted:0,corrected:0,retained:2});
  } finally {f.db.close(true);}
});

test("initial snapshot preserves all source tables, schema, BLOBs, int64 and committed WAL contents", () => {
  const f = fixture("opencode", "CREATE TABLE unknown(id TEXT PRIMARY KEY, raw BLOB, huge INTEGER, real_value REAL, nullable TEXT); CREATE INDEX unknown_raw ON unknown(raw); CREATE VIEW unknown_view AS SELECT * FROM unknown; PRAGMA user_version=17; PRAGMA application_id=35;");
  try {
    f.db.exec("PRAGMA journal_mode=WAL; INSERT INTO session VALUES ('s','repo'); INSERT INTO message VALUES ('m','s','json');");
    f.db.query("INSERT INTO unknown VALUES (?,?,?,?,NULL)").run("opaque",Buffer.from([0,255,127]),9223372036854775807n,1.125);
    f.merge(true);
    expect(rows(f.archive,"SELECT * FROM unknown")).toEqual([["opaque",new Uint8Array([0,255,127]),9223372036854775807n,1.125,null]]);
    expect(rows(f.archive,"SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")).toEqual(rows(f.source,"SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name"));
    expect(rows(f.archive,"PRAGMA user_version")).toEqual([[17n]]);
    expect(rows(f.archive,"PRAGMA application_id")).toEqual([[35n]]);
    expect(f.merge().result.status).toBe("unchanged");
    f.db.exec("UPDATE message SET data='correction';");
    f.merge();
    expect(rows(f.archive,"SELECT huge,hex(raw),typeof(huge),typeof(real_value) FROM unknown")).toEqual([[9223372036854775807n,"00FF7F","integer","real"]]);
  } finally {f.db.close(true);}
});

test("unknown table mutation, deletion and duplicate multiplicity fail closed without losing its raw rows", () => {
  const f = fixture("opencode", "CREATE TABLE unknown(raw BLOB);");
  try {
    f.db.exec("INSERT INTO unknown VALUES (X'01'),(X'01');"); f.merge(true);
    const before = fs.readFileSync(f.archive);
    f.db.exec("DELETE FROM unknown WHERE rowid=1;");
    expect(() => f.merge()).toThrow("unsupported-table-change");
    expect(fs.readFileSync(f.archive)).toEqual(before);
    expect(fs.readdirSync(f.root).filter(name => name.startsWith("output-"))).toEqual(["output-1.sqlite"]);
    f.db.exec("INSERT INTO unknown VALUES (X'01'); UPDATE unknown SET raw=X'02' WHERE rowid=2;");
    expect(() => f.merge()).toThrow("unsupported-table-change");
    expect(fs.readFileSync(f.archive)).toEqual(before);
  } finally {f.db.close(true);}
});

test("schema additions, removed tables and declared type changes require explicit migration", () => {
  for (const change of ["ALTER TABLE message ADD COLUMN extra TEXT", "DROP TABLE message", "DROP TABLE message; CREATE TABLE message(id INTEGER PRIMARY KEY,session_id TEXT,data TEXT)", "CREATE TABLE future(raw BLOB)", "PRAGMA user_version=1"]) {
    const f = fixture("opencode");
    try {
      f.merge(true); const before = fs.readFileSync(f.archive);
      f.db.exec(change);
      expect(() => f.merge()).toThrow("unsupported-schema");
      expect(fs.readFileSync(f.archive)).toEqual(before);
    } finally {f.db.close(true);}
  }
});

test("Gemini accepts proven append and last ordinal completion, retaining an unchanged shorter prefix", () => {
  const f = fixture("gemini");
  try {
    f.db.exec("INSERT INTO gen_metadata VALUES (0,X'00'),(1,X'01'); INSERT INTO trajectory_metadata_blob VALUES (X'05');");
    f.merge(true);
    f.db.exec("UPDATE gen_metadata SET data=X'02' WHERE idx=1; INSERT INTO gen_metadata VALUES (2,X'03'); UPDATE trajectory_metadata_blob SET data=X'06';");
    expect(f.merge().result).toEqual({status:"updated",inserted:1,corrected:2,retained:0});
    expect(rows(f.archive,"SELECT idx,hex(data) FROM gen_metadata ORDER BY idx")).toEqual([[0n,"00"],[1n,"02"],[2n,"03"]]);
    f.db.exec("DELETE FROM gen_metadata WHERE idx>0; DELETE FROM trajectory_metadata_blob;");
    expect(f.merge().result).toEqual({status:"unchanged",inserted:0,corrected:0,retained:3});
  } finally {f.db.close(true);}
});

test("Gemini rejects ordinal reuse, filling earlier gaps, ambiguous shrink+append and duplicate ordinals", () => {
  for (const change of ["DELETE FROM gen_metadata WHERE idx=0; UPDATE gen_metadata SET data=X'07' WHERE idx=2", "UPDATE gen_metadata SET data=X'07' WHERE idx=0", "INSERT INTO gen_metadata VALUES (1,X'08')", "DELETE FROM gen_metadata WHERE idx=0; INSERT INTO gen_metadata VALUES (3,X'08')", "INSERT INTO gen_metadata VALUES (2,X'08')"]) {
    const f = fixture("gemini");
    try {
      f.db.exec("INSERT INTO gen_metadata VALUES (0,X'00'),(2,X'02');"); f.merge(true);
      const before = fs.readFileSync(f.archive);
      f.db.exec(change);
      expect(() => f.merge()).toThrow(SourceDatabaseConflict);
      expect(fs.readFileSync(f.archive)).toEqual(before);
    } finally {f.db.close(true);}
  }
});

test("invalid key types, non-BLOB Gemini payloads and ambiguous singleton metadata are refused initially", () => {
  for (const statement of ["INSERT INTO gen_metadata VALUES (NULL,X'00')", "INSERT INTO gen_metadata VALUES (1.5,X'00')", "INSERT INTO gen_metadata VALUES (-1,X'00')", "INSERT INTO gen_metadata VALUES (0,'not a blob')", "INSERT INTO trajectory_metadata_blob VALUES (X'01'),(X'02')"]) {
    const f = fixture("gemini");
    try {f.db.exec(statement); expect(() => f.merge(true)).toThrow("invalid-source-value"); expect(fs.existsSync(f.archive)).toBeFalse();} finally {f.db.close(true);}
  }
});

test("provider triggers are preserved but never replayed by the archive merge", () => {
  const f = fixture("opencode", "CREATE TABLE side_effect(id TEXT); CREATE TRIGGER provider_effect AFTER UPDATE ON message BEGIN INSERT INTO side_effect VALUES(new.id); END;");
  try {
    f.db.exec("INSERT INTO message VALUES ('m','s','before');"); f.merge(true);
    f.db.exec("DROP TRIGGER provider_effect; UPDATE message SET data='after'; CREATE TRIGGER provider_effect AFTER UPDATE ON message BEGIN INSERT INTO side_effect VALUES(new.id); END;");
    expect(f.merge().result.status).toBe("updated");
    expect(rows(f.archive,"SELECT * FROM side_effect")).toEqual([]);
    expect(rows(f.archive,"SELECT name FROM sqlite_schema WHERE type='trigger'")).toEqual([["provider_effect"]]);
  } finally {f.db.close(true);}
});

test("provider REPLACE constraints cannot silently evict retained rows", () => {
  const f = fixture("opencode", "DROP TABLE message; CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT UNIQUE ON CONFLICT REPLACE);");
  try {
    f.db.exec("INSERT INTO message VALUES ('m1','s','same');"); f.merge(true);
    f.db.exec("DELETE FROM message; INSERT INTO message VALUES ('m2','s','same');");
    const before = fs.readFileSync(f.archive);
    expect(() => f.merge()).toThrow("Provider constraints or generated values changed raw rows");
    expect(fs.readFileSync(f.archive)).toEqual(before);
    expect(fs.existsSync(path.join(f.root,"output-2.sqlite"))).toBeFalse();
  } finally {f.db.close(true);}
});

test("all declared OpenCode raw conversation tables merge by stable or composite keys", () => {
  const textTables = ["project","part","workspace","event","session_message","session_input","permission"];
  const extra = textTables.map(name => `CREATE TABLE ${name}(id TEXT PRIMARY KEY,data TEXT);`).join("") +
    "CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,sequence INTEGER); CREATE TABLE session_context_epoch(session_id TEXT PRIMARY KEY,epoch INTEGER);" +
    "CREATE TABLE project_directory(project_id TEXT,directory TEXT,data TEXT,PRIMARY KEY(project_id,directory)); CREATE TABLE todo(session_id TEXT,position INTEGER,data TEXT,PRIMARY KEY(session_id,position));";
  const f = fixture("opencode",extra);
  try {
    for (const name of textTables) f.db.exec(`INSERT INTO ${name} VALUES ('old','before'),('retained','keep');`);
    f.db.exec("INSERT INTO event_sequence VALUES ('agg',1); INSERT INTO session_context_epoch VALUES ('session',1); INSERT INTO project_directory VALUES ('project','C:/repo','before'); INSERT INTO todo VALUES ('session',0,'before'),('session',1,'retained');");
    f.merge(true);
    for (const name of textTables) f.db.exec(`UPDATE ${name} SET data='after' WHERE id='old'; DELETE FROM ${name} WHERE id='retained'; INSERT INTO ${name} VALUES ('new','append');`);
    f.db.exec("UPDATE event_sequence SET sequence=2; UPDATE session_context_epoch SET epoch=2; UPDATE project_directory SET data='after'; INSERT INTO project_directory VALUES ('project','D:/repo','append'); UPDATE todo SET data='after' WHERE position=0; DELETE FROM todo WHERE position=1; INSERT INTO todo VALUES ('other',0,'distinct');");
    expect(f.merge().result.status).toBe("updated");
    for (const name of textTables) expect(rows(f.archive,`SELECT id,data FROM ${name} ORDER BY id`)).toEqual([["new","append"],["old","after"],["retained","keep"]]);
    expect(rows(f.archive,"SELECT * FROM todo ORDER BY session_id,position")).toEqual([["other",0n,"distinct"],["session",0n,"after"],["session",1n,"retained"]]);
    expect(rows(f.archive,"SELECT * FROM project_directory ORDER BY directory")).toEqual([["project","C:/repo","after"],["project","D:/repo","append"]]);
    expect(rows(f.archive,"SELECT sequence FROM event_sequence")).toEqual([[2n]]);
    expect(rows(f.archive,"SELECT epoch FROM session_context_epoch")).toEqual([[2n]]);
    expect(f.merge().result.status).toBe("unchanged");
  } finally {f.db.close(true);}
});

test("credentials retain only schema, with no payloads or deleted-page remnants; existing archives are scrubbed", () => {
  const excluded = ["account","control_account","account_state","credential","session_share"];
  const marker = "SYNTHETIC-CREDENTIAL-MUST-NEVER-BE-PUBLISHED";
  const f = fixture("opencode",excluded.map(name=>`CREATE TABLE ${name}(id TEXT PRIMARY KEY,value TEXT);`).join(""));
  try {
    for (const name of excluded) f.db.query(`INSERT INTO ${name} VALUES ('id',?)`).run(marker);
    f.db.exec("INSERT INTO message VALUES ('m','s','conversation-preserved');");
    expect(f.merge(true).result.excludedTables?.sort()).toEqual(excluded.sort());
    for (const name of excluded) expect(rows(f.archive,`SELECT COUNT(*) FROM ${name}`)).toEqual([[0n]]);
    expect(fs.readFileSync(f.archive).includes(Buffer.from(marker))).toBeFalse();
    expect(rows(f.archive,"SELECT data FROM message")).toEqual([["conversation-preserved"]]);
    // Simulate an archive accepted by the superseded unfiltered copier.
    const old = new Database(f.archive);
    try {old.query("INSERT INTO credential VALUES ('legacy',?)").run(marker);} finally {old.close(true);}
    expect(f.merge().result.status).toBe("updated");
    expect(fs.readFileSync(f.archive).includes(Buffer.from(marker))).toBeFalse();
    expect(f.merge().result.status).toBe("unchanged");
  } finally {f.db.close(true);}
});

test("unknown credential column names prevent even the first output snapshot", () => {
  for (const name of ["access_token","refresh_token","password","api_key","secret"]) {
    const f = fixture("opencode",`CREATE TABLE future_auth(id TEXT, ${name} TEXT); INSERT INTO future_auth VALUES ('id','synthetic-secret');`);
    try {
      expect(()=>f.merge(true)).toThrow("sensitive-source-schema");
      expect(fs.existsSync(f.archive)).toBeFalse();
      const target = path.join(f.root,"sanitized.sqlite");
      expect(()=>snapshotSourceDatabase(f.source,target,"opencode")).toThrow("sensitive-source-schema");
      expect(fs.existsSync(target)).toBeFalse();
    } finally {f.db.close(true);}
  }
});

test("an unsupported change with an old credential-bearing archive reports the explicit cleanup requirement", () => {
  const f = fixture("opencode","CREATE TABLE credential(id TEXT,value TEXT); CREATE TABLE future(raw TEXT);");
  try {
    f.merge(true);
    const old = new Database(f.archive); try {old.exec("INSERT INTO credential VALUES ('id','synthetic-secret');");} finally {old.close(true);}
    const before = fs.readFileSync(f.archive);
    f.db.exec("INSERT INTO future VALUES ('new');");
    expect(()=>f.merge()).toThrow("existing archive credential rows require explicit cleanup");
    expect(fs.readFileSync(f.archive)).toEqual(before);
  } finally {f.db.close(true);}
});

test("large known and unknown BLOB tables stay inside SQLite during no-op, correction and retention", () => {
  const f = fixture("opencode", "CREATE TABLE part(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE opaque(raw BLOB);");
  try {
    f.db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<16) INSERT INTO part SELECT printf('p%02d',i),zeroblob(1048576) FROM n; INSERT INTO opaque SELECT data FROM part;");
    // Reject payload materialization at the driver boundary, independent of GC/RSS timing.
    const inspect = (value: unknown): void => {
      if (value instanceof Uint8Array) throw new Error("Raw BLOB escaped SQLite into JavaScript");
      if (typeof value === "string" && value.length > 4096) throw new Error("Large payload escaped SQLite into JavaScript");
      if (value && typeof value === "object") for (const child of Object.values(value)) inspect(child);
    };
    const guards = (["all", "values", "get"] as const).map(method => {
      const original = Statement.prototype[method];
      return spyOn(Statement.prototype,method).mockImplementation(function(this: Statement, ...args: unknown[]) {
        const result = Reflect.apply(original,this,args);
        inspect(result);
        return result;
      });
    });
    try {
      expect(f.merge(true).result.inserted).toBe(32);
      expect(f.merge().result.status).toBe("unchanged");
      f.db.exec("DELETE FROM part WHERE id='p16'; UPDATE part SET data=randomblob(1048576) WHERE id='p01';");
      expect(f.merge().result).toEqual({status:"updated",inserted:0,corrected:1,retained:1});
      expect(f.merge().result.status).toBe("unchanged");
    } finally {for (const guard of guards) guard.mockRestore();}
    expect(rows(f.archive,"SELECT COUNT(*),SUM(length(data)) FROM part")).toEqual([[16n,16777216n]]);
  } finally {f.db.close(true);}
}, 30_000);

test("unknown multiset comparison preserves storage types, binary text and duplicate counts", () => {
  for (const change of ["UPDATE opaque SET raw=1.0 WHERE typeof(raw)='integer'", "UPDATE opaque SET raw='A' WHERE raw COLLATE BINARY='a'"]) {
    const f = fixture("opencode","CREATE TABLE opaque(raw COLLATE NOCASE); INSERT INTO opaque VALUES (1),(1.0),('a'),('A');");
    try {
      f.merge(true);
      expect(f.merge().result.status).toBe("unchanged");
      f.db.exec(change);
      expect(()=>f.merge()).toThrow("unsupported-table-change");
    } finally {f.db.close(true);}
  }
});

test("AUTOINCREMENT high-water marks survive append, shrink and ANALYZE without hiding raw tables", () => {
  const f=fixture("opencode","DROP TABLE message; CREATE TABLE message(slot INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,session_id TEXT,data TEXT); CREATE INDEX message_session ON message(session_id);");
  try {
    f.db.exec("INSERT INTO message(id,session_id,data) VALUES ('m1','s','old');");f.merge(true);
    f.db.exec("INSERT INTO message(id,session_id,data) VALUES ('m2','s','new'); ANALYZE;");
    expect(f.merge().result.status).toBe("updated");
    expect(rows(f.archive,"SELECT seq FROM sqlite_sequence WHERE name='message'")).toEqual([[2n]]);
    expect(rows(f.archive,"SELECT name FROM sqlite_schema WHERE name='message_session'")).toEqual([["message_session"]]);
    expect(rows(f.archive,"SELECT COUNT(*) FROM sqlite_stat1")[0]![0]).toBeGreaterThan(0n);
    f.db.exec("DELETE FROM message WHERE id='m2'; UPDATE sqlite_sequence SET seq=1; ANALYZE;");
    expect(f.merge().result.status).toBe("unchanged");
    expect(rows(f.archive,"SELECT seq FROM sqlite_sequence WHERE name='message'")).toEqual([[2n]]);
    f.db.exec("UPDATE sqlite_sequence SET seq=9;");
    expect(f.merge().result.status).toBe("updated");
    expect(rows(f.archive,"SELECT seq FROM sqlite_sequence WHERE name='message'")).toEqual([[9n]]);
  } finally {f.db.close(true);}
});

test("readonly WAL snapshots recover missing SHM in a writable directory", () => {
  const f=fixture("gemini");
  try {
    f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO gen_metadata VALUES(0,X'00FF');");
    const copy=path.join(f.root,"without-shm.db"),snapshot=path.join(f.root,"recovered.db");
    fs.copyFileSync(f.source,copy);fs.copyFileSync(f.source+"-wal",copy+"-wal");
    expect(fs.existsSync(copy+"-shm")).toBeFalse();
    snapshotSourceDatabase(copy,snapshot,"gemini");
    expect(rows(snapshot,"SELECT idx,hex(data) FROM gen_metadata")).toEqual([[0n,"00FF"]]);
  } finally {f.db.close(true);}
});

test("FTS shadow tables retain their unsupported raw identity contract", () => {
  const f=fixture("opencode","CREATE VIRTUAL TABLE search USING fts5(body); INSERT INTO search VALUES ('preserved');");
  try {
    f.merge(true);f.db.exec("INSERT INTO search VALUES ('new');");
    expect(()=>f.merge()).toThrow('unsupported-table-change');
    expect(rows(f.archive,"SELECT body FROM search")).toEqual([['preserved']]);
  } finally {f.db.close(true);}
});

test("realistic Gemini raw schema appends all ordinal tables and completes only their last rows", () => {
  const f=fixture("gemini",`DROP TABLE gen_metadata; CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB,size INTEGER);
    CREATE TABLE trajectory_meta(trajectory_id TEXT PRIMARY KEY,cascade_id TEXT,trajectory_type INTEGER,source INTEGER);
    CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,has_subtrajectory NUMERIC,metadata BLOB,error_details BLOB,permissions BLOB,task_details BLOB,render_info BLOB,step_payload BLOB,step_format INTEGER);
    CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE parent_references(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE battle_mode_infos(idx INTEGER PRIMARY KEY,data BLOB);
    DROP TABLE trajectory_metadata_blob; CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY DEFAULT 'main',data BLOB);`);
  const ordinalTables=['gen_metadata','executor_metadata','parent_references','battle_mode_infos'];
  try {
    f.db.exec("INSERT INTO trajectory_meta VALUES ('conversation','cascade',1,1); INSERT INTO trajectory_metadata_blob(data) VALUES(X'00'); INSERT INTO steps(idx,step_payload) VALUES(0,X'00'),(1,X'01');");
    for(const name of ordinalTables)f.db.exec(`INSERT INTO ${name}(idx,data) VALUES(0,X'00'),(1,X'01');`);
    f.merge(true);
    f.db.exec("UPDATE trajectory_meta SET source=2; UPDATE trajectory_metadata_blob SET data=X'02'; UPDATE steps SET status=1,step_payload=X'02' WHERE idx=1; INSERT INTO steps(idx,step_payload) VALUES(2,X'03');");
    for(const name of ordinalTables)f.db.exec(`UPDATE ${name} SET data=X'02' WHERE idx=1; INSERT INTO ${name}(idx,data) VALUES(2,X'03');`);
    expect(f.merge().result).toMatchObject({status:'updated',inserted:5,corrected:7,retained:0});
    for(const name of [...ordinalTables,'steps'])expect(rows(f.archive,`SELECT COUNT(*) FROM ${name}`)).toEqual([[3n]]);
    expect(f.merge().result.status).toBe('unchanged');
    f.db.exec("UPDATE executor_metadata SET data=X'09' WHERE idx=0;");
    expect(()=>f.merge()).toThrow('ordinal-identity-reuse');
    f.db.exec("UPDATE executor_metadata SET data=X'00' WHERE idx=0; UPDATE trajectory_meta SET trajectory_id='other-conversation';");
    expect(()=>f.merge()).toThrow('Conversation identity changed');
  } finally {f.db.close(true);}
});
