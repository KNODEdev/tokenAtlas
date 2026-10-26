import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { ingestGaugesAsync } from "../ingest/gauges";
import { createTestDatabase, emptyAccountsDocument } from "./test-support";
import { createProbeCollection } from "../db/probe-facts";

const RANGE_START = "2026-09-02T00:00:00.000000Z";
const RANGE_END = "2026-09-02T23:59:59.999999Z";
const BEFORE = "2026-09-01T23:59:59.999Z";
const NEXT_MIDNIGHT = "2026-09-03T00:00:00.000Z";
const ACCEPTED_LIVE = "2026-09-04T12:00:00.000Z";

function journalRow(id: string, ts: string, used: number, canonical: boolean): string {
  const payload = {
    journal_version: 2,
    journal_entry_id: id,
    provider: "codex",
    subject: "fixture-account",
    ts,
    kind: "primary",
    limit_group: "codex",
    reported_percent_side: "used",
    used_percent: used,
    window_minutes: 300,
    machine: "fixture-producer",
    login: "fixture",
    raw_subject: "fixture-account",
    ok: 1,
  };
  const fact = canonical ? createProbeCollection([payload])[0]! : null;
  return JSON.stringify(fact
    ? { ...fact.payload, journal_version: 2, journal_entry_id: id, canonical_probe: fact }
    : payload) + "\n";
}

for (const canonical of [false, true]) test(`a ranged ${canonical ? "canonical" : "legacy"} gauge rebuild publishes only the selected UTC interval and leaves the rest to ordinary ingestion`, async () => {
  const { directory, dbPath } = createTestDatabase();
  try {
    const archiveRoot = path.join(directory, "archive");
    const config = path.join(directory, "config");
    const absentUser = path.join(directory, "absent-user");
    const journal = path.join(archiveRoot, "gauges", "fixture-producer", "probe_windows.jsonl");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify(emptyAccountsDocument()));
    fs.writeFileSync(path.join(config, "projects.json"), JSON.stringify({ projects: [] }));
    fs.writeFileSync(path.join(config, "rate-cards.json"), JSON.stringify({ vendors: {} }));

    const content = [
      journalRow("00000000-0000-4000-8000-000000000001", BEFORE, 10, canonical),
      journalRow("00000000-0000-4000-8000-000000000002", RANGE_START, 20, canonical),
      journalRow("00000000-0000-4000-8000-000000000003", RANGE_END, 40, canonical),
      journalRow("00000000-0000-4000-8000-000000000004", NEXT_MIDNIGHT, 80, canonical),
    ].join("");
    fs.writeFileSync(journal, content);
    // Retired observation segments stay beside the readings; they are read past, never imported.
    const observationJournal = path.join(path.dirname(journal), "account_observations.jsonl");
    // Local calendar dates differ from UTC membership on both sides of midnight.
    const observedTimes = ["2026-09-02T00:30:00+02:00", "2026-09-01T23:30:00-02:00", "2026-09-02T23:30:00-02:00"];
    fs.writeFileSync(observationJournal, observedTimes.map((ts, i) => JSON.stringify({
      journal_version: 2, journal_entry_id: `00000000-0000-4000-8000-00000000001${i}`,
      ts, vendor: "codex", source: "fixture", identity_kind: "email", identity: "fixture@example.test", machine: "fixture-producer",
    })).join("\n") + "\n");

    const active = new Database(dbPath);
    active.query(`INSERT INTO probe_windows
      (provider,subject,ts,kind,limit_group,reported_percent_side,used_percent,window_minutes,machine,ok)
      VALUES ('codex','fixture-account',?,'primary','codex','used',90,300,'accepted-live',1)`)
      .run(ACCEPTED_LIVE);
    active.close(true);

    const request = {
      trigger: "manual",
      scope: { kind: "vendor", vendor: "gauges" },
      mode: "incremental",
      reparse: { from: "2026-09-02", until: "2026-09-02" },
      rebuildGeneration: 91,
      collection: "archive",
    } as const;
    const rebuild = async () => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "runner.ts"),
        JSON.stringify({ dbPath, rootDir: process.cwd(), request })], {
        env: {
          ...process.env,
          TOKENATLAS_ARCHIVE: archiveRoot,
          TOKENATLAS_CONFIG: config,
          TOKENATLAS_LOCAL_STATE: path.join(directory, "local-state"),
          USERPROFILE: absentUser,
          HOME: absentUser,
          APPDATA: path.join(directory,"absent-appdata"),
          LOCALAPPDATA: path.join(directory,"absent-localappdata"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 15_000);
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timeout));
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const line = stdout.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
      expect(line).toBeDefined();
      const result = JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length));
      expect({ status: result.status, error: result.error }).toEqual({ status: "success", error: null });
    };

    const snapshot = () => {
      const sqlite = new Database(dbPath, { readonly: true });
      try {
        const rows = sqlite.query("SELECT ts,used_percent FROM probe_windows ORDER BY ts").all() as Array<{ ts: string; used_percent: number }>;
        return {
          rows,
          count: rows.length,
          percentTotal: rows.reduce((sum, row) => sum + row.used_percent, 0),
          counterTimes: (sqlite.query("SELECT json_extract(payload,'$.ts') AS ts FROM probe_counters ORDER BY ts").all() as Array<{ ts: string }>).map(row => row.ts),
          receipts: (sqlite.query("SELECT count(*) AS n FROM gauge_journal_receipts").get() as { n: number }).n,
          bookmarks: sqlite.query("SELECT store,path,size,offset,rows FROM gauge_files ORDER BY store,path").all(),
        };
      } finally {
        sqlite.close(true);
      }
    };

    await rebuild();
    const ranged = snapshot();
    expect(ranged).toEqual({
      rows: [
        { ts: RANGE_START, used_percent: 20 },
        { ts: RANGE_END, used_percent: 40 },
        { ts: ACCEPTED_LIVE, used_percent: 90 },
      ],
      count: 3,
      percentTotal: 150,
      counterTimes: [RANGE_START, RANGE_END, ACCEPTED_LIVE],
      receipts: 0,
      bookmarks: [],
    });
    expect(ranged.rows.some(row => row.ts === RANGE_START)).toBe(true);
    expect(ranged.rows.some(row => row.ts === RANGE_END)).toBe(true);
    expect(ranged.rows.some(row => row.ts === NEXT_MIDNIGHT)).toBe(false);
    expect(fs.readFileSync(journal, "utf8")).toBe(content);
    expect(fs.existsSync(path.join(absentUser, ".codex", "sessions"))).toBe(false);
    expect(fs.existsSync(path.join(absentUser, ".claude", "projects"))).toBe(false);

    // Replaying the same selected reset neither duplicates facts nor invents a
    // complete-file receipt/bookmark for the deliberately omitted timestamps.
    await rebuild();
    expect(snapshot()).toEqual(ranged);

    // With no ranged bookmark or receipt, ordinary journal ingestion discovers
    // both omitted readings. Already-published selected rows remain one each.
    const replay = (await ingestGaugesAsync({ atlasPath: dbPath, archiveRoot, ownStore: "receiver", force: false }));
    expect(replay).toMatchObject({ files: 2, skipped: 0, rows: 2, malformed: 0 });
    const complete = snapshot();
    expect(complete.rows).toEqual([
      { ts: BEFORE, used_percent: 10 },
      { ts: RANGE_START, used_percent: 20 },
      { ts: RANGE_END, used_percent: 40 },
      { ts: NEXT_MIDNIGHT, used_percent: 80 },
      { ts: ACCEPTED_LIVE, used_percent: 90 },
    ]);
    expect({ count: complete.count, percentTotal: complete.percentTotal }).toEqual({ count: 5, percentTotal: 240 });
    expect(complete.counterTimes).toEqual([BEFORE, RANGE_START, RANGE_END, NEXT_MIDNIGHT, ACCEPTED_LIVE]);
    expect(complete.receipts).toBe(4);
    expect(complete.bookmarks).toHaveLength(2);
    expect((await ingestGaugesAsync({ atlasPath: dbPath, archiveRoot, ownStore: "receiver", force: false })))
      .toMatchObject({ files: 2, skipped: 2, rows: 0, malformed: 0 });
    expect(snapshot()).toEqual(complete);
    expect(fs.readFileSync(journal, "utf8")).toBe(content);
  } finally {
    Bun.gc(true);
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 45_000);
