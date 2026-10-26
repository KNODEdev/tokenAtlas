import { test, expect } from "bun:test";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "../db/period-store";
import { createClaudeCodeAcceptanceFixture, ACCOUNTS, TIMES, measureAnalysis } from "./claude-code-capacity.fixture";
import { buildClaudeCodeCapacityReport } from "./claude-code-capacity";
import { storedProjectUsage } from "./stored-project-usage";
import { storedHistoryUsage } from "./stored-history-usage";
import { subscriptionAccountDiscovery } from "./subscription-account-discovery";
import { loadAccountResolver } from "./account-resolver";
import { SubscriptionFactsPending } from "../db/subscription-facts";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";

/** Statements other than the account resolver's session-identity look (claude-event-account). */
const eventOrFactReads = (queries: string[]) => queries.filter(query =>
  !/^SELECT (COALESCE\(MAX\(rowid\), 0\) AS top|COUNT\(\*\) AS n FROM claude_events WHERE rowid > \?$|DISTINCT account_key AS key FROM claude_events)/.test(query));

test("period correction resets affected capacity accounts without touching another account", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const read = (account: string) => measureAnalysis(f.db, () => buildClaudeCodeCapacityReport(f.db, account, {rateCards:f.rates}));
    // Rule @3: the SDK, desktop and unlabelled calls between the readings are Code too.
    expect(read(ACCOUNTS.a).value.observed!.code_tokens).toBe(111_000);
    const other = read(ACCOUNTS.b).value;
    // Limit windows and measured intervals; a reconstructed window also reports traffic no account owns, which the correction changes.
    const rows = (account: string) => f.db.query(`SELECT * FROM window_usage WHERE provider='claude' AND account=?
      AND window_id NOT LIKE 'declared:%' ORDER BY counter,window_id`).all(account);
    const before = rows(ACCOUNTS.b);
    replaceDeclaredPeriods(f.db, ACCOUNT_PERIODS, loadPeriods(f.db, ACCOUNT_PERIODS).map(p => p.value === ACCOUNTS.a
      ? {...p, until: TIMES.asOf} : p));
    f.prepareProbes();
    const changed = read(ACCOUNTS.a);
    // The second probe is outside the corrected period too; only the first snapshot remains.
    expect(changed.value.observations.at(-1)!.as_of).toBe(TIMES.first);
    expect(changed.value.observed!.code_tokens).toBe(50_000);
    const unchanged = read(ACCOUNTS.b);
    expect(unchanged.value).toEqual(other);
    expect(eventOrFactReads(unchanged.rawOrFactQueries)).toEqual([]);
    // The other account's stored window sums were not recomputed into anything different.
    expect(rows(ACCOUNTS.b)).toEqual(before);
  } finally { f.teardown(); }
});

test("first traffic in a previously empty range joins discovery once the published register reaches it", () => {
  const f = createClaudeCodeAcceptanceFixture();
  const range = {since:"2026-09-25",until:"2026-09-25"};
  try {
    expect(storedProjectUsage(f.db,"claude",f.rates,range).accounts).toEqual([]);
    f.db.query(`INSERT INTO claude_events(store,call_id,path,ts,model,speed,subscription_id,in_uncached)
      VALUES('new-fixture','new-range',?,'2026-09-25T10:00:00.000Z','claude-sonnet-fixture','standard',?,1000)`)
      .run(`${ARCHIVE_LOGICAL_ROOT}/claude/${ACCOUNTS.a}/new-range.jsonl`,ACCOUNTS.a);
    expect(f.db.query("SELECT status FROM usage_ledger_state WHERE provider='claude'").get()).toEqual({status:"ready"});
    // The published register answers as it stands until the producer reaches the new call (golden rules §9).
    expect(storedProjectUsage(f.db,"claude",f.rates,range).accounts).toEqual([]);
    expect(storedHistoryUsage(f.db,"claude",f.rates,{...range,idleGapMinutes:15}).accounts).toEqual([]);
    f.prepareFacts();
    const usage = storedProjectUsage(f.db,"claude",f.rates,range);
    expect(usage.accounts).toEqual([ACCOUNTS.a]);
    expect(usage.groups.reduce((sum,row)=>sum+row.tokens,0)).toBe(1000);
  } finally { f.teardown(); }
});

test("discovery rejects stale pricing rules even when no account days match the range", () => {
  const f = createClaudeCodeAcceptanceFixture();
  try {
    const rates = structuredClone(f.rates);
    rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!.out_total = 30;
    expect(() => subscriptionAccountDiscovery(f.db,"claude",loadAccountResolver(f.db),
      {since:"2026-09-25",until:"2026-09-25"},rates)).toThrow("usage-price-rules-pending");
  } finally { f.teardown(); }
});
