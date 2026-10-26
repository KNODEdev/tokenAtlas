import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "../db/sqlite";
import { removeTestFixture } from "../test-cleanup";
import { installAnalysisTracking } from "../db/analysis";
import { prepareCodexLedgerFixture } from "../server/codex-ledger.fixture";
import { readLedgerSums } from "../server/ledger-sums";
import type { CodexAccountingConfig } from "../server/codex-accounting-pricing";
import { readCodexPricedDay } from "../server/codex-priced-events";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { ensureUsageLedgerSchema } from "../db/usage-ledger";
import { enqueueCodexLedgerRuleChanges,
  markCodexLedgerCopiesDirty, processCodexLedgerBatch } from "../db/codex-ledger-producer";
import type { RateCard } from "../server/pricing";
import type { VendorAdapter } from "./adapters";
import { SyncCoordinator } from "./coordinator";
import { adaptersWith, createTestDatabase, emptyAccountsDocument, importCodexHome, noMirror } from "./test-support";

const DAY = "2026-09-08";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const header = () =>
  line({ type: "session_meta", payload: { originator: "codex-tui", thread_source: "user", cwd: "C:/work/alpha" } })
  + line({ type: "turn_context", payload: { model: "gpt-test", effort: "high", cwd: "C:/work/alpha" } });
const tokens = (minute: string, input: number, percent: number) => line({
  timestamp: `${DAY}T00:${minute}:00.000Z`,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { last_token_usage: { input_tokens: input, output_tokens: 1 } },
    rate_limits: { limit_id: "codex", plan_type: "plus", primary: { window_minutes: 300, used_percent: percent } },
  },
});

const pricing: CodexAccountingConfig = {
  version: 1,
  rules: [{
    id: "rate", model: "gpt-test", speed: "standard", billing_basis: "api_equivalent_usd",
    valid_from: "2026-01-01", verified_at: "2026-01-01", confidence: "user", sources: ["https://example.com"],
    multiplier: 1, rates: { in_uncached: 2, in_cache_read: 1, out_total: 4 },
  }],
};

async function runImport(target: string, home: string, accounts: string) {
  if (!fs.existsSync(accounts)) fs.writeFileSync(accounts, JSON.stringify(emptyAccountsDocument()));
  return importCodexHome(target, home);
}


interface EventRow { rid: number; source_offset: number | null; ts: string; in_tok: number }
const eventRows = (db: Database) =>
  db.query("SELECT rowid AS rid,source_offset,ts,in_tok FROM events ORDER BY source_offset").all() as EventRow[];
const valuationKeys = (db: Database) =>
  (db.query("SELECT id||'|'||identity AS key FROM codex_price_ledger_events ORDER BY id").all() as { key: string }[])
    .map(row => row.key);

/** Publish through the real producer (a fill when empty, changed copies after) before exercising its read-only consumer. */
function priceDay(db: Database): void {
  const context = codexLedgerReadContext({vendors:{}, codex_accounting:pricing} as RateCard);
  ensureUsageLedgerSchema(db);
  enqueueCodexLedgerRuleChanges(db, {bands:context.policy.baseBands, rulesRevision:context.rulesRevision!, policy:context.policy.policy});
  const copies = db.query("SELECT DISTINCT home,path FROM events").all() as {home:string;path:string}[];
  db.transaction(() => markCodexLedgerCopiesDirty(db, copies)).immediate();
  const factsRevision=(db.query("SELECT data_revision revision FROM vendor_sync_revisions WHERE vendor='codex'").get() as {revision:number}|null)?.revision ?? 0;
  let ready = false;
  for (let step=0;step<100;step++) {
    const progress=processCodexLedgerBatch(db, {bands:context.policy.baseBands, policy:context.policy.policy,
      rulesRevision:context.rulesRevision!, factsRevision, batchSize:2,
      anchorOf:(home,file)=>({archiveId:"test-archive",sourceId:`codex/${createHash("sha256").update(home ?? "").digest("hex")}`,
        relativePath:`sessions/${path.basename(file)}`})});
    expect(progress.blocked).toEqual([]);
    if (progress.ready) {ready=true;break;}
  }
  expect(ready).toBe(true);
  readCodexPricedDay(db, pricing, DAY);
}

/** Counts the row writes a publication makes to the Codex fact tables (test-owned triggers). */
function countWrites(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS test_fact_writes(source TEXT NOT NULL, operation TEXT NOT NULL)");
  for (const table of ["events", "ratelimit"]) for (const operation of ["insert", "update", "delete"] as const)
    db.exec(`CREATE TRIGGER IF NOT EXISTS test_fact_writes_${table}_${operation} AFTER ${operation.toUpperCase()} ON ${table}
      BEGIN INSERT INTO test_fact_writes VALUES('${table}','${operation}'); END`);
  db.exec("DELETE FROM test_fact_writes");
}
function countChanges(db: Database) {
  const tally: Record<string, { insert: number; update: number; delete: number }> = {};
  for (const row of db.query("SELECT source, operation, count(*) n FROM test_fact_writes GROUP BY source, operation").all() as
    Array<{ source: string; operation: "insert" | "update" | "delete"; n: number }>) {
    tally[row.source] ??= { insert: 0, update: 0, delete: 0 };
    tally[row.source]![row.operation] = row.n;
  }
  return tally;
}

test("a grown Codex rollout publishes only its new rows and keeps prior identities priced", async () => {
  const { directory, dbPath } = createTestDatabase();
  const home = path.join(directory, "codex");
  const accounts = path.join(directory, "no-accounts.json");
  const rollout = path.join(home, "sessions/2026/09/08/fixture.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, header() + tokens("01", 10, 1) + tokens("02", 20, 2));
  let coordinator: SyncCoordinator | undefined;
  let db: Database | undefined;
  try {
    await runImport(dbPath, home, accounts);
    db = new Database(dbPath);
    installAnalysisTracking(db);
    const before = eventRows(db);
    expect(before).toHaveLength(2);
    priceDay(db);
    const keysBefore = valuationKeys(db);
    expect(keysBefore).toHaveLength(2);

    let revision = 1;
    const adapter: VendorAdapter = async context => {
      const result = await runImport(context.stageDbPath, home, accounts);
      return { processedInputs: result.processed_inputs, skippedInputs: result.skipped_inputs,
        writtenRows: result.written_rows, dirtyRange: result.dirty_range, diagnostics: {}, validationErrors: [] };
    };
    coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), adapters: adaptersWith({ codex: adapter }),
      mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => String(revision),
      prepareStage: () => {}, refreshDerived: () => {} });
    const request = { trigger: "manual" as const, mode: "incremental" as const,
      scope: { kind: "vendor" as const, vendor: "codex" as const } };

    fs.appendFileSync(rollout, tokens("03", 30, 3));
    revision += 1;
    countWrites(db);
    const run = await coordinator.enter(request).completion;
    expect(run.status).toBe("success");

    // The publication is a row-level diff: nothing that did not change is rewritten.
    expect(countChanges(db)).toEqual({
      events: { insert: 1, update: 0, delete: 0 },
      ratelimit: { insert: 1, update: 0, delete: 0 },
    });
    const after = eventRows(db);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]!.in_tok).toBe(30);

    // The valuation register gains exactly the new event and orphans nothing.
    priceDay(db);
    const keysAfter = valuationKeys(db);
    expect(keysAfter).toHaveLength(3);
    expect(keysBefore.every(key => keysAfter.includes(key))).toBe(true);

    const timings = run.vendors.find(vendor => vendor.vendor === "codex")!.timings!;
    for (const field of ["mirrorMs", "stageMs", "ingestMs", "publishMs"] as const) {
      expect(Number.isInteger(timings[field])).toBe(true);
      expect(timings[field]).toBeGreaterThanOrEqual(0);
    }
    expect(timings.ingestMs).toBeGreaterThan(0);
    expect(Number.isInteger(run.derivedMs)).toBe(true);
  } finally {
    db?.close();
    coordinator?.close();
    try { removeTestFixture(directory, { recursive: true, force: true }); }
    catch (error) { if ((error as { code?: string }).code !== "EBUSY") throw error; }
  }
}, 60_000);

test("Codex valuations key on the source offset, one durable row per source record", () => {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  const columns = "home,path,ts,model,speed,in_tok,cached_in,cache_write,out_tok,source_offset,cache_write_status,usage_status";
  // Two records of the same rollout whose accounting facts are identical. Keyed by the
  // event's position they are two valuations; keyed by anything the file shares they
  // collapse into one, and a republication that moves rowids orphans whatever it keyed on.
  const record = (offset: number) =>
    ["h", "p", `${DAY}T00:01:00.000Z`, "gpt-test", "standard", 10, 0, 0, 1, offset, "missing", "valid"];
  const placeholders = record(0).map(() => "?").join(",");
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,speed TEXT,in_tok INTEGER,
      cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,source_offset INTEGER,
      cache_write_status TEXT,usage_status TEXT)`);
    const insert = db.query(`INSERT INTO events(${columns}) VALUES(${placeholders})`);
    for (const offset of [0, 512]) insert.run(...record(offset));
    installAnalysisTracking(db);
    priceDay(db);
    const keys = valuationKeys(db);
    expect(keys).toHaveLength(2);

    const rowids = () => (db.query("SELECT rowid AS rid FROM events ORDER BY rowid").all() as { rid: number }[])
      .map(row => row.rid);
    const before = rowids();
    db.exec("DELETE FROM events");
    const republish = db.query(`INSERT INTO events(rowid,${columns}) VALUES(?,${placeholders})`);
    for (const offset of [0, 512]) republish.run(offset + 5000, ...record(offset));
    expect(rowids()).not.toEqual(before);
    priceDay(db);
    expect(valuationKeys(db)).toEqual(keys);
  } finally {
    db.close();
    try { removeTestFixture(directory, { recursive: true, force: true }); }
    catch (error) { if ((error as { code?: string }).code !== "EBUSY") throw error; }
  }
});

test("a shrunk rollout and a parser-version bump replace Codex rows without duplicates", async () => {
  const { directory, dbPath } = createTestDatabase();
  const home = path.join(directory, "codex");
  const accounts = path.join(directory, "no-accounts.json");
  const rollout = path.join(home, "sessions/2026/09/08/fixture.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, header() + tokens("01", 10, 1) + tokens("02", 20, 2) + tokens("03", 30, 3));
  let coordinator: SyncCoordinator | undefined;
  let db: Database | undefined;
  try {
    await runImport(dbPath, home, accounts);
    db = new Database(dbPath);
    installAnalysisTracking(db);
    expect(eventRows(db)).toHaveLength(3);

    let revision = 1;
    const adapter: VendorAdapter = async context => {
      const result = await runImport(context.stageDbPath, home, accounts);
      return { processedInputs: result.processed_inputs, skippedInputs: result.skipped_inputs,
        writtenRows: result.written_rows, dirtyRange: result.dirty_range, diagnostics: {}, validationErrors: [] };
    };
    coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), adapters: adaptersWith({ codex: adapter }),
      mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => String(revision),
      prepareStage: () => {}, refreshDerived: () => {} });
    const request = { trigger: "manual" as const, mode: "incremental" as const,
      scope: { kind: "vendor" as const, vendor: "codex" as const } };

    // A source that lost its tail: the removed rows go, the retained ones stay put.
    fs.writeFileSync(rollout, header() + tokens("01", 10, 1) + tokens("02", 20, 2));
    revision += 1;
    countWrites(db);
    expect((await coordinator.enter(request).completion).status).toBe("success");
    expect(countChanges(db)).toEqual({
      events: { insert: 0, update: 0, delete: 1 },
      ratelimit: { insert: 0, update: 0, delete: 1 },
    });
    const shrunk = eventRows(db);
    expect(shrunk.map(row => row.in_tok)).toEqual([10, 20]);
    expect(db.query("SELECT count(*) AS n,count(DISTINCT source_offset) AS d FROM events").get())
      .toEqual({ n: 2, d: 2 });

    // A parser-version bump rereads the whole source; identical facts stay identical rows.
    db.exec("UPDATE files SET parser_version=0,parser_state=NULL");
    revision += 1;
    countWrites(db);
    expect((await coordinator.enter(request).completion).status).toBe("success");
    expect(countChanges(db)).toEqual({});
    expect(eventRows(db)).toEqual(shrunk);
    expect(db.query("SELECT parser_version FROM files").get()).not.toEqual({ parser_version: 0 });
    expect(db.query("SELECT count(*) AS n,count(DISTINCT source_offset) AS d FROM events").get())
      .toEqual({ n: 2, d: 2 });
  } finally {
    db?.close();
    coordinator?.close();
    try { removeTestFixture(directory, { recursive: true, force: true }); }
    catch (error) { if ((error as { code?: string }).code !== "EBUSY") throw error; }
  }
}, 60_000);

test("incremental Codex publication yields the daily totals of a full reference rebuild", async () => {
  const { directory, dbPath } = createTestDatabase();
  const reference = createTestDatabase();
  const home = path.join(directory, "codex");
  const accounts = path.join(directory, "no-accounts.json");
  const rollout = path.join(home, "sessions/2026/09/08/fixture.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, header() + tokens("01", 10, 1));
  let coordinator: SyncCoordinator | undefined;
  let db: Database | undefined;
  let referenceDb: Database | undefined;
  try {
    await runImport(dbPath, home, accounts);
    let revision = 1;
    const adapter: VendorAdapter = async context => {
      const result = await runImport(context.stageDbPath, home, accounts);
      return { processedInputs: result.processed_inputs, skippedInputs: result.skipped_inputs,
        writtenRows: result.written_rows, dirtyRange: result.dirty_range, diagnostics: {}, validationErrors: [] };
    };
    coordinator = new SyncCoordinator({ dbPath, rootDir: process.cwd(), adapters: adaptersWith({ codex: adapter }),
      mirror: noMirror, configFingerprint: () => "fixture", sourceFingerprint: () => String(revision),
      prepareStage: () => {}, refreshDerived: () => {} });
    const request = { trigger: "manual" as const, mode: "incremental" as const,
      scope: { kind: "vendor" as const, vendor: "codex" as const } };
    for (const [minute, input, percent] of [["02", 20, 2], ["03", 30, 3], ["04", 40, 4]] as const) {
      fs.appendFileSync(rollout, tokens(minute, input, percent));
      revision += 1;
      expect((await coordinator.enter(request).completion).status).toBe("success");
    }
    await runImport(reference.dbPath, home, accounts);

    const totals = (target: string) => {
      const sqlite = new Database(target);
      try {
        // The ledger's sums, as the maintenance worker publishes them from these events.
        prepareCodexLedgerFixture(sqlite, {vendors:{}, codex_accounting:pricing} as RateCard);
        const usage = new Map<string, { day: string; speed: string | null; input: number; output: number; calls: number }>();
        for (const row of readLedgerSums(sqlite, { vendors: ["codex"], grain: "day" })) {
          const key = JSON.stringify([row.day, row.speed]), sum = usage.get(key) ?? { day: row.day, speed: row.speed, input: 0, output: 0, calls: 0 };
          sum.input += row.uncached + row.cache_read + row.write_unknown; sum.output += row.out; sum.calls += row.calls;
          usage.set(key, sum);
        }
        return {
          usage: [...usage.values()].sort((a, b) => a.day.localeCompare(b.day) || String(a.speed).localeCompare(String(b.speed))),
          events: sqlite.query("SELECT ts,in_tok,out_tok,model,speed FROM events ORDER BY source_offset").all(),
        };
      } finally { sqlite.close(); }
    };
    const incremental = totals(dbPath);
    expect(incremental.events).toHaveLength(4);
    expect(incremental).toEqual(totals(reference.dbPath));
  } finally {
    db?.close();
    referenceDb?.close();
    coordinator?.close();
    for (const target of [directory, reference.directory]) {
      try { removeTestFixture(target, { recursive: true, force: true }); }
      catch (error) { if ((error as { code?: string }).code !== "EBUSY") throw error; }
    }
  }
}, 90_000);
