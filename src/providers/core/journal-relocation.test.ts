import { listJournalFiles } from "./journal-files";
import { afterEach, expect, test } from "bun:test";
import { Database } from "../../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pinCanonicalArchiveRoot, readCanonicalArchiveRoot } from "../../config/archive-paths";
import { acquireArchiveWriterFence } from "../../sync/archive-writers";
import { ensureArchiveIdentity } from "../../sync/archive-inventory";
import {
  PROBE_JOURNAL_FILE,
  configureGaugeJournal,
  enqueueGaugeJournal,
  flushGaugeJournal,
  pendingGaugeJournalLines,
  type ProbeJournalRow,
} from "./journal";

const temporary: string[] = [];
afterEach(() => {
  configureGaugeJournal(null);
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function database(file: string): Database {
  const sqlite = new Database(file, { create: true });
  sqlite.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS gauge_journal_outbox(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      journal_root TEXT NOT NULL,
      archive_root TEXT,
      file_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      queued_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_marker(value TEXT NOT NULL);`);
  if (!sqlite.query("SELECT 1 FROM local_marker").get()) {
    sqlite.query("INSERT INTO local_marker(value) VALUES(?)").run("nonempty-local-index");
  }
  return sqlite;
}
function archive(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const archiveId = ensureArchiveIdentity(root);
  pinCanonicalArchiveRoot(root);
  return archiveId;
}
function bind(sqlite: Database, archiveId: string): void {
  sqlite.query("INSERT INTO meta(key,value) VALUES('archive:identity',?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(archiveId);
}
function reading(ts: string): ProbeJournalRow {
  return {
    provider: "codex", subject: "fixture", ts, plan: null, kind: "primary", limit_group: null, scope: null,
    reported_percent_side: "used", used_percent: 10, remaining_percent: null, vendor_percent: null,
    window_minutes: null, allowance: null, used: null, remaining: null, resets_at: null,
    rate_limit_reached: null, reset_credits: null, profile: null, ok: 1, error: null, extra: null,
    machine: "fixture-machine", login: "fixture-login", source_home: null, raw_subject: "fixture",
  };
}
function enqueue(sqlite: Database, ts: string): void {
  sqlite.transaction(() => enqueueGaugeJournal(sqlite, PROBE_JOURNAL_FILE, [reading(ts)])).immediate();
}
function lines(root: string): Array<{ ts: string; journal_entry_id: string }> {
  return listJournalFiles(root, PROBE_JOURNAL_FILE)
    .flatMap(file => fs.readFileSync(path.join(root, file), "utf8").trim().split("\n"))
    .filter(Boolean).map((line) => JSON.parse(line));
}

function relocationFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-journal-relocation-"));
  temporary.push(base);
  const original = path.join(base, "archive-original");
  const moved = path.join(base, "archive-moved");
  const movedAgain = path.join(base, "archive-moved-again");
  const dbPath = path.join(base, "atlas.sqlite");
  const archiveId = archive(original);
  const journalRelative = path.join("gauges", "fixture-machine-fixture-login");
  return { base, original, moved, movedAgain, dbPath, archiveId, journalRelative };
}

test("pending rows survive restart and relocate by durable archive identity, while future rows keep logical coordinates", () => {
  const f = relocationFixture();
  let sqlite = database(f.dbPath);
  bind(sqlite, f.archiveId);
  const originalJournal = path.join(f.original, f.journalRelative);
  configureGaugeJournal(originalJournal, { archiveRoot: f.original });
  enqueue(sqlite, "2026-09-18T10:00:00.000Z");
  const queuedBeforeMove = sqlite.query("SELECT journal_root,archive_root FROM gauge_journal_outbox").get() as {
    journal_root: string; archive_root: string;
  };
  expect(queuedBeforeMove).toEqual({
    journal_root: path.resolve(originalJournal),
    archive_root: path.resolve(f.original),
  });
  expect(fs.existsSync(originalJournal)).toBe(false);

  fs.cpSync(f.original, f.moved, { recursive: true });
  const movedBinding = readCanonicalArchiveRoot(f.moved)!;
  expect(movedBinding.archiveId).toBe(f.archiveId);
  expect(movedBinding.originalLogicalRoot).toBe(path.resolve(f.original));
  const movedJournal = path.join(f.moved, f.journalRelative);
  configureGaugeJournal(movedJournal, { archiveRoot: f.moved });
  sqlite.close();
  sqlite = database(f.dbPath);
  try {
    expect(flushGaugeJournal(sqlite, { journalRoot: movedJournal, archiveRoot: f.moved }))
      .toEqual({ delivered: 1, error: null });
    expect(flushGaugeJournal(sqlite, { journalRoot: movedJournal, archiveRoot: f.moved }))
      .toEqual({ delivered: 0, error: null });
    expect(lines(movedJournal).map((row) => row.ts)).toEqual(["2026-09-18T10:00:00.000Z"]);
    expect(lines(originalJournal)).toEqual([]);

    enqueue(sqlite, "2026-09-18T10:05:00.000Z");
    const queuedAfterMove = sqlite.query("SELECT journal_root,archive_root FROM gauge_journal_outbox").get() as {
      journal_root: string; archive_root: string;
    };
    expect(queuedAfterMove).toEqual(queuedBeforeMove);

    fs.cpSync(f.moved, f.movedAgain, { recursive: true });
    const secondJournal = path.join(f.movedAgain, f.journalRelative);
    configureGaugeJournal(secondJournal, { archiveRoot: f.movedAgain });
    expect(flushGaugeJournal(sqlite, { journalRoot: secondJournal, archiveRoot: f.movedAgain }))
      .toEqual({ delivered: 1, error: null });
    expect(lines(secondJournal).map((row) => row.ts)).toEqual([
      "2026-09-18T10:00:00.000Z",
      "2026-09-18T10:05:00.000Z",
    ]);
    expect(lines(movedJournal).map((row) => row.ts)).toEqual(["2026-09-18T10:00:00.000Z"]);
    expect(pendingGaugeJournalLines(sqlite)).toBe(0);
  } finally {
    sqlite.close();
  }
});

test("foreign or unknown database identity never redirects legacy rows by matching paths", () => {
  const f = relocationFixture();
  fs.cpSync(f.original, f.moved, { recursive: true });
  const journalRoot = path.join(f.moved, f.journalRelative);
  const logicalJournal = path.join(f.original, f.journalRelative);
  const sqlite = database(f.dbPath);
  try {
    bind(sqlite, "different_archive");
    sqlite.query(`INSERT INTO gauge_journal_outbox
      (entry_id,journal_root,archive_root,file_name,payload,queued_at) VALUES(?,?,?,?,?,?)`)
      .run("same-path", logicalJournal, f.original, PROBE_JOURNAL_FILE,
        JSON.stringify({ journal_entry_id: "same-path", ts: "2026-09-18T11:00:00.000Z" }),
        "2026-09-18T11:00:00.000Z");
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.moved }))
      .toEqual({ delivered: 0, error: null });
    expect(pendingGaugeJournalLines(sqlite)).toBe(1);
    expect(lines(journalRoot)).toEqual([]);

    bind(sqlite, f.archiveId);
    sqlite.query(`INSERT INTO gauge_journal_outbox
      (entry_id,journal_root,archive_root,file_name,payload,queued_at) VALUES(?,?,?,?,?,?)`)
      .run("foreign-root", path.join(f.base, "foreign", f.journalRelative), path.join(f.base, "foreign"),
        PROBE_JOURNAL_FILE,
        JSON.stringify({ journal_entry_id: "foreign-root", ts: "2026-09-18T11:05:00.000Z" }),
        "2026-09-18T11:05:00.000Z");
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.moved }))
      .toEqual({ delivered: 1, error: null });
    expect(lines(journalRoot).map((row) => row.journal_entry_id)).toEqual(["same-path"]);
    expect(pendingGaugeJournalLines(sqlite)).toBe(1);

    sqlite.query("DELETE FROM meta WHERE key='archive:identity'").run();
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.moved }))
      .toEqual({ delivered: 0, error: null });
    expect(pendingGaugeJournalLines(sqlite)).toBe(1);
  } finally {
    sqlite.close();
  }
});

test("pinning an archive does not strand legacy exact-target delivery from an unbound index", () => {
  const f = relocationFixture();
  const sqlite = database(f.dbPath);
  const root = path.join(f.original, f.journalRelative);
  try {
    configureGaugeJournal(root, { archiveRoot: f.original });
    enqueue(sqlite, "2026-09-18T13:00:00.000Z");
    expect(flushGaugeJournal(sqlite, { journalRoot: root, archiveRoot: f.original }))
      .toEqual({ delivered: 1, error: null });
    expect(lines(root)).toHaveLength(1);
    expect(pendingGaugeJournalLines(sqlite)).toBe(0);
  } finally { sqlite.close(); }
});

test("new work from a moved unbound index keeps physical coordinates; a foreign binding cannot deliver it", () => {
  const f = relocationFixture();
  fs.cpSync(f.original, f.moved, { recursive: true });
  const sqlite = database(f.dbPath);
  const root = path.join(f.moved, f.journalRelative);
  try {
    configureGaugeJournal(root, { archiveRoot: f.moved });
    enqueue(sqlite, "2026-09-18T14:00:00.000Z");
    expect(sqlite.query("SELECT journal_root,archive_root FROM gauge_journal_outbox").get())
      .toEqual({ journal_root: root, archive_root: f.moved });
    expect(flushGaugeJournal(sqlite, { journalRoot: root, archiveRoot: f.moved }))
      .toEqual({ delivered: 1, error: null });
    expect(pendingGaugeJournalLines(sqlite)).toBe(0);
    bind(sqlite, "foreign_archive");
    enqueue(sqlite, "2026-09-18T14:05:00.000Z");
    expect(flushGaugeJournal(sqlite, { journalRoot: root, archiveRoot: f.moved })).toEqual({ delivered: 0, error: null });
    expect(pendingGaugeJournalLines(sqlite)).toBe(1);
    expect(lines(root)).toHaveLength(1);
  } finally { sqlite.close(); }
});

test("writer fence preserves pending work and delivery appends exactly once after release", () => {
  const f = relocationFixture();
  fs.cpSync(f.original, f.moved, { recursive: true });
  const journalRoot = path.join(f.moved, f.journalRelative);
  const sqlite = database(f.dbPath);
  bind(sqlite, f.archiveId);
  configureGaugeJournal(journalRoot, { archiveRoot: f.moved });
  enqueue(sqlite, "2026-09-18T12:00:00.000Z");
  const fence = acquireArchiveWriterFence(f.moved, randomUUID());
  try {
    // A relocation fence is a known, recoverable state, not an unexplained failure.
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.moved }))
      .toEqual({ delivered: 0, error: "archive-paused" });
    expect(pendingGaugeJournalLines(sqlite)).toBe(1);
    expect(lines(journalRoot)).toEqual([]);
    fence.release();
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.moved }))
      .toEqual({ delivered: 1, error: null });
    expect(flushGaugeJournal(sqlite, { journalRoot, archiveRoot: f.moved }))
      .toEqual({ delivered: 0, error: null });
    expect(lines(journalRoot).map((row) => row.ts)).toEqual(["2026-09-18T12:00:00.000Z"]);
    expect(pendingGaugeJournalLines(sqlite)).toBe(0);
  } finally {
    sqlite.close();
  }
});
