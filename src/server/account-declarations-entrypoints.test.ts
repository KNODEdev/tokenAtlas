import { expect, test } from "bun:test";
import { createClaudeCodeAcceptanceFixture, measureAnalysis, PROJECT } from "./claude-code-capacity.fixture";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { buildPlanPriceCoverage } from "./plan-price-coverage";
import type { PlansCatalog } from "./plans-catalog";
import { loadAccountResolver } from "./account-resolver";
import { buildProjectCost, subscriptionFirstCallOn } from "./project-cost";
import { buildRepoHistory, listSubjects } from "./repo-history";
import { buildSubscriptionAccountingReport } from "./subscription-accounting";
import { indexSubscriptionHomes, restoreSubscriptionHomes, codexSourceHomes, subscriptionDeclarations } from "./capacity-equivalents";

test("real project, history and selector entry points preserve a custom Claude identity declaration", () => {
  const f = createClaudeCodeAcceptanceFixture();
  const account = "custom-claude-seat";
  const declarations = [{id:account,vendor:"claude",account_key:"synthetic-session-identity"}];
  const indexed = indexSubscriptionHomes([],[]);
  const homes = restoreSubscriptionHomes([...indexed],codexSourceHomes(indexed),subscriptionDeclarations(indexed));
  const range = {since:"2026-09-13",until:"2026-09-17"};
  try {
    f.db.query("UPDATE claude_events SET account_key=?").run(declarations[0]!.account_key);
    f.prepareFacts();
    const accounting = buildSubscriptionAccountingReport({sqlite:f.db,rateCards:f.rates,declarations,
      plans:{segments:[],capacity_regimes:[]},plansCatalog:{provider_groups:[]},manualCapacity:[]},"claude",{...range,account});
    const project = buildProjectCost(f.db,f.rates,homes,{...range,declarations});
    const history = buildRepoHistory(f.db,{...range,repo:null,projectId:PROJECT,granularity:"day",by:"account",
      idleGapMinutes:15,rateCards:f.rates,homeToSubId:homes,declarations});
    expect(accounting.tokens).toBeGreaterThan(0);
    expect(project.subscriptions.map(row=>row.id)).toEqual([account]);
    expect(Object.keys(history.totals.by_sub)).toEqual([account]);
    expect(project.totals.tokens).toBe(accounting.tokens);
    const selectedAccounting = buildSubscriptionAccountingReport({sqlite:f.db,rateCards:f.rates,declarations,
      plans:{segments:[],capacity_regimes:[]},plansCatalog:{provider_groups:[]},manualCapacity:[]},"claude",{...range,account,project:PROJECT});
    expect(history.totals.tokens).toBe(selectedAccounting.tokens);
    const subjects = listSubjects(f.db,15,range,{rateCards:f.rates,declarations});
    const listed = subjects.find(row=>row.kind==="project" && row.id===PROJECT)!;
    expect(listed.tokens).toBe(history.totals.tokens);
    expect(listed.calls).toBe(history.totals.calls);
  } finally { f.teardown(); }
});


test("custom Claude identity keeps the same first-call boundary in coverage, project cost and history", () => {
  const f = createClaudeCodeAcceptanceFixture();
  const account = "custom-claude-seat";
  const declarations = [{ id: account, vendor: "claude", account_key: "synthetic-session-identity" }];
  const range = { since: "2026-09-13", until: "2026-09-13" };
  const plansCatalog: PlansCatalog = { provider_groups: [{ id: "claude", label: "Claude", aliases: ["claude"], plans: [
    { plan_id: "pro", label: "Pro", aliases: ["pro"], versions: [{ from: "2020-01-01", usd_per_month: 20 }] },
  ] }] };
  try {
    f.db.exec("DELETE FROM claude_events WHERE call_id NOT IN ('at-start','foreign-account')");
    f.db.query("UPDATE claude_events SET ts='2026-09-13T12:00:00.000Z', account_key=? WHERE call_id='at-start'")
      .run(declarations[0]!.account_key);
    // Another account has an earlier call on this day; it cannot open this account's price span.
    f.db.exec("UPDATE claude_events SET ts='2026-09-13T00:00:00.000Z' WHERE call_id='foreign-account'");
    f.prepareFacts();
    replaceDeclaredPeriods(f.db, PLAN_PERIODS, [{ provider: "claude", subject: account, value: "pro",
      from: "2026-09-13T12:00:00.000Z", until: null, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" }]);
    const read = () => measureAnalysis(f.db, () => {
      const boundary = measureAnalysis(f.db, () => subscriptionFirstCallOn(f.db, f.rates, { id: account, vendor: "claude" },
        loadAccountResolver(f.db, declarations))(range.since));
      expect(boundary.value).toBe(Date.parse("2026-09-13T12:00:00.000Z"));
      expect(boundary.rawOrFactQueries).toEqual([]);
      const opts = { ...range, declarations, plansCatalog };
      const coverage = buildPlanPriceCoverage(f.db, f.rates, opts).subjects.find(row => row.id === account)!;
      const project = buildProjectCost(f.db, f.rates, new Map(), opts).subscriptions.find(row => row.id === account)!;
      const history = buildRepoHistory(f.db, { ...opts, repo: null, projectId: PROJECT, granularity: "day", by: "account",
        idleGapMinutes: 15, rateCards: f.rates, homeToSubId: new Map() });
      expect(coverage.gaps).toEqual([]);
      expect(coverage.usd).toBe(Math.round(20 * 0.5 / 30.44 * 100) / 100);
      expect(coverage.pieces.map(piece => piece.days)).toEqual([0.5]);
      expect(project.plan_periods).toEqual(coverage.pieces);
      expect(project.paid_usd).toBe(coverage.usd);
      expect(history.totals.by_sub[account]?.billed_usd).toBe(coverage.usd);
      return coverage;
    });
    const first = read();
    expect(first.rawOrFactQueries.some(sql => /\bclaude_events\b/.test(sql))).toBe(false);
    expect(read().value).toEqual(first.value);
    f.reopen();
    const reopened = read();
    expect(reopened.rawOrFactQueries.some(sql => /\bclaude_events\b/.test(sql))).toBe(false);
    expect(reopened.value).toEqual(first.value);
  } finally { f.teardown(); }
});
