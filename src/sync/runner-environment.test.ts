import { afterAll, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";
import { resolveArchiveRootFromEnv } from "../config/paths";
import { createTestDatabase, emptyAccountsDocument } from "./test-support";
import type { SyncRunResult } from "./contracts";
import { ensureArchiveIdentity } from "./archive-inventory";

const createdDirectories: string[] = [];

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

function comparablePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

afterAll(() => {
  const tempRoot = path.resolve(os.tmpdir());
  for (const directory of createdDirectories) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith("tokenatlas-sync-test-")) continue;
    try {
      removeTestFixture(resolved, { recursive: true, force: true });
    } catch {
      // Bun can retain a Windows SQLite handle until process teardown.
    }
  }
});

test("the real runner receives the parent's resolved roots and tolerates existing mirror directories", async () => {
  const created = createTestDatabase();
  createdDirectories.push(created.directory);
  const sqlite = new Database(created.dbPath);
  try {
    sqlite.exec(`
      CREATE TABLE files (
        home TEXT, path TEXT, size INTEGER, mtime REAL, events INTEGER,
        PRIMARY KEY (home, path)
      );
      CREATE TABLE events (
        home TEXT, path TEXT, ts TEXT, surface TEXT, nested TEXT,
        model TEXT, effort TEXT, project TEXT, in_tok INTEGER,
        cached_in INTEGER, cache_write INTEGER, out_tok INTEGER,
        reasoning_out INTEGER, cwd TEXT, project_id TEXT
      );
      CREATE TABLE ratelimit (
        home TEXT, path TEXT, ts TEXT, window_minutes INTEGER,
        used_percent REAL, resets_at INTEGER, plan_type TEXT,
        limit_id TEXT, limit_name TEXT
      );
    `);
  } finally {
    sqlite.close();
  }
  const home = path.join(created.directory, "profiles", "user");
  const session = path.join(home, ".codex", "sessions", "2026", "08", "31", "rollout-env-test.jsonl");
  const archiveSessionDirectory = path.join(
    created.directory,
    "archive",
    "codex",
    "FIXTURE-user",
    "sessions",
    "2026",
    "08",
    "31"
  );
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.mkdirSync(archiveSessionDirectory, { recursive: true });
  ensureArchiveIdentity(path.join(created.directory,"archive"));
  fs.mkdirSync(path.join(created.directory, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(created.directory, "config", "accounts.json"),
    JSON.stringify(emptyAccountsDocument()),
    "utf8"
  );
  fs.writeFileSync(
    session,
    [
      JSON.stringify({
        timestamp: "2026-08-31T10:00:00.000Z",
        type: "session_meta",
        payload: { cwd: process.cwd(), originator: "codex_cli_rs", source: "cli" },
      }),
      JSON.stringify({
        timestamp: "2026-08-31T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 11,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 0,
            },
          },
        },
      }),
    ].join("\n") + "\n",
    "utf8"
  );

  const child = Bun.spawn({
    cmd: [
      process.execPath,
      path.join(import.meta.dir, "runner-environment-fixture.ts"),
      created.directory,
      created.dbPath,
      path.resolve(import.meta.dir, "../.."),
    ],
    cwd: process.cwd(),
    env: { ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null)
    ), TOKENATLAS_LOCAL_STATE:path.join(created.directory,"local-state"), LOCALAPPDATA:path.join(home,"AppData","Local") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr || stdout).toBe(0);
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith("RUNNER_ENV_RESULT:"));
  expect(resultLine).toBeDefined();
  const result = JSON.parse(resultLine!.slice("RUNNER_ENV_RESULT:".length)) as SyncRunResult;
  expect(result.status, JSON.stringify(result)).toBe("success");
  expect(result.vendors[0]).toMatchObject({ vendor: "codex", status: "success" });
  expect(fs.existsSync(path.join(archiveSessionDirectory, path.basename(session)))).toBe(true);
  const pathReferences = collectStrings(result).filter((value) => path.isAbsolute(value) || /[a-z]:[\\/]/i.test(value));
  const fixtureRoot = comparablePath(path.resolve(created.directory));
  expect(pathReferences.length).toBeGreaterThan(0);
  expect(pathReferences.every((value) => comparablePath(value).includes(fixtureRoot))).toBe(true);

  const realArchiveRoot = comparablePath(resolveArchiveRootFromEnv(process.env));
  const realHomeRoot = comparablePath(path.resolve(process.env.USERPROFILE || os.homedir()));
  const outsideFixtureAtRealRoots = pathReferences.filter((value) => {
    const comparable = comparablePath(value);
    return (
      (comparable.includes(realArchiveRoot) || comparable.includes(realHomeRoot)) &&
      !comparable.includes(fixtureRoot)
    );
  });
  expect(outsideFixtureAtRealRoots).toEqual([]);
}, 30_000);
