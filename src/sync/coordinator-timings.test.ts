import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { removeTestFixture } from "../test-cleanup";
import { SyncCoordinator } from "./coordinator";
import { VENDOR_IDS, type VendorPhaseTimings } from "./contracts";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

const request = { trigger: "manual" as const, scope: { kind: "vendor" as const, vendor: "claude" as const }, mode: "incremental" as const };
const optional = ["reparsePreparationMs", "validationMs", "comparisonMs", "publicationMs"] as const;

function assertMeasured(timings: VendorPhaseTimings, field: typeof optional[number]): void {
  expect(Number.isInteger(timings[field])).toBe(true);
  expect(timings[field]).toBeGreaterThanOrEqual(0);
}

test("all six vendors retain absent optional spans on a full no-op, including the stored result", async () => {
  const { directory, dbPath } = createTestDatabase();
  const instance = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(), adapters: adaptersWith({}),
    mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "fixture",
    prepareStage: () => {}, refreshDerived: () => {} });
  try {
    const result = await instance.enter({ trigger: "manual", scope: { kind: "all" }, mode: "full" }).completion;
    expect(result.status).toBe("success");
    expect(result.vendors.map(vendor => vendor.vendor).sort()).toEqual([...VENDOR_IDS].sort());
    const stored = instance.latest()!;
    expect(stored.status).toBe("success");
    for (const vendor of stored.vendors) {
      expect(vendor.status).toBe("success");
      for (const field of optional) expect(vendor.timings?.[field]).toBeUndefined();
    }
    expect(stored.beforeRevisions.data).toBe(stored.afterRevisions.data);
    expect(stored.beforeRevisions.vendors).toEqual(stored.afterRevisions.vendors);
  } finally { instance.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});

test("incremental reparse persists entered spans and a rolled-back publication keeps facts and revisions", async () => {
  const { directory, dbPath } = createTestDatabase();
  let failPublication = true;
  const instance = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(),
    adapters: adaptersWith({ claude: async context => {
      const stage = new Database(context.stageDbPath);
      try { stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','call','source.jsonl','2026-01-10T10:00:00.000Z',7)").run(); }
      finally { stage.close(); }
      return { ...successfulNoop(), processedInputs: 1, writtenRows: 1 };
    } }), mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "fixture",
    prepareStage: () => {}, refreshDerived: () => {},
    afterPublishBeforeRevision: () => { if (failPublication) throw new Error("publication interrupted"); } });
  const db = new Database(dbPath);
  const facts = () => db.query("SELECT call_id,in_uncached FROM claude_events").all();
  try {
    const failed = await instance.enter({ ...request, reparse: {}, rebuildGeneration: 1 }).completion;
    const failedVendor = failed.vendors[0]!;
    expect(failed.status).toBe("failure");
    expect(failedVendor.error).toContain("publication interrupted");
    for (const field of optional) assertMeasured(failedVendor.timings!, field);
    expect(facts()).toEqual([]);
    expect(failed.beforeRevisions.data).toBe(failed.afterRevisions.data);
    expect(failed.beforeRevisions.vendors).toEqual(failed.afterRevisions.vendors);
    expect(instance.latest()?.vendors[0]?.timings).toEqual(failedVendor.timings);

    failPublication = false;
    const succeeded = await instance.enter({ ...request, reparse: {}, rebuildGeneration: 2 }).completion;
    expect(succeeded.status).toBe("success");
    expect(facts()).toEqual([{ call_id: "call", in_uncached: 7 }]);
    expect(succeeded.afterRevisions.data).toBe(succeeded.beforeRevisions.data + 1);
    for (const field of optional) assertMeasured(instance.latest()!.vendors[0]!.timings!, field);
  } finally { db.close(); instance.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});

test("full update measures validation and comparison, while an identical run publishes no facts", async () => {
  const { directory, dbPath } = createTestDatabase();
  const instance = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(),
    adapters: adaptersWith({ claude: async context => {
      const stage = new Database(context.stageDbPath);
      try {
        stage.exec("DELETE FROM claude_events");
        stage.query("INSERT INTO claude_events(store,call_id,path,ts,in_uncached) VALUES('pc','full','full.jsonl','2026-01-10T10:00:00.000Z',9)").run();
      }
      finally { stage.close(); }
      return { ...successfulNoop(), processedInputs: 1, writtenRows: 1 };
    } }), mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "fixture",
    prepareStage: () => {
      const deadline = performance.now() + 8;
      while (performance.now() < deadline) { /* Bounded validation work. */ }
    }, refreshDerived: () => {} });
  const db = new Database(dbPath);
  try {
    const first = await instance.enter({ ...request, mode: "full" }).completion;
    expect(first.status).toBe("success");
    expect(first.vendors[0]?.dataChanged).toBe(true);
    expect(db.query("SELECT call_id,in_uncached FROM claude_events").all()).toEqual([{ call_id: "full", in_uncached: 9 }]);
    expect(first.afterRevisions.data).toBe(first.beforeRevisions.data + 1);
    const firstTimings = instance.latest()!.vendors[0]!.timings!;
    assertMeasured(firstTimings, "validationMs");
    expect(firstTimings.validationMs).toBeGreaterThanOrEqual(5);
    assertMeasured(firstTimings, "comparisonMs");
    assertMeasured(firstTimings, "publicationMs");
    expect(firstTimings.reparsePreparationMs).toBeUndefined();

    const second = await instance.enter({ ...request, mode: "full" }).completion;
    expect(second.status).toBe("success");
    expect(second.vendors[0]?.dataChanged).toBe(false);
    expect(second.afterRevisions.data).toBe(second.beforeRevisions.data);
    expect(db.query("SELECT call_id,in_uncached FROM claude_events").all()).toEqual([{ call_id: "full", in_uncached: 9 }]);
    const secondTimings = instance.latest()!.vendors[0]!.timings!;
    assertMeasured(secondTimings, "validationMs");
    assertMeasured(secondTimings, "comparisonMs");
    assertMeasured(secondTimings, "publicationMs");
  } finally { db.close(); instance.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});

test("gauges append publication records the call without a comparison span", async () => {
  const { directory, dbPath } = createTestDatabase();
  const instance = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(),
    adapters: adaptersWith({ gauges: async context => {
      const stage = new Database(context.stageDbPath);
      try {
        stage.query("INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,used_percent) VALUES('codex','fixture','2026-01-10T10:00:00.000Z','primary','used',42)").run();
      } finally { stage.close(); }
      return { ...successfulNoop(), processedInputs: 1, writtenRows: 1 };
    } }), mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "fixture",
    prepareStage: () => {}, refreshDerived: () => {} });
  const db = new Database(dbPath);
  try {
    const result = await instance.enter({ trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "incremental" }).completion;
    expect(result.status).toBe("success");
    expect(db.query("SELECT used_percent FROM probe_windows WHERE subject='fixture'").get()).toEqual({ used_percent: 42 });
    const timings = instance.latest()!.vendors[0]!.timings!;
    assertMeasured(timings, "validationMs");
    assertMeasured(timings, "publicationMs");
    expect(timings.comparisonMs).toBeUndefined();
    expect(timings.reparsePreparationMs).toBeUndefined();
  } finally { db.close(); instance.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});

test("validation failure measures its entered span and never reports publication", async () => {
  const { directory, dbPath } = createTestDatabase();
  const instance = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(),
    adapters: adaptersWith({ claude: async () => ({ ...successfulNoop(), processedInputs: 1, writtenRows: 1 }) }),
    mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "fixture",
    prepareStage: () => { throw new Error("fixture remap failed"); }, refreshDerived: () => {} });
  const db = new Database(dbPath);
  try {
    const result = await instance.enter({ ...request, mode: "full" }).completion;
    expect(result.status).toBe("failure");
    expect(result.vendors[0]?.error).toContain("fixture remap failed");
    expect(result.beforeRevisions.data).toBe(result.afterRevisions.data);
    expect(result.beforeRevisions.vendors).toEqual(result.afterRevisions.vendors);
    expect(db.query("SELECT count(*) AS n FROM claude_events").get()).toEqual({ n: 0 });
    const timings = instance.latest()!.vendors[0]!.timings!;
    assertMeasured(timings, "validationMs");
    expect(timings.comparisonMs).toBeUndefined();
    expect(timings.publicationMs).toBeUndefined();
  } finally { db.close(); instance.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});

test("a legacy stored timing payload remains readable", async () => {
  const { directory, dbPath } = createTestDatabase();
  const instance = new SyncCoordinator({ archiveInputs: () => undefined, dbPath, rootDir: process.cwd(), adapters: adaptersWith({}),
    mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "fixture",
    prepareStage: () => {}, refreshDerived: () => {} });
  try {
    const result = await instance.enter({ ...request, mode: "full" }).completion;
    const db = new Database(dbPath);
    try {
      const row = db.query("SELECT result_json FROM sync_runs WHERE run_id=?").get(result.runId) as { result_json: string };
      const legacy = JSON.parse(row.result_json);
      for (const vendor of legacy.vendors) {
        for (const field of optional) delete vendor.timings[field];
      }
      db.query("UPDATE sync_runs SET result_json=? WHERE run_id=?").run(JSON.stringify(legacy), result.runId);
    } finally { db.close(); }
    expect(instance.latest()?.mode).toBe("full");
    const timings = instance.latest()?.vendors[0]?.timings;
    for (const field of ["mirrorMs", "stageMs", "ingestMs", "publishMs"] as const) {
      expect(Number.isInteger(timings?.[field])).toBe(true);
    }
    for (const field of optional) expect(timings?.[field]).toBeUndefined();
  } finally { instance.close(); removeTestFixture(directory, { recursive: true, force: true }); }
});
