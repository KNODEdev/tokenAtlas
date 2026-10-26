import { afterAll, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { SyncCoordinator, enterSyncPipeline } from "./coordinator";
import { adaptersWith, createTestDatabase, noMirror } from "./test-support";

const created = createTestDatabase();

afterAll(() => {
  const resolved = path.resolve(created.directory);
  if (
    path.dirname(resolved) === path.resolve(os.tmpdir()) &&
    path.basename(resolved).startsWith("tokenatlas-sync-test-")
  ) {
    try {
      removeTestFixture(resolved, { recursive: true, force: true });
    } catch {
      // Bun can retain a Windows SQLite handle until process teardown.
    }
  }
});

test("fixture archive incremental twice: second run processes zero and keeps the revision", async () => {
  const fixture = path.join(created.directory, "archive", "claude", "session.jsonl");
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, '{"event":"fixture"}\n', "utf8");
  const adapter = async (context: { stageDbPath: string }) => {
    const stat = fs.statSync(fixture);
    const sqlite = new Database(context.stageDbPath);
    try {
      const previous = sqlite
        .query("SELECT size, mtime FROM claude_files WHERE store = 'live' AND path = ?")
        .get(fixture) as { size: number; mtime: number } | null;
      if (previous?.size === stat.size && Math.abs(previous.mtime - stat.mtimeMs) < 1) {
        return {
          processedInputs: 0,
          skippedInputs: 1,
          writtenRows: 0,
          dirtyRange: null,
          diagnostics: { fixture },
          validationErrors: [],
        };
      }
      sqlite.exec("DELETE FROM claude_events; DELETE FROM claude_files");
      sqlite
        .query("INSERT INTO claude_events (store, call_id, ts, path) VALUES ('live', 'fixture-call', ?, ?)")
        .run("2026-08-31T10:00:00.000Z", fixture);
      sqlite
        .query(
          `INSERT INTO claude_files (store, path, size, mtime, calls, ingested_at)
           VALUES ('live', ?, ?, ?, 1, ?)`
        )
        .run(fixture, stat.size, stat.mtimeMs, "2026-08-31T10:01:00.000Z");
      return {
        processedInputs: 1,
        skippedInputs: 0,
        writtenRows: 1,
        dirtyRange: { from: "2026-08-31T10:00:00.000Z", to: "2026-08-31T10:00:00.000Z" },
        diagnostics: { fixture },
        validationErrors: [],
      };
    } finally {
      sqlite.close();
    }
  };
  const coordinator = new SyncCoordinator({
    dbPath: created.dbPath,
    rootDir: process.cwd(),
    adapters: adaptersWith({ claude: adapter }),
    mirror: noMirror,
    configFingerprint: () => "fixture-config-v1",
    sourceFingerprint: () => {
      const stat = fs.statSync(fixture);
      return `${stat.size}:${stat.mtimeMs}`;
    },
    prepareStage: () => {},
    refreshDerived: () => {},
  });
  try {
    const first = await enterSyncPipeline(coordinator, {
      trigger: "manual",
      scope: { kind: "vendor", vendor: "claude" },
      mode: "incremental",
    }).completion;
    const second = await enterSyncPipeline(coordinator, {
      trigger: "manual",
      scope: { kind: "vendor", vendor: "claude" },
      mode: "incremental",
    }).completion;
    expect(first.vendors[0]).toMatchObject({ processedInputs: 1, dataChanged: true });
    expect(second.vendors).toEqual([]);
    expect(second.aggregateWorkRequested).toBe(false);
    expect(second.beforeRevisions.data).toBe(first.afterRevisions.data);
    expect(second.afterRevisions.data).toBe(first.afterRevisions.data);
  } finally {
    coordinator.close();
  }
});
