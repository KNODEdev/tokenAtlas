import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../../src/db/sqlite";
import type { SyncRunResult } from "../../src/sync/contracts";
import { pendingVendorResult } from "../../src/sync/contracts";
import { compactSyncRuns, preservesEvidence } from "./sync-runs-compact";

const directories: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of directories.splice(0)) {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows keeps handles */ }
  }
});

const now = new Date("2026-09-20T12:00:00.000Z");
const revisions = { data: 0, config: 0, vendors: { codex: 0, claude: 0, opencode: 0, grok: 0, gemini: 0, gauges: 0 } };

function fixture(): Database {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-compact-test-"));
  directories.push(directory);
  const sqlite = new Database(path.join(directory, "atlas.sqlite"), { create: true });
  sqlite.exec(`CREATE TABLE sync_runs (
    run_id TEXT PRIMARY KEY NOT NULL, trigger TEXT NOT NULL, scope TEXT NOT NULL, vendor TEXT,
    mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    before_data_revision INTEGER NOT NULL, after_data_revision INTEGER NOT NULL,
    before_config_revision INTEGER NOT NULL, after_config_revision INTEGER NOT NULL,
    result_json TEXT, error TEXT)`);
  return sqlite;
}

function result(runId: string, revision: number, diagnostics: Record<string, unknown>): SyncRunResult {
  const day = "2026-09-01T00:00:00.000Z";
  return {
    runId,
    ownerPid: 123,
    ownerProcessStart: "win32:134053000000000000",
    trigger: "auto",
    scope: { kind: "all" },
    mode: "incremental",
    startedAt: day,
    finishedAt: day,
    status: "success",
    beforeRevisions: { ...revisions, data: revision - 1 },
    afterRevisions: { ...revisions, data: revision },
    aggregateWorkRequested: true,
    vendors: [{
      ...pendingVendorResult("codex"),
      status: "success",
      dataChanged: true,
      writtenRows: 4,
      dirtyRange: { from: day, to: day },
      dirtyRanges: [{ from: day, to: day }],
      startedAt: day,
      finishedAt: day,
      diagnostics,
    }],
    error: null,
  };
}

function insert(sqlite: Database, run: SyncRunResult, status: string, finishedAt: string | null): void {
  sqlite.query(
    `INSERT INTO sync_runs(run_id,trigger,scope,vendor,mode,status,started_at,finished_at,
       before_data_revision,after_data_revision,before_config_revision,after_config_revision,result_json,error)
     VALUES(?,?,?,NULL,?,?,?,?,?,?,0,0,?,NULL)`
  ).run(run.runId, run.trigger, "all", run.mode, status, run.startedAt, finishedAt,
    run.beforeRevisions.data, run.afterRevisions.data, JSON.stringify({ ...run, status, finishedAt }));
}

/** One entry per archived source file: what a failing run used to store in full. */
function flood(count: number): Record<string, unknown> {
  return { mirror: { copied: 0, archiveFiles: Array.from({ length: count }, (_, index) => `C:/archive/gemini/conversation-${index}.db`) } };
}

function bytes(sqlite: Database, runId: string): number {
  return (sqlite.query("SELECT length(result_json) AS bytes FROM sync_runs WHERE run_id=?").get(runId) as { bytes: number }).bytes;
}

const cap = 64 * 1024;

test("compaction reduces only finished runs past the age floor and never the running one", () => {
  const sqlite = fixture();
  try {
    insert(sqlite, result("a-old", 1, flood(40_000)), "success", "2026-09-01T00:00:00.000Z");
    insert(sqlite, result("b-recent", 2, flood(40_000)), "failure", "2026-09-19T23:00:00.000Z");
    insert(sqlite, result("c-running", 3, flood(40_000)), "running", null);
    insert(sqlite, result("d-small", 4, { warnings: ["one"] }), "success", "2026-09-01T00:00:00.000Z");
    const before = { old: bytes(sqlite, "a-old"), recent: bytes(sqlite, "b-recent"), running: bytes(sqlite, "c-running") };

    const dry = compactSyncRuns(sqlite, { maxBytes: cap, now, batchRows: 2 });
    expect(dry.compacted).toBe(1);
    expect(dry.bytesBefore).toBe(before.old);
    expect(dry.bytesAfter).toBeLessThanOrEqual(cap);
    expect(bytes(sqlite, "a-old")).toBe(before.old);

    const applied = compactSyncRuns(sqlite, { maxBytes: cap, now, batchRows: 2, apply: true });
    expect(applied.compacted).toBe(1);
    expect(applied.storedBytesAfter).toBeLessThan(applied.storedBytesBefore);
    expect(bytes(sqlite, "a-old")).toBeLessThanOrEqual(cap);
    expect(bytes(sqlite, "b-recent")).toBe(before.recent);
    expect(bytes(sqlite, "c-running")).toBe(before.running);

    const stored = JSON.parse((sqlite.query("SELECT result_json FROM sync_runs WHERE run_id='a-old'")
      .get() as { result_json: string }).result_json) as SyncRunResult;
    expect(stored.truncated).toBe(true);
    expect(stored.vendors[0]!.dirtyRanges).toEqual([{ from: "2026-09-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" }]);
    expect(stored.vendors[0]!.dataChanged).toBe(true);
    expect(stored.afterRevisions.data).toBe(1);
    expect(stored.ownerProcessStart).toBe("win32:134053000000000000");
    expect(preservesEvidence(stored, { ...stored, ownerProcessStart: "another-process" })).toBe(false);

    // A second pass has nothing left to do: the work is idempotent and resumable.
    expect(compactSyncRuns(sqlite, { maxBytes: cap, now, apply: true }).compacted).toBe(0);
  } finally {
    sqlite.close();
  }
});

test("--all also compacts recently finished runs, in batches, leaving the running one", () => {
  const sqlite = fixture();
  try {
    for (let index = 0; index < 5; index += 1) {
      insert(sqlite, result(`run-${index}`, index + 1, flood(20_000)), "failure", "2026-09-19T23:00:00.000Z");
    }
    insert(sqlite, result("run-live", 9, flood(20_000)), "running", null);
    const running = bytes(sqlite, "run-live");
    const report = compactSyncRuns(sqlite, { maxBytes: cap, now, all: true, batchRows: 2, apply: true });
    expect(report.compacted).toBe(5);
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
    for (let index = 0; index < 5; index += 1) expect(bytes(sqlite, `run-${index}`)).toBeLessThanOrEqual(cap);
    expect(bytes(sqlite, "run-live")).toBe(running);
  } finally {
    sqlite.close();
  }
});

test("the evidence guard rejects a reduction that would change a field the recovery reads", () => {
  const run = result("guard", 1, {});
  expect(preservesEvidence(run, { ...run, truncated: true })).toBe(true);
  expect(preservesEvidence(run, { ...run, afterRevisions: { ...revisions, data: 99 } })).toBe(false);
  expect(preservesEvidence(run, {
    ...run, vendors: [{ ...run.vendors[0]!, dirtyRanges: [] }],
  })).toBe(false);
});
