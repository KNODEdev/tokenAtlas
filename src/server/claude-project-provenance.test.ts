import { expect, test } from "bun:test";
import { loadAccountResolver } from "./account-resolver";
import { usageLedgerEvents } from "../db/usage-ledger-events";
import { installAnalysisTracking } from "../db/analysis";
import { installFactDayRevisions } from "../db/fact-day-revisions";
import { remapRepos } from "../projects/remap";
import { ACCOUNTS, TIMES, createClaudeCodeAcceptanceFixture } from "./claude-code-capacity.fixture";

test("Claude project corrections retain actual and Standard valuations after reopening", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  const rates = structuredClone(fixture.rates);
  const model = rates.vendors.anthropic!.models!["claude-sonnet-fixture"]!;
  model.fast = { in_uncached: 9, in_cache_read: 0.9, in_cache_write_5m: 11.25, in_cache_write_1h: 18, out_total: 45 };
  const price = () => {
    const event = usageLedgerEvents(fixture.db, "claude", rates, loadAccountResolver(fixture.db).plan("claude", ACCOUNTS.a))
      .load(TIMES.start, TIMES.afterAsOf, TIMES.start, TIMES.afterAsOf)
      .find(row => row.identity === "between")!;
    return { event, actual: event.prices.actual!, standard: event.prices.standard! };
  };
  // The stored valuation of the call: a correction of its project must not change it.
  const stored = () => fixture.db.query(`SELECT std_key,std_reason,std_nano,std_femto,act_key,act_reason,act_nano,act_femto
    FROM usage_ledger_facts WHERE provider='claude' AND identity='between'`).all();
  try {
    // Repo columns are supplied by remapping, not the base database migration.
    remapRepos(fixture.db, {});
    installAnalysisTracking(fixture.db);
    installFactDayRevisions(fixture.db);
    fixture.db.exec("UPDATE claude_events SET speed='fast' WHERE call_id='between'");
    fixture.prepareFacts(rates);
    const first = price();
    expect(first.event.subject).toBe("p:project-subset");
    // 24k input + 6k output; Fast rates are three times Standard.
    expect(first.actual.amount).toBeCloseTo(0.486, 12);
    expect(first.standard.amount).toBeCloseTo(0.162, 12);
    const saved = stored();
    expect(saved.length).toBe(1);

    fixture.db.exec("UPDATE claude_events SET project_id=NULL,repo='corrected-repo' WHERE call_id='between'");
    fixture.prepareFacts(rates);
    fixture.reopen();
    const corrected = price();
    expect(corrected.event.subject).toBe("r:corrected-repo");
    expect(corrected.actual).toEqual(first.actual);
    expect(corrected.standard).toEqual(first.standard);
    expect(stored()).toEqual(saved);

    fixture.db.exec("UPDATE claude_events SET repo=NULL WHERE call_id='between'");
    fixture.prepareFacts(rates);
    const unassigned = price();
    expect(unassigned.event.subject).toBeNull();
    expect(unassigned.event.quantities).toEqual(first.event.quantities);
    expect(unassigned.actual).toEqual(first.actual);
    expect(stored()).toEqual(saved);
  } finally {
    fixture.teardown();
  }
});
