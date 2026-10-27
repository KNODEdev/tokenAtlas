import { expect, test } from "bun:test";
import { allocatePlanPeriods, readPlanPeriodUsage, readPlanPeriodsUsage, type PlanPeriodUsage } from "./project-cost-periods";
import type { PlanPriceStretch } from "./plans";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS, PROJECT } from "./claude-code-capacity.fixture";
import { loadAccountResolver } from "./account-resolver";
import { buildProjectCost } from "./project-cost";
import { replaceDeclaredPeriods, PLAN_PERIODS } from "../db/period-store";
import { codexCallsScene, card, openedDatabases } from "./codex-window-calls.fixture";
import { prepareCodexLedgerFixture } from "./codex-ledger.fixture";
import { dailyAggregate } from "./project-cost-daily";

const start = Date.parse("2026-09-01T00:00:00Z"), day = 86_400_000;
function stretch(index: number, plan: string | null, cost: number | null): PlanPriceStretch {
  return { fromMs: start + index * day, untilMs: start + (index + 1) * day, plan, monthly: cost === null ? null : cost * 30.44, source: "declared" };
}
const usage = (project: number, other: number, incomplete = false): PlanPeriodUsage => ({ incomplete, groups: new Map([
  ["p:project", { tokens: project * 100, calls: project ? 1 : 0, api_usd: project }],
  ["p:other", { tokens: other * 100, calls: other ? 1 : 0, api_usd: other }],
]) });

test("x1, x5, x20 and Free each use the project's traffic share in that same dated period", () => {
  const pieces = [stretch(0, "pro", 10), stretch(1, "max-5x", 50), stretch(2, "max-20x", 200), stretch(3, "free", 0)];
  const traffic = [usage(9, 1), usage(1, 9), usage(2, 8), usage(50, 50)];
  const result = allocatePlanPeriods(pieces, ["p:project", "p:other", ""], (_, i) => traffic[i]!);
  expect(result.get("p:project")!.map(period => period.billed_usd)).toEqual([9, 5, 40, 0]);
  expect(result.get("p:project")!.reduce((sum, period) => sum + period.billed_usd!, 0)).toBe(54);
  expect([...result.values()].flat().reduce((sum, period) => sum + period.billed_usd!, 0)).toBe(260);
});

test("a history gap or incomplete usage withholds that period, retaining known allocations and a real zero for Free", () => {
  const pieces = [stretch(0, "pro", 10), stretch(1, null, null), stretch(2, "max-20x", 200), stretch(3, "free", 0)];
  const result = allocatePlanPeriods(pieces, ["p:project", "p:other", ""], (_, i) => usage(5, 5, i >= 2));
  expect(result.get("p:project")!.map(period => period.billed_usd)).toEqual([5, null, null, 0]);
  expect(result.get("p:project")![1]!.billing_unavailable_reasons).toEqual(["plan_history_gap"]);
  expect(result.get("p:project")![2]!.billing_unavailable_reasons).toEqual(["usage_incomplete"]);
  expect(result.get("p:project")![3]!.billing_unavailable_reasons).toEqual([]);
});

test("idle plan time stays unassigned and splitting fee cents conserves the account total", () => {
  const pieces = [stretch(0, "pro", 0.005), stretch(1, "pro", 0.005), stretch(2, "pro", 0.005)];
  const result = allocatePlanPeriods(pieces, ["p:project", ""], () => ({ groups: new Map(), incomplete: false }));
  expect(result.get("p:project")!.map(period => period.billed_usd)).toEqual([0, 0, 0]);
  expect(result.get("")!.reduce((sum, period) => sum + period.billed_usd!, 0)).toBe(0.02);
});

test("stored Claude traffic respects an intraday plan change and survives restart without writes or repricing", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const first = { ...stretch(0, "pro", 10), fromMs: Date.parse("2026-09-16T00:00:00Z"), untilMs: Date.parse("2026-09-16T12:00:00Z") };
    const second = { ...first, fromMs: first.untilMs, untilMs: Date.parse("2026-09-17T00:00:00Z"), plan: "max-20x" };
    const read = () => [first, second].map(piece => readPlanPeriodUsage(fixture.db, fixture.rates, loadAccountResolver(fixture.db),
      { id: ACCOUNTS.a, vendor: "claude" }, piece));
    const before = fixture.db.query("SELECT total_changes() n").get();
    const result = read();
    expect(readPlanPeriodsUsage(fixture.db, fixture.rates, loadAccountResolver(fixture.db),
      { id: ACCOUNTS.a, vendor: "claude" }, [first, second])).toEqual(result);
    expect(result[0]!.groups.get(`p:${PROJECT}`)).toBeUndefined();
    expect(result[1]!.groups.get(`p:${PROJECT}`)!.tokens).toBe(30_000);
    expect(result[1]!.groups.get(`p:${PROJECT}`)!.api_usd).toBeCloseTo(0.162, 12);
    expect(fixture.db.query("SELECT total_changes() n").get()).toEqual(before);
    fixture.reopen();
    expect(read()).toEqual(result);
  } finally { fixture.teardown(); }
});

test("batched Codex period sums match independent exact reads at intraday boundaries, including unpriced traffic", () => {
  const { db } = codexCallsScene();
  try {
    const cuts = ["2026-09-11T00:00:00Z", "2026-09-11T12:17:41.250Z", "2026-09-12T00:00:00Z", "2026-09-12T18:00:00Z"];
    const pieces = cuts.slice(0, -1).map((from, i) => ({ ...stretch(i, "pro", 10), fromMs: Date.parse(from), untilMs: Date.parse(cuts[i + 1]!) }));
    const resolver = loadAccountResolver(db), account = { id: "acct", vendor: "codex" };
    const exact = pieces.map(piece => readPlanPeriodUsage(db, card, resolver, account, piece));
    expect(readPlanPeriodsUsage(db, card, resolver, account, pieces)).toEqual(exact);
    expect(exact.some(period => period.incomplete)).toBe(true);
  } finally { db.close(); openedDatabases.splice(openedDatabases.indexOf(db), 1); }
});

test("a single Codex period cannot allocate a fee over priced-only weights", () => {
  const { db, base } = codexCallsScene();
  try {
    const rates = { ...card, subscriptions: { acct: { usd_per_month: 200 } } };
    const report = buildProjectCost(db, rates, base.homeToSubId!, { since: "2026-09-11", until: "2026-09-12" });
    const slice = report.subjects.find(subject => subject.subject === "p:7")!.subscriptions.acct!;
    expect(slice.billed_complete).toBe(false);
    expect(slice.billed_usd).toBeNull();
    expect(slice.billing_unavailable_reasons).toContain("usage_incomplete");
  } finally { db.close(); openedDatabases.splice(openedDatabases.indexOf(db), 1); }
});

test("internal review without an API price never blocks user-work calendar allocation, but unknown user models do", () => {
  const { db, base } = codexCallsScene();
  try {
    db.exec("DELETE FROM events");
    const insert = db.query(`INSERT INTO events(home,path,ts,model,project,in_tok,cached_in,cache_write,out_tok,
      reasoning_out,speed,billing_mode,plan_type,source_offset)
      VALUES('c:/own','c:/own/work.jsonl',?,?,?,1000,0,0,100,0,'standard','allowance','pro',?)`);
    insert.run("2026-09-12T02:00:00Z", "gpt-6-astra", "seven", 1);
    insert.run("2026-09-12T03:00:00Z", "gpt-6-astra", null, 2);
    insert.run("2026-09-12T04:00:00Z", "codex-auto-review", "seven", 3);
    prepareCodexLedgerFixture(db, card, base.homeToSubId!);
    const rates = { ...card, subscriptions: { acct: { usd_per_month: 200 } } };
    const build = () => buildProjectCost(db, rates, base.homeToSubId!, { since: "2026-09-12", until: "2026-09-12" });
    const report = build(), slice = report.subjects.find(subject => subject.subject === "p:7")!.subscriptions.acct!;
    const fee = report.subscriptions.find(subscription => subscription.id === "acct")!.paid_usd!;
    expect(slice.billed_complete).toBe(true);
    expect(slice.billed_usd).toBeGreaterThan(0);
    expect(Math.abs(slice.billed_usd! - fee / 2)).toBeLessThanOrEqual(0.01);
    expect(report.totals.billed_usd + report.totals.unassigned_billed_usd).toBeCloseTo(fee, 8);
    expect(report.unpriced.models["codex-auto-review"]).toBe(1100);
    const piece = { ...stretch(0, "pro", 10), fromMs: Date.parse("2026-09-12T00:00:00Z"), untilMs: Date.parse("2026-09-13T00:00:00Z") };
    const resolver = loadAccountResolver(db), account = { id: "acct", vendor: "codex" };
    expect(readPlanPeriodUsage(db, rates, resolver, account, piece).incomplete).toBe(false);
    const cuts = [{ ...piece, untilMs: Date.parse("2026-09-12T03:00:00Z") }, { ...piece, fromMs: Date.parse("2026-09-12T03:00:00Z") }];
    const stored = dailyAggregate(db, rates, base.homeToSubId!, { since: "2026-09-12", until: "2026-09-12" }).periodRows!.get("acct")!;
    expect(readPlanPeriodsUsage(db, rates, resolver, account, cuts, stored).every(usage => !usage.incomplete)).toBe(true);
    insert.run("2026-09-12T05:00:00Z", "unknown-user-model", "seven", 4);
    prepareCodexLedgerFixture(db, rates, base.homeToSubId!);
    const blocked = build().subjects.find(subject => subject.subject === "p:7")!.subscriptions.acct!;
    expect(blocked.billed_usd).toBeNull();
    expect(blocked.billing_unavailable_reasons).toContain("usage_incomplete");
  } finally { db.close(); openedDatabases.splice(openedDatabases.indexOf(db), 1); }
});

test("mixed UTC offsets cannot assign a whole lexical timestamp cohort to the wrong plan", () => {
  const { db, base } = codexCallsScene();
  try {
    db.exec("DELETE FROM events");
    const insert = db.query(`INSERT INTO events(home,path,ts,model,project,in_tok,cached_in,cache_write,out_tok,
      reasoning_out,speed,billing_mode,plan_type,source_offset)
      VALUES('c:/own','c:/own/one.jsonl',?,'gpt-6-astra','seven',1000,0,0,100,0,'standard','allowance','pro',?)`);
    insert.run("2026-09-12T01:00:00-02:00", 1);
    insert.run("2026-09-12T02:00:00+02:00", 2);
    prepareCodexLedgerFixture(db, card, base.homeToSubId!);
    const cuts = ["2026-09-12T00:00:00Z", "2026-09-12T01:00:00Z", "2026-09-12T04:00:00Z"];
    const pieces = cuts.slice(0, -1).map((from, i) => ({ ...stretch(i, "pro", 10), fromMs: Date.parse(from), untilMs: Date.parse(cuts[i + 1]!) }));
    const resolver = loadAccountResolver(db), account = { id: "acct", vendor: "codex" };
    const exact = pieces.map(piece => readPlanPeriodUsage(db, card, resolver, account, piece));
    expect(exact.map(period => period.groups.get("p:7")!.tokens)).toEqual([1100, 1100]);
    const stored = dailyAggregate(db, card, base.homeToSubId!, { since: "2026-09-12", until: "2026-09-12" }).periodRows!.get("acct")!;
    expect(readPlanPeriodsUsage(db, card, resolver, account, pieces, stored)).toEqual(exact);
    expect(readPlanPeriodsUsage(db, card, resolver, account, pieces)).toEqual(exact);
  } finally { db.close(); openedDatabases.splice(openedDatabases.indexOf(db), 1); }
});

test("project report publishes dated allocations and sums known pieces while retaining a missing plan period", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const rates = structuredClone(fixture.rates);
  rates.subscriptions = { [ACCOUNTS.a]: { usd_per_month: 100 }, [ACCOUNTS.b]: { usd_per_month: 200 } };
  try {
    fixture.db.exec("DELETE FROM plan_periods");
    const declared = { origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" };
    replaceDeclaredPeriods(fixture.db, PLAN_PERIODS, [
      { ...declared, provider: "claude", subject: ACCOUNTS.a, value: "pro", from: "2026-09-13T00:00:00Z", until: "2026-09-15T00:00:00Z" },
      { ...declared, provider: "claude", subject: ACCOUNTS.a, value: "free", from: "2026-09-17T00:00:00Z", until: null },
    ]);
    const catalog = { provider_groups: [{ id: "claude", label: "Claude", aliases: [], plans: [
      { plan_id: "pro", label: "Pro", versions: [{ from: "2020-01-01", usd_per_month: 30.44 }] },
      { plan_id: "free", label: "Free", versions: [{ from: "2020-01-01", usd_per_month: 0 }] },
    ] }] };
    const result = buildProjectCost(fixture.db, rates, new Map(), { since: "2026-09-13", until: "2026-09-17", plansCatalog: catalog });
    const project = result.subjects.find(subject => subject.subject === `p:${PROJECT}`)!;
    const slice = project.subscriptions[ACCOUNTS.a]!;
    expect(slice.plan_periods!.map(period => period.plan)).toEqual(["pro", null, "free"]);
    expect(slice.plan_periods![0]!.tokens).toBe(10_000);
    expect(slice.plan_periods![1]!.tokens).toBe(30_000);
    expect(slice.billed_usd).toBe(0.5);
    expect(slice.billed_complete).toBe(false);
    expect(slice.billing_unavailable_reasons).toEqual(["plan_history_gap"]);
    expect(project.billed_complete).toBe(false);
  } finally { fixture.teardown(); }
});
