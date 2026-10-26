import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ACCOUNTS, TIMES, createClaudeCodeAcceptanceFixture, measureAnalysis } from "./claude-code-capacity.fixture";
import { buildClaudeLimit } from "./claude-limit";
import { getClaudeRate } from "./pricing";
import { loadAccountResolver } from "./account-resolver";
import { buildEraIndex } from "./eras";
import { subscriptionCapacityCycles } from "./subscription-accounting";
import { handleCapacityCycles } from "./capacity-cycles";
import { advanceCapacityCycleResults } from "./capacity-cycle-producer";
import { prepareClaudeCardMetadataFixture } from "./claude-card-metadata.fixture";
import { handleClaudeLimit, handleWindows, type AppContext } from "./api";
import { buildSubscriptionCapacities } from "./capacity-equivalents";
import { capacityFull, capacityIsLowerBound, capacityMeasurement, capacityPerPoint, compareCapacity, dimensionComparison } from "../web/lib/codex-capacity";
import { ClaudeModelsCard } from "../web/components/ClaudeLimitPanel";
import type { ClaudeLimitResponse } from "../web/lib/api";
import type { WindowsResponse } from "../web/lib/api";
import type { CapacityCyclesResponse } from "../shared/capacity-cycles";

const COUNTER = JSON.stringify(["weekly_all", "weekly", 10080]);
const range = { since: "2026-09-13", until: "2026-09-19" };
const gauge = { subscription: ACCOUNTS.a, window_hours: 168, observations: [] };
const catalog = { provider_groups: [] };
type Fixture = ReturnType<typeof createClaudeCodeAcceptanceFixture>;
function consumers(f: Fixture) {
  const resolver = loadAccountResolver(f.db);
  const ctx = { sqlite: f.db, rateCards: f.rates, resolver, eras: buildEraIndex([]), cycles: { windows: [] }, plans: {}, plansCatalog: catalog, manualCapacity: [],
    claudeGauge: gauge, vendorDiscovery: { accounts: [] }, accounts: { sources: [], subscriptions: [{ id: ACCOUNTS.a, vendor: "claude" }] } } as unknown as AppContext;
  const limit = buildClaudeLimit(f.db, gauge, (m, d, s) => getClaudeRate(f.rates, m, d, s), TIMES.asOf, { rateCards: f.rates, resolver });
  const history = subscriptionCapacityCycles(ctx, "claude", ACCOUNTS.a, COUNTER, range).find(row => row.id === limit.claude_capacity!.window_id)!;
  const equivalents = buildSubscriptionCapacities(f.db, f.rates, new Map(), { fromStored: false, claudeAccounts: [ACCOUNTS.a],
    claudeGauge: gauge, grokGauge: {}, period: range, subscriptions: [ACCOUNTS.a] }).get(ACCOUNTS.a)!;
  return { ctx, limit, history, equivalents };
}

test("real Claude table, capacity/history routes and comparison helpers quote one exact result", async () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const { ctx, limit, history, equivalents } = consumers(f), result = limit.claude_capacity!;
    expect(history.claude_capacity).toEqual(result);
    expect(equivalents.claude_capacity).toEqual(result);
    expect(result.sample).toMatchObject({ from: TIMES.first, through: TIMES.asOf, start_inclusive: false, end_inclusive: true, observed_pp: 14 });
    expect(result.models.reduce((sum, row) => sum + row.window.gross, 0)).toBe(111_000);
    expect(result.models.reduce((sum, row) => sum + row.window.usd, 0)).toBeCloseTo(0.5994, 12);
    expect(capacityPerPoint(history, "tokens")).toBe(result.capacity_tokens.value! / 100);
    expect(capacityFull(history, "api_standard")).toBe(result.capacity_api_usd.value);
    expect(capacityMeasurement(history)).toMatchObject({ start: TIMES.first, end: TIMES.asOf, observed_pp: 14 });
    expect(compareCapacity(history, structuredClone(history)).change("api_standard")).toBeNull();
    prepareClaudeCardMetadataFixture(f.db, Object.values(ACCOUNTS));
    let pending = true;
    for (let turn = 0; pending && turn < 100; turn++) {
      const step = advanceCapacityCycleResults(ctx, { budgetMs: 10_000 });
      if (!step) throw new Error("Fixture capacity-cycle schema is missing");
      pending = step.pending;
    }
    expect(pending).toBe(false);
    const body = await handleCapacityCycles(ctx, new URL(`http://local/api/capacity-cycles?since=${range.since}&until=${range.until}&window_minutes=10080`)).json() as CapacityCyclesResponse;
    const cycle = body.accounts.find(row => row.account === ACCOUNTS.a)!.windows.find(row => row.id === history.id)!;
    expect(cycle.claude_capacity).toEqual(result);
    const rail = await (await handleWindows(ctx, new URL(`http://local/api/windows?account=${ACCOUNTS.a}`))).json() as WindowsResponse;
    expect(rail.windows.find(row => row.claude_capacity?.window_id === result.window_id)!.claude_capacity).toEqual(result);
    const api = await handleClaudeLimit(ctx, new URL(`http://local/api/claude-limit?account=${ACCOUNTS.a}&from=${TIMES.start}&until=${TIMES.reset}`)).json() as ClaudeLimitResponse;
    expect(api.claude_capacity).toEqual(result);
    const html = renderToStaticMarkup(createElement(ClaudeModelsCard, { data: api }));
    expect(html).toContain("claude-sonnet-fixture");
    expect(html).toContain("API Standard");
    expect(api.models).toEqual(result.models);
    expect(api.models.every(row => row.gross_tokens_per_point !== null)).toBe(true);
  } finally { f.teardown(); }
});

test("share correction and reopen keep all consumers equal without reading or revaluing events", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const before = consumers(f).limit.claude_capacity!, saved = f.db.query("SELECT * FROM window_usage ORDER BY provider,account,counter,window_id").all();
    f.changeShare(15); f.reopen();
    const read = measureAnalysis(f.db, () => consumers(f));
    expect(read.rawOrFactQueries.filter(sql => /usage_ledger_facts|in_uncached|out_total|SUM\(/i.test(sql))).toEqual([]);
    expect(read.value.limit.claude_capacity).toEqual(read.value.history.claude_capacity!);
    expect(read.value.equivalents.claude_capacity).toEqual(read.value.history.claude_capacity!);
    expect(read.value.limit.claude_capacity!.capacity_api_usd.value).not.toBe(before.capacity_api_usd.value);
    expect(read.value.limit.claude_capacity!.models.map(row => row.window)).toEqual(before.models.map(row => row.window));
    expect(f.db.query("SELECT * FROM window_usage ORDER BY provider,account,counter,window_id").all()).toEqual(saved);
  } finally { f.teardown(); }
});

test("a historical correction matches a fresh reference including model results and leaves the other account alone", () => {
  const f = createClaudeCodeAcceptanceFixture(), reference = createClaudeCodeAcceptanceFixture();
  try {
    const foreign = subscriptionCapacityCycles({ sqlite: f.db, rateCards: f.rates, plans: {}, plansCatalog: catalog }, "claude", ACCOUNTS.b, COUNTER, range);
    consumers(f);
    for (const target of [f, reference]) {
      target.db.exec("UPDATE claude_events SET in_uncached=32000,out_total=8000 WHERE call_id='between'");
      target.prepareFacts();
    }
    expect(consumers(f).limit.claude_capacity).toEqual(consumers(reference).limit.claude_capacity!);
    expect(subscriptionCapacityCycles({ sqlite: f.db, rateCards: f.rates, plans: {}, plansCatalog: catalog }, "claude", ACCOUNTS.b, COUNTER, range)).toEqual(foreign);
  } finally { f.teardown(); reference.teardown(); }
});

test("missing-price lower bounds are shared, retain tokens and never become exact model rates", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    f.db.exec("UPDATE claude_events SET model='missing-model' WHERE call_id='between'"); f.prepareFacts();
    const { limit, history, equivalents } = consumers(f), result = limit.claude_capacity!;
    expect(history.claude_capacity).toEqual(result);
    expect(equivalents.claude_capacity).toEqual(result);
    expect(result.capacity_api_usd.relation).toBe("≥");
    expect(result.capacity_tokens.value).not.toBeNull();
    expect(capacityIsLowerBound(history, "api_standard")).toBe(true);
    expect(result.models.find(row => row.model === "missing-model")!.absent).toBe("unpriced");
    expect(result.models.every(row => row.gross_tokens_per_point === null)).toBe(true);
    expect(renderToStaticMarkup(createElement(ClaudeModelsCard, { data: limit }))).toContain("missing-model");
  } finally { f.teardown(); }
});

test("share-less history stops at the first 100% in every consumer, including after reopen", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    f.db.exec(`UPDATE probe_windows SET ts=replace(ts,':01.000Z',':00.000Z'),extra=NULL,used_percent=CASE WHEN ts>='${TIMES.asOf}' THEN 100 ELSE used_percent END WHERE subject='${ACCOUNTS.a}'`);
    f.prepareProbes();
    const before = consumers(f).limit.claude_capacity!;
    f.db.query("INSERT INTO probe_windows(provider,subject,ts,kind,limit_group,scope,used_percent,resets_at,window_minutes,reported_percent_side,machine) VALUES('claude',?,'2026-09-19T00:00:00.000Z','weekly_all','weekly',NULL,100,?,10080,'used','synthetic')").run(ACCOUNTS.a, TIMES.reset);
    f.prepareProbes(); f.reopen();
    const { limit, history, equivalents } = consumers(f);
    expect(limit.claude_capacity).toEqual(before);
    expect(history.claude_capacity).toEqual(before);
    expect(equivalents.claude_capacity).toEqual(before);
    expect(before.basis).toBe("local_meter");
    expect(before.sample!.through).toBe(TIMES.asOf);
  } finally { f.teardown(); }
});

test("a newer invalid share cannot inherit an earlier result or a foreign account", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    f.changeShare(0);
    const { limit, history, equivalents } = consumers(f);
    expect(limit.claude_capacity!.capacity_tokens.value).toBeNull();
    expect(limit.claude_capacity!.reason).toBe("share_zero");
    expect(history.claude_capacity).toEqual(limit.claude_capacity!);
    expect(equivalents.claude_capacity).toEqual(limit.claude_capacity!);
    expect(capacityPerPoint({ ...history, account: ACCOUNTS.b }, "tokens")).toBeNull();
    expect(limit.models.length).toBeGreaterThan(0);
    expect(limit.models.every(row => row.gross_tokens_per_point === null)).toBe(true);
  } finally { f.teardown(); }
});

test("published background capacity retains the contract over restart and does no work on an unchanged turn", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    f.prepareSharedCapacities();
    const native = consumers(f).equivalents;
    const stored = () => buildSubscriptionCapacities(f.db, f.rates, new Map(), { claudeAccounts: [ACCOUNTS.a], subscriptions: [ACCOUNTS.a], period: range }).get(ACCOUNTS.a)!;
    expect(stored().claude_capacity).toEqual(native.claude_capacity!);
    f.reopen();
    expect(stored().claude_capacity).toEqual(native.claude_capacity!);
    // The production producer's stable-input discovery cursor survives restart.
    const changes = () => f.db.query("SELECT total_changes() n").get();
    const before = changes();
    f.prepareSharedCapacities();
    expect(changes()).toEqual(before);
  } finally { f.teardown(); }
});
