import { test, expect } from "bun:test";
import { Database } from "./sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { applyDrizzleMigrations } from "./migrate";
import { acceptProbeFact, advanceLinkedProbeBackfill, backfillProbeFacts, createProbeCollection, probeFactsDigest, probeFactShadow, validateCanonicalProbe, validateProbeFacts, type CanonicalProbe } from "./probe-facts";
import { persistProbeWindows } from "../providers/core/probe";
import { configureGaugeJournal } from "../providers/core/journal";
import fixture from "../../test-fixtures/probe-facts-v1.json";
import type { WindowReading } from "../providers/types";

function open() { const db = new Database(":memory:"); applyDrizzleMigrations(drizzle(db)); return db; }
function write(db: Database, ts = fixture.ts, readings: WindowReading[] = [fixture.reading as WindowReading]) {
  configureGaugeJournal(null); persistProbeWindows(db, "codex", fixture.subject, ts, readings);
}
function facts(db: Database) { return db.query("SELECT * FROM probe_counters ORDER BY id").all() as { id: string; observation_id: string; payload: string; discriminator: string }[]; }

test("opaque collection identity and tagged occurrences reject mutable-key and occurrence negative controls", () => {
  const db = open();
  try {
    write(db, fixture.ts, [fixture.reading, fixture.reading, { ...fixture.reading, scope: "" }, { ...fixture.reading, group: null }, { ...fixture.reading, windowMinutes: null }] as WindowReading[]);
    write(db);
    const rows = facts(db);
    expect(rows).toHaveLength(6); expect(new Set(rows.map(r => r.observation_id)).size).toBe(2);
    expect(new Set(rows.map(r => r.id)).size).toBe(6);
    expect(probeFactShadow(db)[0]!.cutover).toBe("blocked");
    const original = createProbeCollection([JSON.parse(rows[0]!.payload), JSON.parse(rows[0]!.payload)]);
    expect(original[0]!.counter_id).not.toBe(original[1]!.counter_id);
    for (const key of [fixture.subject, "1", randomUUID()]) expect(() => validateCanonicalProbe({ ...original[0], observation_id: key })).toThrow();
    expect(() => validateCanonicalProbe({ ...original[1], discriminator: original[0]!.discriminator })).toThrow();
    expect(() => validateCanonicalProbe({ ...original[0], payload: { ...original[0]!.payload, remaining: 0 } })).toThrow();
    validateProbeFacts(db);
  } finally { db.close(true); }
});

test("facts resist direct mutation, replay and legacy A-B-A attribution changes", () => {
  const db = open();
  try {
    write(db); const before = probeFactsDigest(db);
    const errors = ["UPDATE probe_counters SET payload='{}'", "DELETE FROM probe_counters", "UPDATE probe_observations SET header='{}'", "DELETE FROM probe_observations"];
    for (const sql of errors) expect(() => db.exec(sql)).toThrow("Immutable");
    expect(() => db.exec("INSERT OR REPLACE INTO probe_observations SELECT id,'{}' FROM probe_observations")).toThrow("Immutable");
    expect(() => db.exec("INSERT OR REPLACE INTO probe_counters SELECT id,observation_id,discriminator,'{}',payload_digest FROM probe_counters")).toThrow("Immutable");
    // A relabelled projection row (A-B-A) leaves the facts untouched.
    db.exec("UPDATE probe_windows SET subject='B'");
    expect(db.query("SELECT subject FROM probe_windows").get()).toEqual({ subject: "B" });
    expect(probeFactsDigest(db)).toBe(before);
    db.query("UPDATE probe_windows SET subject=?").run(fixture.subject);
    expect(probeFactsDigest(db)).toBe(before);
    backfillProbeFacts(db, { rescan: true });
    expect(facts(db)).toHaveLength(1);
  } finally { db.close(true); }
});

test("real additive migration, bounded backfill restart and changed local pointer preserve candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-migration-"));
  const dir = path.join(root, "drizzle"); fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  const source = path.resolve(import.meta.dir, "../../drizzle");
  const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
  const prefix = { ...journal, entries: journal.entries.slice(0, 24) };
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(prefix));
  for (const e of prefix.entries) fs.copyFileSync(path.join(source, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  const file = path.join(root, "db.sqlite"); let db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL"); applyDrizzleMigrations(drizzle(db), dir);
    db.exec("INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent) VALUES ('codex','codex1','2026-09-01','primary','used',1),('codex','codex1','2026-09-02','primary','used',2)");
    const old = db.query("SELECT * FROM probe_windows").all();
    db.exec(fs.readFileSync(path.join(source, "0024_immutable_probe_facts.sql"), "utf8"));
    expect(() => backfillProbeFacts(db, { batchSize: 1, afterBatch: () => { throw Error("interrupted after commit"); } })).toThrow("interrupted");
    const first = facts(db); expect(first).toHaveLength(1);
    db.close(true); db = new Database(file); backfillProbeFacts(db);
    expect(facts(db)).toHaveLength(2); expect(facts(db).find(r => r.id === first[0]!.id)).toEqual(first[0]);
    const digest = probeFactsDigest(db); backfillProbeFacts(db); expect(probeFactsDigest(db)).toBe(digest);
    expect(db.query("SELECT * FROM probe_windows").all()).toEqual(old);
    db.exec("UPDATE probe_windows SET used_percent=99 WHERE id=1");
    backfillProbeFacts(db, { rescan: true }); expect(facts(db)).toHaveLength(3);
    expect(db.query("SELECT reason FROM probe_fact_conflicts ORDER BY reason").all()).toEqual([{ reason: "legacy-equivalence-unresolved" }, { reason: "legacy-pointer-changed" }]);
    expect(JSON.parse((db.query("SELECT header FROM probe_observations LIMIT 1").get() as { header: string }).header).origin).toBeNull();
  } finally { db.close(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test("counter and observation collisions reject publication and transaction rolls back", () => {
  const db = open();
  try {
    write(db); const row = facts(db)[0]!;
    const c = createProbeCollection([JSON.parse(row.payload)])[0]!;
    db.transaction(() => { expect(acceptProbeFact(db, c)).toBe(true); expect(acceptProbeFact(db, c)).toBe(false); })();
    const before = probeFactsDigest(db);
    expect(() => db.transaction(() => acceptProbeFact(db, { ...c, header: { ...c.header, recorded_at: "2026-09-02" } }))()).toThrow("header-conflict");
    expect(probeFactsDigest(db)).toBe(before);
  } finally { db.close(true); }
});

test("new facts record no source origin; nothing declares a source mapping any more", () => {
  const row = { provider: "codex", subject: "A", ts: fixture.ts, kind: "primary", reported_percent_side: "used", machine: "M", login: "L", source_home: "${HOME}/.codex" };
  expect(createProbeCollection([row])[0]!.header.origin).toBeNull();
  expect(createProbeCollection([row], true)[0]!.header.origin).toBeNull();
});

test("shadow consumes distinct legacy rows and detects duplicate-plus-altered raw projection", () => {
  const db = open();
  try {
    configureGaugeJournal(null);
    persistProbeWindows(db, "grok", fixture.subject, fixture.ts, [fixture.reading, fixture.reading] as WindowReading[]);
    backfillProbeFacts(db);
    expect(probeFactShadow(db)).toEqual([{ family: "grok", canonical: 2, represented: 2, conflicts: 0, cutover: "compatible" }]);
    db.exec("UPDATE probe_windows SET subject='permitted-attribution-change'");
    expect(probeFactShadow(db)[0]!.represented).toBe(2);
    const before = probeFactsDigest(db);
    db.exec("UPDATE probe_windows SET used_percent=99 WHERE id=(SELECT max(id) FROM probe_windows)");
    applyDrizzleMigrations(drizzle(db));
    expect(probeFactsDigest(db)).toBe(before);
    expect(probeFactShadow(db)).toEqual([{ family: "grok", canonical: 2, represented: 1, conflicts: 0, cutover: "blocked" }]);
  } finally { db.close(true); }
});

test("internally consistent subject, rowid, transport and occurrence construction mutants fail collection invariants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-construction-"));
  const original = fs.readFileSync(path.join(import.meta.dir, "probe-facts.ts"), "utf8")
    .replaceAll('"../config/canonical-json"', JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../config/canonical-json.ts")).href));
  const transport = randomUUID();
  const row = { id: 1, journal_entry_id: transport, provider: "grok", subject: "A", ts: fixture.ts, kind: "primary", reported_percent_side: "used" };
  const assertConstruction = (factory: typeof createProbeCollection) => {
    const first = factory([row, row]), second = factory([row, row]);
    const all = [...first, ...second];
    // Every mutant must pass envelope integrity; the target is the construction's loss of independent facts.
    for (const fact of all) validateCanonicalProbe(fact);
    expect(first[0]!.observation_id).not.toBe(transport);
    expect(first[0]!.observation_id).not.toBe(second[0]!.observation_id);
    const db = open();
    try {
      db.transaction(() => { for (const fact of all) acceptProbeFact(db, fact); })();
      expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 4 });
    } finally { db.close(true); }
  };
  try {
    for (const mode of ["subject", "rowid", "transport", "occurrence"] as const) {
      const expression = mode === "transport" ? 'String(rows[0]!.journal_entry_id)' :
        `digest(["forbidden",rows[0]!.${mode === "subject" ? "subject" : "id"}]).slice(0,32).replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, "$1-$2-4$3-8$4-$5")`;
      const source = mode === "occurrence" ? original.replace("const n = occurrences.get(key) ?? 0;", "const n = 0;") :
        original.replace("const observation_id = randomUUID();", `const observation_id = ${expression};`);
      expect(source).not.toBe(original);
      const file = path.join(root, mode + ".ts"); fs.writeFileSync(file, source);
      const mutant = await import(pathToFileURL(file).href) as { createProbeCollection: (rows: Record<string, unknown>[]) => CanonicalProbe[] };
      for (const fact of mutant.createProbeCollection([row, row])) validateCanonicalProbe(fact);
      expect(() => assertConstruction(mutant.createProbeCollection)).toThrow();
      console.info(`negative-control internally consistent ${mode} construction: collection invariant rejected`);
    }
    assertConstruction(createProbeCollection);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a first fill whose rows are all linked moves the backfill cursor, and backfilling them adds nothing", () => {
  const db = open();
  try {
    write(db, fixture.ts, [fixture.reading, { ...fixture.reading, scope: "" }] as WindowReading[]);
    write(db, "2026-09-02T00:00:00.000Z");
    db.exec("UPDATE probe_fact_backfill_checkpoints SET cursor=0");
    const max = (db.query("SELECT max(id) n FROM probe_windows").get() as { n: number }).n;
    const tables = ["probe_observations", "probe_counters", "probe_fact_deliveries", "probe_fact_legacy_map", "probe_fact_conflicts"];
    const dump = (target: Database) => tables.map(table => target.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const reference = Database.deserialize(db.serialize());
    try {
      backfillProbeFacts(reference);
      advanceLinkedProbeBackfill(db);
      expect((db.query("SELECT cursor FROM probe_fact_backfill_checkpoints").get() as { cursor: number }).cursor).toBe(max);
      backfillProbeFacts(db);
      expect(dump(db)).toEqual(dump(reference));
    } finally { reference.close(); }
    // A row without a link keeps the cursor, so the backfill still gives it a fact.
    db.exec(`UPDATE probe_fact_backfill_checkpoints SET cursor=0;
      INSERT INTO probe_windows (provider,subject,ts,kind,reported_percent_side,used_percent) VALUES ('codex','other','2026-09-03T00:00:00.000Z','primary','used',5)`);
    advanceLinkedProbeBackfill(db);
    expect((db.query("SELECT cursor FROM probe_fact_backfill_checkpoints").get() as { cursor: number }).cursor).toBe(0);
  } finally { db.close(); }
});
