import { dailyJournalFile } from "./journal-files";
import { afterEach, expect, test } from "bun:test";
import { Database } from "../../db/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDrizzleMigrations } from "../../db/migrate";
import { configureGaugeJournal, flushGaugeJournal, gaugeJournalOutboxStatus, pendingGaugeJournalLines,
  PROBE_JOURNAL_FILE } from "./journal";
import { ARCHIVE_RELOCATION_OWNER_FILE, ARCHIVE_WRITERS_DIRECTORY } from "../../sync/archive-writers";
import { persistProbeWindows } from "./probe";
import type { WindowReading } from "../types";

const dirs: string[] = [];
const dbs: Database[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-journal-visibility-"));
  dirs.push(root);
  const archiveRoot = path.join(root, "archive");
  const journalRoot = path.join(archiveRoot, "gauges", "producer-user");
  fs.mkdirSync(archiveRoot, { recursive: true });
  const db = new Database(path.join(root, "atlas.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  applyDrizzleMigrations(drizzle(db));
  dbs.push(db);
  configureGaugeJournal(journalRoot, { archiveRoot });
  return { root, archiveRoot, journalRoot, db, target: { journalRoot, archiveRoot } };
}
const reading: WindowReading = {
  kind: "primary", group: "codex", scope: null, plan: "plus", reportedPercentSide: "used",
  usedPercent: 42, remainingPercent: null, vendorPercent: 42, windowMinutes: 300,
  allowance: null, used: null, remaining: null, resetsAt: "2026-09-06T12:00:00Z",
  rateLimitReached: false, resetCredits: null, profile: null, ok: true, error: null, extra: null,
};
function probe(db: Database, time: string) { persistProbeWindows(db, "codex", "one", time, [reading]); }

afterEach(() => {
  configureGaugeJournal(null);
  dbs.splice(0).forEach((db) => { try { db.close(true); } catch { /* already closed */ } });
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

test("a paused archive names its cause instead of reporting one opaque failure", () => {
  const f = fixture();
  probe(f.db, "2026-09-05T12:00:00.000Z");
  probe(f.db, "2026-09-05T12:05:00.000Z");
  expect(pendingGaugeJournalLines(f.db)).toBe(2);

  // A staged relocation blocks archive writes; delivery used to report `delivery-failed`
  // for this, for a locked database and for a permission error alike.
  fs.writeFileSync(path.join(f.archiveRoot, ARCHIVE_RELOCATION_OWNER_FILE), "{}");
  expect(flushGaugeJournal(f.db, f.target)).toEqual({ delivered: 0, error: "archive-paused" });
  expect(gaugeJournalOutboxStatus(f.db)).toEqual({ pending: 2, oldestQueuedAt: expect.any(String) });
  expect(fs.existsSync(path.join(f.journalRoot, dailyJournalFile(PROBE_JOURNAL_FILE, new Date())))).toBe(false);

  // Removing the cause resumes delivery of the entries queued while it lasted.
  fs.rmSync(path.join(f.archiveRoot, ARCHIVE_RELOCATION_OWNER_FILE));
  expect(flushGaugeJournal(f.db, f.target)).toEqual({ delivered: 2, error: null });
  expect(gaugeJournalOutboxStatus(f.db)).toEqual({ pending: 0, oldestQueuedAt: null });
  expect(fs.readFileSync(path.join(f.journalRoot, dailyJournalFile(PROBE_JOURNAL_FILE, new Date())), "utf8").trim().split("\n")).toHaveLength(2);
});

test("a write barrier on the archive is reported as paused, not as a generic failure", () => {
  const f = fixture();
  probe(f.db, "2026-09-05T12:00:00.000Z");
  const writers = path.join(f.archiveRoot, ARCHIVE_WRITERS_DIRECTORY);
  fs.mkdirSync(writers, { recursive: true });
  fs.writeFileSync(path.join(writers, "barrier.json"), JSON.stringify({
    schema: 1, token: "11111111-1111-4111-8111-111111111111", host: "other", pid: 4321,
    jobId: "22222222-2222-4222-8222-222222222222", phase: "fenced",
  }));
  expect(flushGaugeJournal(f.db, f.target)).toEqual({ delivered: 0, error: "archive-paused" });
  expect(pendingGaugeJournalLines(f.db)).toBe(1);

  fs.rmSync(path.join(writers, "barrier.json"));
  expect(flushGaugeJournal(f.db, f.target)).toEqual({ delivered: 1, error: null });
});

test("a database another writer holds is reported as busy and drains once it is released", () => {
  const f = fixture();
  probe(f.db, "2026-09-05T12:00:00.000Z");
  const dbPath = path.join(f.root, "atlas.sqlite");
  const competing = new Database(dbPath);
  dbs.push(competing);
  competing.exec("PRAGMA busy_timeout = 0");
  f.db.exec("PRAGMA busy_timeout = 0");
  competing.exec("BEGIN IMMEDIATE");
  try {
    expect(flushGaugeJournal(f.db, f.target)).toEqual({ delivered: 0, error: "database-busy" });
    // The entry is still queued and still visible as a backlog.
    expect(gaugeJournalOutboxStatus(f.db).pending).toBe(1);
  } finally { competing.exec("ROLLBACK"); }
  expect(flushGaugeJournal(f.db, f.target)).toEqual({ delivered: 1, error: null });
});

test("an absent archive stays distinguishable from a failed write", () => {
  const f = fixture();
  probe(f.db, "2026-09-05T12:00:00.000Z");
  fs.rmSync(f.archiveRoot, { recursive: true, force: true });
  expect(flushGaugeJournal(f.db, f.target)).toEqual({ delivered: 0, error: "archive-unavailable" });
  expect(gaugeJournalOutboxStatus(f.db).pending).toBe(1);
});

test("outbox status reports an empty queue without the table", () => {
  const f = fixture();
  f.db.exec("DROP TABLE gauge_journal_outbox");
  expect(gaugeJournalOutboxStatus(f.db)).toEqual({ pending: 0, oldestQueuedAt: null });
});
