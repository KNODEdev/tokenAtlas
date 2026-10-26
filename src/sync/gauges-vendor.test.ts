import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { ARCHIVE_ROOT, PROFILE } from "../config/paths";
import type { AdapterContext, NormalizedAdapterResult } from "./adapters";
import { SyncCoordinator, enterSyncPipeline } from "./coordinator";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";
import { isOwnMirrorDestination } from "./watch";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      removeTestFixture(directory, { recursive: true, force: true });
    } catch {
      // Bun can retain a Windows SQLite handle until process teardown.
    }
  }
});

function testDatabase(): string {
  const created = createTestDatabase();
  temporaryDirectories.push(created.directory);
  return created.dbPath;
}

const PROBE_COLUMNS =
  "provider, subject, ts, kind, limit_group, scope, reported_percent_side, used_percent, extra, machine";

function insertProbe(
  sqlite: Database,
  row: { subject: string; ts: string; machine: string; home: string; used: number }
): void {
  sqlite
    .query(`INSERT INTO probe_windows (${PROBE_COLUMNS}) VALUES ('codex', ?, ?, 'primary', 'codex', NULL, 'used', ?, ?, ?)`)
    .run(row.subject, row.ts, row.used, JSON.stringify({ home: row.home }), row.machine);
}

// Stands in for ingestGaugesAsync: writes journal rows into the stage the way the
// real adapter does, so the test exercises the coordinator's append publish.
function stagingGaugesAdapter(rows: Parameters<typeof insertProbe>[1][]) {
  return async (context: AdapterContext): Promise<NormalizedAdapterResult> => {
    const stage = new Database(context.stageDbPath);
    try {
      for (const row of rows) insertProbe(stage, row);
      stage
        .query(
          `INSERT OR REPLACE INTO gauge_files (store, path, size, mtime, offset, rows, ingested_at)
           VALUES ('EXAMPLE-MAIN-sample_a', 'probe_windows.jsonl', 100, 1, 100, ?, '2026-09-02T10:00:00.000Z')`
        )
        .run(rows.length);
    } finally {
      stage.close();
    }
    return { ...successfulNoop(), processedInputs: 1, skippedInputs: 0, writtenRows: rows.length };
  };
}

function coordinator(dbPath: string, adapters = adaptersWith({})): SyncCoordinator {
  return new SyncCoordinator({ archiveInputs: () => undefined,
    dbPath,
    rootDir: process.cwd(),
    adapters,
    mirror: noMirror,
    configFingerprint: () => "fixture-config-v1",
    sourceFingerprint: (vendor) => `fixture-source:${vendor}`,
    prepareStage: () => {},
    refreshDerived: () => {},
  });
}

function revisions(dbPath: string): { data: number; gauges: number } {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const data = (sqlite.query("SELECT data_revision FROM sync_revisions WHERE id = 1").get() as { data_revision: number }).data_revision;
    const gauges = (sqlite.query("SELECT data_revision FROM vendor_sync_revisions WHERE vendor = 'gauges'").get() as
      | { data_revision: number }
      | null)?.data_revision ?? 0;
    return { data, gauges };
  } finally {
    sqlite.close();
  }
}

describe("gauges vendor", () => {
  test("append publish adds foreign samples, keeps local ones, dedupes, and never moves the data revision", async () => {
    const dbPath = testDatabase();
    const sqlite = new Database(dbPath);
    insertProbe(sqlite, { subject: "codex1", ts: "2026-09-02T10:00:00.000Z", machine: "EXAMPLE-LAPTOP-A", home: "C:/Users/sample_a/.codex", used: 10 });
    insertProbe(sqlite, { subject: "codex1", ts: "2026-09-02T09:00:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_a/.codex", used: 5 });
    sqlite.close();
    const before = revisions(dbPath);
    const instance = coordinator(
      dbPath,
      adaptersWith({
        gauges: stagingGaugesAdapter([
          // Already present (same provider/ts/kind/group/scope/machine/home) but
          // journaled under a subject the era re-stamp later rewrote: no duplicate.
          { subject: "codex-old-label", ts: "2026-09-02T09:00:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_a/.codex", used: 5 },
          { subject: "codex3", ts: "2026-09-02T10:05:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_b/.codex", used: 70 },
        ]),
      })
    );
    try {
      const result = await enterSyncPipeline(instance, { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "incremental" }).completion;
      expect(result.status).toBe("success");
      const outcome = result.vendors.find((vendor) => vendor.vendor === "gauges");
      expect(outcome).toMatchObject({ status: "success", dataChanged: true, writtenRows: 1, dirtyRange: null });
      expect(result.aggregateWorkRequested).toBe(false);
      const after = revisions(dbPath);
      expect(after.data).toBe(before.data);
      expect(after.gauges).toBe(before.gauges + 1);
      const check = new Database(dbPath, { readonly: true });
      try {
        const rows = check
          .query("SELECT subject, machine, used_percent FROM probe_windows ORDER BY ts")
          .all() as Array<{ subject: string; machine: string; used_percent: number }>;
        expect(rows).toEqual([
          { subject: "codex1", machine: "EXAMPLE-MAIN", used_percent: 5 },
          { subject: "codex1", machine: "EXAMPLE-LAPTOP-A", used_percent: 10 },
          { subject: "codex3", machine: "EXAMPLE-MAIN", used_percent: 70 },
        ]);
        expect(check.query("SELECT count(*) AS n FROM gauge_files").get()).toEqual({ n: 1 });
        expect(fs.existsSync(path.join(path.dirname(dbPath), "sync-staging"))).toBe(true);
      } finally {
        check.close();
      }
    } finally {
      instance.close();
    }
  });

  test("two machines sampling the same subject in the same millisecond do not poison the vendor", async () => {
    const dbPath = testDatabase();
    const sqlite = new Database(dbPath);
    // Local sample; the partial unique index (provider, subject, limit_group, kind, ts) has no machine.
    insertProbe(sqlite, { subject: "codex1", ts: "2026-09-02T10:00:00.000Z", machine: "EXAMPLE-LAPTOP-A", home: "C:/Users/sample_a/.codex", used: 10 });
    sqlite.close();
    const instance = coordinator(
      dbPath,
      adaptersWith({
        gauges: stagingGaugesAdapter([
          { subject: "codex1", ts: "2026-09-02T10:00:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_a/.codex", used: 11 },
          { subject: "codex1", ts: "2026-09-02T10:05:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_a/.codex", used: 12 },
        ]),
      })
    );
    try {
      const result = await enterSyncPipeline(instance, { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "incremental" }).completion;
      expect(result.status).toBe("success");
      expect(result.vendors[0]).toMatchObject({ status: "success", writtenRows: 1, dataChanged: true });
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(check.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 2 });
        expect(check.query("SELECT count(*) AS n FROM gauge_files").get()).toEqual({ n: 1 });
      } finally {
        check.close();
      }
    } finally {
      instance.close();
    }
  });

  test("a journal failure is a partial success that leaves the other vendors alone", async () => {
    const dbPath = testDatabase();
    const instance = coordinator(
      dbPath,
      adaptersWith({
        gauges: async () => {
          throw new Error("fixture journal unreadable");
        },
      })
    );
    try {
      const result = await enterSyncPipeline(instance, { trigger: "manual", scope: { kind: "all" }, mode: "incremental" }).completion;
      expect(result.status).toBe("partial_success");
      expect(result.vendors.find((vendor) => vendor.vendor === "gauges")).toMatchObject({
        status: "failure",
        error: "fixture journal unreadable",
      });
      expect(result.vendors.filter((vendor) => vendor.status === "success")).toHaveLength(5);
    } finally {
      instance.close();
    }
  });

  test("a full run for gauges re-reads journals into an empty stage instead of cloning the index", async () => {
    const dbPath = testDatabase();
    let stagedProbeRows = -1;
    const instance = coordinator(
      dbPath,
      adaptersWith({
        gauges: async (context) => {
          const stage = new Database(context.stageDbPath, { readonly: true });
          try {
            stagedProbeRows = (stage.query("SELECT count(*) AS n FROM probe_windows").get() as { n: number }).n;
            expect(stage.query("SELECT count(*) AS n FROM probe_counters").get()).toEqual({n:0});
            expect(stage.query("SELECT count(*) AS n FROM gauge_journal_receipts").get()).toEqual({n:0});
            expect(context.gaugeEvidenceDbPath).toBe(dbPath);
          } finally {
            stage.close();
          }
          return successfulNoop();
        },
      })
    );
    const sqlite = new Database(dbPath);
    insertProbe(sqlite, { subject: "codex1", ts: "2026-09-02T10:00:00.000Z", machine: "EXAMPLE-LAPTOP-A", home: "h", used: 1 });
    const {backfillProbeFacts}=await import("../db/probe-facts");
    backfillProbeFacts(sqlite);
    sqlite.close();
    try {
      await enterSyncPipeline(instance, { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "full" }).completion;
      expect(stagedProbeRows).toBe(0);
    } finally {
      instance.close();
    }
  });

  // The append publication only inserts journal rows, deduplicated by receipt and
  // by the probe uniqueness indexes, so it cannot have removed anything the live
  // journal position already covered: that position must survive the rebuild.
  test("a rebuild keeps the live journal position and only registers journals the index lacks", async () => {
    const dbPath = testDatabase();
    const sqlite = new Database(dbPath);
    insertProbe(sqlite, { subject: "codex1", ts: "2026-09-02T10:00:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_a/.codex", used: 20 });
    insertProbe(sqlite, { subject: "codex1", ts: "2026-09-02T10:01:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_a/.codex", used: 35 });
    // The live ingest consumed the whole journal before the rebuild publishes.
    sqlite
      .query(`INSERT INTO gauge_files (store, path, size, mtime, offset, rows, ingested_at)
              VALUES ('EXAMPLE-MAIN-sample_a', 'probe_windows.jsonl', 532, 99, 532, 2, '2026-09-02T10:02:00.000Z')`)
      .run();
    sqlite.close();
    // The rebuild stage reports a shorter position for the known journal (a rewritten
    // archive journal) and a genuinely new one for the machine the index has never seen.
    const instance = coordinator(dbPath, adaptersWith({
      gauges: async (context) => {
        const stage = new Database(context.stageDbPath);
        try {
          insertProbe(stage, { subject: "codex1", ts: "2026-09-02T10:00:00.000Z", machine: "EXAMPLE-MAIN", home: "C:/Users/sample_a/.codex", used: 20 });
          stage.query(`INSERT OR REPLACE INTO gauge_files (store, path, size, mtime, offset, rows, ingested_at)
             VALUES ('EXAMPLE-MAIN-sample_a', 'probe_windows.jsonl', 266, 42, 266, 0, '2026-09-02T09:00:00.000Z'),
                    ('OTHER-PC-user', 'probe_windows.jsonl', 80, 43, 80, 1, '2026-09-02T09:00:00.000Z')`).run();
        } finally { stage.close(); }
        return { ...successfulNoop(), processedInputs: 2, skippedInputs: 0, writtenRows: 1 };
      },
    }));
    try {
      const result = await enterSyncPipeline(instance, { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" },
        mode: "incremental", reparse: {}, rebuildGeneration: 77, collection: "archive" }).completion;
      expect({ status: result.status, error: result.error }).toEqual({ status: "success", error: null });
      const check = new Database(dbPath, { readonly: true });
      try {
        // Both canonical probe facts survive the rebuild, undisturbed and unduplicated.
        expect(check.query("SELECT ts, used_percent FROM probe_windows ORDER BY ts").all()).toEqual([
          { ts: "2026-09-02T10:00:00.000Z", used_percent: 20 },
          { ts: "2026-09-02T10:01:00.000Z", used_percent: 35 },
        ]);
        // The live row is kept whole: no field-wise blend of live size with the rebuild's offset.
        expect(check.query("SELECT store, size, mtime, offset, rows FROM gauge_files ORDER BY store").all()).toEqual([
          { store: "EXAMPLE-MAIN-sample_a", size: 532, mtime: 99, offset: 532, rows: 2 },
          { store: "OTHER-PC-user", size: 80, mtime: 43, offset: 80, rows: 1 },
        ]);
      } finally { check.close(); }
    } finally { instance.close(); }
  });
});

describe("watcher and own gauge journal", () => {
  test("the local machine's own journal directory is ignored, other machines' are not", () => {
    expect(isOwnMirrorDestination(path.join(ARCHIVE_ROOT, "gauges", PROFILE, "probe_windows.jsonl"))).toBe(true);
    expect(isOwnMirrorDestination(path.join(ARCHIVE_ROOT, "gauges", `${PROFILE}-other`, "probe_windows.jsonl"))).toBe(false);
    expect(isOwnMirrorDestination(path.join(ARCHIVE_ROOT, "gauges", "SOMEWHERE-ELSE-user", "probe_windows.jsonl"))).toBe(false);
  });
});

test("transport receipts survive append publication and reject altered cross-run replay", async () => {
  const { ingestGaugesAsync } = await import("../ingest/gauges");
  const dbPath = testDatabase();
  const archiveRoot = path.join(path.dirname(dbPath), "journal-archive");
  const journalRoot = path.join(archiveRoot, "gauges", "producer-user");
  fs.mkdirSync(journalRoot, { recursive: true });
  const file = path.join(journalRoot, "probe_windows.jsonl");
  const row = { journal_version: 2, journal_entry_id: "ab53122e-a7c5-41a4-86a7-e67065e99f26", provider: "codex", subject: "one",
    ts: "2026-09-05T12:00:00.000Z", kind: "primary", limit_group: "codex", reported_percent_side: "used", used_percent: 42, machine: "producer" };
  fs.writeFileSync(file, JSON.stringify(row) + "\n");
  let fingerprint = 0;
  const instance = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(), mirror: noMirror,
    configFingerprint: () => "fixture-config-v1", sourceFingerprint: () => String(++fingerprint),
    prepareStage: () => {}, refreshDerived: () => {}, adapters: adaptersWith({ gauges: async ctx => {
      const result = (await ingestGaugesAsync({ atlasPath: ctx.stageDbPath, archiveRoot, ownStore: "receiver", force: ctx.reparse === true, evidenceDbPath: ctx.gaugeEvidenceDbPath }));
      return { ...successfulNoop(), processedInputs: result.files, writtenRows: result.rows };
    } }),
  });
  const read = new Database(dbPath);
  const run = (mode: "incremental" | "full" = "incremental") => enterSyncPipeline(instance, {
    trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode,
  }).completion;
  try {
    const before = revisions(dbPath);
    expect((await run()).status).toBe("success");
    expect(read.query("SELECT count(*) AS n FROM gauge_journal_receipts").get()).toEqual({ n: 1 });
    read.exec("UPDATE probe_windows SET subject='corrected-owner'");
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    expect((await run()).status).toBe("success");
    expect(read.query("SELECT subject, used_percent FROM probe_windows").all()).toEqual([{ subject: "corrected-owner", used_percent: 42 }]);
    expect((await run("full")).status).toBe("success");
    expect(read.query("SELECT count(*) AS n FROM probe_windows").get()).toEqual({ n: 1 });
    const bookmark = read.query("SELECT * FROM gauge_files").all();
    const revision = revisions(dbPath);
    fs.appendFileSync(file, JSON.stringify({ ...row, used_percent: 90 }) + "\n");
    const failed = await run();
    expect(failed.status).not.toBe("success");
    expect(read.query("SELECT * FROM gauge_files").all()).toEqual(bookmark);
    expect(read.query("SELECT used_percent FROM probe_windows").get()).toEqual({ used_percent: 42 });
    expect(revisions(dbPath)).toEqual(revision);
    expect(revision.data).toBe(before.data);
  } finally { read.close(); instance.close(); }
});
