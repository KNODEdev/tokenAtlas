import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { removeTestFixture } from "../test-cleanup";
import { cappedList, type VendorAdapters } from "./adapters";
import { pendingVendorResult, type SyncRunResult } from "./contracts";
import { SyncCoordinator, type SyncCoordinatorOptions } from "./coordinator";
import {
  DIAGNOSTIC_LIST_LIMIT,
  SYNC_RUN_RESULT_MAX_BYTES,
  SyncStore,
  boundedDiagnostics,
  boundedSyncRunResult,
} from "./store";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

const directories: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of directories.splice(0)) {
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function testDatabase(): { directory: string; dbPath: string } {
  const created = createTestDatabase();
  directories.push(created.directory);
  return created;
}

const january = "2026-01-10T10:00:00.000Z";
const revisions = { data: 0, config: 0, vendors: { codex: 0, claude: 0, opencode: 0, grok: 0, gemini: 0, gauges: 0 } };

function runResult(diagnostics: Record<string, unknown>): SyncRunResult {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    trigger: "manual",
    scope: { kind: "vendor", vendor: "claude" },
    mode: "incremental",
    startedAt: january,
    finishedAt: "2026-01-10T10:00:05.000Z",
    status: "success",
    beforeRevisions: revisions,
    afterRevisions: { ...revisions, data: 1 },
    aggregateWorkRequested: true,
    rebuildGeneration: 7,
    rebuildConfiguration: "config-v1",
    vendors: [{
      ...pendingVendorResult("claude"),
      status: "success",
      processedInputs: 3,
      writtenRows: 9,
      dataChanged: true,
      dirtyRange: { from: january, to: january },
      dirtyRanges: [{ from: january, to: january }],
      sourceImpact: {
        basis: "source-record-semantic-diff-v1",
        scope: "published-source-identities",
        sourceFactsChanged: { status: "available", value: "9", reason: null },
        sourceCorrections: { status: "available", value: "0", reason: null },
        sourceDeletions: { status: "available", value: "0", reason: null },
        canonicalFacts: { status: "available", value: "9", reason: null },
        duplicates: { status: "available", value: "0", reason: null },
        evidence: [],
      },
      startedAt: january,
      finishedAt: "2026-01-10T10:00:05.000Z",
      diagnostics,
    }],
    error: null,
  };
}

/** One entry per archived source file: what a failing run used to store in full. */
function enumeration(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}/conversation-${index}.db: source absent`);
}

test("a diagnostic list keeps its first entries and reports the count it was cut from", () => {
  const bounded = boundedDiagnostics({
    mirror: { copied: 0, warnings: enumeration(400, "C:/gemini"), errors: enumeration(300, "C:/gemini") },
    stores: { main: { files: 2, details: enumeration(120, "C:/gauges") } },
    warnings: ["only one"],
    unavailableInputs: enumeration(60, "C:/codex"),
    unavailableInputsTotal: 4321,
  });
  const mirror = bounded.mirror as Record<string, unknown>;
  expect((mirror.warnings as string[]).length).toBe(DIAGNOSTIC_LIST_LIMIT);
  expect((mirror.warnings as string[])[0]).toBe("C:/gemini/conversation-0.db: source absent");
  expect(mirror.warningsTotal).toBe(400);
  expect(mirror.errorsTotal).toBe(300);
  expect(mirror.copied).toBe(0);
  expect(((bounded.stores as Record<string, Record<string, unknown>>).main!.details as string[]).length).toBe(DIAGNOSTIC_LIST_LIMIT);
  expect((bounded.stores as Record<string, Record<string, unknown>>).main!.detailsTotal).toBe(120);
  // A short list is untouched and a producer's own count is never overwritten.
  expect(bounded.warnings).toEqual(["only one"]);
  expect(bounded.warningsTotal).toBeUndefined();
  expect(bounded.unavailableInputsTotal).toBe(4321);
});

test("an adapter list is capped where it is produced, with the count it was cut from", () => {
  // The shape the Codex adapter emits for unreadable transcripts.
  const unavailable = Array.from({ length: 4_000 }, (_, index) => ({ path: `C:/codex/${index}.jsonl`, message: "read failed" }));
  const capped = cappedList("unavailableInputs", unavailable);
  expect((capped.unavailableInputs as unknown[]).length).toBe(DIAGNOSTIC_LIST_LIMIT);
  expect((capped.unavailableInputs as Array<{ path: string }>)[0]!.path).toBe("C:/codex/0.jsonl");
  expect(capped.unavailableInputsTotal).toBe(4_000);
  // A list within the cap keeps the shape earlier runs recorded: no counter.
  expect(cappedList("warnings", ["one", "two"])).toEqual({ warnings: ["one", "two"] });
});

test("a result under the cap is stored unchanged", () => {
  const result = runResult({ warnings: ["one"], mirror: { copied: 1 } });
  expect(boundedSyncRunResult(result)).toBe(result);
  expect(result.truncated).toBeUndefined();
});

test("an oversized result keeps every field its readers walk and says it was reduced", () => {
  const result = runResult({
    mirror: { copied: 2, archiveFiles: enumeration(300_000, "C:/archive") },
    reparse: { requested: 4, unavailable: [{ store: "live", path: "a.jsonl" }] },
    stderr: "x".repeat(50_000),
  });
  result.error = "y".repeat(80_000);
  const reduced = boundedSyncRunResult(result);
  expect(Buffer.byteLength(JSON.stringify(reduced))).toBeLessThanOrEqual(SYNC_RUN_RESULT_MAX_BYTES);
  expect(reduced.truncated).toBe(true);
  expect(reduced.runId).toBe(result.runId);
  expect(reduced.status).toBe("success");
  expect(reduced.mode).toBe("incremental");
  expect(reduced.startedAt).toBe(result.startedAt);
  expect(reduced.finishedAt).toBe(result.finishedAt);
  expect(reduced.beforeRevisions).toEqual(result.beforeRevisions);
  expect(reduced.afterRevisions).toEqual(result.afterRevisions);
  expect(reduced.rebuildGeneration).toBe(7);
  expect(reduced.rebuildConfiguration).toBe("config-v1");
  expect(reduced.aggregateWorkRequested).toBe(true);
  const vendor = reduced.vendors[0]!;
  expect(vendor.status).toBe("success");
  expect(vendor.dataChanged).toBe(true);
  expect(vendor.dirtyRange).toEqual({ from: january, to: january });
  expect(vendor.dirtyRanges).toEqual([{ from: january, to: january }]);
  expect(vendor.writtenRows).toBe(9);
  expect(vendor.sourceImpact).toEqual(result.vendors[0]!.sourceImpact);
  // Sampled diagnostics keep their shape, so an unavailability is still visible.
  const reparse = vendor.diagnostics.reparse as { unavailable: unknown[] };
  expect(reparse.unavailable).toHaveLength(1);
  expect(((vendor.diagnostics.mirror as Record<string, unknown>).archiveFiles as string[]).length).toBeLessThanOrEqual(5);
  expect((vendor.diagnostics.mirror as Record<string, unknown>).archiveFilesTotal).toBe(300_000);
  expect(String(reduced.error)).toContain("more characters omitted");
  // The source result is never mutated in place.
  expect(result.truncated).toBeUndefined();
  expect((result.vendors[0]!.diagnostics.mirror as Record<string, unknown>).archiveFiles).toHaveLength(300_000);
});

test("the persisted run stays under the cap and reads back through the store", () => {
  const { dbPath } = testDatabase();
  const sqlite = new Database(dbPath);
  try {
    const store = new SyncStore(sqlite);
    const result = runResult({ mirror: { copied: 0, warnings: enumeration(400_000, "C:/gemini") } });
    expect(store.claimRun({ ...result, status: "running", finishedAt: null }).claimed).toBe(true);
    store.saveRun(result);
    const stored = sqlite.query("SELECT length(result_json) AS bytes FROM sync_runs WHERE run_id=?")
      .get(result.runId) as { bytes: number };
    expect(stored.bytes).toBeLessThanOrEqual(SYNC_RUN_RESULT_MAX_BYTES);
    const parsed = store.runById(result.runId)!;
    expect(parsed.truncated).toBe(true);
    expect(parsed.status).toBe("success");
    expect(parsed.scope).toEqual({ kind: "vendor", vendor: "claude" });
    expect(parsed.vendors.map((vendor) => vendor.vendor)).toEqual(["claude"]);
    expect(parsed.vendors[0]!.dirtyRanges).toEqual([{ from: january, to: january }]);
    expect(parsed.vendors[0]!.sourceImpact).toEqual(result.vendors[0]!.sourceImpact);
    expect(store.latestRun()!.runId).toBe(result.runId);
  } finally {
    sqlite.close();
  }
});

function coordinator(dbPath: string, adapters: VendorAdapters, overrides: Partial<SyncCoordinatorOptions> = {}): SyncCoordinator {
  return new SyncCoordinator({
    dbPath,
    rootDir: process.cwd(),
    adapters,
    mirror: noMirror,
    configFingerprint: () => "fixture-config-v1",
    sourceFingerprint: (vendor) => `fixture-source:${vendor}:${Math.random()}`,
    prepareStage: () => {},
    refreshDerived: () => {},
    ...overrides,
  });
}

const claudeRun = { trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "incremental" } as const;

async function runOnce(dbPath: string, adapters: VendorAdapters): Promise<SyncRunResult> {
  const instance = coordinator(dbPath, adapters);
  try {
    return await instance.enter(claudeRun).completion;
  } finally {
    instance.close();
  }
}

test("a run whose adapter floods diagnostics is still stored bounded and its stage stays disposable", async () => {
  const { dbPath, directory } = testDatabase();
  const flooding: VendorAdapters["claude"] = async (context) => {
    const stage = new Database(context.stageDbPath);
    try {
      stage.query("INSERT INTO claude_events (store, call_id, ts, path, in_uncached) VALUES ('live', ?, ?, ?, 5)")
        .run("flooded", january, "a.jsonl");
    } finally {
      stage.close();
    }
    return {
      ...successfulNoop(),
      processedInputs: 1,
      writtenRows: 1,
      dirtyRange: { from: january, to: january },
      diagnostics: { warnings: enumeration(200_000, "C:/claude") },
    };
  };
  const run = await runOnce(dbPath, adaptersWith({ claude: flooding }));
  expect(run.status).toBe("success");

  const sqlite = new Database(dbPath);
  let bytes: number;
  try {
    bytes = (sqlite.query("SELECT length(result_json) AS bytes FROM sync_runs WHERE run_id=?")
      .get(run.runId) as { bytes: number }).bytes;
  } finally {
    sqlite.close();
  }
  expect(bytes).toBeLessThanOrEqual(SYNC_RUN_RESULT_MAX_BYTES);

  // Rebuild the residue this run would leave if its own cleanup had lost a race,
  // then prove a later run still proves it disposable from the stored record.
  const staging = path.join(directory, "sync-staging");
  fs.mkdirSync(staging, { recursive: true });
  const residue = path.join(staging, `${run.runId}-claude.sqlite`);
  fs.writeFileSync(residue, "stage");
  const later = await runOnce(dbPath, adaptersWith({}));
  expect(later.status).toBe("success");
  expect(fs.existsSync(residue)).toBe(false);
}, 30_000);

/** The cheapest oversized shape there is: evidence, not diagnostics. */
function overflowingRanges(count: number, days: number): Array<{ from: string; to: string }> {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(Date.parse("2025-01-01T00:00:00.000Z") + (index % days) * 86_400_000).toISOString().slice(0, 10);
    const minute = String(index % 60).padStart(2, "0");
    return { from: `${day}T01:${minute}:00.000Z`, to: `${day}T02:${minute}:00.000Z` };
  });
}

test("dirty ranges are merged at day granularity, never sampled, when evidence alone overflows", () => {
  const result = runResult({ warnings: ["one"] });
  const ranges = overflowingRanges(20_000, 400);
  result.vendors[0]!.dirtyRanges = ranges;
  result.vendors[0]!.sourceImpact!.evidence = Array.from({ length: 200 }, (_, index) => ({
    provider: "claude" as const, table: `claude_events_${index}`, keyColumns: ["store", "call_id"],
    semanticColumns: ["ts", "model", "in_uncached"], status: "available" as const, reason: null,
    beforeRecords: "10", afterRecords: "11", additions: "1", corrections: "0", deletions: "0",
  }));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(SYNC_RUN_RESULT_MAX_BYTES);

  const bounded = boundedSyncRunResult(result);
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(SYNC_RUN_RESULT_MAX_BYTES);
  const vendor = bounded.vendors[0]!;
  // 400 touched days, consecutive from the same start: one range, covering every one.
  const days = (list: Array<{ from: string; to: string }>) => {
    const covered = new Set<string>();
    for (const range of list) {
      for (let day = range.from.slice(0, 10); day <= range.to.slice(0, 10);
           day = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)) covered.add(day);
    }
    return [...covered].sort();
  };
  expect(days(vendor.dirtyRanges!)).toEqual(days(ranges));
  expect(vendor.dirtyRanges!.length).toBeLessThan(ranges.length);
  expect(vendor.dirtyRange).toEqual(result.vendors[0]!.dirtyRange);
  // Impact evidence is a sample with its true count; the exact metrics stay whole.
  expect(vendor.sourceImpact!.evidence.length).toBeLessThanOrEqual(5);
  expect(vendor.sourceImpact!.evidenceTotal).toBe(200);
  expect(vendor.sourceImpact!.sourceFactsChanged).toEqual({ status: "available", value: "9", reason: null });
  expect(bounded.truncated).toBe(true);
  // The source result is never mutated in place.
  expect(result.vendors[0]!.dirtyRanges).toHaveLength(20_000);
});

test("a result that cannot be bounded is refused instead of stored oversized", () => {
  const result = runResult({ warnings: ["one"] });
  // Ranges a day apart cannot merge: nothing may be dropped to make them fit.
  result.vendors[0]!.dirtyRanges = Array.from({ length: 20_000 }, (_, index) => {
    const day = new Date(Date.parse("2025-01-01T00:00:00.000Z") + index * 2 * 86_400_000).toISOString().slice(0, 10);
    return { from: `${day}T01:00:00.000Z`, to: `${day}T02:00:00.000Z` };
  });
  expect(() => boundedSyncRunResult(result)).toThrow(/cannot be stored within/);
});

test("a rebuild vendor whose evidence was sampled resumes only on a proven completeness flag", () => {
  const { dbPath } = testDatabase();
  const sqlite = new Database(dbPath);
  try {
    const store = new SyncStore(sqlite);
    // Diagnostics so wide that sampling them is still oversized: the reduction then
    // replaces them outright, which is where unread inputs used to disappear.
    const flooded = runResult({
      ...Object.fromEntries(Array.from({ length: 60 }, (_, group) => [`group${group}`,
        Object.fromEntries(Array.from({ length: 60 }, (_, entry) => [`entry${entry}`, "x".repeat(3_000)]))])),
      reparse: { requested: 3, unavailable: [{ store: "live", path: "kept.jsonl" }] },
    });
    const reduced = boundedSyncRunResult(flooded);
    expect(reduced.truncated).toBe(true);
    expect(reduced.vendors[0]!.diagnostics).toEqual({ truncated: true });

    expect(store.claimRun({ ...flooded, status: "running", finishedAt: null }).claimed).toBe(true);
    store.saveRun(flooded);
    // One input was left to reread; nothing in the stored run may claim otherwise.
    expect([...store.completedReparseVendors(7, "config-v1").keys()]).toEqual([]);

    const proven = runResult(Object.fromEntries(Array.from({ length: 60 }, (_, group) => [`group${group}`,
      Object.fromEntries(Array.from({ length: 60 }, (_, entry) => [`entry${entry}`, "x".repeat(3_000)]))])));
    proven.runId = "22222222-2222-4222-8222-222222222222";
    proven.vendors[0]!.inputsComplete = true;
    expect(store.claimRun({ ...proven, status: "running", finishedAt: null }).claimed).toBe(true);
    store.saveRun(proven);
    // The same reduction, and the flag it must never drop.
    const stored = store.runById(proven.runId)!;
    expect(stored.truncated).toBe(true);
    expect(stored.vendors[0]!.diagnostics).toEqual({ truncated: true });
    expect(stored.vendors[0]!.inputsComplete).toBe(true);
    const completed = store.completedReparseVendors(7, "config-v1");
    expect([...completed.keys()]).toEqual(["claude"]);
    expect(completed.get("claude")!.diagnostics.resumedFromRun).toBe(proven.runId);
  } finally {
    sqlite.close();
  }
});

test("the coordinator records input completeness where it reads the inputs", async () => {
  const { dbPath } = testDatabase();
  const complete = await runOnce(dbPath, adaptersWith({}));
  expect(complete.vendors.every((vendor) => vendor.inputsComplete === true)).toBe(true);

  // The shape the Codex adapter emits when transcripts stay unread: a capped
  // sample with its true count, which is exactly what truncation later resamples.
  const withUnreadInputs: VendorAdapters["claude"] = async () => ({
    ...successfulNoop(),
    diagnostics: cappedList("unavailableInputs", Array.from({ length: 3_000 },
      (_, index) => ({ path: `C:/claude/${index}.jsonl`, message: "read failed" }))),
  });
  const partial = await runOnce(dbPath, adaptersWith({ claude: withUnreadInputs }));
  expect(partial.vendors.find((vendor) => vendor.vendor === "claude")!.inputsComplete).toBe(false);
}, 30_000);
