import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../db/sqlite";
import { pinCanonicalArchiveRoot } from "./archive-paths";
import { advanceArchiveRelocation, startArchiveRelocation } from "../sync/archive-relocation";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function accountsDocument() {
  return {
    version: 2,
    subscriptions: [
      { id: "codex-fixture", vendor: "codex", account: "codex-fixture" },
      { id: "claude-fixture", vendor: "claude", account: "claude-fixture" },
      { id: "gemini-fixture", vendor: "gemini", account: "gemini-fixture" },
    ],
    sources: [
      { vendor: "codex", machine: "fixture-machine", login: "fixture-login", home: "${ARCHIVE}/codex/fixture", source_home: "codex/fixture" },
      { vendor: "claude", machine: "fixture-machine", login: "fixture-login", home: "${ARCHIVE}/claude/fixture", source_home: "claude/fixture" },
      { vendor: "gemini", machine: "fixture-machine", login: "fixture-login", home: "${ARCHIVE}/gemini/fixture", source_home: "gemini/fixture" },
    ],
  };
}

async function run(command: string[], env: Record<string, string>): Promise<any> {
  const proc = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exit, stderr).toBe(0);
  const line = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).at(-1);
  return line ? JSON.parse(line) : null;
}

test("fresh processes reuse Claude, Gemini and Codex identities after physical archive relocation", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-relocation-restart-"));
  temporary.push(base);
  const original = path.join(base, "original");
  const moved = path.join(base, "moved");
  const localState = path.join(base, "local-state");
  const dbPath = path.join(base, "atlas.sqlite");
  fs.mkdirSync(path.join(original, ".archive-inventory"), { recursive: true });
  fs.writeFileSync(path.join(original, ".archive-inventory", "identity.json"), JSON.stringify({ schema: 1, archiveId: "restart-fixture" }));
  fs.mkdirSync(path.join(original, "config"), { recursive: true });
  fs.writeFileSync(path.join(original, "config", "accounts.json"), JSON.stringify(accountsDocument()));
  fs.writeFileSync(path.join(original, "config", "rate-cards.json"), JSON.stringify({
    vendors: { google: { models: { "gemini-3-flash": { in_uncached: 0.3, in_cache_read: 0, out_total: 0 } } } },
  }));

  const claudeDir = path.join(original, "claude", "fixture", "projects");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "session.jsonl"), JSON.stringify({
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { id: "claude-call", model: "claude-test", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } },
  }) + "\n");

  const geminiDir = path.join(original, "gemini", "fixture", "conversations");
  fs.mkdirSync(geminiDir, { recursive: true });
  const gemini = new Database(path.join(geminiDir, "conversation.db"), { create: true });
  gemini.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE trajectory_metadata_blob(data BLOB)");
  gemini.query("INSERT INTO gen_metadata VALUES (0, ?)").run(new Uint8Array([
    0x0a, 0x15, 0x22, 0x02, 0x10, 0x7b, 0x9a, 0x01, 0x0e,
    0x67, 0x65, 0x6d, 0x69, 0x6e, 0x69, 0x2d, 0x33, 0x2d, 0x66, 0x6c, 0x61, 0x73, 0x68,
  ]));
  gemini.close();

  const codexDir = path.join(original, "codex", "fixture", "sessions", "2026", "01", "01");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "rollout-test.jsonl"), [
    { timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: { cwd: base, originator: "codex_cli_rs", thread_source: "user" } },
    { timestamp: "2026-01-01T00:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 }, total_token_usage: { input_tokens: 7, output_tokens: 2 } } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");

  pinCanonicalArchiveRoot(original);
  const worker = path.resolve(import.meta.dir, "archive-relocation-restart-worker.ts");
  const baseEnv = {
    TOKENATLAS_LOCAL_STATE: localState,
    TOKENATLAS_MACHINE: "fixture-machine",
    TOKENATLAS_LOGIN: "fixture-login",
    USERPROFILE: path.join(base, "profile"),
  };
  const originalEnv = { ...baseEnv, TOKENATLAS_ARCHIVE: original, TOKENATLAS_CONFIG: path.join(original, "config") };
  await run([process.execPath, worker, "ingest", dbPath], originalEnv);
  const firstCodex = await run([process.execPath, worker, "codex", dbPath], originalEnv);
  expect(firstCodex.processed_inputs).toBe(1);
  const before = await run([process.execPath, worker, "snapshot", dbPath], originalEnv);

  expect(before.claudeEvents).toEqual({ n: 1, tokens: 5 });
  expect(before.codexEvents).toEqual({ n: 1, tokens: 9 });
  expect(before.geminiEvents).toMatchObject({ n: 1, tokens: 123 });
  expect(before.geminiEvents.usd).toBeCloseTo(0.0000369, 12);
  expect(before.claudeFiles).toHaveLength(1);
  expect(before.geminiFiles).toHaveLength(1);
  expect(before.codexFiles).toHaveLength(1);
  const stateDirectory = path.join(base, "relocation-state");
  let relocation = startArchiveRelocation(original, moved, { stateDirectory });
  for (let step = 0; relocation.phase !== "ready-to-switch" && step < 100; step++) {
    relocation = await advanceArchiveRelocation(relocation.jobId, { stateDirectory, maxFiles: 3 });
  }
  expect(relocation.phase).toBe("ready-to-switch");
  const offline = path.join(base, "original-offline");
  // Keep all fixture evidence while making the old physical locator unavailable.
  for (const candidate of [original, offline]) expect(path.dirname(path.resolve(candidate))).toBe(path.resolve(base));
  fs.renameSync(original, offline);
  const movedEnv = { ...baseEnv, TOKENATLAS_ARCHIVE: moved, TOKENATLAS_CONFIG: path.join(original, "config") };
  const reimport = await run([process.execPath, worker, "ingest", dbPath], movedEnv);
  expect(reimport.ingested.claude).toMatchObject({ processed: 0, skipped: 1, writtenRows: 0 });
  expect(reimport.ingested.gemini).toMatchObject({ skipped: 1, generations: 0 });
  const secondCodex = await run([process.execPath, worker, "codex", dbPath], movedEnv);
  const after = await run([process.execPath, worker, "snapshot", dbPath], movedEnv);

  expect(secondCodex.processed_inputs).toBe(0);
  expect(secondCodex.written_rows).toBe(0);
  expect(after.accounts).toBe(path.join(path.resolve(moved), "config", "accounts.json"));
  expect(after.accountsDigest).toBe(before.accountsDigest);
  expect(after.claudeFiles).toEqual(before.claudeFiles);
  expect(after.geminiFiles).toEqual(before.geminiFiles);
  expect(after.codexFiles).toEqual(before.codexFiles);
  expect(after.claudeEvents).toEqual(before.claudeEvents);
  expect(after.geminiEvents).toEqual(before.geminiEvents);
  expect(after.codexEvents).toEqual(before.codexEvents);
  for (const row of [...after.claudeFiles, ...after.geminiFiles]) {
    expect(String(row.path).startsWith(path.resolve(original))).toBe(true);
    expect(String(row.path).startsWith(path.resolve(moved))).toBe(false);
  }
  for (const row of after.codexFiles) {
    expect(String(row.home).startsWith(path.resolve(original))).toBe(true);
    expect(String(row.path).startsWith(path.resolve(original))).toBe(true);
  }
}, 30000);
