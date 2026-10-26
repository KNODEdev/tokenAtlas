import { afterEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import type { StoredCyclePrice } from "../db/billing-cycles";
import { planPeriodIndex, type IndexedPeriod } from "./account-periods";
import { advanceBillingCycles, computeBillingCyclesFull, resetBillingCycleClock, type StoredCycleRow } from "./billing-cycle-producer";
import { advanceFxRates, resetFxRatesState, settleFxRates } from "./fx-rates";
import { cyclePriceIndex, planCostOf, planPriceStretches, resolvedPlanPeriod, type CyclePriceIndex } from "./plans";
import { planPriceGaps } from "./plan-price-coverage";
import { planPricingInputs } from "./project-cost";
import { CATALOG } from "./billing-cycles.fixture";

// Plan costs priced from stored billing cycles (docs/plan-price-from-cycles-2026-10-18.md).
const NOW = Date.parse("2026-10-18T12:00:00Z");
afterEach(() => resetFxRatesState());

const account = { provider: "codex", subject: "codex1" };
const declared = planPeriodIndex<IndexedPeriod>([{ provider: "codex", subject: "codex1", from: "2026-09-16", until: null, value: "pro",
  origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "invoice" }]);
const cycle = (start: string, end: string, usd: number | null | undefined, extra: Partial<StoredCyclePrice> = {}): StoredCyclePrice => ({
  provider: "codex", account: "codex1", start_ts: `${start}T00:00:00.000Z`, end_ts: `${end}T00:00:00.000Z`, plan: "pro", basis: "declared",
  price_source: "declared", amount_minor: 81300, currency: "PLN", usd,
  fx: JSON.stringify({ currency: "PLN", day: start, rate: 1, usd_rate: usd === null ? null : 3.7, effective_day: usd === null ? null : start, table: null }), ...extra });
const cost = (cycles: CyclePriceIndex | null, first: string, last: string) =>
  planCostOf(planPriceStretches(declared, CATALOG, account, { first, last }, { usd_per_month: null }, cycles).map(resolvedPlanPeriod));

test("a whole cycle costs what was paid; part of a cycle its share of the cycle's time; outside cycles the catalog stays", () => {
  const cycles = cyclePriceIndex([cycle("2026-09-16", "2026-10-16", 222.67), cycle("2026-10-16", "2026-11-16", 219.73, { price_source: "repeated" })]);
  // 30 days of September's cycle: exactly the payment, not $200 × 30 / 30.44.
  expect(cost(cycles, "2026-09-16", "2026-10-15")).toBe(222.67);
  expect(cost(null, "2026-09-16", "2026-10-15")).toBe(197.11);
  // 16 of the 31 days of the repeated cycle.
  expect(cost(cycles, "2026-10-16", "2026-10-31")).toBe(Math.round(219.73 * 16 / 31 * 100) / 100);
  // Splitting a span never moves the total.
  expect(cost(cycles, "2026-09-16", "2026-10-31")).toBe(Math.round((222.67 + 219.73 * 16 / 31) * 100) / 100);
  // The stretches carry the cycle as their source; another account's cycles and a different case do not matter.
  const pieces = planPriceStretches(declared, CATALOG, account, { first: "2026-09-16", last: "2026-10-31" }, { usd_per_month: null }, cycles).map(resolvedPlanPeriod);
  expect(pieces.map((p) => [p.from, p.until, p.source, p.cycle?.source, p.cycle?.amount, p.cycle?.currency, p.cycle?.usd])).toEqual([
    ["2026-09-16", "2026-10-15", "declared", "declared", 813, "PLN", 222.67],
    ["2026-10-16", "2026-10-31", "declared", "repeated", 813, "PLN", 219.73]]);
  const other = cyclePriceIndex([cycle("2026-09-16", "2026-10-16", 999, { account: "codex2" }), cycle("2026-09-16", "2026-10-16", 222.67, { provider: "CODEX", account: "Codex1" })]);
  expect(cost(other, "2026-09-16", "2026-10-15")).toBe(222.67);
  // Days before the first cycle keep the catalog price.
  const later = cyclePriceIndex([cycle("2026-10-01", "2026-11-01", 210)]);
  expect(cost(later, "2026-09-16", "2026-10-31")).toBe(Math.round((200 * 15 / 30.44 + 210) * 100) / 100);
});

test("a payment without a stored rate is unknown, never 0 nor the catalog, and its gap waits for the rate", () => {
  const cycles = cyclePriceIndex([cycle("2026-09-16", "2026-10-16", null)]);
  expect(cost(cycles, "2026-09-16", "2026-10-15")).toBeNull();
  const stretches = planPriceStretches(declared, CATALOG, account, { first: "2026-09-16", last: "2026-10-15" }, { usd_per_month: null }, cycles);
  expect(planPriceGaps(stretches)).toEqual([{ from: "2026-09-16", until: "2026-10-15", days: 30, from_ts: "2026-09-16T00:00:00.000Z",
    until_ts: "2026-10-16T00:00:00.000Z", plans: [], rate_pending: true }]);
  // A cycle the catalog does not price (no payment, no rate to wait for) stays an ordinary gap naming its plan.
  const unpriced = cyclePriceIndex([cycle("2026-09-16", "2026-10-16", null, { amount_minor: null, currency: null, fx: null, price_source: "catalog", plan: "enterprise" })]);
  const gap = planPriceGaps(planPriceStretches(declared, CATALOG, account, { first: "2026-09-16", last: "2026-10-15" }, { usd_per_month: null }, unpriced))[0];
  expect(gap).toMatchObject({ plans: ["pro"] });
  expect(gap).not.toHaveProperty("rate_pending");
});

test("cycle edges inside a day (an observed run anchored to a window start) cut the day exactly", () => {
  const at = (value: string) => ({ start_ts: value });
  const cycles = cyclePriceIndex([{ ...cycle("2026-09-16", "2026-10-16", 300), ...at("2026-09-16T12:00:00.000Z"), end_ts: "2026-10-16T12:00:00.000Z" }]);
  // The first half day has no cycle (catalog), then 29.5 of the cycle's 30 days.
  expect(cost(cycles, "2026-09-16", "2026-10-15")).toBe(Math.round((200 * 0.5 / 30.44 + 300 * 29.5 / 30) * 100) / 100);
});

test("a row stored before rules 13 (no USD equivalent yet) keeps the catalog price until the producer stores it again", () => {
  expect(cost(cyclePriceIndex([cycle("2026-09-16", "2026-10-16", undefined)]), "2026-09-16", "2026-10-15")).toBe(197.11);
});

/** codex1 pays 813 PLN a month from 16.09 (repeated on 16.10). */
function database(): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  replaceDeclaredPeriods(db, PLAN_PERIODS, [{ provider: "codex", subject: "codex1", from: "2026-09-16", until: null, value: "pro", origin: "declared",
    firstSeen: null, lastSeen: null, readings: 0, evidence: "invoice", amountMinor: 81300, currency: "PLN" }]);
  return db;
}
const nbp = async (url: string) => {
  const tables = [{ no: "179/A/NBP/2026", effectiveDate: "2026-09-15", mid: 3.6512 }, { no: "200/A/NBP/2026", effectiveDate: "2026-10-15", mid: 3.7 }];
  const [, from, until] = url.match(/rates\/a\/usd\/([\d-]+)\/([\d-]+)/)!;
  const rates = tables.filter((t) => t.effectiveDate >= from! && t.effectiveDate <= until!);
  return { ok: true, status: 200, json: async () => ({ rates }) };
};
/** The full reference's rows as the read path takes them from the table. */
const asStored = (rows: StoredCycleRow[]): StoredCyclePrice[] => rows.map((row) => {
  const detail = JSON.parse(row.detail);
  return { provider: row.provider, account: row.account, start_ts: row.start_ts, end_ts: row.end_ts, plan: row.plan, basis: row.basis,
    price_source: row.price_source, amount_minor: row.amount_minor, currency: row.currency, usd: detail.price_usd,
    fx: detail.fx == null ? null : JSON.stringify(detail.fx) };
});
const span = { first: "2026-09-16", last: "2026-10-18" };
const priced = (db: Database, cycles?: CyclePriceIndex) => {
  const inputs = planPricingInputs(db, CATALOG);
  const stretches = planPriceStretches(inputs.planIndex, CATALOG, account, span, { usd_per_month: null }, cycles ?? inputs.cycles);
  return { paid: planCostOf(stretches.map(resolvedPlanPeriod)), gaps: planPriceGaps(stretches) };
};

test("stored cycles price the bill: a rate arriving updates only it, incremental equals the full reference, a restart changes nothing", async () => {
  const db = database();
  resetBillingCycleClock();
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  // Both payments wait for their rates: unknown, with a pending-rate gap rather than a plan gap.
  expect(priced(db)).toMatchObject({ paid: null, gaps: [{ from: "2026-09-16", until: "2026-10-18", rate_pending: true, plans: [] }] });

  advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp });
  await settleFxRates();
  advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp });
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  // 813 PLN at 3.6512 for the whole September cycle, and 3 of the 31 days of the repeated one at 3.7.
  const expected = Math.round((813 / 3.6512 + 813 / 3.7 * (3 / 31)) * 100) / 100;
  const after = priced(db);
  expect(after).toEqual({ paid: expected, gaps: [] });
  expect(priced(db, cyclePriceIndex(asStored(computeBillingCyclesFull(db, { catalog: CATALOG, now: NOW }))))).toEqual(after);

  // Restart: the producer finds nothing to change and reading the bill writes nothing.
  resetFxRatesState();
  resetBillingCycleClock();
  advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp });
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  const changes = (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
  expect(priced(db)).toEqual(after);
  expect((db.query("SELECT total_changes() AS n").get() as { n: number }).n).toBe(changes);
});
