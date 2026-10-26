import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import { removeTestFixture } from "../test-cleanup";
import path from "node:path";
import { ensureRawSyncIndexes } from "../db/migrate";
import { prepareCodexLedgerFixture } from "../server/codex-ledger.fixture";
import { readLedgerSums } from "../server/ledger-sums";
import type { RateCard } from "../server/pricing";
import type { VendorAdapter } from "./adapters";
import { SyncCoordinator } from "./coordinator";
import { adaptersWith, createTestDatabase, emptyAccountsDocument, importCodexHome, noMirror } from "./test-support";

test("raw schema upgrade preserves old tokens and explicitly marks their speed unknown", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,in_tok INTEGER);
      INSERT INTO events VALUES ('home','file','2026-09-08',123);
      CREATE TABLE files(home TEXT,path TEXT,size INTEGER,mtime REAL,events INTEGER);`);
    ensureRawSyncIndexes(db);
    expect(db.query("SELECT in_tok,speed,service_tier FROM events").get())
      .toEqual({ in_tok: 123, speed: "unknown", service_tier: null });
  } finally { db.close(); }
});

test("Codex speed facts survive staged publication, parser backfill and the ledger's sums", async () => {
  const { directory, dbPath } = createTestDatabase();
  const home = path.join(directory, "codex");
  const accounts = path.join(directory, "no-accounts.json");
  fs.writeFileSync(accounts, JSON.stringify(emptyAccountsDocument()));
  const file = path.join(home, "sessions/2026/09/08/fixture.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  const settings = (tier: string) => line({ type: "event_msg", payload: {
    type: "thread_settings_applied", thread_settings: { service_tier: tier, model: "gpt-test" },
  } });
  const tokens = (minute: string, input: number) => line({ timestamp: `2026-09-08T00:${minute}:00Z`,
    type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, output_tokens: 1 } } },
  });
  fs.writeFileSync(file, line({ type: "session_meta", payload: { originator: "codex-tui", thread_source: "user" } })
    + settings("priority") + tokens("01", 10));
  const runImport = (target: string) => importCodexHome(target, home);
  let coordinator: SyncCoordinator | undefined;
  let db: Database | undefined;
  try {
    await runImport(dbPath);
    const adapter: VendorAdapter = async context => {
      const result = await runImport(context.stageDbPath);
      return { processedInputs: result.processed_inputs, skippedInputs: result.skipped_inputs,
        writtenRows: result.written_rows, dirtyRange: result.dirty_range, diagnostics: {}, validationErrors: [] };
    };
    let revision = 1;
    coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), adapters: adaptersWith({ codex: adapter }),
      mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => String(revision),
      prepareStage: () => {}, refreshDerived: () => {} });
    fs.appendFileSync(file, settings("default") + tokens("02", 20));
    const request = { trigger: "manual" as const, mode: "incremental" as const, scope: { kind: "vendor" as const, vendor: "codex" as const } };
    const first = await coordinator.enter(request).completion;
    expect(first.status).toBe("success");
    db = new Database(dbPath);
    const rows = () => db!.query("SELECT in_tok,speed,service_tier FROM events ORDER BY ts").all();
    expect(rows()).toEqual([{ in_tok: 10, speed: "fast", service_tier: "priority" },
      { in_tok: 20, speed: "standard", service_tier: "default" }]);
    fs.appendFileSync(file, settings("priority") + tokens("03", 30));
    revision++;
    expect((await coordinator.enter(request).completion).status).toBe("success");
    expect(rows()).toHaveLength(3);
    // An unchanged file with old parser metadata still needs historical enrichment.
    db.exec("UPDATE files SET parser_version=0,parser_state=NULL; UPDATE events SET speed='unknown',service_tier=NULL");
    revision++;
    expect((await coordinator.enter(request).completion).status).toBe("success");
    expect(rows()).toEqual([{ in_tok: 10, speed: "fast", service_tier: "priority" },
      { in_tok: 20, speed: "standard", service_tier: "default" }, { in_tok: 30, speed: "fast", service_tier: "priority" }]);
    const card = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../rate-cards.json"), "utf8")) as RateCard;
    const inputBySpeed = () => {
      prepareCodexLedgerFixture(db!, card);
      const sums = new Map<string, number>();
      for (const row of readLedgerSums(db!, { vendors: ["codex"], grain: "day" }))
        sums.set(row.speed ?? "", (sums.get(row.speed ?? "") ?? 0) + row.uncached + row.cache_read + row.write_unknown);
      return Object.fromEntries([...sums].sort());
    };
    expect(inputBySpeed()).toEqual({ fast: 40, standard: 20 });
    expect(JSON.parse((db.query("SELECT parser_state FROM files").get() as { parser_state: string }).parser_state).service_tier)
      .toBe("priority");
    db.exec("UPDATE events SET billing_mode='business_credits' WHERE in_tok=20");
    // Accounts and business pools are resolved from periods at read time (stage 4, W6), never stamped.
    expect(inputBySpeed()).toEqual({ fast: 40, standard: 20 });
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 3 });
  } finally {
    db?.close();
    coordinator?.close();
    try { removeTestFixture(directory, { recursive: true, force: true }); }
    catch (error) {
      // Bun may retain closed SQLite statements until process teardown on Windows.
      if ((error as { code?: string }).code !== "EBUSY") throw error;
    }
  }
});
