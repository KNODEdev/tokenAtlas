import { saveProjects } from "../projects/remap";
import { projectRulesOverride } from "../projects/resolve";
import { prepareLimitWindowsFixture } from "./limit-windows.fixture";
import { test, expect } from "bun:test";
import { Database } from "../db/sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountingOptions, handleCodexAccounting,buildCodexAccountingReport as readPreparedCodexAccountingReport } from "./codex-accounting";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { codexModelUsage } from "../web/lib/model-usage";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import {buildFixtureCodexReport as buildCodexAccountingReport,codexFixturePeriods,codexFixtureSources} from "./codex-v8.fixture";
import { priceCodexEvent, prepareCodexPricing, resolveCodexAccountingConfig, validateCodexAccountingConfig,
  type CodexAccountingEvent, type CodexAccountingConfig } from "./codex-accounting-pricing";
import { calculateCodexUsd, getCodexRate, type RateCard } from "./pricing";
import { buildEraIndex } from "./eras";
import { loadEraDeclarations } from "./eras.fixture";
import { expandPath } from "../config/paths";
import { createFetchHandler, handleRoster, handleWindows as apiHandleWindows, periodEras, type AppContext } from "./api";
import { createDataRead } from "./data-read";
import { installAnalysisTracking } from "../db/analysis";
import { prepareProbeReaderFixture, splitProbeReaderFixtureConfig } from "./probe-reader.fixture";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { loadAccountResolver } from "./account-resolver";
import { codexLimitCounter } from "./codex-limit-windows";
import { prepareWindowUsageFixture } from "./window-usage.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { indexSubscriptionHomes } from "./capacity-equivalents";
import { buildProbeLimitWindows } from "./probe-limit-windows";
import type { DatedPeriod } from "./account-periods";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";
import { WindowUsagePreparing } from "./window-usage";

test("prepared pricing preserves all rule boundaries, long-context decisions and missing evidence", () => {
  const original = resolveCodexAccountingConfig(card);
  const prepared = prepareCodexPricing(original);
  for (const rule of original.rules) {
    for (const patch of [
      { ts: `${rule.valid_from}T01:00:00Z`, speed: rule.speed },
      { ts: `${rule.valid_until ?? "2099-01-01"}T00:00:00Z`, speed: rule.speed },
      { ts: `${rule.valid_from}T01:00:00Z`, speed: rule.speed, in_tok: 272001 },
      { speed: "unknown" }, { cache_write: 10 }, { cached_in: -1 }, { ts: "2026-02-30T00:00:00Z" },
    ]) {
      const row = event({ model: rule.model, ...patch });
      expect(priceCodexEvent(prepared, row, rule.billing_basis)).toEqual(priceCodexEvent(original, row, rule.billing_basis));
    }
  }
});

const card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {} };
// These cases price the long-context premium, which the shipped card leaves off (owner decision 2026-10-20).
const config = { ...resolveCodexAccountingConfig(card), long_context_premium: true };
const event = (patch: Partial<CodexAccountingEvent> = {}): CodexAccountingEvent => ({
  model: "gpt-6-astra", speed: "standard", ts: "2026-09-08T01:00:00Z",
  in_tok: 100000, cached_in: 80000, cache_write: 0, out_tok: 10000, ...patch,
});

const fixtureHomes = () => indexSubscriptionHomes([],codexFixtureSources);
/** These synthetic vendor cards explicitly author matching ledger API rules. */
function ledgerFixtureCard(rates: RateCard): RateCard {
  const models = rates.vendors.openai?.models;
  if (rates.codex_accounting || !models) return rates;
  const template = config.rules.find(rule=>rule.billing_basis==="api_equivalent_usd" && rule.speed==="standard")!;
  return {...rates,codex_accounting:{version:1,rules:[
    ...config.rules.filter(rule=>rule.billing_basis!=="api_equivalent_usd" || !models[rule.model]),
    ...Object.entries(models).map(([model,prices])=>({...template,id:`fixture-api-${model}`,model,
      valid_from:"2000-01-01",valid_until:undefined,speed:"standard" as const,multiplier:1,
      rates:{in_uncached:prices.in_uncached!,in_cache_read:prices.in_cache_read!,out_total:prices.out_total!}})),
  ]}};
}

test("Codex Capacity and /api/windows share meter segments, dated plans and a fitting manual reading", async () => {
  const db = new Database(":memory:");
  fixture(db);
  db.exec(`CREATE TABLE probe_windows(id INTEGER PRIMARY KEY,provider TEXT,subject TEXT,ts TEXT,kind TEXT,
    scope TEXT,limit_group TEXT,plan TEXT,machine TEXT,used_percent REAL,resets_at TEXT,window_minutes INTEGER,
    ok INTEGER,extra TEXT);
    CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,
    window_minutes INTEGER,limit_id TEXT,plan_type TEXT);`);
  const activity = db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)");
  activity.run("/archive", "/archive/a", "2026-09-10T11:00:00.000Z", "gpt-6-astra", "standard", 100, 0, 0, 10, "project-a");
  activity.run("/archive", "/archive/b", "2026-09-10T13:00:00.000Z", "gpt-6-astra", "standard", 200, 0, 0, 20, "project-a");
  const account = "codex1", counter = codexLimitCounter(10080);
  const period = (from: string, until: string | null, value: string): DatedPeriod => ({ provider: "codex",
    subject: account, from, until, value, origin: "declared", firstSeen: null, lastSeen: null,
    readings: 0, evidence: "fixture" });
  replaceDeclaredPeriods(db, PLAN_PERIODS, [period("2026-09-01", "2026-09-10T08:00:00Z", "pro"),
    period("2026-09-10T08:00:00Z", "2026-09-11T08:00:00Z", "max-5x"),
    period("2026-09-11T08:00:00Z", null, "max-20x")]);
  const insert = db.query(`INSERT INTO probe_windows
    (id,provider,subject,ts,kind,limit_group,plan,machine,used_percent,resets_at,window_minutes,ok,extra)
    VALUES (?,'codex',?,?,'primary','codex',?,?,?, ?,10080,1,?)`);
  for (const [id, ts, used, reset, machine, home, plan] of [
    [1, "2026-09-08T00:00:00Z", 0, "2026-09-15T00:00:00Z", "MAIN", "/archive", "pro"],
    [2, "2026-09-08T01:00:00Z", 35, "2026-09-15T00:00:00Z", "MAIN", "/archive", "pro"],
    [3, "2026-09-09T05:00:00Z", 0, "2026-09-16T05:00:00Z", "MAIN", "/archive", "pro"],
    [4, "2026-09-09T06:00:00Z", 10, "2026-09-16T05:00:00Z", "MAIN", "/archive", "pro"],
    [5, "2026-09-10T07:00:00Z", 55, "2026-09-16T05:00:00Z", "MAIN", "/archive", "pro"],
    [6, "2026-09-10T10:00:00Z", 60, "2026-09-16T05:00:00Z", "MAIN", "/archive", "max-5x"],
    [7, "2026-09-10T10:00:30Z", 61, "2026-09-16T05:01:00Z", "LAPTOP", "/local/.codex", "max-5x"],
    [8, "2026-09-10T12:00:00Z", 5, "2026-09-16T05:00:00Z", "MAIN", "/archive", "max-5x"],
    [9, "2026-09-11T09:00:00Z", 20, "2026-09-16T05:00:00Z", "MAIN", "/archive", "max-20x"],
    [10, "2026-09-11T10:00:00Z", 40, "2026-09-16T05:00:00Z", "MAIN", "/archive", "max-20x"],
    [11, "2026-09-16T06:00:00Z", 2, "2026-09-23T05:00:00Z", "MAIN", "/archive", "max-20x"],
    [12, "2026-09-10T13:00:00Z", 99, "2026-09-16T05:00:00Z", "MAIN", "/archive", "max-5x"],
  ] as const) {
    insert.run(id, account, ts, plan, machine, used, reset, JSON.stringify({ home }));
    if (id === 12) db.query("UPDATE probe_windows SET limit_group='codex-spark' WHERE id=12").run();
  }
  const sources = splitProbeReaderFixtureConfig(codexFixtureSources);
  prepareProbeReaderFixture(db, codexFixtureSources);
  const resolver = loadAccountResolver(db);
  const manualCapacity = [{ id: "manual-codex", account, counter,
    start: "2026-09-10T12:00:00Z", end: "2026-09-11T10:00:00Z",
    start_percent: 5, end_percent: 100, approximate_time: false, note: "limit",
    updated_at: "2026-09-11T10:00:00Z" }, { id: "orphan-5h", account,
    counter: codexLimitCounter(300), start: "2026-09-11T12:00:00Z", end: "2026-09-11T14:00:00Z",
    start_percent: 0, end_percent: 60, approximate_time: false, note: "separate",
    updated_at: "2026-09-11T14:00:00Z" }];
  const railCard: RateCard = ledgerFixtureCard({ ...card, vendors: { openai: { models: {
    "gpt-6-astra": { in_uncached: 3, in_cache_read: 0.3, out_total: 15 },
  } } } });
  // The producer reads the same manual measurements as the screens (the measurement file in production).
  prepareLimitWindowsFixture(db, { sources: codexFixtureSources as never, manualCapacity: provider => provider === "codex" ? manualCapacity : [] });
  const ctx = { sqlite: db, resolver, rateCards: railCard, accounts: sources, manualCapacity,
    eras: buildEraIndex([{ id: account, vendor: "codex", home: "/archive", from: "2026-09-01" }]),
    cycles: {}, plans: {}, plansCatalog: { provider_groups: [] }, claudeGauge: {}, grokGauge: {},
    homeToSubId: new Map([["/archive", account]]), subIdToHomes: new Map([[account, ["/archive"]]]),
    rootDir: "", homeConflict: null, eraErrors: [] } as unknown as AppContext;
  try {
    const pending = await apiHandleWindows(ctx, new URL(`http://localhost/api/windows?account=${account}`));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ status: "preparing" });
    prepareCodexLedgerFixture(db,railCard,fixtureHomes());
    prepareWindowUsageFixture(db, { rateCards: railCard });
    const capacityResponse = handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-16&account=${account}`));
    expect(capacityResponse.status).toBe(200);
    const capacity = await capacityResponse.json() as { windows: Array<{ id: string; cycle_start: string;
      cycle_end: string; plan: string | null; declared_plan_meter_mismatch: boolean;
      plan_detail?: { status: string }; manual_measurement?: { id: string } }> };
    const rail = await (await apiHandleWindows(ctx, new URL(`http://localhost/api/windows?account=${account}`))).json() as
      { windows: Array<{ windowId: string; startIso: string; resetIso: string; plan: string | null;
        declared_plan_meter_mismatch: boolean; plan_detail?: { status: string }; manual_measurement?: { id: string } }> };
    const byId = new Map(rail.windows.map(window => [window.windowId, window]));
    expect(capacity.windows).toHaveLength(4);
    for (const window of capacity.windows) {
      const match = byId.get(window.id);
      expect(match).toBeDefined();
      expect([match!.startIso, match!.resetIso, match!.plan]).toEqual([
        window.cycle_start, window.cycle_end, window.plan]);
    }
    const early = capacity.windows.find(window => window.cycle_start === "2026-09-09T05:00:00.000Z")!;
    expect(early.cycle_end).toBe("2026-09-10T12:00:00.000Z");
    expect(early).toMatchObject({ plan: null, plan_detail: { status: "mixed" },
      declared_plan_meter_mismatch: true });
    const drop = capacity.windows.find(window => window.cycle_start === "2026-09-10T12:00:00.000Z")!;
    expect(drop).toMatchObject({ plan: null, plan_detail: { status: "mixed" },
      declared_plan_meter_mismatch: true, manual_measurement: { id: "manual-codex" } });
    // The meter is the account's: a project filter keeps every cycle and adds the project's part of each, split at
    // the cycle boundary inside 10 September.
    const scoped = await handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-16&account=${account}&project=project-a`)).json() as
      { windows: Array<{ id: string; project_usage?: { project: string; events: number; tokens: number; api_standard: number } }> };
    expect(scoped.windows.map(window => window.id)).toEqual(capacity.windows.map(window => window.id));
    expect(scoped.windows.find(window => window.id === early.id)?.project_usage).toMatchObject({ project: "project-a", events: 1, tokens: 110 });
    expect(scoped.windows.find(window => window.id === drop.id)?.project_usage).toMatchObject({ project: "project-a", events: 1, tokens: 220 });
    expect(scoped.windows.find(window => window.id === drop.id)!.project_usage!.api_standard).toBeCloseTo(0.0009);
    const other = await handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-16&account=${account}&project=project-b`)).json() as typeof scoped;
    expect(other.windows.find(window => window.id === drop.id)?.project_usage).toMatchObject({ events: 0, tokens: 0 });
    const beforeDrop = rail.windows.find(window => window.resetIso === drop.cycle_start)! as typeof rail.windows[number] &
      { tokensTotal: number; usd: number; activityShape: Array<{ t: number; amount: number }>;
        trafficByMachine: Array<{ machine: string | null; amount: number }>; aggregation_partial: boolean };
    const afterDrop = byId.get(drop.id)! as typeof beforeDrop;
    expect(beforeDrop.tokensTotal).toBe(110);
    expect(beforeDrop.usd).toBeCloseTo(0.00045);
    expect(beforeDrop.activityShape.at(-1)?.amount).toBe(110);
    expect(beforeDrop.trafficByMachine.reduce((sum, row) => sum + row.amount, 0)).toBe(110);
    expect(beforeDrop.aggregation_partial).toBe(false);
    expect(afterDrop.tokensTotal).toBe(220);
    expect(afterDrop.usd).toBeCloseTo(0.0009);
    expect(afterDrop.activityShape.at(-1)?.amount).toBe(220);
    expect(afterDrop.trafficByMachine.reduce((sum, row) => sum + row.amount, 0)).toBe(220);
    expect(rail.windows).toHaveLength(4); // The jittered second machine and Spark reading add no window.
    expect(rail.windows.every(window => window.windowId !== "manual:orphan-5h")).toBe(true);
    const detail = await handleCodexAccounting(ctx, new Request(`http://localhost/api/codex-accounting?since=2026-09-10&until=2026-09-11&account=${account}&detail_cycle=${encodeURIComponent(drop.id)}`)).json() as
      { windows: Array<{ id: string; timeline?: { readings: Array<{ percent: number; source: string }> } }> };
    expect(detail.windows.find(window => window.id === drop.id)?.timeline?.readings)
      .toContainEqual(expect.objectContaining({ percent: 100, source: "manual" }));
    // A window whose stored sums predate its newest reading (being recomputed) is read as last stored, not refused.
    const stale = db.query("SELECT account,counter,window_id,readings FROM window_usage WHERE provider='codex' AND json_array_length(readings)>1 LIMIT 1")
      .get() as { account: string; counter: string; window_id: string; readings: string };
    db.query("UPDATE window_usage SET readings=? WHERE provider='codex' AND account=? AND counter=? AND window_id=?")
      .run(JSON.stringify(JSON.parse(stale.readings).slice(0, -1)), stale.account, stale.counter, stale.window_id);
    expect(handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-16&account=${account}`)).status).toBe(200);
    const narrow = await handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-10&until=2026-09-11&account=${account}`)).json() as typeof capacity;
    expect(narrow.windows.map(window => window.id)).toEqual(capacity.windows
      .filter(window => window.cycle_end > "2026-09-10" && window.cycle_start < "2026-09-12")
      .map(window => window.id));
    const short = await handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-11&until=2026-09-11&account=${account}&window_minutes=300`)).json() as typeof capacity;
    // A manual interval matching no meter window is not a stored window (Codex measurements are not writable).
    expect(short.windows).toEqual([]);
    const shortRail = await (await apiHandleWindows(ctx, new URL(
      `http://localhost/api/windows?account=${account}&window=300`))).json() as typeof rail;
    expect(shortRail.windows).toEqual([]);
    // A reference-date comparison values the calls when read: it answers at once and writes nothing. The windows'
    // stored rows carry the variant of a day with the same coefficients.
    const compare = async (day: string) => handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-16&account=${account}&reference_day=${day}`));
    const changes = db.query("SELECT total_changes() n").get();
    expect((await compare("2026-09-13")).status).toBe(200);
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    prepareWindowUsageFixture(db, { rateCards: railCard, referenceDay: "2026-09-12" });
    expect((db.query("SELECT COUNT(*) n FROM window_usage WHERE reference IS NULL").get() as { n: number }).n).toBe(0);
    const compared = await compare("2026-09-13");
    expect(compared.status).toBe(200);
    const valued = await compared.json() as { scope: { reference_day: string }; windows: Array<{ id: string;
      cycle_usage: { api_standard: number; reference_api_standard?: number; reference_priced_tokens?: number; priced_tokens: number } }> };
    expect(valued.scope.reference_day).toBe("2026-09-13");
    expect(valued.windows.map(window => window.id)).toEqual(capacity.windows.map(window => window.id));
    // A window without traffic carries no reference fields, as it carries no valued call.
    expect(valued.windows.some(window => window.cycle_usage.reference_api_standard! > 0)).toBe(true);
    for (const window of valued.windows) {
      expect(window.cycle_usage.reference_api_standard ?? 0).toBeCloseTo(window.cycle_usage.api_standard, 12);
      expect(window.cycle_usage.reference_priced_tokens ?? 0).toBe(window.cycle_usage.priced_tokens);
    }
    // The rail, the account cards and the accounting windows read rows: no Codex call is read for them.
    const callReads: string[] = [], query = db.query;
    db.query = function (this: Database, statement: string, ...rest: unknown[]) {
      if (/\b(?:FROM|JOIN)\s+(?:events|codex_price_ledger_events)\b/i.test(statement)) callReads.push(statement);
      return query.call(this, statement, ...rest as []);
    } as typeof db.query;
    try {
      expect((await apiHandleWindows(ctx, new URL(`http://localhost/api/windows?account=${account}`))).status).toBe(200);
      const roster = await handleRoster(ctx, new URL("http://localhost/api/roster?window=10080"));
      expect(roster.status).toBe(200);
      expect(((await roster.json()) as { accounts: Array<{ id: string; cycles: unknown[] }> }).accounts
        .find(row => row.id === account)?.cycles.length).toBeGreaterThan(0);
    } finally { db.query = query; }
    expect(callReads).toEqual([]);
    // Both screens read the stored sums: a stored row is what they answer, nothing is recomputed.
    const stored = db.query("SELECT cycle,rail FROM window_usage WHERE window_id=?").get(drop.id) as { cycle: string; rail: string };
    const cycle = JSON.parse(stored.cycle), railSums = JSON.parse(stored.rail);
    cycle.usage.tokens = 4242; railSums.tokens = 4343;
    db.query("UPDATE window_usage SET cycle=?,rail=? WHERE window_id=?").run(JSON.stringify(cycle), JSON.stringify(railSums), drop.id);
    const reread = await handleCodexAccounting(ctx, new Request(
      `http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-16&account=${account}`)).json() as { windows: Array<{ id: string; usage: { tokens: number } }> };
    expect(reread.windows.find(window => window.id === drop.id)!.usage.tokens).toBe(4242);
    const rerail = await (await apiHandleWindows(ctx, new URL(`http://localhost/api/windows?account=${account}`))).json() as { windows: Array<{ windowId: string; tokensTotal: number }> };
    expect(rerail.windows.find(window => window.windowId === drop.id)!.tokensTotal).toBe(4343);
  } finally { db.close(); }
});

test("Astra token mix yields 19.5 credits; Fast changes credits by 2.5 and API by 2", () => {
  expect(priceCodexEvent(config, event(), "chatgpt_credits").amount).toBeCloseTo(19.5, 10);
  expect(priceCodexEvent(config, event({ speed: "fast" }), "chatgpt_credits").amount).toBeCloseTo(48.75, 10);
  expect(priceCodexEvent(config, event(), "api_equivalent_usd").amount).toBeCloseTo(.78, 10);
  expect(priceCodexEvent(config, event({ speed: "fast" }), "api_equivalent_usd").amount).toBeCloseTo(1.56, 10);
});

test("credit multiplier and rates follow the exact model; no parent or prefix guesses", () => {
  const input = event({ in_tok: 1000000, cached_in: 0, out_tok: 0, speed: "fast" });
  expect(priceCodexEvent(config, { ...input, model: "gpt-5.4" }, "chatgpt_credits").amount).toBe(125);
  expect(priceCodexEvent(config, { ...input, model: "gpt-5.5" }, "chatgpt_credits").amount).toBe(312.5);
  expect(priceCodexEvent(config, { ...input, model: "gpt-5.6-luna" }, "chatgpt_credits").amount).toBe(12.5);
  for (const model of ["gpt-6-astra-auto-review", "gpt-5.3-codex-preview", "gpt-5.4-mini"]) {
    expect(priceCodexEvent(config, { ...input, model }, "chatgpt_credits").reason).toBe("missing_rate");
  }
  // Spark is free by its own rule (user decision 2026-10-09), not by a guess from gpt-5.3-codex.
  for (const basis of ["chatgpt_credits", "api_equivalent_usd"] as const) {
    const spark = priceCodexEvent(config, { ...input, model: "gpt-5.3-codex-spark" }, basis);
    expect(spark.reason).toBeNull();
    expect(spark.amount).toBe(0);
  }
});

test("long context is a strict per-request boundary, applied independently from speed", () => {
  const input = event({ in_tok: 272000, cached_in: 0, out_tok: 10000 });
  expect(priceCodexEvent(config, input, "api_equivalent_usd").amount).toBeCloseTo(3.22, 10);
  expect(priceCodexEvent(config, { ...input, in_tok: 272001 }, "api_equivalent_usd").amount).toBeCloseTo(6.19002, 10);
  expect(priceCodexEvent(config, { ...input, in_tok: 272001, speed: "fast" }, "api_equivalent_usd").amount).toBeCloseTo(12.38004, 10);
  const split = [event({ in_tok: 200000, cached_in: 0, out_tok: 0 }), event({ in_tok: 200000, cached_in: 0, out_tok: 0 })];
  expect(split.reduce((sum, e) => sum + priceCodexEvent(config, e, "api_equivalent_usd").amount!, 0)).toBe(4);
  expect(priceCodexEvent(config, event({ in_tok: 400000, cached_in: 0, out_tok: 0 }), "api_equivalent_usd").amount).toBe(8);
});

test("period boundaries are exclusive, missing periods remain unpriced and overlap is rejected", () => {
  const first = structuredClone(config.rules.find(r => r.model === "gpt-6-astra" && r.speed === "standard" && r.billing_basis === "chatgpt_credits")!);
  first.valid_until = "2026-09-10";
  const next = { ...first, id: "next", valid_from: "2026-09-10", valid_until: "2026-09-20", multiplier: 2 };
  const dated: CodexAccountingConfig = { version: 1, rules: [next, first] };
  validateCodexAccountingConfig(dated);
  expect(priceCodexEvent(dated, event({ ts: "2026-09-09T23:59:59Z" }), "chatgpt_credits").amount).toBe(19.5);
  expect(priceCodexEvent(dated, event({ ts: "2026-09-10T00:00:00Z" }), "chatgpt_credits").amount).toBe(39);
  expect(priceCodexEvent(dated, event({ ts: "2026-09-20T00:00:00Z" }), "chatgpt_credits").reason).toBe("missing_rate");
  expect(priceCodexEvent(config, event({ ts: "2026-09-03T23:59:59Z" }), "chatgpt_credits").reason).toBe("missing_rate");
  next.valid_from = "2026-09-09";
  expect(() => validateCodexAccountingConfig(dated)).toThrow("overlapping");
});

test("historical reference rates begin at first observation, independently of verification", () => {
  for (const [model, day] of [["gpt-6-astra", "2026-09-04"], ["gpt-5.6-sol", "2026-07-09"],
    ["gpt-5.6-terra", "2026-07-09"], ["gpt-5.6-luna", "2026-07-09"]]) {
    const e = event({ model, ts: `${day}T00:00:00Z` });
    for (const basis of ["chatgpt_credits", "api_equivalent_usd"] as const) {
      const price = priceCodexEvent(config, e, basis);
      expect(price.amount).not.toBeNull();
      const rule = config.rules.find(r => r.id === price.rule_id)!;
      expect(rule.confidence).toBe("user");
      expect(rule.verified_at > rule.valid_from).toBe(true);
      const before = new Date(Date.parse(e.ts) - 1).toISOString();
      expect(priceCodexEvent(config, { ...e, ts: before }, basis).reason).toBe("missing_rate");
    }
    expect(priceCodexEvent(config, { ...e, speed: "unknown" }, "chatgpt_credits").reason).toBe("unknown_speed");
  }
});

test("Sol, Terra and Luna expose API and credits on the same historical token vector", () => {
  for (const [model, api, credits] of [["gpt-5.6-sol", .312, 7.8], ["gpt-5.6-terra", .176, 4.4],
    ["gpt-5.6-luna", .0176, .44]] as const) {
    const e = event({ model, ts: "2026-08-31T12:00:00Z" });
    expect(priceCodexEvent(config, e, "api_equivalent_usd").amount).toBeCloseTo(api, 10);
    expect(priceCodexEvent(config, e, "chatgpt_credits").amount).toBeCloseTo(credits, 10);
    expect(priceCodexEvent(config, { ...e, speed: "fast" }, "api_equivalent_usd").amount).toBeCloseTo(api * 2, 10);
    expect(priceCodexEvent(config, { ...e, speed: "fast" }, "chatgpt_credits").amount).toBeCloseTo(credits * 2.5, 10);
    const long = event({ model, ts: e.ts, in_tok: 300000, cached_in: 0, out_tok: 10000 });
    const priced = priceCodexEvent(config, long, "api_equivalent_usd");
    expect(priced.long_context).toBe(true);
    expect(priceCodexEvent(config, { ...long, speed: "fast" }, "api_equivalent_usd").amount).toBeCloseTo(priced.amount! * 2, 10);
  }
});

test("daily Standard API rollups follow dated accounting while legacy cards keep their own prices", () => {
  const datedCard: RateCard = { ...card, codex_accounting: config };
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    for (const day of ["2026-07-29", "2026-07-30", "2026-08-20", "2026-08-21", "2026-09-11"]) {
      const row = event({ model, ts: `${day}T01:00:00Z` });
      expect(calculateCodexUsd(getCodexRate(datedCard, model, day), row.in_tok, row.cached_in, 0, row.out_tok))
        .toBeCloseTo(priceCodexEvent(config, row, "api_equivalent_usd").amount!, 10);
    }
  }
  expect(getCodexRate(datedCard, "gpt-5.6-sol", "2026-07-08")).toBeNull();
  const withLegacyWrite: RateCard = { ...datedCard, vendors: { openai: { models: {
    "gpt-5.6-sol": { in_uncached: 4, in_cache_read: .4, out_total: 20, in_cache_write: 5 },
  } } } };
  expect(getCodexRate(withLegacyWrite, "gpt-5.6-sol", "2026-09-11")?.in_cache_write).toBe(5);
  const legacy: RateCard = { ...card, vendors: { openai: { models: { custom: {
    in_uncached: 7, in_cache_read: 1, out_total: 9, until: "2026-08-20",
    after: { in_uncached: 5, in_cache_read: .5, out_total: 8 },
  } } } } };
  expect(getCodexRate(legacy, "custom", "2026-08-20")?.in_uncached).toBe(7);
  expect(getCodexRate(legacy, "custom", "2026-08-21")?.in_uncached).toBe(5);
  expect(getCodexRate(legacy, "custom")?.in_uncached).toBe(7);
});

test("the minimum Sol promotion duration is not treated as a confirmed expiry", () => {
  for (const speed of ["standard", "fast"]) {
    for (const basis of ["api_equivalent_usd", "chatgpt_credits"] as const) {
      const before = event({ model: "gpt-5.6-sol", speed, ts: "2026-11-21T23:59:59Z" });
      const after = { ...before, ts: "2026-11-22T00:00:00Z" };
      expect(priceCodexEvent(config, before, basis).amount).toBeGreaterThan(0);
      expect(priceCodexEvent(config, after, basis).amount).toBe(priceCodexEvent(config, before, basis).amount);
    }
  }
});

test("dated price reductions do not retroactively discount earlier token events", () => {
  // Use separate token components so an incorrect cache/output discount cannot cancel out.
  for (const [model, day, apiBefore, apiAfter, creditBefore, creditAfter] of [
    ["gpt-5.6-luna", "2026-07-30", [1, .1, 6], [.2, .02, 1.2], [25, 2.5, 150], [5, .5, 30]],
    ["gpt-5.6-terra", "2026-07-30", [2.5, .25, 15], [2, .2, 12], [62.5, 6.25, 375], [50, 5, 300]],
    ["gpt-5.6-sol", "2026-08-21", [5, .5, 30], [4, .4, 20], [100, 10, 500], [100, 10, 500]],
  ] as const) {
    const before = new Date(Date.parse(day) - 1).toISOString();
    for (const [index, vector] of [
      { in_tok: 100000, cached_in: 0, out_tok: 0 },
      { in_tok: 100000, cached_in: 100000, out_tok: 0 },
      { in_tok: 0, cached_in: 0, out_tok: 100000 },
    ].entries()) {
      const row = event({ model, ...vector });
      for (const [basis, previous, next] of [["api_equivalent_usd", apiBefore, apiAfter], ["chatgpt_credits", creditBefore, creditAfter]] as const) {
        expect(priceCodexEvent(config, { ...row, ts: before }, basis).amount).toBeCloseTo(previous[index]! / 10, 10);
        expect(priceCodexEvent(config, { ...row, ts: day + "T00:00:00Z" }, basis).amount).toBeCloseTo(next[index]! / 10, 10);
      }
    }
  }
});

test("unknown and invalid evidence stays unpriced; zero rates are different from missing rates", () => {
  for (const speed of [null, "unknown", "turbo"]) expect(priceCodexEvent(config, event({ speed }), "chatgpt_credits").reason).toBe("unknown_speed");
  for (const patch of [{ in_tok: -1 }, { cached_in: 100001 }, { out_tok: NaN }, { out_tok: Infinity }]) {
    expect(priceCodexEvent(config, event(patch), "chatgpt_credits").reason).toBe("invalid_tokens");
  }
  expect(priceCodexEvent(config, event({ cache_write: 50 }), "chatgpt_credits").reason).toBe("cache_write_semantics_unknown");
  expect(priceCodexEvent(config, event({ ts: "2026-02-30T00:00:00Z" }), "chatgpt_credits").reason).toBe("invalid_timestamp");
  const free = structuredClone(config);
  for (const rule of free.rules) rule.rates = { in_uncached: 0, in_cache_read: 0, out_total: 0 };
  expect(priceCodexEvent(free, event(), "chatgpt_credits").amount).toBe(0);
});

test("private cards can replace or disable rules without changing legacy USD", () => {
  expect(resolveCodexAccountingConfig({ codex_accounting: { version: 1, rules: [] } }).rules).toEqual([]);
  const legacy: RateCard = { ...card, vendors: { openai: { models: { "gpt-6-astra": {
    in_uncached: 3, in_cache_read: .3, out_total: 15,
  } } } } };
  resolveCodexAccountingConfig(legacy);
  expect(calculateCodexUsd(getCodexRate(legacy, "gpt-6-astra"), 100000, 80000, 0, 10000)).toBeCloseTo(.234, 10);
  const invalid = structuredClone(config); invalid.rules[0]!.rates.in_cache_read = null as unknown as number;
  expect(() => validateCodexAccountingConfig(invalid)).toThrow("invalid rates");
  const api = structuredClone(config); api.rules.find(r => r.billing_basis === "api_equivalent_usd")!.multiplier = 2.5;
  expect(() => validateCodexAccountingConfig(api)).toThrow("explicit tier rates");
});

function fixture(db: Database) {
  codexFixturePeriods(db);
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,ts TEXT,model TEXT,speed TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,project_id TEXT);`);
  const put = db.query("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?)");
  for (const [home, relative, speed, day, project] of [
    ["/archive", "sessions/a.jsonl", "fast", "2026-09-08", "project-a"],
    ["/local/.codex", "sessions/a.jsonl", "fast", "2026-09-08", "project-a"],
    ["/archive", "sessions/b.jsonl", "standard", "2026-09-08", "project-b"],
    ["/archive", "sessions/c.jsonl", "unknown", "2026-09-08", "project-b"],
    ["/archive", "sessions/d.jsonl", "fast", "2026-09-07", "project-b"],
  ]) {
    put.run(home!, `${home}/${relative}`, `${day}T01:00:00Z`, "gpt-6-astra", speed!, 100000, 80000, 0, 10000, project!);
  }
}

test("5h report recovers main historical counters via dated ownership and keeps weekly/Spark denominators separate", () => {
  const db = new Database(":memory:");
  fixture(db);
  db.exec(`CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT,plan_type TEXT);
    CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
    INSERT INTO probe_windows VALUES
      ('codex','codex','codex1','2026-09-08T00:00:00Z','weekly','pro',0,'2026-09-15T00:00:00Z',10080,1),
      ('codex','codex','codex1','2026-09-08T02:00:00Z','weekly','pro',10,'2026-09-15T00:00:00Z',10080,1),
      ('codex','codex_bengalfox','codex1','2026-09-08T02:00:00Z','primary','pro',99,'2026-09-08T05:00:00Z',300,1);`);
  const insert = db.query("INSERT INTO ratelimit VALUES('/archive','/archive/sessions/a.jsonl',?,?,?,300,'codex','pro')");
  insert.run("2026-09-08T00:00:00Z", 0, Date.parse("2026-09-08T05:00:00Z") / 1000);
  insert.run("2026-09-08T02:00:00Z", 40, Date.parse("2026-09-08T05:00:00Z") / 1000);
  try {
    const homes = new Map([["/archive", "codex1"]]);
    const eras = buildEraIndex([{ id: "codex1", vendor: "codex", home: "/archive", from: "2026-09-01", until: "2026-09-09" }]);
    const options = { since: "2026-09-08", until: "2026-09-08", account: "codex1" };
    const weekly = buildCodexAccountingReport(db, card, options, homes, eras);
    const short = buildCodexAccountingReport(db, card, { ...options, window_minutes: 300 }, homes, eras);
    expect(short.provider?.counter).toBe("five_hour");
    expect(short.windows).toHaveLength(1);
    expect(short.windows![0]).toMatchObject({ window_minutes: 300, observed_pp: 40, plan: "pro" });
    expect(short.windows![0]!.usage.events).toBe(3);
    expect(short.traffic_periods.reduce((n, p) => n + p.events, 0)).toBe(3);
    expect(short.tokens).toBe(weekly.tokens);
    expect(short.normalization).toEqual(weekly.normalization);
    expect(weekly.windows![0]!.observed_pp).toBe(10);
    expect(() => accountingOptions(new URLSearchParams("window_minutes=60"))).toThrow("300 or 10080");
  } finally { db.close(); }
});

test("Free defaults to its 30-day meter and keeps explicitly selected durations separate", () => {
  const db = new Database(":memory:");
  fixture(db);
  db.exec(`CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
    INSERT INTO probe_windows VALUES
      ('codex','codex','codex1','2026-09-08T00:00:00Z','primary','free',0,'2026-10-08T00:00:00Z',43200,1),
      ('codex','codex','codex1','2026-09-08T02:00:00Z','primary','free',40,'2026-10-08T00:00:00Z',43200,1),
      ('codex','codex','codex1','2026-09-08T00:00:00Z','secondary','free',0,'2026-09-15T00:00:00Z',10080,1),
      ('codex','codex','codex1','2026-09-08T01:00:00Z','secondary','free',20,'2026-09-15T00:00:00Z',10080,1),
      ('codex','codex','codex1','2026-09-08T00:00:00Z','primary','free',0,'2026-09-08T05:00:00Z',300,1),
      ('codex','codex','codex1','2026-09-08T01:00:00Z','primary','free',10,'2026-09-08T05:00:00Z',300,1);`);
  try {
    const options = { since: "2026-09-08", until: "2026-09-08", account: "codex1" };
    const homes = new Map([["/archive", "codex1"]]);
    const monthly = buildCodexAccountingReport(db, card, options, homes);
    expect(monthly.provider?.counter).toBe("thirty_day");
    expect(monthly.provider?.counters?.map(counter => counter.id)).toEqual(["weekly", "five_hour", "thirty_day"]);
    expect(monthly.windows).toHaveLength(1);
    expect(monthly.windows![0]).toMatchObject({ window_minutes: 43200, observed_pp: 40 });
    const totals = JSON.stringify(monthly.normalization);
    for (const [minutes, pp] of [[300, 10], [10080, 20], [43200, 40]] as const) {
      const report = readPreparedCodexAccountingReport(db, card, { ...options, window_minutes: minutes }, homes);
      expect(report.windows).toHaveLength(1);
      expect(report.windows![0]).toMatchObject({ window_minutes: minutes, observed_pp: pp });
      expect(JSON.stringify(report.normalization)).toBe(totals);
    }
    expect(accountingOptions(new URLSearchParams("window_minutes=43200")).window_minutes).toBe(43200);
  } finally { db.close(); }
});

test("traffic totals assign events at a reset to the new cycle without splitting daily aggregates", () => {
  const db = new Database(":memory:");
  fixture(db);
  db.exec(`CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
    INSERT INTO probe_windows VALUES
    ('codex','codex','codex1','2026-09-08T00:00:00Z','weekly','pro',20,'2026-09-08T01:00:00Z',10080,1),
    ('codex','codex','codex1','2026-09-08T00:55:00Z','weekly','pro',99,'2026-09-08T01:00:00Z',10080,1),
    ('codex','codex','codex1','2026-09-08T01:05:00Z','weekly','pro',1,'2026-09-10T01:00:00Z',10080,1),
    ('codex','codex','codex1','2026-09-08T02:00:00Z','weekly','pro',30,'2026-09-10T01:00:00Z',10080,1);`);
  try {
    const report = buildCodexAccountingReport(db, card, { since: "2026-09-08", until: "2026-09-08" });
    expect(report.traffic_periods).toHaveLength(2);
    expect(report.traffic_periods[0]!.events).toBe(0);
    expect(report.traffic_periods[1]!.events).toBe(report.events);
    expect(report.traffic_periods[1]!.tokens).toBe(report.tokens);
    expect(report.traffic_periods[1]!.api).toBeCloseTo(report.normalization.standard_api_usd.priced_subtotal, 8);
  } finally { db.close(); }
});

test("capacity includes both cycle boundaries outside the date filter without expanding report totals", () => {
  const db = new Database(":memory:");
  fixture(db);
  db.exec(`CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
    INSERT INTO probe_windows VALUES
    ('codex','codex','codex1','2026-09-08T02:00:00Z','weekly','pro',70,'2026-09-14T00:00:00Z',10080,1);`);
  try {
    for (const day of ["2026-09-07", "2026-09-08"]) {
      const report = buildCodexAccountingReport(db, card, { since: day, until: day });
      expect(report.events).toBe(day === "2026-09-07" ? 1 : 3);
      expect(report.breakdown.every(r => r.day === day)).toBe(true);
      expect(report.windows).toHaveLength(1);
      expect(report.windows![0]).toMatchObject({ start: "2026-09-07T00:00:00.000Z", start_percent: 0, observed_pp: 70,
        cycle_end: "2026-09-14T00:00:00.000Z", end: "2026-09-08T02:00:00.000Z" });
      expect(report.windows![0]!.usage.events).toBe(4);
    }
  } finally { db.close(); }
});

test("365 days includes pre-probe cycles, preserves missing rates and excludes legacy Spark clocks", () => {
  const db = new Database(":memory:");
  fixture(db);
  db.exec(`CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT,plan_type TEXT);
    INSERT INTO events VALUES('/archive','old','2026-02-14T09:00:00Z','old-model',NULL,100,0,0,10,NULL),
      ('/archive','spark','2026-02-15T09:00:00Z','gpt-5.3-codex-spark',NULL,100,0,0,10,NULL);
    INSERT INTO ratelimit VALUES('/archive','old','2026-02-14T10:00:00Z',77,1771255520,10080,'codex',NULL),
      ('/archive','spark','2026-02-15T10:00:00Z',10,1771776000,10080,'codex','pro');`);
  try {
    const report = buildCodexAccountingReport(db, card, { since: "2025-09-12", until: "2026-09-11", account: "codex1" });
    expect(report.windows).toHaveLength(1);
    expect(report.windows![0]).toMatchObject({ start_percent: 0, observed_pp: 77, plan: null, meter_sources: ["session"] });
    expect(report.windows![0]!.usage).toMatchObject({ events: 1, unpriced_events: 1, api_standard: 0 });
    expect(report.meter_history).toMatchObject({ session_first: "2026-02-14T10:00:00.000Z", periodic_first: null });
    const recent = buildCodexAccountingReport(db, card, { since: "2026-08-12", until: "2026-09-11", account: "codex1" });
    expect(recent.windows).toHaveLength(0);
  } finally { db.close(); }
});

test("long Capacity reads published cycles without source history, survives restart and retains pending sums", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-capacity-register-"));
  const file = path.join(directory, "atlas.sqlite");
  let db = new Database(":memory:");
  const options = { since: "2026-07-21", until: "2026-10-18", account: "codex1" };
  const read = () => readPreparedCodexAccountingReport(db, card, options, fixtureHomes(), undefined, true,
    undefined, undefined, undefined, loadAccountResolver(db), codexFixtureSources);
  const withoutRawReads = () => {
    const query = db.query;
    db.query = ((sql: string) => {
      if (/\b(?:FROM|JOIN)\s+(?:probe_windows|probe_sources|ratelimit|limit_window_inputs)\b/i.test(sql))
        throw new Error(`Capacity read source history: ${sql}`);
      return query.call(db, sql);
    }) as typeof db.query;
    try { return read(); } finally { db.query = query; }
  };
  try {
    fixture(db);
    // This restart trial concerns capacity; fixture-only project rules live in a process-local override.
    db.exec("UPDATE events SET project_id=NULL");
    db.exec(`CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,
      used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
      INSERT INTO probe_windows VALUES
      ('codex','codex','codex1','2026-09-08T00:00:00Z','weekly','pro',0,'2026-09-15T00:00:00Z',10080,1),
      ('codex','codex','codex1','2026-09-08T02:00:00Z','weekly','pro',40,'2026-09-15T00:00:00Z',10080,1);`);
    const reference = buildCodexAccountingReport(db, card, options);
    const facts = db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const changes = db.query("SELECT total_changes() n").get();
    expect(withoutRawReads()).toEqual(reference);
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
    // A corrected percentage is published by the existing producers, never by the report.
    db.exec("UPDATE probe_windows SET used_percent=50 WHERE used_percent=40");
    const corrected = buildCodexAccountingReport(db, card, options);
    expect(corrected.windows![0]!.observed_pp).toBe(50);
    expect(withoutRawReads()).toEqual(corrected);
    expect(corrected.amounts).toEqual(reference.amounts);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(facts);

    fs.writeFileSync(file, db.serialize());
    db.close();
    db = new Database(file);
    expect(withoutRawReads()).toEqual(corrected);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(facts);
    db.exec("INSERT OR IGNORE INTO window_usage_pending(provider,account,counter,window_id) SELECT provider,account,counter,window_id FROM window_usage");
    expect(withoutRawReads()).toEqual(corrected);
    db.exec("DELETE FROM window_usage");
    expect(withoutRawReads).toThrow(WindowUsagePreparing);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a rollout switching from Spark to Luna keeps their clocks separate and preserves the continuing Pro cycle",()=>{
  const db=new Database(":memory:");fixture(db);
  db.exec(`DELETE FROM events;
    ALTER TABLE events ADD COLUMN meter_reset INTEGER;
    CREATE TABLE ratelimit(home TEXT,path TEXT,ts TEXT,used_percent REAL,resets_at INTEGER,window_minutes INTEGER,limit_id TEXT,plan_type TEXT);`);
  const main=Date.parse("2026-09-03T16:24:50Z")/1000,spark=Date.parse("2026-08-31T14:13:42Z")/1000;
  const add=db.query("INSERT INTO events VALUES('/archive','mixed',?,?,'standard',100,0,0,10,NULL,?)");
  add.run("2026-08-28T13:40:00Z","gpt-5.6-luna",main);
  add.run("2026-08-28T13:52:00Z","gpt-5.3-codex-spark",spark);
  add.run("2026-08-28T13:55:00Z","gpt-5.6-luna",main);
  add.run("2026-08-29T20:00:00Z","gpt-5.6-luna",main);
  const meter=db.query("INSERT INTO ratelimit VALUES('/archive','mixed',?,?,?,10080,'codex','pro')");
  meter.run("2026-08-28T13:40:00Z",44,main);
  meter.run("2026-08-28T13:51:30Z",63,spark+1);
  meter.run("2026-08-28T13:53:53Z",99,spark);
  meter.run("2026-08-28T13:55:00Z",44,main);
  meter.run("2026-08-29T21:00:00Z",92,main);
  try {
    const result=buildCodexAccountingReport(db,card,{since:"2026-08-27",until:"2026-08-30",account:"codex1"});
    expect(result.events).toBe(4);
    expect(result.windows).toHaveLength(1);
    expect(result.windows![0]).toMatchObject({reset:"2026-09-03T16:24:50.000Z",observed_pp:92,
      end:"2026-08-29T21:00:00.000Z",usage:{events:3,tokens:330}});
    expect(result.windows![0]!.evidence!.excluded_events.counter).toBe(1);
  }finally{db.close();}
});

test("accounting follows data and configuration publication", async () => {
  const sqlite = new Database(":memory:");
  fixture(sqlite);
  prepareProbeReaderFixture(sqlite,[{id:"codex1",vendor:"codex",source_home:"/archive"}]);
  sqlite.exec(`CREATE TABLE sync_revisions(id INTEGER PRIMARY KEY,data_revision INTEGER,config_revision INTEGER);
    INSERT INTO sync_revisions VALUES(1,1,1);
    CREATE TABLE vendor_sync_revisions(vendor TEXT,data_revision INTEGER);
    INSERT INTO vendor_sync_revisions VALUES('codex',1);`);
  const accounts = splitProbeReaderFixtureConfig(codexFixtureSources);
  const ctx = { sqlite, accounts, eras: buildEraIndex(periodEras(sqlite, accounts), "instant"),
    homeToSubId: new Map(), subIdToHomes: new Map(), rateCards: structuredClone(card), rootDir: process.cwd() } as AppContext;
  prepareCodexLedgerFixture(sqlite,card,fixtureHomes());
  const fetch = createFetchHandler(ctx);
  const url = "http://127.0.0.1/api/codex-accounting?since=2026-09-08&until=2026-09-08&account=codex1";
  try {
    // One subscription per report: a request without one is refused before the report is read.
    for (const refused of ["http://127.0.0.1/api/codex-accounting?since=2026-09-08&until=2026-09-08",
      "http://127.0.0.1/api/codex-accounting?since=2026-09-08&until=2026-09-08&account=all",
      "http://127.0.0.1/api/subscription-accounting?provider=codex&since=2026-09-08&until=2026-09-08"]) {
      const response = await fetch(new Request(refused));
      expect({ status: response.status, body: await response.json() })
        .toEqual({ status: 400, body: { error: "Select one subscription to analyse its capacity" } });
    }
    const first = await fetch(new Request(url));
    const original = await first.json();
    expect({status:first.status,body:original}).toMatchObject({status:200});
    // A database without a file is read in place; with one, the report is computed off the HTTP thread (data-read.ts).
    expect(first.headers.get("X-Analysis")).toBe("inline");
    expect(await (await fetch(new Request(url))).json()).toEqual(original);
    sqlite.exec("UPDATE events SET out_tok=out_tok+1; UPDATE sync_revisions SET data_revision=2");
    prepareCodexLedgerFixture(sqlite,ctx.rateCards,fixtureHomes());
    const changed = await fetch(new Request(url));
    expect((await changed.json()).tokens).toBeGreaterThan(original.tokens);
    ctx.rateCards = { ...card, codex_accounting: { version: 1, rules: [] } };
    sqlite.exec("UPDATE sync_revisions SET config_revision=2");
    prepareCodexLedgerFixture(sqlite,ctx.rateCards,fixtureHomes());
    const repriced = await fetch(new Request(url));
    expect((await repriced.json()).normalization.standard_api_usd.priced_subtotal).toBe(0);
  } finally { sqlite.close(); }
});

test("accounting honors pending publication and modern tier corrections",()=>{
  const db=new Database(":memory:"); fixture(db);
  try {
    db.exec(`CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
      INSERT INTO probe_windows VALUES('codex','codex','codex1','2026-09-08T02:00:00Z','weekly','pro',30,'2026-09-14T00:00:00Z',10080,1);`);
    createAnalysisSourceRevisions(db);
    installAnalysisTracking(db);
    const options={since:"2026-09-08",until:"2026-09-08",account:"codex1"};
    const before=buildCodexAccountingReport(db,card,options);
    const read=(rates=card)=>readPreparedCodexAccountingReport(db,rates,options,fixtureHomes(),undefined,true,undefined,undefined,undefined,loadAccountResolver(db),codexFixtureSources);
    expect(read()).toEqual(before);
    const facts=db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const policy=structuredClone(codexLedgerReadContext(card).policy.policy);
    for(const rule of policy.tier_rules) if(rule.model==="gpt-6-astra" && rule.tier==="fast" && rule.billing_basis==="chatgpt_credits") {
      rule.multiplier="3.5";rule.id+="-corrected";rule.sources=["https://example.test/corrected-tier"];rule.confidence="user";
    }
    for(const rule of policy.base_rules) {
      rule.id+="-renamed";rule.sources=["https://example.test/new-base-declaration"];rule.confidence="user";
    }
    const corrected={...card,codex_ledger_policy:policy},context=codexLedgerReadContext(corrected);
    db.exec("UPDATE usage_ledger_state SET status='pending' WHERE provider='codex'");
    expect(()=>read()).toThrow(SubscriptionFactsPending);
    expect(()=>read(corrected)).toThrow(SubscriptionFactsPending);
    db.query("UPDATE usage_ledger_state SET status='ready',rules_digest=?,rules_json=? WHERE provider='codex'").run(context.rulesRevision!,JSON.stringify(policy));
    const after=read(corrected);
    expect(after.amounts.chatgpt_credits.priced_subtotal).toBe(107.25);
    expect(after.normalization.normalized_usd.priced_subtotal).toBeGreaterThan(before.normalization.normalized_usd.priced_subtotal);
    expect(after.amounts.api_equivalent_usd).toEqual(before.amounts.api_equivalent_usd);
    expect(after.rule_source).toBe("configured");
    const originalBase=before.applied_rules.find(rule=>rule.model==="gpt-6-astra" && rule.billing_basis==="chatgpt_credits" && rule.speed==="standard")!;
    const actual=after.applied_rules.find(rule=>rule.model==="gpt-6-astra" && rule.billing_basis==="chatgpt_credits" && rule.speed==="fast")!;
    expect(after.applied_rules.find(rule=>rule.id===originalBase.id)).toEqual(originalBase);
    expect(actual.multiplier).toBe(3.5);
    expect(actual.confidence).toBe("user");
    expect(actual.sources).toEqual([...new Set([...originalBase.sources,"https://example.test/corrected-tier"])]);
    expect(actual.sources).not.toContain("https://example.test/new-base-declaration");
    expect(actual.id).toContain(originalBase.id);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(facts);
    expect(read(corrected)).toEqual(after);
  } finally {db.close();}
});

test("applied metadata preserves dated factors and an open tier's actual stored base",()=>{
  const db=new Database(":memory:"); fixture(db);
  try {
    db.exec(`DELETE FROM events; INSERT INTO events VALUES
      ('/archive','earlier','2026-09-08T01:00:00Z','gpt-6-astra','fast',100000,80000,0,10000,NULL),
      ('/archive','later','2026-09-09T01:00:00Z','gpt-6-astra','fast',100000,80000,0,10000,NULL);`);
    const options={since:"2026-09-08",until:"2026-09-09",account:"codex1"};
    const before=buildCodexAccountingReport(db,card,options,fixtureHomes(),undefined,false);
    const facts=db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
    const policy=structuredClone(codexLedgerReadContext(card).policy.policy);
    const old=policy.tier_rules.find(rule=>rule.model==="gpt-6-astra" && rule.billing_basis==="chatgpt_credits" && rule.tier==="fast")!;
    policy.tier_rules.push({...old,id:"dated-fast-correction",valid_from:"2026-09-09",multiplier:"3.5",sources:["https://example.test/dated-tier"],confidence:"user"});
    old.valid_until="2026-09-09";
    const corrected={...card,codex_ledger_policy:policy},context=codexLedgerReadContext(corrected);
    db.query("UPDATE usage_ledger_state SET rules_digest=?,rules_json=? WHERE provider='codex'").run(context.rulesRevision!,JSON.stringify(policy));
    const read=(rates:RateCard)=>readPreparedCodexAccountingReport(db,rates,options,fixtureHomes(),undefined,false,undefined,undefined,undefined,loadAccountResolver(db),codexFixtureSources);
    const after=read(corrected),fast=after.applied_rules.filter(rule=>rule.model==="gpt-6-astra" && rule.billing_basis==="chatgpt_credits" && rule.speed==="fast");
    expect(before.amounts.chatgpt_credits.value).toBe(97.5);
    expect(after.amounts.chatgpt_credits.value).toBe(117);
    expect(fast.map(rule=>[rule.valid_from,rule.valid_until??null,rule.multiplier]).sort()).toEqual([
      ["2026-09-08","2026-09-09",2.5],["2026-09-09",null,3.5],
    ]);
    expect(fast.find(rule=>rule.multiplier===3.5)!.sources).toContain("https://example.test/dated-tier");
    policy.tiers.push("ultrafast");
    policy.mappings.find(mapping=>mapping.raw_value==="priority")!.tier="ultrafast";
    for(const basis of ["chatgpt_credits","api_equivalent_usd"] as const) {
      const template=policy.tier_rules.find(rule=>rule.model==="gpt-6-astra" && rule.billing_basis===basis && rule.tier==="standard")!;
      policy.tier_rules.push({...template,id:`ultra-${basis}`,tier:"ultrafast",multiplier:"4",sources:["https://example.test/ultra"],confidence:"user"});
    }
    const open={...card,codex_ledger_policy:policy},openContext=codexLedgerReadContext(open);
    db.query("UPDATE usage_ledger_state SET rules_digest=?,rules_json=? WHERE provider='codex'").run(openContext.rulesRevision!,JSON.stringify(policy));
    const ultra=read(open),applied=ultra.applied_rules.filter(rule=>rule.speed==="ultrafast");
    expect(ultra.amounts.chatgpt_credits.value).toBe(156);
    expect(applied).toHaveLength(2);
    expect(applied.every(rule=>rule.multiplier===4 && rule.sources.includes("https://example.test/ultra"))).toBe(true);
    expect(db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(facts);
  } finally {db.close();}
});

test("accounting windows include adjacent lexical-date instants and their corrections",()=>{
  const db=new Database(":memory:"); fixture(db);
  try {
    db.exec(`DELETE FROM events; DELETE FROM account_periods;
      INSERT INTO account_periods(provider,source,account,from_ts,until_ts,origin,evidence) VALUES
        ('codex','codex/fixture','old','2000-01-01T00:00:00Z','2026-09-08T00:00:00Z','declared','fixture'),
        ('codex','codex/fixture','codex1','2026-09-08T00:00:00Z',NULL,'declared','fixture');
      INSERT INTO events VALUES
        ('/archive','offset-a','2026-09-07T23:30:00-02:00','gpt-6-astra','standard',100,0,0,10,NULL),
        ('/archive','offset-b','2026-09-08T04:00:00+02:00','gpt-6-astra','standard',200,0,0,20,NULL),
        ('/archive','outside','2026-09-08T23:30:00-02:00','gpt-6-astra','standard',300,0,0,30,NULL);
      CREATE TABLE probe_windows(provider TEXT,limit_group TEXT,subject TEXT,ts TEXT,kind TEXT,plan TEXT,used_percent REAL,resets_at TEXT,window_minutes INTEGER,ok INTEGER);
      INSERT INTO probe_windows VALUES
        ('codex','codex','codex1','2026-09-08T00:00:00Z','weekly','pro',0,'2026-09-14T00:00:00Z',10080,1),
        ('codex','codex','codex1','2026-09-08T03:00:00Z','weekly','pro',30,'2026-09-14T00:00:00Z',10080,1);`);
    createAnalysisSourceRevisions(db);
    installAnalysisTracking(db);
    const options={since:"2026-09-08",until:"2026-09-08",account:"codex1"};
    const before=buildCodexAccountingReport(db,card,options);
    expect(before).toMatchObject({events:2,tokens:330});
    expect(before.windows![0]!.usage).toMatchObject({events:2,tokens:330});
    db.exec("UPDATE events SET in_tok=400 WHERE path='offset-a'");
    const after=buildCodexAccountingReport(db,card,options);
    expect(after).toMatchObject({events:2,tokens:630});
    expect(after.windows![0]!.usage).toMatchObject({events:2,tokens:630});
    expect(after.windows![0]!.usage.api_standard).toBeGreaterThan(before.windows![0]!.usage.api_standard);
  } finally {db.close();}
});

test("omitted tiers are Standard in reports and model bars, preserving filters, mirrors and token totals", () => {
  const db = new Database(":memory:");
  try {
    fixture(db);
    const options = { since: "2026-09-08", until: "2026-09-08", account: "codex1" };
    const report = buildCodexAccountingReport(db, card, options);
    expect(report.events).toBe(3); expect(report.tokens).toBe(330000);
    expect(report.excluded_mirror_events).toBe(1); expect(report.known_speed_tokens).toBe(330000);
    expect(report.amounts.chatgpt_credits).toMatchObject({ value: 87.75, priced_subtotal: 87.75, status: "complete", unpriced_tokens: 0 });
    expect(report.amounts.api_equivalent_usd.priced_subtotal).toBeCloseTo(3.12, 10);
    expect(report.amounts.api_equivalent_usd).toMatchObject({ status: "complete", unpriced_events: 0, reasons: {} });
    expect(report.unknown_speed_tokens).toBe(0);
    expect(report.amounts.chatgpt_credits.reasons).toEqual({});
    expect(report.breakdown.reduce((s, r) => s + r.amounts.chatgpt_credits.priced_subtotal, 0)).toBe(87.75);
    expect(codexModelUsage(report.breakdown)).toMatchObject({ tokens: 330000, calls: 3,
      modes: { standard: 220000, fast: 110000, unknown: 0 } });
    expect(buildCodexAccountingReport(db, card, { ...options, project: "project-a" }).amounts.chatgpt_credits.value).toBe(48.75);
    expect(buildCodexAccountingReport(db, card, { ...options, account: "other" }).amounts.chatgpt_credits.status).toBe("empty");
    db.exec("ALTER TABLE events DROP COLUMN speed");
    const legacy = buildCodexAccountingReport(db, card, options);
    expect(legacy.tokens).toBe(330000); expect(legacy.unknown_speed_events).toBe(0);
    expect(legacy.amounts.chatgpt_credits).toMatchObject({ status: "complete", value: 58.5 });
  } finally { db.close(); }
});

test("HTTP rejects invalid/oversized ranges, returns the report and never mutates facts", async () => {
  const db = new Database(":memory:"); fixture(db);
  prepareProbeReaderFixture(db,[{id:"codex1",vendor:"codex",source_home:"/archive"}]);
  prepareCodexLedgerFixture(db,card,fixtureHomes());
  try {
    const ctx = { sqlite: db, rateCards: card };
    for (const query of ["since=2026-02-30", "since=2025-01-01&until=2026-03-01", "since=2026-09-09&until=2026-09-08"]) {
      expect(handleCodexAccounting(ctx, new Request(`http://localhost/api/codex-accounting?${query}`)).status).toBe(400);
    }
    expect(handleCodexAccounting(ctx, new Request("http://localhost/api/codex-accounting", { method: "POST" })).status).toBe(405);
    expect(handleCodexAccounting(ctx, new Request("http://localhost/api/codex-accounting?since=2026-01-01&until=2026-09-09")).status).toBe(400);
    expect(handleCodexAccounting(ctx, new Request("http://localhost/api/codex-accounting?since=2026-01-01&until=2026-09-09&account=codex1")).status).toBe(200);
    expect(accountingOptions(new URLSearchParams("since=2025-09-09&until=2026-09-09")).since).toBe("2025-09-09");
    expect(accountingOptions(new URLSearchParams("since=2025-09-08&until=2026-09-09")))
      .toMatchObject({ since: "2025-09-08", until: "2026-09-09" });
    expect(() => accountingOptions(new URLSearchParams("since=1900-01-01&until=2026-09-09"))).toThrow("Maximum range");
    const response = handleCodexAccounting(ctx, new Request("http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-08&account=codex1"));
    expect(response.status).toBe(200); expect((await response.json()).quota_verified).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 5 });
    expect(accountingOptions(new URLSearchParams(), new Date("2026-09-08T01:00:00Z"))).toMatchObject({ since: "2026-09-08", until: "2026-09-08" });
  } finally { db.close(); }
});

test("missing probe preparation returns the existing pending response", async () => {
  const db = new Database(":memory:"); fixture(db);
  prepareCodexLedgerFixture(db,card,fixtureHomes());
  try {
    const response = handleCodexAccounting({sqlite:db,rateCards:card},
      new Request("http://localhost/api/codex-accounting?since=2026-09-08&until=2026-09-08&account=codex1"));
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Analysis")).toBe("preparing");
  } finally { db.close(); }
});

test("accounting attributes each event across an era boundary instead of inheriting a stale rollout owner", () => {
  const db = new Database(":memory:"); fixture(db);
  try {
    const eras = buildEraIndex([
      { id: "old", vendor: "codex", home: "/archive", until: "2026-09-08" },
      { id: "new", vendor: "codex", home: "/archive", from: "2026-09-08" },
      { id: "new", vendor: "codex", home: "/local/.codex", from: "2026-09-08" },
    ]);
    db.exec("DELETE FROM account_periods; INSERT INTO account_periods(provider,source,account,from_ts,until_ts,origin,evidence) VALUES('codex','codex/fixture','old','2000-01-01T00:00:00Z','2026-09-08T00:00:00Z','declared','test'),('codex','codex/fixture','new','2026-09-08T00:00:00Z',NULL,'declared','test')");
    const report = buildCodexAccountingReport(db, card, { since: "2026-09-08", until: "2026-09-08", account: "new" }, undefined, eras);
    expect(report.events).toBe(3); expect(report.tokens).toBe(330000);
    expect(report.breakdown.every(row => row.account === "new")).toBe(true);
    expect(report.account_attribution).toBe("account-periods");
    expect(buildCodexAccountingReport(db, card, { since: "2026-09-07", until: "2026-09-07", account: "old" }, undefined, eras).events).toBe(1);
  } finally { db.close(); }
});

test("strict era loading expands configured paths and does not hide invalid account configuration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accounting-config-"));
  const file = path.join(dir, "accounts.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ subscriptions: [{ id: "codex1", vendor: "codex", home: "${ARCHIVE}/codex/laptop", source_home: "~/.codex" }] }));
    const eras = buildEraIndex(loadEraDeclarations({ strict: true, file }));
    expect(eras.resolve("codex", expandPath("${ARCHIVE}/codex/laptop"), "2026-09-08T00:00:00Z")).toBe("codex1");
    expect(eras.resolve("codex", expandPath("~/.codex"), "2026-09-08T00:00:00Z")).toBe("codex1");
    fs.writeFileSync(file, "{bad");
    expect(() => loadEraDeclarations({ strict: true, file })).toThrow();
    expect(loadEraDeclarations({ file })).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the accounting CLI uses the same calculator with explicit database and rate card", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accounting-"));
  const file = path.join(dir, "atlas.sqlite");
  const db = new Database(file); fixture(db);
  // Both processes use the same isolated physical-source configuration.
  const configRoot = path.join(dir, "config");
  fs.mkdirSync(configRoot);
  fs.writeFileSync(path.join(configRoot, "accounts.json"), JSON.stringify({version:2,subscriptions:[],sources:[]}));
  const declarations: import("./eras").EraDeclaration[] = [];
  const expected = buildCodexAccountingReport(db, card, { since: "2026-09-08", until: "2026-09-08" },
    undefined, undefined, true, undefined, undefined, undefined, undefined, declarations);
  // ... and the same project rules (the fixture's, derived while its ledger was prepared: rules.fixture.ts).
  saveProjects(projectRulesOverride(db) ?? { projects: [] }, path.join(configRoot, "projects.json"));
  db.close(true);
  try {
    const child = Bun.spawn([process.execPath, "run", "src/server/codex-accounting-cli.ts", "--db", file, "--rates", path.resolve("rate-cards.json"),
      "--since", "2026-09-08", "--until", "2026-09-08"], { env: {...process.env,TOKENATLAS_CONFIG:configRoot}, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0);
    const actual = JSON.parse(stdout);
    expect(actual.amounts).toEqual(expected.amounts); expect(actual.tokens).toBe(expected.tokens);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (error) { if ((error as { code?: string }).code !== "EBUSY") throw error; }
  }
});

test("pre-Pro20 traffic has API reference prices as well as credit prices", () => {
  for (const model of ["gpt-5.5", "gpt-5.4"]) {
    const e = event({ model, ts: "2026-06-14T12:00:00Z" });
    expect(priceCodexEvent(config, e, "api_equivalent_usd").amount).toBeGreaterThan(0);
    expect(priceCodexEvent(config, e, "chatgpt_credits").amount).toBeGreaterThan(0);
    expect(priceCodexEvent(config, { ...e, in_tok: 300000, cached_in: 0 }, "api_equivalent_usd").long_context).toBe(true);
  }
});


test("per-event Business billing overrides a shared Pro profile without losing traffic", () => {
  const db = new Database(":memory:");
  try {
    fixture(db);
    db.exec(`ALTER TABLE events ADD COLUMN billing_mode TEXT;
      ALTER TABLE events ADD COLUMN meter_reset INTEGER;
      ALTER TABLE events ADD COLUMN plan_type TEXT;
      ALTER TABLE events ADD COLUMN account_id TEXT;
      UPDATE events SET billing_mode='allowance';
      UPDATE events SET billing_mode='business_credits' WHERE path LIKE '%b.jsonl';`);
    const eras = buildEraIndex([{ id: "codex1", vendor: "codex", home: "/archive" },
      { id: "codex1", vendor: "codex", home: "/local/.codex" }]);
    const options = { since: "2026-09-08", until: "2026-09-08" };
    const business = buildCodexAccountingReport(db, card, { ...options, account: "codex1::business" }, new Map(), eras, false);
    const personal = buildCodexAccountingReport(db, card, { ...options, account: "codex1" }, new Map(), eras, false);
    const all = buildCodexAccountingReport(db, card, options, new Map(), eras, false);
    expect(business.events).toBe(1);
    expect(business.funding?.[0]?.mode).toBe("business_credits");
    expect(personal.events).toBe(2);
    expect(personal.events + business.events).toBe(all.events);
  } finally { db.close(); }
});
