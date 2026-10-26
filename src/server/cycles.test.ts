import { claudeWeeklyRegisterWindows } from "./probe-limit-windows";
import { prepareLimitWindowsFixture as prepareLimitWindows } from "./limit-windows.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import type { ClaudeGaugeConfig } from "./claude-gauge";
import type { RateCard } from "./pricing";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { describe, expect, it, spyOn } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  anchoredWindows,
  findCadenceSegments,
  findCycleRow,
  isStrictCalendarDay,
  isStrictIsoInstant,
  loadCycles,
  reconstructAnchoredWindows,
  removeCycleHistory,
  replaceCadenceHistory,
  resolveCadence,
  resolveCadenceForDay,
  saveCycles,
  segmentsForCadence,
  upsertCycleRow,
  validateCycles,
  type Cadence,
  type CadenceSegment,
  type CyclesConfig,
  type CycleWindowConfig,
  type ObservedCadence,
} from "./cycles";
import {
  collectVersionedPlanWindowObservations,
  handleCycles as apiHandleCycles,
  handleCyclesSave,
  handlePlanCapacity as apiHandlePlanCapacity,
  handleWindows as apiHandleWindows,
  type AppContext,
} from "./api";
import { buildEraIndex } from "./eras";
import { Database } from "../db/sqlite";
import { declareClaudeLabelPeriods } from "./subscription-reader.fixture";
import { prepareProbeReaderFixture as prepareProbes, probeReaderFixtureSource, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";

/** What the maintenance worker publishes after the windows: ledgers and window sums (readers never compute them). */
function publishWindowSums(db: Database, options: Parameters<typeof prepareLimitWindows>[1] = {}, claudeGauge: ClaudeGaugeConfig = {},
  rateCards?: RateCard): void {
  const card = { version: 1, currency: "USD", unit: "per 1M", vendors: {}, ...rateCards } as RateCard;
  fillUsageLedgerFixture(db, card);
  prepareWindowUsageFixture(db, { rateCards: card, cycles: options.cycles ?? { windows: [] }, claudeGauge,
    manualCapacity: options.manualCapacity ?? (() => []), subscriptions: options.subscriptions });
}
function prepareLimitWindowsFixture(db: Database, options: Parameters<typeof prepareLimitWindows>[1] = {}): void {
  prepareLimitWindows(db, options);
  publishWindowSums(db, options);
}
function prepareProbeReaderFixture(db: Database, ...rest: Parameters<typeof prepareProbes> extends [unknown, ...infer R] ? R : never): void {
  prepareProbes(db, ...rest);
  publishWindowSums(db);
}
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cycles-test-"));
}
function mockAppContext(cyclesCfg: CyclesConfig): AppContext {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE IF NOT EXISTS probe_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      subject TEXT,
      kind TEXT,
      scope TEXT,
      limit_group TEXT,
      ts TEXT,
      plan TEXT,
      machine TEXT,
      used_percent REAL,
      remaining_percent REAL,
      vendor_percent REAL,
      allowance REAL,
      used REAL,
      remaining REAL,
      resets_at TEXT,
      window_minutes INTEGER,
      ok INTEGER
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS claude_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      store TEXT,
      model TEXT,
      speed TEXT,
      in_uncached INTEGER,
      in_cache_read INTEGER,
      in_cache_write INTEGER,
      cache_write_5m INTEGER,
      cache_write_1h INTEGER,
      out_total INTEGER,
      subscription_id TEXT,
      path TEXT,
      account_key TEXT,
      subscription_conflict INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS grok_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      store TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS oc_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      store TEXT,
      model TEXT,
      in_tok INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      out_tok INTEGER
    );
  `);
  const subscriptions = [
    { id: "claude-work", vendor: "claude" },
    { id: "codex-1", vendor: "codex" },
  ];
  const accounts = splitProbeReaderFixtureConfig([
    ...subscriptions,
    { id: "claude-work", vendor: "claude", machine: "EXAMPLE-MAIN", login: "fixture",
      home: `${ARCHIVE_LOGICAL_ROOT}/claude/claude-work`, source_home: "C:/Users/fixture/.claude" },
    { id: "codex-1", vendor: "codex", machine: "EXAMPLE-MAIN", home: "codex-1" },
  ]);
  return {
    sqlite: db,
    cycles: cyclesCfg,
    accounts,
    grokGauge: {},
    claudeGauge: {
      limits: {
        fable: { models: ["claude-3-5-haiku-20241022"] },
      },
    },
    rateCards: {
      vendors: {
        anthropic: {
          models: {
            "claude-3-7-sonnet-20250219": {
              in_uncached: 3.0,
              out_total: 15.0,
              in_cache_read: 0.3,
              in_cache_write_5m: 3.75,
              in_cache_write_1h: 6.0,
            },
          },
        },
      },
    },
    homeToSubId: new Map([["app", "claude-work"]]),
    subIdToHomes: new Map(),
    eras: buildEraIndex(accounts.subscriptions),
    plans: { segments: [] },
    plansCatalog: { provider_groups: [] },
  } as unknown as AppContext;
}
function prepareProbeReader(ctx: AppContext): void {
  const sources = (ctx.accounts.subscriptions ?? []).map(sub => probeReaderFixtureSource(sub.vendor ?? "codex", sub.id));
  prepareProbes(ctx.sqlite, sources);
  publishWindowSums(ctx.sqlite, { cycles: ctx.cycles }, ctx.claudeGauge, ctx.rateCards);
}
function handleCycles(ctx: AppContext, opts?: Parameters<typeof apiHandleCycles>[1]) {
  prepareProbeReader(ctx);
  return apiHandleCycles(ctx, opts);
}
function handleWindows(ctx: AppContext, url: URL) {
  prepareProbeReader(ctx);
  return apiHandleWindows(ctx, url);
}
function handlePlanCapacity(ctx: AppContext, url: URL) {
  prepareProbeReader(ctx);
  return apiHandlePlanCapacity(ctx, url);
}
function replaceProbeWindowTable(
  ctx: AppContext,
  options: { machine: boolean }
): void {
  ctx.sqlite.exec("DROP TABLE probe_windows");
  ctx.sqlite.exec(`
    CREATE TABLE probe_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      subject TEXT,
      kind TEXT,
      scope TEXT,
      limit_group TEXT,
      ts TEXT,
      plan TEXT,
      ${options.machine ? "machine TEXT," : ""}
      used_percent REAL,
      remaining_percent REAL,
      vendor_percent REAL,
      allowance REAL,
      used REAL,
      remaining REAL,
      resets_at TEXT,
      window_minutes INTEGER,
      ok INTEGER
    )
  `);
}
describe("Versioned window cadence history", () => {
  it("strict validators accept only real calendar days and strict ISO instants", () => {
    expect(isStrictCalendarDay("2026-01-01")).toBe(true);
    expect(isStrictCalendarDay("2026-02-28")).toBe(true);
    expect(isStrictCalendarDay("2026-02-29")).toBe(false);
    expect(isStrictCalendarDay("2026-01-01garbage")).toBe(false);
    expect(isStrictCalendarDay("2026-13-01")).toBe(false);
    expect(isStrictCalendarDay("August 8, 2026")).toBe(false);
    expect(isStrictIsoInstant("2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isStrictIsoInstant("2026-01-01T00:00:00Z")).toBe(true);
    expect(isStrictIsoInstant("2026-01-01T12:00:00+02:00")).toBe(true);
    expect(isStrictIsoInstant("August 8, 2026")).toBe(false);
    expect(isStrictIsoInstant("2026-01-01 12:00:00")).toBe(false);
    expect(isStrictIsoInstant("2026-02-30T12:00:00Z")).toBe(false);
    expect(isStrictIsoInstant("2026-01-01T24:00:00Z")).toBe(false);
  });
  it("loads legacy single cadence record as first segment from origin without rewriting the file", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "cycles.json");
    const legacyJson = {
      _comment: ["legacy cycles fixture"],
      windows: [
        {
          subscription: "codex1",
          kind: "5h",
          period_hours: 5,
          anchor_ts: "2026-08-28T09:00:00.000Z",
          history_windows: 40,
          note: "legacy note",
        },
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(legacyJson, null, 2) + "\n", "utf-8");
    const originalMtime = fs.statSync(filePath).mtimeMs;
    const loaded = loadCycles(dir);
    expect(loaded.windows?.length).toBe(1);
    const segments = segmentsForCadence(loaded.windows?.[0]);
    expect(segments.length).toBe(1);
    expect(segments[0]).toEqual({
      from: null,
      period_hours: 5,
      anchor_ts: "2026-08-28T09:00:00.000Z",
      history_windows: 40,
      note: "legacy note",
      source: "declared",
    });
    expect(fs.readFileSync(filePath, "utf-8")).toContain('"subscription": "codex1"');
    expect(fs.statSync(filePath).mtimeMs).toBe(originalMtime);
  });
  it("persists and returns canonically sorted ascending history when given unsorted segments", () => {
    const initial: CyclesConfig = { windows: [] };
    const unsorted = [
      { from: "2026-07-01", period_hours: 168, anchor_ts: "2026-07-08T00:00:00.000Z" },
      { from: null, period_hours: 336, anchor_ts: "2026-01-15T00:00:00.000Z" },
      { from: "2026-03-01", period_hours: 168, anchor_ts: "2026-03-08T00:00:00.000Z" },
    ];
    const replaced = replaceCadenceHistory(initial, "claude-work", "weekly_all", unsorted);
    const segs = replaced.windows?.[0]?.segments;
    expect(segs).toBeDefined();
    expect(segs!.length).toBe(3);
    expect(segs![0]!.from).toBeNull();
    expect(segs![1]!.from).toBe("2026-03-01");
    expect(segs![2]!.from).toBe("2026-07-01");
  });
  it("resolves day-specific segment and returns explicit absence for dates before first dated segment", () => {
    const config: CyclesConfig = {
      windows: [
        {
          subscription: "claude-work",
          kind: "weekly_all",
          segments: [
            {
              from: "2026-03-01",
              period_hours: 168,
              anchor_ts: "2026-03-08T00:00:00.000Z",
              note: "Spring cadence",
            },
            {
              from: "2026-07-01",
              period_hours: 168,
              anchor_ts: "2026-07-08T12:00:00.000Z",
              note: "Summer cadence",
            },
          ],
        },
      ],
    };
    const observed: ObservedCadence = {
      periodHours: 168,
      anchorIso: "2026-08-20T10:00:00.000Z",
      source: "probe",
    };
    const beforeFirst = resolveCadenceForDay(config, "claude-work", "weekly_all", "2026-02-15", observed);
    expect(beforeFirst.declaredCovering).toBe(false);
    expect(beforeFirst.segmentFrom).toBeNull();
    expect(beforeFirst.sourceWon).toBe("probe");
    expect(beforeFirst.periodHours).toBe(168);
    expect(beforeFirst.anchorIso).toBe("2026-08-20T10:00:00.000Z");
    const inFirst = resolveCadenceForDay(config, "claude-work", "weekly_all", "2026-03-15", observed);
    expect(inFirst.declaredCovering).toBe(true);
    expect(inFirst.segmentFrom).toBe("2026-03-01");
    expect(inFirst.sourceWon).toBe("declared");
    expect(inFirst.anchorIso).toBe("2026-03-08T00:00:00.000Z");
    const onBoundary = resolveCadenceForDay(config, "claude-work", "weekly_all", "2026-07-01", observed);
    expect(onBoundary.declaredCovering).toBe(true);
    expect(onBoundary.segmentFrom).toBe("2026-07-01");
    expect(onBoundary.sourceWon).toBe("declared");
    expect(onBoundary.anchorIso).toBe("2026-07-08T12:00:00.000Z");
  });
  it("GET /api/cycles carries authoritative probe fallback beside dated declarations", async () => {
    const ctx = mockAppContext({
      windows: [
        {
          subscription: "claude-work",
          kind: "weekly_all",
          segments: [
            {
              from: "2026-06-01",
              period_hours: 168,
              anchor_ts: "2026-06-08T00:00:00.000Z",
              note: "dated declaration",
            },
          ],
        },
      ],
    });
    ctx.sqlite.run(`
      INSERT INTO probe_windows
        (provider, subject, kind, resets_at, window_minutes, ok, ts)
      VALUES
        ('claude', 'claude-work', 'weekly_all', '2026-05-25T00:00:00.000Z', 20160, 1, '2026-05-24T00:00:00.000Z');
    `);
    const response = handleCycles(ctx);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      rows: Array<{
        subscription: string;
        declaration_editable: boolean;
        segments: Array<{
          from: string | null;
          period_hours: number;
          source: string;
          declaration: boolean;
        }>;
      }>;
    };
    const row = payload.rows.find((candidate) => candidate.subscription === "claude-work");
    expect(row?.declaration_editable).toBe(true);
    expect(row?.segments).toHaveLength(2);
    expect(row?.segments[0]).toMatchObject({
      from: null,
      period_hours: 336,
      source: "probe",
      declaration: false,
    });
    expect(row?.segments[1]).toMatchObject({
      from: "2026-06-01",
      period_hours: 168,
      source: "declared",
      declaration: true,
    });
  });
  it("uses physical probe periods for cycle rows and rail readings after a correction", async () => {
    const ctx = mockAppContext({ windows: [] });
    const source = probeReaderFixtureSource("glm", "first");
    ctx.accounts.subscriptions.push({ id: "first", vendor: "glm" }, { id: "second", vendor: "glm" });
    ctx.accounts.sources.push({ vendor: "glm", machine: source.machine, login: source.login,
      home: source.home, source_home: source.source_home });
    const ts = new Date().toISOString();
    const reset = new Date(Date.now() + 3 * 86_400_000).toISOString();
    ctx.sqlite.query(`INSERT INTO probe_windows
      (provider, subject, kind, ts, used_percent, window_minutes, resets_at, ok)
      VALUES ('glm', 'second', 'weekly', ?, 42, 10080, ?, 1)`).run(ts, reset);
    ctx.sqlite.query(`INSERT INTO probe_windows
      (provider, subject, kind, ts, used_percent, window_minutes, resets_at, ok)
      VALUES ('glm', 'obsolete-stamp', 'session', ?, 17, 300, ?, 1)`).run(ts, reset);
    prepareProbeReaderFixture(ctx.sqlite, [source], () => "first");
    const original = ctx.sqlite.query("SELECT subject FROM probe_windows ORDER BY id").all();
    const before = await apiHandleCycles(ctx).json() as { rows: Array<{ subscription: string; kind: string }> };
    expect(before.rows.some(row => row.subscription === "first" && row.kind === "weekly")).toBe(true);
    expect(before.rows.some(row => row.subscription === "first" && row.kind === "session")).toBe(true);
    expect(before.rows.some(row => row.subscription === "second" && row.kind === "weekly")).toBe(false);

    const periods = loadPeriods(ctx.sqlite, ACCOUNT_PERIODS).map(period => period.provider === "glm"
      ? { ...period, value: "second" } : period);
    replaceDeclaredPeriods(ctx.sqlite, ACCOUNT_PERIODS, periods);
    const config = { subscriptions: ctx.accounts.subscriptions, sources: ctx.accounts.sources };
    const registry = currentRegistry(config.subscriptions, new Date().toISOString());
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (!publishCurrentBatch(ctx.sqlite, registry, new Date().toISOString(), 32, config)) break;
      if (attempt === 999) throw new Error("Corrected probe account index did not settle");
    }
    // The maintenance worker publishes the corrected limit windows before the rail reads them.
    prepareLimitWindowsFixture(ctx.sqlite, { sources: ctx.accounts.sources, subscriptions: ctx.accounts.subscriptions });
    const after = await apiHandleCycles(ctx).json() as { rows: Array<{ subscription: string; kind: string }> };
    expect(after.rows.some(row => row.subscription === "first" && row.kind === "weekly")).toBe(false);
    expect(after.rows.some(row => row.subscription === "second" && row.kind === "weekly")).toBe(true);
    expect(after.rows.some(row => row.subscription === "second" && row.kind === "session")).toBe(true);
    const rail = await apiHandleWindows(ctx, new URL("http://localhost/api/windows?account=second"));
    const windows = await rail.json() as { windows: Array<{ usedPercent: number }> };
    expect(windows.windows.map(window => window.usedPercent).sort()).toEqual([17, 42]);
    expect(ctx.sqlite.query("SELECT subject FROM probe_windows ORDER BY id").all()).toEqual(original);
  });
  it("reports an unavailable probe index instead of empty cycle or rail data", async () => {
    const ctx = mockAppContext({ windows: [] });
    ctx.accounts.subscriptions?.push({ id: "glm-work", vendor: "glm" });
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    ctx.sqlite.query(`INSERT INTO probe_windows (provider, subject, kind, ts, ok)
      VALUES ('glm', 'glm-work', 'weekly', ?, 1)`).run(new Date().toISOString());
    expect(() => apiHandleCycles(ctx)).toThrow(ProbeAccountIndexUnavailable);
    const preparing = await apiHandleWindows(ctx, new URL("http://localhost/api/windows?account=glm-work"));
    expect(preparing.status).toBe(202);
    expect(preparing.headers.get("X-Analysis")).toBe("preparing");
  });
  it("POST→GET exposes the cadence active on the injected UTC day, never a scheduled future segment", async () => {
    const testDir = tmpDir();
    const ctx = mockAppContext({ windows: [] });
    const beforeBoundary = Date.parse("2026-09-09T23:59:59.000Z");
    const onBoundary = Date.parse("2026-09-10T00:00:00.000Z");
    const afterBoundary = Date.parse("2026-09-10T12:00:00.000Z");
    const segments = [
      {
        from: "2026-08-01",
        period_hours: 5,
        anchor_ts: "2026-08-01T05:00:00.000Z",
        note: "active cadence",
      },
      {
        from: "2026-09-10",
        period_hours: 6,
        anchor_ts: "2026-09-10T06:00:00.000Z",
        note: "scheduled cadence",
      },
    ];
    const rowFrom = async (response: Response) => {
      const payload = (await response.json()) as {
        rows: Array<{
          subscription: string;
          period_hours: number | null;
          anchor_ts: string | null;
          note: string | null;
          segments: Array<{ from: string | null; period_hours: number; declaration: boolean }>;
        }>;
      };
      return payload.rows.find((row) => row.subscription === "claude-work")!;
    };
    prepareProbeReader(ctx);
    const post = await handleCyclesSave(
      ctx,
      new Request("http://localhost/api/cycles", {
        method: "POST",
        body: JSON.stringify({ subscription: "claude-work", kind: "weekly_all", segments }),
      }),
      { rootDir: testDir, nowMs: beforeBoundary }
    );
    expect(post.status).toBe(200);
    const postRow = await rowFrom(post);
    expect(postRow).toMatchObject({
      period_hours: 5,
      anchor_ts: "2026-08-01T05:00:00.000Z",
      note: "active cadence",
    });
    expect(postRow.segments.filter((segment) => segment.declaration)).toMatchObject([
      { from: "2026-08-01", period_hours: 5, declaration: true },
      { from: "2026-09-10", period_hours: 6, declaration: true },
    ]);
    const beforeGet = await rowFrom(handleCycles(ctx, { rootDir: testDir, nowMs: beforeBoundary }));
    expect(beforeGet).toMatchObject({
      period_hours: 5,
      anchor_ts: "2026-08-01T05:00:00.000Z",
      note: "active cadence",
    });
    for (const nowMs of [onBoundary, afterBoundary]) {
      const current = await rowFrom(handleCycles(ctx, { rootDir: testDir, nowMs }));
      expect(current).toMatchObject({
        period_hours: 6,
        anchor_ts: "2026-09-10T06:00:00.000Z",
        note: "scheduled cadence",
      });
      expect(current.segments.filter((segment) => segment.declaration)).toHaveLength(2);
    }
  });
  it("POST /api/cycles strictly refutes malformed inputs verbatim naming subscription+kind with unchanged disk/memory", async () => {
    const testDir = tmpDir();
    const isolatedFile = path.join(testDir, "cycles.json");
    const baseline: CyclesConfig = {
      windows: [
        {
          subscription: "claude-work",
          kind: "weekly_all",
          segments: [
            { from: "2026-01-01", period_hours: 168, anchor_ts: "2026-01-08T00:00:00.000Z" },
          ],
        },
      ],
    };
    fs.writeFileSync(isolatedFile, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
    const ctx = mockAppContext(baseline);
    const assertRefusal = async (body: any, expectedErrorSubstrings: string[]) => {
      const req = new Request("http://localhost/api/cycles", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const res = await handleCyclesSave(ctx, req, { rootDir: testDir });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      for (const s of expectedErrorSubstrings) {
        expect(json.error).toContain(s);
      }
      expect(ctx.cycles.windows?.[0]?.segments?.length).toBe(1);
      const disk = JSON.parse(fs.readFileSync(isolatedFile, "utf-8")) as CyclesConfig;
      expect(disk.windows?.[0]?.segments?.length).toBe(1);
    };
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-01-01garbage", period_hours: 168, anchor_ts: "2026-01-08T00:00:00.000Z" },
        ],
      },
      ["claude-work/weekly_all", "nieprawidłowa data 'from'", "2026-01-01garbage"]
    );
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-02-30", period_hours: 168, anchor_ts: "2026-03-08T00:00:00.000Z" },
        ],
      },
      ["claude-work/weekly_all", "nieprawidłowa data 'from'", "2026-02-30"]
    );
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-01-01", period_hours: 168, anchor_ts: "August 8, 2026" },
        ],
      },
      ["claude-work/weekly_all", "anchor_ts", "August 8, 2026"]
    );
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-01-01", period_hours: 0, anchor_ts: "2026-01-08T00:00:00.000Z" },
        ],
      },
      ["claude-work/weekly_all", "period_hours musi być z zakresu"]
    );
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-01-01", period_hours: 168, anchor_ts: "2026-01-08T00:00:00.000Z" },
          { from: "2026-01-01", period_hours: 168, anchor_ts: "2026-01-08T00:00:00.000Z" },
        ],
      },
      ["claude-work/weekly_all", "zduplikowana granica 'from' '2026-01-01'"]
    );
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-01-01", period_hours: 168, anchor_ts: "2026-01-08T00:00:00.000Z", source: "probe" },
        ],
      },
      ["claude-work/weekly_all", "source nie może być 'probe' w deklaracji"]
    );
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [{ from: null, period_hours: 168, anchor_ts: null }],
      },
      ["claude-work/weekly_all", "anchor_ts 'null'"]
    );
    await assertRefusal(
      {
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-01-01", period_hours: "168", anchor_ts: "2026-01-08T00:00:00.000Z" },
        ],
      },
      ["claude-work/weekly_all", "period_hours musi być z zakresu"]
    );
  });
  it("spans an actual period change (336h -> 168h), reconstructing historical boundaries without crossing and aggregating events into their exact versioned window", async () => {
    const config: CyclesConfig = {
      windows: [
        {
          subscription: "claude-work",
          kind: "weekly_all",
          segments: [
            {
              from: "2026-01-01",
              period_hours: 336,
              anchor_ts: "2026-01-15T00:00:00.000Z",
              note: "Winter 14d cycle",
            },
            {
              from: "2026-06-01",
              period_hours: 168,
              anchor_ts: "2026-06-08T00:00:00.000Z",
              note: "Summer 7d cycle",
            },
          ],
        },
      ],
    };
    const cadence = resolveCadence(config, "claude-work", "weekly_all", {
      periodHours: 168,
      anchorIso: "2026-08-15T00:00:00.000Z",
      source: "probe",
    });
    const nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const earliestMs = Date.parse("2026-01-01T00:00:00.000Z");
    const boundaryMs = Date.parse("2026-06-01T00:00:00.000Z");
    const windows = anchoredWindows(cadence, { nowMs, earliestMs, limit: 100 });
    expect(windows.length).toBeGreaterThan(0);
    const oldWindows = windows.filter((w) => w.segmentFrom === "2026-01-01");
    const newWindows = windows.filter((w) => w.segmentFrom === "2026-06-01");
    expect(oldWindows.length).toBeGreaterThan(0);
    expect(newWindows.length).toBeGreaterThan(0);
    for (const ow of oldWindows) {
      expect(ow.periodHours).toBe(336);
      expect(ow.periodSource).toBe("declared");
      expect(ow.anchorSource).toBe("declared");
      expect(ow.source).toBe("declared");
      expect(ow.resetMs).toBeLessThanOrEqual(boundaryMs);
    }
    for (const nw of newWindows) {
      expect(nw.periodHours).toBe(168);
      expect(nw.periodSource).toBe("declared");
      expect(nw.anchorSource).toBe("declared");
      expect(nw.source).toBe("declared");
      expect(nw.startMs).toBeGreaterThanOrEqual(boundaryMs);
    }
    const ctx = mockAppContext(config);
    ctx.sqlite.run(`
      INSERT INTO probe_windows (provider, subject, kind, resets_at, ok, ts)
      VALUES ('claude', 'claude-work', 'weekly_all', '2026-08-08T00:00:00.000Z', 1, '2026-08-01T00:00:00.000Z');
    `);
    ctx.sqlite.run(`
      INSERT INTO claude_events (ts, store, model, speed, in_uncached, in_cache_read, in_cache_write, cache_write_5m, cache_write_1h, out_total, subscription_id)
      VALUES ('2026-02-10T12:00:00.000Z', 'app', 'claude-3-7-sonnet-20250219', 'standard', 100000, 0, 0, 0, 0, 20000, 'claude-work');
    `);
    ctx.sqlite.run(`
      INSERT INTO claude_events (ts, store, model, speed, in_uncached, in_cache_read, in_cache_write, cache_write_5m, cache_write_1h, out_total, subscription_id)
      VALUES ('2026-02-10T13:00:00.000Z', 'remote', 'claude-3-7-sonnet-20250219', 'standard', 25000, 0, 0, 0, 0, 5000, 'claude-work');
    `);
    ctx.sqlite.run(`
      INSERT INTO claude_events (ts, store, model, speed, in_uncached, in_cache_read, in_cache_write, cache_write_5m, cache_write_1h, out_total, subscription_id)
      VALUES ('2026-02-10T14:00:00.000Z', 'unmapped-store', 'claude-3-7-sonnet-20250219', 'standard', 5000, 0, 0, 0, 0, 1000, 'claude-work');
    `);
    ctx.sqlite.run(`
      INSERT INTO claude_events (ts, store, model, speed, in_uncached, in_cache_read, in_cache_write, cache_write_5m, cache_write_1h, out_total, subscription_id)
      VALUES ('2026-07-10T12:00:00.000Z', 'app', 'claude-3-7-sonnet-20250219', 'standard', 50000, 0, 0, 0, 0, 10000, 'claude-work');
    `);
    declareClaudeLabelPeriods(ctx.sqlite);
    prepareProbeReader(ctx);
    const res = await handleWindows(ctx, new URL("http://localhost/api/windows?account=claude-work"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { windows: any[] };
    expect(data.windows.length).toBeGreaterThan(0);
    const febWindow = data.windows.find(
      (w) => w.startIso <= "2026-02-10T12:00:00.000Z" && w.resetIso > "2026-02-10T12:00:00.000Z"
    );
    expect(febWindow).toBeDefined();
    expect(febWindow.windowHours).toBe(336);
    expect(febWindow.label).toBe("14d");
    expect(febWindow.tokensTotal).toBe(156000);
    expect(febWindow.usd).toBe(0.78);
    expect(febWindow.activityShape.at(-1)).toEqual({ t: 100, amount: 156000 });
    // The legacy store labels collapse to one archived Claude source in this fixture.
    // Machine identity follows that physical source across account periods.
    expect(febWindow.trafficByMachine).toEqual([{ machine: "EXAMPLE-MAIN", amount: 156000 }]);
    expect(febWindow.cadenceSegmentFrom).toBe("2026-01-01");
    expect(febWindow.cadencePeriodSource).toBe("declared");
    expect(febWindow.cadenceAnchorSource).toBe("declared");
    const julWindow = data.windows.find(
      (w) => w.startIso <= "2026-07-10T12:00:00.000Z" && w.resetIso > "2026-07-10T12:00:00.000Z"
    );
    expect(julWindow).toBeDefined();
    expect(julWindow.windowHours).toBe(168);
    expect(julWindow.label).toBe("7d");
    expect(julWindow.tokensTotal).toBe(60000);
    expect(julWindow.usd).toBe(0.3);
    expect(julWindow.activityShape.at(-1)).toEqual({ t: 100, amount: 60000 });
    expect(julWindow.cadenceSegmentFrom).toBe("2026-06-01");
    expect(julWindow.cadencePeriodSource).toBe("declared");
    expect(julWindow.cadenceAnchorSource).toBe("declared");
  });
  it("legacy top-level save from legacy client updates only latest segment and preserves earlier versioned history", async () => {
    const testDir = tmpDir();
    const isolatedFile = path.join(testDir, "cycles.json");
    const multiSegmentHistory: CyclesConfig = {
      windows: [
        {
          subscription: "claude-work",
          kind: "weekly_all",
          segments: [
            {
              from: "2026-01-01",
              period_hours: 336,
              anchor_ts: "2026-01-15T00:00:00.000Z",
              note: "v1 historical",
            },
            {
              from: "2026-06-01",
              period_hours: 168,
              anchor_ts: "2026-06-08T00:00:00.000Z",
              note: "v2 current",
            },
          ],
        },
      ],
    };
    fs.writeFileSync(isolatedFile, JSON.stringify(multiSegmentHistory, null, 2) + "\n", "utf-8");
    const ctx = mockAppContext(multiSegmentHistory);
    const legacyPayload = {
      subscription: "claude-work",
      kind: "weekly_all",
      period_hours: 168,
      anchor_ts: "2026-06-10T12:00:00.000Z",
      history_windows: 50,
      note: "v2 updated via legacy panel",
    };
    const req = new Request("http://localhost/api/cycles", {
      method: "POST",
      body: JSON.stringify(legacyPayload),
    });
    prepareProbeReader(ctx);
    const res = await handleCyclesSave(ctx, req, { rootDir: testDir });
    expect(res.status).toBe(200);
    const row = ctx.cycles.windows?.find((w) => w.subscription === "claude-work" && w.kind === "weekly_all");
    expect(row).toBeDefined();
    expect(row!.segments?.length).toBe(2);
    expect(row!.segments![0]?.from).toBe("2026-01-01");
    expect(row!.segments![0]?.period_hours).toBe(336);
    expect(row!.segments![0]?.anchor_ts).toBe("2026-01-15T00:00:00.000Z");
    expect(row!.segments![0]?.note).toBe("v1 historical");
    expect(row!.segments![1]?.from).toBe("2026-06-01");
    expect(row!.segments![1]?.period_hours).toBe(168);
    expect(row!.segments![1]?.anchor_ts).toBe("2026-06-10T12:00:00.000Z");
    expect(row!.segments![1]?.history_windows).toBe(50);
    expect(row!.segments![1]?.note).toBe("v2 updated via legacy panel");
    const disk = JSON.parse(fs.readFileSync(isolatedFile, "utf-8")) as CyclesConfig;
    expect(disk.windows?.[0]?.segments?.length).toBe(2);
    expect(disk.windows?.[0]?.segments?.[0]?.from).toBe("2026-01-01");
    expect(disk.windows?.[0]?.segments?.[1]?.anchor_ts).toBe("2026-06-10T12:00:00.000Z");
  });
  it("keeps mixed legacy declaration/probe provenance explicit on reconstructed boundaries", () => {
    const legacy: CyclesConfig = {
      windows: [{ subscription: "claude-work", kind: "weekly_all", period_hours: 168 }],
    };
    const cadence = resolveCadence(legacy, "claude-work", "weekly_all", {
      periodHours: 168,
      anchorIso: "2026-08-08T00:00:00.000Z",
      source: "probe",
    });
    const windows = anchoredWindows(cadence, {
      nowMs: Date.parse("2026-08-01T00:00:00.000Z"),
      earliestMs: Date.parse("2026-07-01T00:00:00.000Z"),
      limit: 2,
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]!.periodSource).toBe("declared");
    expect(windows[0]!.anchorSource).toBe("probe");
    expect(windows[0]!.source).toBe("probe");
  });
  it("POST canonicalizes valid whole history only after validation and makes source server-owned", async () => {
    const testDir = tmpDir();
    const ctx = mockAppContext({ windows: [] });
    const req = new Request("http://localhost/api/cycles", {
      method: "POST",
      body: JSON.stringify({
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-06-01", period_hours: 168, anchor_ts: "2026-06-08T00:00:00.000Z" },
          { from: "2026-01-01", period_hours: 336, anchor_ts: "2026-01-15T00:00:00.000Z" },
        ],
      }),
    });
    prepareProbeReader(ctx);
    const response = await handleCyclesSave(ctx, req, { rootDir: testDir });
    expect(response.status).toBe(200);
    const stored = loadCycles(testDir).windows?.[0]?.segments;
    expect(stored?.map((seg) => seg.from)).toEqual(["2026-01-01", "2026-06-01"]);
    expect(stored?.every((seg) => seg.source === "declared")).toBe(true);
  });
  it("rejects duplicate logical histories through the POST boundary without changing disk or memory", async () => {
    const testDir = tmpDir();
    const duplicate: CyclesConfig = {
      windows: [
        { subscription: "claude-work", kind: "weekly_all", period_hours: 168 },
        { subscription: "CLAUDE-WORK", kind: "WEEKLY_ALL", period_hours: 336 },
      ],
    };
    const file = path.join(testDir, "cycles.json");
    const before = JSON.stringify(duplicate, null, 2) + "\n";
    fs.writeFileSync(file, before, "utf-8");
    const ctx = mockAppContext(duplicate);
    const response = await handleCyclesSave(
      ctx,
      new Request("http://localhost/api/cycles", {
        method: "POST",
        body: JSON.stringify({ subscription: "codex-1", kind: "weekly", period_hours: 168 }),
      }),
      { rootDir: testDir }
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("zduplikowany wiersz CLAUDE-WORK/WEEKLY_ALL");
    expect(ctx.cycles).toBe(duplicate);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });
  it("uses an atomic temp write so a failed save leaves the target unchanged", () => {
    const testDir = tmpDir();
    const file = path.join(testDir, "cycles.json");
    const before = '{"windows":[]}\n';
    fs.writeFileSync(file, before, "utf-8");
    const flush = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("disk flush failed"); });
    try {
      expect(() => saveCycles(testDir, {
        windows: [{ subscription: "claude-work", kind: "weekly_all", period_hours: 168 }],
      })).toThrow("disk flush failed");
    } finally { flush.mockRestore(); }
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });
  it("keeps an exact-boundary ending plan window old and a boundary-starting window new", async () => {
    const config: CyclesConfig = {
      windows: [{
        subscription: "claude-work",
        kind: "weekly_all",
        segments: [
          { from: "2026-01-01", period_hours: 336, anchor_ts: "2026-01-15T00:00:00.000Z" },
          { from: "2026-06-01", period_hours: 168, anchor_ts: "2026-06-08T00:00:00.000Z" },
        ],
      }],
    };
    const ctx = mockAppContext(config);
    ctx.plansCatalog = {
      provider_groups: [{
        id: "anthropic",
        label: "Anthropic",
        aliases: ["claude", "anthropic"],
        plans: [{
          plan_id: "claude-pro",
          label: "Pro",
          versions: [{ from: "2025-01-01", usd_per_month: 20 }],
        }],
      }],
    };
    // Plan history lives in the account's plan periods.
    ctx.sqlite.exec(`CREATE TABLE IF NOT EXISTS plan_periods (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL,
      from_ts TEXT NOT NULL, until_ts TEXT, plan TEXT NOT NULL, amount_minor INTEGER, currency TEXT, origin TEXT NOT NULL,
      first_seen TEXT, last_seen TEXT, readings INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL)`);
    replaceDeclaredPeriods(ctx.sqlite, PLAN_PERIODS, [{ provider: "claude", subject: "claude-work", value: "claude-pro",
      from: "2025-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
    const windows = [
      { reset: "2026-06-01T00:00:00.000Z", sampleStart: "2026-05-29T12:00:00.000Z" },
      { reset: "2026-06-08T00:00:00.000Z", sampleStart: "2026-06-01T00:00:00.000Z" },
    ];
    for (const { reset, sampleStart } of windows) {
      const resetMs = Date.parse(reset);
      for (let i = 0; i < 60; i++) {
        const ts = new Date(Date.parse(sampleStart) + i * 3_600_000).toISOString();
        ctx.sqlite.run(
          `INSERT INTO probe_windows
             (provider, subject, kind, ts, used_percent, window_minutes, resets_at, ok)
           VALUES ('claude', 'claude-work', 'weekly_all', ?, ?, 10080, ?, 1)`,
          [ts, (i / 59) * 50, reset]
        );
      }
      ctx.sqlite.run(
        `INSERT INTO claude_events
           (ts, store, model, speed, in_uncached, in_cache_read, in_cache_write,
            cache_write_5m, cache_write_1h, out_total, subscription_id)
         VALUES (?, 'app', 'claude-3-7-sonnet-20250219', 'standard',
                 1000000, 0, 0, 0, 0, 100000, 'claude-work')`,
        [new Date(resetMs - 24 * 3_600_000).toISOString()]
      );
    }
    declareClaudeLabelPeriods(ctx.sqlite);
    prepareProbeReader(ctx);
    const observations = collectVersionedPlanWindowObservations(ctx, {
      provider: "claude",
      plan_id: "claude-pro",
      window_kind: "weekly_all",
    }).filter((row) => !row.exclusion_reason);
    // Plan observations are the stored limit windows (plan U4.4): each takes its own window's length and
    // bounds from the register, which the cadence configuration segments; it keeps no cadence of its own.
    const stored = claudeWeeklyRegisterWindows(ctx.sqlite, "claude-work");
    expect(observations.map(row => [row.window_id.split("|").at(-1), row.cadence_hours])).toEqual(
      stored.map(window => [window.end, window.window_minutes / 60]));
    expect(observations.map(row => row.start_ts)).toEqual(stored.map(window => window.readings[0]!.ts));
    const response = handlePlanCapacity(
      ctx,
      new URL("http://localhost/api/plan-capacity?provider=claude&plan_id=claude-pro&window_kind=weekly_all&as_of=2026-06-08")
    );
    expect(response.status).toBe(200);
  });
  it("keeps an exact-boundary ending measured window old and a boundary-starting window new", async () => {
    const ctx = mockAppContext({
      windows: [{
        subscription: "glm-old",
        kind: "weekly",
        segments: [
          { from: "2026-01-01", period_hours: 336, anchor_ts: "2026-01-15T00:00:00.000Z" },
          { from: "2026-06-01", period_hours: 168, anchor_ts: "2026-06-08T00:00:00.000Z" },
        ],
      }, {
        subscription: "glm-work",
        kind: "weekly",
        segments: [
          { from: "2026-01-01", period_hours: 336, anchor_ts: "2026-01-15T00:00:00.000Z" },
          { from: "2026-06-01", period_hours: 168, anchor_ts: "2026-06-08T00:00:00.000Z" },
        ],
      }],
    });
    ctx.accounts.subscriptions?.push({ id: "glm-old", vendor: "glm" }, { id: "glm-work", vendor: "glm" });
    // One physical source changes owner on the boundary; its machine does not change with its account.
    ctx.accounts.sources.push({ vendor: "glm", machine: "EXAMPLE-NEW", home: `${ARCHIVE_LOGICAL_ROOT}/glm/EXAMPLE-NEW` });
    ctx.sqlite.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE account_periods(id INTEGER PRIMARY KEY,provider TEXT NOT NULL,source TEXT NOT NULL,from_ts TEXT NOT NULL,
        until_ts TEXT,account TEXT NOT NULL,origin TEXT NOT NULL,first_seen TEXT,last_seen TEXT,readings INTEGER NOT NULL DEFAULT 0,evidence TEXT NOT NULL)`);
    replaceDeclaredPeriods(ctx.sqlite, ACCOUNT_PERIODS, [
      { provider: "glm", subject: "glm/example-new", value: "glm-old", from: "2000-01-01", until: "2026-06-01",
        origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" },
      { provider: "glm", subject: "glm/example-new", value: "glm-work", from: "2026-06-01", until: null,
        origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" },
    ]);
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    for (const [ts, reset] of [
      ["2026-05-31T23:00:00.000Z", "2026-06-01T00:00:00.000Z"],
      ["2026-06-01T00:00:00.000Z", "2026-06-08T00:00:00.000Z"],
    ] as const) {
      ctx.sqlite.run(
        `INSERT INTO probe_windows
         (provider, subject, kind, ts, used_percent, window_minutes, resets_at, ok, machine)
         VALUES ('glm', 'glm-work', 'weekly', ?, 25, 10080, ?, 1, 'EXAMPLE-NEW')`,
        [ts, reset]
      );
    }
    // OpenCode records the vendor of each call; only the GLM plan's calls draw on its windows.
    ctx.sqlite.exec("ALTER TABLE oc_events ADD COLUMN provider TEXT; ALTER TABLE oc_events ADD COLUMN message_id TEXT");
    ctx.sqlite.run(`
      INSERT INTO oc_events (ts, store, model, provider, message_id, in_tok, cache_read, cache_write, out_tok)
      VALUES ('2026-05-31T12:00:00.000Z', 'EXAMPLE-NEW', 'glm-4.5', 'zai-coding-plan', 'message-1', 100, 0, 0, 20);
    `);
    ctx.sqlite.run(`
      INSERT INTO oc_events (ts, store, model, provider, message_id, in_tok, cache_read, cache_write, out_tok)
      VALUES ('2026-06-02T12:00:00.000Z', 'EXAMPLE-NEW', 'glm-4.5', 'zai-coding-plan', 'message-2', 200, 0, 0, 40);
    `);
    prepareProbeReaderFixture(ctx.sqlite, [
      { ...probeReaderFixtureSource("glm", "glm-old"), machine: "EXAMPLE-NEW" },
      { ...probeReaderFixtureSource("glm", "glm-work"), machine: "EXAMPLE-NEW" },
    ]);
    // The producer reads the same cadence declarations as the screen (cycles.json in production).
    prepareLimitWindowsFixture(ctx.sqlite, { sources: ctx.accounts.sources, subscriptions: ctx.accounts.subscriptions, cycles: ctx.cycles });
    const oldResponse = await apiHandleWindows(ctx, new URL("http://localhost/api/windows?account=glm-old"));
    const oldPayload = (await oldResponse.json()) as { windows: any[] };
    const old = oldPayload.windows.find((row) => row.resetIso === "2026-06-01T00:00:00.000Z");
    const response = await apiHandleWindows(ctx, new URL("http://localhost/api/windows?account=glm-work"));
    const payload = (await response.json()) as { windows: any[] };
    const current = payload.windows.find((row) => row.resetIso === "2026-06-08T00:00:00.000Z");
    expect(old.windowHours).toBe(336);
    expect(old.startIso).toBe("2026-05-18T00:00:00.000Z");
    expect(old.cadenceSegmentFrom).toBe("2026-01-01");
    expect(old.cadencePeriodSource).toBe("declared");
    expect(old.cadenceAnchorSource).toBe("probe");
    expect(old.activityShape.at(-1)).toEqual({ t: 100, amount: 120 });
    expect(old.trafficByMachine).toEqual([{ machine: "EXAMPLE-NEW", amount: 120 }]);
    expect(current.windowHours).toBe(168);
    expect(current.startIso).toBe("2026-06-01T00:00:00.000Z");
    expect(current.cadenceSegmentFrom).toBe("2026-06-01");
    expect(current.cadencePeriodSource).toBe("declared");
    expect(current.cadenceAnchorSource).toBe("probe");
    expect(current.activityShape.at(-1)).toEqual({ t: 100, amount: 240 });
    expect(current.trafficByMachine).toEqual([{ machine: "EXAMPLE-NEW", amount: 240 }]);
    expect(payload.windows.some((row) => row.resetIso === "2026-06-01T00:00:00.000Z")).toBe(false);
  });
  it("keeps distinct limit groups separate and serves Grok probe history", async () => {
    const ctx = mockAppContext({ windows: [] });
    ctx.accounts.subscriptions?.push({
      id: "grok-work",
      vendor: "grok",
      home: "grok-store",
      machine: "EXAMPLE-MAIN",
    });
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    const now = Date.now();
    const currentReset = new Date(now + 3 * 24 * 3_600_000).toISOString();
    const oldReset = new Date(now - 4 * 24 * 3_600_000).toISOString();
    const olderReset = new Date(now - 11 * 24 * 3_600_000).toISOString();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO probe_windows
         (provider, subject, kind, scope, limit_group, plan, ts, used_percent, window_minutes, resets_at, ok)
       VALUES ('grok', 'grok-work', 'weekly', 'shared-scope', ?, ?, ?, ?, 10080, ?, 1)`
    );
    for (const [group, reset, base, plans] of [
      ["subscription", olderReset, 15, ["SuperGrok", "Max", "SuperGrok"]],
      ["subscription", oldReset, 20, ["Max", "SuperGrok", "Max"]],
      ["subscription", currentReset, 30, ["SuperGrok", "SuperGrok", "SuperGrok"]],
      ["bonus", currentReset, 10, ["SuperGrok", "SuperGrok", "SuperGrok"]],
    ] as const) {
      const resetMs = Date.parse(reset);
      for (let daysBeforeReset = 6; daysBeforeReset >= 4; daysBeforeReset--) {
        insert.run(
          group,
          plans[6 - daysBeforeReset]!,
          new Date(resetMs - daysBeforeReset * 24 * 3_600_000).toISOString(),
          base + 6 - daysBeforeReset,
          reset
        );
      }
    }

    const response = await handleWindows(ctx, new URL("http://localhost/api/windows?account=grok-work"));
    const payload = (await response.json()) as {
      provider: string;
      source: string;
      windows: Array<{
        isCurrent: boolean;
        counterKey: string;
        sampledAtIso: string | null;
        regimeKey: string;
      }>;
    };

    expect(payload.provider).toBe("grok");
    expect(payload.source).toBe("probe");
    expect(payload.windows).toHaveLength(4);
    expect(payload.windows.filter((window) => window.isCurrent).map((window) => window.counterKey).sort()).toEqual([
      "grok:kind=value(weekly):group=value(bonus):scope=value(shared-scope)",
      "grok:kind=value(weekly):group=value(subscription):scope=value(shared-scope)",
    ]);
    expect(payload.windows.every((window) => window.sampledAtIso != null)).toBe(true);
    const mixedPlanHistory = payload.windows.filter(
      (window) => !window.isCurrent && window.counterKey === "grok:kind=value(weekly):group=value(subscription):scope=value(shared-scope)"
    );
    expect(new Set(mixedPlanHistory.map((window) => window.regimeKey)).size).toBe(2);
  });

  it("isolates two historical probe windows when their plan provenance is unknown", async () => {
    const ctx = mockAppContext({ windows: [] });
    ctx.accounts.subscriptions?.push({ id: "grok-work", vendor: "grok" });
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    const now = Date.now();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO probe_windows
         (provider, subject, kind, limit_group, ts, used_percent, window_minutes, resets_at, ok)
       VALUES ('grok', 'grok-work', 'weekly', 'subscription', ?, 40, 10080, ?, 1)`
    );
    for (const daysAgo of [4, 11]) {
      const reset = new Date(now - daysAgo * 24 * 3_600_000).toISOString();
      insert.run(new Date(Date.parse(reset) - 5 * 24 * 3_600_000).toISOString(), reset);
    }
    const currentReset = new Date(now + 3 * 24 * 3_600_000).toISOString();
    ctx.sqlite.run(
      `INSERT INTO probe_windows
         (provider, subject, kind, limit_group, plan, ts, used_percent, window_minutes, resets_at, ok)
       VALUES ('grok', 'grok-work', 'weekly', 'subscription', 'SuperGrok', ?, 50, 10080, ?, 1)`,
      [new Date(now).toISOString(), currentReset]
    );

    const response = await handleWindows(ctx, new URL("http://localhost/api/windows?account=grok-work"));
    const payload = (await response.json()) as { windows: Array<{ isCurrent: boolean; regimeKey: string }> };
    const unknownHistory = payload.windows.filter((window) => !window.isCurrent);

    expect(unknownHistory).toHaveLength(2);
    expect(new Set(unknownHistory.map((window) => window.regimeKey)).size).toBe(2);
    expect(unknownHistory.every((window) => window.regimeKey.includes("unknown-plan@"))).toBe(true);
  });

  it("takes the window's plan from plan periods, not from the labels of its readings", async () => {
    const ctx = mockAppContext({ windows: [] });
    ctx.accounts.subscriptions?.push({ id: "grok-work", vendor: "grok", home: "grok-store" });
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    ctx.sqlite.run(`CREATE TABLE plan_periods (
      id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, from_ts TEXT NOT NULL, until_ts TEXT,
      plan TEXT NOT NULL, amount_minor INTEGER, currency TEXT, origin TEXT NOT NULL, first_seen TEXT, last_seen TEXT,
      readings INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL)`);
    const day = 24 * 3_600_000;
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO probe_windows
         (provider, subject, kind, limit_group, plan, ts, used_percent, window_minutes, resets_at, ok)
       VALUES ('grok', 'grok-work', 'weekly', 'subscription', ?, ?, 40, 10080, ?, 1)`
    );
    // Readings of one window disagree about the plan; the declared period says heavy throughout.
    for (const daysAgo of [4, 11, 18]) {
      const resetMs = now - daysAgo * day;
      insert.run("SuperGrok", iso(resetMs - 5 * day), iso(resetMs));
      insert.run("Heavy", iso(resetMs - 3 * day), iso(resetMs));
    }
    const period = ctx.sqlite.prepare(
      `INSERT INTO plan_periods (provider, account, from_ts, until_ts, plan, origin, evidence) VALUES ('grok', 'grok-work', ?, ?, ?, 'declared', 'owner')`
    );
    // The plan changes inside the oldest window only.
    period.run(iso(now - 60 * day), iso(now - 20 * day), "supergrok");
    period.run(iso(now - 20 * day), null, "heavy");

    prepareProbeReader(ctx);
    const response = await handleWindows(ctx, new URL("http://localhost/api/windows?account=grok-work"));
    const payload = (await response.json()) as { windows: Array<{ isCurrent: boolean; resetIso: string; regimeKey: string }> };
    const byAge = payload.windows.filter((window) => !window.isCurrent).sort((a, b) => Date.parse(b.resetIso) - Date.parse(a.resetIso));

    expect(byAge).toHaveLength(3);
    expect(byAge[0]!.regimeKey).toBe(byAge[1]!.regimeKey);
    expect(byAge[0]!.regimeKey).toContain(":heavy:");
    expect(byAge[2]!.regimeKey).toContain(":mixed-plan@");
  });

  it("keeps a legacy probe without physical evidence unassigned after preparation", async () => {
    const ctx = mockAppContext({ windows: [] });
    replaceProbeWindowTable(ctx, { machine: false });
    prepareProbeReaderFixture(ctx.sqlite, []);
    ctx.accounts.subscriptions?.push({ id: "glm-work", vendor: "glm" });
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    const reset = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    ctx.sqlite.run(
      `INSERT INTO probe_windows
         (provider, subject, kind, limit_group, plan, ts, used_percent, allowance, window_minutes, resets_at, ok)
       VALUES ('glm', 'glm-work', 'weekly', 'credits', 'GLM Pro', ?, 25, 1000, 10080, ?, 1)`,
      [new Date().toISOString(), reset]
    );
    ctx.sqlite.run(
      `INSERT INTO probe_windows
         (provider, subject, kind, limit_group, plan, ts, used_percent, allowance, window_minutes, resets_at, ok)
       VALUES ('glm', 'glm-work', 'weekly', 'credits', 'wrong-plan', ?, 99, 1000, 10080, ?, 1)`,
      [new Date(Date.now() + 1_000).toISOString(), reset]
    );

    // The published (empty) evidence answers while the new readings' evidence is written (golden rules §9).
    const pending = await apiHandleWindows(ctx, new URL("http://localhost/api/windows?account=glm-work"));
    expect(pending.status).toBe(200);
    expect((await pending.json() as { windows: unknown[] }).windows).toEqual([]);
    prepareProbeReaderFixture(ctx.sqlite, []);
    const response = await apiHandleWindows(ctx, new URL("http://localhost/api/windows?account=glm-work"));
    expect((await response.json() as { windows: unknown[] }).windows).toEqual([]);
  });

  it("reads a hand-built probe table with the current schema", async () => {
    const ctx = mockAppContext({ windows: [] });
    replaceProbeWindowTable(ctx, { machine: true });
    ctx.accounts.subscriptions?.push({ id: "glm-work", vendor: "glm" });
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    const reset = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    ctx.sqlite.run(
      `INSERT INTO probe_windows
         (provider, subject, kind, limit_group, plan, machine, ts, used_percent, allowance, window_minutes, resets_at, ok)
       VALUES ('glm', 'glm-work', 'weekly', 'credits', 'GLM Pro', 'EXAMPLE-OLD', ?, 25, 1000, 10080, ?, 1)`,
      [new Date().toISOString(), reset]
    );

    prepareProbeReaderFixture(ctx.sqlite, [{ ...probeReaderFixtureSource("glm", "glm-work"), machine: "EXAMPLE-OLD" }]);
    const response = await apiHandleWindows(ctx, new URL("http://localhost/api/windows?account=glm-work"));
    const payload = (await response.json()) as { windows: Array<{ sampleMachine: string | null }> };

    expect(response.status).toBe(200);
    expect(payload.windows).toHaveLength(1);
    expect(payload.windows[0]?.sampleMachine).toBe("EXAMPLE-OLD");
  });

  it("isolates GLM history when numeric allowance provenance is absent", async () => {
    const ctx = mockAppContext({ windows: [] });
    ctx.accounts.subscriptions?.push({ id: "glm-work", vendor: "glm" });
    ctx.eras = buildEraIndex(ctx.accounts.subscriptions ?? []);
    const now = Date.now();
    for (const [reset, allowance] of [
      [new Date(now - 11 * 24 * 3_600_000).toISOString(), null],
      [new Date(now - 4 * 24 * 3_600_000).toISOString(), null],
      [new Date(now + 3 * 24 * 3_600_000).toISOString(), 1000],
    ] as const) {
      ctx.sqlite.run(
        `INSERT INTO probe_windows
           (provider, subject, kind, limit_group, plan, ts, used_percent, allowance, window_minutes, resets_at, ok)
         VALUES ('glm', 'glm-work', 'weekly', 'credits', 'GLM Pro', ?, 40, ?, 10080, ?, 1)`,
        [new Date(Date.parse(reset) - 24 * 3_600_000).toISOString(), allowance, reset]
      );
    }

    const response = await handleWindows(ctx, new URL("http://localhost/api/windows?account=glm-work"));
    const payload = (await response.json()) as { windows: Array<{ isCurrent: boolean; regimeKey: string }> };
    const history = payload.windows.filter((window) => !window.isCurrent);

    expect(history).toHaveLength(2);
    expect(history.every((window) => window.regimeKey.includes("unknown-allowance@"))).toBe(true);
    expect(new Set(history.map((window) => window.regimeKey)).size).toBe(2);
  });

  it("attaches a Claude scoped counter to exactly one matching parent with the same reset", async () => {
    const ctx = mockAppContext({ windows: [] });
    const reset = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const ts = new Date(Date.parse(reset) - 4 * 24 * 3_600_000).toISOString();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO probe_windows
         (provider, subject, kind, scope, limit_group, plan, ts, used_percent, window_minutes, resets_at, ok)
       VALUES ('claude', 'claude-work', ?, ?, ?, 'pro', ?, ?, 10080, ?, 1)`
    );
    for (const [group, parentPercent, scopedPercent] of [
      ["main-a", 30, 10],
      ["main-b", 60, 20],
    ] as const) {
      insert.run("weekly_all", null, group, ts, parentPercent, reset);
      insert.run("weekly_scoped", "Fable", group, ts, scopedPercent, reset);
    }
    const start = new Date(Date.parse(reset) - 7 * 24 * 3_600_000).toISOString();
    const middle = new Date(Date.parse(reset) - 3 * 24 * 3_600_000).toISOString();
    for (const [eventTs, model, input, output] of [
      [start, "claude-3-7-sonnet-20250219", 100, 20],
      [middle, "claude-3-5-haiku-20241022", 50, 10],
      [reset, "claude-3-5-haiku-20241022", 900, 99],
    ] as const) {
      ctx.sqlite.run(
        `INSERT INTO claude_events
           (ts, store, model, in_uncached, in_cache_read, in_cache_write, out_total, subscription_id)
         VALUES (?, 'app', ?, ?, 0, 0, ?, 'claude-work')`,
        [eventTs, model, input, output]
      );
    }

    declareClaudeLabelPeriods(ctx.sqlite);
    prepareProbeReader(ctx);
    const response = await handleWindows(ctx, new URL("http://localhost/api/windows?account=claude-work"));
    const payload = (await response.json()) as {
      windows: Array<{
        counterKey: string;
        activityShape: Array<{ t: number; amount: number }>;
        trafficByMachine: Array<{ machine: string | null; amount: number }>;
        sublimits: Array<{
          counterKey: string;
          usedPercent: number;
          activityShape: Array<{ t: number; amount: number }>;
          trafficByMachine: Array<{ machine: string | null; amount: number }>;
        }>;
      }>;
    };
    const parents = payload.windows.filter((window) => window.counterKey.includes(":kind=value(weekly_all):"));
    const parentA = parents.find((window) => window.counterKey === "claude:kind=value(weekly_all):group=value(main-a):scope=none");
    const parentB = parents.find((window) => window.counterKey === "claude:kind=value(weekly_all):group=value(main-b):scope=none");

    expect(parentA?.sublimits).toEqual([expect.objectContaining({
      counterKey: "claude:kind=value(weekly_scoped):group=value(main-a):scope=value(Fable)",
      usedPercent: 10,
    })]);
    expect(parentB?.sublimits).toEqual([expect.objectContaining({
      counterKey: "claude:kind=value(weekly_scoped):group=value(main-b):scope=value(Fable)",
      usedPercent: 20,
    })]);
    expect(parentA?.activityShape.at(-1)).toEqual({ t: 100, amount: 180 });
    expect(parentA?.trafficByMachine).toEqual([{ machine: "EXAMPLE-MAIN", amount: 180 }]);
    expect(parentA?.sublimits[0]?.activityShape.at(-1)).toEqual({ t: 100, amount: 60 });
    expect(parentA?.sublimits[0]?.trafficByMachine).toEqual([{ machine: "EXAMPLE-MAIN", amount: 60 }]);
  });

  it("reads Claude Code's limit refusal as the 100% the account probe missed before a plan change", async () => {
    const ctx = mockAppContext({ windows: [] });
    const hour = 3_600_000;
    const reset = new Date(Date.now() + 36 * hour).toISOString();
    const start = Date.parse(reset) - 168 * hour;
    const at = (hoursAfterStart: number) => new Date(start + hoursAfterStart * hour).toISOString();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO probe_windows (provider, subject, kind, scope, ts, used_percent, window_minutes, resets_at, ok)
       VALUES ('claude', 'claude-work', 'weekly_all', NULL, ?, ?, 10080, ?, 1)`
    );
    // 88% is the last account reading; the probe then fails until the plan change restarts the meter.
    for (const [ts, all] of [[at(10), 40], [at(60), 70], [at(80), 88], [at(94), 0], [at(110), 5], [at(130), 11]] as const) insert.run(ts, all, reset);
    // The account owns the transcript's source through its declared period, as for its events.
    ctx.sqlite.query(`INSERT INTO claude_events (store, ts, path, subscription_id) VALUES ('live', ?, 'seed', 'claude-work')`).run(at(1));
    declareClaudeLabelPeriods(ctx.sqlite);
    ctx.sqlite.exec(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0043_claude_limit_hits.sql"), "utf8").replaceAll("--> statement-breakpoint", ""));
    const refusal = ctx.sqlite.prepare(`INSERT INTO claude_limit_hits (store, call_id, ts, limit_type, status, resets_at, path)
      VALUES ('live', ?, ?, ?, 'rejected', ?, ?)`);
    const transcript = `${ARCHIVE_LOGICAL_ROOT}/claude/claude-work/session.jsonl`;
    refusal.run("refused", at(86), "seven_day", reset, transcript);
    // A refusal of another counter or of another source's account does not touch this window.
    refusal.run("session", at(87), "five_hour", at(88), transcript);
    refusal.run("elsewhere", at(90), "seven_day", reset, `${ARCHIVE_LOGICAL_ROOT}/claude/other/session.jsonl`);
    prepareProbeReader(ctx);
    const response = await handleWindows(ctx, new URL("http://localhost/api/windows?account=claude-work"));
    const payload = (await response.json()) as {
      windows: Array<{ counterKey: string; regimeKey: string; usedPercent: number; percentBasis: string; startIso: string;
        resetIso: string; sampledAtIso: string; note: string; shape: Array<{ t: number; pct: number }> | null }>;
    };
    const [before, after] = payload.windows
      .filter((window) => window.counterKey === "claude:kind=value(weekly_all):group=none:scope=none" && window.regimeKey.includes(":segment@"))
      .sort((a, b) => a.startIso.localeCompare(b.startIso));
    expect([before?.usedPercent, before?.percentBasis, before?.sampledAtIso, before?.resetIso]).toEqual([100, "measured", at(86), at(94)]);
    expect(before?.shape?.map((point) => point.pct)).toEqual([40, 70, 88, 100]);
    expect(before?.note).toContain("Limit osiągnięty");
    expect(after?.usedPercent).toBe(11);
    // The five-hour refusal starts a session window of its own at 100%.
    expect(payload.windows.some((window) => window.counterKey.includes("kind=value(session)") && window.usedPercent === 100)).toBe(true);
  });

  it("splits a Claude window at a meter drop that keeps the reset, sub-limit included", async () => {
    const ctx = mockAppContext({ windows: [] });
    const hour = 3_600_000;
    const now = Date.now();
    const reset = new Date(now + 36 * hour).toISOString();
    const start = Date.parse(reset) - 168 * hour;
    const at = (hoursAfterStart: number) => new Date(start + hoursAfterStart * hour).toISOString();
    const insert = ctx.sqlite.prepare(
      `INSERT INTO probe_windows
         (provider, subject, kind, scope, ts, used_percent, window_minutes, resets_at, ok)
       VALUES ('claude', 'claude-work', ?, ?, ?, ?, 10080, ?, 1)`
    );
    // Max 5x → 20x on the fourth day: 88% → 0% (Fable 96% → 0%), the reset stays where it was.
    const dropAt = at(94);
    for (const [ts, all, fable] of [[at(10), 40, 50], [at(60), 70, 80], [at(80), 88, 96], [dropAt, 0, 0], [at(110), 5, 0], [at(130), 11, 0]] as const) {
      insert.run("weekly_all", null, ts, all, reset);
      insert.run("weekly_scoped", "Fable", ts, fable, reset);
    }
    declareClaudeLabelPeriods(ctx.sqlite);
    prepareProbeReader(ctx);
    const response = await handleWindows(ctx, new URL("http://localhost/api/windows?account=claude-work"));
    const payload = (await response.json()) as {
      windows: Array<{
        key: string; counterKey: string; isCurrent: boolean; usedPercent: number; startIso: string; resetIso: string;
        windowHours: number; elapsedPercent: number; ppAhead: number; regimeKey: string; note: string;
        shape: Array<{ t: number; pct: number }> | null; sublimits: Array<{ usedPercent: number }>;
        counterSegment?: unknown;
      }>;
    };
    const measured = payload.windows
      .filter((window) => window.counterKey === "claude:kind=value(weekly_all):group=none:scope=none" && window.regimeKey.includes(":segment@"))
      .sort((a, b) => a.startIso.localeCompare(b.startIso));

    expect(measured).toHaveLength(2);
    const [before, after] = measured as [typeof measured[0], typeof measured[0]];
    // The closed segment: from the server's window start to the first reading after the drop.
    expect([before.isCurrent, before.usedPercent, before.startIso, before.resetIso, before.windowHours]).toEqual([false, 88, at(0), dropAt, 168]);
    expect(before.shape?.map((point) => point.pct)).toEqual([40, 70, 88]);
    expect(before.sublimits.map((sub) => sub.usedPercent)).toEqual([96]);
    // The running segment starts at the drop and ends at the unchanged reset; time is its own share.
    expect([after.isCurrent, after.usedPercent, after.startIso, after.resetIso, after.windowHours]).toEqual([true, 11, dropAt, reset, 168]);
    expect(after.shape?.map((point) => point.pct)).toEqual([0, 5, 11]);
    expect(after.shape?.[0]?.t).toBe(0);
    expect(after.elapsedPercent).toBeCloseTo(((now - Date.parse(dropAt)) / (Date.parse(reset) - Date.parse(dropAt))) * 100, 0);
    expect(after.ppAhead).toBeCloseTo(11 - after.elapsedPercent, 0);
    expect(after.sublimits.map((sub) => sub.usedPercent)).toEqual([0]);
    expect(after.note).toContain("z 88% do 0%");
    expect(before.counterSegment).toEqual({ startDrop: null, endDrop: { before: 88, after: 0 } });
    expect(after.counterSegment).toEqual({ startDrop: { before: 88, after: 0 }, endDrop: null });
    expect(before.key).not.toBe(after.key);
    expect(before.regimeKey).not.toBe(after.regimeKey);
  });
});
