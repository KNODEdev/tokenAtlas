import { afterEach, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import path from "node:path";
import { installAnalysisTracking } from "../db/analysis";
import { createCodexSchema, createTestDatabase } from "../sync/test-support";
import type { SyncRunResult } from "../sync/contracts";
import {
  analysisRebuildStatus,
  queueAnalysisRebuild,
  runAnalysisRebuild,
  updateAnalysisRebuild,
} from "./analysis-rebuild";
import { advanceAnalysisRebuildSources, type AppContext } from "./api";
import { buildEraIndex } from "./eras";
import { removeTestFixture } from "../test-cleanup";

const temporary: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const directory of temporary.splice(0)) {
    try { removeTestFixture(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    }
  }
});

const REQUESTED_AT = new Date("2026-09-16T12:34:56.789Z");
// Keep the source/config acknowledgement run separate from every queued reset.
const BASELINE_GENERATION = 900_000;
const SOURCE_DAYS = [
  "2024-09-16",
  "2024-09-17",
  "2025-09-16",
  "2025-09-17",
  "2026-03-20",
  "2026-03-21",
  "2026-06-18",
  "2026-06-19",
  "2026-08-17",
  "2026-08-18",
  "2026-09-02",
  "2026-09-03",
  "2026-09-09",
  "2026-09-10",
  "2026-09-15",
  "2026-09-16",
] as const;
const SENTINEL_TOKENS = 999;

function context(sqlite: Database, dbPath: string): AppContext {
  return {
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
}

function matrixFixture() {
  const created = createTestDatabase();
  temporary.push(created.directory);
  const sqlite = new Database(created.dbPath);
  const insert = sqlite.query(`INSERT INTO claude_events(store,call_id,path,ts,in_uncached,out_total)
    VALUES('period-fixture',?,?,?, ?,0)`);
  for (let index = 0; index < SOURCE_DAYS.length; index++) {
    const day = SOURCE_DAYS[index]!;
    insert.run(`call-${index}`, `period-${index}.jsonl`, `${day}T12:00:00.000Z`, index + 1);
  }
  insert.finalize();
  installAnalysisTracking(sqlite);
  return { ...created, sqlite };
}

const PERIODS = [
  { scope: "1d", range: { from: "2026-09-16", until: "2026-09-16" }, timeBounds: { from: "2026-09-16T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "7d", range: { from: "2026-09-10", until: "2026-09-16" }, timeBounds: { from: "2026-09-10T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "14d", range: { from: "2026-09-03", until: "2026-09-16" }, timeBounds: { from: "2026-09-03T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "30d", range: { from: "2026-08-18", until: "2026-09-16" }, timeBounds: { from: "2026-08-18T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "90d", range: { from: "2026-06-19", until: "2026-09-16" }, timeBounds: { from: "2026-06-19T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "180d", range: { from: "2026-03-21", until: "2026-09-16" }, timeBounds: { from: "2026-03-21T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "365d", range: { from: "2025-09-17", until: "2026-09-16" }, timeBounds: { from: "2025-09-17T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "730d", range: { from: "2024-09-17", until: "2026-09-16" }, timeBounds: { from: "2024-09-17T00:00:00.000Z", untilExclusive: "2026-09-17T00:00:00.000Z" } },
  { scope: "all", range: null, timeBounds: null },
  { scope: "custom", range: { from: "2026-08-18", until: "2026-09-03" }, timeBounds: { from: "2026-08-18T00:00:00.000Z", untilExclusive: "2026-09-04T00:00:00.000Z" } },
] as const;
const MODES = ["archive", "collect-archive"] as const;
type PeriodCase = (typeof PERIODS)[number];
type PeriodMode = (typeof MODES)[number];

test("all ten persisted periods and both source modes survive reopen and repair only their selected numeric days", async () => {
  const fixture = matrixFixture();
  let db = fixture.sqlite;
  try {
    for (const period of PERIODS) for (const mode of MODES) {
      const selection = period.scope === "custom"
        ? { scope: period.scope, mode, from: period.range.from, until: period.range.until }
        : { scope: period.scope, mode };
      const queued = queueAnalysisRebuild(db, selection, REQUESTED_AT, true);
      const expectedBounds = period.timeBounds;
      expect(queued).toMatchObject({
        scope: period.scope,
        mode,
        requestedAt: "2026-09-16T12:34:56.789Z",
        range: period.range,
        timeBounds: expectedBounds,
        state: "queued",
        phase: "sources",
      });

      db.close(true);
      db = new Database(fixture.dbPath);
      expect(analysisRebuildStatus(db)).toMatchObject({
        generation: queued.generation,
        scope: period.scope,
        mode,
        requestedAt: "2026-09-16T12:34:56.789Z",
        range: period.range,
        timeBounds: expectedBounds,
        state: "queued",
        phase: "sources",
      });

      const ctx = context(db, fixture.dbPath);
      let sourceRuns = 0;
      ctx.syncRunner = async (_root, _file, request) => {
        sourceRuns++;
        expect(request.collection).toBe(mode);
        expect(request.reparse).toEqual(period.range ?? {});
        return {
          runId: `period-${period.scope}-${mode}-${sourceRuns}`,
          scope: { kind: "all" },
          mode: "incremental",
          status: "success",
          vendors: [],
          changedConfigDomains: [],
          ...(sourceRuns === 2 ? { rebuildGeneration: request.rebuildGeneration } : {}),
        } as unknown as SyncRunResult;
      };
      let liveRefreshes = 0;
      ctx.refreshLiveReadings = async () => { liveRefreshes++; };

      expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
      await advanceAnalysisRebuildSources(ctx);
      expect(analysisRebuildStatus(db)).toMatchObject({
        generation: queued.generation,
        state: "running",
        phase: "sources",
      });
      expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);

      await advanceAnalysisRebuildSources(ctx);
      expect(sourceRuns).toBe(2);
      expect(liveRefreshes).toBe(mode === "collect-archive" ? 2 : 0);
      expect(analysisRebuildStatus(db)).toMatchObject({
        generation: queued.generation,
        state: "queued",
        phase: "summaries",
      });
      expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
      expect(analysisRebuildStatus(db)).toMatchObject({
        generation: queued.generation,
        state: "running",
        phase: "reports",
      });

      updateAnalysisRebuild(db, queued.generation, { state: "complete" });
    }
  } finally {
    db.close(true);
  }
}, 120_000);

function writeConfigFiles(directory: string, archiveRoot: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  write("accounts.json", { version: 2,
    subscriptions: [{ id: "claude-period", vendor: "claude" }],
    sources: [{ vendor: "claude", home: path.join(archiveRoot, "claude", "PC-user") }],
  });
  write("projects.json", { projects: [] });
  write("rate-cards.json", { vendors: {} });
}

/** The environment the server gives the source-phase runner, confined to the fixture. */
function runnerEnvironment(directory: string, archiveRoot: string): Record<string, string> {
  const absent = path.join(directory, "absent-home");
  return {
    TOKENATLAS_ARCHIVE: archiveRoot,
    TOKENATLAS_CONFIG: path.join(directory, "config"),
    // The fixture's configuration is complete; never fall back to the repository's files.
    TOKENATLAS_FROZEN_CONFIG: "1",
    TOKENATLAS_LOCAL_STATE: path.join(directory, "local-state"),
    // Collection must find no provider installation of the machine running the test.
    USERPROFILE: absent,
    HOME: absent,
    APPDATA: path.join(absent, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(absent, "AppData", "Local"),
  };
}

/** The production runner, exactly as the server starts a rebuild's source phase. */
async function runRebuildChild(dbPath: string, request: Record<string, unknown>,
  env: Record<string, string>): Promise<SyncRunResult> {
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

async function runBaselineSource(dbPath: string, env: Record<string, string>): Promise<SyncRunResult> {
  const request = {
    trigger: "manual",
    scope: { kind: "all" },
    mode: "incremental",
    reparse: {},
    rebuildGeneration: BASELINE_GENERATION,
    collection: "archive",
  } as const;
  const result = await runRebuildChild(dbPath, request, env);
  expect(result.status).toBe("success");
  expect(result.rebuildGeneration).toBe(BASELINE_GENERATION);
  return result;
}

type ClaudeDayRevision = { bucket: string; revision: number };

function claudeDayRevisions(sqlite: Database): ClaudeDayRevision[] {
  return sqlite.query(`SELECT bucket,revision FROM analysis_source_revisions
    WHERE source='claude_events' AND bucket <> '*' ORDER BY bucket`).all() as ClaudeDayRevision[];
}

function outsideClaudeDayRevisions(sqlite: Database,
  range: { from: string; until: string } | null): ClaudeDayRevision[] {
  return claudeDayRevisions(sqlite).filter((row) =>
    range != null && !(row.bucket >= range.from && row.bucket <= range.until));
}

test("a real archive source run includes the exact start and fractional final instant while preserving outside facts and summaries", async () => {
  const created = createTestDatabase();
  temporary.push(created.directory);
  createCodexSchema(created.dbPath);
  const archiveRoot = path.join(created.directory, "archive");
  const env = runnerEnvironment(created.directory, archiveRoot);
  const sourceFile = path.join(archiveRoot, "claude", "PC-user", "project", "session.jsonl");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  const sourceRows = [
    { id: "before", ts: "2026-09-08T23:59:59.999999Z", tokens: 7 },
    { id: "start", ts: "2026-09-09T00:00:00.000000Z", tokens: 11 },
    { id: "end", ts: "2026-09-10T23:59:59.999500Z", tokens: 13 },
    { id: "after", ts: "2026-09-11T00:00:00.000000Z", tokens: 17 },
  ];
  fs.writeFileSync(sourceFile, sourceRows.map(row => JSON.stringify({
    type: "assistant",
    sessionId: `session-${row.id}`,
    timestamp: row.ts,
    message: {
      id: row.id,
      model: "claude-fixture",
      stop_reason: "end_turn",
      usage: { input_tokens: row.tokens, output_tokens: 0 },
    },
  })).join("\n") + "\n");
  writeConfigFiles(path.join(created.directory, "config"), archiveRoot);

  let db = new Database(created.dbPath);
  try {
    const insert = db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,in_uncached,out_total)
      VALUES('live',?,?,?,?, 'claude-fixture',?,0)`);
    for (const row of sourceRows) insert.run(row.id, `session-${row.id}`, sourceFile, row.ts, row.tokens);
    insert.finalize();
    installAnalysisTracking(db);
    const baseline = await runBaselineSource(created.dbPath, env);
    expect(baseline.status).toBe("success");
    db.close(true);
    db = new Database(created.dbPath);
    installAnalysisTracking(db);
    db.exec(`UPDATE claude_events SET in_uncached=${SENTINEL_TOKENS}`);
    const outsideRevisionsBeforeQueue = outsideClaudeDayRevisions(db, {
      from: "2026-09-09", until: "2026-09-10",
    });

    const queued = queueAnalysisRebuild(db, {
      scope: "custom",
      from: "2026-09-09",
      until: "2026-09-10",
      mode: "archive",
    }, REQUESTED_AT, true);
    expect(queued.generation).not.toBe(BASELINE_GENERATION);
    expect(queued).toMatchObject({
      range: { from: "2026-09-09", until: "2026-09-10" },
      timeBounds: {
        from: "2026-09-09T00:00:00.000Z",
        untilExclusive: "2026-09-11T00:00:00.000Z",
      },
      state: "queued",
      phase: "sources",
    });
    db.close(true);
    db = new Database(created.dbPath);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      requestedAt: "2026-09-16T12:34:56.789Z",
      range: { from: "2026-09-09", until: "2026-09-10" },
      state: "queued",
      phase: "sources",
    });
    const ctx = context(db, created.dbPath);
    ctx.syncRunner = async (_root, _file, actualRequest) => {
      expect(actualRequest.reparse).toEqual({ from: "2026-09-09", until: "2026-09-10" });
      expect(actualRequest.collection).toBe("archive");
      const result = await runRebuildChild(created.dbPath, actualRequest as unknown as Record<string, unknown>, env);
      expect(result.status).toBe("success");
      expect(result.changedConfigDomains).toEqual([]);
      return result;
    };
    ctx.refreshLiveReadings = async () => { throw new Error("An archive-only rebuild must not poll primary installations"); };

    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    await advanceAnalysisRebuildSources(ctx);
    expect(outsideClaudeDayRevisions(db, {
      from: "2026-09-09", until: "2026-09-10",
    })).toEqual(outsideRevisionsBeforeQueue);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      state: "queued",
      phase: "summaries",
    });
    expect(db.query("SELECT call_id,in_uncached FROM claude_events ORDER BY call_id").all()).toEqual([
      { call_id: "after", in_uncached: SENTINEL_TOKENS },
      { call_id: "before", in_uncached: SENTINEL_TOKENS },
      { call_id: "end", in_uncached: 13 },
      { call_id: "start", in_uncached: 11 },
    ]);

    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      state: "running",
      phase: "reports",
    });
  } finally {
    db.close(true);
  }
}, 120_000);

type PeriodSourceRow = { callId: string; sessionId: string; day: string; ts: string; tokens: number };

const PERIOD_SOURCE_ROWS: PeriodSourceRow[] = SOURCE_DAYS.map((day, index) => ({
  callId: `period-call-${index}`,
  sessionId: `period-session-${index}`,
  day,
  ts: `${day}T12:00:00.000Z`,
  tokens: index + 1,
}));

function writePeriodArchiveFixture(directory: string): {
  archiveRoot: string;
  sourceFile: string;
  env: Record<string, string>;
} {
  const archiveRoot = path.join(directory, "archive");
  const sourceFile = path.join(archiveRoot, "claude", "PC-user", "project", "session.jsonl");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, PERIOD_SOURCE_ROWS.map((row) => JSON.stringify({
    type: "assistant",
    sessionId: row.sessionId,
    timestamp: row.ts,
    message: {
      id: row.callId,
      model: "claude-period-fixture",
      stop_reason: "end_turn",
      usage: { input_tokens: row.tokens, output_tokens: 0 },
    },
  })).join("\n") + "\n");
  writeConfigFiles(path.join(directory, "config"), archiveRoot);
  return { archiveRoot, sourceFile, env: runnerEnvironment(directory, archiveRoot) };
}

function initializeEngineSchema(dbPath: string): void {
  createCodexSchema(dbPath);
}

function seedPeriodFacts(sqlite: Database, sourceFile: string): void {
  const insert = sqlite.query(`INSERT INTO claude_events(
    store,call_id,session_id,path,ts,model,subscription_id,subscription_conflict,in_uncached,out_total
  ) VALUES('live',?,?,?,?,?,?,0,?,0)`);
  for (const row of PERIOD_SOURCE_ROWS) {
    insert.run(row.callId, row.sessionId, sourceFile, row.ts, "claude-period", "claude-period", row.tokens);
  }
  insert.finalize();
  installAnalysisTracking(sqlite);
}

function corruptPeriodFacts(sqlite: Database): void {
  sqlite.exec(`UPDATE claude_events SET in_uncached=${SENTINEL_TOKENS}`);
}

function periodIncludes(period: PeriodCase, day: string): boolean {
  return period.range == null || (day >= period.range.from && day <= period.range.until);
}

function expectedPeriodFacts(period: PeriodCase): Array<{ call_id: string; in_uncached: number }> {
  return PERIOD_SOURCE_ROWS
    .map((row) => ({ call_id: row.callId, in_uncached: periodIncludes(period, row.day) ? row.tokens : SENTINEL_TOKENS }))
    .sort((left, right) => left.call_id.localeCompare(right.call_id));
}

async function runRealPeriodCase(period: PeriodCase, mode: PeriodMode): Promise<void> {
  const created = createTestDatabase();
  temporary.push(created.directory);
  initializeEngineSchema(created.dbPath);
  const fixture = writePeriodArchiveFixture(created.directory);
  let db = new Database(created.dbPath);
  try {
    seedPeriodFacts(db, fixture.sourceFile);
    const baseline = await runBaselineSource(created.dbPath, fixture.env);
    expect(baseline.status).toBe("success");
    db.close(true);
    db = new Database(created.dbPath);
    installAnalysisTracking(db);
    corruptPeriodFacts(db);
    const outsideRevisionsBeforeQueue = outsideClaudeDayRevisions(db, period.range);
    const selection = period.scope === "custom"
      ? { scope: period.scope, mode, from: period.range.from, until: period.range.until }
      : { scope: period.scope, mode };
    const queued = queueAnalysisRebuild(db, selection, REQUESTED_AT, true);
    expect(queued.generation).not.toBe(BASELINE_GENERATION);
    expect(queued).toMatchObject({
      scope: period.scope,
      mode,
      range: period.range,
      timeBounds: period.timeBounds,
      state: "queued",
      phase: "sources",
    });
    db.close(true);
    db = new Database(created.dbPath);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      scope: period.scope,
      mode,
      range: period.range,
      timeBounds: period.timeBounds,
      state: "queued",
      phase: "sources",
    });
    const ctx = context(db, created.dbPath);
    let liveRefreshes = 0;
    ctx.syncRunner = async (_root, _file, actualRequest) => {
      expect(actualRequest.collection).toBe(mode);
      expect(actualRequest.reparse).toEqual(period.range ?? {});
      const result = await runRebuildChild(created.dbPath, actualRequest as unknown as Record<string, unknown>, fixture.env);
      expect(result.status).toBe("success");
      expect(result.changedConfigDomains).toEqual([]);
      return result;
    };
    ctx.refreshLiveReadings = async () => { liveRefreshes++; };

    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    await advanceAnalysisRebuildSources(ctx);
    expect(outsideClaudeDayRevisions(db, period.range)).toEqual(outsideRevisionsBeforeQueue);
    expect(liveRefreshes).toBe(mode === "collect-archive" ? 1 : 0);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      state: "queued",
      phase: "summaries",
    });
    expect(db.query("SELECT call_id,in_uncached FROM claude_events ORDER BY call_id").all()).toEqual(
      expectedPeriodFacts(period),
    );

    db.close(true);
    db = new Database(created.dbPath);
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(true);
    expect(analysisRebuildStatus(db)).toMatchObject({
      generation: queued.generation,
      state: "running",
      phase: "reports",
    });

    const factsAfterReports = db.query("SELECT call_id,in_uncached FROM claude_events ORDER BY call_id").all();
    db.close(true);
    db = new Database(created.dbPath);
    expect(runAnalysisRebuild(db, { subscriptions: [], sources: [] })).toBe(false);
    expect(db.query("SELECT call_id,in_uncached FROM claude_events ORDER BY call_id").all()).toEqual(factsAfterReports);
  } finally {
    db.close(true);
  }
}

for (const period of PERIODS) {
  for (const mode of MODES) {
    test(`real archive rebuild ${period.scope}/${mode} replaces only selected facts and is idempotent`,
      () => runRealPeriodCase(period, mode), 180_000);
  }
}
