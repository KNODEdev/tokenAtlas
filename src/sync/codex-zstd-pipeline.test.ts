import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("production queue, mirror and adapter preserve priced history across codec transition, restart and cloud order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-zstd-pipeline-"));
  try {
    const user = path.join(root, "profiles", "fixture"), archive = path.join(root, "archive"), config = path.join(root, "config");
    fs.mkdirSync(user, { recursive: true }); fs.mkdirSync(config); fs.writeFileSync(path.join(root, "fixture-only"), "1");
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [
      { vendor: "codex", home: path.join(archive, "codex", "PC"), source_home: path.join(user, ".codex"), machine: "fixture-pc" },
    ] }));
    const child = Bun.spawn([process.execPath, path.resolve("scripts/acceptance/codex-zstd-trial.ts")], {
      cwd: process.cwd(), env: { ...process.env, TOKENATLAS_ZSTD_TRIAL_ROOT: root, TOKENATLAS_ARCHIVE: archive, TOKENATLAS_CONFIG: config,
        TOKENATLAS_DB: path.join(root, "copy.sqlite"), TOKENATLAS_LOCAL_STATE: path.join(root, "local"), TOKENATLAS_TEMP_DIR: path.join(root, "scratch"),
        TOKENATLAS_FROZEN_CONFIG: "1", USERPROFILE: user, TOKENATLAS_MACHINE: "fixture-pc", TOKENATLAS_LOGIN: "fixture" },
      stdout: "pipe", stderr: "pipe",
    });
    const watchdog = setTimeout(() => child.kill(), 90_000);
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(watchdog); expect({ exit, stderr, stdout }).toMatchObject({ exit: 0 });
    const report = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
    expect(report.conversion).toEqual({ dataChanged: false, processed: 0, repricedApi: 0, repricedCredits: 0, aggregatePartitions: 0 });
    expect(report.restartProcessed).toBe(0); expect(report.conversationCopies).toBe(1);
    expect(report.archiveCompression).toMatchObject({ status: "complete", compressed: 1, dataChanged: false,
      processed: 0, repricedApi: 0, repricedCredits: 0, aggregatePartitions: 0, restartProcessed: 0, providerOriginalPreserved: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 100_000);
