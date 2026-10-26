import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dailyJournalFile, JOURNAL_FILE_PATH, journalKindOf, listJournalFiles,
  OBSERVATION_JOURNAL_FILE, PROBE_JOURNAL_FILE, SUPERSEDED_JOURNALS_FILE, supersededJournals } from "./journal-files";

test("journal file names map to their kind and nothing else does", () => {
  expect(journalKindOf("probe_windows.jsonl")).toBe(PROBE_JOURNAL_FILE);
  expect(journalKindOf("probe_windows.2026-09-21.jsonl")).toBe(PROBE_JOURNAL_FILE);
  expect(journalKindOf("account_observations.2026-09.jsonl")).toBe(OBSERVATION_JOURNAL_FILE);
  for (const name of ["probe_windows.2026-13.jsonl", "probe_windows.2026-09-32.jsonl", "probe_windows.2026.jsonl",
    "probe_windows.jsonl.conflict", "other.2026-09-21.jsonl", "probe_windows.2026-09-21.jsonl.tmp"])
    expect(journalKindOf(name)).toBeNull();
  expect(JOURNAL_FILE_PATH.test("gauges/PC-user/probe_windows.2026-09-21.jsonl")).toBe(true);
  expect(JOURNAL_FILE_PATH.test("gauges/PC-user/probe_windows.jsonl")).toBe(true);
  expect(JOURNAL_FILE_PATH.test("gauges/PC-user/notes.jsonl")).toBe(false);
});

test("the daily segment is named after the UTC day of the write", () => {
  expect(dailyJournalFile(PROBE_JOURNAL_FILE, new Date("2026-09-21T23:59:59.999Z"))).toBe("probe_windows.2026-09-21.jsonl");
  expect(dailyJournalFile(OBSERVATION_JOURNAL_FILE, new Date("2026-09-22T00:00:00.000Z"))).toBe("account_observations.2026-09-22.jsonl");
});

test("superseded journals tolerate missing and malformed manifests and filter replacement kinds", () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "journal-superseded-"));
  try {
    const manifest = path.join(store, SUPERSEDED_JOURNALS_FILE);
    expect(supersededJournals(store)).toEqual({});
    for (const text of ["{", "[]", "null", "42"]) {
      fs.writeFileSync(manifest, text);
      expect(supersededJournals(store)).toEqual({});
    }
    const valid = { bytes: 123, sha256: "a".repeat(64), lines: 1,
      into: ["probe_windows.2026-09.jsonl", "probe_windows.2026-10-01.jsonl"], superseded_at: "2026-10-02T00:00:00Z" };
    for (const record of [null, {}, { into: [] }, { into: "probe_windows.2026-09.jsonl" },
      { into: [42] }, { into: ["notes.jsonl"] }, { into: ["account_observations.2026-09.jsonl"] },
      { into: ["probe_windows.2026-09.jsonl", "notes.jsonl"] }, { into: ["../probe_windows.2026-09.jsonl"] }]) {
      fs.writeFileSync(manifest, JSON.stringify({ [PROBE_JOURNAL_FILE]: record }));
      expect(supersededJournals(store)).toEqual({});
    }
    fs.writeFileSync(manifest, JSON.stringify({ [PROBE_JOURNAL_FILE]: valid, "notes.jsonl": valid,
      [OBSERVATION_JOURNAL_FILE]: { ...valid, into: ["account_observations.2026-09.jsonl"] } }));
    expect(supersededJournals(store)).toEqual({ [PROBE_JOURNAL_FILE]: valid,
      [OBSERVATION_JOURNAL_FILE]: { ...valid, into: ["account_observations.2026-09.jsonl"] } });
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

test("a store lists one kind oldest first: unsuffixed journal, month files, then remaining days", () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "journal-files-"));
  try {
    for (const name of ["probe_windows.2026-10-01.jsonl", "probe_windows.2026-09.jsonl", "probe_windows.jsonl",
      "probe_windows.2026-09-30.jsonl", "probe_windows.2026-08.jsonl", "account_observations.2026-09-30.jsonl", "notes.txt"])
      fs.writeFileSync(path.join(store, name), "");
    expect(listJournalFiles(store, PROBE_JOURNAL_FILE)).toEqual(["probe_windows.jsonl", "probe_windows.2026-08.jsonl",
      "probe_windows.2026-09.jsonl", "probe_windows.2026-09-30.jsonl", "probe_windows.2026-10-01.jsonl"]);
    expect(listJournalFiles(path.join(store, "missing"), PROBE_JOURNAL_FILE)).toEqual([]);
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});
