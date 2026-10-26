/**
 * The project cost's Claude traffic from stored day rows (stored-project-usage.ts, step 8 of
 * docs/stored-activity-plan-2026-10-07.md) against an oracle over the ledger's priced calls (`usageLedgerEvents`, each call's
 * stored valuation grouped by its owner and subject), and against a full refill of the same source rows, after a late call,
 * a rate-card change and a project rule change. The fixture holds a row the sums cannot split (a call with invalid counters
 * among priced ones) on a day an account period cuts. A rule change writes nothing.
 */
import { expect, test } from "bun:test";
import type { Database } from "../db/sqlite";
import { usageLedgerEvents } from "../db/usage-ledger-events";
import { loadAccountResolver } from "./account-resolver";
import { ACCOUNTS, createClaudeCodeAcceptanceFixture, PROJECT, RATES } from "./claude-code-capacity.fixture";
import { buildProjectCost } from "./project-cost";
import type { RateCard } from "./pricing";
import { storedProjectUsage } from "./stored-project-usage";
import { TOKEN_BUCKETS } from "./subscription-accounting-adapters";
import { overrideProjectRules, projectRulesOverride } from "../projects/resolve";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";

const RANGE = { since: "2026-09-13", until: "2026-09-17" };
const ACCOUNT_C = "account-c";
const CUT = "2026-09-16T13:30:00.000Z";
const changes = (db: Database) => (db.query("SELECT total_changes() n").get() as { n: number }).n;
type Types = { in_uncached: number; cache_read: number; cache_write: number; out: number };

/** Every owned, canonical, eligible call of the range by account and subject, each valued as the ledger stored it. */
function oracle(db: Database, rates: RateCard, range: { since?: string; until?: string }) {
  const resolver = loadAccountResolver(db);
  const groups = new Map<string, { account: string; subject: string | null; tokens: number; calls: number; types: Types; api: number; byType: Types;
    standard: number | null }>();
  const unpriced = new Map<string, { account: string; model: string; reason: string; tokens: number; calls: number }>();
  const from = `${range.since ?? "2000-01-01"}T00:00:00.000Z`;
  const until = new Date(Date.parse(`${range.until ?? "2099-12-31"}T00:00:00.000Z`) + 86_400_000).toISOString();
  for (const account of resolver.accounts("claude")) {
    for (const event of usageLedgerEvents(db, "claude", rates, resolver.plan("claude", account)).load(from, until)) {
      const q = event.quantities, tokens = TOKEN_BUCKETS.reduce((sum, bucket) => sum + q[bucket], 0), actual = event.prices.actual!;
      if (actual.amount === null) {
        const key = `${account}|${actual.reason}|${event.model}`;
        const row = unpriced.get(key) ?? { account, model: event.model || "?", reason: actual.reason!, tokens: 0, calls: 0 };
        row.tokens += tokens; row.calls++; unpriced.set(key, row);
        continue;
      }
      const key = `${account}|${event.subject ?? ""}`;
      const row = groups.get(key) ?? { account, subject: event.subject ?? null, tokens: 0, calls: 0,
        types: { in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 }, api: 0, byType: { in_uncached: 0, cache_read: 0, cache_write: 0, out: 0 }, standard: 0 };
      const cost = (bucket: keyof typeof actual.costs) => actual.costs[bucket] ?? 0;
      row.tokens += tokens; row.calls++; row.api += actual.amount;
      row.types.in_uncached += q.in_uncached; row.types.cache_read += q.in_cache_read; row.types.out += q.out_total;
      row.types.cache_write += q.in_cache_write_5m + q.in_cache_write_1h + q.in_cache_write_unknown;
      row.byType.in_uncached += cost("in_uncached"); row.byType.cache_read += cost("in_cache_read"); row.byType.out += cost("out_total");
      row.byType.cache_write += cost("in_cache_write_5m") + cost("in_cache_write_1h") + cost("in_cache_write_unknown");
      row.standard = row.standard === null || event.prices.standard!.amount === null ? null : row.standard + event.prices.standard!.amount;
      groups.set(key, row);
    }
  }
  return { groups: [...groups.values()].sort((a, b) => `${a.account}|${a.subject}`.localeCompare(`${b.account}|${b.subject}`)),
    unpriced: [...unpriced.values()].sort((a, b) => `${a.account}|${a.model}|${a.reason}`.localeCompare(`${b.account}|${b.model}|${b.reason}`)) };
}
/** The stored usage equals the oracle: counts exactly, money to a femto-dollar (exact sums against summed doubles). */
function expectOracle(db: Database, rates: RateCard, range: { since?: string; until?: string } = RANGE) {
  const usage = storedProjectUsage(db, "claude", rates, range), expected = oracle(db, rates, range);
  const groups = [...usage.groups].sort((a, b) => `${a.account}|${a.subject}`.localeCompare(`${b.account}|${b.subject}`));
  expect(groups.map(g => [g.account, g.subject, g.tokens, g.calls, g.tokens_by_type]))
    .toEqual(expected.groups.map(g => [g.account, g.subject, g.tokens, g.calls, g.types]));
  groups.forEach((group, index) => {
    const want = expected.groups[index]!;
    expect(group.api_usd).toBeCloseTo(want.api, 12);
    for (const type of ["in_uncached", "cache_read", "cache_write", "out"] as const) expect(group.api_usd_by_type[type]).toBeCloseTo(want.byType[type], 12);
    if (want.standard === null) expect(group.standard_usd).toBeNull(); else expect(group.standard_usd!).toBeCloseTo(want.standard, 12);
  });
  expect([...usage.unpriced].sort((a, b) => `${a.account}|${a.model}|${a.reason}`.localeCompare(`${b.account}|${b.model}|${b.reason}`)))
    .toEqual(expected.unpriced);
  return usage;
}
/** The project cost of the incremental ledger equals the one a full refill of the same source rows gives. */
function expectRefillEqual(f: ReturnType<typeof createClaudeCodeAcceptanceFixture>, rates: RateCard) {
  const incremental = buildProjectCost(f.db, rates, new Map(), RANGE);
  const keys = () => f.db.query(`SELECT d.day, m.key, d.act_key IS NOT NULL keyed FROM usage_ledger_days d JOIN usage_ledger_dims m
    ON m.provider=d.provider AND m.id=d.dim_id WHERE d.provider='claude' ORDER BY 1, 2`).all();
  const before = keys();
  for (const table of ["usage_ledger_facts", "usage_ledger_days", "usage_ledger_hours", "usage_ledger_day_reasons", "usage_ledger_dirty",
    "usage_ledger_dims", "usage_ledger_keys", "usage_ledger_source_days", "usage_ledger_state", "usage_ledger_mixed_sessions"])
    f.db.query(`DELETE FROM ${table} WHERE provider='claude'`).run();
  f.prepareFacts(rates);
  expect(keys()).toEqual(before);
  expect(buildProjectCost(f.db, rates, new Map(), RANGE)).toEqual(incremental);
}
/** Every day row's rate key is the one all its eligible canonical calls carry (as migration 0070 fills it). */
function expectRowKeys(db: Database) {
  expect(db.query(`SELECT COUNT(*) n FROM usage_ledger_days d LEFT JOIN (SELECT provider, day, dim_id,
      CASE WHEN COUNT(DISTINCT act_key)=1 AND COUNT(act_key)=COUNT(*) THEN MIN(act_key) END k
      FROM usage_ledger_facts WHERE copy_state='canonical' AND accounting=1 AND eligible=1 GROUP BY 1, 2, 3) f
    ON f.provider=d.provider AND f.day=d.day AND f.dim_id=d.dim_id WHERE d.act_key IS NOT f.k`).get()).toEqual({ n: 0 });
}

test("stored project usage equals the priced calls after a late call, a rate change and a rule change, and a full refill", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    // A call with impossible cache counters (unpriced, its recorded tokens kept) among priced calls of the same place and day,
    // and an account period that hands account A's source to account C within that day.
    f.db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,project_id,
        in_uncached,in_cache_write,cache_write_5m,out_total) VALUES('fixture-primary','invalid','session-invalid',?,'2026-09-16T12:30:00.000Z',
        'claude-sonnet-fixture','standard',?,'cli','2.1.0',?,1000,0,500,200)`)
      .run(`claude/${ACCOUNTS.a}/invalid.jsonl`, ACCOUNTS.a, PROJECT);
    const periods = loadPeriods(f.db, ACCOUNT_PERIODS).map(period => period.value === ACCOUNTS.a ? { ...period, until: CUT } : period);
    periods.push({ ...periods.find(period => period.value === ACCOUNTS.a)!, from: CUT, until: null, value: ACCOUNT_C });
    replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, periods);
    f.prepareFacts();
    expect(f.db.query(`SELECT COUNT(*) n FROM usage_ledger_days WHERE provider='claude' AND invalid_token_events>0 AND act_priced_events>0`).get())
      .toEqual({ n: 1 });
    expectRowKeys(f.db);
    const base = expectOracle(f.db, RATES);
    expect(base.accounts).toContain(ACCOUNT_C);
    expect(base.unpriced).toEqual([expect.objectContaining({ account: ACCOUNTS.a, reason: "invalid_cache_totals", tokens: 1700, calls: 1 })]);
    expectOracle(f.db, RATES, {});

    // A late call on an earlier day.
    f.db.query(`INSERT INTO claude_events(store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,project_id,in_uncached,out_total)
      VALUES('fixture-primary','late','session-late',?,'2026-09-14T08:00:00.000Z','claude-sonnet-fixture','standard',?,'cli','2.1.0',?,4000,1000)`)
      .run(`claude/${ACCOUNTS.a}/late.jsonl`, ACCOUNTS.a, PROJECT);
    f.prepareFacts();
    expectRowKeys(f.db);
    expectOracle(f.db, RATES);
    expectRefillEqual(f, RATES);

    // A rate-card change revalues the facts and rebuilds their days.
    const rates = structuredClone(RATES);
    rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!.in_uncached = 4;
    rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!.in_cache_write_5m = 5;
    f.prepareFacts(rates);
    expectRowKeys(f.db);
    expectOracle(f.db, rates);
    expectRefillEqual(f, rates);

    // A project rule change writes nothing; the stored rows follow it at once.
    const written = changes(f.db);
    const rules = projectRulesOverride(f.db)!;
    overrideProjectRules(f.db, { projects: rules.projects.map(project => project.id === PROJECT ? { ...project, id: "moved", name: "moved" } : project) });
    const moved = expectOracle(f.db, rates);
    expect(moved.groups.some(group => group.subject === "p:moved")).toBe(true);
    expect(moved.groups.some(group => group.subject === `p:${PROJECT}`)).toBe(false);
    expect(buildProjectCost(f.db, rates, new Map(), RANGE).subjects.map(row => row.subject)).toContain("p:moved");
    expect(changes(f.db)).toBe(written);
  } finally { f.teardown(); }
}, 60_000);

test("exceptional project dimensions share one day scan and refresh after correction and reopen", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const range = { since: "2026-09-16", until: "2026-09-16" };
    const expected = storedProjectUsage(f.db, "claude", RATES, range);
    // Missing a uniform row key requires the existing per-call valuation path, for several dimensions.
    const forceCalls = () => f.db.query("UPDATE usage_ledger_days SET act_key=NULL WHERE provider='claude' AND day=?")
      .run(range.since);
    forceCalls();
    expect((f.db.query("SELECT COUNT(*) n FROM usage_ledger_days WHERE provider='claude' AND day=? AND act_priced_events>0")
      .get(range.since) as { n: number }).n).toBeGreaterThan(1);
    const query = f.db.query.bind(f.db);
    let scans = 0;
    f.db.query = ((sql: string) => {
      if (sql.includes("FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_claude") && sql.includes("CAST(act_usd AS TEXT)")) scans++;
      return query(sql);
    }) as typeof f.db.query;
    const written = changes(f.db);
    expect(storedProjectUsage(f.db, "claude", RATES, range)).toEqual(expected);
    expect(scans).toBe(1);
    expect(changes(f.db)).toBe(written);
    f.db.query = query;

    f.db.query("UPDATE claude_events SET in_uncached=in_uncached+100 WHERE call_id='between'").run();
    f.prepareFacts();
    forceCalls();
    const corrected = expectOracle(f.db, RATES, range);
    expect(corrected).not.toEqual(expected);
    f.reopen();
    const reopenedChanges = changes(f.db);
    expect(storedProjectUsage(f.db, "claude", RATES, range)).toEqual(corrected);
    expect(changes(f.db)).toBe(reopenedChanges);
  } finally { f.teardown(); }
}, 60_000);
