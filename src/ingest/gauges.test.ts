import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../db/migrate";
import * as schema from "../db/schema";
import { ingestGaugesAsync } from "./gauges";
import { createHash, randomUUID } from "node:crypto";
import { backfillProbeFacts, createProbeCollection } from "../db/probe-facts";
import { digest } from "../config/canonical-json";
import { compactProbeLine } from "../providers/core/journal-compact";

const tempDirectories: string[] = [];

test("archive rebuild includes the own journal without replaying its unchanged prefix", async () => {
  const f=fixture();
  writeJournal(f.archiveRoot,"local","probe_windows.jsonl",[probeLine({subject:"local"})]);
  const read=async ()=>(await ingestGaugesAsync({atlasPath:f.dbPath,archiveRoot:f.archiveRoot,ownStore:"local",force:false,includeOwnStore:true}));
  expect((await read())).toMatchObject({files:1,rows:1,skipped:0});
  const unchanged=(await read());
  expect(unchanged).toMatchObject({files:1,rows:0,skipped:1});
  expect(unchanged.details[0]).toMatchObject({readLines:0,skipped:true});
});

test("journal inventory reports interim checked-file progress and stops before a failed file", async () => {
  const f = fixture();
  writeJournal(f.archiveRoot, "remote", "probe_windows.2026-08.jsonl", [probeLine({ subject: "first" })]);
  const second = writeJournal(f.archiveRoot, "remote", "probe_windows.2026-09.jsonl", [probeLine({ subject: "second" })]);
  const updates: Array<[number,number]> = [];
  const read = async () => (await ingestGaugesAsync({atlasPath:f.dbPath,archiveRoot:f.archiveRoot,ownStore:"local",force:true,
    onFileProgress:(completed,total)=>updates.push([completed,total])}));
  expect((await read()).files).toBe(2);
  expect(updates).toEqual([[0,2],[1,2],[2,2]]);
  fs.writeFileSync(second, JSON.stringify({journal_version:2,journal_entry_id:randomUUID(),provider:"codex"}) + "\n");
  updates.length = 0;
  expect(read).toThrow();
  expect(updates).toEqual([[0,2],[1,2]]);
});

test("canonical replay keeps raw identity and restamped attribution; separate collections and conflicts survive", async () => {
  const f = fixture(), payload = JSON.parse(probeLine({ machine: "producer-a" }));
  const c = createProbeCollection([payload])[0]!;
  const envelope = (canonical: typeof c, extra: Record<string, unknown> = {}) => JSON.stringify({ ...canonical.payload, canonical_probe: canonical, journal_version: 2, journal_entry_id: randomUUID(), ...extra });
  const file = writeJournal(f.archiveRoot, "remote", "probe_windows.jsonl", [envelope(c)]);
  const ingest = async () => (await ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: false }));
  (await ingest()); const db = new Database(f.dbPath);
  try {
    db.exec("UPDATE probe_windows SET subject='rebound'");
    fs.appendFileSync(file, envelope(c) + "\n"); (await ingest());
    expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 1 });
    expect(db.query("SELECT subject FROM probe_windows").get()).toEqual({ subject: "rebound" });
    const other = createProbeCollection([{ ...payload, machine: "producer-b" }])[0]!;
    fs.appendFileSync(file, envelope(other) + "\n"); (await ingest());
    expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 2 });
    const before = db.query("SELECT * FROM gauge_files").all(), receipts = db.query("SELECT * FROM gauge_journal_receipts").all();
    const changed = { ...c, payload: { ...c.payload, used_percent: 99 } }; changed.payload_digest = digest(changed.payload);
    fs.appendFileSync(file, envelope(changed) + "\n");
    expect(ingest).toThrow("counter-identity-conflict");
    expect(db.query("SELECT * FROM gauge_files").all()).toEqual(before);
    expect(db.query("SELECT * FROM gauge_journal_receipts").all()).toEqual(receipts);
    expect(db.query("SELECT count(*) n FROM probe_fact_conflicts").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 2 });
  } finally { db.close(true); }
});

for (const firstFill of [false, true]) for (const compact of [false, true]) {
  test(`canonical unknown machine survives reopen, forced replay and backfill (bulk=${firstFill}, compact=${compact})`, async () => {
    const f = fixture();
    const unknown = createProbeCollection([JSON.parse(probeLine({ machine: null }))])[0]!;
    const explicit = createProbeCollection([JSON.parse(probeLine({ machine: "actual-producer", ts: "2026-09-02T10:05:00.000Z" }))])[0]!;
    const envelopes = [unknown, explicit].map((c, index) => compact
      ? compactProbeLine(randomUUID(), c, index === 0 ? null : unknown).line
      : JSON.stringify({ ...c.payload, canonical_probe: c, journal_version: 2, journal_entry_id: randomUUID() }));
    writeJournal(f.archiveRoot, "recovery-store", "probe_windows.jsonl", envelopes);
    const ingest = (force = false) => ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force, firstFill });
    const snapshot = (rescan = false) => {
      const db = new Database(f.dbPath);
      try {
        if (rescan) backfillProbeFacts(db, { rescan: true });
        return Object.fromEntries(["probe_observations", "probe_counters", "probe_windows", "probe_fact_legacy_map", "probe_fact_conflicts"]
          .map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY id`).all()]));
      } finally { db.close(true); }
    };
    expect((await ingest()).rows).toBe(2);
    const before = snapshot();
    expect(before.probe_windows).toMatchObject([{ machine: null }, { machine: "actual-producer" }]);
    expect(before.probe_counters).toHaveLength(2);
    expect(before.probe_fact_conflicts).toHaveLength(0);
    expect((await ingest()).rows).toBe(0);
    expect(snapshot()).toEqual(before);
    expect((await ingest(true)).rows).toBe(0);
    expect(snapshot(true)).toEqual(before);
  });
}

test("forced canonical replay restores only a missing projection", async () => {
  const f = fixture(), c = createProbeCollection([JSON.parse(probeLine({}))])[0]!;
  writeJournal(f.archiveRoot, "remote", "probe_windows.jsonl", [JSON.stringify({
    ...c.payload, canonical_probe: c, journal_version: 2, journal_entry_id: randomUUID(),
  })]);
  const ingest = async () => (await ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: true }));
  expect((await ingest()).rows).toBe(1);
  const db = new Database(f.dbPath);
  try {
    expect(db.query("SELECT count(*) n FROM probe_counters").get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) n FROM gauge_journal_receipts").get()).toEqual({ n: 1 });
    db.exec("DELETE FROM probe_windows");
  } finally { db.close(true); }
  expect((await ingest()).rows).toBe(1);
  expect(count(f.dbPath, "SELECT count(*) AS n FROM probe_windows")).toBe(1);
  expect(count(f.dbPath, "SELECT count(*) AS n FROM probe_counters")).toBe(1);
  expect(count(f.dbPath, "SELECT count(*) AS n FROM gauge_journal_receipts")).toBe(1);
  expect((await ingest()).rows).toBe(0);
  expect(count(f.dbPath, "SELECT count(*) AS n FROM probe_windows")).toBe(1);
});

for (const edit of ["version", "partial", "null", "header", "canonical-only", "canonical-field-only"] as const) test(`canonical ${edit} envelope cannot acknowledge a preceding valid line`, async () => {
  const f = fixture(), c = createProbeCollection([JSON.parse(probeLine({}))])[0]!;
  const good: Record<string, unknown> = { ...c.payload, journal_version: 2, journal_entry_id: randomUUID(), canonical_probe: c };
  let bad: any = structuredClone(good); bad.journal_entry_id = randomUUID();
  if (edit === "version") bad.canonical_probe.version = 99;
  if (edit === "partial") delete bad.canonical_probe.observation_id;
  if (edit === "null") bad.remaining = 0;
  if (edit === "header") bad.canonical_probe.header.subject = "mutable";
  if (edit === "canonical-only") bad = { canonical_probe: { version: 99 } };
  if (edit === "canonical-field-only") bad = { canonical_observation_id: randomUUID() };
  writeJournal(f.archiveRoot, "remote", "probe_windows.jsonl", [JSON.stringify(good), JSON.stringify(bad)]);
  await expect(ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: true })).rejects.toThrow();
  const db = new Database(f.dbPath);
  try {
    for (const t of ["probe_windows", "probe_counters", "probe_observations", "gauge_journal_receipts", "gauge_files"])
      expect(db.query(`SELECT count(*) n FROM ${t}`).get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) n FROM probe_fact_conflicts").get()).toEqual({ n: 1 });
  } finally { db.close(true); }
});

afterAll(() => {
  for (const directory of tempDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Bun can retain a Windows SQLite handle until process teardown.
    }
  }
});

function fixture(): { archiveRoot: string; dbPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-gauges-"));
  tempDirectories.push(directory);
  const dbPath = path.join(directory, "stage.sqlite");
  const sqlite = new Database(dbPath, { create: true });
  try {
    applyDrizzleMigrations(drizzle(sqlite, { schema }));
  } finally {
    sqlite.close();
  }
  return { archiveRoot: path.join(directory, "archive"), dbPath };
}

function probeLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    provider: "codex",
    subject: "codex1",
    ts: "2026-09-02T10:00:00.000Z",
    plan: "plus",
    kind: "primary",
    limit_group: "codex",
    scope: null,
    reported_percent_side: "used",
    used_percent: 42,
    remaining_percent: null,
    vendor_percent: 42,
    window_minutes: 300,
    allowance: null,
    used: null,
    remaining: null,
    resets_at: "2026-09-02T14:00:00.000Z",
    rate_limit_reached: 0,
    reset_credits: null,
    profile: null,
    ok: null,
    error: null,
    extra: JSON.stringify({ home: "C:/Users/sample_a/.codex" }),
    machine: "EXAMPLE-MAIN",
    login: "sample_a",
    source_home: "C:/Users/sample_a/.codex",
    raw_subject: "codex1",
    ...overrides,
  });
}

function writeJournal(archiveRoot: string, store: string, file: string, lines: string[]): string {
  const directory = path.join(archiveRoot, "gauges", store);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, file);
  fs.writeFileSync(target, lines.join("\n") + "\n");
  return target;
}

function count(dbPath: string, sql: string): number {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return (sqlite.query(sql).get() as { n: number }).n;
  } finally {
    sqlite.close();
  }
}

describe("ingestGaugesAsync", () => {
  test("chunked tails preserve UTF-8, whole-line hashes and a torn final line across two boundaries", async () => {
    const f = fixture(), chunkBytes = 4 * 1024 * 1024;
    const records: { ts: string; extra: string; line: string }[] = [];
    const straddling: number[] = [];
    let offset = 0;
    const timestamp = (i: number) => new Date(Date.UTC(2026, 8, 2, 10, 0, i)).toISOString();
    for (let i = 0; i < 300; i++) {
      const ts = timestamp(i);
      let extra = "x".repeat(32 * 1024);
      let line = probeLine({ ts, extra });
      const boundary = (Math.floor(offset / chunkBytes) + 1) * chunkBytes;
      if (offset + Buffer.byteLength(line + "\n") > boundary) {
        const extraStart = Buffer.byteLength(line.slice(0, line.indexOf('"extra":"') + '"extra":"'.length));
        const split = boundary - offset - extraStart - 1;
        expect(split).toBeGreaterThan(0); expect(split).toBeLessThan(extra.length);
        // Split the four-byte character itself across the chunk boundary.
        extra = extra.slice(0, split) + "🙂" + extra.slice(split);
        line = probeLine({ ts, extra });
        expect(offset + Buffer.from(line).indexOf(Buffer.from("🙂"))).toBe(boundary - 1);
        straddling.push(i);
      }
      records.push({ ts, extra, line });
      offset += Buffer.byteLength(line + "\n");
    }
    expect(straddling).toHaveLength(2);
    const whole = Buffer.from(records.map(record => record.line + "\n").join(""));
    expect(whole.length).toBeGreaterThan(9 * 1024 * 1024);
    expect(whole.length).toBeLessThan(10 * 1024 * 1024);
    const torn = probeLine({ ts: timestamp(300), extra: "tail-🙂-" + "x".repeat(32 * 1024) });
    const split = Math.floor(torn.length / 2);
    const file = writeJournal(f.archiveRoot, "remote", "probe_windows.jsonl", records.map(record => record.line));
    fs.appendFileSync(file, torn.slice(0, split));
    const ingest = async () => (await ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: false }));
    const first = (await ingest());
    expect(first).toMatchObject({ files: 1, rows: 300, malformed: 0 });
    expect(first.details[0]).toMatchObject({ fromOffset: 0, toOffset: whole.length, readLines: 300 });
    const db = new Database(f.dbPath);
    const bookmark = () => db.query("SELECT offset, prefix_sha256 FROM gauge_files WHERE store='remote' AND path='probe_windows.jsonl'").get();
    try {
      expect(db.query("SELECT count(*) AS n, count(DISTINCT ts) AS timestamps FROM probe_windows").get()).toEqual({ n: 300, timestamps: 300 });
      for (const i of [0, ...straddling, 299]) {
        const record = records[i]!;
        expect(db.query("SELECT ts, extra FROM probe_windows WHERE ts=?").all(record.ts)).toEqual([{ ts: record.ts, extra: record.extra }]);
      }
      expect(db.query("SELECT ts FROM probe_windows WHERE ts=?").get(timestamp(300))).toBeNull();
      expect(bookmark()).toEqual({ offset: whole.length, prefix_sha256: createHash("sha256").update(whole).digest("hex") });
      const appended = probeLine({ ts: timestamp(301), extra: "last-🙂" });
      fs.appendFileSync(file, torn.slice(split) + "\n" + appended + "\n");
      const second = (await ingest());
      const complete = Buffer.concat([whole, Buffer.from(torn + "\n" + appended + "\n")]);
      expect(second).toMatchObject({ files: 1, rows: 2, malformed: 0 });
      expect(second.details[0]).toMatchObject({ fromOffset: whole.length, toOffset: complete.length, readLines: 2 });
      expect(db.query("SELECT count(*) AS n, count(DISTINCT ts) AS timestamps FROM probe_windows").get()).toEqual({ n: 302, timestamps: 302 });
      expect(db.query("SELECT ts FROM probe_windows WHERE ts>=? ORDER BY ts").all(timestamp(300))).toEqual([
        { ts: timestamp(300) }, { ts: timestamp(301) },
      ]);
      expect(bookmark()).toEqual({ offset: complete.length, prefix_sha256: createHash("sha256").update(complete).digest("hex") });
    } finally { db.close(true); }
  }, 240000);

  test("a missing compact base preserves facts, receipts and bookmark until its file arrives", async () => {
    const f = fixture();
    const base = createProbeCollection([JSON.parse(probeLine({}))])[0]!;
    const next = createProbeCollection([JSON.parse(probeLine({ ts: "2026-09-02T10:05:00.000Z", used_percent: 43 }))])[0]!;
    const reference = compactProbeLine(randomUUID(), next, base);
    expect(reference.full).toBe(false);
    const file = writeJournal(f.archiveRoot, "remote", "probe_windows.2026-09-02.jsonl", [""]);
    const ingest = async () => (await ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: false }));
    expect((await ingest()).rows).toBe(0);
    const db = new Database(f.dbPath);
    try {
      const bookmark = db.query("SELECT * FROM gauge_files").all();
      fs.appendFileSync(file, reference.line + "\n");
      expect(ingest).toThrow("Compact probe base not ingested yet");
      expect(db.query("SELECT * FROM gauge_files").all()).toEqual(bookmark);
      for (const table of ["probe_counters", "probe_observations", "probe_windows", "gauge_journal_receipts"])
        expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      writeJournal(f.archiveRoot, "remote", "probe_windows.2026-09-01.jsonl", [compactProbeLine(randomUUID(), base, null).line]);
      const recovered = (await ingest());
      expect(recovered).toMatchObject({ files: 2, rows: 2, malformed: 0 });
      expect(recovered.details[1]).toMatchObject({ fromOffset: 1, readLines: 1 });
      expect(db.query("SELECT id FROM probe_counters ORDER BY id").all()).toEqual(
        [base.counter_id, next.counter_id].sort().map(id => ({ id })));
      expect(db.query("SELECT count(*) AS n FROM gauge_journal_receipts").get()).toEqual({ n: 2 });
      expect((await ingest())).toMatchObject({ rows: 0, skipped: 2 });
    } finally { db.close(true); }
  });

  test("reads legacy, month and daily journals in order with independent bookmarks", async () => {
    const f = fixture();
    const names = ["probe_windows.jsonl", "probe_windows.2026-08.jsonl", "probe_windows.2026-09-01.jsonl"];
    const files = names.map((name, i) => writeJournal(f.archiveRoot, "remote", name, [probeLine({ subject: `segment-${i}` })]));
    const ingest = async () => (await ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: false }));
    const first = (await ingest());
    expect(first).toMatchObject({ files: 3, rows: 3, skipped: 0, malformed: 0 });
    expect(first.details.map(detail => detail.file)).toEqual(names);
    expect(first.details.map(detail => detail.readLines)).toEqual([1, 1, 1]);
    const db = new Database(f.dbPath);
    try {
      expect(db.query("SELECT subject FROM probe_windows ORDER BY id").all()).toEqual(
        [0, 1, 2].map(i => ({ subject: `segment-${i}` })));
      const bookmarks = db.query("SELECT path, offset FROM gauge_files ORDER BY path").all();
      const unchanged = (await ingest());
      expect(unchanged).toMatchObject({ files: 3, rows: 0, skipped: 3 });
      expect(unchanged.details.map(detail => detail.readLines)).toEqual([0, 0, 0]);
      expect(db.query("SELECT path, offset FROM gauge_files ORDER BY path").all()).toEqual(bookmarks);
      const daily = files[2]!, before = fs.statSync(daily);
      fs.appendFileSync(daily, probeLine({ subject: "appended" }) + "\n");
      fs.utimesSync(daily, before.atime, new Date(before.mtimeMs + 5000));
      const tail = (await ingest());
      expect(tail).toMatchObject({ files: 3, rows: 1, skipped: 2, malformed: 0 });
      expect(tail.details.map(detail => detail.readLines)).toEqual([0, 0, 1]);
      expect(tail.details[2]).toMatchObject({ file: names[2], fromOffset: before.size, toOffset: fs.statSync(daily).size });
      expect(db.query("SELECT subject FROM probe_windows ORDER BY id").all()).toEqual(
        ["segment-0", "segment-1", "segment-2", "appended"].map(subject => ({ subject })));
      for (const file of files) expect(db.query("SELECT offset FROM gauge_files WHERE store='remote' AND path=?").get(path.basename(file)))
        .toEqual({ offset: fs.statSync(file).size });
    } finally { db.close(true); }
  });

  test("a versioned entry shared by a daily and month file has one receipt and one fact", async () => {
    const f = fixture(), entryId = randomUUID();
    const line = probeLine({ journal_version: 2, journal_entry_id: entryId });
    writeJournal(f.archiveRoot, "remote", "probe_windows.2026-09-01.jsonl", [line]);
    writeJournal(f.archiveRoot, "remote", "probe_windows.2026-09.jsonl", [line]);
    const result = (await ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: false }));
    expect(result).toMatchObject({ files: 2, rows: 1, malformed: 0 });
    expect(result.details.map(detail => [detail.file, detail.rows, detail.readLines])).toEqual([
      ["probe_windows.2026-09.jsonl", 1, 1], ["probe_windows.2026-09-01.jsonl", 0, 1],
    ]);
    const db = new Database(f.dbPath);
    try {
      expect(db.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 1 });
      expect(db.query("SELECT count(*) AS n FROM probe_counters").get()).toEqual({ n: 1 });
      expect(db.query("SELECT entry_id, payload_hash FROM gauge_journal_receipts").all()).toEqual([
        { entry_id: entryId, payload_hash: createHash("sha256").update("probe_windows.jsonl\0" + line).digest("hex") },
      ]);
      expect(db.query("SELECT count(*) AS n FROM probe_fact_conflicts").get()).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM gauge_files").get()).toEqual({ n: 2 });
    } finally { db.close(true); }
  });

  test("selected daily journal is accepted and non-journal names are rejected", async () => {
    const f = fixture();
    const file = writeJournal(f.archiveRoot, "remote", "probe_windows.2026-09-01.jsonl", [probeLine({})]);
    const ingest = async (selected: string) => (await ingestGaugesAsync({ atlasPath: f.dbPath, archiveRoot: f.archiveRoot, ownStore: "local", force: false, files: [selected] }));
    expect((await ingest(file))).toMatchObject({ files: 1, rows: 1, malformed: 0 });
    for (const name of ["probe_windows.2026-13-01.jsonl", "notes.jsonl"]) {
      const invalid = writeJournal(f.archiveRoot, "remote", name, [probeLine({ subject: "invalid" })]);
      await expect(ingest(invalid)).rejects.toThrow("Invalid gauge journal path");
    }
    expect(count(f.dbPath, "SELECT count(*) AS n FROM probe_windows")).toBe(1);
    expect(count(f.dbPath, "SELECT count(*) AS n FROM gauge_files")).toBe(1);
  });

  test("reads every foreign journal and stamps the machine", async () => {
    const { archiveRoot, dbPath } = fixture();
    writeJournal(archiveRoot, "EXAMPLE-MAIN-sample_a", "probe_windows.jsonl", [
      probeLine({}),
      probeLine({ ts: "2026-09-02T10:05:00.000Z", used_percent: 43 }),
    ]);
    writeJournal(archiveRoot, "EXAMPLE-MAIN-sample_b", "probe_windows.jsonl", [
      probeLine({ subject: "codex3", machine: "EXAMPLE-MAIN", login: "sample_b", extra: JSON.stringify({ home: "C:/Users/sample_b/.codex" }) }),
    ]);
    writeJournal(archiveRoot, "EXAMPLE-MAIN-sample_a", "account_observations.jsonl", [
      JSON.stringify({ ts: "2026-09-02T10:00:00.000Z", vendor: "codex", source: "C:/Users/sample_a/.codex", identity_kind: "email", identity: "a@b.c", raw_source: null, machine: "EXAMPLE-MAIN", login: "sample_a" }),
    ]);
    const result = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "EXAMPLE-LAPTOP-A-sample_a" }));
    expect(result.files).toBe(3);
    expect(result.skipped).toBe(0);
    // The observation segment is read past and bookmarked, not imported.
    expect(result.rows).toBe(3);
    expect(result.stores).toEqual(["EXAMPLE-MAIN-sample_b", "EXAMPLE-MAIN-sample_a"]);
    expect(count(dbPath, "SELECT count(*) AS n FROM probe_windows WHERE machine = 'EXAMPLE-MAIN'")).toBe(3);
    expect(count(dbPath, "SELECT count(*) AS n FROM probe_windows WHERE subject = 'codex3'")).toBe(1);
    expect(count(dbPath, "SELECT count(*) AS n FROM probe_windows")).toBe(3);
    expect(count(dbPath, "SELECT count(*) AS n FROM gauge_files")).toBe(3);
    expect(fs.readFileSync(path.join(archiveRoot, "gauges", "EXAMPLE-MAIN-sample_a", "account_observations.jsonl"), "utf8"))
      .toContain('"identity":"a@b.c"');
  });

  test("skips the local machine's own journal unless forced", async () => {
    const { archiveRoot, dbPath } = fixture();
    writeJournal(archiveRoot, "EXAMPLE-LAPTOP-A-sample_a", "probe_windows.jsonl", [probeLine({ machine: "EXAMPLE-LAPTOP-A" })]);
    const incremental = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "EXAMPLE-LAPTOP-A-sample_a" }));
    expect(incremental.files).toBe(0);
    expect(count(dbPath, "SELECT count(*) AS n FROM probe_windows")).toBe(0);
    const forced = (await ingestGaugesAsync({ atlasPath: dbPath, force: true, archiveRoot, ownStore: "EXAMPLE-LAPTOP-A-sample_a" }));
    expect(forced.rows).toBe(1);
  });

  test("second run reads only the appended tail and skips unchanged files", async () => {
    const { archiveRoot, dbPath } = fixture();
    const file = writeJournal(archiveRoot, "EXAMPLE-MAIN-sample_a", "probe_windows.jsonl", [probeLine({})]);
    const first = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "other" }));
    expect(first.rows).toBe(1);
    const unchanged = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "other" }));
    expect(unchanged.skipped).toBe(1);
    expect(unchanged.rows).toBe(0);
    const before = fs.statSync(file);
    fs.appendFileSync(file, probeLine({ ts: "2026-09-02T10:05:00.000Z" }) + "\n");
    fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 5_000));
    const tail = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "other" }));
    expect(tail.rows).toBe(1);
    const detail = tail.details.find((item) => item.file === "probe_windows.jsonl");
    expect(detail?.fromOffset).toBe(before.size);
    expect(detail?.readLines).toBe(1);
    expect(detail?.toOffset).toBe(fs.statSync(file).size);
    expect(count(dbPath, "SELECT count(*) AS n FROM probe_windows")).toBe(2);
  });

  test("selected own journals retain prefix evidence on reopen and detect historical rewrites", async () => {
    const f = fixture();
    const file = writeJournal(f.archiveRoot, "local", "probe_windows.jsonl", [probeLine({})]);
    const other = writeJournal(f.archiveRoot, "other", "probe_windows.jsonl", [probeLine({subject:"untouched"})]);
    const ingest = async () => (await ingestGaugesAsync({atlasPath:f.dbPath,archiveRoot:f.archiveRoot,ownStore:"local",force:false,files:[file]}));
    expect((await ingest()).details[0]?.readLines).toBe(1);
    const size = fs.statSync(file).size;
    fs.appendFileSync(file,probeLine({ts:"2026-09-02T10:05:00.000Z"})+"\n");
    const read = fs.readSync;
    let bytesRead = 0;
    const reads = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const bytes = read(...args); bytesRead += bytes; return bytes;
    }) as typeof fs.readSync);
    try { expect((await ingest()).details[0]).toMatchObject({fromOffset:size,readLines:1}); }
    finally { reads.mockRestore(); }
    expect(bytesRead).toBe(size);
    const db = new Database(f.dbPath);
    try {
      const checkpoint = db.query("SELECT * FROM gauge_files").all();
      expect((await ingest()).details[0]?.readLines).toBe(0);
      expect(db.query("SELECT * FROM gauge_files").all()).toEqual(checkpoint);
      expect(db.query("SELECT count(*) n FROM gauge_files WHERE store='other'").get()).toEqual({n:0});
      expect(fs.existsSync(other)).toBe(true);
      // Changing a historical byte, even with the same size and restored mtime, is not an append.
      const stat = fs.statSync(file), before = fs.readFileSync(file,"utf8");
      fs.writeFileSync(file,before.replace("10:00:00","09:00:00"));
      expect(fs.statSync(file).size).toBe(stat.size);
      fs.utimesSync(file,stat.atime,stat.mtime);
      expect((await ingest()).details[0]).toMatchObject({fromOffset:0,readLines:2});
      // Missing prefix evidence conservatively replays once, then becomes a no-op.
      db.exec("UPDATE gauge_files SET prefix_sha256=NULL");
      expect((await ingest()).details[0]).toMatchObject({fromOffset:0,readLines:2});
      expect((await ingest()).details[0]?.readLines).toBe(0);
    } finally { db.close(); }
  });

  test("a partial last line waits for its newline; a shrunken file is re-read from the start", async () => {
    const { archiveRoot, dbPath } = fixture();
    const file = writeJournal(archiveRoot, "EXAMPLE-MAIN-sample_a", "probe_windows.jsonl", [probeLine({})]);
    fs.appendFileSync(file, probeLine({ ts: "2026-09-02T10:05:00.000Z" }).slice(0, 40));
    const partial = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "other" }));
    expect(partial.rows).toBe(1);
    const bookmark = partial.details[0]!;
    expect(bookmark.toOffset).toBeLessThan(fs.statSync(file).size);
    // A rewrite shorter than the bookmark offset is the rotation signal.
    fs.writeFileSync(
      file,
      JSON.stringify({ provider: "codex", subject: "codex1", ts: "2026-09-02T11:00:00.000Z", kind: "primary", reported_percent_side: "used" }) + "\n"
    );
    const shrunk = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "other" }));
    expect(shrunk.details[0]?.fromOffset).toBe(0);
    expect(shrunk.rows).toBe(1);
  });

  test("malformed lines are counted, never fatal", async () => {
    const { archiveRoot, dbPath } = fixture();
    writeJournal(archiveRoot, "EXAMPLE-MAIN-sample_a", "probe_windows.jsonl", ["{not json", probeLine({}), JSON.stringify({ provider: "codex" })]);
    const result = (await ingestGaugesAsync({ atlasPath: dbPath, force: false, archiveRoot, ownStore: "other" }));
    expect(result.rows).toBe(1);
    expect(result.malformed).toBe(2);
  });
});
