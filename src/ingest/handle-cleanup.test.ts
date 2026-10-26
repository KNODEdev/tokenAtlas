import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("ingest-owned database handles close on failures after open", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-ingest-handles-"));
  try {
    const modulePath = (relative: string) => JSON.stringify(path.resolve(import.meta.dir, relative));
    const runner = path.join(root, "handle-cleanup-runner.ts");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      runner,
      String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Database } from ${modulePath("../db/sqlite.ts")};
import { ingestClaude } from ${modulePath("./claude.ts")};
import { ingestGeminiAsync } from ${modulePath("./gemini.ts")};
import { ingestGrokAsync } from ${modulePath("./grok.ts")};
import { ingestOpencodeAsync } from ${modulePath("./opencode.ts")};

const root = ${JSON.stringify(root)};
const closeEvents: Array<{ filename: string; handle: number; database: Database }> = [];
const databasePrototype = Database.prototype as any;
const originalClose = databasePrototype.close;

function removeCase(directory: string): { removed: boolean; error: string | null } {
  let error: string | null = null;
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
  } catch (cause) {
    error = String(cause);
  }
  return { removed: !fs.existsSync(directory), error };
}

async function expectFailure(
  name: string,
  directory: string,
  expectedFiles: string[],
  run: () => unknown | Promise<unknown>,
): Promise<{ name: string; closed: Array<{ filename: string; handle: number }>; removal: { removed: boolean; error: string | null } }> {
  let thrown = false;
  try {
    await run();
  } catch {
    thrown = true;
  }
  assert.equal(thrown, true, name + " did not reject");
  const closed = expectedFiles.map((filename) => {
    const event = closeEvents.find((candidate) => candidate.filename === path.resolve(filename));
    assert.ok(event, name + " did not close " + filename);
    assert.notEqual(event.handle, 0, name + " recorded an invalid native handle for " + filename);
    assert.throws(() => event.database.query("SELECT 1"), /closed/i, name + " left a usable handle for " + filename);
    return { filename: event.filename, handle: event.handle };
  });
  const removal = removeCase(directory);
  return { name, closed, removal };
}

const claudeDirectory = path.join(root, "claude");
const geminiDirectory = path.join(root, "gemini");
const opencodeDirectory = path.join(root, "opencode");
const grokDirectory = path.join(root, "grok");
for (const directory of [claudeDirectory, geminiDirectory, opencodeDirectory, grokDirectory]) fs.mkdirSync(directory, { recursive: true });

const claudeDb = path.join(claudeDirectory, "atlas.sqlite");
const geminiDb = path.join(geminiDirectory, "atlas.sqlite");
// Schema-less databases make both importers fail after opening their handle.
new Database(claudeDb, { create: true }).close(true);
new Database(geminiDb, { create: true }).close(true);
const claudeInput = path.join(claudeDirectory, "inputs");
const geminiInput = path.join(geminiDirectory, "conversations");
fs.mkdirSync(claudeInput);
fs.mkdirSync(geminiInput);

const opencodeDb = path.join(opencodeDirectory, "atlas.sqlite");
const opencodeSnapshot = path.join(opencodeDirectory, "opencode.sqlite");
const opencodeSource = new Database(opencodeSnapshot, { create: true });
opencodeSource.exec("CREATE TABLE wrong_schema (id TEXT)");
opencodeSource.close(true);
new Database(opencodeDb, { create: true }).close(true);

const grokDb = path.join(grokDirectory, "atlas.sqlite");
const missingSource = path.join(grokDirectory, "missing.sqlite");
new Database(grokDb, { create: true }).close(true);
fs.mkdirSync(path.join(grokDirectory, "sessions"));

databasePrototype.close = function (this: Database, force?: boolean) {
  closeEvents.push({ filename: path.resolve(this.filename), handle: this.handle, database: this });
  return originalClose.call(this, force);
};

const results: Array<{ name: string; closed: Array<{ filename: string; handle: number }>; removal: { removed: boolean; error: string | null } }> = [];
try {
  results.push(await expectFailure("claude", claudeDirectory, [claudeDb], () => ingestClaude({ path: claudeInput, store: "live", dbPath: claudeDb, skipMigrations: true })));
  results.push(await expectFailure("gemini", geminiDirectory, [geminiDb], async () => await ingestGeminiAsync(geminiInput, "fixture", { archivedInput: true, atlasPath: geminiDb })));
  results.push(await expectFailure("opencode", opencodeDirectory, [opencodeDb], async () => await ingestOpencodeAsync(opencodeSnapshot, "fixture", { archivedInput: true, atlasPath: opencodeDb })));
  results.push(await expectFailure("grok", grokDirectory, [grokDb], async () => await ingestGrokAsync(path.join(grokDirectory, "sessions"), "fixture", { atlasPath: grokDb, sourceAtlasPath: missingSource })));
  console.log(JSON.stringify({ results }));
} finally {
  databasePrototype.close = originalClose;
}
`,
      "utf8",
    );

    const child = Bun.spawnSync([process.execPath, runner], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        TOKENATLAS_CONFIG: path.join(root, "config"),
        TOKENATLAS_ARCHIVE: path.join(root, "archive"),
        TOKENATLAS_LOCAL_STATE: path.join(root, "local"),
        TOKENATLAS_FROZEN_CONFIG: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    expect(child.exitCode, stdout + stderr).toBe(0);
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(report.results.map((result: { name: string }) => result.name)).toEqual(["claude", "gemini", "opencode", "grok"]);
    expect(report.results.every((result: { closed: Array<{ filename: string; handle: number }> }) => result.closed.length > 0)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 10 });
  }
});
