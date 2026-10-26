import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema } from "./codex-price-ledger";
import { codexLedgerReadContext, readCodexLedgerOwnedDaySums, readCodexLedgerOwnedSeries, type CodexOwnedDaySum } from "./codex-ledger-adapters";
import { add, rational, type Rational } from "./price-ledger-exact";
import { projectRulesFromRawRows } from "../projects/rules.fixture";
import { buildAccountResolver, type AccountResolver } from "../server/account-resolver";
import type { DatedPeriod } from "../server/account-periods";
import type { CodexLedgerPolicy } from "../server/codex-ledger-policy";
import type { RateCard } from "../server/pricing";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";

const day = "2026-09-01";
const evidence = { verified_at: day, sources: ["https://example.test/pricing"], confidence: "official" as const };
/** Two priced models with different bands (rates) and a model without any rate (unpriced, `missing_rate`). */
function policy(): CodexLedgerPolicy {
  const models = { model: ["1", "0.1", "5"], model2: ["3", "0.3", "7"] } as const;
  return { version: 1, tiers: ["standard", "fast"],
    mappings: [{ id: "raw-default", raw_value: "default", tier: "standard" }, { id: "raw-priority", raw_value: "priority", tier: "fast" }],
    base_rules: Object.entries(models).flatMap(([model, [input, cached, output]]) => [
      { id: `${model}-api`, model, billing_basis: "api_equivalent_usd" as const, valid_from: "2026-01-01", multiplier: "1", ...evidence,
        rates: { in_uncached: input, in_cache_read: cached, out_total: output } },
      { id: `${model}-credit`, model, billing_basis: "chatgpt_credits" as const, valid_from: "2026-01-01", multiplier: "1", ...evidence,
        rates: { in_uncached: "100", in_cache_read: "10", out_total: "500" } }]),
    tier_rules: Object.keys(models).flatMap(model => (["api_equivalent_usd", "chatgpt_credits"] as const).flatMap(basis => [
      { id: `${model}-${basis}-standard`, model, billing_basis: basis, tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...evidence },
      { id: `${model}-${basis}-fast`, model, billing_basis: basis, tier: "fast", valid_from: "2026-01-01", multiplier: "2", ...evidence }])) };
}
type Input = { ts: string; home?: string; offset?: number; model?: string; input?: number; output?: number; billing?: string };
function fixture(events: Input[], fn: (db: Database, context: ReturnType<typeof codexLedgerReadContext>) => void) {
  const db = new Database(":memory:"), card: RateCard = { version: 2, currency: "USD", unit: "per 1M", vendors: {}, codex_ledger_policy: policy() };
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,
      cache_write ANY,out_tok ANY,reasoning_out ANY,usage_status TEXT,cache_write_status TEXT,service_tier TEXT,speed TEXT,
      subject TEXT,billing_mode TEXT,surface TEXT,nested TEXT,plan_type TEXT,meter_reset INTEGER) STRICT`);
    const insert = db.query("INSERT INTO events VALUES (?,?,?,?,?,?,0,0,?,0,'valid','missing','default','unknown',NULL,?,'chat',NULL,'plus',1)");
    events.forEach((event, index) => {
      const home = event.home ?? "/archive/codex/a";
      insert.run(home, `${home}/sessions/shared.jsonl`, event.offset ?? index * 100, event.model ?? "model", event.ts,
        event.input ?? 1_000_000, event.output ?? 0, event.billing ?? "subscription");
    });
    projectRulesFromRawRows(db);
    const context = codexLedgerReadContext(card);
    createCodexLedgerSchema(db);
    // Each archive folder is its own source; a local copy of folder `a` is the same source.
    fillCodexLedgerFixture(db, { bands: context.policy.baseBands, rulesRevision: context.rulesRevision!, factsRevision: 0,
      policy: context.policy.policy, sourceOf: home => home === "/local/.codex" ? "codex/a" : `codex/${home!.split("/").at(-1)}` });
    fn(db, context);
  } finally { db.close(); }
}
const period = (source: string, from: string, until: string | null, value: string): DatedPeriod => ({ provider: "codex", subject: source,
  from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "test" });
const sumRational = (values: Rational[]) => values.reduce((total, value) => add(total, value), rational(0n));

/** Per day, account and unpriced model: the sums of the per-group path, and the order owners first appear in it. */
function reference(db: Database, context: ReturnType<typeof codexLedgerReadContext>, range: { since?: string; until?: string }, resolver: AccountResolver) {
  const groups = readCodexLedgerOwnedSeries(db, range, resolver, context, ["api_standard"] as const).filter(({ group }) => group.selected);
  return summarize(groups.map(({ group, account }) => ({ day: group.stored.day, account,
    model: group.variants.api_standard.unpricedTokens ? group.stored.model : null, calls: group.calls,
    tokens: group.tokens.in_uncached! + group.tokens.in_cache_read! + group.tokens.in_cache_write_unknown! + group.tokens.out_total!,
    unpricedTokens: group.variants.api_standard.unpricedTokens, unpricedEvents: group.variants.api_standard.unpricedEvents,
    usd: group.variants.api_standard.pricedSubtotal, first_ts: group.stored.first_ts, last_ts: group.stored.last_ts })));
}
function summarize(rows: ReadonlyArray<Omit<CodexOwnedDaySum, "dim" | "seq">>) {
  const sums = new Map<string, { calls: bigint; tokens: bigint; unpricedTokens: bigint; unpricedEvents: bigint; usd: Rational[]; first: string; last: string }>();
  const owners: string[] = [];
  for (const row of rows) {
    const key = JSON.stringify([row.day, row.account, row.unpricedTokens ? row.model : null]);
    if (!owners.includes(String(row.account))) owners.push(String(row.account));
    const sum = sums.get(key) ?? { calls: 0n, tokens: 0n, unpricedTokens: 0n, unpricedEvents: 0n, usd: [], first: row.first_ts, last: row.last_ts };
    sum.calls += row.calls; sum.tokens += row.tokens; sum.unpricedTokens += row.unpricedTokens; sum.unpricedEvents += row.unpricedEvents;
    sum.usd.push(row.usd);
    if (row.first_ts < sum.first) sum.first = row.first_ts;
    if (row.last_ts > sum.last) sum.last = row.last_ts;
    sums.set(key, sum);
  }
  return { owners, sums: Object.fromEntries([...sums].sort(([a], [b]) => a.localeCompare(b)).map(([key, sum]) =>
    [key, { ...sum, usd: sumRational(sum.usd) }])) };
}
/** `perGroup`: days are expected to be read per stored group (period boundaries); otherwise from the summed rows only. */
function expectParity(db: Database, context: ReturnType<typeof codexLedgerReadContext>, range: { since?: string; until?: string }, resolver: AccountResolver,
  perGroup = false) {
  const queries = spyOn(db, "query");
  let summed: CodexOwnedDaySum[];
  try {
    summed = readCodexLedgerOwnedDaySums(db, { ...range, dependencyBases: ["api_equivalent_usd"] }, resolver, context);
    expect(queries.mock.calls.some(([sql]) => sql.includes("GROUP BY a.day,d.source,d.billing_mode,band,model"))).toBe(true);
    // The per-group read (its stored-group query) runs only for days a period boundary cuts.
    expect(queries.mock.calls.some(([sql]) => sql.includes("ORDER BY g.day,g.dim_id,g.copy_state"))).toBe(perGroup);
  } finally { queries.mockRestore(); }
  expect(summarize(summed!)).toEqual(reference(db, context, range, resolver));
  return summed!;
}

describe("owned Codex day sums (account history)", () => {
  test("mixed price bands and unpriced groups sum per day and owner as the per-group path values them", () => fixture([
    { ts: `${day}T09:00:00Z` }, { ts: `${day}T10:00:00Z`, model: "model2", output: 3000 }, { ts: `${day}T11:00:00Z`, model: "nameless" },
    { ts: `${day}T12:00:00Z`, model: "nameless", input: 7 }, { ts: "2026-09-02T08:00:00Z", home: "/archive/codex/b", model: "model2" },
    { ts: "2026-09-02T09:00:00Z", home: "/archive/codex/b", billing: "business_credits" },
  ], (db, context) => {
    const resolver = buildAccountResolver([period("codex/a", "2026-08-01", null, "one"), period("codex/b", "2026-08-01", null, "two")]);
    const summed = expectParity(db, context, {}, resolver);
    const unpriced = summed.filter(row => row.unpricedTokens > 0n);
    expect(unpriced.map(row => [row.model, row.unpricedTokens, row.unpricedEvents])).toEqual([["nameless", 1_000_007n, 2n]]);
    // $1 + ($3 + 3000 × $7/M) + $3 + $1 at the two bands' rates; the nameless model's calls stay unpriced.
    expect(sumRational(summed.map(row => row.usd))).toEqual(rational(8021n, 1000n));
    expect([...new Set(summed.map(row => row.account))].sort()).toEqual(["one", "two", "two::business"]);
    expectParity(db, context, { since: "2026-09-02", until: "2026-09-02" }, resolver);
  }));

  test("a day whose window holds a period boundary is read per stored group, its neighbours too", () => fixture([
    { ts: "2026-08-31T23:30:00Z" }, { ts: `${day}T11:59:00Z` }, { ts: `${day}T12:01:00Z` }, { ts: `${day}T12:10:00Z`, model: "model2" },
    { ts: `${day}T12:20:00Z`, model: "nameless" }, { ts: `${day}T14:00:00Z` }, { ts: "2026-09-02T01:00:00Z" },
    { ts: "2026-09-05T10:00:00Z" }, { ts: `${day}T12:30:00Z`, home: "/archive/codex/b" },
  ], (db, context) => {
    const resolver = buildAccountResolver([period("codex/a", "2026-08-01", `${day}T12:05:00Z`, "early"),
      period("codex/a", `${day}T12:05:00Z`, null, "late"), period("codex/b", "2026-08-01", null, "other")]);
    const summed = expectParity(db, context, {}, resolver, true);
    const owners = (wanted: string) => summed.filter(row => row.day === wanted).map(row => row.account);
    expect([...new Set(owners(day))].sort()).toEqual(["early", "late", "other"]);
    expect(owners("2026-08-31")).toEqual(["early"]);
    expect(owners("2026-09-02")).toEqual(["late"]);
    expect(owners("2026-09-05")).toEqual(["late"]);
    // Owners appear in the order of their first calls, as the history merges them.
    expect(summarize(summed).owners).toEqual(["early", "late", "other"]);
    expectParity(db, context, { since: day, until: day }, resolver, true);
  }));

  test("owners keep the per-group order on a cut day whose zero-token cohort comes first in time but second in the stored order", () => fixture([
    { ts: `${day}T09:00:00Z`, input: 0 }, { ts: `${day}T15:00:00Z` }, { ts: `${day}T10:00:00Z`, home: "/archive/codex/b" },
  ], (db, context) => {
    const resolver = buildAccountResolver([period("codex/a", "2026-08-01", `${day}T12:00:00Z`, "early"),
      period("codex/a", `${day}T12:00:00Z`, null, "late"), period("codex/b", "2026-08-01", null, "early")]);
    const summed = expectParity(db, context, {}, resolver, true);
    // The order owners first appear in is the history's split-key and tie order: exactly the per-group path's.
    expect(summarize(summed).owners).toEqual(reference(db, context, {}, resolver).owners);
    expect(new Set(summarize(summed).owners)).toEqual(new Set(["early", "late"]));
  }));

  test("only canonical copies count; a duplicate copy in another folder of the same source adds nothing", () => fixture([
    { ts: `${day}T12:01:00Z`, home: "/local/.codex", offset: 0 }, { ts: `${day}T12:01:00Z`, offset: 0 }, { ts: `${day}T12:02:00Z`, offset: 100 },
  ], (db, context) => {
    const resolver = buildAccountResolver([period("codex/a", "2026-08-01", null, "one")]);
    const summed = expectParity(db, context, {}, resolver);
    expect(summed.reduce((total, row) => total + row.calls, 0n)).toBe(2n);
  }));

  test("a corrected period moves only attribution; the sums stay those of the per-group path under the new periods", () => fixture([
    { ts: `${day}T09:00:00Z` }, { ts: `${day}T15:00:00Z`, model: "model2" }, { ts: "2026-09-03T10:00:00Z" },
  ], (db, context) => {
    const before = buildAccountResolver([period("codex/a", "2026-08-01", null, "one")]);
    const after = buildAccountResolver([period("codex/a", "2026-08-01", `${day}T12:00:00Z`, "one"), period("codex/a", `${day}T12:00:00Z`, null, "two")]);
    const stored = db.query("SELECT * FROM codex_price_ledger_aggregates ORDER BY grain,day,hour,dim_id").all();
    const first = expectParity(db, context, {}, before), second = expectParity(db, context, {}, after, true);
    const total = (rows: CodexOwnedDaySum[]) => [rows.reduce((sum, row) => sum + row.calls, 0n), sumRational(rows.map(row => row.usd))];
    expect(total(second)).toEqual(total(first));
    expect(second.filter(row => row.account === "two").reduce((sum, row) => sum + row.calls, 0n)).toBe(2n);
    // Periods are joined at read time: nothing stored changes.
    expect(db.query("SELECT * FROM codex_price_ledger_aggregates ORDER BY grain,day,hour,dim_id").all()).toEqual(stored);
  }));
});
