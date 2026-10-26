import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import type { SourceDeclaration } from "./archive-source";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import { createTestDatabase } from "../sync/test-support";
import { installAnalysisTracking } from "../db/analysis";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { markLimitWindowsDirty } from "../db/limit-windows";
import { WindowUsagePreparing } from "./window-usage";
import { Database } from "../db/sqlite";
import { createFetchHandler, handlePlanCapacity, type AppContext } from "./api";
import {
  GAUGE_QUALITY_MIN_SAMPLES,
  GAUGE_QUALITY_MIN_SPAN_PP,
} from "./capacity-equivalents";
import {
  CONSISTENCY_RELATIVE_MAX,
  buildPlanCapacity,
  collectPlanWindowObservations,
  type PlanCapacityResult,
  type PlanWindowObservation,
  type TokenRates,
} from "./plan-capacity";
import type { RateCard } from "./pricing";
import { encodeClaudeCodeProductShare } from "../providers/adapters/claude";
import type { PlansCatalog, TokenVector } from "./plans-catalog";
import { declareClaudeLabelPeriods } from "./subscription-reader.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { prepareProbeReaderFixture, probeReaderFixtureSource } from "./probe-reader.fixture";
import { ACCOUNT_PERIODS, PLAN_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import type { DatedPeriod } from "./account-periods";

const LIMIT_WINDOW_BEGINNING = -8_640_000_000_000_000;
/** Runs `read` recording every statement that reads Claude calls (the event table or the ledger's facts). */
function measureCallReads<T>(db: Database, read: () => T): { value: T; callReads: string[] } {
  const callReads: string[] = [], query = db.query;
  db.query = function (this: Database, statement: string, ...rest: unknown[]) {
    if (/\b(?:FROM|JOIN)\s+(?:claude_events|usage_ledger_facts)\b/i.test(statement)) callReads.push(statement);
    return query.call(this, statement, ...rest as []);
  } as typeof db.query;
  try { return { value: read(), callReads }; } finally { db.query = query; }
}
/** Plan history lives in plan periods only: one declared plan per row, `until` inclusive as the fixtures state it. */
function planHistory(provider: string, rows: Array<{ subscription: string; plan: string; from: string; until?: string }>): DatedPeriod[] {
  return rows.map((row) => ({ provider, subject: row.subscription, value: row.plan, from: row.from,
    until: row.until ? new Date(Date.parse(`${row.until}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null,
    origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }));
}
/** The server reads plan periods from the database. */
function storePlanHistory(db: Database, periods: DatedPeriod[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS plan_periods (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL,
    from_ts TEXT NOT NULL, until_ts TEXT, plan TEXT NOT NULL, amount_minor INTEGER, currency TEXT, origin TEXT NOT NULL,
    first_seen TEXT, last_seen TEXT, readings INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL)`);
  replaceDeclaredPeriods(db, PLAN_PERIODS, periods);
}

/** The maintenance worker's ledger and window sums, which Codex plan observations read. */
function prepareCodexWindowSums(db: Database, ctx: { homeToSubId: Map<string, string>; accounts: { sources?: readonly SourceDeclaration[] } }) {
  prepareCodexLedgerFixture(db, rateCard(), ctx.homeToSubId, ctx.accounts.sources);
  prepareWindowUsageFixture(db, { rateCards: rateCard() });
}
/** The local profile copies an archive folder whose account period names codex1 (stage 4, W6). */
function codex1Source(db: Database, home: string) {
  const source = { id: "codex1", vendor: "codex", home: `${ARCHIVE_LOGICAL_ROOT}/codex/test`, source_home: home };
  declareCodexEraPeriods(db, [source]);
  preparePlanProbeReader(db, [{ ...source, machine: "fixture-test", login: "test" }]);
  return source;
}
function preparePlanProbeReader(db: Database, sources: ReturnType<typeof probeReaderFixtureSource>[],
  accountForRow: Parameters<typeof prepareProbeReaderFixture>[2] = row => row.subject) {
  const columns = new Set((db.query("PRAGMA table_info(probe_windows)").all() as { name: string }[]).map(row => row.name));
  for (const [name, type] of [["machine", "TEXT"], ["profile", "TEXT"], ["extra", "TEXT"], ["limit_group", "TEXT"]] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE probe_windows ADD COLUMN ${name} ${type}`);
  }
  const rows = db.query("SELECT id, provider, subject, machine, profile, extra FROM probe_windows").all() as Array<{
    id: number; provider: string; subject: string; machine: string | null; profile: string | null; extra: string | null;
  }>;
  for (const row of rows) {
    const source = sources.find(candidate => candidate.vendor === row.provider
      && candidate.id.toLowerCase() === row.subject.toLowerCase());
    if (!source) continue;
    let extra: Record<string, unknown> = {};
    try {
      const parsed: unknown = row.extra ? JSON.parse(row.extra) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extra = parsed as Record<string, unknown>;
    } catch { /* malformed fixture metadata is retained only as opaque source input */ }
    db.query("UPDATE probe_windows SET machine=?, profile=?, extra=?, limit_group=? WHERE id=?").run(
      source.machine, source.login, JSON.stringify({ ...extra, home: source.source_home }),
      source.vendor === "codex" ? "codex" : null, row.id);
  }
  prepareProbeReaderFixture(db, sources, accountForRow);
}
/**
 * A full-schema Claude database for plan observations: probe readings and Claude Code calls of the given
 * accounts (each in its own archive folder; `null` is a folder no account owns), then what the maintenance
 * worker publishes after them: account periods and limit windows, the usage ledger and window usage.
 */
function claudePlanDb() {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  claudeDatabases.push(() => { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  installAnalysisTracking(db);
  let calls = 0;
  const folder = (account: string | null) => account ? `${probeReaderFixtureSource("claude", account).home}` : `${ARCHIVE_LOGICAL_ROOT}/claude/nobody`;
  return {
    db,
    probe(subject: string, ts: string, kind: string, used: number, reset: string, extra: string | null = null, scope: string | null = null) {
      db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,scope,reported_percent_side,used_percent,window_minutes,resets_at,ok,extra)
        VALUES('claude',?,?,?,?,'used',?,10080,?,1,?)`).run(subject, ts, kind, scope, used, reset, extra);
    },
    event(account: string | null, ts: string, tokens: number, options: { model?: string; entrypoint?: string | null; output?: number } = {}) {
      const id = `call-${calls++}`;
      db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,entrypoint,cc_version,in_uncached,out_total)
        VALUES('fixture',?,?,?,?,?,'standard',?,?,?,?)`).run(id, `session-${id}`, `${folder(account)}/${id}.jsonl`, ts,
        options.model ?? "claude-opus-5", options.entrypoint === undefined ? "cli" : options.entrypoint,
        options.entrypoint === undefined || options.entrypoint === "cli" ? "2.1.0" : null, tokens, options.output ?? 0);
    },
    publish(accounts: readonly string[], accountForRow?: Parameters<typeof prepareProbeReaderFixture>[2]) {
      preparePlanProbeReader(db, accounts.map(account => probeReaderFixtureSource("claude", account)), accountForRow);
      fillUsageLedgerFixture(db, rateCard(), ["claude"]);
      prepareWindowUsageFixture(db, { rateCards: rateCard(), claudeGauge: {}, manualCapacity: () => [], cycles: { windows: [] } });
    },
  };
}
const claudeDatabases: Array<() => void> = [];
/** A full-schema fixture publishes probe facts one by one; under a loaded machine it needs more than the default 5 s. */
const CLAUDE_FIXTURE_MS = 60_000;
afterEach(() => { while (claudeDatabases.length) claudeDatabases.pop()!(); });
/** Hourly readings of one week from 0% to `top`%. */
function claudeWeek(f: ReturnType<typeof claudePlanDb>, subject: string, kind = "weekly", top = 50, extraAt?: (i: number, ts: string) => string | null,
  scope: string | null = null) {
  const startMs = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < 60; i++) {
    const ts = new Date(startMs + i * 3_600_000).toISOString();
    f.probe(subject, ts, kind, (i / 59) * top, "2026-01-08T00:00:00.000Z", extraAt?.(i, ts) ?? null, scope);
  }
}
it("plan observations follow a corrected account period while original probe stamps stay unchanged", () => {
  const f = claudePlanDb(), db = f.db;
  f.probe("old", "2026-01-01T12:00:00Z", "weekly_all", 10, "2026-01-08T00:00:00Z");
  f.probe("old", "2026-01-02T12:00:00Z", "weekly_all", 20, "2026-01-08T00:00:00Z");
  const source = probeReaderFixtureSource("claude", "old");
  f.publish(["old"], () => "old");
  const ctx = { sqlite: db, plansCatalog: catalog(),
    accounts: splitProbeReaderFixtureConfig([source, { id: "moved", vendor: "claude" }]),
    planPeriods: planHistory("claude", ["old", "moved"].map(subscription => ({ subscription, plan: "claude-pro", from: "2025-01-01" }))) };
  const query = { provider: "claude", plan_id: "claude-pro", window_kind: "weekly" };
  const before = collectPlanWindowObservations(ctx, query);
  expect(before).toHaveLength(1);
  const original = db.query("SELECT subject,extra FROM probe_windows ORDER BY id").all();
  const periods = loadPeriods(db, ACCOUNT_PERIODS).filter(period => period.origin === "declared");
  replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods.map(period => ({ ...period, value: "moved" })));
  markLimitWindowsDirty(db, "claude", "*", LIMIT_WINDOW_BEGINNING);
  f.publish(["old"], () => "old");
  const after = collectPlanWindowObservations(ctx, query);
  expect(after).toEqual(before.map(row => ({ ...row, subscription_id: "moved",
    window_id: row.window_id.replace(/^old\|/, "moved|") })));
  expect(db.query("SELECT subject,extra FROM probe_windows ORDER BY id").all()).toEqual(original);
}, CLAUDE_FIXTURE_MS);
it("a Claude meter that falls inside a week splits it into two stored windows, neither with a falling meter", () => {
  // A plan change zeroes the meter but keeps the reset (Max 5x → Max 20x, 24.09.2026).
  const f = claudePlanDb();
  for (const [ts, used] of [["2026-01-01T12:00:00Z", 60], ["2026-01-02T12:00:00Z", 88], ["2026-01-03T12:00:00Z", 0], ["2026-01-04T12:00:00Z", 4]] as const)
    f.probe("seat", ts, "weekly_all", used, "2026-01-08T00:00:00Z");
  f.publish(["seat"]);
  const ctx = { sqlite: f.db, plansCatalog: catalog(), accounts: splitProbeReaderFixtureConfig([probeReaderFixtureSource("claude", "seat")]),
    planPeriods: planHistory("claude", [{ subscription: "seat", plan: "claude-pro", from: "2025-01-01" }]) };
  const query = { provider: "claude", plan_id: "claude-pro", window_kind: "weekly" };
  // The limit-window register ends a window at the drop, as it does for Codex; each part keeps its own meter.
  expect(collectPlanWindowObservations(ctx, query).map(row => [row.start_ts, row.end_ts, row.peak_percent, row.exclusion_reason ?? null])).toEqual([
    ["2026-01-01T12:00:00.000Z", "2026-01-02T12:00:00.000Z", 88, null], ["2026-01-03T12:00:00.000Z", "2026-01-04T12:00:00.000Z", 4, null]]);
}, CLAUDE_FIXTURE_MS);

function vector(n: number): TokenVector {
  return {
    in_uncached: n,
    in_cache_read: n,
    in_cache_write_5m: n,
    in_cache_write_1h: n,
    out_total: n,
  };
}
const CACHE_HEAVY: TokenVector = {
  in_uncached: 5_000_000,
  in_cache_read: 495_000_000,
  in_cache_write_5m: 0,
  in_cache_write_1h: 0,
  out_total: 2_500_000,
};
const TYPE_RATES: TokenRates = {
  in_uncached: 5,
  in_cache_read: 0.5,
  in_cache_write_5m: 6.25,
  in_cache_write_1h: 10,
  out_total: 25,
};
const PLUS_REF: TokenVector = {
  in_uncached: 80_000,
  in_cache_read: 8_000_000,
  in_cache_write_5m: 0,
  in_cache_write_1h: 0,
  out_total: 40_000,
};
function catalog(): PlansCatalog {
  return {
    provider_groups: [
      {
        id: "openai",
        label: "OpenAI",
        aliases: ["codex", "openai"],
        plans: [
          {
            plan_id: "codex-plus",
            label: "Plus",
            aliases: ["plus"],
            versions: [
              {
                from: "2023-02-01",
                usd_per_month: 20,
                default_reference: { tokens_per_1pct: PLUS_REF, source: "curated" },
              },
              {
                from: "2026-06-01",
                usd_per_month: 20,
                default_reference: { absent: true, reason: "v2 unpublished" },
              },
            ],
          },
          {
            plan_id: "codex-pro-20x",
            label: "Pro (20x)",
            aliases: ["pro-20x", "pro"],
            versions: [
              {
                from: "2024-12-05",
                usd_per_month: 200,
                default_reference: { tokens_per_1pct: vector(1), source: "curated-pro" },
              },
            ],
          },
        ],
      },
      {
        id: "anthropic",
        label: "Anthropic",
        aliases: ["claude", "anthropic"],
        plans: [
          {
            plan_id: "claude-pro",
            label: "Pro",
            aliases: ["pro"],
            versions: [
              { from: "2023-09-07", usd_per_month: 20, default_reference: { absent: true, reason: "v1 no vector" } },
              {
                from: "2025-08-28",
                usd_per_month: 20,
                default_reference: { tokens_per_1pct: vector(10), source: "curated-claude" },
              },
            ],
          },
        ],
      },
    ],
  };
}
function rateCard(): RateCard {
  return {
    version: 2,
    currency: "USD",
    unit: "USD per 1,000,000 tokens",
    vendors: {
      anthropic: {
        models: {
          "claude-opus-5": {
            in_uncached: 5,
            in_cache_read: 0.5,
            in_cache_write_5m: 6.25,
            in_cache_write_1h: 10,
            out_total: 25,
            fast: {
              in_uncached: 10,
              in_cache_read: 1,
              in_cache_write_5m: 12.5,
              in_cache_write_1h: 20,
              out_total: 50,
            },
          },
        },
      },
      openai: {
        models: {
          "gpt-5.4": {
            in_uncached: 5,
            in_cache_read: 0.5,
            in_cache_write: 5,
            out_total: 15,
          },
        },
      },
    },
  };
}
function obs(partial: Partial<PlanWindowObservation> & Pick<PlanWindowObservation, "window_id" | "start_ts" | "end_ts">): PlanWindowObservation {
  return {
    provider_alias: "codex",
    plan_id: "codex-plus",
    window_kind: "weekly",
    first_percent: 0,
    peak_percent: 50,
    sample_count: 60,
    lag_fraction: 0.02,
    distinct_steps: 40,
    tokens: { ...CACHE_HEAVY },
    cadence_hours: 168,
    rates: { ...TYPE_RATES },
    ...partial,
  };
}
function pair(kind = "weekly"): PlanWindowObservation[] {
  return [
    obs({ window_id: "plus-w1", start_ts: "2026-01-01T00:00:00Z", end_ts: "2026-01-08T00:00:00Z", window_kind: kind }),
    obs({ window_id: "plus-w2", start_ts: "2026-01-15T00:00:00Z", end_ts: "2026-01-22T00:00:00Z", window_kind: kind }),
  ];
}
function build(observations: PlanWindowObservation[], extra?: Partial<Parameters<typeof buildPlanCapacity>[0]>) {
  return buildPlanCapacity({
    catalog: catalog(),
    rateCard: rateCard(),
    observations,
    provider: "codex",
    plan_id: "codex-plus",
    window_kind: "weekly",
    as_of: "2026-03-01",
    ...extra,
  });
}
describe("first-gate constants", () => {
  it("reuses the cycle.ts 50-sample / 20 pp floor", () => {
    expect(GAUGE_QUALITY_MIN_SAMPLES).toBe(50);
    expect(GAUGE_QUALITY_MIN_SPAN_PP).toBe(20);
  });
});
describe("cohort partitioning", () => {
  it("normalizes known promotion windows back to ordinary 1x capacity", () => {
    const ordinary = build(pair());
    const promotion = build(pair().map((sample) => ({
      ...sample,
      capacity_factor: 2,
      capacity_regime_id: "promo-2x",
      tokens: Object.fromEntries(
        Object.entries(sample.tokens).map(([key, value]) => [key, (value ?? 0) * 2]),
      ),
    })));
    expect(promotion.local_calibration.tokens.vector).toEqual(ordinary.local_calibration.tokens.vector);
    expect(promotion.local_calibration.api.usd_per_1pct).toEqual(ordinary.local_calibration.api.usd_per_1pct);
  });

  it("keeps Plus v1 weekly separate from Pro, Plus v2, and 5h windows", () => {
    const plusWeekly = pair("weekly");
    const plusSession = [
      obs({
        window_id: "plus-5h-1",
        start_ts: "2026-01-01T00:00:00Z",
        end_ts: "2026-01-01T05:00:00Z",
        window_kind: "5h",
        cadence_hours: 5,
      }),
      obs({
        window_id: "plus-5h-2",
        start_ts: "2026-01-08T00:00:00Z",
        end_ts: "2026-01-08T05:00:00Z",
        window_kind: "5h",
        cadence_hours: 5,
      }),
    ];
    const plusV2 = [
      obs({
        window_id: "plus-v2-1",
        start_ts: "2026-06-02T00:00:00Z",
        end_ts: "2026-06-09T00:00:00Z",
      }),
    ];
    const pro = [
      obs({
        window_id: "pro-w1",
        start_ts: "2026-01-01T00:00:00Z",
        end_ts: "2026-01-08T00:00:00Z",
        plan_id: "codex-pro-20x",
      }),
      obs({
        window_id: "pro-w2",
        start_ts: "2026-01-15T00:00:00Z",
        end_ts: "2026-01-22T00:00:00Z",
        plan_id: "codex-pro-20x",
      }),
    ];
    const target = build(plusWeekly);
    const mixed = build([...plusWeekly, ...plusSession, ...plusV2, ...pro]);
    expect(JSON.stringify(target.local_calibration.tokens)).toBe(JSON.stringify(mixed.local_calibration.tokens));
    expect(JSON.stringify(target.primary)).toBe(JSON.stringify(mixed.primary));
    expect(target.local_calibration.samples.accepted).toBe(2);
    expect(target.cohort).toEqual({
      provider_group: "openai",
      plan_id: "codex-plus",
      plan_version: "2023-02-01",
      version_from: "2023-02-01",
      window_kind: "weekly",
    });
    expect(build(plusWeekly, { provider: "openai" }).cohort?.provider_group).toBe("openai");
  });
  it("treats a cross-version window as rejected unless parts can be attributed", () => {
    const cross: PlanWindowObservation = {
      window_id: "cross",
      provider_alias: "claude",
      plan_id: "claude-pro",
      window_kind: "weekly",
      start_ts: "2025-08-20T00:00:00Z",
      end_ts: "2025-09-05T00:00:00Z",
      first_percent: 0,
      peak_percent: 50,
      sample_count: 80,
      lag_fraction: 0.02,
      distinct_steps: 40,
      tokens: { ...CACHE_HEAVY },
      cadence_hours: 168,
      rates: { ...TYPE_RATES },
    };
    const rejected = buildPlanCapacity({
      catalog: catalog(),
      rateCard: rateCard(),
      observations: [cross],
      provider: "claude",
      plan_id: "claude-pro",
      window_kind: "weekly",
      as_of: "2025-09-01",
    });
    expect(rejected.local_calibration.samples.accepted).toBe(0);
    expect(rejected.local_calibration.samples.diagnostics[0]?.reason).toBe("cross_version_unattributable");
    const split = buildPlanCapacity({
      catalog: catalog(),
      rateCard: rateCard(),
      observations: [
        {
          ...cross,
          parts: [
            {
              start_ts: "2025-08-20T00:00:00Z",
              end_ts: "2025-08-28T00:00:00Z",
              first_percent: 0,
              peak_percent: 40,
              sample_count: 60,
              lag_fraction: 0.02,
              distinct_steps: 40,
              tokens: { ...CACHE_HEAVY },
            },
            {
              start_ts: "2025-08-28T00:00:00Z",
              end_ts: "2025-09-05T00:00:00Z",
              first_percent: 0,
              peak_percent: 50,
              sample_count: 60,
              lag_fraction: 0.02,
              distinct_steps: 40,
              tokens: { ...CACHE_HEAVY },
            },
          ],
        },
      ],
      provider: "claude",
      plan_id: "claude-pro",
      window_kind: "weekly",
      as_of: "2025-09-01",
    });
    expect(split.local_calibration.samples.accepted).toBe(1);
    expect(split.cohort?.plan_version).toBe("2025-08-28");
  });
});
describe("independent windows", () => {
  it("counts mirrored copies of the same reset interval once even when ids differ", () => {
    const live = obs({
      window_id: "live",
      subscription_id: "codex1",
      start_ts: "2026-01-01T00:00:00Z",
      end_ts: "2026-01-08T00:00:00Z",
      sample_count: 60,
    });
    const archive = obs({
      window_id: "archive-copy",
      subscription_id: "codex1",
      start_ts: "2026-01-01T00:00:00Z",
      end_ts: "2026-01-08T00:00:00Z",
      sample_count: 90,
    });
    const later = obs({
      window_id: "other",
      subscription_id: "codex1",
      start_ts: "2026-01-15T00:00:00Z",
      end_ts: "2026-01-22T00:00:00Z",
    });
    const result = build([live, archive, later]);
    expect(result.local_calibration.samples.independent_windows).toBe(2);
    expect(result.local_calibration.samples.accepted).toBe(2);
    expect(result.local_calibration.samples.diagnostics.some((d) => d.reason === "duplicate_window" && d.window_id === "live")).toBe(true);
  });
});
describe("first-gate rejection", () => {
  it("rejects below 50 samples or 20 pp and keeps the reason in diagnostics", () => {
    const weakSamples = obs({
      window_id: "weak-n",
      start_ts: "2026-01-01T00:00:00Z",
      end_ts: "2026-01-08T00:00:00Z",
      sample_count: 20,
      peak_percent: 80,
    });
    const weakSpan = obs({
      window_id: "weak-pp",
      start_ts: "2026-01-15T00:00:00Z",
      end_ts: "2026-01-22T00:00:00Z",
      sample_count: 80,
      first_percent: 70,
      peak_percent: 80,
    });
    const result = build([weakSamples, weakSpan]);
    expect(result.local_calibration.samples.accepted).toBe(0);
    expect(result.local_calibration.samples.rejected).toBe(2);
    expect(result.local_calibration.samples.diagnostics.every((d) => d.reason === "first_gate_rejected")).toBe(true);
    expect(result.local_calibration.samples.diagnostics.every((d) => d.quality?.confidence === "none")).toBe(true);
    expect(result.local_calibration.tokens.status).toBe("none");
  });
});
describe("cohort reliability gates", () => {
  it("labels one accepted window working and two spanning a cadence reliable when within 10%", () => {
    const one = build([obs({ window_id: "one", start_ts: "2026-01-01T00:00:00Z", end_ts: "2026-01-08T00:00:00Z" })]);
    expect(one.local_calibration.samples.accepted).toBe(1);
    expect(one.local_calibration.tokens.status).toBe("working");
    expect(one.local_calibration.tokens.reason).toContain("insufficient_windows");
    const two = build(pair());
    expect(two.local_calibration.samples.accepted).toBe(2);
    expect(two.local_calibration.tokens.status).toBe("reliable");
    expect(two.primary.source).toBe("local_calibration");
  });
  it("fails reliability when span is shorter than one cadence", () => {
    const short = build([
      obs({ window_id: "a", start_ts: "2026-01-01T00:00:00Z", end_ts: "2026-01-01T12:00:00Z", cadence_hours: 168 }),
      obs({ window_id: "b", start_ts: "2026-01-01T06:00:00Z", end_ts: "2026-01-01T18:00:00Z", cadence_hours: 168 }),
    ]);
    expect(short.local_calibration.samples.accepted).toBe(2);
    expect(short.local_calibration.tokens.status).toBe("working");
    expect(short.local_calibration.tokens.reason).toContain("cadence_span_short");
    expect(short.local_calibration.samples.span_hours).toBeLessThan(168);
  });
  it("passes below 10% relative deviation and fails above it", () => {
    const within = build([
      obs({
        window_id: "a",
        start_ts: "2026-01-01T00:00:00Z",
        end_ts: "2026-01-08T00:00:00Z",
        tokens: { ...CACHE_HEAVY },
      }),
      obs({
        window_id: "b",
        start_ts: "2026-01-15T00:00:00Z",
        end_ts: "2026-01-22T00:00:00Z",
        tokens: {
          in_uncached: CACHE_HEAVY.in_uncached * 1.05,
          in_cache_read: CACHE_HEAVY.in_cache_read * 1.05,
          in_cache_write_5m: 0,
          in_cache_write_1h: 0,
          out_total: CACHE_HEAVY.out_total * 1.05,
        },
      }),
    ]);
    expect(within.local_calibration.tokens.spread).toBeLessThanOrEqual(CONSISTENCY_RELATIVE_MAX);
    expect(within.local_calibration.tokens.consistent).toBe(true);
    expect(within.local_calibration.tokens.status).toBe("reliable");
    const over = build([
      obs({
        window_id: "a",
        start_ts: "2026-01-01T00:00:00Z",
        end_ts: "2026-01-08T00:00:00Z",
        tokens: { ...CACHE_HEAVY },
      }),
      obs({
        window_id: "b",
        start_ts: "2026-01-15T00:00:00Z",
        end_ts: "2026-01-22T00:00:00Z",
        tokens: {
          in_uncached: CACHE_HEAVY.in_uncached * 1.3,
          in_cache_read: CACHE_HEAVY.in_cache_read * 1.3,
          in_cache_write_5m: 0,
          in_cache_write_1h: 0,
          out_total: CACHE_HEAVY.out_total * 1.3,
        },
      }),
    ]);
    expect(over.local_calibration.tokens.spread).toBeGreaterThan(CONSISTENCY_RELATIVE_MAX);
    expect(over.local_calibration.tokens.consistent).toBe(false);
    expect(over.local_calibration.tokens.status).toBe("working");
    expect(over.local_calibration.tokens.reason).toContain("inconsistent_gt_10pct");
    expect(over.local_calibration.explanation).toContain("consistency=fail");
  });
});
describe("median vector and per-type valuation", () => {
  it("aggregates a robust median per token type", () => {
    const result = build([
      obs({
        window_id: "lo",
        start_ts: "2026-01-01T00:00:00Z",
        end_ts: "2026-01-08T00:00:00Z",
        tokens: { in_uncached: 4_000_000, in_cache_read: 400_000_000, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 2_000_000 },
      }),
      obs({
        window_id: "mid",
        start_ts: "2026-01-15T00:00:00Z",
        end_ts: "2026-01-22T00:00:00Z",
        tokens: { in_uncached: 5_000_000, in_cache_read: 500_000_000, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 2_500_000 },
      }),
      obs({
        window_id: "hi",
        start_ts: "2026-02-01T00:00:00Z",
        end_ts: "2026-02-08T00:00:00Z",
        tokens: { in_uncached: 9_000_000, in_cache_read: 900_000_000, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 8_000_000 },
      }),
    ]);
    expect(result.local_calibration.tokens.vector.in_uncached).toEqual({ value: 100_000, absent: null });
    expect(result.local_calibration.tokens.vector.in_cache_read).toEqual({ value: 10_000_000, absent: null });
    expect(result.local_calibration.tokens.vector.out_total).toEqual({ value: 50_000, absent: null });
  });
  it("hand-computes per-type API value and rejects a naive single-rate blend", () => {
    const result = build(pair());
    const usd = result.local_calibration.api.usd_per_1pct;
    expect(usd.absent).toBeNull();
    if (usd.absent != null) return;
    expect(usd.value).toBe(6.7);
    const naiveUncached = ((100_000 + 9_900_000 + 50_000) / 1e6) * 5;
    expect(naiveUncached).toBe(50.25);
    expect(Math.abs(usd.value - naiveUncached)).toBeGreaterThan(10);
    expect(result.derived.usd_per_1pct).toEqual(usd);
    expect(result.derived.usd_per_1m.absent).toBeNull();
    if (result.derived.usd_per_1m.absent != null) return;
    expect(result.derived.usd_per_1m.value).toBe(0.6667);
  });
});
describe("token / API status independence", () => {
  it("does not normalize Codex token capacity when speed and rates are missing", () => {
    const noRates = pair().map((o) => ({ ...o, rates: undefined }));
    const card: RateCard = { version: 2, currency: "USD", unit: "x", vendors: {} };
    const result = build(noRates, { rateCard: card });
    expect(result.local_calibration.tokens.status).toBe("none");
    expect(result.local_calibration.samples.diagnostics.every(d => d.reason === "unknown_speed")).toBe(true);
    expect(result.local_calibration.api.status).toBe("none");
    expect(result.primary.source).toBe("default_reference");
  });
  it("does not treat a partial counter set as reliable token capacity", () => {
    const partial = pair().map((o) => {
      const { out_total: _drop, ...rest } = o.tokens;
      return { ...o, tokens: rest };
    });
    const result = build(partial);
    expect(result.local_calibration.tokens.vector.out_total).toEqual({ value: null, absent: "missing_counter" });
    expect(result.local_calibration.tokens.status).toBe("working");
    expect(result.local_calibration.tokens.reason).toContain("missing_counter");
    expect(result.local_calibration.api.usd_per_1pct.absent).toBe("missing_counter");
    expect(result.primary.source).not.toBe("local_calibration");
  });
  it("keeps a null rate absent instead of coercing it to zero", () => {
    const nullOut: TokenRates = { ...TYPE_RATES, out_total: null };
    const result = build(pair().map((o) => ({ ...o, rates: nullOut })));
    expect(result.local_calibration.tokens.status).toBe("reliable");
    expect(result.local_calibration.api.by_type.out_total).toEqual({ value: null, absent: "missing_rate" });
    expect(result.local_calibration.api.usd_per_1pct).toEqual({ value: null, absent: "missing_rate" });
    expect(result.local_calibration.api.status).toBe("none");
  });
});
describe("API total equals per-type medians", () => {
  it("derives the exposed total from type medians on an asymmetric three-window cohort", () => {
    const rate1: TokenRates = {
      in_uncached: 1,
      in_cache_read: 1,
      in_cache_write_5m: 1,
      in_cache_write_1h: 1,
      out_total: 1,
    };
    const raw = (usdUncached: number, usdCache: number): TokenVector => ({
      in_uncached: usdUncached * 50e6,
      in_cache_read: usdCache * 50e6,
      in_cache_write_5m: 0,
      in_cache_write_1h: 0,
      out_total: 0,
    });
    const result = build([
      obs({
        window_id: "a",
        start_ts: "2026-01-01T00:00:00Z",
        end_ts: "2026-01-08T00:00:00Z",
        tokens: raw(100, 90),
        rates: rate1,
      }),
      obs({
        window_id: "b",
        start_ts: "2026-01-15T00:00:00Z",
        end_ts: "2026-01-22T00:00:00Z",
        tokens: raw(90, 100),
        rates: rate1,
      }),
      obs({
        window_id: "c",
        start_ts: "2026-02-01T00:00:00Z",
        end_ts: "2026-02-08T00:00:00Z",
        tokens: raw(99, 99),
        rates: rate1,
      }),
    ]);
    expect(result.local_calibration.api.by_type.in_uncached).toEqual({ value: 99, absent: null });
    expect(result.local_calibration.api.by_type.in_cache_read).toEqual({ value: 99, absent: null });
    const byTypeSum =
      (result.local_calibration.api.by_type.in_uncached.value ?? 0) +
      (result.local_calibration.api.by_type.in_cache_read.value ?? 0) +
      (result.local_calibration.api.by_type.in_cache_write_5m.value ?? 0) +
      (result.local_calibration.api.by_type.in_cache_write_1h.value ?? 0) +
      (result.local_calibration.api.by_type.out_total.value ?? 0);
    expect(result.local_calibration.api.usd_per_1pct).toEqual({ value: 198, absent: null });
    expect(result.local_calibration.api.usd_per_1pct.value).toBe(byTypeSum);
    expect(result.local_calibration.api.usd_per_1pct.value).not.toBe(190);
  });
});
describe("mixed cadence is order-independent", () => {
  it("emits byte-identical output for cadence permutations", () => {
    const a = obs({
      window_id: "short",
      start_ts: "2026-01-01T00:00:00Z",
      end_ts: "2026-01-01T12:00:00Z",
      cadence_hours: 5,
    });
    const b = obs({
      window_id: "week",
      start_ts: "2026-01-01T06:00:00Z",
      end_ts: "2026-01-02T00:00:00Z",
      cadence_hours: 168,
    });
    const forward = build([a, b]);
    const reverse = build([b, a]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    expect(forward.local_calibration.tokens.status).toBe("working");
    expect(forward.local_calibration.tokens.reason).toContain("mixed_cadence");
    expect(forward.local_calibration.samples.cadence_hours).toBe(168);
    expect(forward.derived.leverage).toEqual(reverse.derived.leverage);
  });
});
describe("reference fallback and local takeover", () => {
  it("uses the exact version default_reference when local calibration is not reliable", () => {
    const result = build([]);
    expect(result.local_calibration.tokens.status).toBe("none");
    expect(result.primary.source).toBe("default_reference");
    expect(result.primary.tokens_per_1pct.in_uncached).toEqual({ value: PLUS_REF.in_uncached, absent: null });
    expect(result.default_reference).toEqual({
      present: true,
      tokens_per_1pct: PLUS_REF,
      source: "curated",
      reason: null,
      version_id: "2023-02-01",
      version_from: "2023-02-01",
    });
  });
  it("does not invent a reference from another plan or version", () => {
    const v2 = build([], { as_of: "2026-07-01" });
    expect(v2.cohort?.plan_version).toBe("2026-06-01");
    expect(v2.default_reference.present).toBe(false);
    expect(v2.default_reference.reason).toBe("v2 unpublished");
    expect(v2.primary.source).toBe("none");
    expect(v2.primary.tokens_per_1pct.in_uncached.absent).toBe("no_reference");
  });
  it("lets reliable local calibration take over without mutating the reference", () => {
    const result = build(pair());
    expect(result.local_calibration.tokens.status).toBe("reliable");
    expect(result.primary.source).toBe("local_calibration");
    expect(result.default_reference.present).toBe(true);
    expect(result.default_reference.tokens_per_1pct).toEqual(PLUS_REF);
    expect(result.default_reference.source).toBe("curated");
    expect(result.deviation.local_vs_reference).not.toBeNull();
  });
});
describe("as_of selects version but does not clip the cohort", () => {
  it("includes the version's full lifetime even when as_of is a day in the middle", () => {
    const early = obs({ window_id: "jan", start_ts: "2026-01-01T00:00:00Z", end_ts: "2026-01-08T00:00:00Z" });
    const late = obs({ window_id: "may", start_ts: "2026-05-01T00:00:00Z", end_ts: "2026-05-08T00:00:00Z" });
    const result = build([early, late], { as_of: "2026-03-15" });
    expect(result.cohort?.plan_version).toBe("2023-02-01");
    expect(result.local_calibration.samples.accepted).toBe(2);
    expect(result.local_calibration.samples.diagnostics.map((d) => d.window_id).sort()).toEqual(["jan", "may"]);
  });
});
describe("fast pricing and derived metrics", () => {
  it("normalizes mixed Codex speed with per-event standard prices and preserves original counters", () => {
    const rows = pair().map((o, i) => ({ ...o, rates: undefined,
      start_ts: i ? "2026-09-15T00:00:00Z" : "2026-09-08T00:00:00Z",
      end_ts: i ? "2026-09-22T00:00:00Z" : "2026-09-15T00:00:00Z",
      slices: ["standard", "fast"].map(speed => ({ model: "gpt-6-astra", speed, day: "2026-09-08",
        tokens: { in_uncached: 20000, in_cache_read: 80000, in_cache_write_5m: 0, in_cache_write_1h: 0, out_total: 10000 } })) }));
    const before = JSON.stringify(rows);
    const r = build(rows, { as_of: "2026-09-20" });
    expect(r.normalization).toBe("standard");
    expect(r.local_calibration.api.usd_per_1pct.value).toBeCloseTo(.0546, 4);
    expect(r.local_calibration.tokens.vector.in_uncached.value).toBe(1400);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("uses fast rates when usage.speed requires them", () => {
    const slices = pair().map((o) => ({
      ...o,
      rates: undefined,
      provider_alias: "claude",
      plan_id: "claude-pro",
      start_ts: o.window_id === "plus-w1" ? "2025-09-01T00:00:00Z" : "2025-09-15T00:00:00Z",
      end_ts: o.window_id === "plus-w1" ? "2025-09-08T00:00:00Z" : "2025-09-22T00:00:00Z",
      slices: [
        {
          model: "claude-opus-5",
          speed: "fast",
          day: "2025-09-02",
          tokens: { ...CACHE_HEAVY },
        },
      ],
    }));
    const result = buildPlanCapacity({
      catalog: catalog(),
      rateCard: rateCard(),
      observations: slices,
      provider: "claude",
      plan_id: "claude-pro",
      window_kind: "weekly",
      as_of: "2025-09-10",
    });
    expect(result.local_calibration.api.usd_per_1pct).toEqual({ value: 13.4, absent: null });
  });
  it("computes utilisation, headroom and leverage from the selected estimate", () => {
    const result = build(pair(), { current_used_percent: 40 });
    expect(result.derived.utilisation_pct).toEqual({ value: 40, absent: null });
    expect(result.derived.headroom_pct).toEqual({ value: 60, absent: null });
    expect(result.derived.leverage.absent).toBeNull();
    expect(result.derived.tokens_at_100pct.in_uncached).toEqual({ value: 10_000_000, absent: null });
  });
});
describe("GET /api/plan-capacity", () => {
  it("requires provider, plan_id and window_kind", async () => {
    const ctx = { plansCatalog: catalog(), rateCards: rateCard() } as AppContext;
    const res = handlePlanCapacity(ctx, new URL("http://local/api/plan-capacity"));
    expect(res.status).toBe(400);
  });
  it("createFetchHandler refuses legacy unknown-speed usage and events at the first probe boundary", async () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE probe_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT, subject TEXT, ts TEXT, kind TEXT,
        used_percent REAL, window_minutes REAL, resets_at TEXT, ok INTEGER
      );
      CREATE TABLE events (
        ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT,
        in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, path TEXT
      );
    `);
    const home = "C:/Users/test/.codex";
    const windows = [
      { start: "2026-01-01T00:00:00Z", reset: "2026-01-08T00:00:00Z" },
      { start: "2026-01-15T00:00:00Z", reset: "2026-01-22T00:00:00Z" },
    ];
    for (const w of windows) {
      const startMs = Date.parse(w.start);
      for (let i = 0; i < 60; i++) {
        const ts = new Date(startMs + i * 3_600_000).toISOString();
        const pct = (i / 59) * 50;
        db.run(
          `INSERT INTO probe_windows (provider, subject, ts, kind, used_percent, window_minutes, resets_at, ok)
           VALUES ('codex', 'codex1', ?, 'weekly', ?, 10080, ?, 1)`,
          [ts, pct, w.reset]
        );
      }
      db.run(
        `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
         VALUES (?, ?, 'repo', 'app', 'gpt-5.4', ?, ?, 0, ?, 'sess')`,
        [w.start, home, CACHE_HEAVY.in_uncached + CACHE_HEAVY.in_cache_read, CACHE_HEAVY.in_cache_read, CACHE_HEAVY.out_total]
      );
    }
    storePlanHistory(db, planHistory("codex", [{ subscription: "codex1", plan: "codex-plus", from: "2023-02-01" }]));
    const ctx = {
      sqlite: db,
      rateCards: rateCard(),
      plansCatalog: catalog(),
      plans: { segments: [] },
      cycles: { windows: [{ subscription: "codex1", kind: "weekly", period_hours: 168 }] },
      accounts: splitProbeReaderFixtureConfig([{ id: "codex1", vendor: "codex", plan: "codex-plus", home }, codex1Source(db, home)]),
      homeToSubId: new Map([[home.split("\\").join("/").toLowerCase(), "codex1"]]),
      subIdToHomes: new Map([["codex1", [home]]]),
      homeConflict: null,
    } as unknown as AppContext;
    prepareCodexWindowSums(db, ctx);
    const fetch = createFetchHandler(ctx);
    const res = await fetch(
      new Request("http://local/api/plan-capacity?provider=codex&plan_id=codex-plus&window_kind=weekly&as_of=2026-03-01")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlanCapacityResult;
    expect(body.default_reference.present).toBe(true);
    expect(body.local_calibration.samples.accepted).toBe(0);
    expect(body.local_calibration.samples.diagnostics.length).toBeGreaterThan(0);
    expect(body.local_calibration.tokens.status).toBe("none");
    expect(body.primary.source).toBe("default_reference");
  });
  // Observed Codex periods carry the profile's names (`plus`, `pro`); `pro` is Pro (20x) by its catalog alias.
  it.each([["codex-plus", "codex-pro-20x"], ["plus", "pro"]])("does not assign a weekly window to the start-day Plan when the stage changes mid-interval (%s → %s)", (plusValue, proValue) => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE probe_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT, subject TEXT, ts TEXT, kind TEXT,
        used_percent REAL, window_minutes REAL, resets_at TEXT, ok INTEGER
      );
      CREATE TABLE events (
        ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT,
        in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, path TEXT
      );
    `);
    const home = "C:/Users/test/.codex";
    const reset = "2026-01-08T00:00:00Z";
    const startMs = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 60; i++) {
      const ts = new Date(startMs + i * 3_600_000).toISOString();
      db.run(
        `INSERT INTO probe_windows (provider, subject, ts, kind, used_percent, window_minutes, resets_at, ok)
         VALUES ('codex', 'codex1', ?, 'weekly', ?, 10080, ?, 1)`,
        [ts, (i / 59) * 50, reset]
      );
    }
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-02T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 1000000, 0, 0, 100000, 'plus-sess')`,
      [home]
    );
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-05T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 80000000, 0, 0, 0, 'pro-sess')`,
      [home]
    );
    const ctx = {
      sqlite: db,
      plansCatalog: catalog(),
      planPeriods: planHistory("codex", [
        { subscription: "codex1", plan: plusValue!, from: "2023-02-01", until: "2026-01-03" },
        { subscription: "codex1", plan: proValue!, from: "2026-01-04" },
      ]),
      cycles: { windows: [{ subscription: "codex1", kind: "weekly", period_hours: 168 }] },
      accounts: splitProbeReaderFixtureConfig([{ id: "codex1", vendor: "codex", plan: "codex-plus", home }, codex1Source(db, home)]),
      homeToSubId: new Map([[home.toLowerCase(), "codex1"]]),
      subIdToHomes: new Map([["codex1", [home]]]),
    };
    prepareCodexWindowSums(db, ctx);
    const plus = collectPlanWindowObservations(ctx, {
      provider: "codex",
      plan_id: "codex-plus",
      window_kind: "weekly",
    });
    const pro = collectPlanWindowObservations(ctx, {
      provider: "codex",
      plan_id: "codex-pro-20x",
      window_kind: "weekly",
    });
    expect(plus).toHaveLength(1);
    expect(Date.parse(plus[0]!.end_ts)).toBeLessThanOrEqual(Date.parse("2026-01-04T00:00:00Z"));
    expect(plus[0]!.tokens.in_uncached).toBe(1_000_000);
    expect(plus[0]!.tokens.out_total).toBe(100_000);
    expect(plus[0]!.tokens.in_uncached).not.toBe(80_000_000);
    expect(pro).toHaveLength(1);
    expect(Date.parse(pro[0]!.start_ts)).toBeGreaterThanOrEqual(Date.parse("2026-01-04T00:00:00Z"));
    expect(pro[0]!.tokens.in_uncached).toBe(80_000_000);
    expect(pro[0]!.tokens.in_uncached).not.toBe(1_000_000);
  });
  it("splits a middle-stage Plan at its catalog version cut inside A→B→A", () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE probe_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT, subject TEXT, ts TEXT, kind TEXT,
        used_percent REAL, window_minutes REAL, resets_at TEXT, ok INTEGER
      );
      CREATE TABLE events (
        ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT,
        in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, path TEXT
      );
    `);
    const home = "C:/Users/test/.codex";
    const reset = "2026-01-08T00:00:00Z";
    const startMs = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 168; i++) {
      const ts = new Date(startMs + i * 3_600_000).toISOString();
      db.run(
        `INSERT INTO probe_windows (provider, subject, ts, kind, used_percent, window_minutes, resets_at, ok)
         VALUES ('codex', 'codex1', ?, 'weekly', ?, 10080, ?, 1)`,
        [ts, (i / 167) * 50, reset]
      );
    }
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-01T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 1000000, 0, 0, 10000, 'plus-sess')`,
      [home]
    );
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-04T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 2000000, 0, 0, 20000, 'pro-v1')`,
      [home]
    );
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-06T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 3000000, 0, 0, 30000, 'pro-v2')`,
      [home]
    );
    const cat: PlansCatalog = {
      provider_groups: [
        {
          id: "openai",
          label: "OpenAI",
          aliases: ["codex", "openai"],
          plans: [
            {
              plan_id: "codex-plus",
              label: "Plus",
              versions: [
                {
                  from: "2023-02-01",
                  usd_per_month: 20,
                  default_reference: { tokens_per_1pct: PLUS_REF, source: "curated" },
                },
              ],
            },
            {
              plan_id: "codex-pro-20x",
              label: "Pro (20x)",
              versions: [
                {
                  from: "2024-12-05",
                  usd_per_month: 200,
                  default_reference: { tokens_per_1pct: vector(1), source: "curated-pro" },
                },
                {
                  from: "2026-01-05",
                  usd_per_month: 200,
                  default_reference: { tokens_per_1pct: vector(2), source: "curated-pro-v2" },
                },
              ],
            },
          ],
        },
      ],
    };
    const ctx = {
      sqlite: db,
      plansCatalog: cat,
      planPeriods: planHistory("codex", [
        { subscription: "codex1", plan: "codex-plus", from: "2023-02-01", until: "2026-01-02" },
        { subscription: "codex1", plan: "codex-pro-20x", from: "2026-01-03", until: "2026-01-06" },
        { subscription: "codex1", plan: "codex-plus", from: "2026-01-07" },
      ]),
      cycles: { windows: [{ subscription: "codex1", kind: "weekly", period_hours: 168 }] },
      accounts: splitProbeReaderFixtureConfig([{ id: "codex1", vendor: "codex", plan: "codex-plus", home }, codex1Source(db, home)]),
      homeToSubId: new Map([[home.toLowerCase(), "codex1"]]),
      subIdToHomes: new Map([["codex1", [home]]]),
    };
    prepareCodexWindowSums(db, ctx);
    const plus = collectPlanWindowObservations(ctx, {
      provider: "codex",
      plan_id: "codex-plus",
      window_kind: "weekly",
    });
    expect(plus.some((o) => Date.parse(o.start_ts) <= Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
    expect(plus.some((o) => Date.parse(o.start_ts) >= Date.parse("2026-01-07T00:00:00Z"))).toBe(true);
    const pro = collectPlanWindowObservations(ctx, {
      provider: "codex",
      plan_id: "codex-pro-20x",
      window_kind: "weekly",
    });
    expect(pro.length).toBe(2);
    const cut = Date.parse("2026-01-05T00:00:00Z");
    expect(pro.some((o) => Date.parse(o.start_ts) < cut && Date.parse(o.end_ts) > cut)).toBe(false);
    const earlier = pro.find((o) => Date.parse(o.end_ts) <= cut)!;
    const later = pro.find((o) => Date.parse(o.start_ts) >= cut)!;
    expect(earlier.tokens.in_uncached).toBe(2_000_000);
    expect(later.tokens.in_uncached).toBe(3_000_000);
    expect(earlier.tokens.in_uncached).not.toBe(3_000_000);
    expect(later.tokens.in_uncached).not.toBe(2_000_000);
    const input = {
      catalog: cat,
      rateCard: rateCard(),
      observations: pro,
      provider: "codex",
      plan_id: "codex-pro-20x",
      window_kind: "weekly",
      as_of: "2026-01-04",
    };
    const v1 = buildPlanCapacity(input);
    const v2 = buildPlanCapacity({ ...input, as_of: "2026-01-06" });
    expect(v1.local_calibration.samples.diagnostics.some((d) => d.reason === "cross_version_unattributable")).toBe(
      false
    );
    expect(v2.local_calibration.samples.diagnostics.some((d) => d.reason === "cross_version_unattributable")).toBe(
      false
    );
    expect(v1.cohort?.plan_version).toBe("2024-12-05");
    expect(v2.cohort?.plan_version).toBe("2026-01-05");
  });
  it("filters Claude calls by the account periods and excludes windows with traffic no account owns", () => {
    const f = claudePlanDb();
    for (const subject of ["claude-a", "claude-b"]) claudeWeek(f, subject);
    f.event("claude-a", "2026-01-02T12:00:00Z", 1_000_000, { output: 100_000 });
    f.event("claude-b", "2026-01-02T12:00:00Z", 50_000_000);
    f.event(null, "2026-01-02T13:00:00Z", 999_999);
    f.publish(["claude-a", "claude-b"]);
    const ctx = { sqlite: f.db, plansCatalog: catalog(),
      planPeriods: planHistory("claude", ["claude-a", "claude-b"].map(subscription => ({ subscription, plan: "claude-pro", from: "2025-08-28" }))),
      accounts: splitProbeReaderFixtureConfig(["claude-a", "claude-b"].map(id => probeReaderFixtureSource("claude", id))) };
    const collected = measureCallReads(f.db, () => collectPlanWindowObservations(ctx, { provider: "claude", plan_id: "claude-pro", window_kind: "weekly" }));
    expect(collected.callReads).toEqual([]);
    const a = collected.value.find((o) => o.subscription_id === "claude-a" && !o.exclusion_reason);
    const b = collected.value.find((o) => o.subscription_id === "claude-b" && !o.exclusion_reason);
    expect(a!.tokens).toMatchObject({ in_uncached: 1_000_000, out_total: 100_000 });
    expect(b!.tokens.in_uncached).toBe(50_000_000);
    // Each account's week holds traffic no account owns: both get an excluded row.
    expect(collected.value.filter((o) => o.exclusion_reason === "unmapped_claude_events").map(o => o.subscription_id).sort())
      .toEqual(["claude-a", "claude-b"]);
    const calibrated = buildPlanCapacity({ catalog: catalog(), rateCard: rateCard(),
      observations: collected.value.filter((o) => o.subscription_id === "claude-a"),
      provider: "claude", plan_id: "claude-pro", window_kind: "weekly", as_of: "2026-01-10" });
    expect(calibrated.local_calibration.samples.diagnostics.some((d) => d.reason === "unmapped_claude_events")).toBe(true);
    // A window whose rows are not published yet is "preparing", never computed from calls.
    f.db.exec("DELETE FROM window_usage WHERE provider='claude'");
    expect(() => collectPlanWindowObservations(ctx, { provider: "claude", plan_id: "claude-pro", window_kind: "weekly" }))
      .toThrow(WindowUsagePreparing);
  }, CLAUDE_FIXTURE_MS);
  it("does not assign a plan-history gap through account.plan", () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE probe_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT, subject TEXT, ts TEXT, kind TEXT,
        used_percent REAL, window_minutes REAL, resets_at TEXT, ok INTEGER
      );
      CREATE TABLE events (
        ts TEXT, home TEXT, repo TEXT, project_id TEXT, model TEXT,
        in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER, path TEXT
      );
    `);
    const home = "C:/Users/test/.codex";
    const reset = "2026-01-08T00:00:00Z";
    const startMs = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 60; i++) {
      const ts = new Date(startMs + i * 3_600_000).toISOString();
      db.run(
        `INSERT INTO probe_windows (provider, subject, ts, kind, used_percent, window_minutes, resets_at, ok)
         VALUES ('codex', 'codex1', ?, 'weekly', ?, 10080, ?, 1)`,
        [ts, (i / 59) * 50, reset]
      );
    }
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-02T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 1000000, 0, 0, 100000, 'plus-sess')`,
      [home]
    );
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-04T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 7770000, 0, 0, 0, 'gap-sess')`,
      [home]
    );
    db.run(
      `INSERT INTO events (ts, home, repo, project_id, model, in_tok, cached_in, cache_write, out_tok, path)
       VALUES ('2026-01-06T12:00:00Z', ?, 'repo', 'app', 'gpt-5.4', 80000000, 0, 0, 0, 'pro-sess')`,
      [home]
    );
    const ctx = {
      sqlite: db,
      plansCatalog: catalog(),
      planPeriods: planHistory("codex", [
        { subscription: "codex1", plan: "codex-plus", from: "2023-02-01", until: "2026-01-03" },
        { subscription: "codex1", plan: "codex-pro-20x", from: "2026-01-05" },
      ]),
      cycles: { windows: [{ subscription: "codex1", kind: "weekly", period_hours: 168 }] },
      accounts: splitProbeReaderFixtureConfig([{ id: "codex1", vendor: "codex", plan: "codex-plus", home }, codex1Source(db, home)]),
      homeToSubId: new Map([[home.toLowerCase(), "codex1"]]),
      subIdToHomes: new Map([["codex1", [home]]]),
    };
    prepareCodexWindowSums(db, ctx);
    const plus = collectPlanWindowObservations(ctx, {
      provider: "codex",
      plan_id: "codex-plus",
      window_kind: "weekly",
    });
    const admitted = plus.filter((o) => !o.exclusion_reason);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.tokens.in_uncached).toBe(1_000_000);
    expect(admitted[0]!.tokens.in_uncached).not.toBe(7_770_000);
    expect(plus.some((o) => o.exclusion_reason === "plan_period_gap")).toBe(true);
  });
});

describe("Claude Code share on weekly plan windows", () => {
  function shareFixture() {
    const f = claudePlanDb();
    const start = "2026-01-01T00:00:00.000Z";
    for (const subject of ["claude-a", "claude-b"]) {
      // Only claude-a ever reads a product share; claude-b stays the pre-share history.
      claudeWeek(f, subject, "weekly", 50, (i, ts) => subject === "claude-a" && i === 59 ? JSON.stringify(encodeClaudeCodeProductShare({
        schema: 1, key: "claude_code", percent: 50, as_of: ts, window_started_at: start, display_name: "Claude Code",
      })) : null);
      f.event(subject, "2026-01-02T12:00:00Z", 1_000_000);
      // SDK traffic is Claude Code too (rule @3).
      f.event(subject, "2026-01-02T13:00:00Z", 3_000_000, { entrypoint: "sdk-ts" });
    }
    f.publish(["claude-a", "claude-b"]);
    return collectPlanWindowObservations({ sqlite: f.db, plansCatalog: catalog(),
      planPeriods: planHistory("claude", ["claude-a", "claude-b"].map((subscription) => ({ subscription, plan: "claude-pro", from: "2025-08-28" }))),
      accounts: splitProbeReaderFixtureConfig(["claude-a", "claude-b"].map(id => probeReaderFixtureSource("claude", id))) },
      { provider: "claude", plan_id: "claude-pro", window_kind: "weekly" });
  }
  function calibrate(observations: ReturnType<typeof collectPlanWindowObservations>) {
    return buildPlanCapacity({ catalog: catalog(), rateCard: rateCard(), observations,
      provider: "claude", plan_id: "claude-pro", window_kind: "weekly", as_of: "2026-01-10" });
  }
  it("divides the Claude Code tokens of every local source by the Code part of the meter", () => {
    const a = shareFixture().find((o) => o.subscription_id === "claude-a" && !o.exclusion_reason)!;
    expect(a.local_share_percent).toBe(50);
    expect(a.tokens.in_uncached).toBe(4_000_000);
    const result = calibrate([a]);
    // 4,000,000 Code tokens moved 50% × 50% = 25 points of the account meter: 160,000 per point.
    expect(result.local_calibration.tokens.vector.in_uncached).toEqual({ value: 160_000, absent: null });
    expect(result.local_calibration.samples.diagnostics[0]!.local_share_percent).toBe(50);
  }, CLAUDE_FIXTURE_MS);
  it("keeps a window without a share, marked unknown and unscaled", () => {
    const b = shareFixture().find((o) => o.subscription_id === "claude-b" && !o.exclusion_reason)!;
    expect(b.local_share_percent).toBeNull();
    expect(b.tokens.in_uncached).toBe(4_000_000);
    const result = calibrate([b]);
    expect(result.local_calibration.tokens.vector.in_uncached).toEqual({ value: 80_000, absent: null });
    expect(result.local_calibration.samples.diagnostics[0]!.local_share_percent).toBeNull();
  }, CLAUDE_FIXTURE_MS);
  it("rejects a zero share instead of dividing by it", () => {
    const a = shareFixture().find((o) => o.subscription_id === "claude-a" && !o.exclusion_reason)!;
    const result = calibrate([{ ...a, local_share_percent: 0 }]);
    expect(result.local_calibration.samples.diagnostics[0]).toMatchObject({ accepted: false, reason: "share_zero" });
  }, CLAUDE_FIXTURE_MS);
});

describe("plan membership from plan periods", () => {
  function collect(planPeriods: Parameters<typeof collectPlanWindowObservations>[0]["planPeriods"]) {
    const f = claudePlanDb();
    claudeWeek(f, "claude-a");
    f.publish(["claude-a"]);
    return collectPlanWindowObservations({ sqlite: f.db, plansCatalog: catalog(), planPeriods,
      accounts: splitProbeReaderFixtureConfig([probeReaderFixtureSource("claude", "claude-a")]),
    }, { provider: "claude", plan_id: "claude-pro", window_kind: "weekly" });
  }
  const period = (value: string, from: string, until: string | null, origin: "observed" | "declared" = "observed") => ({
    provider: "claude", subject: "claude-a", from, until, value, origin,
    firstSeen: from, lastSeen: from, readings: 1, evidence: "profile-reading",
  });
  it("assigns the window from a plan period", () => {
    const obs = collect([period("default_claude_ai", "2025-12-01T00:00:00Z", null)]);
    expect(obs.filter((o) => !o.exclusion_reason).map((o) => o.plan_id)).toEqual(["claude-pro"]);
    expect(obs.some((o) => o.exclusion_reason === "plan_period_gap")).toBe(false);
  }, CLAUDE_FIXTURE_MS);
  it("splits the window at the instant the plan changed", () => {
    const obs = collect([
      period("pro", "2025-12-01T00:00:00Z", "2026-01-03T12:00:00Z", "declared"),
      period("max-5x", "2026-01-03T12:00:00Z", null, "declared"),
    ]);
    const pro = obs.filter((o) => o.plan_id === "claude-pro" && !o.exclusion_reason);
    expect(pro).toHaveLength(1);
    // The part ends at its last reading before the change.
    expect(pro[0]!.end_ts).toBe("2026-01-03T11:00:00.000Z");
  }, CLAUDE_FIXTURE_MS);
  it("assigns no plan to an account without plan periods (retired plans.json stages are not a fallback)", () => {
    const obs = collect([]);
    expect(obs.some((o) => !o.exclusion_reason)).toBe(false);
    expect(obs.some((o) => o.exclusion_reason === "plan_period_gap")).toBe(true);
  }, CLAUDE_FIXTURE_MS);
  it("leaves a window of another plan out of this plan's calibration", () => {
    const obs = collect([period("max-5x", "2025-12-01T00:00:00Z", null)]);
    expect(obs.some((o) => o.plan_id === "claude-pro" && !o.exclusion_reason)).toBe(false);
  }, CLAUDE_FIXTURE_MS);
  it("leaves a window under a declared \"no subscription\" out of every plan: no limits, and no plan-history gap either", () => {
    const obs = collect([period("none", "2025-12-01T00:00:00Z", null, "declared")]);
    expect(obs).toEqual([]);
  }, CLAUDE_FIXTURE_MS);
});

describe("Claude account meter only", () => {
  it("keeps the Fable sublimit out of plan windows and prices around zero-token turns", () => {
    const f = claudePlanDb();
    claudeWeek(f, "claude-a", "weekly_all", 50);
    claudeWeek(f, "claude-a", "weekly_scoped", 96, undefined, "Fable");
    f.event("claude-a", "2026-01-02T12:00:00Z", 1_000_000);
    f.event("claude-a", "2026-01-02T12:30:00Z", 0, { model: "<synthetic>" });
    f.publish(["claude-a"]);
    const observations = collectPlanWindowObservations({
      sqlite: f.db, plansCatalog: catalog(), planPeriods: planHistory("claude", [{ subscription: "claude-a", plan: "claude-pro", from: "2025-08-28" }]),
      accounts: splitProbeReaderFixtureConfig([probeReaderFixtureSource("claude", "claude-a")]),
    }, { provider: "claude", plan_id: "claude-pro", window_kind: "weekly" }).filter((o) => !o.exclusion_reason);
    expect(observations.map((o) => o.peak_percent)).toEqual([50]);
    const result = buildPlanCapacity({ catalog: catalog(), rateCard: rateCard(), observations,
      provider: "claude", plan_id: "claude-pro", window_kind: "weekly", as_of: "2026-01-10" });
    expect(result.local_calibration.api.usd_per_1pct.absent).toBeNull();
  }, CLAUDE_FIXTURE_MS);
});
