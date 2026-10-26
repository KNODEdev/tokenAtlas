import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { removeTestFixture } from "../test-cleanup";
import { SyncStore } from "./store";
import { SyncCoordinator, enterSyncPipeline } from "./coordinator";
import { pendingVendorResult, type SyncRunResult } from "./contracts";
import { readProcessBirth } from "./process-owner";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

test("startup recovers a reused PID, preserves completed work, and admits the next incremental run", async () => {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  let coordinator: SyncCoordinator | undefined;
  try {
    const store = new SyncStore(db);
    const revisions = store.revisions();
    const completed = { ...pendingVendorResult("codex"), status: "success" as const, processedInputs: 17580,
      writtenRows: 1157982, startedAt: "2000-01-01T00:00:00Z", finishedAt: "2000-01-01T00:01:00Z", dataChanged: true };
    const old: SyncRunResult = {
      runId: crypto.randomUUID(), ownerPid: process.pid, trigger: "auto", scope: { kind: "all" }, mode: "incremental",
      startedAt: "2000-01-01T00:00:00Z", finishedAt: null, status: "running", beforeRevisions: revisions,
      afterRevisions: revisions, aggregateWorkRequested: false,
      vendors: [completed, { ...pendingVendorResult("claude"), startedAt: "2000-01-01T00:01:00Z" }], error: null,
    };
    expect(store.claimRun(old).claimed).toBe(true);
    coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), archiveInputs: () => undefined,
      adapters: adaptersWith({}), mirror: noMirror, configFingerprint: () => "owner-recovery-fixture",
      sourceFingerprint: vendor => `owner-recovery:${vendor}`, prepareStage: () => {}, refreshDerived: () => {} });
    const recovered = store.runById(old.runId)!;
    expect(recovered.status).toBe("partial_success");
    expect(recovered.vendors[0]).toEqual(completed);
    expect(recovered.vendors[1]).toMatchObject({ status: "failure", error: "Sync interrupted by process shutdown" });
    expect(store.revisions()).toEqual(revisions);
    const next = await enterSyncPipeline(coordinator,
      { trigger: "auto", scope: { kind: "vendor", vendor: "claude" }, mode: "incremental" }).completion;
    expect(next.runId).not.toBe(old.runId);
    expect(next.status).toBe("success");
    expect(next.ownerProcessStart).toBe(readProcessBirth(process.pid)!.identity);
    expect(store.activeRun()).toBeNull();
    expect(store.recoverInterrupted(new Date().toISOString())).toEqual([]);
  } finally { coordinator?.close(); db.close(); removeTestFixture(directory, { recursive: true, force: true }); }
}, 30_000);

test("recovery never steals a still-running run with a saved process birth", async () => {
  const { directory, dbPath } = createTestDatabase();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), archiveInputs: () => undefined,
    adapters: adaptersWith({ claude: async () => { await gate; return successfulNoop(); } }), mirror: noMirror,
    configFingerprint: () => "live-owner-fixture", sourceFingerprint: vendor => `live-owner:${vendor}`,
    prepareStage: () => {}, refreshDerived: () => {} });
  const db = new Database(dbPath);
  const execution = enterSyncPipeline(coordinator,
    { trigger: "auto", scope: { kind: "vendor", vendor: "claude" }, mode: "incremental" });
  try {
    const store = new SyncStore(db);
    expect(execution.initial.ownerProcessStart).toBeDefined();
    expect(store.recoverInterrupted(new Date().toISOString())).toEqual([]);
    expect(store.activeRun()?.runId).toBe(execution.initial.runId);
    release();
    expect((await execution.completion).status).toBe("success");
  } finally { release(); await execution.completion; coordinator.close(); db.close(); removeTestFixture(directory, { recursive: true, force: true }); }
}, 30_000);

for (const terminal of [false, true]) {
  test(`recovery preserves an owner's ${terminal ? "terminal result" : "last committed vendor"} saved during process inspection`, () => {
    const { directory, dbPath } = createTestDatabase();
    const db = new Database(dbPath);
    try {
      const baseStore = new SyncStore(db);
      const revisions = baseStore.revisions();
      const old: SyncRunResult = {
        runId: crypto.randomUUID(), ownerPid: 123, trigger: "auto", scope: { kind: "all" }, mode: "incremental",
        startedAt: "2000-01-01T00:00:00Z", finishedAt: null, status: "running", beforeRevisions: revisions,
        afterRevisions: revisions, aggregateWorkRequested: false, vendors: [pendingVendorResult("codex"), pendingVendorResult("claude")], error: null,
      };
      expect(baseStore.claimRun(old).claimed).toBe(true);
      const completed = { ...pendingVendorResult("codex"), status: "success" as const, processedInputs: 7,
        writtenRows: 31, finishedAt: "2000-01-01T00:01:00Z", dataChanged: true };
      const latest: SyncRunResult = { ...old, status: terminal ? "success" : "running",
        finishedAt: terminal ? "2000-01-01T00:02:00Z" : null, afterRevisions: { ...revisions, data: 7 },
        vendors: [completed, { ...pendingVendorResult("claude"), status: terminal ? "success" : "pending" }] };
      const payload = path.join(directory, "last-owner-result.json");
      fs.writeFileSync(payload, JSON.stringify(latest));
      const script = `import {Database} from ${JSON.stringify(path.resolve(import.meta.dir, "../db/sqlite.ts"))};
        import {SyncStore} from ${JSON.stringify(path.resolve(import.meta.dir, "store.ts"))};
        const d=new Database(process.argv[1]); new SyncStore(d).saveRun(JSON.parse(await Bun.file(process.argv[2]).text())); d.close();`;
      const store = new SyncStore(db, () => {
        // The real owner saves and exits before the process inspector reports its death.
        const child = Bun.spawnSync([process.execPath, "--eval", script, dbPath, payload], { stdout: "pipe", stderr: "pipe" });
        expect(child.stderr.toString()).toBe("");
        expect(child.exitCode).toBe(0);
        return false;
      });
      const recovered = store.recoverInterrupted("2000-01-01T00:03:00Z");
      const saved = store.runById(old.runId)!;
      if (terminal) {
        expect(recovered).toEqual([]);
        expect(saved).toEqual(latest);
      } else {
        expect(recovered).toHaveLength(1);
        expect(saved.status).toBe("partial_success");
        expect(saved.vendors[0]).toEqual(completed);
        expect(saved.vendors[1]?.status).toBe("failure");
        expect(saved.afterRevisions).toEqual(latest.afterRevisions);
      }
    } finally { db.close(); removeTestFixture(directory, { recursive: true, force: true }); }
  }, 30_000);
}
