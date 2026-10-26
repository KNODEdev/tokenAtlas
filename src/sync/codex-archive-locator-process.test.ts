import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTestDatabase } from "./test-support";

const temporary: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of temporary.splice(0))
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function child(command: string[], env: Record<string, string>, timeout = 120_000): Promise<string> {
  const handle = Bun.spawn({ cmd: [command[0]!, "--no-env-file", ...command.slice(1)], cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    handle.kill();
  }, timeout);
  const [exit, stdout, stderr] = await Promise.all([
    handle.exited,
    new Response(handle.stdout).text(),
    new Response(handle.stderr).text(),
  ]).finally(() => clearTimeout(watchdog));
  if (timedOut) throw new Error(`child timed out after ${timeout}ms`);
  if (exit !== 0) throw new Error(`child exited ${exit}: ${stderr}`);
  return stdout;
}

function isolatedEnvironment(base: string, localState: string): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of ["TOKENATLAS_ARCHIVE", "TOKENATLAS_CONFIG", "CODEX_HOME", "OneDrive", "ONEDRIVE", "TOKENATLAS_ARCHIVE_LOGICAL_ROOT"])
    delete env[key];
  env.TOKENATLAS_LOCAL_STATE = localState;
  env.TOKENATLAS_MACHINE = "locator-fixture-machine";
  env.TOKENATLAS_LOGIN = "locator-fixture-login";
  env.USERPROFILE = path.join(base, "absent-userprofile");
  env.OneDrive = path.join(base, "absent-onedrive");
  env.ONEDRIVE = path.join(base, "absent-onedrive-uppercase");
  return env;
}

function writeWorker(file: string): void {
  const adapters = pathToFileURL(path.join(import.meta.dir, "adapters.ts")).href;
  const inventory = pathToFileURL(path.join(import.meta.dir, "archive-inventory.ts")).href;
  const writers = pathToFileURL(path.join(import.meta.dir, "archive-writers.ts")).href;
  const relocation = pathToFileURL(path.join(import.meta.dir, "archive-relocation.ts")).href;
  fs.writeFileSync(file, `
    const action = process.argv[2]!;
    if (action === "relocate") {
      const { ensureArchiveIdentity } = await import(${JSON.stringify(inventory)});
      const { initializeArchiveWriterIdentity } = await import(${JSON.stringify(writers)});
      initializeArchiveWriterIdentity();
      const { startArchiveRelocation, advanceArchiveRelocation, activateArchiveRelocation } = await import(${JSON.stringify(relocation)});
      const original = process.argv[3]!;
      const moved = process.argv[4]!;
      const stateDirectory = process.argv[5]!;
      ensureArchiveIdentity(original);
      let state = startArchiveRelocation(original, moved, { stateDirectory });
      for (let step = 0; state.phase !== "ready-to-switch" && step < 100; step++)
        state = await advanceArchiveRelocation(state.jobId, { stateDirectory, maxFiles: 3 });
      if (state.phase !== "ready-to-switch") throw new Error("relocation did not become ready-to-switch");
      state = await activateArchiveRelocation(state.jobId, { stateDirectory, database: process.argv[6]!, env: process.env });
      console.log(JSON.stringify(state));
    } else if (action === "sync") {
      const { createProductionAdapters } = await import(${JSON.stringify(adapters)});
      const dbPath = process.argv[3]!;
      const result = await createProductionAdapters().codex({
        activeDbPath: dbPath,
        stageDbPath: dbPath,
        mode: "incremental",
        rootDir: process.cwd(),
      });
      console.log(JSON.stringify(result));
    } else {
      throw new Error("unknown action: " + action);
    }
  `);
}

function databaseState(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      events: db.query(`SELECT home,path,ts,in_tok,out_tok FROM events ORDER BY home,path,ts`).all(),
      files: db.query(`SELECT home,path,size,mtime,offset,events,parser_state FROM files ORDER BY home,path`).all(),
    };
  } finally {
    db.close(true);
  }
}

test("real Codex adapter follows the selected local archive after relocation and keeps logical paths stable", async () => {
  const created = createTestDatabase();
  const base = created.directory;
  temporary.push(base);
  const original = path.join(base, "archive-a");
  const moved = path.join(base, "archive-b");
  const offline = path.join(base, "archive-a-offline");
  const localState = path.join(base, "local-state");
  const relocationState = path.join(base, "relocation-state");
  const dbPath = created.dbPath;
  const worker = path.join(base, "worker.ts");

  fs.mkdirSync(path.join(original, "config"), { recursive: true });
  fs.writeFileSync(path.join(original, "config", "accounts.json"), JSON.stringify({ version: 2,
    subscriptions: [{ id: "codex-locator-fixture", vendor: "codex" }],
    sources: [{ vendor: "codex", home: "${ARCHIVE}/codex/fixture" }],
  }));
  fs.writeFileSync(path.join(original, "config", "projects.json"), JSON.stringify({ projects: [] }));
  fs.writeFileSync(path.join(original, "config", "rate-cards.json"), JSON.stringify({ vendors: {} }));

  const logicalHome = path.join(path.resolve(original), "codex", "fixture");
  const logicalRollout = path.join(logicalHome, "sessions", "2026", "01", "01", "rollout-fixture.jsonl");
  const physicalRollout = path.join(original, "codex", "fixture", "sessions", "2026", "01", "01", "rollout-fixture.jsonl");
  fs.mkdirSync(path.dirname(physicalRollout), { recursive: true });
  fs.writeFileSync(physicalRollout, [
    { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: base, originator: "codex_cli_rs", thread_source: "user" } },
    { timestamp: "2026-01-01T00:00:01.000Z", type: "turn_context", payload: { cwd: base, model: "gpt-test", effort: "high" } },
    { timestamp: "2026-01-01T00:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 9 }, total_token_usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 9 }, model_context_window: 200000 } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");

  writeWorker(worker);
  const env = isolatedEnvironment(base, localState);
  await child([process.execPath, worker, "relocate", original, moved, relocationState, dbPath], env);
  expect(fs.existsSync(path.join(localState, "archive-location.sqlite"))).toBe(true);
  expect(fs.existsSync(path.join(moved, ".archive-inventory", "path-binding.json"))).toBe(true);

  fs.renameSync(original, offline);
  expect(fs.existsSync(original)).toBe(false);
  expect(fs.existsSync(path.join(moved, "codex", "fixture", "sessions", "2026", "01", "01", "rollout-fixture.jsonl"))).toBe(true);

  const first = JSON.parse(await child([process.execPath, worker, "sync", dbPath], env));
  expect(first).toMatchObject({ processedInputs: 1, skippedInputs: 0 });

  const firstState = databaseState(dbPath) as {
    events: Array<{ home: string; path: string; in_tok: number; out_tok: number }>;
    files: Array<{ home: string; path: string }>;
  };
  expect(firstState.events).toHaveLength(1);
  expect(firstState.events[0]).toMatchObject({
    home: logicalHome,
    path: logicalRollout,
    in_tok: 7,
    out_tok: 2,
  });
  expect(firstState.events[0]!.in_tok + firstState.events[0]!.out_tok).toBe(9);
  expect(firstState.files).toHaveLength(1);
  expect(firstState.files[0]).toMatchObject({ home: logicalHome, path: logicalRollout });
  expect(firstState.files[0]!.home.startsWith(path.resolve(moved))).toBe(false);
  expect(firstState.files[0]!.path.startsWith(path.resolve(moved))).toBe(false);

  const second = JSON.parse(await child([process.execPath, worker, "sync", dbPath], env));
  expect(second).toMatchObject({ processedInputs: 0, writtenRows: 0 });
  expect(databaseState(dbPath)).toEqual(firstState);
  const movedRollout = path.join(moved, path.relative(original, physicalRollout));
  fs.writeFileSync(`${movedRollout}.zst`, Bun.zstdCompressSync(fs.readFileSync(movedRollout), { level: 3 }));
  fs.unlinkSync(movedRollout);
  const compressed = JSON.parse(await child([process.execPath, worker, "sync", dbPath], env));
  expect(compressed).toMatchObject({ processedInputs: 1, retryRequired: false });
  const compressedState = databaseState(dbPath) as typeof firstState;
  expect(compressedState.events).toEqual(firstState.events);
  expect(compressedState.files).toHaveLength(1);
  expect(compressedState.files[0]).toMatchObject({ home: logicalHome, path: logicalRollout });
  const compressedRestart = JSON.parse(await child([process.execPath, worker, "sync", dbPath], env));
  expect(compressedRestart).toMatchObject({ processedInputs: 0, writtenRows: 0 });
  expect(databaseState(dbPath)).toEqual(compressedState);
}, 180_000);
