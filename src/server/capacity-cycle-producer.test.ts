import { expect, test, spyOn } from "bun:test";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS, TIMES } from "./claude-code-capacity.fixture";
import { advanceCapacityCycleResults } from "./capacity-cycle-producer";
import { handleCapacityCycles } from "./capacity-cycles";
import { capacityCyclesReference } from "../../scripts/lib/capacity-cycles-reference";
import type { AppContext } from "./api";
import { markWindowAnswersDirty } from "../db/window-answers";
import { CAPACITY_CYCLE_RESULTS_SQL } from "../db/capacity-cycle-results";
import * as manualStore from "./manual-capacity";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import fs from "node:fs";
import { markCapacityCycleResultsDirty } from "../db/capacity-cycle-results";
import * as accounting from "./subscription-accounting";
import { database as codexDatabase, settle as prepareCodexSums, card as codexRates, sources as codexSources, opened as codexOpened } from "./window-usage-codex.fixture";
import { ensureCapacityCycleResults } from "../db/capacity-cycle-results";
import { PLAN_PERIODS, ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { publishCurrentBatch } from "./current/store";
import { currentRegistry } from "./current/registry";
import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { markWindowUsageDirty } from "../db/window-usage";

const url = (since = "2026-09-13", until = "2026-09-19", minutes = 10080) => new URL(`http://local/api/capacity-cycles?since=${since}&until=${until}&window_minutes=${minutes}`);
function context(f: ReturnType<typeof createClaudeCodeAcceptanceFixture>): AppContext {
  return { sqlite: f.db, accounts: { version: 2, subscriptions: Object.values(ACCOUNTS).map(id => ({ id, vendor: "claude" })), sources: [] },
    rateCards: f.rates, plans: {}, plansCatalog: { provider_groups: [] }, cycles: {} } as unknown as AppContext;
}
function settle(ctx: AppContext) {
  let total = 0;
  for (let i = 0; i < 500; i++) { const result = advanceCapacityCycleResults(ctx, { budgetMs: 10000 }); total += result?.processed ?? 0; if (!result?.pending) return total; }
  throw new Error("Capacity projection did not settle");
}
test("migration and producer schema agree", () => {
  expect(fs.readFileSync(new URL("../../drizzle/0081_capacity_cycle_results.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint\n", "").trim()).toBe(CAPACITY_CYCLE_RESULTS_SQL.trim());
});

test("Codex projections retain exact per-cycle results and never request shared-provider manual settings", async () => {
  const db = codexDatabase();
  try {
    prepareCodexSums(db); ensureCapacityCycleResults(db);
    const ctx = { sqlite: db, accounts: { version: 2, subscriptions: [{ id: "codex1", vendor: "codex" }], sources: codexSources },
      rateCards: codexRates, plans: {}, plansCatalog: { provider_groups: [] }, cycles: {} } as unknown as AppContext;
    settle(ctx);
    for (const request of [url("2026-09-01", "2026-09-21"), url("2026-09-12", "2026-09-12"), url(undefined, undefined, 300)])
      expect(await handleCapacityCycles(ctx, request).json()).toEqual(await capacityCyclesReference(ctx, request).json());
    expect(settle(ctx)).toBe(0);
  } finally { codexOpened.splice(codexOpened.indexOf(db), 1); db.close(); }
});

test("30-day Free projections use separate stored sums and match a full reference without changing weekly results", async () => {
  const db = codexDatabase();
  try {
    prepareCodexSums(db); ensureCapacityCycleResults(db);
    const ctx = { sqlite: db, accounts: { version: 2, subscriptions: [{ id: "codex1", vendor: "codex" }], sources: codexSources },
      rateCards: codexRates, plans: {}, plansCatalog: { provider_groups: [] }, cycles: {} } as unknown as AppContext;
    settle(ctx);
    const weekly = await handleCapacityCycles(ctx, url("2026-09-01", "2026-09-30")).json();
    const counter = '["codex","codex",43200]', reset = "2026-10-01T00:00:00.000Z";
    const readings = [{ ts: "2026-09-01T00:00:00.000Z", percent: 0, source: "probe" },
      { ts: "2026-09-03T00:00:00.000Z", percent: 20, source: "probe" }, { ts: "2026-09-07T00:00:00.000Z", percent: 100, source: "probe" }];
    db.query(`INSERT INTO limit_windows(provider,account,counter,seq,window_id,start_ts,end_ts,reset_ts,cycle_end_basis,
      window_minutes,plan,plan_detail,plan_mismatch,readings,manual,start_drop,end_drop,seen_reset,last_input)
      SELECT provider,account,?,0,'free-month','2026-09-01T00:00:00.000Z',?,?,'scheduled',43200,'free',NULL,0,?,NULL,NULL,NULL,1,'{}'
      FROM limit_windows WHERE provider='codex' LIMIT 1`).run(counter, reset, reset, JSON.stringify(readings));
    db.query("INSERT INTO limit_window_state(provider,account,scope,version,status) VALUES('codex','codex1',?,1,'ready')").run(counter);
    markWindowUsageDirty(db, { provider: "codex", account: "codex1", counter, fromMs: Date.parse("2026-09-01") });
    prepareCodexSums(db); settle(ctx);
    const request = url("2026-09-01", "2026-09-30", 43200);
    const monthly = await handleCapacityCycles(ctx, request).json();
    expect(monthly).toEqual(await capacityCyclesReference(ctx, request).json());
    expect(monthly.accounts[0]).toMatchObject({ counter: "thirty_day", counter_label: "30d" });
    expect(monthly.accounts[0].windows).toHaveLength(1);
    expect(monthly.accounts[0].windows[0]).toMatchObject({ window_minutes: 43200, observed_pp: 100 });
    expect(monthly.accounts[0].windows[0].usage.events).toBeGreaterThan(0);
    expect(await handleCapacityCycles(ctx, url("2026-09-01", "2026-09-30")).json()).toEqual(weekly);
    expect(settle(ctx)).toBe(0);
  } finally { codexOpened.splice(codexOpened.indexOf(db), 1); db.close(); }
});

test("prepared capacity cycles equal existing formulas for full and overlapping filters, then survive restart", async () => {
  const f = createClaudeCodeAcceptanceFixture(); let ctx = context(f);
  const manual = spyOn(manualStore, "readManualCapacity").mockReturnValue({ revision: "fixture", measurements: [] });
  try {
    expect((await handleCapacityCycles(ctx, url()).json()).accounts.every((row: any) => row.preparing)).toBe(true);
    expect(settle(ctx)).toBeGreaterThan(0);
    for (const request of [url(), url("2026-09-16", "2026-09-16"), url("2026-09-20", "2026-09-20"), url(undefined, undefined, 300)])
      expect(await handleCapacityCycles(ctx, request).json()).toEqual(await capacityCyclesReference(ctx, request).json());
    const before = await handleCapacityCycles(ctx, url()).json();
    const query = spyOn(ctx.sqlite, "query");
    await handleCapacityCycles(ctx, url()).json();
    expect(query.mock.calls.some(([sql]) => /\b(?:FROM|JOIN)\s+(?:window_usage|probe_|claude_events|usage_ledger_facts)/i.test(String(sql)))).toBe(false);
    expect(query.mock.calls.some(([sql]) => /\b(?:UPDATE|INSERT|DELETE)\b/i.test(String(sql)))).toBe(false);
    query.mockRestore();
    f.reopen(); ctx = context(f);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(before);
    expect(settle(ctx)).toBe(0);
  } finally { manual.mockRestore(); f.teardown(); }
});

test("a changed share corrects only its cycle; unrelated account and provider marks do no work", async () => {
  const f = createClaudeCodeAcceptanceFixture(), ctx = context(f);
  const manual = spyOn(manualStore, "readManualCapacity").mockReturnValue({ revision: "fixture", measurements: [] });
  try {
    settle(ctx);
    const before = await handleCapacityCycles(ctx, url()).json();
    markWindowAnswersDirty(f.db, { provider: "grok", account: ACCOUNTS.a, fromMs: Date.parse(TIMES.start), untilMs: Date.parse(TIMES.reset) });
    expect(settle(ctx)).toBe(0);
    f.changeShare(15);
    expect((await handleCapacityCycles(ctx, url()).json()).accounts.find((row: any) => row.account === ACCOUNTS.a).preparing).toBe(true);
    expect(settle(ctx)).toBe(1);
    const after = await handleCapacityCycles(ctx, url()).json();
    expect(after).toEqual(await capacityCyclesReference(ctx, url()).json());
    expect(after.accounts.find((row: any) => row.account === ACCOUNTS.b)).toEqual(before.accounts.find((row: any) => row.account === ACCOUNTS.b));
    expect(after.accounts.find((row: any) => row.account === ACCOUNTS.a)).not.toEqual(before.accounts.find((row: any) => row.account === ACCOUNTS.a));
    expect(settle(ctx)).toBe(0);
  } finally { manual.mockRestore(); f.teardown(); }
});

test("manual interval changes and configuration changes retain the same standalone/meter projections", async () => {
  const f = createClaudeCodeAcceptanceFixture(), ctx = context(f);
  let measurements: ManualCapacityMeasurement[] = [];
  const manual = spyOn(manualStore, "readManualCapacity").mockImplementation(() => ({ revision: "fixture", measurements }));
  try {
    settle(ctx);
    measurements = [{ id: "manual-capacity", account: ACCOUNTS.a, counter: '["weekly_all","weekly",10080]',
      start: "2026-08-01T00:00:00.000Z", end: "2026-08-07T00:00:00.000Z", start_percent: 10, end_percent: 50,
      approximate_time: true, note: "fixture", updated_at: TIMES.asOf }];
    f.publishSums(measurements);
    settle(ctx);
    const request = url("2026-08-01", "2026-09-19");
    expect(await handleCapacityCycles(ctx, request).json()).toEqual(await capacityCyclesReference(ctx, request).json());
    measurements = []; f.publishSums(measurements); settle(ctx);
    expect(await handleCapacityCycles(ctx, request).json()).toEqual(await capacityCyclesReference(ctx, request).json());
    ctx.plans = { capacity_regimes: [{ id: "changed", subscription: ACCOUNTS.a, factor: 2, from: "2026-09-01" }] };
    expect((await handleCapacityCycles(ctx, url()).json()).accounts.find((row: any) => row.account === ACCOUNTS.a).preparing).toBe(true);
    expect(settle(ctx)).toBe(1);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(await capacityCyclesReference(ctx, url()).json());
  } finally { manual.mockRestore(); f.teardown(); }
});

test("identity inventory and deletion are bounded and resume across restart and a newer overlapping mark", async () => {
  const f = createClaudeCodeAcceptanceFixture(); let ctx = context(f);
  const manual = spyOn(manualStore, "readManualCapacity").mockReturnValue({ revision: "fixture", measurements: [] });
  try {
    settle(ctx);
    const template = f.db.query("SELECT * FROM limit_windows WHERE account=? LIMIT 1").get(ACCOUNTS.a) as Record<string, string | number | null>;
    const columns = Object.keys(template), insert = f.db.query(`INSERT INTO limit_windows(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
    for (let i = 1; i <= 150; i++) insert.run(...columns.map(column => column === "seq" ? Number(template.seq) + i + 1000 : column === "window_id" ? `synthetic:${String(i).padStart(3, "0")}` : template[column]!));
    markCapacityCycleResultsDirty(f.db, "claude", ACCOUNTS.a, Date.parse(TIMES.start), Date.parse(TIMES.reset));
    const first = advanceCapacityCycleResults(ctx, { limit: 1 });
    expect(first?.discovered).toBe(64); expect(first?.pending).toBe(true);
    expect((f.db.query("SELECT COUNT(*) n FROM capacity_cycle_results WHERE window_id LIKE 'synthetic:%'").get() as { n: number }).n).toBeLessThanOrEqual(64);
    const cursor = f.db.query("SELECT cursor FROM capacity_cycle_result_dirty WHERE account=?").get(ACCOUNTS.a) as { cursor: string };
    expect(cursor.cursor).toBeString();
    f.reopen(); ctx = context(f);
    expect((f.db.query("SELECT cursor FROM capacity_cycle_result_dirty WHERE account=?").get(ACCOUNTS.a) as { cursor: string }).cursor).toBe(cursor.cursor);
    markCapacityCycleResultsDirty(f.db, "claude", ACCOUNTS.a, Date.parse(TIMES.start), Date.parse(TIMES.reset) + 1);
    expect((f.db.query("SELECT cursor FROM capacity_cycle_result_dirty WHERE account=?").get(ACCOUNTS.a) as { cursor: string | null }).cursor).toBeNull();
    // Remove sources during discovery: the retained generation restarts and the paged orphan sweep removes partial identities.
    f.db.exec("DELETE FROM limit_windows WHERE window_id LIKE 'synthetic:%'");
    markCapacityCycleResultsDirty(f.db, "claude", ACCOUNTS.a, Date.parse(TIMES.start), Date.parse(TIMES.reset) + 1);
    expect((await handleCapacityCycles(ctx, url()).json()).accounts.find((row: any) => row.account === ACCOUNTS.a).preparing).toBe(true);
    settle(ctx);
    expect((f.db.query("SELECT COUNT(*) n FROM capacity_cycle_results WHERE window_id LIKE 'synthetic:%'").get() as { n: number }).n).toBe(0);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(await capacityCyclesReference(ctx, url()).json());
  } finally { manual.mockRestore(); f.teardown(); }
});

test("a burst of marks for one cycle is folded before its projection is calculated", async () => {
  const f = createClaudeCodeAcceptanceFixture(), ctx = context(f);
  const manual = spyOn(manualStore, "readManualCapacity").mockReturnValue({ revision: "fixture", measurements: [] });
  try {
    settle(ctx);
    const before = await handleCapacityCycles(ctx, url()).json();
    for (let i = 1; i <= 20; i++) {
      const from = Date.parse(TIMES.start) + i * 1000;
      markCapacityCycleResultsDirty(f.db, "claude", ACCOUNTS.a, from, from + 1);
    }
    expect((f.db.query("SELECT COUNT(*) n FROM capacity_cycle_result_dirty").get() as { n: number }).n).toBe(20);
    const result = advanceCapacityCycleResults(ctx, { budgetMs: 10000 });
    expect(result?.processed).toBe(1);
    expect(result?.pending).toBe(false);
    expect(result?.discovered).toBeLessThanOrEqual(64);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(before);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(await capacityCyclesReference(ctx, url()).json());
    f.reopen(); ctx.sqlite = f.db;
    expect(settle(ctx)).toBe(0);
  } finally { manual.mockRestore(); f.teardown(); }
});

test("projection errors stay explicit without a busy loop and a later source publication retries them", async () => {
  const f = createClaudeCodeAcceptanceFixture(), ctx = context(f);
  const manual = spyOn(manualStore, "readManualCapacity").mockReturnValue({ revision: "fixture", measurements: [] });
  const real = accounting.subscriptionCapacityCycles;
  const calculate = spyOn(accounting, "subscriptionCapacityCycles").mockImplementation((...args) => {
    if (args[2] === ACCOUNTS.a) throw new Error("synthetic projection failure");
    return real(...args);
  });
  try {
    settle(ctx);
    const row = (await handleCapacityCycles(ctx, url()).json()).accounts.find((entry: any) => entry.account === ACCOUNTS.a);
    expect(row.error).toBe("synthetic projection failure"); expect(row.windows).toEqual([]);
    expect(settle(ctx)).toBe(0);
    calculate.mockRestore();
    markCapacityCycleResultsDirty(f.db, "claude", ACCOUNTS.a, Date.parse(TIMES.asOf), Date.parse(TIMES.asOf) + 1);
    expect(settle(ctx)).toBe(1);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(await capacityCyclesReference(ctx, url()).json());
  } finally { calculate.mockRestore(); manual.mockRestore(); f.teardown(); }
});

test("dated plan and owner corrections publish only affected accounts and match the full reference", async () => {
  const f = createClaudeCodeAcceptanceFixture(), ctx = context(f);
  const manual = spyOn(manualStore, "readManualCapacity").mockReturnValue({ revision: "fixture", measurements: [] });
  try {
    settle(ctx);
    const beforeB = (await handleCapacityCycles(ctx, url()).json()).accounts.find((row: any) => row.account === ACCOUNTS.b);
    replaceDeclaredPeriods(f.db, PLAN_PERIODS, [{ provider: "claude", subject: ACCOUNTS.a, value: "max20", from: TIMES.start, until: null,
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
    f.prepareProbes();
    expect(settle(ctx)).toBe(1);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(await capacityCyclesReference(ctx, url()).json());
    expect((await handleCapacityCycles(ctx, url()).json()).accounts.find((row: any) => row.account === ACCOUNTS.b)).toEqual(beforeB);
    ctx.accounts.subscriptions.push({ id: "account-c", vendor: "claude" });
    replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, loadPeriods(f.db, ACCOUNT_PERIODS).filter(period => period.origin === "declared")
      .map(period => period.provider === "claude" && period.value === ACCOUNTS.a ? { ...period, value: "account-c" } : period));
    const config = { subscriptions: ctx.accounts.subscriptions, sources: Object.values(ACCOUNTS).map(id => ({ vendor: "claude", machine: "synthetic", login: "fixture",
      home: `${ARCHIVE_LOGICAL_ROOT}/claude/${id}`, source_home: `C:/Users/fixture/.claude-${id}` })) };
    for (let i = 0; publishCurrentBatch(f.db, currentRegistry(config.subscriptions), "2026-09-21T00:00:00.000Z", 64, config); i++)
      if (i > 100) throw new Error("Period feed did not settle");
    prepareLimitWindowsFixture(f.db, { sources: config.sources });
    prepareWindowUsageFixture(f.db, { rateCards: f.rates, subscriptions: ctx.accounts.subscriptions, manualCapacity: () => [] });
    settle(ctx);
    expect(await handleCapacityCycles(ctx, url()).json()).toEqual(await capacityCyclesReference(ctx, url()).json());
    expect((await handleCapacityCycles(ctx, url()).json()).accounts.find((row: any) => row.account === ACCOUNTS.b)).toEqual(beforeB);
  } finally { manual.mockRestore(); f.teardown(); }
});
