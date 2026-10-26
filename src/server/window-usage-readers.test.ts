import { expect, test } from "bun:test";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { createClaudeCodeAcceptanceFixture, measureAnalysis, ACCOUNTS, TIMES } from "./claude-code-capacity.fixture";
import { markLimitWindowsDirty } from "../db/limit-windows";
import type { Database } from "../db/sqlite";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { computeWindowUsageFull, readSpanSums, readWindowIntervals, readWindowSums, referenceFingerprint, WindowUsagePreparing, type WindowSums } from "./window-usage";
import type { RateCard } from "./pricing";
import { claudeWeeklyRegisterWindows } from "./probe-limit-windows";
import { buildSubscriptionAccountingReport } from "./subscription-accounting";
import { buildClaudeLimit, type ClaudeGaugeConfig } from "./claude-limit";
import { handleClaudeAccountSplits, handleClaudeLimit, handleWindows, type AppContext } from "./api";
import { getClaudeRate } from "./pricing";
import { loadAccountResolver } from "./account-resolver";
import { buildEraIndex } from "./eras";
import type { ManualCapacityMeasurement } from "../shared/manual-capacity";
import type { RailWindow } from "../web/lib/windows";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";

/**
 * Plan U1.4: the screens of Claude (and the other providers) read stored window rows. These tests use
 * the two-account Claude fixture: account-a has a weekly window [13.09, 20.09) with readings at 10% and
 * 24%, and canonical ledger traffic around both.
 */
const COUNTER = JSON.stringify(["weekly_all", "weekly", 10080]);
const SESSION = JSON.stringify(["session", "", 300]);
/** The fixture's own source declarations. */
const fixtureSources = Object.values(ACCOUNTS).map(id => ({ id, vendor: "claude", machine: "synthetic", login: "fixture",
  home: `${ARCHIVE_LOGICAL_ROOT}/claude/${id}`, source_home: `C:/Users/fixture/.claude-${id}` }));
/** A request that scans events or ledger facts for sums: what a screen read must never do. */
const eventScans = (queries: string[]) => queries.filter(query => /usage_ledger_facts/i.test(query)
  || /claude_events/i.test(query) && /in_uncached|out_total|SUM\(/i.test(query));
const rows = (db: Database, account: string): Map<string, WindowSums> =>
  new Map((db.query("SELECT * FROM window_usage WHERE provider='claude' AND account=? ORDER BY counter,window_id").all(account) as
    Array<Record<string, string>>).map(row => [row.window_id!, { cycle: JSON.parse(row.cycle!), rail: JSON.parse(row.rail!),
    readings: JSON.parse(row.readings!), slices: JSON.parse(row.slices!) }]));

function claudeEvent(f: ReturnType<typeof createClaudeCodeAcceptanceFixture>, id: string, ts: string, tokens: number, folder: string = ACCOUNTS.a) {
  f.db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total)
    VALUES('fixture-primary',?,?,?,?,'claude-sonnet-fixture','standard',?,'cli','2.1.0',?,?)`)
    .run(id, `session-${id}`, `${ARCHIVE_LOGICAL_ROOT}/claude/${folder}/${id}.jsonl`, ts, folder === ACCOUNTS.a || folder === ACCOUNTS.b ? folder : null,
      tokens * 0.8, tokens * 0.2);
}
function refusal(f: ReturnType<typeof createClaudeCodeAcceptanceFixture>, id: string, ts: string) {
  f.db.query(`INSERT INTO claude_limit_hits(store,call_id,ts,limit_type,status,resets_at,path)
    VALUES('fixture-primary',?,?,'seven_day','rejected',?,?)`).run(id, ts, TIMES.reset, `${ARCHIVE_LOGICAL_ROOT}/claude/${ACCOUNTS.a}/${id}.jsonl`);
  // The sync publication marks the refusals it publishes for the limit-window producer.
  markLimitWindowsDirty(f.db, "claude", "*", Date.parse(ts));
}

test("producer: a Claude refusal ends the paired part of its window and later traffic stays unpaired", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const week = () => claudeWeeklyRegisterWindows(f.db, ACCOUNTS.a).find(window => window.start === TIMES.start)!;
    const before = readWindowSums(f.db, "claude", ACCOUNTS.a, week().counter, [week()], ["cycle", "readings"]).get(week().id)!;
    expect(before.cycle.cycle_usage.tokens).toBe(170_000);
    expect(before.readings.map(reading => reading.usage.tokens)).toEqual([50_000, 161_000]);
    // The refusal on 18.09 is the vendor's 100% reading; a call on 19.09 comes after it.
    claudeEvent(f, "after-refusal", "2026-09-19T00:00:00.000Z", 5_000);
    refusal(f, "refused", "2026-09-18T00:00:00.000Z");
    f.prepareFacts();
    const window = week();
    expect(window.readings.map(reading => [reading.percent, reading.source])).toEqual([[10, "probe"], [24, "probe"], [100, "limit_hit"]]);
    const after = readWindowSums(f.db, "claude", ACCOUNTS.a, window.counter, [window], ["cycle", "readings"]).get(window.id)!;
    expect(after.cycle.cycle_usage.tokens).toBe(175_000);
    expect(after.cycle.usage.tokens).toBe(170_000);
    expect(after.cycle.unpaired_events).toBe(1);
    // Running totals at the refusal: everything up to it, all of it Code (rule @3), the duplicate copy counted once.
    expect(after.readings.at(-1)).toMatchObject({ ts: "2026-09-18T00:00:00.000Z", usage: { tokens: 170_000 },
      products: { code_tokens: 170_000, other_product_events: 0, unknown_events: 0, duplicate_copies: 1 } });
    expect(after.cycle.spend!.reduce((sum, spend) => sum + spend.tokens, 0)).toBe(175_000);
    // The incremental table is the full computation of the same windows and intervals.
    const full = computeWindowUsageFull(f.db, { rateCards: f.rates, claudeGauge: {} });
    for (const [key, sums] of full) {
      const [, account, , id] = JSON.parse(key) as string[];
      expect(rows(f.db, account!).get(id!)).toEqual(sums);
    }
  } finally { f.teardown(); }
});

test("producer: a manual measurement is its own (start, end] interval, recomputed on edit and removed on delete", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const measurement: ManualCapacityMeasurement = { id: "m1", account: ACCOUNTS.a, counter: SESSION,
      start: "2026-09-16T12:00:00.000Z", end: "2026-09-16T14:00:00.000Z", start_percent: 10, end_percent: 30,
      approximate_time: false, note: "panel", updated_at: "2026-09-17T00:00:00.000Z" };
    f.publishSums([measurement]);
    const stored = () => readSpanSums(f.db, "claude", ACCOUNTS.a, ["manual:m1"], ["cycle"]).get("manual:m1")!.cycle;
    // The call at the start instant is outside; the one at the end instant is inside.
    expect(stored().cycle_usage).toMatchObject({ events: 2, tokens: 24_000 });
    f.publishSums([{ ...measurement, end: "2026-09-16T15:00:00.000Z" }]);
    expect(stored().cycle_usage).toMatchObject({ events: 3, tokens: 41_000 });
    expect(readWindowIntervals(f.db, "claude", ACCOUNTS.a).find(interval => interval.id === "manual:m1")?.end).toBe("2026-09-16T15:00:00.000Z");
    f.publishSums([]);
    expect(() => stored()).toThrow(WindowUsagePreparing);
    expect(readWindowIntervals(f.db, "claude", ACCOUNTS.a).some(interval => interval.id === "manual:m1")).toBe(false);
  } finally { f.teardown(); }
});

test("subscription accounting reads window rows: no event scan, a missing row is preparing", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const measurement: ManualCapacityMeasurement = { id: "m1", account: ACCOUNTS.a, counter: SESSION,
      start: "2026-09-16T12:00:00.000Z", end: "2026-09-16T14:00:00.000Z", start_percent: 10, end_percent: 30,
      approximate_time: false, note: "panel", updated_at: "2026-09-17T00:00:00.000Z" };
    f.publishSums([measurement]);
    const ctx = { sqlite: f.db, rateCards: f.rates, plans: {}, plansCatalog: { provider_groups: [] }, manualCapacity: [measurement],
      resolver: loadAccountResolver(f.db) };
    const options = { since: "2026-09-13", until: "2026-09-17", account: ACCOUNTS.a, counter: COUNTER };
    const weekly = measureAnalysis(f.db, () => buildSubscriptionAccountingReport(ctx, "claude", options));
    expect(eventScans(weekly.rawOrFactQueries)).toEqual([]);
    const window = weekly.value.windows![0]!;
    expect(window).toMatchObject({ cycle_start: TIMES.start, start: TIMES.start, end: TIMES.asOf, start_basis: "reset",
      usage: { tokens: 161_000 }, cycle_usage: { tokens: 170_000 }, unpaired_events: 1 });
    expect(Object.keys(window)).toEqual(expect.arrayContaining(["id", "usage", "cycle_usage", "sources", "models", "evidence",
      "claude_code_capacity", "plan_detail", "promotion"]));
    const session = buildSubscriptionAccountingReport(ctx, "claude", { ...options, counter: SESSION });
    expect(session.windows!.map(w => [w.id, w.cycle_usage!.tokens, w.manual_measurement?.id])).toEqual([["manual:m1", 24_000, "m1"]]);
    // A window the producer has not published yet is "preparing", never computed in the request.
    f.db.exec("DELETE FROM window_usage WHERE provider='claude'");
    expect(() => buildSubscriptionAccountingReport(ctx, "claude", { ...options, until: "2026-09-16" })).toThrow(WindowUsagePreparing);
  } finally { f.teardown(); }
});

test("the Claude limit and account splits read stored sums; shapes are unchanged", async () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const gauge: ClaudeGaugeConfig = { subscription: ACCOUNTS.a, plan: "Max", window_hours: 168,
      limits: { fable: { share_of_all: 0.5, models: ["claude-sonnet-fixture"] } },
      observations: [{ ts: TIMES.asOf, reset_ts: TIMES.reset, window_start_ts: TIMES.start, percent: { all: 24, fable: 10 }, source: "panel" }] };
    prepareWindowUsageFixture(f.db, { rateCards: f.rates, claudeGauge: gauge, manualCapacity: () => [], cycles: { windows: [] } });
    const resolver = loadAccountResolver(f.db);
    const price = (model: string | null, day: string, speed: string | null) => getClaudeRate(f.rates, model, day, speed);
    const report = measureAnalysis(f.db, () => buildClaudeLimit(f.db, gauge, price, "2026-09-17T12:00:00.000Z", { rateCards: f.rates, resolver }));
    expect(eventScans(report.rawOrFactQueries)).toEqual([]);
    const limit = report.value;
    // The manual observation is its gauge interval [start, cutoff): the call at the cutoff instant is outside.
    const manual = limit.observations.find(observation => observation.basis === "manual")!;
    expect(manual).toMatchObject({ window_start_ts: TIMES.start, measured_through: TIMES.asOf, spend: { gross: 121_000 } });
    // The probe observation is the running total at its reading in the stored window.
    const probe = limit.observations.find(observation => observation.basis === "probe")!;
    expect(probe).toMatchObject({ window_start_ts: TIMES.start, measured_through: TIMES.asOf, spend: { gross: 161_000 } });
    expect(limit.calibration?.basis).toBe("code_share");
    expect(limit.current).toMatchObject({ window_start: TIMES.start, reset_at: TIMES.reset, spend: { gross: 170_000 },
      percent_all_measured: 24 });
    expect(limit.current!.fable_spend.gross).toBe(170_000);
    // The chart's daily bars regroup the same stored tokens.
    expect(limit.current!.days!.reduce((sum, day) => sum + day.tokens, 0)).toBe(170_000);
    expect(Object.keys(limit)).toEqual(["configured", "plan", "window_hours", "fable_share_of_all", "observations", "calibration",
      "models", "current", "session", "probe", "claude_code_capacity", "claude_capacity", "caveats"]);
    const ctx = { sqlite: f.db, rateCards: f.rates, resolver, claudeGauge: gauge, accounts: { subscriptions: [], sources: [] },
      vendorDiscovery: { accounts: [] } } as unknown as AppContext;
    const api = await handleClaudeLimit(ctx, new URL(`http://local/api/claude-limit?from=${TIMES.start}&until=${TIMES.reset}`)).json() as typeof limit;
    expect(api.current?.spend.gross).toBe(170_000);
    const splits = await handleClaudeAccountSplits(ctx, new URL("http://local/api/claude-account-splits?since=2026-09-13&until=2026-09-13")).json() as
      { pending: boolean; windows: Array<{ account: string; split: unknown }> };
    expect(splits.pending).toBe(false);
    // account-a's selected estimate is an interval between two readings, which never splits the account.
    expect(splits.windows.map(window => window.account)).toEqual([ACCOUNTS.b]);
  } finally { f.teardown(); }
});

test("the Claude rail draws stored activity and reconstructed windows; unowned traffic is not a zero", async () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    // A week the meter never reported, with traffic no account owns.
    claudeEvent(f, "unowned", "2026-09-01T12:00:00.000Z", 4_000, "nobody");
    f.prepareFacts();
    const gauge: ClaudeGaugeConfig = { subscription: ACCOUNTS.a, plan: "Max", window_hours: 168, observations: [] };
    const nowMs = Date.parse("2026-09-17T12:00:00.000Z");
    prepareWindowUsageFixture(f.db, { rateCards: f.rates, claudeGauge: gauge, manualCapacity: () => [], cycles: { windows: [] }, nowMs });
    const declared = readWindowIntervals(f.db, "claude", ACCOUNTS.a).filter(interval => interval.kind === "declared");
    expect(declared.some(interval => interval.start === "2026-09-06T00:00:00.000Z")).toBe(true);
    const ctx = { sqlite: f.db, rateCards: f.rates, resolver: loadAccountResolver(f.db, fixtureSources), claudeGauge: gauge,
      accounts: { subscriptions: fixtureSources, sources: fixtureSources }, cycles: { windows: [] }, eras: buildEraIndex([]), eraErrors: [],
      homeToSubId: new Map(), subIdToHomes: new Map(), plans: {}, plansCatalog: { provider_groups: [] }, rootDir: "" } as unknown as AppContext;
    const measured = await measureAnalysis(f.db, () => handleWindows(ctx, new URL(`http://local/api/windows?account=${ACCOUNTS.a}`)));
    const body = await (await measured.value).json() as { source: string; windows: RailWindow[] };
    expect(eventScans(measured.rawOrFactQueries)).toEqual([]);
    expect(body.source).toBe("probe+declared");
    const current = body.windows.find(window => window.startIso === TIMES.start)!;
    expect(current.activityShape?.at(-1)).toEqual({ t: 100, amount: 170_000 });
    expect(current.activityShape!.every(point => point.t * 4 === Math.round(point.t * 4))).toBe(true);
    // Every counted call of the window came from account-a's archive folder, declared on machine "synthetic".
    expect(current.trafficByMachine).toEqual([{ machine: "synthetic", amount: 170_000 }]);
    const unowned = body.windows.find(window => window.startIso === "2026-08-30T00:00:00.000Z")!;
    expect(unowned).toMatchObject({ source: "probe", tokensTotal: null, usd: null });
    expect(unowned.note).toContain("bez przypisanego konta");
    const quiet = body.windows.find(window => window.startIso === "2026-08-23T00:00:00.000Z")!;
    expect(quiet).toMatchObject({ tokensTotal: 0, usd: 0 });
    // Rows that are not published yet make the rail answer "preparing".
    f.db.exec("DELETE FROM window_usage WHERE window_id LIKE 'declared:%'");
    expect((await handleWindows(ctx, new URL(`http://local/api/windows?account=${ACCOUNTS.a}`))).status).toBe(202);
  } finally { f.teardown(); }
});

test("a week without a meter reading yet: the Claude limit's current window is the stored reconstructed week with its usage", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    // The meter's last reading is in the week that reset on 20.09; the next week has traffic but no reading.
    claudeEvent(f, "next-week", "2026-09-21T06:00:00.000Z", 7_000);
    f.prepareFacts();
    const gauge: ClaudeGaugeConfig = { subscription: ACCOUNTS.a, plan: "Max", window_hours: 168, observations: [] };
    const now = "2026-09-21T12:00:00.000Z";
    prepareWindowUsageFixture(f.db, { rateCards: f.rates, claudeGauge: gauge, manualCapacity: () => [], cycles: { windows: [] }, nowMs: Date.parse(now) });
    expect(claudeWeeklyRegisterWindows(f.db, ACCOUNTS.a).some(window => Date.parse(window.start) <= Date.parse(now)
      && Date.parse(now) < Date.parse(window.end))).toBe(false);
    const price = (model: string | null, day: string, speed: string | null) => getClaudeRate(f.rates, model, day, speed);
    const report = measureAnalysis(f.db, () => buildClaudeLimit(f.db, gauge, price, now, { rateCards: f.rates, resolver: loadAccountResolver(f.db) }));
    expect(eventScans(report.rawOrFactQueries)).toEqual([]);
    const declared = readWindowIntervals(f.db, "claude", ACCOUNTS.a).find(interval => interval.kind === "declared"
      && interval.start === TIMES.reset)!;
    const stored = readSpanSums(f.db, "claude", ACCOUNTS.a, [declared.id], ["cycle"]).get(declared.id)!.cycle;
    expect(stored.cycle_usage.tokens).toBeGreaterThanOrEqual(7_000);
    // Tokens and dollars of the week are shown, as the rail stores them; its percent is only estimated from the week before.
    expect(report.value.current).toMatchObject({ window_id: declared.id, window_start: TIMES.reset, reset_at: declared.end,
      spend: { gross: stored.spend!.reduce((sum, spend) => sum + spend.tokens, 0) }, percent_all_measured: null,
      measured_at: null });
    expect(report.value.current!.percent_all_est).not.toBeNull();
    expect(report.value.current!.days!.reduce((sum, day) => sum + day.tokens, 0)).toBe(report.value.current!.spend.gross);
  } finally { f.teardown(); }
});

test("the windows API omits reconstructed weeks outside the plan but keeps actual meter evidence and active empty weeks", async () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    replaceDeclaredPeriods(f.db, PLAN_PERIODS, [{ provider: "claude", subject: ACCOUNTS.a, value: "pro",
      from: "2026-08-30", until: "2026-09-13", origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
    const gauge: ClaudeGaugeConfig = { subscription: ACCOUNTS.a, plan: "Pro", window_hours: 168, observations: [] };
    prepareWindowUsageFixture(f.db, { rateCards: f.rates, claudeGauge: gauge, manualCapacity: () => [], cycles: { windows: [] },
      nowMs: Date.parse("2026-10-25") });
    const ctx = { sqlite: f.db, rateCards: f.rates, resolver: loadAccountResolver(f.db, fixtureSources), claudeGauge: gauge,
      accounts: { subscriptions: fixtureSources, sources: fixtureSources }, cycles: { windows: [] }, eras: buildEraIndex([]), eraErrors: [],
      homeToSubId: new Map(), subIdToHomes: new Map(), plans: {}, plansCatalog: { provider_groups: [] }, rootDir: "" } as unknown as AppContext;
    const changes = () => f.db.query("SELECT total_changes() n").get();
    const before = changes();
    const measured = measureAnalysis(f.db, () => handleWindows(ctx, new URL(`http://local/api/windows?account=${ACCOUNTS.a}`)));
    const response = await measured.value;
    expect(response.status).toBe(200);
    const body = await response.json() as { windows: RailWindow[] };
    expect(eventScans(measured.rawOrFactQueries)).toEqual([]);
    expect(changes()).toEqual(before);
    expect(body.windows.map(window => window.startIso?.slice(0, 10)).sort()).toEqual(["2026-08-30", "2026-09-06", "2026-09-13"]);
    const actual = body.windows.find(window => window.startIso === TIMES.start)!;
    expect(actual.sampledAtIso).toBe(TIMES.asOf);
    expect(actual.activityShape?.at(-1)?.amount).toBe(170_000);
    expect(claudeWeeklyRegisterWindows(f.db, ACCOUNTS.a)[0]!.readings.at(-1)?.percent).toBe(24);
    expect(body.windows.find(window => window.startIso === "2026-08-30T00:00:00.000Z")).toMatchObject({ tokensTotal: 0, usd: 0 });
  } finally { f.teardown(); }
});

test("the week after a reset is current as soon as the clock passes the reset, before the meter reports it", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const gauge: ClaudeGaugeConfig = { subscription: ACCOUNTS.a, plan: "Max", window_hours: 168, observations: [] };
    const options = { rateCards: f.rates, claudeGauge: gauge, manualCapacity: () => [], cycles: { windows: [] } };
    // The producer ran minutes before the reset (as the worker does every second), then again just after it.
    prepareWindowUsageFixture(f.db, { ...options, nowMs: Date.parse(TIMES.reset) - 4 * 60_000 });
    const now = new Date(Date.parse(TIMES.reset) + 3 * 60_000).toISOString();
    prepareWindowUsageFixture(f.db, { ...options, nowMs: Date.parse(now) });
    const declared = readWindowIntervals(f.db, "claude", ACCOUNTS.a).find(interval => interval.kind === "declared"
      && interval.start === TIMES.reset);
    expect(declared).toBeDefined();
    const price = (model: string | null, day: string, speed: string | null) => getClaudeRate(f.rates, model, day, speed);
    const report = buildClaudeLimit(f.db, gauge, price, now, { rateCards: f.rates, resolver: loadAccountResolver(f.db) });
    expect(report.current).toMatchObject({ window_id: declared!.id, window_start: TIMES.reset, percent_all_measured: null });
    // Until the first reading, the week before it prices the indexed usage since the reset: an estimate, never a measurement.
    expect(report.current!.percent_all_est).toBeGreaterThan(0);
    expect(report.current!.percent_all_est).toBeLessThan(1);
  } finally { f.teardown(); }
});

test("reference-day variant: stored for the configured day, read for any day with the same rates, recomputed when they change", () => {
  const f = createClaudeCodeAcceptanceFixture({ referenceDay: "2026-09-20" });
  try {
    const produce = (rateCards: RateCard, referenceDay: string) => prepareWindowUsageFixture(f.db, { rateCards, claudeGauge: {},
      manualCapacity: () => [], cycles: { windows: [] }, referenceDay });
    produce(f.rates, "2026-09-20");
    const week = () => claudeWeeklyRegisterWindows(f.db, ACCOUNTS.a).find(window => window.start === TIMES.start)!;
    const row = () => readWindowSums(f.db, "claude", ACCOUNTS.a, week().counter, [week()], ["cycle", "reference"]).get(week().id)!;
    // Fixture preparation uses the same configured day, independently of the machine's clock.
    expect(row().reference).toMatchObject({ day: "2026-09-20", fingerprint: referenceFingerprint(f.rates, "claude", "2026-09-20") });
    // Every event costs tokens × 5.4 / 1M at these rates; the ordinary cycle carries no reference fields.
    expect(row().reference!.cycle.cycle_usage.reference_api_standard).toBeCloseTo(0.918, 9);
    expect(row().cycle.cycle_usage.reference_api_standard).toBeUndefined();
    const ctx = (rateCards: RateCard) => ({ sqlite: f.db, rateCards, plans: {}, plansCatalog: { provider_groups: [] }, manualCapacity: [],
      resolver: loadAccountResolver(f.db) });
    const options = { since: "2026-09-13", until: "2026-09-17", account: ACCOUNTS.a, counter: COUNTER };
    const report = (rateCards: RateCard, reference_day: string) =>
      measureAnalysis(f.db, () => buildSubscriptionAccountingReport(ctx(rateCards), "claude", { ...options, reference_day }));
    // The configured day and another day with the same rates read the stored variant.
    for (const day of ["2026-09-20", "2026-09-21"]) {
      const read = report(f.rates, day);
      expect(eventScans(read.rawOrFactQueries)).toEqual([]);
      expect(read.value.windows![0]!.cycle_usage).toMatchObject({ tokens: 170_000, reference_priced_tokens: 170_000 });
      expect(read.value.windows![0]!.cycle_usage!.reference_api_standard).toBeCloseTo(0.918, 9);
    }

    // The rates double after 25.09 and the configured day moves to 05.10: the variant is valued again at the new rates.
    const base = { in_uncached: 3, in_cache_read: 0.3, in_cache_write_5m: 3.75, in_cache_write_1h: 6, out_total: 15 };
    const doubled = { ...f.rates, vendors: { anthropic: { source: "independent-synthetic-fixture", models: { "claude-sonnet-fixture": { ...base,
      until: "2026-09-25", after: { in_uncached: 6, in_cache_read: 0.6, in_cache_write_5m: 7.5, in_cache_write_1h: 12, out_total: 30 } } } } } } as RateCard;
    f.prepareFacts(doubled);
    // The fixture still prepares 20.09, whose rates did not change; changing the configured day must publish the doubled variant.
    expect(row().reference!.day).toBe("2026-09-20");
    expect(row().reference!.cycle.cycle_usage.reference_api_standard).toBeCloseTo(0.918, 9);
    produce(doubled, "2026-10-05");
    expect(row().reference).toMatchObject({ day: "2026-10-05", fingerprint: referenceFingerprint(doubled, "claude", "2026-10-05") });
    expect(row().reference!.cycle.cycle_usage.reference_api_standard).toBeCloseTo(1.836, 9);
    const after = report(doubled, "2026-09-30");
    expect(eventScans(after.rawOrFactQueries)).toEqual([]);
    expect(after.value.windows![0]!.cycle_usage!.reference_api_standard).toBeCloseTo(1.836, 9);
    // A day with other rates is the named bounded exception: the window's own calls are valued in the request.
    const before = report(doubled, "2026-09-20");
    expect(eventScans(before.rawOrFactQueries).length).toBeGreaterThan(0);
    expect(before.value.windows![0]!.cycle_usage!.reference_api_standard).toBeCloseTo(0.918, 9);
    // The next day with unchanged rates recomputes nothing: the stored variant keeps its day.
    produce(doubled, "2026-10-06");
    expect(row().reference!.day).toBe("2026-10-05");
  } finally { f.teardown(); }
});
