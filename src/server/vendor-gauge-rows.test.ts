import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { Database } from "../db/sqlite";
import { createTestDatabase } from "../sync/test-support";
import { installAnalysisTracking } from "../db/analysis";
import { GROK_TICKS_PER_USD } from "../ingest/grok";
import type { RateCard } from "./pricing";
import { prepareProbeReaderFixture, probeReaderFixtureSource, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { fillUsageLedgerFixture } from "./usage-ledger.fixture";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { computeWindowUsageFull, readSpanSums, readWindowIntervals, WindowUsagePreparing } from "./window-usage";
import { buildGrokLimit } from "./grok-limit";
import { buildGlmLimit } from "./glm-limit";
import type { GrokGaugeConfig } from "./grok-gauge-spans";
import { buildEraIndex } from "./eras";
import { handleRoster, handleWindows, periodEras, type AppContext } from "./api";

/**
 * Plan U1.4: the gauges of Grok, GLM and Gemini read stored rows (limit windows, window_usage and the
 * producer's intervals). Every reader here runs under a recorder of the SQL it issues; a read of the
 * provider's calls (its event table or the ledger's facts) fails the test.
 */
const RATES: RateCard = { version: 1, currency: "USD", unit: "per 1M", vendors: {
  xai: { models: { "grok-4": { in_uncached: 1, in_cache_read: 0.1, in_cache_write: 1, out_total: 2 } } },
  zai: { models: { "glm-test": { in_uncached: 1000, in_cache_read: 0, in_cache_write: 0, out_total: 0 } } },
  google: { models: { "gemini-2.5-pro": { in_uncached: 1000, in_cache_read: 0, in_cache_write: 0, out_total: 0 } } },
} } as unknown as RateCard;
const CALL_TABLES = /\b(?:FROM|JOIN)\s+["`[]?(?:grok_events|gemini_events|oc_events|claude_events|events|usage_ledger_facts|codex_price_ledger_events)\b/i;

function recordCallReads<T>(db: Database, read: () => T): { value: T; callReads: string[] } {
  const callReads: string[] = [], query = db.query, prepare = db.prepare;
  const record = (statement: string) => { if (CALL_TABLES.test(statement)) callReads.push(statement); };
  db.query = function (this: Database, statement: string, ...rest: unknown[]) { record(statement); return query.call(this, statement, ...rest as []); } as typeof db.query;
  db.prepare = function (this: Database, statement: string, ...rest: unknown[]) { record(statement); return prepare.call(this, statement, ...rest as []); } as typeof db.prepare;
  try { return { value: read(), callReads }; }
  finally { db.query = query; db.prepare = prepare; }
}
async function recordCallReadsAsync<T>(db: Database, read: () => Promise<T>): Promise<{ value: T; callReads: string[] }> {
  const callReads: string[] = [], query = db.query, prepare = db.prepare;
  const record = (statement: string) => { if (CALL_TABLES.test(statement)) callReads.push(statement); };
  db.query = function (this: Database, statement: string, ...rest: unknown[]) { record(statement); return query.call(this, statement, ...rest as []); } as typeof db.query;
  db.prepare = function (this: Database, statement: string, ...rest: unknown[]) { record(statement); return prepare.call(this, statement, ...rest as []); } as typeof db.prepare;
  try { return { value: await read(), callReads }; }
  finally { db.query = query; db.prepare = prepare; }
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** One Grok account with its archive source, turns priced by xAI's own ticks, and the maintenance worker's producers. */
function grokFixture(gauge: GrokGaugeConfig) {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  cleanups.push(() => { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  installAnalysisTracking(db);
  const source = probeReaderFixtureSource("grok", "grok");
  let n = 0;
  const turn = (ts: string, tokens: number, usd: number) => db.query(`INSERT INTO grok_events
      (store,source_id,session_id,prompt_id,ts,model,path,in_tok,cached_in,out_tok,model_calls,cost_ticks)
      VALUES('grok','',?,?,?,'grok-4',?,?,0,0,7,?)`)
    .run(`session-${n}`, `prompt-${n++}`, ts, `${source.home}/sessions/s/updates.jsonl`, tokens, usd * GROK_TICKS_PER_USD);
  const billing = (ts: string, percent: number, periodStart: string, reset: string) => db.query(`INSERT INTO probe_windows
      (provider,subject,ts,plan,kind,reported_percent_side,used_percent,window_minutes,resets_at,ok,extra)
      VALUES('grok','grok',?,'SuperGrok','weekly','used',?,10080,?,1,?)`)
    .run(ts, percent, reset, JSON.stringify({ period_start: periodStart, period_type: "USAGE_PERIOD_TYPE_WEEKLY" }));
  const publish = () => {
    prepareProbeReaderFixture(db, [source]);
    fillUsageLedgerFixture(db, RATES, ["grok"]);
    prepareWindowUsageFixture(db, { rateCards: RATES, grokGauge: gauge, claudeGauge: {}, manualCapacity: () => [], cycles: { windows: [] } });
  };
  const context = (): AppContext => {
    const accounts = splitProbeReaderFixtureConfig([source]);
    return { sqlite: db, accounts, rateCards: RATES, grokGauge: gauge, claudeGauge: {}, cycles: { windows: [] },
      homeToSubId: new Map(), subIdToHomes: new Map(), eraErrors: [], plans: { segments: [] }, plansCatalog: { provider_groups: [] },
      vendorDiscovery: { accounts: [] }, eras: buildEraIndex(periodEras(db, accounts), "instant") } as unknown as AppContext;
  };
  return { db, turn, billing, publish, context };
}

const OBSERVATION = { ts: "2026-09-06T00:00:00.000Z", percent: 50 };

test("producer: a Grok account without a Billing reading keeps a rolling fallback that ends at its newest call", () => {
  const f = grokFixture({ subscription: "grok", observations: [OBSERVATION] });
  f.turn("2026-09-01T00:00:00.000Z", 100, 1);
  f.turn("2026-09-05T00:00:00.000Z", 200, 2);
  f.turn("2026-09-08T12:00:00.000Z", 400, 4);
  f.publish();
  const fallback = () => readWindowIntervals(f.db, "grok", "grok").find(interval => interval.id === "rolling:10080")!;
  const sums = () => readSpanSums(f.db, "grok", "grok", ["rolling:10080"], ["cycle", "rail"]).get("rolling:10080")!;
  // [newest − 168 h, newest]: the first turn is outside, the newest is inside.
  expect(fallback()).toMatchObject({ kind: "rolling", start: "2026-09-01T12:00:00.000Z", end: "2026-09-08T12:00:00.000Z", minutes: 10080 });
  expect(sums().cycle.cycle_usage).toMatchObject({ events: 2, tokens: 600 });
  expect(sums().rail.reported).toEqual({ usd: 6, missing: 0 });
  // The observation is its own [start, ts) span, measured from the observation, never from the clock.
  const observation = readWindowIntervals(f.db, "grok", "grok").find(interval => interval.id === `gauge:${OBSERVATION.ts}`)!;
  expect(observation).toMatchObject({ kind: "gauge", start: "2026-08-30T00:00:00.000Z", end: OBSERVATION.ts });
  expect(readSpanSums(f.db, "grok", "grok", [observation.id], ["rail"]).get(observation.id)!.rail.reported).toEqual({ usd: 3, missing: 0 });

  // A new call moves the fallback and its sums; the earlier observation is untouched.
  f.turn("2026-09-09T00:00:00.000Z", 800, 8);
  f.publish();
  expect(fallback()).toMatchObject({ start: "2026-09-02T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z" });
  expect(sums().cycle.cycle_usage).toMatchObject({ events: 3, tokens: 1400 });
  expect(sums().rail.reported?.usd).toBe(14);
  expect(readSpanSums(f.db, "grok", "grok", [observation.id], ["rail"]).get(observation.id)!.rail.reported?.usd).toBe(3);
  // Incremental rows equal the full computation of every published interval.
  const full = computeWindowUsageFull(f.db, { rateCards: RATES, claudeGauge: {} });
  for (const id of ["rolling:10080", "rolling:300", observation.id]) {
    const stored = f.db.query("SELECT cycle,rail FROM window_usage WHERE provider='grok' AND window_id=?").get(id) as { cycle: string; rail: string };
    const reference = full.get(JSON.stringify(["grok", "grok", id === observation.id ? "gauge" : id, id]))!;
    expect(JSON.parse(stored.cycle)).toEqual(reference.cycle);
    expect(JSON.parse(stored.rail)).toEqual(reference.rail);
  }
});

test("the Grok gauge, rail and card read stored rows; the fallback is never presented as measured", async () => {
  const f = grokFixture({ subscription: "grok", observations: [OBSERVATION] });
  f.turn("2026-09-01T00:00:00.000Z", 100, 1);
  f.turn("2026-09-05T00:00:00.000Z", 200, 2);
  f.turn("2026-09-08T12:00:00.000Z", 400, 4);
  f.turn("2026-09-09T00:00:00.000Z", 800, 8);
  f.publish();
  const gauge = recordCallReads(f.db, () => buildGrokLimit(f.db, { subscription: "grok", observations: [OBSERVATION] }, "2026-09-10T00:00:00.000Z"));
  expect(gauge.callReads).toEqual([]);
  expect(gauge.value.observations[0]).toMatchObject({ window_start: "2026-08-30T00:00:00.000Z", spend: { turns: 2, usd: 3 }, usd_per_point: 0.06 });
  expect(gauge.value.current).toMatchObject({ window_start: "2026-09-02T00:00:00.000Z", window_end: "2026-09-09T00:00:00.000Z",
    anchored: false, percent_measured: null, measurement_source: null, idle_hours: 24,
    spend: { turns: 3, gross: 1400, fresh: 1400, usd: 14 }, percent_est: 233.3 });
  expect(Object.keys(gauge.value)).toEqual(["configured", "plan", "window_hours", "observations", "calibration", "current", "caveats"]);

  const ctx = f.context();
  const rail = await recordCallReadsAsync(f.db, async () => (await handleWindows(ctx, new URL("http://local/api/windows?account=grok"))).json());
  expect(rail.callReads).toEqual([]);
  const body = rail.value as { source: string; windows: Array<Record<string, unknown>> };
  expect(body.source).toBe("probe+rolling");
  expect(body.windows[0]).toMatchObject({ key: "rolling:168h", source: "rolling", percentBasis: "counterfactual",
    startIso: "2026-09-02T00:00:00.000Z", resetIso: null, tokensTotal: 1400, usd: 14 });

  const roster = await recordCallReadsAsync(f.db, async () => (await handleRoster(ctx, new URL("http://local/api/roster?window=10080"))).json());
  expect(roster.callReads).toEqual([]);
  const card = (roster.value as { accounts: Array<{ id: string; grok: Record<string, unknown> | null }> }).accounts.find(row => row.id === "grok")!;
  expect(card.grok).toMatchObject({ window_hours: 168, since_ts: "2026-09-02T00:00:00.000Z", until_ts: "2026-09-09T00:00:00.000Z",
    spend: { turns: 3, gross: 1400, usd: 14 }, first_ts: "2026-09-01T00:00:00.000Z", last_ts: "2026-09-09T00:00:00.000Z", usd_basis: "vendor" });
  expect((card.grok as { models: unknown[] }).models).toEqual([
    { model: "grok-4", turns: 3, calls: 3, tokens: 1400, fresh: 1400, usd: 14 }]);

  // A row the producer has not published yet is "preparing", never computed in the request.
  f.db.exec("DELETE FROM window_usage WHERE provider='grok'");
  expect(() => buildGrokLimit(f.db, { subscription: "grok", observations: [OBSERVATION] }, "2026-09-10T00:00:00.000Z")).toThrow(WindowUsagePreparing);
  const preparing = await handleWindows(ctx, new URL("http://local/api/windows?account=grok"));
  expect(preparing.status).toBe(202);
  expect(preparing.headers.get("X-Analysis")).toBe("preparing");
});

test("an active Billing reading takes its window's stored sums; the anchored fallback holds the newest call", () => {
  const anchored: GrokGaugeConfig = { subscription: "grok", window_hours: 168, reset_anchor: { ts: "2026-08-04T00:00:00.000Z" },
    observations: [OBSERVATION] };
  const f = grokFixture(anchored);
  f.turn("2026-09-05T00:00:00.000Z", 200, 2);
  f.turn("2026-09-08T12:00:00.000Z", 400, 4);
  f.billing("2026-09-09T00:00:00.000Z", 33, "2026-09-05T00:00:00.000Z", "2026-09-12T00:00:00.000Z");
  f.publish();
  const live = recordCallReads(f.db, () => buildGrokLimit(f.db, anchored, "2026-09-10T00:00:00.000Z"));
  expect(live.callReads).toEqual([]);
  expect(live.value.current).toMatchObject({ percent_measured: 33, measurement_source: "grok_billing", anchored: true,
    window_start: "2026-09-05T00:00:00.000Z", window_end: "2026-09-12T00:00:00.000Z", spend: { turns: 2, usd: 6 } });
  // After the reading expires the declared anchor decides: the period [01.09, 08.09) holds no call after
  // the stored anchored period [08.09, 15.09) of the newest call, which is the current one here.
  expect(readWindowIntervals(f.db, "grok", "grok").find(interval => interval.kind === "anchored"))
    .toMatchObject({ start: "2026-09-08T00:00:00.000Z", end: "2026-09-15T00:00:00.000Z" });
  const expired = buildGrokLimit(f.db, anchored, "2026-09-13T00:00:00.000Z");
  expect(expired.current).toMatchObject({ percent_measured: null, anchored: true, window_start: "2026-09-08T00:00:00.000Z",
    spend: { turns: 1, usd: 4 } });
  // The manual calibration is measured over its own declared period whether the reading is live or expired.
  expect(live.value.observations[0]).toMatchObject({ window_start: "2026-09-01T00:00:00.000Z", spend: { turns: 1, usd: 2 } });
  expect(expired.observations).toEqual(live.value.observations);
  expect(expired.calibration).toEqual(live.value.calibration);
  // A later period has no call yet: empty, from the same rows.
  const later = buildGrokLimit(f.db, anchored, "2026-09-16T00:00:00.000Z");
  expect(later.current).toMatchObject({ window_start: "2026-09-15T00:00:00.000Z", spend: { turns: 0, usd: 0 } });
});

/** One account of a provider with its archive source and the maintenance worker's producers. */
function providerFixture(vendor: "glm" | "gemini", id: string) {
  const { directory, dbPath } = createTestDatabase();
  const db = new Database(dbPath);
  cleanups.push(() => { db.close(true); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)");
  installAnalysisTracking(db);
  const source = probeReaderFixtureSource(vendor, id);
  const publish = () => {
    prepareProbeReaderFixture(db, [source]);
    fillUsageLedgerFixture(db, RATES, [vendor]);
    prepareWindowUsageFixture(db, { rateCards: RATES, grokGauge: {}, claudeGauge: {}, manualCapacity: () => [], cycles: { windows: [] } });
  };
  const context = (): AppContext => {
    const accounts = splitProbeReaderFixtureConfig([source]);
    return { sqlite: db, accounts, rateCards: RATES, grokGauge: {}, claudeGauge: {}, cycles: { windows: [] },
      homeToSubId: new Map(), subIdToHomes: new Map(), eraErrors: [], plans: { segments: [] }, plansCatalog: { provider_groups: [] },
      vendorDiscovery: { accounts: [] }, eras: buildEraIndex(periodEras(db, accounts), "instant") } as unknown as AppContext;
  };
  const roster = async (window = 10080) => {
    const result = await recordCallReadsAsync(db, async () => (await handleRoster(context(), new URL(`http://local/api/roster?window=${window}`))).json());
    expect(result.callReads).toEqual([]);
    return (result.value as { accounts: Array<Record<string, unknown> & { id: string }> }).accounts.find(row => row.id === id)!;
  };
  return { db, source, publish, context, roster };
}

test("the GLM card reads its sample's stored window: the cycle's spend, the calibration at the sample's instant", async () => {
  const f = providerFixture("glm", "glm");
  let n = 0;
  const call = (ts: string, tokens: number, session: string) => f.db.query(`INSERT INTO oc_events
      (store,message_id,session_id,ts,model,provider,in_tok,out_tok,reasoning,cache_read,cache_write)
      VALUES(?,?,?,?,'glm-test','zai-coding-plan',?,0,0,0,0)`).run(f.source.machine, `m${n++}`, session, ts, tokens);
  call("2026-09-07T00:00:00.000Z", 1000, "s1");
  call("2026-09-08T00:00:00.000Z", 2000, "s1");
  call("2026-09-09T00:00:00.000Z", 4000, "s2");
  f.db.query(`INSERT INTO probe_windows(provider,subject,ts,plan,kind,reported_percent_side,used_percent,allowance,used,remaining,
    window_minutes,resets_at,ok) VALUES('glm','glm','2026-09-08T12:00:00.000Z','pro','weekly','used',30,1000,300,700,10080,?,1)`)
    .run("2026-09-12T00:00:00.000Z");
  f.publish();
  const report = recordCallReads(f.db, () => buildGlmLimit(f.db));
  expect(report.callReads).toEqual([]);
  const window = report.value!.windows[0]!;
  expect(window).toMatchObject({ kind: "weekly", used: 300, reset_at: "2026-09-12T00:00:00.000Z", window_start: "2026-09-05T00:00:00.000Z",
    measured_at: "2026-09-08T12:00:00.000Z" });
  // The whole cycle (no call is later than the clock), sessions counted once each.
  expect(window.spend).toMatchObject({ since_ts: "2026-09-05T00:00:00.000Z", until_ts: "2026-09-12T00:00:00.000Z", calls: 3, sessions: 2,
    gross: 7000, in_tok: 7000, usd: 7, usd_basis: "api-eq", unpriced_tokens: 0, models: [{ model: "glm-test", calls: 3, in_tok: 7000, usd: 7 }] });
  // 300 credits over the 3 000 tokens known at the sample: later traffic never divides an older percentage.
  expect(window.credits_per_mtok).toBe(100_000);
  const card = await f.roster();
  expect((card.glm as { windows: Array<{ spend: { calls: number } }> }).windows[0]!.spend.calls).toBe(3);
  f.db.exec("DELETE FROM window_usage WHERE provider='glm'");
  expect(() => buildGlmLimit(f.db)).toThrow(WindowUsagePreparing);
});

test("the Gemini card reads its weekly span or rolling fallback and the account's whole traffic from stored rows", async () => {
  const f = providerFixture("gemini", "g1");
  let n = 0;
  const generation = (ts: string, tokens: number, conversation: string) => f.db.query(`INSERT INTO gemini_events
      (store,conversation_id,gen_idx,ts,ts_basis,model,path,fresh_in,cached_in,out_total,out_thinking,usd)
      VALUES('g1',?,?,?,'conversation','gemini-2.5-pro',?,?,0,0,0,0)`)
    .run(conversation, n++, ts, `${f.source.home}/conversations/${conversation}.db`, tokens);
  generation("2026-08-01T00:00:00.000Z", 50, "c0");
  generation("2026-09-07T00:00:00.000Z", 100, "c1");
  generation("2026-09-08T00:00:00.000Z", 200, "c1");
  generation("2026-09-09T00:00:00.000Z", 400, "c2");
  f.db.query(`INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,reported_percent_side,remaining_percent,resets_at,ok,profile)
    VALUES('gemini','g1','2026-09-09T12:00:00.000Z','weekly','gemini-pro','remaining',80,'2026-09-10T00:00:00.000Z',1,'default')`).run();
  f.publish();
  // Conversation times are approximate, so the fallback spans hold every generation by its recorded time.
  expect(readWindowIntervals(f.db, "gemini", "g1").map(interval => [interval.id, interval.kind, interval.start, interval.end])).toEqual([
    ["anchored:2026-09-03T00:00:00.000Z", "anchored", "2026-09-03T00:00:00.000Z", "2026-09-10T00:00:00.000Z"],
    ["rolling:10080", "rolling", "2026-09-02T00:00:00.000Z", "2026-09-09T00:00:00.000Z"],
    ["rolling:300", "rolling", "2026-09-08T19:00:00.000Z", "2026-09-09T00:00:00.000Z"],
  ]);
  const weekly = await f.roster();
  expect((weekly.gemini as { spend: unknown }).spend).toMatchObject({ anchored: true, since_ts: "2026-09-03T00:00:00.000Z",
    until_ts: "2026-09-10T00:00:00.000Z", resolution: "conversation", generations: 3, conversations: 2, gross: 700, fresh_in: 700,
    usd: 0.7, usd_basis: "api-eq", first_ts: "2026-08-01T00:00:00.000Z", last_ts: "2026-09-09T00:00:00.000Z",
    all_time_gross: 750, all_time_usd: 0.75,
    models: [{ model: "gemini-2.5-pro", generations: 3, tokens: 700, fresh: 700, usd: 0.7 }] });
  // Five hours have no weekly anchor: the rolling span up to the newest generation.
  const short = await f.roster(300);
  expect((short.gemini as { spend: unknown }).spend).toMatchObject({ anchored: false, since_ts: "2026-09-08T19:00:00.000Z",
    until_ts: "2026-09-09T00:00:00.000Z", generations: 1, gross: 400 });
  // A newer generation moves the fallbacks; the weekly span follows the reading.
  generation("2026-09-09T06:00:00.000Z", 800, "c2");
  f.publish();
  expect((await f.roster(300)).gemini).toMatchObject({ spend: { since_ts: "2026-09-09T01:00:00.000Z", until_ts: "2026-09-09T06:00:00.000Z", generations: 1, gross: 800 } });
  expect((await f.roster()).gemini).toMatchObject({ spend: { generations: 4, conversations: 2, gross: 1500, all_time_gross: 1550 } });
});

test("a detected Gemini login without readings has an empty rail, not an unknown account", async () => {
  const f = providerFixture("gemini", "g1");
  f.publish();
  const detected = "gemini-1f5514887c0b51e0";
  const ctx = { ...f.context(), vendorDiscovery: { accounts: [{ id: detected, vendor: "gemini", profiles: [] }] } } as unknown as AppContext;
  const response = await handleWindows(ctx, new URL(`http://local/api/windows?account=${detected}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ account: detected, provider: "gemini", windows: [] });
  // Without the detection the same id stays unknown.
  expect((await handleWindows(f.context(), new URL(`http://local/api/windows?account=${detected}`))).status).toBe(400);
});
