import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeTestFixture } from "../test-cleanup";

test("real forced Codex adapter configures its populated stage connection without reinstalling tracking", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-adapter-stage-"));
  const module = (name: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, name)).href);
  try {
    const archive = path.join(directory, "archive"), config = path.join(directory, "config");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, "accounts.json"), JSON.stringify({ version: 2, subscriptions: [], sources: [] }));
    const worker = path.join(directory, "worker.ts");
    fs.writeFileSync(worker, `
      import fs from "node:fs"; import path from "node:path";
      import { Database } from ${module("../db/sqlite.ts")};
      import { createProductionAdapters } from ${module("adapters.ts")};
      import { createTestDatabase } from ${module("test-support.ts")};
      import { ensureCodexSchema, syncCodex } from ${module("../ingest/codex.ts")};
      import { installAnalysisTracking } from ${module("../db/analysis.ts")};
      import { omitStageAnalysisTracking } from ${module("stage-tracking.ts")};
      const fixture = createTestDatabase();
      try {
        const home = path.join(process.env.TOKENATLAS_ARCHIVE!, "codex", "PC-fixture");
        const session = path.join(home, "sessions", "2026", "01", "01"); fs.mkdirSync(session, { recursive: true });
        const files = ["present", "pruned"].map(name => path.join(session, "rollout-" + name + ".jsonl"));
        for (const [index, file] of files.entries()) fs.writeFileSync(file, [
          { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { cwd: fixture.directory, originator: "codex_cli_rs", thread_source: "user" } },
          { timestamp: "2026-01-01T00:00:01Z", type: "turn_context", payload: { model: "gpt-fixture", effort: "high" } },
          { timestamp: "2026-01-01T00:01:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 7 + index, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 9 + index }, total_token_usage: { input_tokens: 7 + index, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 9 + index }, model_context_window: 200000 } } }
        ].map(row => JSON.stringify(row)).join("\\n") + "\\n");
        const active = new Database(fixture.dbPath);
        const stagePath = path.join(fixture.directory, "stage.sqlite");
        ensureCodexSchema(active); await syncCodex(active, { homes: [home], exactHomes: true });
        active.exec("CREATE TABLE stage_retention_marker (value TEXT); INSERT INTO stage_retention_marker VALUES ('other-provider-history')");
        installAnalysisTracking(active);
        active.close(); fs.copyFileSync(fixture.dbPath, stagePath);
        const preparation = new Database(stagePath); omitStageAnalysisTracking(preparation); preparation.close();
        fs.unlinkSync(files[1]!);
        const originalQuery = Database.prototype.query;
        let importer: InstanceType<typeof Database> | undefined;
        const observeQuery = function(this: InstanceType<typeof Database>, sql: string) {
          if (sql === "SELECT value FROM meta WHERE key='schema'") importer = this;
          return originalQuery.call(this, sql);
        } as typeof Database.prototype.query;
        Database.prototype.query = observeQuery;
        const settings: Record<string, unknown>[] = [];
        const context = { activeDbPath: fixture.dbPath, stageDbPath: stagePath, rootDir: fixture.directory, mode: "incremental" as const, reparse: true, rebuild: true };
        const adapter = createProductionAdapters().codex;
        const recordSettings = (completed: number) => {
            if (completed !== 0) return;
            // Selected-file validation reports progress before the importer is opened.
            if (!importer) return;
            const main = originalQuery.call(importer, "PRAGMA database_list").all().find((row: any) => row.name === "main") as { file: string };
            if (path.resolve(main.file) !== path.resolve(stagePath)) throw new Error("importer opened a different database");
            const settingsForConnection: Record<string, unknown> = {};
            for (const pragma of ["journal_mode", "synchronous", "journal_size_limit", "cache_size", "mmap_size", "temp_store"])
              settingsForConnection[pragma] = Object.values(originalQuery.call(importer, "PRAGMA " + pragma).get()!)[0];
            settings.push(settingsForConnection);
        };
        let first;
        try {
          first = await adapter({ ...context, onFileProgress: recordSettings });
        } finally { Database.prototype.query = originalQuery; }
        const snapshot = () => {
          const read = new Database(stagePath, { readonly: true });
          try { return {
            events: read.query("SELECT * FROM events ORDER BY home,path,source_offset").all(),
            fileProof: read.query("SELECT * FROM codex_file_evidence ORDER BY home,path").all(),
            files: read.query("SELECT * FROM files ORDER BY home,path").all(),
            marker: read.query("SELECT value FROM stage_retention_marker").all(),
            tracking: read.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'analysis_%' AND tbl_name IN ('events','files','codex_file_evidence','ratelimit') ORDER BY name").all(),
          }; } finally { read.close(); }
        };
        const beforeRetry = snapshot();
        importer = undefined;
        Database.prototype.query = observeQuery;
        let second;
        try { second = await adapter({ ...context, changedFiles: [files[0]!], onFileProgress: recordSettings }); }
        finally { Database.prototype.query = originalQuery; }
        const afterRetry = snapshot();
        let closedAfterError = false, error = "";
        importer = undefined;
        Database.prototype.query = observeQuery;
        try { await adapter({ ...context, onFileDiscovery() { throw new Error("synthetic stage failure"); } }); }
        catch (caught) { error = String(caught); }
        finally { Database.prototype.query = originalQuery; }
        if (!importer) throw new Error("failed importer connection was not observed");
        try { importer!.query("SELECT 1").get(); } catch { closedAfterError = true; }
        const originalExec = Database.prototype.exec;
        const configurationFailure = new Error("synthetic stage configuration failure");
        let failedConfigurationConnection: InstanceType<typeof Database> | undefined;
        let originalFailurePreserved = false, closedAfterConfigurationFailure = false;
        Database.prototype.exec = function(...args: Parameters<typeof originalExec>) {
          if (args[0] === "PRAGMA cache_size = -65536;") {
            failedConfigurationConnection = this;
            throw configurationFailure;
          }
          return originalExec.apply(this, args);
        };
        try { await adapter(context); }
        catch (caught) { originalFailurePreserved = caught === configurationFailure; }
        finally { Database.prototype.exec = originalExec; }
        if (!failedConfigurationConnection) throw new Error("configuration failure connection was not observed");
        try { failedConfigurationConnection.query("SELECT 1").get(); } catch { closedAfterConfigurationFailure = true; }
        console.log("RESULT:" + JSON.stringify({ first, second, settings, beforeRetry, afterRetry, closedAfterError, error,
          originalFailurePreserved, closedAfterConfigurationFailure }));
      } finally { fs.rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    `);
    const child = Bun.spawn([process.execPath, worker], { env: { ...process.env, TOKENATLAS_ARCHIVE: archive,
      TOKENATLAS_ARCHIVE_LOGICAL_ROOT: archive, TOKENATLAS_CONFIG: config, TOKENATLAS_FROZEN_CONFIG: "1",
      TOKENATLAS_LOCAL_STATE: path.join(directory, "state"), TOKENATLAS_PARSE_WORKERS: "0" }, stdout: "pipe", stderr: "pipe" });
    const [exit, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(output.split(/\r?\n/).find(line => line.startsWith("RESULT:"))!.slice(7));
    const settings = { journal_mode: "wal", synchronous: 1, journal_size_limit: 67108864,
      cache_size: -65536, mmap_size: 268435456, temp_store: 2 };
    expect(result.settings).toEqual([settings, settings]);
    expect(result.first.processedInputs).toBe(1);
    expect(result.second.processedInputs).toBe(1);
    expect(result.beforeRetry.events).toHaveLength(2);
    expect(result.beforeRetry.events.map((row: { in_tok: number }) => row.in_tok).sort()).toEqual([7, 8]);
    expect(result.beforeRetry.marker).toEqual([{ value: "other-provider-history" }]);
    expect(result.beforeRetry.tracking).toEqual([]);
    expect(result.afterRetry).toEqual(result.beforeRetry);
    expect(result.error).toContain("synthetic stage failure");
    expect(result.closedAfterError).toBe(true);
    expect(result.originalFailurePreserved).toBe(true);
    expect(result.closedAfterConfigurationFailure).toBe(true);
  } finally { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}, 60000);
