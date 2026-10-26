import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { Database } from "../db/sqlite";
import { SyncCoordinator } from "./coordinator";
import { adaptersWith, createCodexSchema, createTestDatabase } from "./test-support";
import type { VendorId } from "./contracts";

const directories: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of directories.splice(0)) removeTestFixture(directory, { recursive: true, force: true, maxRetries:10, retryDelay:50 });
});

function writeClaudeSession(file: string, id: string, input: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "assistant", sessionId: "session", timestamp: "2026-01-01T00:00:00Z",
    message: { id, model: "claude-sonnet", usage: { input_tokens: input, output_tokens: 1 } } })}\n`);
}

test("a scoped Claude rebuild reads every archived Claude machine profile and nothing of retired aliases or other vendors", async () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  createCodexSchema(fixture.dbPath);
  const archiveRoot = path.join(fixture.directory, "archive"), config = path.join(fixture.directory, "config");
  const first = path.join(archiveRoot, "claude", "profile", "project", "session.jsonl");
  const second = path.join(archiveRoot, "claude", "second-machine", "project", "session.jsonl");
  writeClaudeSession(first, "first", 3);
  writeClaudeSession(second, "second", 5);
  // A retired alias at the archive root and another vendor's unreadable file stay outside the scope.
  writeClaudeSession(path.join(archiveRoot, "projects", "project", "session.jsonl"), "retired", 7);
  const corrupt = path.join(archiveRoot, "codex", "profile", "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, "not-json\n");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [{ id: "claude", vendor: "claude" }], sources: [] }));
  fs.writeFileSync(path.join(config, "projects.json"), '{"projects":[]}');
  fs.writeFileSync(path.join(config, "rate-cards.json"), '{"vendors":{}}');
  const request = { trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "incremental",
    reparse: {}, rebuildGeneration: 41, collection: "archive" } as const;
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "runner.ts"),
    JSON.stringify({ dbPath: fixture.dbPath, rootDir: process.cwd(), request })], {
    env: { ...process.env, TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_CONFIG: config,
      TOKENATLAS_LOCAL_STATE: path.join(fixture.directory, "local"), TOKENATLAS_TEMP_DIR: path.join(fixture.directory, "temp"),
      USERPROFILE: path.join(fixture.directory, "absent-home"), HOME: path.join(fixture.directory, "absent-home") },
    stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 60_000);
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .finally(() => clearTimeout(timeout));
  expect({ exit, err }).toEqual({ exit: 0, err: "" });
  const line = out.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
  expect(line).toBeDefined();
  const result = JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length)) as { status: string; error: string | null; vendors: Array<{ vendor: string }> };
  expect({ status: result.status, error: result.error }).toEqual({ status: "success", error: null });
  expect(result.vendors.map(vendor => vendor.vendor)).toEqual(["claude"]);
  const check = new Database(fixture.dbPath, { readonly: true });
  try {
    expect(check.query("SELECT call_id,path,in_uncached FROM claude_events ORDER BY call_id").all()).toEqual([
      { call_id: "first", path: first, in_uncached: 3 },
      { call_id: "second", path: second, in_uncached: 5 },
    ]);
  } finally { check.close(true); }
}, 90_000);

test("scoped collection before an archive rebuild visits only the selected vendors", async () => {
  const fixture = createTestDatabase();
  directories.push(fixture.directory);
  const collected: VendorId[] = [];
  const coordinator = new SyncCoordinator({ dbPath: fixture.dbPath, rootDir: fixture.directory, adapters: adaptersWith({}),
    sourceFingerprint: () => "unchanged", configFingerprint: () => "config", refreshDerived: () => {},
    mirror: async vendor => { collected.push(vendor); return { copied: 0, skipped: 0, warnings: [], errors: [] }; } });
  try {
    // A selected rebuild requires synchronized configuration first.
    expect((await coordinator.enter({ trigger: "manual", scope: { kind: "all" }, mode: "incremental" }).completion).status).toBe("success");
    collected.splice(0);
    const result = await coordinator.enter({ trigger: "manual", scope: { kind: "vendors", vendors: ["claude", "gemini"] }, mode: "incremental",
      reparse: {}, rebuildGeneration: 41, collection: "collect-archive" }).completion;
    expect({ status: result.status, error: result.error }).toEqual({ status: "success", error: null });
    expect(collected.sort()).toEqual(["claude", "gemini"]);
    expect(result.vendors.map(vendor => vendor.vendor).sort()).toEqual(["claude", "gemini"]);
  } finally { coordinator.close(); }
}, 30_000);
