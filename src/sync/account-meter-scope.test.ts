import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import { parseRebuildOptions } from "../shared/analysis-rebuild";
import {
  pendingVendorResult,
  vendorsForScope,
  type SyncRunResult,
  type SyncScope,
} from "./contracts";
import { SyncStore } from "./store";
import { createTestDatabase } from "./test-support";

const accounts = [
  { vendor: "claude" as const, account: " historical-b " },
  { vendor: "codex" as const, account: "HISTORICAL-A" },
];

const canonicalAccounts = [
  { vendor: "codex" as const, account: "historical-a" },
  { vendor: "claude" as const, account: "historical-b" },
];

test("account meter opt-in is strict, canonical and does not change legacy account scopes", () => {
  expect(parseRebuildOptions({ scope: "all", accounts })).toEqual({
    scope: "all",
    mode: "archive",
    accounts: canonicalAccounts,
  });
  expect(parseRebuildOptions({ scope: "all", accounts, meters: "archive" })).toEqual({
    scope: "all",
    mode: "archive",
    accounts: canonicalAccounts,
    meters: "archive",
  });

  expect(vendorsForScope({ kind: "accounts", accounts: canonicalAccounts })).toEqual(["codex", "claude"]);
  expect(vendorsForScope({ kind: "accounts", accounts: canonicalAccounts, meters: "archive" })).toEqual([
    "codex",
    "claude",
    "gauges",
  ]);

  for (const meters of [null, false, true, "", "gauges", "Archive", 1, {}]) {
    expect(() => parseRebuildOptions({ scope: "all", accounts, meters })).toThrow();
    expect(() => vendorsForScope({
      kind: "accounts",
      accounts: canonicalAccounts,
      meters,
    } as unknown as SyncScope)).toThrow();
  }

  expect(() => parseRebuildOptions({ scope: "all", meters: "archive" })).toThrow();
  expect(() => parseRebuildOptions({ scope: "all", vendors: ["codex"], meters: "archive" })).toThrow();
  expect(() => vendorsForScope({ kind: "all", meters: "archive" } as unknown as SyncScope)).toThrow();
});

test("SyncStore preserves account meter opt-in in result JSON and relational fallback", () => {
  const fixture = createTestDatabase();
  const sqlite = new Database(fixture.dbPath);
  try {
    const store = new SyncStore(sqlite);
    const scope: SyncScope = {
      kind: "accounts",
      accounts: canonicalAccounts,
      meters: "archive",
    };
    const revisions = store.revisions();
    const run: SyncRunResult = {
      runId: "account-meter-scope",
      trigger: "manual",
      scope,
      mode: "incremental",
      startedAt: "2026-09-17T00:00:00.000Z",
      finishedAt: null,
      status: "running",
      beforeRevisions: revisions,
      afterRevisions: revisions,
      aggregateWorkRequested: false,
      vendors: vendorsForScope(scope).map(pendingVendorResult),
      error: null,
    };

    expect(store.claimRun(run).claimed).toBe(true);
    const stored = sqlite.query("SELECT vendor,result_json FROM sync_runs WHERE run_id=?")
      .get(run.runId) as { vendor: string; result_json: string };
    expect(JSON.parse(stored.vendor)).toEqual({ accounts: canonicalAccounts, meters: "archive" });
    expect((JSON.parse(stored.result_json) as SyncRunResult).scope).toEqual(scope);

    sqlite.query("UPDATE sync_runs SET result_json=NULL WHERE run_id=?").run(run.runId);
    expect(store.runById(run.runId)?.scope).toEqual(scope);
    expect(store.runById(run.runId)?.vendors.map(vendor => vendor.vendor)).toEqual(["codex", "claude", "gauges"]);

    sqlite.query("UPDATE sync_runs SET result_json=? WHERE run_id=?").run("not-json", run.runId);
    expect(store.runById(run.runId)?.scope).toEqual(scope);

    sqlite.query("UPDATE sync_runs SET result_json=NULL,vendor=? WHERE run_id=?")
      .run(JSON.stringify(canonicalAccounts), run.runId);
    expect(store.runById(run.runId)?.scope).toEqual({ kind: "accounts", accounts: canonicalAccounts });
    expect(store.runById(run.runId)?.vendors.map(vendor => vendor.vendor)).toEqual(["codex", "claude"]);

    for (const invalid of [
      { accounts: canonicalAccounts },
      { accounts: canonicalAccounts, meters: null },
      { accounts: canonicalAccounts, meters: false },
      { accounts: canonicalAccounts, meters: "gauges" },
      { accounts: canonicalAccounts, meters: "archive", extra: true },
    ]) {
      sqlite.query("UPDATE sync_runs SET result_json=NULL,vendor=? WHERE run_id=?")
        .run(JSON.stringify(invalid), run.runId);
      expect(() => store.runById(run.runId)).toThrow();
    }
  } finally {
    sqlite.close(true);
    Bun.gc(true);
    removeTestFixture(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
