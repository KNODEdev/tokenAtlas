import { Database } from "../db/sqlite";
import fs from "node:fs";
import { SyncCoordinator } from "./coordinator";
import type { NormalizedAdapterResult, VendorAdapter, VendorAdapters } from "./adapters";

function noopResult(): NormalizedAdapterResult {
  return {
    processedInputs: 0,
    skippedInputs: 1,
    writtenRows: 0,
    dirtyRange: null,
    diagnostics: {},
    validationErrors: [],
  };
}

function adapters(claude: VendorAdapter): VendorAdapters {
  const noop: VendorAdapter = async () => noopResult();
  return { codex: noop, claude, opencode: noop, grok: noop, gemini: noop, gauges: noop };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await Bun.sleep(10);
  }
}

function coordinator(
  dbPath: string,
  claude: VendorAdapter,
  afterPublishBeforeRevision?: () => void
): SyncCoordinator {
  return new SyncCoordinator({
    dbPath,
    rootDir: process.cwd(),
    adapters: adapters(claude),
    mirror: async () => ({ copied: 0, skipped: 0, warnings: [], errors: [] }),
    configFingerprint: () => "process-fixture-config",
    sourceFingerprint: (vendor) => `process-fixture-source:${vendor}`,
    prepareStage: () => {},
    refreshDerived: () => {},
    afterPublishBeforeRevision,
  });
}

async function claimProcess(args: string[]): Promise<void> {
  const [dbPath, startGate, finishGate, readyFile, resultFile] = args;
  if (!dbPath || !startGate || !finishGate || !readyFile || !resultFile) {
    throw new Error("claim fixture arguments missing");
  }
  fs.writeFileSync(readyFile, "ready");
  await waitForFile(startGate);
  const instance = coordinator(dbPath, async () => {
    await waitForFile(finishGate);
    return noopResult();
  });
  try {
    const execution = instance.enter({
      trigger: "cli",
      scope: { kind: "vendor", vendor: "claude" },
      mode: "incremental",
    });
    fs.writeFileSync(
      resultFile,
      JSON.stringify({ runId: execution.initial.runId, status: execution.initial.status })
    );
    await execution.completion;
  } finally {
    instance.close();
  }
}

async function crashProcess(dbPath: string): Promise<void> {
  const instance = coordinator(
    dbPath,
    async (context) => {
      const sqlite = new Database(context.stageDbPath);
      try {
        sqlite.exec("DELETE FROM claude_events");
        sqlite
          .query("INSERT INTO claude_events (store, call_id, ts, path) VALUES ('live', 'new-row', ?, 'new.jsonl')")
          .run("2026-08-31T12:00:00.000Z");
      } finally {
        sqlite.close();
      }
      return {
        processedInputs: 1,
        skippedInputs: 0,
        writtenRows: 1,
        dirtyRange: {
          from: "2026-08-31T12:00:00.000Z",
          to: "2026-08-31T12:00:00.000Z",
        },
        diagnostics: {},
        validationErrors: [],
      };
    },
    () => process.exit(86)
  );
  await instance.enter({
    trigger: "cli",
    scope: { kind: "vendor", vendor: "claude" },
    mode: "incremental",
  }).completion;
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "claim") await claimProcess(args);
  else if (mode === "crash" && args[0]) await crashProcess(args[0]);
  else throw new Error(`Unknown process fixture mode: ${mode ?? "<missing>"}`);
}
