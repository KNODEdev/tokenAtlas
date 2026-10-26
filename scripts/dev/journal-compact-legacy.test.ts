import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../../src/db/sqlite";
import { applyDrizzleMigrations } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import { createProbeCollection } from "../../src/db/probe-facts";
import { ingestGaugesAsync } from "../../src/ingest/gauges";
import { supersededJournals } from "../../src/providers/core/journal-files";
import { expandProbeJournal } from "../../src/providers/core/journal-compact";
import { compactLegacyJournals } from "./journal-compact-legacy";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function reading(ts: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: "codex", subject: "codex1", ts, plan: "plus", kind: "primary", limit_group: "codex", scope: null,
    reported_percent_side: "used", used_percent: 42, remaining_percent: null, vendor_percent: 42, window_minutes: 300,
    allowance: null, used: null, remaining: null, resets_at: "2026-09-02T14:00:00.000Z", rate_limit_reached: 0,
    reset_credits: null, profile: null, ok: null, error: null, extra: JSON.stringify({ home: "C:/Users/x/.codex", as_of: ts }),
    machine: "PRODUCER", login: "user", source_home: "C:/Users/x/.codex", raw_subject: "codex1", ...overrides };
}
function database(root: string, name: string): string {
  const file = path.join(root, name), sqlite = new Database(file, { create: true });
  try { applyDrizzleMigrations(drizzle(sqlite, { schema })); } finally { sqlite.close(); }
  return file;
}
function facts(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    return { counters: db.query("SELECT id, payload FROM probe_counters ORDER BY id").all(),
      windows: db.query("SELECT provider, subject, ts, kind, used_percent, extra, machine FROM probe_windows ORDER BY ts, kind").all() };
  } finally { db.close(); }
}

test("a legacy journal becomes a compact month file that old and new receivers read as the same facts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "journal-legacy-")); roots.push(root);
  const archiveRoot = path.join(root, "archive"), store = path.join(archiveRoot, "gauges", "PRODUCER-user"), backupRoot = path.join(root, "backup");
  fs.mkdirSync(store, { recursive: true });
  const canonical = ["2026-09-02T10:00:00.000Z", "2026-09-02T10:05:00.000Z", "2026-09-02T10:10:00.000Z"].map((ts, index) => {
    const row = reading(ts, index === 2 ? { used_percent: 43, vendor_percent: 43 } : {});
    const fact = createProbeCollection([row])[0]!;
    fact.header.recorded_at = ts;
    return JSON.stringify({ ...row, canonical_probe: fact, journal_version: 2, journal_entry_id: randomUUID() });
  });
  const plain = JSON.stringify({ ...reading("2026-09-01T09:00:00.000Z", { used_percent: 7 }), journal_version: 2, journal_entry_id: randomUUID() });
  const unversioned = JSON.stringify(reading("2026-08-31T09:00:00.000Z", { used_percent: 5 }));
  const legacy = path.join(store, "probe_windows.jsonl"), text = [unversioned, plain, ...canonical].join("\n") + "\n";
  fs.writeFileSync(legacy, text);
  const digest = createHash("sha256").update(text).digest("hex");
  const earlier = database(root, "earlier.sqlite");
  const ingest = async (atlasPath: string) => (await ingestGaugesAsync({ atlasPath, archiveRoot, ownStore: "receiver", force: false }));
  (await ingest(earlier));
  const before = facts(earlier);
  expect(before.windows).toHaveLength(5);

  const options = { storeRoot: store, backupRoot, ownStore: "PRODUCER-user", quietMinutes: 0 };
  const dry = await compactLegacyJournals({ ...options, apply: false });
  expect(dry[0]).toMatchObject({ lines: 5, compacted: 3, references: 2, verbatim: 2, applied: false });
  expect(fs.readdirSync(store)).toEqual(["probe_windows.jsonl"]);
  await expect(compactLegacyJournals({ ...options, ownStore: "someone-else", apply: true })).rejects.toThrow("owner");
  await expect(compactLegacyJournals({ ...options, backupRoot: path.join(archiveRoot, "backup"), apply: true })).rejects.toThrow("outside the archive");
  await expect(compactLegacyJournals({ ...options, quietMinutes: 30, apply: true })).rejects.toThrow("written recently");

  const [report] = await compactLegacyJournals({ ...options, apply: true });
  expect(report).toMatchObject({ applied: true, into: ["probe_windows.2026-08.jsonl", "probe_windows.2026-09.jsonl"] });
  expect(report!.bytesAfter).toBeLessThan(report!.bytesBefore);
  expect(fs.existsSync(legacy)).toBe(false);
  expect(fs.readdirSync(store).sort()).toEqual(["journal-superseded.json", "probe_windows.2026-08.jsonl", "probe_windows.2026-09.jsonl"]);
  const [backup] = fs.readdirSync(path.join(backupRoot, "PRODUCER-user"));
  expect(createHash("sha256").update(fs.readFileSync(path.join(backupRoot, "PRODUCER-user", backup!))).digest("hex")).toBe(digest);
  expect(supersededJournals(store)["probe_windows.jsonl"]).toMatchObject({ sha256: digest, lines: 5, into: report!.into });

  // A database that ingested the original keeps exactly its canonical facts and its projection.
  await ingest(earlier);
  const after = facts(earlier);
  expect(after.windows).toEqual(before.windows);
  const canonicalIds = new Set(canonical.map(line => JSON.parse(line).canonical_probe.counter_id as string));
  const kept = (rows: unknown[]) => (rows as { id: string }[]).filter(row => canonicalIds.has(row.id));
  expect(kept(after.counters)).toEqual(kept(before.counters));
  // A database that never saw the original reads the same readings from the month files.
  const fresh = database(root, "fresh.sqlite");
  (await ingest(fresh));
  expect(facts(fresh).windows).toEqual(before.windows);
  expect(kept(facts(fresh).counters)).toEqual(kept(before.counters));
  // Nothing is left to convert, and a second run does not disturb the result.
  expect(await compactLegacyJournals({ ...options, apply: true })).toEqual([]);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "journal-legacy-")); roots.push(root);
  const archiveRoot = path.join(root, "archive"), storeRoot = path.join(archiveRoot, "gauges", "PRODUCER-user");
  fs.mkdirSync(storeRoot, { recursive: true });
  return { root, archiveRoot, storeRoot, backupRoot: path.join(root, "backup"), ownStore: "PRODUCER-user", quietMinutes: 0, apply: true };
}

function canonicalLine(ts: string): string {
  const row = reading(ts);
  const fact = createProbeCollection([row])[0]!;
  fact.header.recorded_at = ts;
  return JSON.stringify({ ...row, canonical_probe: fact, journal_version: 2, journal_entry_id: randomUUID() });
}

test("a zero quiet interval disables the clock guard while a positive interval protects recent writes", async () => {
  const f = fixture(), legacy = path.join(f.storeRoot, "probe_windows.jsonl");
  fs.writeFileSync(legacy, canonicalLine("2026-09-02T10:00:00.000Z") + "\n");
  const timestamp = new Date("2026-09-03T00:00:00.000Z");
  fs.utimesSync(legacy, timestamp, timestamp);
  // A filesystem timestamp may be ahead of the millisecond wall clock on a just-written file.
  const now = () => new Date(fs.statSync(legacy).mtimeMs - 1);
  await expect(compactLegacyJournals({ ...f, now, quietMinutes: 30 })).rejects.toThrow("written recently");
  expect(fs.existsSync(f.backupRoot)).toBe(false);
  expect((await compactLegacyJournals({ ...f, now }))[0]?.applied).toBe(true);
});

test("the first reading after UTC midnight is self-contained and that day expands independently", async () => {
  const f = fixture();
  const lines = ["2026-09-02T23:58:00.000Z", "2026-09-02T23:59:00.000Z", "2026-09-03T00:00:00.000Z", "2026-09-03T00:01:00.000Z"].map(canonicalLine);
  fs.writeFileSync(path.join(f.storeRoot, "probe_windows.jsonl"), lines.join("\n") + "\n");
  expect((await compactLegacyJournals(f))[0]).toMatchObject({ compacted: 4, references: 2 });
  const converted = fs.readFileSync(path.join(f.storeRoot, "probe_windows.2026-09.jsonl"), "utf8").trim().split("\n");
  expect(JSON.parse(converted[1]!).b).toBeString();
  expect(JSON.parse(converted[2]!).b).toBeUndefined();
  expect(JSON.parse(converted[2]!).p).toBeDefined();
  expect(JSON.parse(converted[3]!).b).toBeString();
  expect(expandProbeJournal(converted.slice(2)).map(row => row.canonical_probe))
    .toEqual(lines.slice(2).map(line => JSON.parse(line).canonical_probe));
});

test("an existing target month aborts before publishing any month, backup or manifest", async () => {
  const f = fixture();
  const original = canonicalLine("2026-08-31T23:59:00.000Z") + "\n" + canonicalLine("2026-09-01T00:00:00.000Z") + "\n";
  const target = "probe_windows.2026-09.jsonl", existing = "existing target must survive\n";
  fs.writeFileSync(path.join(f.storeRoot, "probe_windows.jsonl"), original);
  fs.writeFileSync(path.join(f.storeRoot, target), existing);
  await expect(compactLegacyJournals(f)).rejects.toThrow(`${target} already exists`);
  expect(fs.readdirSync(f.storeRoot).sort()).toEqual([target, "probe_windows.jsonl"]);
  expect(fs.readFileSync(path.join(f.storeRoot, target), "utf8")).toBe(existing);
  expect(fs.readFileSync(path.join(f.storeRoot, "probe_windows.jsonl"), "utf8")).toBe(original);
  expect(fs.existsSync(f.backupRoot)).toBe(false);
});

test("a crash leftover is never ingested and does not block conversion on rerun", async () => {
  const f = fixture(), original = canonicalLine("2026-09-02T10:00:00.000Z") + "\n";
  const pending = path.join(f.storeRoot, "probe_windows.2026-09.jsonl.converting");
  fs.writeFileSync(path.join(f.storeRoot, "probe_windows.jsonl"), original);
  fs.writeFileSync(pending, canonicalLine("2026-09-02T11:00:00.000Z") + "\n");
  const receiver = database(f.root, "receiver.sqlite");
  const ingest = async () => (await ingestGaugesAsync({ atlasPath: receiver, archiveRoot: f.archiveRoot, ownStore: "receiver", force: false }));
  const first = (await ingest());
  expect(first).toMatchObject({ files: 1, rows: 1, malformed: 0 });
  expect(first.details.map(detail => detail.file)).toEqual(["probe_windows.jsonl"]);
  const before = facts(receiver);
  expect(before.counters).toHaveLength(1);
  expect((await compactLegacyJournals(f))[0]?.applied).toBe(true);
  expect(fs.existsSync(pending)).toBe(false);
  expect(expandProbeJournal(fs.readFileSync(path.join(f.storeRoot, "probe_windows.2026-09.jsonl"), "utf8").trim().split("\n"))[0]?.canonical_probe)
    .toEqual(JSON.parse(original).canonical_probe);
  expect((await ingest())).toMatchObject({ files: 1, rows: 0, malformed: 0 });
  expect(facts(receiver)).toEqual(before);
});

test("account observations move verbatim and a receiver reads past them before and after", async () => {
  const f = fixture();
  const text = [0, 1].map(index => JSON.stringify({ ts: `2026-09-02T10:0${index}:00.000Z`, vendor: "codex",
    source: "fixture", identity_kind: "email", identity: "fixture@example.test", raw_source: "keep spacing:  a  b",
    machine: "PRODUCER", journal_version: 2, journal_entry_id: randomUUID() }, null, 0)).join("\n") + "\n";
  fs.writeFileSync(path.join(f.storeRoot, "account_observations.jsonl"), text);
  const receiver = database(f.root, "receiver.sqlite");
  const ingest = async () => (await ingestGaugesAsync({ atlasPath: receiver, archiveRoot: f.archiveRoot, ownStore: "receiver", force: false }));
  const snapshot = () => {
    const db = new Database(receiver, { readonly: true });
    try { return { bookmarks: db.query("SELECT path,offset,rows FROM gauge_files ORDER BY path").all(),
      receipts: db.query("SELECT * FROM gauge_journal_receipts ORDER BY entry_id").all() }; }
    finally { db.close(); }
  };
  // Retired observation segments are archive originals only: bookmarked, never imported.
  expect((await ingest())).toMatchObject({ files: 1, rows: 0, malformed: 0 });
  const before = snapshot();
  expect(before).toEqual({ bookmarks: [{ path: "account_observations.jsonl", offset: Buffer.byteLength(text), rows: 0 }], receipts: [] });
  expect((await compactLegacyJournals(f))[0]).toMatchObject({ compacted: 0, verbatim: 2, applied: true });
  expect(fs.readFileSync(path.join(f.storeRoot, "account_observations.2026-09.jsonl"), "utf8")).toBe(text);
  expect(fs.existsSync(path.join(f.storeRoot, "account_observations.jsonl"))).toBe(false);
  expect((await ingest())).toMatchObject({ files: 1, rows: 0, malformed: 0 });
  const after = snapshot();
  expect(after.receipts).toEqual(before.receipts);
  expect(after.bookmarks).toEqual([
    { path: "account_observations.2026-09.jsonl", offset: Buffer.byteLength(text), rows: 0 },
    ...before.bookmarks,
  ]);
});

test("a run interrupted after publishing a month file finishes on rerun instead of refusing", async () => {
  const f = fixture();
  const original = [canonicalLine("2026-08-31T23:59:00.000Z"), canonicalLine("2026-09-01T00:00:00.000Z")].join("\n") + "\n";
  const legacy = path.join(f.storeRoot, "probe_windows.jsonl");
  fs.writeFileSync(legacy, original);
  await compactLegacyJournals(f);
  const months = ["probe_windows.2026-08.jsonl", "probe_windows.2026-09.jsonl"];
  const publishedText = months.map(name => fs.readFileSync(path.join(f.storeRoot, name), "utf8"));
  // The state an interruption leaves: one month published, the original and no record of it.
  fs.writeFileSync(legacy, original);
  fs.rmSync(path.join(f.storeRoot, "journal-superseded.json"));
  fs.rmSync(path.join(f.storeRoot, months[1]!));
  const [report] = await compactLegacyJournals(f);
  expect(report).toMatchObject({ applied: true, into: months });
  expect(months.map(name => fs.readFileSync(path.join(f.storeRoot, name), "utf8"))).toEqual(publishedText);
  expect(fs.existsSync(legacy)).toBe(false);
  expect(supersededJournals(f.storeRoot)["probe_windows.jsonl"]?.into).toEqual(months);
});
