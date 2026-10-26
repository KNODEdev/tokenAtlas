import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { ingestGaugesAsync } from "../ingest/gauges";
import { createTestDatabase, emptyAccountsDocument } from "./test-support";

for (const change of ["append", "truncate"] as const) {
  test(`a gauge rebuild retains accepted progress after an archive journal ${change} across rebuild, reopen and ordinary sync`, async () => {
    const { directory, dbPath } = createTestDatabase();
    try {
      const archiveRoot = path.join(directory, "archive"), config = path.join(directory, "config");
      const journal = path.join(archiveRoot, "gauges", "fixture-pc", "probe_windows.jsonl");
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.mkdirSync(config);
      fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify(emptyAccountsDocument()));
      fs.writeFileSync(path.join(config, "projects.json"), JSON.stringify({ projects: [] }));
      fs.writeFileSync(path.join(config, "rate-cards.json"), JSON.stringify({ vendors: {} }));
      const row = (ts: string, used: number) => JSON.stringify({ provider: "codex", subject: "fixture-account", ts,
        kind: "primary", limit_group: "codex", reported_percent_side: "used", used_percent: used,
        window_minutes: 300, machine: "fixture-pc", login: "fixture", raw_subject: "fixture-account", ok: 1 }) + "\n";
      const first = row("2026-09-01T10:00:00Z", 20), second = row("2026-09-01T10:01:00Z", 35);
      fs.writeFileSync(journal, change === "append" ? first : first + second);
      const ingest = async () => (await ingestGaugesAsync({ atlasPath: dbPath, archiveRoot, ownStore: "receiver", force: false }));
      (await ingest());
      // The archive journal changes after the first reading; the ordinary ingest accepts both readings.
      const changedContent = change === "append" ? first + second : first;
      fs.writeFileSync(journal, changedContent);
      (await ingest());
      const request = { trigger: "manual", scope: { kind: "vendor", vendor: "gauges" }, mode: "incremental",
        reparse: {}, rebuildGeneration: 77, collection: "archive" } as const;
      const snapshot = () => {
        const db = new Database(dbPath, { readonly: true });
        try {
          return { facts: db.query("SELECT ts,used_percent FROM probe_windows ORDER BY ts").all(),
            counters: db.query("SELECT * FROM probe_counters ORDER BY id").all(),
            bookmark: db.query("SELECT * FROM gauge_files ORDER BY store,path").all() };
        } finally { db.close(true); }
      };
      const accepted = snapshot();
      expect(accepted.counters).toHaveLength(2);
      expect(accepted.facts).toEqual([{ ts: "2026-09-01T10:00:00Z", used_percent: 20 },
        { ts: "2026-09-01T10:01:00Z", used_percent: 35 }]);
      const rebuild = async () => {
        const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "runner.ts"),
          JSON.stringify({ dbPath, rootDir: process.cwd(), request })], {
          env: { ...process.env, TOKENATLAS_ARCHIVE: archiveRoot, TOKENATLAS_CONFIG: config,
            TOKENATLAS_LOCAL_STATE: path.join(directory, "local"), USERPROFILE: path.join(directory, "absent-user"),
            HOME:path.join(directory,"absent-user"), APPDATA:path.join(directory,"absent-appdata"), LOCALAPPDATA:path.join(directory,"absent-localappdata") },
          stdout: "pipe", stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 30_000);
        const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
          .finally(() => clearTimeout(timeout));
        expect({ exit, err }).toEqual({ exit: 0, err: "" });
        const line = out.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
        expect(line).toBeDefined();
        const result = JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length));
        expect({ status: result.status, error: result.error }).toEqual({ status: "success", error: null });
        expect(result.vendors.find((vendor: { vendor: string }) => vendor.vendor === "gauges")).toMatchObject({
          status: "success", processedInputs: 1,
        });
      };
      await rebuild();
      expect(snapshot()).toEqual(accepted);
      await rebuild();
      expect(snapshot()).toEqual(accepted);
      // A finished import must stay finished; no replay of an already accepted file prefix.
      expect((await ingest())).toMatchObject({ files: 1, skipped: 1, rows: 0, malformed: 0 });
      expect(snapshot()).toEqual(accepted);
    } finally {
      Bun.gc(true);
      removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60_000);
}
