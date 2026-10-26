import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

test("BAT and CLI use the coordinator while the server crosses a sync subprocess boundary", () => {
  const root = path.resolve(import.meta.dir, "../..");
  const batch = fs.readFileSync(path.join(root, "_sync.bat"), "utf8");
  const cli = fs.readFileSync(path.join(root, "src", "sync", "cli.ts"), "utf8");
  const server = fs.readFileSync(path.join(root, "src", "server", "server-sync.ts"), "utf8");
  const runner = fs.readFileSync(path.join(root, "src", "sync", "runner.ts"), "utf8");

  expect(batch).toContain("bun run sync");
  expect(batch).not.toContain("ingest:claude");
  expect(batch).not.toContain("codex_usage_report.py");
  expect(cli).toContain("enterSyncPipeline(");
  expect(server).toContain("Bun.spawn(");
  expect(server).toContain("src\", \"sync\", \"runner.ts");
  expect(runner).toContain("coordinator.enter(");
});
