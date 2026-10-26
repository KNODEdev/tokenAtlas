import { Database } from "../db/sqlite";
import { describe, expect, it } from "bun:test";
import { buildHistoryCoverage, handleHistoryCoverage } from "./history-coverage";
import type { PlansCatalog } from "./plans-catalog";
import { ARCHIVE_LOGICAL_ROOT, LOGIN } from "../config/paths";
import { ACCOUNT_PERIODS, PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { acceptProbeFact, createProbeCollection, mapProbeLegacy } from "../db/probe-facts";
import { declareCodexEraPeriods } from "./codex-periods.fixture";
import { prepareUsageRegisters } from "./usage-register.fixture";
import { applyDrizzleMigrations } from "../db/migrate";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { currentRegistry } from "./current/registry";
import { publishCurrentBatch } from "./current/store";
import { splitProbeReaderFixtureConfig } from "./probe-reader.fixture";

const GAUGE_HOME = `${ARCHIVE_LOGICAL_ROOT}/codex/MAIN`;
const SOURCE_HOME = `C:/Users/${LOGIN}/.codex`;

const CATALOG: PlansCatalog = {
  provider_groups: [{
    id: "openai",
    label: "OpenAI",
    aliases: ["codex"],
    plans: [{ plan_id: "plus", label: "Plus", aliases: ["plus"], versions: [{ from: null, usd_per_month: 20 }] }],
  }],
};

function coverageDb(): Database {
  const sqlite = new Database(":memory:");
  applyDrizzleMigrations(drizzle(sqlite));
  sqlite.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, home TEXT, path TEXT, ts TEXT, model TEXT,
      in_tok INTEGER, cached_in INTEGER, cache_write INTEGER, out_tok INTEGER
    );
    CREATE TABLE ratelimit (
      ts TEXT, home TEXT, path TEXT, used_percent REAL, resets_at TEXT, plan_type TEXT, window_minutes INTEGER, limit_id TEXT
    );
    CREATE TABLE IF NOT EXISTS probe_windows (
      provider TEXT, subject TEXT, ts TEXT, used_percent REAL, resets_at TEXT,
      plan TEXT, ok INTEGER
    );
  `);
  // Events and samples belong to codex1 through the account period of their archive folder (stage 4, W6).
  declareCodexEraPeriods(sqlite, [{ id: "codex1", vendor: "openai", home: GAUGE_HOME }]);
  return sqlite;
}

/** Plan history is the account's plan periods: codex1 on Plus from `from`, or no plan history at all. */
function declarePlan(sqlite: Database, from: string | null) {
  replaceDeclaredPeriods(sqlite, PLAN_PERIODS, from === null ? [] : [{ provider: "codex", subject: "codex1", value: "plus",
    from, until: null, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
}

/** The context of a read; the shared price register is prepared first, as the maintenance worker does. */
function context(sqlite: Database, planFrom: string | null = "2026-01-01") {
  declarePlan(sqlite, planFrom);
  const rateCards = {
    version: 1,
    currency: "USD",
    unit: "per 1M",
    vendors: {
      openai: {
        models: { "gpt-test": { in_uncached: 1, in_cache_read: 1, in_cache_write: 1, out_total: 1 } },
      },
    },
  };
  prepareUsageRegisters(sqlite, rateCards);
  const declarations =
    [{ id: "codex1", vendor: "codex", machine: "MAIN", home: GAUGE_HOME, source_home: SOURCE_HOME }];
  const config = splitProbeReaderFixtureConfig(declarations);
  const at = "2026-03-01T00:00:00.000Z";
  for (let step = 0; publishCurrentBatch(sqlite, currentRegistry(config.subscriptions, at), at, 64, config); step++) {
    if (step > 100) throw new Error("coverage fixture projection did not settle");
  }
  return {
    sqlite,
    rateCards,
    accounts: config,
    // A retired stage saying otherwise is ignored.
    plans: { segments: [{ subscription: "codex1", plan: "plus", from: "2020-01-01" }] },
    plansCatalog: CATALOG,
  };
}

describe("history coverage", () => {
  it("uses proven physical ownership for stale-subject probes and moves only the corrected account", () => {
    const sqlite = coverageDb();
    try {
      const ts = "2026-02-02T12:00:00.000Z";
      const id = Number(sqlite.query(`INSERT INTO probe_windows(provider,subject,ts,kind,reported_percent_side,
        used_percent,resets_at,plan,machine,profile,extra)
        VALUES('codex','stale',?,'primary','used',30,'2026-02-09T12:00:00.000Z','plus','MAIN',?,?)`)
        .run(ts, LOGIN, JSON.stringify({ home: SOURCE_HOME })).lastInsertRowid);
      const reading = sqlite.query("SELECT * FROM probe_windows WHERE id=?").get(id) as Record<string, unknown>;
      const fact = createProbeCollection([{ ...reading, raw_subject: null, login: LOGIN, source_home: SOURCE_HOME }])[0]!;
      sqlite.transaction(() => { acceptProbeFact(sqlite, fact); mapProbeLegacy(sqlite, fact, id, "coverage-fixture"); }).immediate();
      const original = sqlite.query("SELECT subject,extra FROM probe_windows WHERE id=?").get(id);
      const ctx = context(sqlite);
      expect(buildHistoryCoverage(ctx).subscriptions[0]!.gauge).toMatchObject({
        basis: "probe-history", first_at: ts, last_at: ts, samples: 1, reset_samples: 1, plan_samples: 1,
      });
      replaceDeclaredPeriods(sqlite, ACCOUNT_PERIODS, [{ provider: "codex", subject: "codex/main", value: "other",
        from: "2000-01-01", until: null, origin: "declared", firstSeen: null, lastSeen: null,
        readings: 0, evidence: "coverage-correction" }]);
      expect(buildHistoryCoverage(context(sqlite)).subscriptions[0]!.gauge).toMatchObject({ basis: "none", samples: 0 });
      expect(sqlite.query("SELECT subject,extra FROM probe_windows WHERE id=?").get(id)).toEqual(original);
    } finally { sqlite.close(); }
  });
  it("finds historical usage gaps without reading or evaluating model prices", () => {
    const sqlite = coverageDb();
    try {
      sqlite.run(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES ('${GAUGE_HOME}', 'a.jsonl', '2026-01-01T12:00:00Z', 'gpt-test', 100, 0, 0, 20)`);
      const ctx = context(sqlite);
      Object.defineProperty(ctx, "rateCards", { get() { throw new Error("Coverage must not calculate prices"); } });
      expect(buildHistoryCoverage(ctx).subscriptions[0]!.usage).toMatchObject({ active_days: 1, calls: 1, tokens: 120 });
    } finally { sqlite.close(); }
  });
  it("reports one persistent account even when several machine declarations share its id", () => {
    const sqlite = coverageDb();
    try {
      const ctx = context(sqlite);
      ctx.accounts.subscriptions.push({ id: "CODEX1", vendor: "openai" });
      expect(buildHistoryCoverage(ctx).subscriptions.map(row => row.subscription)).toEqual(["codex1"]);
    } finally { sqlite.close(); }
  });
  it("counts days under a declared \"no subscription\" as covered plan history", () => {
    const sqlite = coverageDb();
    try {
      for (const day of ["2026-01-01", "2026-01-02", "2026-01-05"]) {
        sqlite.run(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES ('${GAUGE_HOME}', 'a.jsonl', ?, 'gpt-test', 100, 0, 0, 20)`, [`${day}T12:00:00Z`]);
      }
      const ctx = context(sqlite, "2026-01-05");
      replaceDeclaredPeriods(sqlite, PLAN_PERIODS, ["none", "plus"].map((value, index) => ({ provider: "codex", subject: "codex1", value,
        from: index ? "2026-01-05" : "2025-12-01", until: index ? null : "2026-01-05", origin: "declared" as const,
        firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" })));
      expect(buildHistoryCoverage(ctx).subscriptions[0]!.plan_history).toMatchObject({ status: "covered", uncovered_usage_days: 0 });
    } finally { sqlite.close(); }
  });
  it("suggests exact consecutive uncovered usage dates without filling idle days", () => {
    const sqlite = coverageDb();
    try {
      for (const day of ["2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05"]) {
        sqlite.run(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES ('${GAUGE_HOME}', 'a.jsonl', ?, 'gpt-test', 100, 0, 0, 20)`, [`${day}T12:00:00Z`]);
      }
      const ctx = context(sqlite, "2026-01-05");
      const row = buildHistoryCoverage(ctx).subscriptions[0]!;
      expect(row.plan_history).toMatchObject({ status: "partial", uncovered_usage_days: 3, uncovered_ranges: [
        { since: "2026-01-01", until: "2026-01-02", days: 2 },
        { since: "2026-01-04", until: "2026-01-04", days: 1 },
      ] });
    } finally { sqlite.close(); }
  });
  it("counts a day as covered only when plan periods name a plan through the whole day", () => {
    const sqlite = coverageDb();
    try {
      for (const day of ["2026-01-05", "2026-01-06"]) {
        sqlite.run(`INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES ('${GAUGE_HOME}', 'a.jsonl', ?, 'gpt-test', 100, 0, 0, 20)`, [`${day}T18:00:00Z`]);
      }
      const row = buildHistoryCoverage(context(sqlite, "2026-01-05T12:00:00.000Z")).subscriptions[0]!;
      expect(row.plan_history).toMatchObject({ status: "partial", plan_periods: 1, uncovered_usage_days: 1,
        uncovered_ranges: [{ since: "2026-01-05", until: "2026-01-05", days: 1 }] });
    } finally { sqlite.close(); }
  });
  it("reports the unknown pre-gauge gap without inventing historical fill", () => {
    const sqlite = coverageDb();
    sqlite.run(
      `INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES ('${GAUGE_HOME}', 'a.jsonl', '2026-01-01T12:00:00Z', 'gpt-test', 100, 0, 0, 20)`,
    );
    sqlite.run(
      `INSERT INTO ratelimit VALUES ('2026-02-01T12:00:00Z', ?, 'a.jsonl', 25, '2026-02-08T12:00:00Z', 'plus', 10080, 'codex')`,
      [GAUGE_HOME],
    );

    const row = buildHistoryCoverage(context(sqlite), { now: "2026-03-01T00:00:00Z" }).subscriptions[0]!;
    expect(row.usage).toMatchObject({ first_day: "2026-01-01", active_days: 1, calls: 1, tokens: 120 });
    expect(row.gauge).toMatchObject({
      basis: "vendor-history",
      samples: 1,
      reset_samples: 1,
      plan_samples: 1,
      actual_fill_available_from: "2026-02-01T12:00:00Z",
      history_before_first_gauge: "unknown",
      gap_days: 31,
      utilization_semantics: "observed-lower-bound",
    });
    expect(row.plan_history).toMatchObject({ status: "covered", uncovered_usage_days: 0 });
    expect(row.normalized_trend).toEqual({ available: true, reason: null });
    expect(row.actions).toEqual(["confirm-capacity-regimes"]);
    const withoutDeclaration = context(sqlite, null);
    expect(buildHistoryCoverage(withoutDeclaration).subscriptions[0]!.actions).toContain(
      "review-observed-plan-history",
    );
    sqlite.close();
  });

  it("marks a usage-only account as needing plan and gauge history", () => {
    const sqlite = coverageDb();
    sqlite.run(
      `INSERT INTO events(home,path,ts,model,in_tok,cached_in,cache_write,out_tok) VALUES ('${GAUGE_HOME}', 'a.jsonl', '2026-01-01T12:00:00Z', 'gpt-test', 100, 0, 0, 20)`,
    );
    const ctx = context(sqlite, null);
    const row = buildHistoryCoverage(ctx).subscriptions[0]!;
    expect(row.gauge.basis).toBe("none");
    expect(row.gauge.history_before_first_gauge).toBe("unknown");
    expect(row.gauge.gap_days).toBe(1);
    expect(row.plan_history.status).toBe("missing");
    expect(row.normalized_trend).toEqual({ available: false, reason: "no-gauge" });
    expect(row.actions).toEqual([
      "start-gauge-collection",
      "declare-plan-history",
      "confirm-capacity-regimes",
    ]);
    sqlite.close();
  });

  it("returns 404 for an unknown subscription filter", async () => {
    const sqlite = coverageDb();
    const response = handleHistoryCoverage(context(sqlite), new URL("http://localhost/api/history-coverage?subscription=missing"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "subscription 'missing' not found" });
    sqlite.close();
  });
});
