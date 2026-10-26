import { describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import type { SyncRunResult } from "../sync/contracts";
import { startSync, syncPhaseFromLine, type AppContext } from "./api";
import { progressDirectory, readProgress } from "../sync/progress";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("syncPhaseFromLine", () => {
  test("refreshes current account readings before starting the history worker", async () => {
    const sqlite = new Database(":memory:");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ta-readings-progress-")), dbPath = path.join(directory, "atlas.sqlite");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const context = { sqlite, dbPath,
      refreshLiveReadings: async (vendor, progress) => {
        expect(vendor).toBe("claude");
        order.push("readings");
        progress?.(0, 1);
        await gate;
        progress?.(1, 1);
      },
      syncRunner: async () => { order.push("history"); throw new Error("fixture completion"); },
    } satisfies Partial<AppContext>;
    const state = startSync(process.cwd(), "manual", "incremental", context as unknown as AppContext, "claude");
    try {
      await Bun.sleep(0);
      expect(order).toEqual(["readings"]);
      expect(state.run?.progress).toMatchObject({ phase: "readings" });
      // The counter is in the progress register, under the run's scope.
      expect(readProgress(progressDirectory(dbPath)).map(({ scope, step, done, total }) => ({ scope, step, done, total })))
        .toEqual([{ scope: "sync", step: "readings", done: 0, total: 1 }]);
      release();
      for (let i = 0; i < 20 && state.running; i++) await Bun.sleep(0);
      expect(order).toEqual(["readings", "history"]);
      expect(state.running).toBe(false);
      expect(readProgress(progressDirectory(dbPath))).toEqual([]);
    } finally { release(); sqlite.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test("maps every _sync.bat stage to the honest eight-stage UI sequence", () => {
    const lines = [
      "[1/4] Mirroring live sources into the archive (additive, never deletes)...",
      "[2/4] Ingesting Codex rollouts (from the archive)...",
      "[3/4] Ingesting Claude Code transcripts (from the archive)...",
      "[3b/4] Ingesting opencode usage (from archive snapshots)...",
      "[3c/4] Ingesting grok turns (from the archive)...",
      "[3d/4] Ingesting Antigravity generations (protobuf; halts if the field layout changed)...",
      "[3e/4] Mapping events to projects (projects.json -> project_id)...",
      "[4/4] Verifying database...",
    ];

    expect(lines.map(syncPhaseFromLine)).toEqual([
      { index: 1, label: "Kopiuję lokalne źródła do archiwum" },
      { index: 2, label: "Indeksuję historię Codex" },
      { index: 3, label: "Indeksuję transkrypty Claude Code" },
      { index: 4, label: "Indeksuję użycie OpenCode" },
      { index: 5, label: "Indeksuję wywołania Grok" },
      { index: 6, label: "Indeksuję generacje Antigravity" },
      { index: 7, label: "Mapuję zdarzenia do projektów" },
      { index: 8, label: "Weryfikuję bazę" },
    ]);
  });

  test("ignores ordinary file and summary lines", () => {
    expect(syncPhaseFromLine("  - C:\\Users\\sample_a\\.codex\\sessions")).toBeNull();
    expect(syncPhaseFromLine("[OK] Archive refreshed.")).toBeNull();
  });

  test("a rejected worker completion cannot leave server sync state running", async () => {
    const sqlite = new Database(":memory:");
    const context = {
      sqlite,
      dbPath: "unused.sqlite",
      syncRunner: () => Promise.reject(new Error("durable finalizer unavailable")),
    } as unknown as AppContext;

    const state = startSync(process.cwd(), "manual", "incremental", context, "claude");
    expect(state.running).toBe(true);
    await Bun.sleep(0);
    expect(state.running).toBe(false);
    expect(state.ok).toBe(false);
    expect(state.exit_code).toBe(1);
    expect(state.log_tail.at(-1)).toContain("durable finalizer unavailable");
    sqlite.close();
  });

  test("a failed config publication leaves the parent configuration untouched", async () => {
    const sqlite = new Database(":memory:");
    const originalAccounts = { version: 2 as const, subscriptions: [{ id: "before", vendor: "claude" }],
      sources: [{ vendor: "claude", home: "H:/before" }] };
    const revisions = {
      data: 0,
      config: 0,
      vendors: { codex: 0, claude: 0, opencode: 0, grok: 0, gemini: 0, gauges: 0 },
    };
    const failed: SyncRunResult = {
      runId: "failed-accounts-publication",
      trigger: "auto",
      scope: { kind: "all" },
      mode: "incremental",
      startedAt: "2026-09-01T12:00:00.000Z",
      finishedAt: "2026-09-01T12:00:01.000Z",
      status: "failure",
      beforeRevisions: revisions,
      afterRevisions: revisions,
      changedConfigDomains: ["accounts"],
      aggregateWorkRequested: true,
      vendors: [],
      error: "era restamp failed",
    };
    const context = {
      sqlite,
      dbPath: "unused.sqlite",
      accounts: originalAccounts,
      syncRunner: async () => failed,
    } as unknown as AppContext;

    const state = startSync(process.cwd(), "auto", "incremental", context);
    for (let attempt = 0; attempt < 20 && state.running; attempt += 1) await Bun.sleep(0);
    expect(state.running).toBe(false);
    expect(context.accounts).toBe(originalAccounts);
    sqlite.close();
  });
});
