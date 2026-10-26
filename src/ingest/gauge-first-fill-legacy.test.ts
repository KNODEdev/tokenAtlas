import { expect, mock, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { removeTestFixture } from "../test-cleanup";
import { PROBE_JOURNAL_FILE } from "../providers/core/journal-files";

// Legacy facts get a fresh observation UUID; replay the same sequence for both ingest paths.
let sequence: number | null = null;
const realRandomUUID = crypto.randomUUID, realCrypto = { ...crypto };
mock.module("node:crypto", () => ({ ...realCrypto, randomUUID: () => sequence === null ? realRandomUUID()
  : `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` }));
const { ingestGaugesAsync } = await import("./gauges");
const probeFacts = await import("../db/probe-facts");

test("gauges first fill keeps the bulk path through legacy lines with identical facts, ambiguity and projections", async () => {
  const fixture = createTestDatabase(), copy = path.join(fixture.directory, "copy.sqlite"), archive = path.join(fixture.directory, "archive");
  try {
    const seed = new Database(fixture.dbPath);
    try { probeFacts.backfillProbeFacts(seed); seed.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { seed.close(); }
    fs.copyFileSync(fixture.dbPath, copy);
    const folder = path.join(archive, "gauges", "producer");
    fs.mkdirSync(folder, { recursive: true });
    const flat = (i: number, used: number) => ({ provider: "codex", subject: "one", ts: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(),
      kind: "primary", reported_percent_side: "used", used_percent: used, machine: "producer" });
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      // Old journals: flat records without a canonical fact or envelope; one repeats at a new offset.
      lines.push(JSON.stringify(flat(i, i % 100)));
      if (i % 37 === 0) lines.push(JSON.stringify(flat(i, i % 100)));
    }
    for (let i = 250; i < 400; i++) {
      // Canonical successors overlap the legacy times with the same dimensions (ambiguity evidence).
      const fact = probeFacts.createProbeCollection([flat(i, (i % 100) + 1)])[0]!;
      lines.push(JSON.stringify({ ...fact.payload, canonical_probe: fact, journal_version: 2, journal_entry_id: randomUUID() }));
      if (i >= 300 && i % 9 === 0) lines.push(JSON.stringify(flat(i, 7)));
    }
    fs.writeFileSync(path.join(folder, PROBE_JOURNAL_FILE), lines.join("\n") + "\n");
    const options = { archiveRoot: archive, ownStore: "receiver", force: false, now: () => "2026-09-02T00:00:00Z" };
    const run = async (atlasPath: string, firstFill: boolean) => {
      sequence = 0; setSystemTime(new Date("2026-09-02T00:00:00Z"));
      try { return (await ingestGaugesAsync({ ...options, atlasPath, firstFill })); } finally { sequence = null; setSystemTime(); }
    };
    const reference = (await run(fixture.dbPath, false));
    const legacyFallback = spyOn(probeFacts, "legacyJournalProbe");
    const fast = (await run(copy, true));
    expect(legacyFallback).not.toHaveBeenCalled();
    legacyFallback.mockRestore();
    expect(fast.rows).toBe(reference.rows);
    const a = new Database(fixture.dbPath), b = new Database(copy);
    const dump = (db: Database, table: string) => db.query(`SELECT * FROM ${table} ORDER BY ${table === "probe_windows" ? "id" : "rowid"}`).all();
    try {
      expect((a.query("SELECT count(*) n FROM probe_fact_conflicts").get() as { n: number }).n).toBeGreaterThan(0);
      for (const table of [...probeFacts.PROBE_FACT_TABLES, "gauge_journal_receipts", "probe_windows", "gauge_files"])
        expect(dump(b, table)).toEqual(dump(a, table));
    } finally { a.close(); b.close(); }
  } finally { removeTestFixture(fixture.directory, { recursive: true, force: true }); }
});
