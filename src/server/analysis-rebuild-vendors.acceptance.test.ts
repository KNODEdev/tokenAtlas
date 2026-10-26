import { afterEach, expect, test } from "bun:test";
import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import path from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { createCodexSchema, createTestDatabase } from "../sync/test-support";
import type { SyncRunResult } from "../sync/contracts";
import {
  advanceRebuildReadiness,
  analysisRebuildStatus,
  queueAnalysisRebuild,
  runAnalysisRebuild,
} from "./analysis-rebuild";
import { advanceAnalysisRebuildSources, type AppContext } from "./api";
import { ledgerSumsCurrent } from "./ledger-sums";
import { fillUsageLedger } from "./usage-ledger.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { buildEraIndex } from "./eras";
import { removeTestFixture } from "../test-cleanup";

const temporary: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of temporary.splice(0)) {
    removeTestFixture(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const BASELINE_GENERATION = 910_000;
const REQUESTED_AT = new Date("2026-09-17T10:00:00.000Z");
const CLAUDE_SENTINEL = 444;
const CODEX_SENTINEL = 31337;
const ROLLUP_SENTINEL = 999;
const CALL_SENTINEL = 777;

function initializeEngineSchema(dbPath: string): void {
  createCodexSchema(dbPath);
}

function writeConfigFiles(directory: string, archiveRoot: string, codexHome: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  write("accounts.json", splitProbeReaderFixtureConfig([
    { id: "claude-selected", vendor: "claude", home: path.join(archiveRoot, "claude", "PC-user") },
    { id: "codex-unselected", vendor: "codex", home: codexHome },
  ]));
  write("projects.json", { projects: [] });
  write("rate-cards.json", { vendors: {} });
}

function fixture() {
  const created = createTestDatabase();
  temporary.push(created.directory);
  initializeEngineSchema(created.dbPath);
  const archiveRoot = path.join(created.directory, "archive");
  const configRoot = path.join(created.directory, "config");
  const localState = path.join(created.directory, "local-state");
  const claudeFile = path.join(archiveRoot, "claude", "PC-user", "project", "session.jsonl");
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, [
    { id: "selected-seven", session: "selected-a", tokens: 7 },
    { id: "selected-two", session: "selected-b", tokens: 2 },
  ].map((row, index) => JSON.stringify({
    type: "assistant",
    sessionId: row.session,
    timestamp: `2026-09-0${index + 1}T12:00:00.000Z`,
    message: {
      id: row.id,
      model: "claude-selected-fixture",
      stop_reason: "end_turn",
      usage: { input_tokens: row.tokens, output_tokens: 0 },
    },
  })).join("\n") + "\n");

  const codexHome = path.join(archiveRoot, "codex", "PC-user");
  const codexFile = path.join(codexHome, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, [
    { type: "session_meta", payload: { originator: "codex-tui", thread_source: "user", cwd: "C:/vendor-scope" } },
    { type: "turn_context", payload: { model: "gpt-unselected", effort: "high", cwd: "C:/vendor-scope" } },
    { timestamp: "2026-09-01T12:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");

  writeConfigFiles(configRoot, archiveRoot, codexHome);
  const absent = path.join(created.directory, "absent-home");
  // The environment the server gives the source-phase runner, confined to the fixture.
  const env = {
    TOKENATLAS_ARCHIVE: archiveRoot,
    TOKENATLAS_CONFIG: configRoot,
    // The fixture's configuration is complete; never fall back to the repository's files.
    TOKENATLAS_FROZEN_CONFIG: "1",
    TOKENATLAS_LOCAL_STATE: localState,
    // Collection must find no provider installation of the machine running the test.
    USERPROFILE: absent,
    HOME: absent,
    APPDATA: path.join(absent, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(absent, "AppData", "Local"),
    OneDrive: path.join(created.directory, "absent-onedrive"),
    TOKENATLAS_DB: created.dbPath,
    TOKENATLAS_MACHINE: "vendor-fixture",
    TOKENATLAS_LOGIN: "fixture",
  };
  return { ...created, archiveRoot, claudeFile, codexHome, codexFile, env };
}

function context(sqlite: Database, dbPath: string): AppContext {
  const ctx = {
    sqlite,
    dbPath,
    accounts: { version: 2, subscriptions: [], sources: [] },
    homeToSubId: new Map(),
    subIdToHomes: new Map(),
    eras: buildEraIndex([]),
    eraErrors: [],
    homeConflict: null,
    rateCards: { version: 1, currency: "USD", unit: "per 1M", vendors: {} },
    claudeGauge: {},
    grokGauge: {},
    cycles: {},
    plans: {},
    plansCatalog: { provider_groups: [] },
    rootDir: process.cwd(),
    attribution: null,
  } as AppContext;
  return ctx;
}

/** The production runner, exactly as the server starts a rebuild's source phase. */
async function runRebuildChild(
  dbPath: string,
  request: Record<string, unknown>,
  env: Record<string, string>,
): Promise<SyncRunResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "../sync/runner.ts"), JSON.stringify({
      dbPath,
      rootDir: process.cwd(),
      request,
    })],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => child.kill(), 60_000);
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(watchdog));
  expect(exit, stderr).toBe(0);
  const line = stdout.split(/\r?\n/).find(value => value.startsWith("TOKENATLAS_SYNC_RESULT:"));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("TOKENATLAS_SYNC_RESULT:".length)) as SyncRunResult;
}

async function acknowledgeBaseline(f: ReturnType<typeof fixture>): Promise<void> {
  const request = {
    trigger: "manual",
    scope: { kind: "all" },
    mode: "incremental",
    reparse: {},
    rebuildGeneration: BASELINE_GENERATION,
    collection: "archive",
  } as const;
  const result = await runRebuildChild(f.dbPath, request, f.env);
  expect(result.status).toBe("success");
  expect(result.rebuildGeneration).toBe(BASELINE_GENERATION);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(sqlite: Database, table: string): boolean {
  return sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) != null;
}

function columns(sqlite: Database, table: string): string[] {
  return (sqlite.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
    .map(column => column.name);
}

function orderedRows(sqlite: Database, table: string, where = "", params: unknown[] = []): unknown[] {
  if (!tableExists(sqlite, table)) return [];
  const names = columns(sqlite, table);
  return sqlite.query(`SELECT * FROM ${quoteIdentifier(table)} ${where}
    ORDER BY ${names.map(quoteIdentifier).join(",")}`).all(...params as never[]);
}

function codexSummaryTables(sqlite: Database): string[] {
  return (sqlite.query(`SELECT name FROM sqlite_master
    WHERE type='table' AND (name LIKE '%usage%' OR name LIKE '%project%' OR name LIKE '%subscription%')
    ORDER BY name`).all() as Array<{ name: string }>)
    .map(row => row.name)
    .filter(table => {
      const names = columns(sqlite, table);
      return names.includes("vendor") || names.includes("provider");
    });
}

function codexPredicate(sqlite: Database, table: string): { sql: string; params: string[] } {
  const names = columns(sqlite, table);
  if (names.includes("vendor")) return { sql: "WHERE vendor IN ('codex','openai')", params: [] };
  return { sql: "WHERE provider IN ('codex','openai')", params: [] };
}

function setCodexSummarySentinels(sqlite: Database): void {
  for (const table of codexSummaryTables(sqlite)) {
    if (!/(rollup|daily|summary)/i.test(table)) continue;
    const names = columns(sqlite, table);
    const counters = ["in_uncached", "out_total", "calls", "total_tokens", "cost_micros"]
      .filter(column => names.includes(column));
    if (!counters.length) continue;
    const predicate = codexPredicate(sqlite, table);
    sqlite.query(`UPDATE ${quoteIdentifier(table)} SET ${counters.map(column =>
      `${quoteIdentifier(column)}=?`).join(",")} ${predicate.sql}`)
      .run(...counters.map(column => column === "calls" ? CALL_SENTINEL : ROLLUP_SENTINEL));
  }
}

function codexState(sqlite: Database): Record<string, unknown> {
  const summaries = Object.fromEntries(codexSummaryTables(sqlite).map(table => {
    const predicate = codexPredicate(sqlite, table);
    return [table, orderedRows(sqlite, table, predicate.sql, predicate.params)];
  }));
  const revision = sqlite.query("SELECT data_revision FROM vendor_sync_revisions WHERE vendor='codex'").get();
  return {
    events: orderedRows(sqlite, "events"),
    files: orderedRows(sqlite, "files"),
    rateLimits: orderedRows(sqlite, "ratelimit"),
    summaries,
    revision,
    mutations: orderedRows(sqlite, "unselected_mutations"),
  };
}

test("a persisted Claude-only reset repairs real sources and reports without touching accepted Codex facts or summaries", async () => {
  const f = fixture();
  await acknowledgeBaseline(f);

  let db = new Database(f.dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    installAnalysisTracking(db);
    db.exec(`UPDATE claude_events SET in_uncached=${CLAUDE_SENTINEL}`);

    const outsideCodexPath = path.join(f.directory, "accepted-outside-archive", "rollout.jsonl");
    db.query("UPDATE events SET path=?,in_tok=?").run(outsideCodexPath, CODEX_SENTINEL);
    db.exec("DELETE FROM files");
    setCodexSummarySentinels(db);
    db.exec("CREATE TABLE unselected_mutations(table_name TEXT, operation TEXT)");
    for (const table of ["events", "files"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const filter = table === "events" || table === "files" ? "" :
          ` WHEN ${operation === "DELETE" ? "OLD" : "NEW"}.vendor='codex'`;
        db.exec(`CREATE TRIGGER vendor_watch_${table}_${operation} AFTER ${operation} ON ${table}${filter}
          BEGIN INSERT INTO unselected_mutations VALUES('${table}','${operation}'); END`);
      }
    }
    // Accepted Codex facts are already priced: the background producer published their price ledger.
    const accepted = context(db, f.dbPath);
    prepareCodexLedgerFixture(db, accepted.rateCards, accepted.homeToSubId);
    const acceptedCodex = codexState(db);
    expect((acceptedCodex.events as unknown[]).length).toBeGreaterThan(0);

    // A vendor-scoped rebuild must neither parse this malformed unselected source nor
    // demand the accepted Codex path that deliberately lies outside the archive.
    fs.writeFileSync(f.codexFile, "malformed-unselected-codex\n");

    const queued = queueAnalysisRebuild(db, {
      scope: "all",
      mode: "collect-archive",
      vendors: ["claude"],
    }, REQUESTED_AT, true);
    expect(queued).toMatchObject({
      vendors: ["claude"],
      state: "queued",
      phase: "sources",
    });

    db.close(true);
    db = new Database(f.dbPath);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      vendors: ["claude"],
      state: "queued",
      phase: "sources",
    });

    const ctx = context(db, f.dbPath);
    const refreshed: string[] = [];
    const captured: { result?: SyncRunResult } = {};
    ctx.refreshLiveReadings = async (vendor) => { refreshed.push(vendor ?? "all"); };
    ctx.syncRunner = async (_root, _file, request) => {
      expect(request.scope).toEqual({ kind: "vendors", vendors: ["claude"] });
      expect(request.reparse).toEqual({});
      expect(request.collection).toBe("collect-archive");
      captured.result = await runRebuildChild(f.dbPath, request as unknown as Record<string, unknown>, f.env);
      return captured.result;
    };

    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    await advanceAnalysisRebuildSources(ctx);
    expect(refreshed).toEqual(["claude"]);
    expect(captured.result).toBeDefined();
    expect(captured.result!.status).toBe("success");
    expect(captured.result!.scope).toEqual({ kind: "vendors", vendors: ["claude"] });
    expect(captured.result!.vendors.map(result => result.vendor)).toEqual(["claude"]);

    const persisted = db.query("SELECT scope,vendor,result_json FROM sync_runs WHERE run_id=?")
      .get(captured.result!.runId) as { scope: string; vendor: string; result_json: string };
    expect(persisted.scope).toBe("vendors");
    expect(JSON.parse(persisted.vendor)).toEqual(["claude"]);
    expect(JSON.parse(persisted.result_json).scope).toEqual({ kind: "vendors", vendors: ["claude"] });
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      vendors: ["claude"],
      state: "queued",
      phase: "summaries",
    });
    expect(db.query("SELECT SUM(in_uncached) AS tokens,COUNT(*) AS calls FROM claude_events").get())
      .toEqual({ tokens: 9, calls: 2 });
    expect(codexState(db)).toEqual(acceptedCodex);

    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      vendors: ["claude"],
      state: "running",
      phase: "reports",
    });
    expect(codexState(db)).toEqual(acceptedCodex);

    // The background producer catches the rebuilt Claude ledger up (against the fixture's archive root),
    // then the maintenance worker's turn completes the reports phase.
    for (let attempt = 0; attempt < 100 && analysisRebuildStatus(db)?.state === "running"; attempt++) {
      fillUsageLedger(db, "claude", ctx.rateCards, f.archiveRoot, 500);
      advanceRebuildReadiness(db, { prices: ledgerSumsCurrent(db), limitWindows: true, windowSums: true });
    }
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      vendors: ["claude"],
      state: "complete",
      phase: "reports",
    });
    expect(codexState(db)).toEqual(acceptedCodex);
  } finally {
    db.close(true);
    Bun.gc(true);
  }
}, 60_000);

