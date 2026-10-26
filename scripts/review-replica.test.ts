import { expandProbeJournal } from "../src/providers/core/journal-compact";
import { dailyJournalFile } from "../src/providers/core/journal-files";
import { createProbeCollection } from "../src/db/probe-facts";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/db/sqlite";
import { initialize, safeRoot, writeNew, verifyDownloaded, receive, returnReport, inspectHistory, waitForGaugeJournal } from "./review-replica";
import { flushGaugeJournal } from "../src/providers/core/journal";
// The existing real-router scenario covers late/error samples and stage rollback.
import "../src/sync/gauge-current.acceptance.test";

const script = path.join(import.meta.dir, "review-replica.ts");
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 10000);
  try { const code = await child.exited; return { code, out: await out, err: await err }; }
  finally { clearTimeout(timer); }
}
async function expectCliSuccess(...args: string[]) {
  const result = await cli(...args);
  expect(result.code, result.err || result.out).toBe(0);
}

test("delivery polling waits through an exclusive writer and confirms readiness after release", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "replica-poll-lock-"));
  const file = path.join(parent, "queue.sqlite");
  const reader = new Database(file), writer = new Database(file);
  let pending: Promise<void> | undefined;
  try {
    reader.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; CREATE TABLE gauge_journal_outbox(entry_id TEXT)");
    writer.exec("BEGIN EXCLUSIVE");
    let settled = false;
    pending = waitForGaugeJournal(reader);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Bun.sleep(75);
    expect(settled).toBe(false);
    writer.exec("ROLLBACK");
    await pending;
    expect(settled).toBe(true);
    expect(reader.query("SELECT count(*) n FROM gauge_journal_outbox").get()).toEqual({ n: 0 });
  } finally {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    await pending?.catch(() => {});
    writer.close(true); reader.close(true);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("delivery polling rejects failures other than writer contention", async () => {
  const db = new Database(":memory:");
  try { await expect(waitForGaugeJournal(db)).rejects.toThrow("no such table"); }
  finally { db.close(true); }
});

test("root ownership, defaults, overlap and existing evidence are refused", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "replica-root-test-"));
  const root = path.join(parent, "tokenatlas-replica-local"), archive = path.join(parent, "tokenatlas-replica-archive");
  try {
    expect(() => safeRoot(".")).toThrow(); expect(() => safeRoot(os.homedir())).toThrow();
    expect(() => initialize(root, root, "replica-test", "MAIN", "local")).toThrow();
    fs.mkdirSync(archive); fs.writeFileSync(path.join(archive, "existing.txt"), "retained");
    expect(() => initialize(root, archive, "replica-test", "MAIN", "local")).toThrow();
    expect(fs.readFileSync(path.join(archive, "existing.txt"), "utf8")).toBe("retained");
    const file = path.join(parent, "evidence.json"); writeNew(file, { original: true });
    expect(() => writeNew(file, {})).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ original: true });
    expect(inspectHistory(path.join(parent, "missing.json"), file).history).toBe("NEW-LINKED-EXPERIMENT-REQUIRED");
    const before = fs.readFileSync(file, "utf8");
    expect(inspectHistory(file, file).history).toBe("NEW-LINKED-EXPERIMENT-REQUIRED");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const linked = path.join(parent, "tokenatlas-replica-link");
    fs.symlinkSync(archive, linked, "junction");
    expect(() => safeRoot(linked)).toThrow();
    fs.unlinkSync(linked);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
test("resumable producer process, crash after fsync, verified receipt/current, replay and safe export", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "replica-process-test-"));
  const root = path.join(parent, "tokenatlas-replica-main"), archive = path.join(parent, "tokenatlas-replica-archive");
  const receiver = path.join(parent, "tokenatlas-replica-laptop");
  try {
    initialize(root, archive, "replica-test", "MAIN", "local", "tx97098");
    await expectCliSuccess("producer", root);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, "producer.json"), "utf8"));
    const dbPath = path.join(root, "synthetic.sqlite");
    let db = new Database(dbPath);
    expect(db.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 1 });
    const target = { archiveRoot: archive, journalRoot: path.join(archive, "gauges", "MAIN-synthetic") };
    // Make only the marked disposable archive unavailable; the committed work must survive.
    fs.renameSync(archive, archive + "-offline");
    expect(flushGaugeJournal(db, target)).toEqual({ delivered: 0, error: "archive-unavailable" });
    fs.renameSync(archive + "-offline", archive); db.close(true);
    const crash = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/providers/core/journal-process-fixture.ts"),
      dbPath, target.journalRoot, archive, "crash-after-fsync"], { stdout: "ignore", stderr: "ignore" });
    expect(await crash.exited).toBe(73);
    db = new Database(dbPath);
    expect(db.query("SELECT count(*) AS n FROM gauge_journal_outbox").get()).toEqual({ n: 1 }); db.close(true);
    await expectCliSuccess("flush", root);
    const flushed = JSON.parse(fs.readFileSync(path.join(root, "flush.json"), "utf8"));
    expect(flushed).toMatchObject({ pending_after_restart: 1, pending_after_flush: 0, local_archive: "PASS", remote: "NOT-RUN" });
    expect(returnReport(root).producer_delivery).toEqual({ id: evidence.id, digest: evidence.digest, pending_after_restart: 1, pending_after_flush: 0 });
    const journal = path.join(target.journalRoot, dailyJournalFile("probe_windows.jsonl", new Date()));
    expect(fs.readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(2);
    expect(() => verifyDownloaded(journal, { ...evidence, digest: "0".repeat(64) })).toThrow();
    expect(() => verifyDownloaded(journal, { ...evidence, receipt_digest: "0".repeat(64) })).toThrow();
    initialize(receiver, archive, "replica-test", "LAPTOP", "local", "tx97098");
    const received = await receive(receiver, "MAIN");
    expect(received).toMatchObject({ id: evidence.id, digest: evidence.digest, file_receipt_current: "PASS", multi_pc: "NOT-RUN", latency_ms: null });
    const receiverDb = new Database(path.join(receiver, "synthetic.sqlite"), { readonly: true });
    expect(receiverDb.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 1 });
    expect(receiverDb.query("SELECT count(*) AS n FROM gauge_journal_receipts").get()).toEqual({ n: 1 }); receiverDb.close(true);
    expect((await cli("receiver", receiver, "MAIN")).code).toBe(1);
    const receivedPath = path.join(receiver, "receiver-MAIN.json");
    fs.writeFileSync(receivedPath, JSON.stringify({ ...received, digest: "0".repeat(64) }));
    expect(() => returnReport(receiver)).toThrow();
    fs.writeFileSync(receivedPath, JSON.stringify(received));
    const report = returnReport(receiver);
    expect(report).toMatchObject({ multi_pc: "NOT-RUN", opposite_direction: "NOT-RUN", continuity: "NEW-LINKED-NOT-RESUMED", owner_acceptance: "NOT-RECORDED" });
    const text = JSON.stringify(report);
    expect(text).not.toContain(parent); expect(text).not.toContain(os.hostname()); expect(text).not.toContain(evidence.device);
    expect(() => returnReport(receiver)).toThrow();
    const manifestPath = path.join(receiver, ".tokenatlas-replica.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha: "0".repeat(40) }));
    expect((await cli("receiver", receiver, "MAIN")).code).toBe(1);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}, 15000);

test("receiver cannot certify delivery A when current selects newer MAIN/42 delivery B or provenance is ambiguous", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "replica-current-correlation-"));
  const archive = path.join(parent, "tokenatlas-replica-archive");
  const first = path.join(parent, "tokenatlas-replica-first"), second = path.join(parent, "tokenatlas-replica-second");
  const receiver = path.join(parent, "tokenatlas-replica-receiver");
  try {
    initialize(first, archive, "replica-correlation", "MAIN", "local");
    await expectCliSuccess("producer", first);
    await expectCliSuccess("flush", first);
    const original = JSON.parse(fs.readFileSync(path.join(first, "producer.json"), "utf8"));
    initialize(second, archive, "replica-correlation", "MAIN", "local");
    await expectCliSuccess("producer", second);
    const newer = JSON.parse(fs.readFileSync(path.join(second, "producer.json"), "utf8"));
    expect(Date.parse(newer.ts)).toBeGreaterThan(Date.parse(original.ts));
    expect((await cli("flush", second)).code).toBe(1);
    const journal = path.join(archive, "gauges", "MAIN-synthetic", dailyJournalFile("probe_windows.jsonl", new Date()));
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(archive, "producer-MAIN.json"), "utf8")).id).toBe(original.id);
    initialize(receiver, archive, "replica-correlation", "LAPTOP", "local");
    await expect(receive(receiver, "MAIN")).rejects.toThrow("current-projection-mismatch");
    const db = new Database(path.join(receiver, "synthetic.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT count(*) AS n FROM gauge_journal_receipts").get()).toEqual({ n: 2 });
      expect(db.query("SELECT ts FROM probe_windows ORDER BY julianday(ts) DESC LIMIT 1").get()).toEqual({ ts: newer.ts });
    } finally { db.close(true); }
    expect(fs.existsSync(path.join(receiver, "receiver-MAIN.json"))).toBe(false);
    expect(returnReport(receiver).received).toBe("NOT-RUN");

    // Only disposable synthetic input is changed; A's verified bytes and manifest stay intact.
    const duplicateTime = { ...expandProbeJournal(lines)[1]!, journal_version: 2, ts: original.ts } as Record<string, unknown>;
    duplicateTime.canonical_probe = createProbeCollection([duplicateTime])[0];
    fs.writeFileSync(journal, lines[0] + "\n" + JSON.stringify(duplicateTime) + "\n");
    const ambiguous = path.join(parent, "tokenatlas-replica-ambiguous");
    initialize(ambiguous, archive, "replica-correlation", "LAPTOP", "local");
    await expect(receive(ambiguous, "MAIN")).rejects.toThrow("current-delivery-ambiguous");
    expect(fs.existsSync(path.join(ambiguous, "receiver-MAIN.json"))).toBe(false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}, 15000);
