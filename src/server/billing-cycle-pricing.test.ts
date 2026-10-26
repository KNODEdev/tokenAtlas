import { expect, test } from "bun:test";
import { planPeriodIndex, type DatedPeriod, type IndexedPeriod } from "./account-periods";
import { planCostOf, planPriceStretches, resolvedPlanPeriod } from "./plans";
import { planPriceGaps } from "./plan-price-coverage";
import { planPricingInputs } from "./project-cost";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { CATALOG, database } from "./billing-cycles.fixture";

const period = (value: string, from: string, until: string | null, origin: IndexedPeriod["origin"]): IndexedPeriod => ({
  provider: "codex", subject: "codex1", from, until, value, origin, firstSeen: null, lastSeen: null, readings: 0, evidence: "test" });
const account = { provider: "codex", subject: "codex1" };
const span = { first: "2026-08-01", last: "2026-10-31" };
const brief = (index: ReturnType<typeof planPeriodIndex<IndexedPeriod>>) => planPriceStretches(index, CATALOG, account, span, { usd_per_month: null })
  .map((s) => [new Date(s.fromMs).toISOString().slice(0, 10), new Date(s.untilMs).toISOString().slice(0, 10), s.plan, s.source, s.monthly]);

test("an inferred cycle prices the days after a declared end; declared and observed rows still win where they exist", () => {
  const index = planPeriodIndex<IndexedPeriod>([
    period("pro", "2026-08-01", "2026-09-01", "declared"),
    period("pro", "2026-09-01", "2026-10-01", "inferred"),
    period("plus", "2026-09-15", "2026-09-20", "observed"),
    period("plus", "2026-09-18", "2026-09-19", "declared"),
  ]);
  expect(brief(index)).toEqual([
    ["2026-08-01", "2026-09-01", "pro", "declared", 200],
    ["2026-09-01", "2026-09-15", "pro", "inferred", 200],
    ["2026-09-15", "2026-09-18", "plus", "observed", 20],
    ["2026-09-18", "2026-09-19", "plus", "declared", 20],
    // The declared end of "plus" closes the observed run of the same plan (22.09 rule): the inferred cycle resumes.
    ["2026-09-19", "2026-10-01", "pro", "inferred", 200],
    // After the last inferred cycle there is no plan and no rate-card price: unknown, never 0.
    ["2026-10-01", "2026-11-01", null, "rate-card", null],
  ]);
});

test("unknown is never 0: an inferred plan the catalog does not price leaves the cost unknown and stays a gap", () => {
  const index = planPeriodIndex<IndexedPeriod>([period("pro", "2026-08-01", "2026-09-01", "declared"), period("enterprise", "2026-09-01", "2026-11-01", "inferred")]);
  const stretches = planPriceStretches(index, CATALOG, account, span, { usd_per_month: null });
  expect(planCostOf(stretches.map(resolvedPlanPeriod))).toBeNull();
  expect(planPriceGaps(stretches).map((gap) => [gap.from_ts.slice(0, 10), gap.until_ts.slice(0, 10), gap.plans])).toEqual([["2026-09-01", "2026-11-01", ["enterprise"]]]);
  // Priced inferred cycles close the gap: the whole span has a cost.
  const priced = planPriceStretches(planPeriodIndex<IndexedPeriod>([period("pro", "2026-08-01", "2026-09-01", "declared"),
    period("pro", "2026-09-01", "2026-11-01", "inferred")]), CATALOG, account, span, { usd_per_month: null });
  expect(planPriceGaps(priced)).toEqual([]);
  expect(planCostOf(priced.map(resolvedPlanPeriod))).not.toBeNull();
});

test("the project report and the plan price coverage read the stored inferred cycles through one index", () => {
  const db = database();
  const declared: DatedPeriod = { provider: "codex", subject: "codex1", from: "2026-08-01", until: "2026-09-01", value: "pro", origin: "declared",
    firstSeen: null, lastSeen: null, readings: 0, evidence: "payment" };
  replaceDeclaredPeriods(db, PLAN_PERIODS, [declared]);
  db.query(`INSERT INTO billing_cycles(provider,account,start_ts,end_ts,plan,basis,anchor_uncertain,cycle_months,amount_minor,currency,price_source,
    catalog_usd,counter,windows_share,idle_share,windows_touched,observed_share,used_pp,api_usd,capacity_usd,is_current,flags,detail,inputs_rev,computed_at)
    VALUES('codex','codex1','2026-09-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','pro','inferred',0,1,20000,'USD','inferred',200,NULL,0,0,0,NULL,NULL,NULL,NULL,0,'[]','{}','x','2026-10-08T00:00:00.000Z')`).run();
  const inputs = planPricingInputs(db, CATALOG);
  expect(inputs.planIndex!.resolve("codex", "codex1", "2026-09-10T00:00:00.000Z")).toMatchObject({ value: "pro", basis: "inferred" });
  expect(inputs.planIndex!.resolve("codex", "codex1", "2026-08-10T00:00:00.000Z")).toMatchObject({ value: "pro", basis: "declared" });
  expect(inputs.planIndex!.resolve("codex", "codex1", "2026-10-10T00:00:00.000Z").value).toBeNull();
});
