import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { removeTestFixture } from "../test-cleanup";
import { SyncCoordinator, type SyncCoordinatorOptions } from "./coordinator";
import { adaptersWith, createTestDatabase, successfulNoop } from "./test-support";

test("extracted preparation and publication preserve injected callback receivers", async () => {
  const { directory, dbPath } = createTestDatabase();
  const receivers: Array<{ operation: string; receiver: unknown }> = [];
  let revision = 1;
  const adapters = adaptersWith({
    claude: async function (context) {
      receivers.push({ operation: "adapter", receiver: this });
      const stage = new Database(context.stageDbPath);
      try {
        stage.query(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached)
          VALUES('fixture','receiver','receiver.jsonl','2026-01-10T10:00:00.000Z',?)`).run(revision);
      } finally { stage.close(); }
      return { ...successfulNoop(), processedInputs: 1, writtenRows: 1 };
    },
  });
  const options: SyncCoordinatorOptions = {
    dbPath, rootDir: directory, adapters, archiveInputs: () => undefined,
    configFingerprint: () => "receiver-fixture",
    mirror: async function () {
      receivers.push({ operation: "mirror", receiver: this });
      return { copied: 1, skipped: 0, errors: [], warnings: [] };
    },
    sourceFingerprint: function () {
      receivers.push({ operation: "fingerprint", receiver: this });
      return `receiver-source-${revision}`;
    },
    prepareStage: function () { receivers.push({ operation: "stage", receiver: this }); },
    now: function () {
      receivers.push({ operation: "clock", receiver: this });
      return new Date().toISOString();
    },
    beforeIncrementalPublish: function () { receivers.push({ operation: "hook", receiver: this }); },
    refreshDerived: () => {},
  };
  const coordinator = new SyncCoordinator(options);
  try {
    for (revision = 1; revision <= 2; revision++) {
      const result = await coordinator.enter({ trigger: "manual", scope: { kind: "vendor", vendor: "claude" }, mode: "incremental" }).completion;
      expect(result.status).toBe("success");
      expect(result.vendors[0]?.dataChanged).toBe(true);
    }
    for (const operation of ["adapter", "mirror", "fingerprint", "stage", "clock", "hook"])
      expect(receivers.some(item => item.operation === operation)).toBe(true);
    for (const { operation, receiver } of receivers)
      expect(receiver).toBe(operation === "adapter" ? adapters : operation === "hook" ? options : coordinator);
  } finally {
    coordinator.close();
    Bun.gc(true);
    removeTestFixture(directory, { recursive: true, force: true });
  }
});
