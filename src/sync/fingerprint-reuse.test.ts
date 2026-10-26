import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import { SyncCoordinator, enterSyncPipeline } from "./coordinator";
import { adaptersWith, createTestDatabase } from "./test-support";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      removeTestFixture(directory, { recursive: true, force: true });
    } catch {
      // Bun can retain a Windows SQLite handle until process teardown.
    }
  }
});

describe("source fingerprint per run", () => {
  test("is computed once per vendor when the mirror copied nothing, twice when it did", async () => {
    const created = createTestDatabase();
    temporaryDirectories.push(created.directory);
    const calls: string[] = [];
    let copied = 0;
    const instance = new SyncCoordinator({ archiveInputs: () => undefined,
      dbPath: created.dbPath,
      rootDir: process.cwd(),
      adapters: adaptersWith({}),
      mirror: async () => ({ copied, skipped: 0, warnings: [], errors: [] }),
      configFingerprint: () => "fixture-config-v1",
      sourceFingerprint: (vendor) => {
        calls.push(vendor);
        return `fp:${vendor}:${copied}`;
      },
      prepareStage: () => {},
      refreshDerived: () => {},
    });
    try {
      await enterSyncPipeline(instance, { trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "full" }).completion;
      expect(calls).toEqual(["claude"]);
      calls.length = 0;
      copied = 3;
      await enterSyncPipeline(instance, { trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "full" }).completion;
      expect(calls).toEqual(["claude", "claude"]);
    } finally {
      instance.close();
    }
  });
});
