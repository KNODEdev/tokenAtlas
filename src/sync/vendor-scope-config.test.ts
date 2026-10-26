import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import { CONFIG_DOMAINS, type ConfigDomain } from "./contracts";
import { SyncCoordinator } from "./coordinator";
import { adaptersWith, createTestDatabase, noMirror, successfulNoop } from "./test-support";

for (const domain of ["accounts", "projects"] as const) {
  test(`selected reset refuses an unacknowledged ${domain} change before starting source work`, async () => {
    const { directory, dbPath } = createTestDatabase();
    let version = 1, reads = 0, derived = 0;
    const domains = Object.fromEntries(CONFIG_DOMAINS.map(name => [name, "v1"])) as Record<ConfigDomain, string>;
    const coordinator = new SyncCoordinator({
      dbPath, rootDir: process.cwd(), mirror: noMirror,
      configFingerprints: () => ({ fingerprint: String(version), domains: { ...domains } }),
      sourceFingerprint: vendor => vendor,
      adapters: adaptersWith({ claude: async () => { reads++; return successfulNoop(); } }),
      prepareStage: () => {}, refreshDerived: () => { derived++; },
    });
    const db = new Database(dbPath);
    try {
      expect((await coordinator.enter({ trigger: "manual", scope: { kind: "all" }, mode: "incremental" }).completion).status).toBe("success");
      const before = {
        reads, derived,
        revisions: db.query("SELECT * FROM sync_revisions").all(),
        runs: db.query("SELECT COUNT(*) AS n FROM sync_runs").get(),
      };
      version++; domains[domain] = "v2";
      expect(() => coordinator.enter({
        trigger: "manual", scope: { kind: "vendors", vendors: ["claude"] },
        mode: "incremental", reparse: {}, rebuildGeneration: 101,
      })).toThrow("selected vendors were not expanded");
      expect({ reads, derived,
        revisions: db.query("SELECT * FROM sync_revisions").all(),
        runs: db.query("SELECT COUNT(*) AS n FROM sync_runs").get(),
      }).toEqual(before);
      // A regular sync can acknowledge the configuration before the scoped repair.
      expect((await coordinator.enter({ trigger: "manual", scope: { kind: "all" }, mode: "incremental" }).completion).status).toBe("success");
      const repaired = await coordinator.enter({
        trigger: "manual", scope: { kind: "vendors", vendors: ["claude"] },
        mode: "incremental", reparse: {}, rebuildGeneration: 101,
      }).completion;
      expect(repaired.status).toBe("success");
      expect(repaired.vendors.map(row => row.vendor)).toEqual(["claude"]);
    } finally {
      coordinator.close(); db.close(true); Bun.gc(true);
      removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
