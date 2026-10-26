import { dailyJournalFile, listJournalFiles, type JournalKind } from "./journal-files";
import { compactProbeLine, expandCompactProbe, expandProbeJournal } from "./journal-compact";
import { createProbeCollection } from "../../db/probe-facts";
import { digest } from "../../config/canonical-json";
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../../db/migrate";
import { ingestGaugesAsync } from "../../ingest/gauges";
import { configureGaugeJournal, enqueueGaugeJournal, flushGaugeJournal, pendingGaugeJournalLines,
  PROBE_JOURNAL_FILE, OBSERVATION_JOURNAL_FILE } from "./journal";
import { persistProbeWindows } from "./probe";
import { deliverGaugeJournal } from "../../server/background-jobs";
import { interruptJournalFsync } from "./journal-fault-fixture";
import type { WindowReading } from "../types";

const dirs: string[] = [];
const dbs: Database[] = [];
function open(file: string) {
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  applyDrizzleMigrations(drizzle(db)); dbs.push(db); return db;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-outbox-")); dirs.push(root);
  const dbPath = path.join(root, "atlas.sqlite");
  const archiveRoot = path.join(root, "archive");
  const journalRoot = path.join(archiveRoot, "gauges", "producer-user");
  const db = open(dbPath);
  configureGaugeJournal(journalRoot, { archiveRoot });
  return { root, dbPath, archiveRoot, journalRoot, db };
}
const reading: WindowReading = {
  kind: "primary", group: "codex", scope: null, plan: "plus", reportedPercentSide: "used",
  usedPercent: 42, remainingPercent: null, vendorPercent: 42, windowMinutes: 300,
  allowance: null, used: null, remaining: null, resetsAt: "2026-09-06T12:00:00Z",
  rateLimitReached: false, resetCredits: null, profile: null, ok: true, error: null, extra: null,
};
const ts = "2026-09-05T12:00:00.000Z";
test("three cycles retain dense producer facts through a full line and compact references", async () => {
  const f = fixture(); fs.mkdirSync(f.archiveRoot);
  for (const [i, percent] of [42, 42, 43].entries()) {
    persistProbeWindows(f.db, "codex", "one", `2026-09-05T12:0${i}:00.000Z`, [
      { ...reading, usedPercent: percent }, { ...reading, kind: "secondary", usedPercent: percent + 1 },
    ]);
  }
  expect(flushGaugeJournal(f.db, f)).toEqual({ delivered: 6, error: null });
  const delivered = lines(f).map(line => JSON.parse(line) as Record<string, unknown>);
  expect(delivered.map(row => row.journal_version)).toEqual([3, 3, 3, 3, 3, 3]);
  expect(delivered.map(row => "p" in row)).toEqual([true, true, false, false, false, false]);
  const expanded = expandProbeJournal(lines(f));
  const bases = expanded.slice(0, 2).map(row => (row.canonical_probe as { counter_id: string }).counter_id);
  expect(delivered.slice(2).map(row => row.b)).toEqual([...bases, ...bases]);
  const receiver = targetDb(f);
  expect((await importJournal(f, receiver)).rows).toBe(6);
  const db = open(receiver);
  for (const table of ["probe_counters", "probe_observations", "probe_windows"]) {
    const producer = f.db.query(`SELECT * FROM ${table} ORDER BY id`).all();
    expect(producer).toHaveLength(table === "probe_observations" ? 3 : 6);
    expect(db.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(producer);
  }
});

test("a rolled-back enqueue cannot supply a compact base to the next reading", () => {
  const f = fixture();
  expect(() => f.db.transaction(() => { probe(f.db); throw new Error("rollback compact base"); })()).toThrow("rollback compact base");
  for (const table of ["probe_counters", "probe_observations", "probe_fact_deliveries", "gauge_journal_outbox"])
    expect(f.db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  probe(f.db, "2026-09-05T12:01:00.000Z");
  const queued = f.db.query("SELECT payload FROM gauge_journal_outbox").get() as { payload: string };
  const record = JSON.parse(queued.payload) as Record<string, unknown>;
  expect(record).toMatchObject({ journal_version: 3, p: { ts: "2026-09-05T12:01:00.000Z" } });
  expect(record.b).toBeUndefined();
  expect(expandCompactProbe(record, null).fact.counter_id).toBe(
    (f.db.query("SELECT id FROM probe_counters").get() as { id: string }).id);
});

test("a committed compact base is used today but not after UTC midnight", () => {
  const f = fixture();
  try {
    setSystemTime(new Date("2026-09-21T23:59:58.000Z")); probe(f.db, "2026-09-21T23:59:58.000Z");
    setSystemTime(new Date("2026-09-21T23:59:59.000Z")); probe(f.db, "2026-09-21T23:59:59.000Z");
    setSystemTime(new Date("2026-09-22T00:00:00.000Z")); probe(f.db, "2026-09-22T00:00:00.000Z");
    const queued = (f.db.query("SELECT payload FROM gauge_journal_outbox ORDER BY id").all() as { payload: string }[])
      .map(row => JSON.parse(row.payload) as Record<string, unknown>);
    expect(queued.map(row => "p" in row)).toEqual([true, false, true]);
    expect(queued[1]!.b).toBe(expandCompactProbe(queued[0]!, null).fact.counter_id);
    expect(queued[2]!.b).toBeUndefined();
    expect(expandCompactProbe(queued[2]!, null).outer.ts).toBe("2026-09-22T00:00:00.000Z");
  } finally { setSystemTime(); }
});

for (const existingLegacy of [false, true]) test(`daily delivery preserves legacy files (existing: ${existingLegacy}) and reaches a receiver`, async () => {
  const f = fixture();
  fs.mkdirSync(f.journalRoot, { recursive: true });
  const legacy = path.join(f.journalRoot, PROBE_JOURNAL_FILE);
  const legacyBytes = Buffer.from(JSON.stringify({ provider: "codex", subject: "historical", ts: "2026-08-01T12:00:00.000Z",
    kind: "primary", reported_percent_side: "used", used_percent: 7, machine: "producer-user" }) + "\r\n");
  if (existingLegacy) fs.writeFileSync(legacy, legacyBytes);
  probe(f.db);
  expect(f.db.query("SELECT file_name FROM gauge_journal_outbox ORDER BY id").all()).toEqual([{ file_name: PROBE_JOURNAL_FILE }]);
  const before = new Date();
  expect(flushGaugeJournal(f.db, f)).toEqual({ delivered: 1, error: null });
  const after = new Date();
  const segments = listJournalFiles(f.journalRoot, PROBE_JOURNAL_FILE).filter(name => name !== PROBE_JOURNAL_FILE);
  expect(segments).toHaveLength(1);
  expect([dailyJournalFile(PROBE_JOURNAL_FILE, before), dailyJournalFile(PROBE_JOURNAL_FILE, after)]).toContain(segments[0]!);
  const row = expandProbeJournal([fs.readFileSync(path.join(f.journalRoot, segments[0]!), "utf8")])[0];
  expect(row).toMatchObject({ journal_version: 3, ts });
  expect(fs.existsSync(legacy)).toBe(existingLegacy);
  if (existingLegacy) expect(fs.readFileSync(legacy)).toEqual(legacyBytes);
  expect(pendingGaugeJournalLines(f.db)).toBe(0);
  const receiver = targetDb(f);
  expect((await importJournal(f, receiver))).toMatchObject({ rows: existingLegacy ? 2 : 1, malformed: 0 });
  const db = open(receiver);
  expect(db.query("SELECT used_percent FROM probe_windows ORDER BY id").all()).toEqual(
    (existingLegacy ? [7, 42] : [42]).map(used_percent => ({ used_percent })));
  expect((await importJournal(f, receiver, false)).rows).toBe(0);
});

function probe(db: Database, time = ts) { return persistProbeWindows(db, "codex", "one", time, [reading]); }
function lines(f: ReturnType<typeof fixture>, file: JournalKind = PROBE_JOURNAL_FILE) {
  return fs.readFileSync(path.join(f.journalRoot, dailyJournalFile(file, new Date())), "utf8").trim().split("\n");
}
function targetDb(f: ReturnType<typeof fixture>) {
  const file = path.join(f.root, "receiver.sqlite"); open(file); return file;
}
async function importJournal(f: ReturnType<typeof fixture>, file: string, force = true) {
  return (await ingestGaugesAsync({ atlasPath: file, archiveRoot: f.archiveRoot, ownStore: "receiver-user", force }));
}
afterEach(() => {
  configureGaugeJournal(null);
  dbs.splice(0).forEach(db => { try { db.close(true); } catch {} });
  dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("durable gauge journal outbox", () => {
  test("producer commits the fact and immutable transport entry without filesystem I/O", () => {
    const f = fixture();
    const write = spyOn(fs, "writeSync");
    try { probe(f.db); expect(write).not.toHaveBeenCalled(); } finally { write.mockRestore(); }
    expect(fs.existsSync(f.archiveRoot)).toBe(false);
    const row = f.db.query("SELECT * FROM gauge_journal_outbox").get() as { entry_id: string; payload: string };
    expect(expandProbeJournal([row.payload])[0]).toMatchObject({ journal_entry_id: row.entry_id, journal_version: 3, raw_subject: "one" });
    expect(f.db.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 1 });
  });
  test("outbox failure rolls back all readings and projection-trigger writes", () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON gauge_journal_outbox BEGIN SELECT RAISE(ABORT,'outbox-fault'); END");
    expect(() => probe(f.db)).toThrow("outbox-fault");
    expect(f.db.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT probe_revision FROM current_projection_state").get()).toEqual({ probe_revision: 0 });
    expect(pendingGaugeJournalLines(f.db)).toBe(0);
  });
  test("outer rollback keeps the fact, queue and archive unchanged", () => {
    const f = fixture();
    expect(() => f.db.transaction(() => { probe(f.db); throw new Error("outer"); })()).toThrow("outer");
    expect(pendingGaugeJournalLines(f.db)).toBe(0);
    expect(fs.existsSync(f.archiveRoot)).toBe(false);
    expect(f.db.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 0 });
  });
  test("unmounted archive, disable, reconfigure and reopen never discard or redirect work", () => {
    const f = fixture(); probe(f.db);
    expect(flushGaugeJournal(f.db, f)).toEqual({ delivered: 0, error: "archive-unavailable" });
    configureGaugeJournal(null); f.db.close();
    const reopened = open(f.dbPath);
    expect(pendingGaugeJournalLines(reopened)).toBe(1);
    const other = { journalRoot: path.join(f.root, "other"), archiveRoot: null };
    configureGaugeJournal(other.journalRoot);
    expect(flushGaugeJournal(reopened, other).delivered).toBe(0);
    expect(pendingGaugeJournalLines(reopened)).toBe(1);
    fs.mkdirSync(f.archiveRoot);
    expect(flushGaugeJournal(reopened, f)).toEqual({ delivered: 1, error: null });
    expect(pendingGaugeJournalLines(reopened)).toBe(0);
  });
  test("drain has a bounded batch and never changes usage revisions", () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot);
    for (let i = 0; i < 20; i++) probe(f.db, `2026-09-05T12:00:${String(i).padStart(2, "0")}.000Z`);
    const before = f.db.query("SELECT * FROM sync_revisions").all();
    expect(flushGaugeJournal(f.db, f).delivered).toBe(16);
    expect(pendingGaugeJournalLines(f.db)).toBe(4);
    expect(flushGaugeJournal(f.db, f).delivered).toBe(4);
    expect(f.db.query("SELECT * FROM sync_revisions").all()).toEqual(before);
    expect(() => flushGaugeJournal(f.db, f, 1000)).toThrow();
  });
  test("oversized payload fails explicitly without committing a partial set of facts", () => {
    const f = fixture();
    expect(() => persistProbeWindows(f.db, "codex", "one", ts, [reading, { ...reading, kind: "secondary", extra: { text: "x".repeat(65536) } }])).toThrow("64 KiB");
    expect(pendingGaugeJournalLines(f.db)).toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 0 });
  });
  test("unsafe enqueue and draining an uncommitted connection are rejected", () => {
    const f = fixture();
    expect(() => enqueueGaugeJournal(f.db, PROBE_JOURNAL_FILE, [{} as never])).toThrow("fact transaction");
    expect(() => f.db.transaction(() => flushGaugeJournal(f.db, f))()).toThrow("independent committed connection");
  });
  test("delivers into an existing cloud directory whose recursive mkdir raises EEXIST", () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot); fs.mkdirSync(f.journalRoot, { recursive: true }); probe(f.db);
    // Bun does this for an existing OneDrive directory that carries the read-only attribute.
    const original = fs.mkdirSync;
    const mkdir = spyOn(fs, "mkdirSync").mockImplementation(((...args: Parameters<typeof fs.mkdirSync>) => {
      if (fs.existsSync(args[0])) throw Object.assign(new Error("Existing cloud directory"), { code: "EEXIST" });
      return Reflect.apply(original, fs, args);
    }) as typeof fs.mkdirSync);
    try { expect(flushGaugeJournal(f.db, f)).toEqual({ delivered: 1, error: null }); } finally { mkdir.mockRestore(); }
    expect(pendingGaugeJournalLines(f.db)).toBe(0);
  });
  test("fsync failure retains queue and retry uses identical IDs and receiver facts", async () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot); probe(f.db);
    const restore = interruptJournalFsync(path.join(f.journalRoot, dailyJournalFile(PROBE_JOURNAL_FILE, new Date())), () => { throw new Error("disk fault"); });
    try { expect(flushGaugeJournal(f.db, f).error).toBe("delivery-failed"); } finally { restore(); }
    expect(pendingGaugeJournalLines(f.db)).toBe(1);
    expect(flushGaugeJournal(f.db, f).delivered).toBe(1);
    expect(lines(f)).toHaveLength(2);
    expect(lines(f)[0]).toBe(lines(f)[1]);
    const receiver = targetDb(f);
    expect((await importJournal(f, receiver)).rows).toBe(1);
    expect((await importJournal(f, receiver)).rows).toBe(0);
  });
  test("real process death after fsync leaves recoverable work and no duplicate receiver fact", async () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot); probe(f.db);
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "journal-process-fixture.ts"), f.dbPath, f.journalRoot, f.archiveRoot, "crash-after-fsync"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(73);
    expect(pendingGaugeJournalLines(f.db)).toBe(1);
    expect(flushGaugeJournal(f.db, f).delivered).toBe(1);
    expect(lines(f)).toHaveLength(2);
    expect(lines(f)[0]).toBe(lines(f)[1]);
    expect((await importJournal(f, targetDb(f))).rows).toBe(1);
  });
  test("two independent processes serialize delivery for one local database", async () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot);
    for (let i = 0; i < 8; i++) probe(f.db, `2026-09-05T12:00:0${i}.000Z`);
    const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, path.join(import.meta.dir, "journal-process-fixture.ts"), f.dbPath, f.journalRoot, f.archiveRoot, "drain"], { stdout: "pipe", stderr: "pipe" }));
    expect(await Promise.all(children.map(p => p.exited))).toEqual([0, 0]);
    expect(lines(f)).toHaveLength(8);
    expect(pendingGaugeJournalLines(f.db)).toBe(0);
  });
  test("partial append is separated, retried and never hides the next complete entry", async () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot); probe(f.db);
    const original = fs.writeSync; let once = false;
    const partial = spyOn(fs, "writeSync").mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) => {
      if (!once) { once = true; return original(fd, bytes, offset, Math.min(30, length)); }
      throw new Error("partial");
    }) as typeof fs.writeSync);
    try { expect(flushGaugeJournal(f.db, f).error).toBe("delivery-failed"); } finally { partial.mockRestore(); }
    expect(flushGaugeJournal(f.db, f).delivered).toBe(1);
    const result = (await importJournal(f, targetDb(f)));
    expect(result.rows).toBe(1); expect(result.malformed).toBe(1);
  });
  test("receiver refuses altered reuse of a delivery ID and rolls back the bookmark", async () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot); probe(f.db); flushGaugeJournal(f.db, f);
    const receiver = targetDb(f); expect((await importJournal(f, receiver)).rows).toBe(1);
    const db = open(receiver); const bookmark = db.query("SELECT * FROM gauge_files").all();
    const row = JSON.parse(lines(f)[0]!);
    const original = expandCompactProbe(row, null).fact;
    row.p.used_percent = 90;
    row.d = digest({ ...original.payload, used_percent: 90 }).slice(0, 16);
    fs.appendFileSync(path.join(f.journalRoot, dailyJournalFile(PROBE_JOURNAL_FILE, new Date())), JSON.stringify(row) + "\n");
    await expect(importJournal(f, receiver, false)).rejects.toThrow("identity conflict");
    expect(db.query("SELECT * FROM gauge_files").all()).toEqual(bookmark);
    expect(db.query("SELECT used_percent FROM probe_windows").get()).toEqual({ used_percent: 42 });
  });
  test("unsupported envelopes fail without downgrading to legacy import", async () => {
    const f = fixture(); fs.mkdirSync(f.archiveRoot); probe(f.db); flushGaugeJournal(f.db, f);
    const row = JSON.parse(lines(f)[0]!); row.journal_version = 99;
    fs.writeFileSync(path.join(f.journalRoot, dailyJournalFile(PROBE_JOURNAL_FILE, new Date())), JSON.stringify(row) + "\n");
    const receiver = targetDb(f);
    await expect(importJournal(f, receiver)).rejects.toThrow("Unsupported");
    expect(open(receiver).query("SELECT count(*) AS n FROM gauge_files").get()).toEqual({ n: 0 });
  });
  test("account observation segments stay in the archive and are read past, not imported", async () => {
    const f = fixture(); fs.mkdirSync(f.journalRoot, { recursive: true });
    const segment = path.join(f.journalRoot, dailyJournalFile(OBSERVATION_JOURNAL_FILE, new Date()));
    const bytes = JSON.stringify({ ts, vendor: "codex", source: "profile", identity_kind: "email", identity: "a@example.test",
      raw_source: null, machine: "producer-user", login: "x", journal_version: 2, journal_entry_id: crypto.randomUUID() }) + "\n";
    fs.writeFileSync(segment, bytes);
    const receiver = targetDb(f);
    expect((await importJournal(f, receiver))).toMatchObject({ rows: 0, malformed: 0 });
    const db = open(receiver);
    expect(db.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM probe_counters").get()).toEqual({ n: 0 });
    expect(db.query("SELECT path, offset FROM gauge_files").all()).toEqual([{ path: path.basename(segment), offset: Buffer.byteLength(bytes) }]);
    expect(fs.readFileSync(segment, "utf8")).toBe(bytes);
    expect((await importJournal(f, receiver, false)).rows).toBe(0);
  });
  test("the background writer's delivery recovers a returning archive without a new measurement or transition", () => {
    const f = fixture(); probe(f.db);
    const target = { journalRoot: f.journalRoot, archiveRoot: f.archiveRoot };
    expect(deliverGaugeJournal(f.db, target)).toMatchObject({ delivered: 0, error: "archive-unavailable", pending: 1 });
    fs.mkdirSync(f.archiveRoot);
    expect(deliverGaugeJournal(f.db, target)).toMatchObject({ delivered: 1, error: null, pending: 0 });
    expect(lines(f)).toHaveLength(1);
  });
});

// A versioned record must not bypass delivery validation by losing a required
// payload field. Otherwise the importer acknowledges the byte offset forever.
for (const journalFile of [PROBE_JOURNAL_FILE] as const) {
  describe(`versioned payload boundary: ${journalFile}`, () => {
    function delivered() {
      const f = fixture(); fs.mkdirSync(f.archiveRoot);
      probe(f.db);
      expect(flushGaugeJournal(f.db, f).delivered).toBe(1);
      const file = path.join(f.journalRoot, dailyJournalFile(journalFile, new Date()));
      const row = JSON.parse(lines(f, journalFile)[0]!);
      const receiver = targetDb(f);
      return { f, file, row, receiver, db: open(receiver) };
    }
    function malformed(row: Record<string, unknown>) {
      const result = { ...row };
      const fields = { ...row.p as Record<string, unknown> }; delete fields.subject; result.p = fields;
      return result;
    }
    function state(db: Database) {
      return {
        bookmarks: db.query("SELECT * FROM gauge_files ORDER BY store, path").all(),
        receipts: db.query("SELECT * FROM gauge_journal_receipts ORDER BY entry_id").all(),
        probes: db.query("SELECT * FROM probe_windows ORDER BY id").all(),
        projection: db.query("SELECT * FROM current_projection_state").all(),
        dirty: db.query("SELECT * FROM current_projection_dirty ORDER BY provider, subject").all(),
      };
    }
    test("malformed replay rolls back valid preceding rows, receipts and the bookmark", async () => {
      const { f, file, row, receiver, db } = delivered();
      expect((await importJournal(f, receiver)).rows).toBe(1);
      const before = state(db);
      const fresh = JSON.parse(compactProbeLine(crypto.randomUUID(), createProbeCollection([
        { ...expandCompactProbe(row, null).outer, ts: "2026-09-05T12:01:00.000Z" },
      ])[0]!, null).line);
      fs.appendFileSync(file, JSON.stringify(fresh) + "\n" + JSON.stringify(malformed(row)) + "\n");
      await expect(importJournal(f, receiver, false)).rejects.toThrow();
      expect(state(db)).toEqual(before);
    });
    test("a new malformed versioned payload is not silently acknowledged", async () => {
      const { f, file, row, receiver, db } = delivered();
      const before = state(db);
      fs.writeFileSync(file, JSON.stringify(malformed(row)) + "\n");
      await expect(importJournal(f, receiver)).rejects.toThrow("Invalid canonical probe");
      expect(state(db)).toEqual(before);
    });
    test("an unsupported envelope is rejected even if its payload is malformed", async () => {
      const { f, file, row, receiver, db } = delivered();
      const before = state(db);
      fs.writeFileSync(file, JSON.stringify({ ...malformed(row), journal_version: 99 }) + "\n");
      await expect(importJournal(f, receiver)).rejects.toThrow("Unsupported gauge journal envelope");
      expect(state(db)).toEqual(before);
    });
  });
}
