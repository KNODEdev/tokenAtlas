import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import os from "node:os";
import path from "node:path";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    try {
      removeTestFixture(directory, { recursive: true, force: true });
    } catch {
      // Windows can retain a SQLite handle until process teardown.
    }
  }
});

test("shared config watcher publishes project remaps and derived facts before its terminal result", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-config-watch-"));
  directories.push(directory);
  const configRoot = path.join(directory, "config");
  const archiveRoot = path.join(directory, "archive");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configRoot, "accounts.json"),
    JSON.stringify({ version: 2, subscriptions: [{ id: "claude-old", vendor: "claude" }],
      sources: [{ vendor: "claude", home: path.join(archiveRoot, "claude", "fixture") }] })
  );
  fs.writeFileSync(
    path.join(configRoot, "projects.json"),
    JSON.stringify({ projects: [{ id: "alpha", name: "Alpha", matches: [{ cwd: "C:/work/alpha" }] }] })
  );
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "config-watcher-fixture.ts")],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      TOKENATLAS_CONFIG: configRoot,
      TOKENATLAS_ARCHIVE: archiveRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  expect(exitCode, stderr || stdout).toBe(0);
  const line = stdout.split(/\r?\n/).filter(Boolean).at(-1)!;
  const proof = JSON.parse(line) as Record<string, unknown>;
  expect(proof).toMatchObject({
    initialCalls: 1,
    configOnlyCalls: 1,
    configOnlyDomains: ["projects"],
    configOnlyVendors: 0,
    configPlusDataCalls: 2,
    configPlusDataDomains: ["projects"],
    configPlusDataChanged: ["claude"],
    accountsOnlyDomains: ["accounts"],
    accountsOnlyVendors: 0,
    accountsOnlyServedCalls: 0,
    accountsOnlyRawCalls: 0,
    declaredServedCalls: 2,
  });
  expect(proof.configOnlyDerived).toBeNumber();
  expect(proof.configPlusDataDerived).toBeGreaterThan(proof.configOnlyDerived as number);
  expect(proof.configPlusDataConfigRevision).toBeGreaterThan(proof.configOnlyConfigRevision as number);
  // Neither the era edit nor the declared period rebuilds derived facts.
  expect(proof.accountsOnlyDerived).toBe(proof.configPlusDataDerived);
  expect(proof.declaredDerived).toBe(proof.configPlusDataDerived);
  expect(proof.accountsOnlyConfigRevision).toBeGreaterThan(proof.configPlusDataConfigRevision as number);
}, 25_000);
