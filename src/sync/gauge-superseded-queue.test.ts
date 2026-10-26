import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createTestDatabase, emptyAccountsDocument } from "./test-support";
import { removeTestFixture } from "../test-cleanup";

for (const scenario of ["no record", "same store", "another store", "replacement not delivered yet"] as const) {
  test(`queued vanished gauge journal: ${scenario}`, async () => {
    const fixture = createTestDatabase();
    const archive = path.join(fixture.directory, "archive");
    const config = path.join(fixture.directory, "config");
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify(emptyAccountsDocument()));
    const moduleUrl = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
    const script = path.join(fixture.directory, "superseded-queue.ts");
    fs.writeFileSync(script, `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import { createHash, randomUUID } from "node:crypto";
      import { Database } from ${moduleUrl("../db/sqlite.ts")};
      import { SyncCoordinator } from ${moduleUrl("./coordinator.ts")};
      import { SyncFileQueue } from ${moduleUrl("./file-queue.ts")};
      import { syncFileRoots } from ${moduleUrl("./mirror.ts")};
      const scenario = ${JSON.stringify(scenario)};
      const archive = process.env.TOKENATLAS_ARCHIVE!, dbPath = process.env.TOKENATLAS_DB!;
      const store = path.join(archive, "gauges", "target");
      const legacy = path.join(store, "probe_windows.jsonl");
      const month = path.join(store, "probe_windows.2026-09.jsonl");
      fs.mkdirSync(store, { recursive: true });
      const line = (ts: string, used: number) => JSON.stringify({
        provider: "codex", subject: "target", ts, kind: "primary", reported_percent_side: "used",
        used_percent: used, window_minutes: 300, machine: "fixture", ok: 1,
        journal_version: 2, journal_entry_id: randomUUID(),
      }) + "\\n";
      const original = line("2026-09-01T10:00:00Z", 42);
      fs.writeFileSync(legacy, original);
      const run = async () => {
        const coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), refreshDerived: () => {} });
        try {
          return await coordinator.enter({ trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "incremental" }).completion;
        } finally { coordinator.close(); }
      };
      const queuedPaths = () => {
        const queue = new SyncFileQueue(archive);
        try { return queue.take("gauges", syncFileRoots()).map(row => row.path); }
        finally { queue.close(); }
      };
      assert.equal((await run()).status, "success");
      const db = new Database(dbPath);
      const accepted = db.query("SELECT * FROM probe_windows ORDER BY id").all();
      assert.equal(accepted.length, 1);
      if (scenario !== "no record") {
        const recordStore = scenario === "another store" ? path.join(archive, "gauges", "other") : store;
        fs.mkdirSync(recordStore, { recursive: true });
        // A cloud client may deliver the record before the month file it names.
        if (scenario !== "replacement not delivered yet") fs.writeFileSync(path.join(recordStore, path.basename(month)), original + line("2026-09-01T10:01:00Z", 43));
        fs.writeFileSync(path.join(recordStore, "journal-superseded.json"), JSON.stringify({
          [path.basename(legacy)]: { bytes: Buffer.byteLength(original), sha256: createHash("sha256").update(original).digest("hex"),
            lines: 1, into: [path.basename(month)], superseded_at: "2026-09-21T10:00:00Z" },
        }));
      }
      fs.unlinkSync(legacy);
      const queue = new SyncFileQueue(archive);
      try {
        queue.signal(legacy, syncFileRoots());
        if (scenario === "same store") queue.signal(month, syncFileRoots());
      } finally { queue.close(); }
      assert.ok(queuedPaths().includes(legacy), "the missing legacy file must enter the real queue");
      if (scenario === "same store") assert.ok(queuedPaths().includes(month));
      const result = await run();
      if (scenario === "same store") {
        assert.equal(result.status, "success", JSON.stringify(result));
        assert.equal(result.vendors.find(vendor => vendor.vendor === "gauges")?.status, "success");
        assert.deepEqual(db.query("SELECT used_percent FROM probe_windows ORDER BY ts").all(), [{ used_percent: 42 }, { used_percent: 43 }]);
        assert.deepEqual(db.query("SELECT * FROM probe_windows WHERE used_percent=42").all(), accepted);
        assert.deepEqual(queuedPaths(), [], "both the missing legacy file and ingested month must be acknowledged");
        const next = await run();
        assert.equal(next.status, "success", JSON.stringify(next));
        assert.equal(next.vendors.length, 0, "a fresh coordinator must not retry the superseded journal");
        assert.deepEqual(queuedPaths(), []);
      } else {
        assert.equal(result.status, "failure", JSON.stringify(result));
        assert.ok(JSON.stringify(result).includes("Archived source is unavailable; retained facts kept for retry"));
        assert.deepEqual(db.query("SELECT * FROM probe_windows ORDER BY id").all(), accepted);
        assert.ok(queuedPaths().includes(legacy), "unexplained disappearance must remain queued");
        const retry = await run();
        assert.equal(retry.status, "failure", JSON.stringify(retry));
        assert.ok(JSON.stringify(retry).includes("Archived source is unavailable; retained facts kept for retry"));
        assert.ok(queuedPaths().includes(legacy));
      }
      db.close();
      console.log("SUPERSEDED_QUEUE_PASS");
    `);
    try {
      const child = Bun.spawn([process.execPath, script], {
        cwd: process.cwd(), env: { ...process.env,
          TOKENATLAS_DB: fixture.dbPath, TOKENATLAS_ARCHIVE: archive, TOKENATLAS_CONFIG: config,
          TOKENATLAS_LOCAL_STATE: path.join(fixture.directory, "state"),
          USERPROFILE: path.join(fixture.directory, "missing"), HOME: path.join(fixture.directory, "missing"),
          APPDATA: path.join(fixture.directory, "missing-appdata"), LOCALAPPDATA: path.join(fixture.directory, "missing-local"),
        }, stdout: "pipe", stderr: "pipe",
      });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exit, err }).toEqual({ exit: 0, err: "" });
      expect(out).toContain("SUPERSEDED_QUEUE_PASS");
    } finally {
      removeTestFixture(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);
}
