import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Database } from "../db/sqlite";
import { installFirstTokenTracking } from "../db/first-token";
import { codexFirstTokenAdapter } from "../providers/first-token/codex";
import { ParsePool, nativeParserBinary } from "../ingest/parse-pool";
import { syncCodex } from "../ingest/codex";
import { advanceFirstTokenTimes } from "../server/first-token-producer";
import { SyncCoordinator } from "./coordinator";
import { adaptersWith, createCodexSchema, createTestDatabase, noMirror } from "./test-support";

test("ordinary native import publishes prepared TTFT through the real stage without another file read", async () => {
  const { directory, dbPath } = createTestDatabase(), home = path.join(directory, "codex", "fixture");
  const file = path.join(home, "sessions", "turn.jsonl"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    { type: "turn_context", payload: { turn_id: "t", model: "fixture-model" } },
    { type: "event_msg", timestamp: "2026-10-25T10:00:00Z", payload: { type: "task_started", turn_id: "t" } },
    { type: "event_msg", timestamp: "2026-10-25T10:00:10Z", payload: { type: "task_complete", turn_id: "t", duration_ms: 10000, time_to_first_token_ms: 1234 } },
  ];
  fs.writeFileSync(file, records.map(row => JSON.stringify(row)).join("\n") + "\n");
  createCodexSchema(dbPath);
  const db = new Database(dbPath); installFirstTokenTracking(db, codexFirstTokenAdapter);
  const pool = new ParsePool(2, { binary: process.env.TOKENATLAS_TTFT_TEST_PARSER ?? nativeParserBinary() });
  const coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), archiveInputs: () => undefined,
    mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => "native-ttft", prepareStage: () => {}, refreshDerived: () => {},
    adapters: adaptersWith({ codex: async context => {
      const stage = new Database(context.stageDbPath);
      try {
        const result = await syncCodex(stage, { homes: [home], pool });
        return { processedInputs: result.processed_inputs, skippedInputs: result.skipped_inputs, writtenRows: result.written_rows,
          dirtyRange: result.dirty_range, diagnostics: {}, validationErrors: [] };
      } finally { stage.close(); }
    } }),
  });
  try {
    const result = await coordinator.enter({ trigger: "manual", mode: "incremental", scope: { kind: "vendor", vendor: "codex" } }).completion;
    expect({ status: result.status, error: result.error, vendor: result.vendors[0]?.error }).toEqual({ status: "success", error: null, vendor: null });
    const payload = (db.query("SELECT first_token_json payload FROM codex_file_evidence").get() as { payload: string }).payload;
    expect(JSON.parse(payload).turns).toMatchObject([{ id: "t", ms: 1234 }]);
    expect(advanceFirstTokenTimes(db, { archiveRoot: directory, physicalPath: () => { throw new Error("Unexpected second file read"); } }))
      .toMatchObject({ processed: 1, pending: false, failed: 0, completed: 1 });
    expect(db.query("SELECT ms FROM response_time_turns").get()).toEqual({ ms: 1234 });
  } finally { coordinator.close(); await pool.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}, 30000);
