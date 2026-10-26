import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { removeTestFixture } from "../test-cleanup";
import { ensureAcceptedFacts, identityFacts, factsValue, saveAcceptedFacts, type FactsSpec } from "./accepted-facts";
import { createHash } from "node:crypto";
import { ensureRawSyncIndexes } from "../db/migrate";
import { SyncCoordinator } from "./coordinator";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

const spec: FactsSpec = { identity: ["store", "path"], tables: [{ table: "facts", order: ["store", "path", "offset"] }] };
const identities = [{ store: "pc", path: "a" }, { store: "pc", path: "b" }];

test("buffered hashing preserves the exact typed stream across large Unicode rows and chunk boundaries", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(store TEXT,path TEXT,offset INTEGER,amount,value,PRIMARY KEY(store,path,offset))");
    const insert = db.query("INSERT INTO facts VALUES('pc','a',?,?,?)");
    for (let index = 0; index < 4101; index++) insert.run(index, index % 2 ? 1.5 : 1, "ż😀\u0000".repeat(index === 20 ? 20000 : 10));
    const fields = ["store", "path", "offset", "amount", "value"];
    const rows = db.query(`SELECT json_array(${fields.map(factsValue).join(",")}) AS encoded FROM facts
      ORDER BY +store,+path,+offset,encoded`).all() as { encoded: string }[];
    const expected = createHash("sha256").update("facts\n" + rows.map(row => row.encoded + "\n").join("")).digest("hex");
    expect(identityFacts(db, "sample", spec, [identities[0]!]).byIdentity.get('["pc","a"]')).toBe(expected);
  } finally { db.close(); }
});

test("accepted digests survive restart, fall back on missing proofs and invalidate only mutated identities", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-accepted-facts-"));
  const file = path.join(directory, "trial.sqlite");
  let db = new Database(file);
  try {
    db.exec(`CREATE TABLE facts(store TEXT,path TEXT,offset INTEGER,amount,value,PRIMARY KEY(store,path,offset));
      INSERT INTO facts VALUES('pc','a',1,9223372036854775806,x'0102');
      INSERT INTO facts VALUES('pc','b',1,1,NULL)`);
    ensureAcceptedFacts(db, { sample: spec });
    const original = identityFacts(db, "sample", spec, identities, true);
    expect(original.cachedIdentities.size).toBe(0);
    expect(() => saveAcceptedFacts(db, "sample", original)).toThrow("publication transaction");
    db.transaction(() => saveAcceptedFacts(db, "sample", original)).immediate();
    db.close(); db = new Database(file);
    const restarted = identityFacts(db, "sample", spec, identities, true);
    expect(restarted.byIdentity).toEqual(original.byIdentity);
    expect(restarted.cachedIdentities.size).toBe(2);
    db.exec("UPDATE facts SET amount=9223372036854775807 WHERE path='a'");
    const corrected = identityFacts(db, "sample", spec, identities, true);
    expect(corrected.cachedIdentities).toEqual(new Set(['["pc","b"]']));
    expect(corrected.byIdentity.get('["pc","a"]')).not.toBe(original.byIdentity.get('["pc","a"]'));
    expect(corrected.byIdentity).toEqual(identityFacts(db, "sample", spec, identities).byIdentity);
    db.transaction(() => saveAcceptedFacts(db, "sample", corrected)).immediate();
    expect(() => db.transaction(() => {
      db.exec("DELETE FROM facts WHERE path='a'");
      saveAcceptedFacts(db, "sample", identityFacts(db, "sample", spec, identities, true));
      throw new Error("rollback");
    }).immediate()).toThrow("rollback");
    expect(identityFacts(db, "sample", spec, identities, true).byIdentity).toEqual(corrected.byIdentity);
    db.exec("UPDATE facts SET path='b',offset=2 WHERE path='a'");
    expect(identityFacts(db, "sample", spec, identities, true).cachedIdentities.size).toBe(0);
  } finally { db.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});

test("schema changes and a recreated table cannot retain accepted proofs", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(store TEXT,path TEXT,offset INTEGER,value); INSERT INTO facts VALUES('pc','a',1,1)");
    ensureAcceptedFacts(db, { sample: spec });
    const accept = () => db.transaction(() => saveAcceptedFacts(db, "sample", identityFacts(db, "sample", spec, identities))).immediate();
    accept();
    db.exec("ALTER TABLE facts ADD COLUMN new_evidence TEXT");
    expect(identityFacts(db, "sample", spec, identities, true).cachedIdentities.size).toBe(0);
    accept();
    db.exec("DROP TABLE facts; CREATE TABLE facts(store TEXT,path TEXT,offset INTEGER,value,new_evidence TEXT)");
    ensureAcceptedFacts(db, { sample: spec });
    expect(identityFacts(db, "sample", spec, identities, true).cachedIdentities.size).toBe(0);
    db.exec("INSERT INTO facts VALUES('pc','a',1,1,NULL)");
    const integer = identityFacts(db, "sample", spec, identities);
    db.exec("UPDATE facts SET value=1.0");
    expect(identityFacts(db, "sample", spec, identities).byIdentity).not.toEqual(integer.byIdentity);
  } finally { db.close(); }
});

test("invalid digests and missing invalidators fall back to facts; installation is additive and idempotent", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE facts(store TEXT,path TEXT,offset INTEGER,value); INSERT INTO facts VALUES('pc','a',1,7)");
    const before = db.query("SELECT rowid,* FROM facts").all();
    ensureAcceptedFacts(db, { sample: spec });
    db.transaction(() => saveAcceptedFacts(db, "sample", identityFacts(db, "sample", spec, identities))).immediate();
    const schema = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    const proofs = db.query("SELECT * FROM sync_accepted_facts ORDER BY identity").all();
    ensureAcceptedFacts(db, { sample: spec });
    expect(db.query("SELECT rowid,* FROM facts").all()).toEqual(before);
    expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(db.query("SELECT * FROM sync_accepted_facts ORDER BY identity").all()).toEqual(proofs);
    db.exec("UPDATE sync_accepted_facts SET digest='invalid' WHERE identity='[\"pc\",\"a\"]'");
    const invalid = identityFacts(db, "sample", spec, identities, true);
    expect(invalid.cachedIdentities).toEqual(new Set(['["pc","b"]']));
    expect(invalid.byIdentity).toEqual(identityFacts(db, "sample", spec, identities).byIdentity);
    db.transaction(() => saveAcceptedFacts(db, "sample", invalid)).immediate();
    db.exec("DROP TRIGGER sync_accepted_facts_facts_update; UPDATE facts SET value=11");
    const untracked = identityFacts(db, "sample", spec, identities, true);
    expect(untracked.cachedIdentities.size).toBe(0);
    expect(untracked.byIdentity).toEqual(identityFacts(db, "sample", spec, identities).byIdentity);
    ensureAcceptedFacts(db, { sample: spec });
    expect(db.query("SELECT count(*) n FROM sync_accepted_facts").get()).toEqual({ n: 0 });
    db.transaction(() => saveAcceptedFacts(db, "sample", identityFacts(db, "sample", spec, identities))).immediate();
    db.exec("UPDATE sync_accepted_facts SET contract='obsolete'");
    expect(identityFacts(db, "sample", spec, identities, true).cachedIdentities.size).toBe(0);
    db.exec("DROP TABLE sync_accepted_facts");
    const missing = identityFacts(db, "sample", spec, identities, true);
    expect(missing.cachedIdentities.size).toBe(0);
    expect(missing.byIdentity).toEqual(identityFacts(db, "sample", spec, identities).byIdentity);
    ensureAcceptedFacts(db, { sample: spec });
    expect(db.query("SELECT count(*) n FROM sync_accepted_facts").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test("digests retain the legacy typed fact coverage, excluding only id, with deterministic ties", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE facts(id INTEGER PRIMARY KEY,store TEXT,path TEXT,offset INTEGER,amount,value);
      CREATE TABLE evidence(store TEXT,path TEXT,proof TEXT);
      INSERT INTO facts VALUES(1,'pc','a',1,9223372036854775807,x'0102');
      INSERT INTO facts VALUES(2,'pc','a',1,1.0,NULL);
      INSERT INTO evidence VALUES('pc','a','original')`);
    const covered: FactsSpec = { ...spec, tables: [...spec.tables, { table: "evidence" }] };
    const legacy = createHash("sha256");
    for (const { table, order } of covered.tables) {
      const fields = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map(row => row.name).filter(column => column !== "id");
      legacy.update(table + "\n");
      const rows = db.query(`SELECT json_array(${fields.map(factsValue).join(",")}) AS encoded
        FROM ${table} WHERE store='pc' AND path='a' ORDER BY ${(order ?? fields).map(column => `+${column}`).join(",")}`).all() as { encoded: string }[];
      for (const { encoded } of rows) legacy.update(encoded + "\n");
    }
    const original = identityFacts(db, "sample", covered, [identities[0]!]).byIdentity;
    expect(original.get('["pc","a"]')).toBe(legacy.digest("hex"));
    db.exec("UPDATE facts SET id=id+10");
    expect(identityFacts(db, "sample", covered, [identities[0]!]).byIdentity).toEqual(original);
    db.exec("UPDATE evidence SET proof='corrected'");
    expect(identityFacts(db, "sample", covered, [identities[0]!]).byIdentity).not.toEqual(original);
    db.exec("UPDATE evidence SET proof='original'; UPDATE facts SET amount=1 WHERE typeof(amount)='real'");
    expect(identityFacts(db, "sample", covered, [identities[0]!]).byIdentity).not.toEqual(original);
  } finally { db.close(); }
});

test("range indexes preserve existing rows and can be installed twice", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT);
      CREATE TABLE ratelimit(id INTEGER PRIMARY KEY,home TEXT,path TEXT,ts TEXT);
      INSERT INTO events VALUES(17,'pc','a','2026-08-28T12:00:00Z');
      INSERT INTO ratelimit VALUES(18,'pc','a','2026-08-28T12:00:00Z')`);
    const tables = ["events", "ratelimit"];
    const originalColumns = tables.map(table => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map(column => column.name));
    const originalRows = () => tables.map((table, index) =>
      db.query(`SELECT rowid AS original_rowid,${originalColumns[index]!.join(",")} FROM ${table}`).all());
    const before = originalRows();
    ensureRawSyncIndexes(db);
    const schema = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    ensureRawSyncIndexes(db);
    expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(originalRows()).toEqual(before);
    for (const table of tables)
      expect((db.query(`EXPLAIN QUERY PLAN SELECT DISTINCT home,path FROM ${table} WHERE ts>=? AND ts<?`)
        .all("2026-08-28", "2026-08-30") as { detail: string }[]).some(row => row.detail.includes(`COVERING INDEX ${table}_range_sources`))).toBe(true);
  } finally { db.close(); }
});

test("coordinator accepts unchanged retries atomically and fences a correction after comparison", async () => {
  const { directory, dbPath } = createTestDatabase();
  const writer = new Database(dbPath);
  let correction = false;
  const coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), archiveInputs: () => undefined,
    adapters: adaptersWith({ claude: async context => {
      const stage = new Database(context.stageDbPath);
      try {
        stage.exec(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','call','a','2026-08-28T12:00:00Z',7);
          INSERT OR REPLACE INTO claude_files(store,path,size,mtime,calls,ingested_at) VALUES('pc','a',1,1,1,'2026-08-28T12:00:00Z')`);
      } finally { stage.close(); }
      return { ...successfulNoop(), processedInputs: 1, writtenRows: 1 };
    } }), mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "fixture",
    prepareStage: () => {}, refreshDerived: () => {},
    beforeIncrementalPublish: () => { if (correction) writer.exec("UPDATE claude_events SET in_uncached=11"); } });
  try {
    const request = { trigger: "manual" as const, scope: { kind: "vendor" as const, vendor: "claude" as const }, mode: "full" as const };
    const first = await coordinator.enter(request).completion;
    expect({ status: first.status, errors: first.vendors.map(vendor => vendor.error) }).toEqual({ status: "success", errors: [null] });
    // An empty provider is a first fill: it writes no proofs; the first ordinary publication does.
    expect(first.vendors[0]!.diagnostics.firstFill).toBe(true);
    expect(writer.query("SELECT count(*) n FROM sync_accepted_facts").get()).toEqual({ n: 0 });
    const retry = await coordinator.enter(request).completion;
    expect(retry.status).toBe("success");
    expect(retry.vendors[0]!.dataChanged).toBe(false);
    expect(retry.afterRevisions.data).toBe(first.afterRevisions.data);
    expect(writer.query("SELECT count(*) n FROM sync_accepted_facts").get()).toEqual({ n: 1 });
    correction = true;
    const conflicted = await coordinator.enter(request).completion;
    expect(conflicted.status).toBe("failure");
    expect(conflicted.vendors[0]!.error).toContain("Accepted source facts changed");
    expect(writer.query("SELECT in_uncached FROM claude_events").get()).toEqual({ in_uncached: 11 });
    expect(writer.query("SELECT count(*) n FROM sync_accepted_facts").get()).toEqual({ n: 0 });
  } finally { coordinator.close(); writer.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});
