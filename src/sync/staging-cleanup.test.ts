import { afterAll, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import type { VendorAdapters } from "./adapters";
import { SyncCoordinator, type SyncCoordinatorOptions } from "./coordinator";
import { ORPHAN_STAGE_MS, recoverDisposableStages, removeStageArtifacts, stageArtifacts, stageRunIsDisposable } from "./staging";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

const temporaryDirectories: string[] = [];
const january = "2026-01-10T10:00:00.000Z";

function testDatabase(): { directory: string; dbPath: string } {
  const created = createTestDatabase();
  temporaryDirectories.push(created.directory);
  return created;
}

/** A fresh source fingerprint per run, so a vendor is never skipped as unchanged. */
let generation = 0;

function coordinator(
  dbPath: string,
  adapters: VendorAdapters,
  overrides: Partial<SyncCoordinatorOptions> = {}
): SyncCoordinator {
  generation += 1;
  const stamp = generation;
  return new SyncCoordinator({
    dbPath,
    rootDir: process.cwd(),
    adapters,
    mirror: noMirror,
    configFingerprint: () => "fixture-config-v1",
    sourceFingerprint: (vendor) => `fixture-source:${vendor}:${stamp}`,
    prepareStage: () => {},
    refreshDerived: () => {},
    ...overrides,
  });
}

/** An adapter that behaves like a real ingest: a WAL connection writing staged facts. */
function writingAdapter(hold?: Database[]): VendorAdapters["claude"] {
  return async (context) => {
    const stage = new Database(context.stageDbPath);
    stage.exec("PRAGMA journal_mode = WAL");
    stage.query("INSERT INTO claude_events (store, call_id, ts, path, in_uncached) VALUES ('live', ?, ?, ?, 5)")
      .run(`call-${generation}-${Math.random()}`, january, "a.jsonl");
    if (hold) hold.push(stage);
    else stage.close();
    return { ...successfulNoop(), processedInputs: 1, writtenRows: 1, dirtyRange: { from: january, to: january } };
  };
}

const claudeRun = { trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "incremental" } as const;

function stagingFiles(directory: string): string[] {
  const root = path.join(directory, "sync-staging");
  return fs.existsSync(root) ? fs.readdirSync(root).filter(name =>
    name !== "live" || fs.readdirSync(path.join(root, name)).length > 0).sort() : [];
}

async function runOnce(
  dbPath: string,
  adapters: VendorAdapters,
  request: Parameters<SyncCoordinator["enter"]>[0] = claudeRun,
  overrides: Partial<SyncCoordinatorOptions> = {}
) {
  const instance = coordinator(dbPath, adapters, overrides);
  try {
    return await instance.enter(request).completion;
  } finally {
    instance.close();
  }
}

test("a completed sync closes its stage handles and removes the stage database with its sidecars", async () => {
  const { dbPath, directory } = testDatabase();
  const run = await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }));
  expect(run.status).toBe("success");
  expect(run.vendors.map((vendor) => vendor.status)).toEqual(["success"]);
  // Nothing of the stage survives: database, -wal and -shm are all gone.
  expect(stagingFiles(directory)).toEqual([]);
});

test("a stage still held open is reported as retryable and removed by a later run", async () => {
  const { dbPath, directory } = testDatabase();
  const held: Database[] = [];
  const blocked = await runOnce(dbPath, adaptersWith({ claude: writingAdapter(held) }));
  expect(blocked.status).toBe("success");
  const residue = stagingFiles(directory);
  if (process.platform !== "win32") {
    // POSIX can unlink the open stage; only retained artifacts produce a cleanup warning.
    expect(residue).toEqual([]);
    expect(blocked.vendors[0]!.diagnostics.stageCleanup).toBeUndefined();
    expect((blocked.vendors[0]!.diagnostics.warnings as string[] | undefined) ?? [])
      .not.toContainEqual(expect.stringContaining("Stage cleanup incomplete"));
    for (const stage of held) stage.close();
    return;
  }
  expect(residue.length).toBeGreaterThan(0);
  expect(residue.every((file) => file.startsWith(blocked.runId))).toBe(true);
  // The failure is visible on the run instead of being swallowed.
  const warnings = blocked.vendors[0]!.diagnostics.warnings as string[];
  expect(warnings.some((warning) => warning.includes("Stage cleanup incomplete"))).toBe(true);
  expect((blocked.vendors[0]!.diagnostics.stageCleanup as { retained: string[] }).retained.length)
    .toBeGreaterThan(0);

  // The publication itself succeeded, so the retained stage holds nothing unacknowledged.
  for (const stage of held) stage.close();
  const later = await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }));
  expect(later.status).toBe("success");
  expect(stagingFiles(directory)).toEqual([]);
});

test("an ingest connection abandoned without close does not leave a stage behind", async () => {
  const { dbPath, directory } = testDatabase();
  const leaking: VendorAdapters["claude"] = async (context) => {
    // Matches an ingest path that throws past its own close(): the handle becomes
    // unreachable and only a forced collection releases the file on Windows.
    const stage = new Database(context.stageDbPath);
    stage.query("INSERT INTO claude_events (store, call_id, ts, path, in_uncached) VALUES ('live', ?, ?, ?, 5)")
      .run("leaked", january, "a.jsonl");
    return { ...successfulNoop(), processedInputs: 1, writtenRows: 1, dirtyRange: { from: january, to: january } };
  };
  const run = await runOnce(dbPath, adaptersWith({ claude: leaking }));
  expect(run.status).toBe("success");
  expect(stagingFiles(directory)).toEqual([]);
});

test("recovery removes the stage of any finished run, including failed and partial ones", async () => {
  const { dbPath, directory } = testDatabase();
  const failing: VendorAdapters["claude"] = async () => { throw new Error("adapter refused"); };

  const success = await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }));
  expect(success.status).toBe("success");
  const failure = await runOnce(dbPath, adaptersWith({ claude: failing }));
  expect(failure.status).toBe("failure");
  const partial = await runOnce(
    dbPath,
    adaptersWith({ claude: writingAdapter(), codex: failing }),
    { trigger: "manual", scope: { kind: "vendors", vendors: ["claude", "codex"] }, mode: "incremental" }
  );
  expect(partial.status).toBe("partial_success");

  // Rebuild the residue each of those runs would leave if its cleanup had lost a race.
  const root = path.join(directory, "sync-staging");
  fs.mkdirSync(root, { recursive: true });
  const unknownRun = "00000000-0000-4000-8000-000000000000";
  const staged = [
    `${success.runId}-claude.sqlite`,
    `${success.runId}-claude.sqlite-wal`,
    `${success.runId}-identity.sqlite`,
    `${failure.runId}-claude.sqlite`,
    `${partial.runId}-claude.sqlite`,
    `${unknownRun}-claude.sqlite`,
    `${success.runId}-unknownvendor.sqlite`,
    "operator-notes.txt",
  ];
  for (const file of staged) fs.writeFileSync(path.join(root, file), "stage");
  fs.mkdirSync(path.join(root, "frozen-manifest-1"), { recursive: true });
  fs.writeFileSync(path.join(root, "frozen-manifest-1", "claude.sqlite"), "frozen");

  const sweep = await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }));
  expect(sweep.status).toBe("success");
  // Nothing reuses an abandoned stage, so a finished run's scratch goes whatever its
  // status. Only the orphan, which no run record explains yet, and the files that are
  // not stages at all survive.
  expect(stagingFiles(directory)).toEqual([
    "frozen-manifest-1",
    `${unknownRun}-claude.sqlite`,
    "operator-notes.txt",
  ].sort());
});

test("an orphan stage is kept until it has aged out, then removed", async () => {
  const { dbPath, directory } = testDatabase();
  const root = path.join(directory, "sync-staging");
  fs.mkdirSync(root, { recursive: true });
  const orphan = path.join(root, "66666666-6666-4666-8666-666666666666-claude.sqlite");
  fs.writeFileSync(orphan, "stage");

  expect((await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }))).status).toBe("success");
  expect(fs.existsSync(orphan)).toBe(true);

  const aged = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(orphan, aged, aged);
  expect((await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }))).status).toBe("success");
  expect(fs.existsSync(orphan)).toBe(false);
});

test("a stage of a run still recorded as running is never disposable", () => {
  expect(stageRunIsDisposable({ status: "running", finishedAt: null }, 0, Date.now())).toBe(false);
  expect(stageRunIsDisposable({ status: "running", finishedAt: january }, 0, Date.now())).toBe(false);
  // A terminal status with no finish time is an interrupted record, not a closed run.
  expect(stageRunIsDisposable({ status: "failure", finishedAt: null }, 0, Date.now())).toBe(false);
  for (const status of ["success", "failure", "partial_success"]) {
    expect(stageRunIsDisposable({ status, finishedAt: january }, 0, Date.now())).toBe(true);
  }
  const now = Date.now();
  expect(stageRunIsDisposable(null, now - ORPHAN_STAGE_MS + 1000, now)).toBe(false);
  expect(stageRunIsDisposable(null, now - ORPHAN_STAGE_MS, now)).toBe(true);
});

test("recovery keeps the run in progress, unknown names and anything it cannot prove disposable", () => {
  const { directory } = testDatabase();
  const root = path.join(directory, "sync-staging");
  fs.mkdirSync(root, { recursive: true });
  const disposableRun = "11111111-1111-4111-8111-111111111111";
  const runningRun = "22222222-2222-4222-8222-222222222222";
  for (const file of [
    `${disposableRun}-claude.sqlite`,
    `${disposableRun}-claude.sqlite-shm`,
    `${runningRun}-gauges.sqlite`,
    `${runningRun}-gauges.sqlite-wal`,
    "atlas.sqlite",
    "not-a-uuid-claude.sqlite",
  ]) fs.writeFileSync(path.join(root, file), "stage");

  const asked: string[] = [];
  const result = recoverDisposableStages(root, (runId, vendor) => {
    asked.push(`${runId}-${vendor}`);
    return runId === disposableRun;
  });

  expect(result).toEqual({ removed: 2, retained: 2, cursor: `${runningRun}-gauges` });
  // Each stage is decided once, whatever the number of sidecars it has.
  expect(asked.sort()).toEqual([`${disposableRun}-claude`, `${runningRun}-gauges`]);
  expect(fs.readdirSync(root).sort()).toEqual([
    "atlas.sqlite",
    "not-a-uuid-claude.sqlite",
    `${runningRun}-gauges.sqlite`,
    `${runningRun}-gauges.sqlite-wal`,
  ].sort());
});

test("recovery tolerates a missing staging directory and a bounded number of stages", () => {
  const { directory } = testDatabase();
  const root = path.join(directory, "sync-staging");
  expect(recoverDisposableStages(path.join(root, "absent"), () => true)).toEqual({ removed: 0, retained: 0, cursor: null });

  fs.mkdirSync(root, { recursive: true });
  const runIds = Array.from({ length: 5 }, (_, index) =>
    `3333333${index}-3333-4333-8333-333333333333`);
  for (const runId of runIds) fs.writeFileSync(path.join(root, `${runId}-claude.sqlite`), "stage");
  expect(recoverDisposableStages(root, () => true, 2)).toEqual({ removed: 2, retained: 0, cursor: `${runIds[1]}-claude` });
  expect(fs.readdirSync(root).length).toBe(3);
});

test("recovery advances past retained runs and wraps after directory changes", () => {
  const { directory } = testDatabase();
  const root = path.join(directory, "sync-staging");
  fs.mkdirSync(root, { recursive: true });
  const runIds = Array.from({ length: 5 }, (_, index) =>
    `5555555${index}-5555-4555-8555-555555555555`);
  const file = (index: number) => path.join(root, `${runIds[index]}-claude.sqlite`);
  for (let index = 0; index < runIds.length; index++) fs.writeFileSync(file(index), "stage");
  const disposable = (runId: string) => runId === runIds[4];
  const first = recoverDisposableStages(root, disposable, 2);
  expect(first).toEqual({ removed: 0, retained: 2, cursor: `${runIds[1]}-claude` });
  const second = recoverDisposableStages(root, disposable, 2, first.cursor);
  expect(second).toEqual({ removed: 0, retained: 2, cursor: `${runIds[3]}-claude` });
  const third = recoverDisposableStages(root, disposable, 2, second.cursor);
  expect(third).toEqual({ removed: 1, retained: 1, cursor: `${runIds[0]}-claude` });
  expect(fs.existsSync(file(4))).toBe(false);
  // A new disposable entry before the saved cursor is reached after wrapping.
  fs.writeFileSync(file(4), "stage");
  const fourth = recoverDisposableStages(root, () => true, 2, `${runIds[4]}-claude`);
  expect(fourth).toEqual({ removed: 2, retained: 0, cursor: `${runIds[1]}-claude` });
});

test("coordinator persists recovery progress across restarts with retained stages", async () => {
  const { dbPath, directory } = testDatabase();
  const success = await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }));
  expect(success.status).toBe("success");
  const root = path.join(directory, "sync-staging");
  const stale = path.join(root, `${success.runId}-claude.sqlite`);
  fs.writeFileSync(stale, "published");
  // These unknown runs sort first and must be retained, without blocking recovery.
  for (let index = 0; index < 500; index++) {
    fs.writeFileSync(path.join(root,
      `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}-claude.sqlite`), "unknown");
  }
  expect((await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }))).status).toBe("success");
  expect(fs.existsSync(stale)).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(db.query("SELECT value FROM meta WHERE key='sync_stage_cleanup_cursor'").get())
      .toEqual({ value: "00000000-0000-4000-8000-000000000499-claude" });
  } finally { db.close(); }
  expect((await runOnce(dbPath, adaptersWith({ claude: writingAdapter() }))).status).toBe("success");
  expect(fs.existsSync(stale)).toBe(false);
  expect(stagingFiles(directory).length).toBe(500);
});

test("removing a stage reports the artifacts a live connection keeps locked", () => {
  const { directory } = testDatabase();
  const root = path.join(directory, "sync-staging");
  fs.mkdirSync(root, { recursive: true });
  const stagePath = path.join(root, "44444444-4444-4444-8444-444444444444-claude.sqlite");
  const stage = new Database(stagePath, { create: true });
  stage.exec("PRAGMA journal_mode = WAL");
  stage.exec("CREATE TABLE t (a INTEGER)");
  stage.query("INSERT INTO t VALUES (1)").run();

  const blocked = removeStageArtifacts(stagePath);
  if(process.platform==="win32") {
    expect(blocked.retained).toContain(stagePath);
    expect(fs.existsSync(stagePath)).toBe(true);
  } else {
    expect(blocked.retained).toEqual([]);
    expect(fs.existsSync(stagePath)).toBe(false);
  }

  stage.close();
  const cleared = removeStageArtifacts(stagePath);
  expect(cleared.retained).toEqual([]);
  expect(stageArtifacts(stagePath).some((file) => fs.existsSync(file))).toBe(false);
});

afterAll(() => {
  for (const directory of temporaryDirectories) {
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
