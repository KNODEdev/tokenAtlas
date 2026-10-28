import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "../db/sqlite";
import { createCodexLedgerSchema } from "../db/codex-price-ledger";
import { enqueueCodexLedgerRuleChanges } from "../db/codex-ledger-producer";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { installAnalysisTracking } from "../db/analysis";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { createAnalysisSourceRevisions } from "../db/analysis-source-revisions.fixture";
import { fillCodexLedgerFixture } from "./codex-ledger.fixture";
import { buildProjectCost } from "./project-cost";
import { buildRepoHistory } from "./repo-history";
import { buildPlanPriceCoverage, planPriceGaps } from "./plan-price-coverage";
import type { CodexLedgerPolicy } from "./codex-ledger-policy";
import type { PlansCatalog } from "./plans-catalog";
import type { RateCard } from "./pricing";
import type { DatedPeriod } from "./account-periods";

const evidence = { verified_at: "2026-01-01", sources: ["https://example.test/prices"], confidence: "official" as const };
function policy(): CodexLedgerPolicy {
  return { version: 1, tiers: ["standard", "fast"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
    base_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).map((billing_basis) => ({ id: billing_basis, model: "model",
      billing_basis, valid_from: "2026-01-01", multiplier: "1", rates: { in_uncached: "1", in_cache_read: "0.1", out_total: "5" }, ...evidence })),
    tier_rules: (["api_equivalent_usd", "chatgpt_credits"] as const).flatMap((billing_basis) => ["standard", "fast"].map((tier) => ({
      id: `${billing_basis}-${tier}`, model: "model", billing_basis, tier, valid_from: "2026-01-01", multiplier: tier === "fast" ? "2" : "1", ...evidence }))) };
}
const catalog: PlansCatalog = { provider_groups: [{ id: "openai", label: "OpenAI", aliases: ["codex", "openai"], plans: [
  { plan_id: "codex-plus", label: "Plus", aliases: ["plus"], versions: [{ from: "2023-02-01", usd_per_month: 20, default_reference: { absent: true, reason: "fixture" } }] },
  { plan_id: "codex-mystery", label: "Mystery", aliases: ["mystery"], versions: [{ from: "2024-01-01", usd_per_month: null, default_reference: { absent: true, reason: "fixture" } }] },
] }] };
const planPeriod = (value: string, from: string, until: string | null): DatedPeriod => ({ provider: "codex", subject: "accounta", value, from, until,
  origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });

/**
 * One Codex account (`accounta`, signed in at `codex/main` from 2026-01-01) with traffic on 1, 10 and 25 April and a
 * business-credits call on 20 April, which the reports bill to the `accounta::business` pool.
 */
function fixture(run: (db: Database, card: RateCard) => void) {
  const db = new Database(":memory:"), card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {}, codex_ledger_policy: policy() };
  try {
    db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,
      speed TEXT,service_tier TEXT,in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,
      project_id TEXT,repo TEXT,repo_group TEXT,gap_seconds REAL,billing_mode TEXT);
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
    const insert = db.query("INSERT INTO events VALUES(?,'/archive',?,?,?,'model','standard','default',1000000,0,0,0,0,'a','repo-a','test',0,?)");
    const calls: Array<[string, string | null]> = [["2026-04-01T12:00:00Z", null], ["2026-04-10T12:00:00Z", null],
      ["2026-04-20T12:00:00Z", "business_credits"], ["2026-04-25T12:00:00Z", null]];
    calls.forEach(([ts, mode], index) => insert.run(index + 1, `/archive/${index}.jsonl`, index + 1, ts, mode));
    db.exec(readFileSync(new URL("../../drizzle/0040_account_periods.sql", import.meta.url), "utf8"));
    db.query("INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex','codex/main','accounta','2026-01-01T00:00:00Z','declared','fixture')").run();
    createCodexLedgerSchema(db);
    const context = codexLedgerReadContext(card);
    fillCodexLedgerFixture(db, { bands: context.policy.baseBands, policy: context.policy.policy,
      rulesRevision: context.rulesRevision!, factsRevision: 0, sourceOf: () => "codex/main" });
    enqueueCodexLedgerRuleChanges(db, { bands: context.policy.baseBands, policy: context.policy.policy, rulesRevision: context.rulesRevision! });
    db.exec("DELETE FROM usage_ledger_dirty WHERE provider='codex' AND kind IN ('copy','blocked','rules')");
    createAnalysisSourceRevisions(db); installAnalysisTracking(db);
    run(db, card);
  } finally { db.close(); }
}
const coverage = (db: Database, card: RateCard) => buildPlanPriceCoverage(db, card, { plansCatalog: catalog });
const subject = (db: Database, card: RateCard, id: string) => coverage(db, card).subjects.find((row) => row.id === id)!;
/** The coverage must say exactly what the project report prices: same subscriptions, spans, stretches and cost. */
function expectSameAsProjectCost(db: Database, card: RateCard) {
  const report = buildProjectCost(db, card, new Map(), { plansCatalog: catalog });
  const read = coverage(db, card);
  expect(read.subjects.map((row) => row.id).sort()).toEqual(report.subscriptions.map((row) => row.id).sort());
  for (const sub of report.subscriptions) {
    const row = read.subjects.find((item) => item.id === sub.id)!;
    expect([row.provider, row.first, row.last, row.usd]).toEqual([sub.vendor, sub.first_day, sub.last_day, sub.paid_usd]);
    expect(row.pieces).toEqual(sub.plan_periods);
    expect(sub.price_gaps).toEqual(row.gaps);
  }
}

test("a stretch of traffic with no plan period and no rate-card price is a gap that leaves the plan cost unknown", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("plus", "2026-04-05T00:00:00.000Z", "2026-04-15T00:00:00.000Z")]);
  const row = subject(db, card, "accounta");
  expect([row.first, row.last, row.usd, row.account, row.provider]).toEqual(["2026-04-01", "2026-04-25", null, "accounta", "codex"]);
  expect(row.pieces.map((piece) => [piece.from, piece.until, piece.plan, piece.usd_per_month, piece.source])).toEqual([
    ["2026-04-01", "2026-04-04", null, null, "rate-card"],
    ["2026-04-05", "2026-04-14", "plus", 20, "declared"],
    ["2026-04-15", "2026-04-25", null, null, "rate-card"],
  ]);
  expect(row.gaps).toEqual([
    { from: "2026-04-01", until: "2026-04-04", days: 4, from_ts: "2026-04-01T00:00:00.000Z", until_ts: "2026-04-05T00:00:00.000Z", plans: [] },
    { from: "2026-04-15", until: "2026-04-25", days: 11, from_ts: "2026-04-15T00:00:00.000Z", until_ts: "2026-04-26T00:00:00.000Z", plans: [] },
  ]);
  expectSameAsProjectCost(db, card);
  const report = buildProjectCost(db, card, new Map(), { plansCatalog: catalog });
  expect(report.subjects[0]!.subscriptions.accounta!.billing_unavailable_reasons).toEqual(["plan_history_gap"]);
}));

test("an account whose plan periods cover its whole span is fully priced", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("plus", "2026-03-01T00:00:00.000Z", null)]);
  const row = subject(db, card, "accounta");
  expect(row.gaps).toEqual([]);
  expect(row.pieces.map((piece) => [piece.plan, piece.source, piece.days])).toEqual([["plus", "declared", 25]]);
  expect(row.usd).toBe(Math.round(20 * 25 / 30.44 * 100) / 100);
  expectSameAsProjectCost(db, card);
}));

/** The project history bills the account's only project (`a`, every call) with the same plan cost, or leaves it unknown. */
function historyRead(db: Database, card: RateCard) {
  return buildRepoHistory(db, { repo: null, projectId: "a", granularity: "day", by: "none", idleGapMinutes: 15,
    rateCards: card, homeToSubId: new Map(), plansCatalog: catalog });
}
function historyBilled(db: Database, card: RateCard): number | null {
  return historyRead(db, card).totals.by_sub.accounta?.billed_usd ?? null;
}

test("rule D: an account with plan periods leaves its breaks unknown, never at the rate-card price", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("plus", "2026-04-05T00:00:00.000Z", "2026-04-15T00:00:00.000Z")]);
  card.subscriptions = { accounta: { usd_per_month: 200 } };
  const row = subject(db, card, "accounta");
  expect(row.pieces.map((piece) => [piece.source, piece.usd_per_month])).toEqual([["rate-card", null], ["declared", 20], ["rate-card", null]]);
  expect(row.gaps.map((gap) => [gap.from, gap.until, gap.plans])).toEqual([["2026-04-01", "2026-04-04", []], ["2026-04-15", "2026-04-25", []]]);
  expect(row.usd).toBeNull();
  expectSameAsProjectCost(db, card);
  // The unknown full fee does not erase the ten known days from the project's subtotal.
  expect(historyBilled(db, card)).toBe(Math.round(20 * 10 / 30.44 * 100) / 100);
  expect(historyRead(db, card).totals.billed_complete).toBe(false);
}));

test("rule D: an account with no plan period at all keeps the rate-card price", () => fixture((db, card) => {
  card.subscriptions = { accounta: { usd_per_month: 200 } };
  const row = subject(db, card, "accounta");
  expect(row.gaps).toEqual([]);
  expect(row.pieces.map((piece) => [piece.source, piece.usd_per_month, piece.days])).toEqual([["rate-card", 200, 25]]);
  expect(row.usd).toBe(Math.round(200 * 25 / 30.44 * 100) / 100);
  expectSameAsProjectCost(db, card);
  expect(historyBilled(db, card)).toBe(row.usd);
}));

test("a declared \"no subscription\" break costs $0 under rule D, even with a rate-card price", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [
    planPeriod("none", "2026-03-01T00:00:00.000Z", "2026-04-05T00:00:00.000Z"),
    planPeriod("plus", "2026-04-05T00:00:00.000Z", "2026-04-15T00:00:00.000Z"),
    planPeriod("none", "2026-04-15T00:00:00.000Z", null),
  ]);
  card.subscriptions = { accounta: { usd_per_month: 200 } };
  const row = subject(db, card, "accounta");
  expect(row.gaps).toEqual([]);
  expect(row.pieces.map((piece) => [piece.plan, piece.usd_per_month])).toEqual([["none", 0], ["plus", 20], ["none", 0]]);
  expect(row.usd).toBe(Math.round(20 * 10 / 30.44 * 100) / 100);
  expectSameAsProjectCost(db, card);
  expect(historyBilled(db, card)).toBe(row.usd);
}));

test("fix E: the first day before the first period is not billed when it holds no call", () => fixture((db, card) => {
  // The first call (1 April 12:00) opens the first period; the span still starts at 00:00 of that day.
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("plus", "2026-04-01T12:00:00.000Z", null)]);
  card.subscriptions = { accounta: { usd_per_month: 200 } };
  const row = subject(db, card, "accounta");
  expect(row.gaps).toEqual([]);
  expect(row.pieces.map((piece) => [piece.from, piece.until, piece.plan, piece.days])).toEqual([["2026-04-01", "2026-04-25", "plus", 24.5]]);
  expect(row.usd).toBe(Math.round(20 * 24.5 / 30.44 * 100) / 100);
  expectSameAsProjectCost(db, card);
  expect(historyBilled(db, card)).toBe(row.usd);
}));

test("fix E: a call earlier that day than the first period still leaves a gap, from that call", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("plus", "2026-04-01T18:00:00.000Z", null)]);
  const row = subject(db, card, "accounta");
  expect(row.usd).toBeNull();
  expect(row.gaps).toEqual([{ from: "2026-04-01", until: "2026-04-01", days: 0.25,
    from_ts: "2026-04-01T12:00:00.000Z", until_ts: "2026-04-01T18:00:00.000Z", plans: [] }]);
  expectSameAsProjectCost(db, card);
  expect(historyBilled(db, card)).toBe(Math.round(20 * 24.25 / 30.44 * 100) / 100);
  expect(historyRead(db, card).totals.billed_complete).toBe(false);
}));

test("fix E leaves a first period that starts on a later day alone: the days before it stay a gap", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("plus", "2026-04-05T00:00:00.000Z", null)]);
  const row = subject(db, card, "accounta");
  expect(row.gaps.map((gap) => [gap.from_ts, gap.until_ts])).toEqual([["2026-04-01T00:00:00.000Z", "2026-04-05T00:00:00.000Z"]]);
  expectSameAsProjectCost(db, card);
}));

test("a plan the catalog does not price is a gap that names the plan, never the rate-card price", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("mystery", "2026-03-01T00:00:00.000Z", null)]);
  card.subscriptions = { accounta: { usd_per_month: 200 } };
  const row = subject(db, card, "accounta");
  expect(row.usd).toBeNull();
  expect(row.gaps.map((gap) => [gap.from, gap.until, gap.plans])).toEqual([["2026-04-01", "2026-04-25", ["mystery"]]]);
  expectSameAsProjectCost(db, card);
  const report = buildProjectCost(db, card, new Map(), { plansCatalog: catalog });
  expect(report.subjects[0]!.subscriptions.accounta!.billing_unavailable_reasons).toEqual(["plan_price_missing"]);
}));

test("Free costs zero in coverage, project allocation and history even without a paid-offer catalog entry", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("free", "2026-03-01T00:00:00.000Z", null)]);
  const row = subject(db, card, "accounta");
  expect(row.usd).toBe(0);
  expect(row.gaps).toEqual([]);
  expectSameAsProjectCost(db, card);
  const report = buildProjectCost(db, card, new Map(), { plansCatalog: catalog });
  expect(report.subjects[0]!.subscriptions.accounta).toMatchObject({ billed_usd: 0, billing_unavailable_reasons: [] });
  expect(historyBilled(db, card)).toBe(0);
}));

test("a declared \"no subscription\" stretch costs $0, closes the gap and makes the plan cost known", () => fixture((db, card) => {
  // The catalog has no "none" plan: the value is built in, for every provider.
  replaceDeclaredPeriods(db, PLAN_PERIODS, [
    planPeriod("plus", "2026-04-05T00:00:00.000Z", "2026-04-15T00:00:00.000Z"),
    planPeriod("none", "2026-03-01T00:00:00.000Z", "2026-04-05T00:00:00.000Z"),
    planPeriod("none", "2026-04-15T00:00:00.000Z", null),
  ]);
  const row = subject(db, card, "accounta");
  expect(row.gaps).toEqual([]);
  expect(row.pieces.map((piece) => [piece.from, piece.until, piece.plan, piece.usd_per_month, piece.usd, piece.source])).toEqual([
    ["2026-04-01", "2026-04-04", "none", 0, 0, "declared"],
    ["2026-04-05", "2026-04-14", "plus", 20, Math.round(20 * 10 / 30.44 * 100) / 100, "declared"],
    ["2026-04-15", "2026-04-25", "none", 0, 0, "declared"],
  ]);
  expect(row.usd).toBe(Math.round(20 * 10 / 30.44 * 100) / 100);
  expectSameAsProjectCost(db, card);
  const report = buildProjectCost(db, card, new Map(), { plansCatalog: catalog });
  expect(report.subscriptions.find((sub) => sub.id === "accounta")?.plan).toBe("none → plus → none");
}));

test("a business credits pool is a usage-based subject with no flat monthly price", () => fixture((db, card) => {
  replaceDeclaredPeriods(db, PLAN_PERIODS, [planPeriod("plus", "2026-03-01T00:00:00.000Z", null)]);
  const pool = subject(db, card, "accounta::business");
  expect(pool).toMatchObject({ account: "accounta", provider: "codex", usage_based: true, first: "2026-04-20", last: "2026-04-20", usd: null });
  // The account's plan is not the pool's: plan periods name accounts, not their billing variants.
  expect(pool.pieces.map((piece) => [piece.plan, piece.source, piece.usd_per_month])).toEqual([[null, "rate-card", null]]);
  expect(subject(db, card, "accounta").usage_based).toBeUndefined();
  expectSameAsProjectCost(db, card);
}));

test("gaps merge consecutive unpriced stretches and keep exact instants", () => {
  const at = (iso: string) => Date.parse(iso);
  expect(planPriceGaps([
    { fromMs: at("2026-09-08T00:00:00Z"), untilMs: at("2026-09-08T12:00:00Z"), plan: null, monthly: null, source: "rate-card" },
    { fromMs: at("2026-09-08T12:00:00Z"), untilMs: at("2026-09-09T15:00:00Z"), plan: "mystery", monthly: null, source: "observed" },
    { fromMs: at("2026-09-09T15:00:00Z"), untilMs: at("2026-09-20T00:00:00Z"), plan: "pro", monthly: 200, source: "observed" },
  ])).toEqual([{ from: "2026-09-08", until: "2026-09-09", days: 1.625,
    from_ts: "2026-09-08T00:00:00.000Z", until_ts: "2026-09-09T15:00:00.000Z", plans: ["mystery"] }]);
});
