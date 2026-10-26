import { afterEach, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { PLAN_PERIODS, replaceDeclaredPeriods, replaceObservedPeriods } from "../db/period-store";
import {
  DAYS_PER_MONTH,
  catalogPlanPrice,
  effectiveMonthlyOf,
  loadPlans,
  planCostOf,
  planLabelOf,
  planPricePeriods,
  capacityRegimesFor,
  replaceCapacityRegimes,
  resolveCapacityRegime,
  validatePlans,
  type PlansConfig,
} from "./plans";
import type { PlansCatalog, PlanVersion } from "./plans-catalog";
import { planPeriodIndex, type DatedPeriod } from "./account-periods";
import { handlePlans, handlePlansSave, type AppContext } from "./api";

const DAY_MS = 86_400_000;
function inclusiveDays(from: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}
function version(from: string | null, monthly: number | null): PlanVersion {
  return { from, usd_per_month: monthly, default_reference: { absent: true, reason: "fixture" } };
}
const catalog: PlansCatalog = {
  provider_groups: [
    {
      id: "openai",
      label: "OpenAI",
      aliases: ["codex", "openai"],
      plans: [
        { plan_id: "codex-plus", label: "Plus", aliases: ["plus"], versions: [version("2023-02-01", 20)] },
        { plan_id: "codex-pro-20x", label: "Pro 20x", aliases: ["pro"], versions: [version("2024-12-05", 200)] },
        { plan_id: "codex-mystery", label: "Mystery", aliases: ["mystery"], versions: [version("2024-01-01", null)] },
      ],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      aliases: ["claude", "anthropic"],
      plans: [
        { plan_id: "claude-pro", label: "Pro", aliases: ["pro"], versions: [version("2023-09-07", 20), version("2025-08-28", 22)] },
      ],
    },
  ],
};
const planPeriod = (subject: string, value: string, from: string, until: string | null,
  origin: DatedPeriod["origin"] = "declared", provider = "codex"): DatedPeriod =>
  ({ provider, subject, value, from, until, origin, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
const index = (...periods: DatedPeriod[]) => planPeriodIndex(periods);
const codex1 = { provider: "codex", subject: "codex1" };

function expectTiling(periods: Array<{ days: number }>, span: { first: string; last: string }) {
  expect(periods.length).toBeGreaterThan(0);
  expect(periods.reduce((sum, period) => sum + period.days, 0)).toBeCloseTo(inclusiveDays(span.first, span.last), 6);
}

describe("planPricePeriods", () => {
  const span = { first: "2026-01-01", last: "2026-06-30" };
  const fallback = { usd_per_month: 200 };
  it("without plan periods produces one rate-card period equal to the old formula", () => {
    const periods = planPricePeriods(null, catalog, codex1, span, fallback);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ source: "rate-card", plan: null, from: span.first, until: span.last });
    expectTiling(periods, span);
    const legacy = Math.round(200 * (inclusiveDays(span.first, span.last) / DAYS_PER_MONTH) * 100) / 100;
    expect(planCostOf(periods)).toBe(legacy);
    expect(effectiveMonthlyOf(periods)).toBeCloseTo(200, 1);
  });
  it("prices each plan period at its catalog version and splits the span at the plan change", () => {
    const periods = planPricePeriods(index(
      planPeriod("codex1", "plus", "2026-01-01", "2026-04-01"),
      planPeriod("codex1", "pro", "2026-04-01", null),
    ), catalog, codex1, span, fallback);
    expect(periods.map((p) => [p.plan, p.usd_per_month, p.source, p.from, p.until, p.days])).toEqual([
      ["plus", 20, "declared", "2026-01-01", "2026-03-31", 90],
      ["pro", 200, "declared", "2026-04-01", "2026-06-30", 91],
    ]);
    expectTiling(periods, span);
    expect(planCostOf(periods)).toBeCloseTo(periods.reduce((a, p) => a + (p.usd ?? 0), 0), 2);
  });
  it("marks an observed plan and lets a declared period outrank it", () => {
    const periods = planPricePeriods(index(
      planPeriod("codex1", "plus", "2026-01-01", null, "observed"),
      planPeriod("codex1", "pro", "2026-03-01", "2026-04-01", "declared"),
    ), catalog, codex1, span, fallback);
    expect(periods.map((p) => [p.plan, p.source])).toEqual([["plus", "observed"], ["pro", "declared"], ["plus", "observed"]]);
    expectTiling(periods, span);
  });
  it("leaves a stretch no plan period covers unknown when the account has plan periods (rule D)", () => {
    const periods = planPricePeriods(index(planPeriod("codex1", "plus", "2026-02-01", "2026-03-01")),
      catalog, codex1, span, fallback);
    expect(periods.map((p) => [p.source, p.usd_per_month])).toEqual([["rate-card", null], ["declared", 20], ["rate-card", null]]);
    expect(periods[1]!.days).toBe(28);
    expectTiling(periods, span);
  });
  it("splits a day at a period edge inside it, so the fractions still sum to the whole span", () => {
    const short = { first: "2026-09-11", last: "2026-09-12" };
    const periods = planPricePeriods(index(planPeriod("codex1", "plus", "2026-09-11T18:00:00.000Z", null, "observed")),
      catalog, codex1, short, fallback);
    expect(periods.map((p) => [p.source, p.from, p.until, p.days])).toEqual([
      ["rate-card", "2026-09-11", "2026-09-11", 0.75],
      ["observed", "2026-09-11", "2026-09-12", 1.25],
    ]);
    expectTiling(periods, short);
  });
  it("changes the price on the catalog version day", () => {
    const periods = planPricePeriods(index(planPeriod("seat", "pro", "2025-08-01", null, "declared", "claude")),
      catalog, { provider: "claude", subject: "seat" }, { first: "2025-08-01", last: "2025-09-15" }, { usd_per_month: null });
    expect(periods.map((p) => [p.from, p.until, p.usd_per_month])).toEqual([
      ["2025-08-01", "2025-08-27", 20],
      ["2025-08-28", "2025-09-15", 22],
    ]);
  });
  it("keeps a plan without a catalog price as a hole rather than as zero or the rate-card price", () => {
    for (const value of ["mystery", "not-in-catalog"]) {
      const periods = planPricePeriods(index(planPeriod("codex1", value, "2026-01-01", null)), catalog, codex1, span, fallback);
      expect(periods).toHaveLength(1);
      expect(periods[0]).toMatchObject({ plan: value, usd: null, usd_per_month: null, source: "declared" });
      expect(planCostOf(periods)).toBeNull();
      expect(effectiveMonthlyOf(periods)).toBeNull();
    }
  });
  it("returns nothing for an inverted or unparseable span", () => {
    expect(planPricePeriods(null, catalog, codex1, { first: "2026-06-30", last: "2026-01-01" }, fallback)).toHaveLength(0);
    expect(planPricePeriods(null, catalog, codex1, { first: "nonsense", last: "2026-01-01" }, fallback)).toHaveLength(0);
  });
});
describe("planCostOf", () => {
  const stretch = (usd_per_month: number | null, days: number) =>
    ({ plan: "x", usd_per_month, from: "2026-01-01", until: "2026-01-01", days, usd: null, source: "declared" as const });
  it("is unknown when any stretch has no price, even beside a free one", () => {
    expect(planCostOf([stretch(0, 10), stretch(null, 5)])).toBeNull();
    expect(planCostOf([stretch(20, 10), stretch(null, 5)])).toBeNull();
    expect(planCostOf([])).toBeNull();
  });
  it("keeps a genuinely free span at 0", () => {
    expect(planCostOf([stretch(0, 10)])).toBe(0);
  });
});
describe("catalogPlanPrice", () => {
  it("reads a plan-period value through the catalog aliases after the shared plan-name normalization", () => {
    expect(catalogPlanPrice(catalog, "claude", "default_claude_ai", "2026-01-01")).toEqual({ plan_id: "claude-pro", label: "Pro", usd_per_month: 22 });
    expect(catalogPlanPrice(catalog, "codex", "pro", "2026-01-01")?.usd_per_month).toBe(200);
    expect(catalogPlanPrice(catalog, "codex", "mystery", "2026-01-01")).toEqual({ plan_id: "codex-mystery", label: "Mystery", usd_per_month: null });
    expect(catalogPlanPrice(catalog, "codex", "unknown", "2026-01-01")).toBeNull();
    expect(catalogPlanPrice(catalog, "claude", "pro", "2020-01-01")?.usd_per_month).toBeNull();
  });
  it("prices the built-in \"none\" at exactly $0 for any provider, even one the catalog does not know", () => {
    for (const provider of ["claude", "codex", "grok", "no-such-provider"]) {
      expect(catalogPlanPrice(catalog, provider, "none", "2026-01-01")).toEqual({ plan_id: "none", label: "No subscription", usd_per_month: 0 });
    }
    // Only the exact value is reserved; another spelling is an ordinary unknown plan.
    expect(catalogPlanPrice(catalog, "codex", "None", "2026-01-01")).toBeNull();
  });
  it("a catalog alias named \"none\" cannot reprice or give limits to the reserved value", () => {
    const shadow: PlansCatalog = { provider_groups: [{ ...catalog.provider_groups[0]!, plans: [
      { plan_id: "codex-shadow", label: "Shadow", aliases: ["none"], versions: [version("2020-01-01", 99)] }] }] };
    expect(catalogPlanPrice(shadow, "codex", "none", "2026-01-01")?.usd_per_month).toBe(0);
  });
});
describe("a declared \"no subscription\" stretch", () => {
  it("closes a gap at $0 so the span's plan cost becomes known", () => {
    const span = { first: "2026-06-01", last: "2026-07-10" };
    const claude = { provider: "claude", subject: "seat" };
    const gap = planPricePeriods(index(
      planPeriod("seat", "pro", "2026-06-01", "2026-06-18", "declared", "claude"),
      planPeriod("seat", "pro", "2026-07-01", null, "declared", "claude"),
    ), catalog, claude, span, { usd_per_month: null });
    expect(planCostOf(gap)).toBeNull();
    const closed = planPricePeriods(index(
      planPeriod("seat", "pro", "2026-06-01", "2026-06-18", "declared", "claude"),
      planPeriod("seat", "none", "2026-06-18", "2026-07-01", "declared", "claude"),
      planPeriod("seat", "pro", "2026-07-01", null, "declared", "claude"),
    ), catalog, claude, span, { usd_per_month: null });
    expect(closed.map((p) => [p.plan, p.from, p.until, p.usd_per_month, p.usd])).toEqual([
      ["pro", "2026-06-01", "2026-06-17", 22, Math.round(22 * 17 / DAYS_PER_MONTH * 100) / 100],
      ["none", "2026-06-18", "2026-06-30", 0, 0],
      ["pro", "2026-07-01", "2026-07-10", 22, Math.round(22 * 10 / DAYS_PER_MONTH * 100) / 100],
    ]);
    expect(planCostOf(closed)).toBe(Math.round(22 * 27 / DAYS_PER_MONTH * 100) / 100);
    expect(planLabelOf(closed)).toBe("pro → none → pro");
  });
});
describe("effectiveMonthlyOf", () => {
  it("returns the plan's exact price for every span length, not a rounded echo of it", () => {
    for (const last of ["2026-01-08", "2026-01-27", "2026-02-14", "2026-03-31", "2026-12-31"]) {
      const periods = planPricePeriods(null, catalog, codex1, { first: "2026-01-01", last }, { usd_per_month: 20 });
      expect(effectiveMonthlyOf(periods)).toBe(20);
    }
  });
  it("weights the price by days, so it lands between the two plans", () => {
    const periods = planPricePeriods(index(
      planPeriod("codex1", "plus", "2026-01-01", "2026-04-01"),
      planPeriod("codex1", "pro", "2026-04-01", null),
    ), catalog, codex1, { first: "2026-01-01", last: "2026-06-30" }, { usd_per_month: 200 });
    const eff = effectiveMonthlyOf(periods)!;
    expect(eff).toBeGreaterThan(20);
    expect(eff).toBeLessThan(200);
    expect(eff).toBeCloseTo(110, -1);
  });
  it("skips priceless periods instead of counting them as free days", () => {
    const periods = planPricePeriods(index(planPeriod("codex1", "pro", "2026-01-01", "2026-02-01")),
      catalog, codex1, { first: "2026-01-01", last: "2026-02-28" }, { usd_per_month: null });
    expect(effectiveMonthlyOf(periods)).toBeCloseTo(200, 1);
  });
});
describe("planLabelOf", () => {
  const span = { first: "2026-01-01", last: "2026-06-30" };
  it("chains the plans in chronological order", () => {
    const periods = planPricePeriods(index(
      planPeriod("codex1", "plus", "2026-01-01", "2026-04-01"),
      planPeriod("codex1", "pro", "2026-04-01", null),
    ), catalog, codex1, span, { usd_per_month: 200 });
    expect(planLabelOf(periods)).toBe("plus → pro");
  });
  it("collapses a repeat but keeps a genuine there-and-back", () => {
    const periods = planPricePeriods(index(
      planPeriod("codex1", "pro", "2026-01-01", "2026-03-01"),
      planPeriod("codex1", "plus", "2026-03-01", "2026-05-01"),
      planPeriod("codex1", "pro", "2026-05-01", null),
    ), catalog, codex1, span, { usd_per_month: 200 });
    expect(planLabelOf(periods)).toBe("pro → plus → pro");
  });
  it("is null when nothing names a plan", () => {
    expect(planLabelOf(planPricePeriods(null, catalog, codex1, span, { usd_per_month: 10 }))).toBeNull();
  });
});
describe("validatePlans", () => {
  it("ignores retired stages, even malformed ones", () => {
    expect(validatePlans({ segments: [{ subscription: "" }, { subscription: "c", from: "01.01.2026", usd_per_month: -5 }] })).toEqual([]);
  });
});
describe("dated capacity regimes", () => {
  const cfg: PlansConfig = {
    segments: [],
    capacity_regimes: [
      {
        id: "summer-2x",
        subscription: "codex1",
        factor: 2,
        from: "2026-06-01",
        until: "2026-06-30",
        source: "promotion",
      },
      {
        id: "spark-3x",
        subscription: "codex1",
        factor: 3,
        from: "2026-06-10",
        until: "2026-06-20",
        window_kind: "spark-weekly",
        source: "vendor",
      },
    ],
  };

  it("uses 1x outside declarations and the most specific matching exception", () => {
    expect(resolveCapacityRegime(cfg, { subscription: "CODEX1", day: "2026-05-31", window_kind: "weekly" }))
      .toMatchObject({ id: null, factor: 1, source: "default" });
    expect(resolveCapacityRegime(cfg, { subscription: "codex1", day: "2026-06-15", window_kind: "weekly" }))
      .toMatchObject({ id: "summer-2x", factor: 2 });
    expect(resolveCapacityRegime(cfg, { subscription: "codex1", day: "2026-06-15", window_kind: "spark-weekly" }))
      .toMatchObject({ id: "spark-3x", factor: 3 });
  });

  it("rejects ambiguous overlaps for one selector", () => {
    const errors = validatePlans({
      segments: [],
      capacity_regimes: [
        { id: "first", subscription: "c", factor: 2, from: "2026-01-01", until: "2026-01-10" },
        { id: "second", subscription: "c", factor: 3, from: "2026-01-10", until: "2026-01-20" },
      ],
    });
    expect(errors.some((error) => error.includes("reżimy pojemności zachodzą"))).toBe(true);
  });

  it("replaces one subscription without touching another", () => {
    const next = replaceCapacityRegimes(cfg, "codex1", [
      { id: "new", subscription: "ignored", factor: 1.5, from: "2026-07-01" },
    ]);
    expect(capacityRegimesFor(next, "codex1").map((regime) => regime.id)).toEqual(["new"]);
    expect(capacityRegimesFor(next, "codex1")[0]!.subscription).toBe("codex1");
  });
});

const opened: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close(true);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function planSettingsContext(
  subscriptions: NonNullable<AppContext["accounts"]["subscriptions"]>,
  rateSubscriptions: Record<string, { usd_per_month: number }>,
  periods: DatedPeriod[] = [],
  plans: PlansConfig = { segments: [], capacity_regimes: [] },
): AppContext {
  const db = new Database(":memory:"); opened.push(db);
  applyDrizzleMigrations(drizzle(db));
  replaceDeclaredPeriods(db, PLAN_PERIODS, periods.filter((period) => period.origin === "declared"));
  for (const period of periods.filter((row) => row.origin === "observed")) {
    replaceObservedPeriods(db, PLAN_PERIODS, period.provider, period.subject, [period]);
  }
  return {
    sqlite: db,
    accounts: { subscriptions },
    rateCards: { subscriptions: rateSubscriptions },
    plans,
    plansCatalog: catalog,
  } as unknown as AppContext;
}
interface PlanSettingsResponse {
  rows: Array<{
    subscription: string;
    vendor: string;
    account: string | null;
    fallback_usd_per_month: number | null;
    plan_on_day: { plan: string | null; plan_id: string | null; basis: string; from: string | null; until: string | null };
  }>;
}
const plansAt = async (ctx: AppContext, asOf?: string) =>
  (await handlePlans(ctx, new URL(`http://local/api/plans${asOf ? `?as_of=${asOf}` : ""}`)).json()) as PlanSettingsResponse;

describe("subscription roster from accounts.json", () => {
  it("uses only distinct declared ids, keeps first spelling, sorts rows, and normalises identity", async () => {
    const ctx = planSettingsContext(
      [
        { id: "Zeta", vendor: "openai", home: "C:/zeta", account: "zeta@example.com" },
        { id: "zeta", vendor: "gemini", home: "C:/zeta-duplicate", account: "other@example.com" },
        { id: "Alpha", vendor: "anthropic", home: "C:/alpha", account: "alpha@example.com" },
      ],
      { "rate-only": { usd_per_month: 99 }, Zeta: { usd_per_month: 20 } },
    );

    const body = await plansAt(ctx);
    expect(body.rows.map((row) => row.subscription)).toEqual(["Alpha", "Zeta"]);
    expect(body.rows.map((row) => ({ vendor: row.vendor, account: row.account }))).toEqual([
      { vendor: "claude", account: "alpha@example.com" },
      { vendor: "codex", account: "zeta@example.com" },
    ]);
  });

  it("keeps an unpriced declaration visible with a null fallback and excludes price-only ids", async () => {
    const ctx = planSettingsContext(
      [{ id: "agy1", vendor: "gemini", home: "H:/archive/gemini/PC-login" }],
      { "rate-only": { usd_per_month: 99 } },
    );

    const body = await plansAt(ctx);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.subscription).toBe("agy1");
    expect(body.rows[0]?.fallback_usd_per_month).toBeNull();
    expect(body.rows[0]?.plan_on_day.basis).toBe("none");
  });
});

describe("plan on the As of day comes from the account periods", () => {
  const accounts = [{ id: "codex1", vendor: "codex", home: "C:/codex1" }];
  const periods = [
    planPeriod("codex1", "plus", "2026-01-01", "2026-03-01"),
    planPeriod("codex1", "pro", "2026-04-01T10:00:00.000Z", null, "observed"),
  ];
  it("names the covering period, its origin and the catalog plan", async () => {
    const ctx = planSettingsContext(accounts, {}, periods);
    expect((await plansAt(ctx, "2026-02-10")).rows[0]!.plan_on_day)
      .toEqual({ plan: "plus", plan_id: "codex-plus", basis: "declared", from: "2026-01-01", until: "2026-03-01" });
    // The plan in force at the end of the day counts, so the day a period starts belongs to it.
    expect((await plansAt(ctx, "2026-04-01")).rows[0]!.plan_on_day)
      .toMatchObject({ plan: "pro", plan_id: "codex-pro-20x", basis: "observed" });
  });
  it("reports the hole around a day between or outside the periods, without a plan", async () => {
    const ctx = planSettingsContext(accounts, {}, periods);
    expect((await plansAt(ctx, "2026-03-15")).rows[0]!.plan_on_day)
      .toEqual({ plan: null, plan_id: null, basis: "gap", from: "2026-03-01", until: "2026-04-01T10:00:00.000Z" });
    expect((await plansAt(ctx, "2025-12-01")).rows[0]!.plan_on_day)
      .toEqual({ plan: null, plan_id: null, basis: "uncovered", from: null, until: "2026-01-01" });
  });
  it("rejects a malformed day", async () => {
    const ctx = planSettingsContext(accounts, {}, periods);
    for (const day of ["15.03.2026", "2026-13-45"]) {
      expect(handlePlans(ctx, new URL(`http://local/api/plans?as_of=${day}`)).status).toBe(400);
    }
  });
});

describe("retired plans.json stages", () => {
  const stages = [{ subscription: "codex1", plan: "plus", usd_per_month: 20, from: "2026-01-01" }];
  it("an old file with stages still loads and is not rewritten on read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenatlas-plans-")); dirs.push(dir);
    const file = path.join(dir, "plans.json");
    const original = JSON.stringify({ segments: stages }, null, 2) + "\n";
    fs.writeFileSync(file, original, "utf-8");
    const before = fs.statSync(file);
    const loaded = loadPlans(dir);
    expect(loaded.segments).toEqual(stages);
    expect(loaded.capacity_regimes).toEqual([]);
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  });
  it("a capacity-period save writes the stored stages back unchanged", async () => {
    const ctx = planSettingsContext([{ id: "codex1", vendor: "codex", home: "C:/codex1" }], {}, [],
      { segments: stages, capacity_regimes: [] });
    let persisted: PlansConfig | null = null;
    const response = await handlePlansSave(ctx, new Request("http://local/api/plans", { method: "POST",
      body: JSON.stringify({ subscription: "codex1", capacity_regimes: [{ id: "promo", factor: 2, from: "2026-06-01", until: "2026-06-30" }] }) }),
    (next) => { persisted = next; });
    expect(response.status).toBe(200);
    expect(persisted!.segments).toEqual(stages);
    expect(capacityRegimesFor(persisted!, "codex1").map((regime) => regime.id)).toEqual(["promo"]);
  });
  it("refuses to save stages", async () => {
    const ctx = planSettingsContext([{ id: "codex1", vendor: "codex", home: "C:/codex1" }], {});
    for (const body of [{ subscription: "codex1", segments: stages }, { subscription: "codex1", clear: true }]) {
      let saved = false;
      const response = await handlePlansSave(ctx, new Request("http://local/api/plans", { method: "POST", body: JSON.stringify(body) }),
        () => { saved = true; });
      expect(response.status).toBe(400);
      expect(saved).toBe(false);
    }
  });
});
