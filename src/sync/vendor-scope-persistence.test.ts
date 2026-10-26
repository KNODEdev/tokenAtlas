import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import { createTestDatabase } from "./test-support";
import { pendingVendorResult, type SyncRunResult, type SyncRunStatus, type VendorId } from "./contracts";
import { SyncStore } from "./store";

const directories: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of directories.splice(0)) {
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function result(runId: string, status: SyncRunStatus, vendors: readonly VendorId[]): SyncRunResult {
  const startedAt = "2026-09-17T10:00:00.000Z";
  const finishedAt = "2026-09-17T10:00:01.000Z";
  const revisions = {data:0,config:0,vendors:{codex:0,claude:0,opencode:0,grok:0,gemini:0,gauges:0}};
  return {
    runId,
    trigger: "manual",
    scope: {kind:"vendors",vendors:[...vendors]},
    mode: "incremental",
    startedAt,
    finishedAt,
    status,
    beforeRevisions: revisions,
    afterRevisions: revisions,
    aggregateWorkRequested: false,
    changedConfigDomains: [],
    vendors: vendors.map((vendor) => ({
      ...pendingVendorResult(vendor),
      status: status === "success" ? "success" : "failure",
      startedAt,
      finishedAt,
      error: status === "success" ? null : `${vendor} failed`,
    })),
    error: status === "success" ? null : "Selected sync failed",
  } as SyncRunResult;
}

function expectSelectedScope(run: SyncRunResult | null, status: SyncRunStatus): void {
  expect(run).not.toBeNull();
  expect(run!.status).toBe(status);
  expect(run!.scope).toEqual({kind:"vendors",vendors:["claude","gemini"]});
  expect(run!.scope.kind).not.toBe("all");
  expect(run!.vendors.map((item) => item.vendor)).toEqual(["claude","gemini"]);
}

test("account selectors survive a database reopen and missing result JSON without widening scope", () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  let sqlite = new Database(fixture.dbPath);
  const accounts = [{vendor:"claude" as const,account:"historical-a"}, {vendor:"gemini" as const,account:"b:|ą"}];
  const run = result("account-success", "success", ["claude","gemini"]);
  run.scope = {kind:"accounts",accounts};
  try {
    expect(new SyncStore(sqlite).claimRun(run).claimed).toBe(true);
    expect(sqlite.query("SELECT scope,vendor FROM sync_runs WHERE run_id=?").get(run.runId))
      .toEqual({scope:"accounts",vendor:JSON.stringify(accounts)});
    sqlite.close(true);
    sqlite = new Database(fixture.dbPath);
    const store = new SyncStore(sqlite);
    expect(store.runById(run.runId)?.scope).toEqual(run.scope);
    for (const savedJson of [null,"{"]) {
      sqlite.query("UPDATE sync_runs SET result_json=? WHERE run_id=?").run(savedJson,run.runId);
      expect(store.runById(run.runId)?.scope).toEqual(run.scope);
      expect(store.runById(run.runId)?.vendors.map(item=>item.vendor)).toEqual(["claude","gemini"]);
    }
    for (const invalid of [[],["claude"],[{vendor:"claude",account:""}],[...accounts,accounts[0]]]) {
      sqlite.query("UPDATE sync_runs SET vendor=? WHERE run_id=?").run(JSON.stringify(invalid),run.runId);
      expect(()=>store.runById(run.runId)).toThrow();
    }
  } finally {
    sqlite.close(true);
  }
});

test("public readers recover successful and failed multi-vendor runs from relational selectors", () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  const sqlite = new Database(fixture.dbPath);
  try {
    const store = new SyncStore(sqlite);
    const successful = result("selected-success", "success", ["claude","gemini"]);
    const failed = result("selected-failure", "failure", ["claude","gemini"]);
    expect(store.claimRun(successful)).toEqual({run:successful,claimed:true});
    expect(store.claimRun(failed)).toEqual({run:failed,claimed:true});
    expectSelectedScope(store.runById(successful.runId), "success");
    expectSelectedScope(store.runById(failed.runId), "failure");

    expect(sqlite.query("SELECT scope,vendor FROM sync_runs WHERE run_id=?").get(successful.runId)).toEqual({
      scope:"vendors",vendor:JSON.stringify(["claude","gemini"]),
    });
    expect(sqlite.query("SELECT scope,vendor FROM sync_runs WHERE run_id=?").get(failed.runId)).toEqual({
      scope:"vendors",vendor:JSON.stringify(["claude","gemini"]),
    });

    sqlite.query("UPDATE sync_runs SET result_json=NULL WHERE run_id=?").run(successful.runId);
    sqlite.query("UPDATE sync_runs SET result_json='{' WHERE run_id=?").run(failed.runId);
    expectSelectedScope(store.runById(successful.runId), "success");
    expectSelectedScope(store.runById(failed.runId), "failure");

    sqlite.query("UPDATE sync_runs SET vendor=?,result_json=NULL WHERE run_id=?")
      .run(JSON.stringify(["claude","unknown"]), failed.runId);
    expect(() => store.runById(failed.runId)).toThrow();
  } finally {
    sqlite.close(true);
  }
});
