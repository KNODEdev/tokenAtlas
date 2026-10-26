import { dailyJournalFile } from "../providers/core/journal-files";
import { afterEach, expect, test, spyOn } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ARCHIVE_WRITERS_DIRECTORY, ArchiveWritesPausedError, acquireArchiveWriterFence, withArchiveWriter } from "./archive-writers";
import { ensureArchiveIdentity } from "./archive-inventory";
import { allocateLocalIdentity } from "../config/local-identity";
import { prepareArchiveConnection } from "../config/archive-location";
import { atomicArchiveWrite, publishArchiveFile } from "./archive-publication";
import { savePlans } from "../server/plans";
import { flushGaugeJournal } from "../providers/core/journal";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) removeTestFixture(directory, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-writers-"));
  directories.push(root);
  const archive = path.join(root, "archive");
  fs.mkdirSync(archive);
  ensureArchiveIdentity(archive);
  return { root, archive, coordination: path.join(archive, ARCHIVE_WRITERS_DIRECTORY) };
}
function withIsolatedMachine<T>(root: string, operation: (machineId: string) => T): T {
  const prior = process.env.TOKENATLAS_LOCAL_STATE;
  process.env.TOKENATLAS_LOCAL_STATE = path.join(root, "local-state");
  try {
    const identity = allocateLocalIdentity("archive-writer-test", "test", { machine: "fixture", profile: "fixture-test" });
    return operation(identity.machine_id);
  } finally {
    if (prior === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
    else process.env.TOKENATLAS_LOCAL_STATE = prior;
  }
}
function copyArchiveIdentity(source: string, destination: string): void {
  const metadata = path.join(destination, ".archive-inventory");
  fs.mkdirSync(metadata, { recursive: true });
  fs.copyFileSync(path.join(source, ".archive-inventory", "identity.json"), path.join(metadata, "identity.json"));
}

test("private-link sharing violations preserve successful writer and fence ownership", () => {
  const f = fixture();
  withIsolatedMachine(f.root, () => {
    const unlink = fs.unlinkSync.bind(fs);
    const cleanup = spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (path.dirname(String(file)) === f.coordination && String(file).endsWith(".tmp")) {
        throw Object.assign(new Error("simulated sharing violation"), { code: "EPERM" });
      }
      unlink(file);
    });
    try {
      expect(withArchiveWriter(f.archive, () => "written")).toBe("written");
      const fence = acquireArchiveWriterFence(f.archive, randomUUID());
      fence.assertDrained();
      fence.release();
      expect(fs.readdirSync(f.coordination).filter(name => name.endsWith(".json"))).toEqual([]);
      expect(fs.readdirSync(f.coordination).some(name => name.endsWith(".tmp"))).toBe(true);
    } finally { cleanup.mockRestore(); }
  });
});

test("admission closes before existing writers drain; nested publication finishes under its lease", async () => {
  const f = fixture();
  let continueWrite!: () => void;
  const ready = new Promise<void>(resolve => { continueWrite = resolve; });
  const writer = withArchiveWriter(f.archive, async () => {
    await ready;
    atomicArchiveWrite(path.join(f.archive, "config", "plans.json"), "finished");
  });
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  expect(() => fence.assertDrained()).toThrow("writer still active");
  expect(() => atomicArchiveWrite(path.join(f.archive, "new.json"), "wrong")).toThrow(ArchiveWritesPausedError);
  continueWrite();
  await writer;
  fence.assertDrained();
  expect(fs.readFileSync(path.join(f.archive, "config", "plans.json"), "utf8")).toBe("finished");
  expect(fs.existsSync(path.join(f.archive, "new.json"))).toBe(false);
  fence.release();
  atomicArchiveWrite(path.join(f.archive, "new.json"), "right");
  expect(fs.readFileSync(path.join(f.archive, "new.json"), "utf8")).toBe("right");
});

test("released async context cannot grant detached work permission through a fence", async () => {
  const f = fixture();
  let continueWrite!: () => void;
  const ready = new Promise<void>(resolve => { continueWrite = resolve; });
  let result!: Promise<unknown>;
  withArchiveWriter(f.archive, () => {
    result = ready.then(() => {
      try { return atomicArchiveWrite(path.join(f.archive, "late.json"), "wrong"); }
      catch (error) { return error; }
    });
  });
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  continueWrite();
  expect(await result).toBeInstanceOf(ArchiveWritesPausedError);
  fence.assertDrained();
  fence.release();
});

test("fenced and relocated roots reject publication, archive identity and settings without changing data", () => {
  const f = fixture();
  const input = path.join(f.root, "source.jsonl");
  fs.writeFileSync(input, '{"tokens":7}\n');
  const plans = path.join(f.archive, "config", "plans.json");
  atomicArchiveWrite(plans, '{"segments":[]}');
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  expect(() => publishArchiveFile(input, path.join(f.archive, "codex", "source.jsonl"), { archiveRoot: f.archive })).toThrow(ArchiveWritesPausedError);
  expect(() => ensureArchiveIdentity(f.archive)).toThrow(ArchiveWritesPausedError);
  expect(() => savePlans(path.dirname(plans), { segments: [{ subscription: "test", usd_per_month: 4 }] })).toThrow(ArchiveWritesPausedError);
  expect(fs.readFileSync(plans, "utf8")).toBe('{"segments":[]}');
  expect(fs.existsSync(path.join(f.archive, "codex"))).toBe(false);
  const moved = path.join(f.root, "moved");
  fs.mkdirSync(moved);
  copyArchiveIdentity(f.archive, moved);
  fence.markRelocated(moved);
  expect(() => fence.release()).toThrow("no longer owned");
  expect(() => atomicArchiveWrite(plans, "wrong")).toThrow("Archive moved");
  expect(() => acquireArchiveWriterFence(f.archive, randomUUID())).toThrow("Archive moved");
  const external = path.join(f.root, "external.json");
  atomicArchiveWrite(external, "outside");
  expect(fs.readFileSync(external, "utf8")).toBe("outside");
});

test("remote or malformed leases are never expired on elapsed time", () => {
  const f = fixture();
  const token = randomUUID();
  const lease = path.join(f.coordination, `${token}.json`);
  fs.writeFileSync(lease, JSON.stringify({ schema: 1, token, host: "another-machine", pid: 42, startedAt: "2000-01-01" }));
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  expect(() => fence.assertDrained()).toThrow("another-machine/42");
  expect(fs.existsSync(lease)).toBe(true);
  fs.writeFileSync(lease, "broken");
  expect(() => fence.assertDrained()).toThrow();
  fence.release();
});

test("same-host foreign and legacy owners are never reclaimed without this machine instance ID", () => {
  const f = fixture();
  withIsolatedMachine(f.root, machineId => {
    const foreignToken = randomUUID();
    const foreign = path.join(f.coordination, `${foreignToken}.json`);
    fs.writeFileSync(foreign, JSON.stringify({ schema: 1, token: foreignToken, host: os.hostname(), pid: 2147483647, machineId: randomUUID() }));
    const legacyToken = randomUUID();
    const legacy = path.join(f.coordination, `${legacyToken}.json`);
    fs.writeFileSync(legacy, JSON.stringify({ schema: 1, token: legacyToken, host: os.hostname(), pid: 2147483647 }));
    const fence = acquireArchiveWriterFence(f.archive, randomUUID());
    expect(() => fence.assertDrained()).toThrow("writer still active");
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(machineId).not.toBe(JSON.parse(fs.readFileSync(foreign, "utf8")).machineId);
    fence.release();
  });
});

test("writer guards do not allocate missing local identity state", () => {
  const f = fixture();
  const localState = path.join(f.root, "unallocated-local-state");
  const prior = process.env.TOKENATLAS_LOCAL_STATE;
  process.env.TOKENATLAS_LOCAL_STATE = localState;
  try {
    withArchiveWriter(f.archive, () => {});
    expect(fs.existsSync(localState)).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.TOKENATLAS_LOCAL_STATE;
    else process.env.TOKENATLAS_LOCAL_STATE = prior;
  }
});

test("missing configured archive fails closed without recreating directories", () => {
  const f = fixture();
  const missingArchive = path.join(f.root, "missing-archive");
  const source = path.join(f.root, "source.jsonl");
  fs.writeFileSync(source, "{}\n");
  const prior = process.env.TOKENATLAS_ARCHIVE;
  process.env.TOKENATLAS_ARCHIVE = missingArchive;
  try {
    expect(() => atomicArchiveWrite(path.join(missingArchive, "config", "plans.json"), "wrong")).toThrow();
    expect(() => publishArchiveFile(source, path.join(missingArchive, "codex", "session.jsonl"), { archiveRoot: missingArchive })).toThrow();
    expect(fs.existsSync(missingArchive)).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.TOKENATLAS_ARCHIVE;
    else process.env.TOKENATLAS_ARCHIVE = prior;
  }
});

test("canonical aliases share one lease and one fence", async () => {
  const f = fixture();
  const alias = path.join(f.root, "archive-alias");
  fs.symlinkSync(f.archive, alias, process.platform === "win32" ? "junction" : "dir");
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const writer = withArchiveWriter(alias, async () => { await blocked; });
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  expect(() => fence.assertDrained()).toThrow("writer still active");
  finish();
  await writer;
  fence.assertDrained();
  fence.release();
});

test("relocated barrier accepts only a distinct directory with the same archive identity", () => {
  const f = fixture();
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  expect(() => fence.markRelocated(f.archive)).toThrow("Invalid archive relocation destination");
  const file = path.join(f.root, "not-a-directory");
  fs.writeFileSync(file, "x");
  expect(() => fence.markRelocated(file)).toThrow("Invalid archive relocation destination");
  const different = path.join(f.root, "different");
  fs.mkdirSync(different);
  ensureArchiveIdentity(different);
  expect(() => fence.markRelocated(different)).toThrow("different archive");
  const moved = path.join(f.root, "moved");
  fs.mkdirSync(moved);
  copyArchiveIdentity(f.archive, moved);
  fence.markRelocated(moved);
});

test("connection probes cannot mutate a fenced archive", () => {
  const f = fixture();
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  expect(() => prepareArchiveConnection(f.archive, "connect", { database: path.join(f.root, "atlas.sqlite") })).toThrow(ArchiveWritesPausedError);
  expect(fs.readdirSync(f.archive).some(name => name.startsWith(".archive-write-check-"))).toBe(false);
  fence.release();
});

test("failed publication releases its lease without opening the relocation gate", () => {
  const f = fixture();
  expect(() => withArchiveWriter(f.archive, () => { throw new Error("write failed"); })).toThrow("write failed");
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  fence.assertDrained();
  expect(() => withArchiveWriter(f.archive, () => {})).toThrow(ArchiveWritesPausedError);
  fence.release();
});

test("journal keeps durable outbox while fenced and delivers once after release", () => {
  const f = fixture();
  const sqlite = new Database(":memory:");
  const journalRoot = path.join(f.archive, "gauges", "fixture");
  sqlite.exec(`CREATE TABLE gauge_journal_outbox(id INTEGER PRIMARY KEY, journal_root TEXT, archive_root TEXT, file_name TEXT, payload TEXT)`);
  sqlite.query("INSERT INTO gauge_journal_outbox VALUES(1,?,?,?,?)").run(journalRoot, f.archive, "probe_windows.jsonl", '{"entry_id":"one"}');
  const fence = acquireArchiveWriterFence(f.archive, randomUUID());
  try {
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.archive })).toEqual({ delivered: 0, error: "archive-paused" });
    expect(sqlite.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 1 });
    expect(fs.existsSync(journalRoot)).toBe(false);
    fence.release();
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.archive })).toEqual({ delivered: 1, error: null });
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.archive })).toEqual({ delivered: 0, error: null });
    expect(fs.readFileSync(path.join(journalRoot, dailyJournalFile("probe_windows.jsonl", new Date())), "utf8")).toBe('{"entry_id":"one"}\n');
  } finally { sqlite.close(); }
});
