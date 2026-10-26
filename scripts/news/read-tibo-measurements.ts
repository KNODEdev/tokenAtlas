import type { Database } from "../../src/db/sqlite";
import { withReadSnapshot } from "../../src/db/analysis";
import { codexLedgerReadContext, readCodexLedgerOwnedSeries } from "../../src/db/codex-ledger-adapters";
import { loadAccountResolver } from "../../src/server/account-resolver";
import { loadPeriods, PLAN_PERIODS } from "../../src/db/period-store";
import { effectiveDatedPeriods, periodInstant, planPeriodIndex } from "../../src/server/account-periods";
import { tiboBounds, tiboDate, tiboMidnight } from "../../src/shared/tibo-challenge";
import type { TiboHour } from "../../src/shared/tibo-measurements";
type Context = { sqlite: Database; rateCards: Parameters<typeof codexLedgerReadContext>[0]; accounts: { subscriptions: Parameters<typeof loadAccountResolver>[1] } };
const safe = (n: bigint | number | string): number => {
  const value = Number(n);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Challenge counters exceed the safe integer range");
  return value;
};
/** Stored canonical hour cohorts; no import, valuation or history rebuild. */
export function readTiboMeasurements(ctx: Context, account: string): { hours: TiboHour[]; excludedCalls: number } {
  return withReadSnapshot(ctx.sqlite, () => {
    const from = tiboMidnight(tiboDate(-6)), until = tiboBounds(28).until;
    const resolver = loadAccountResolver(ctx.sqlite, ctx.accounts.subscriptions);
    const periods = ctx.sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_periods'").get()
      ? effectiveDatedPeriods(loadPeriods(ctx.sqlite, PLAN_PERIODS)) : [];
    const plans = planPeriodIndex(periods);
    const wanted = account.toLowerCase(), all = wanted === "__all__" || wanted === "all";
    const hours = new Map<string, TiboHour>();
    let excludedCalls = 0;
    // The valid-token projection omits bad calls. Count them in the same owned stored range first.
    for (const { group, account: owner } of readCodexLedgerOwnedSeries(ctx.sqlite,
      { grain: "hour", fromMs: from, toMs: until, dependencyBases: [] }, resolver, codexLedgerReadContext(ctx.rateCards), [] as const)) {
      if (!group.selected || !owner || !all && owner.toLowerCase() !== wanted) continue;
      const bad = group.stored.api_reason === "invalid_tokens" || group.stored.credit_reason === "invalid_tokens"
        ? group.calls : group.quality.invalid_token_events;
      excludedCalls = safe(excludedCalls + safe(bad));
    }
    for (const { group, account: owner } of readCodexLedgerOwnedSeries(ctx.sqlite,
      { grain: "hour", fromMs: from, toMs: until, dependencyBases: [] }, resolver,
      codexLedgerReadContext(ctx.rateCards), [] as const, { validTokensOnly: true })) {
      if (!group.selected || !owner || !all && owner.toLowerCase() !== wanted) continue;
      const row = group.stored;
      if (row.api_reason === "invalid_tokens" || row.credit_reason === "invalid_tokens" || group.quality.invalid_token_events > 0n) {
        continue;
      }
      const at = row.hour! * 3_600_000;
      if (!Number.isFinite(at) || at < from || at >= until) continue;
      const first = Date.parse(row.first_ts), last = Date.parse(row.last_ts);
      const accountPeriods = plans?.periodsOf("codex", owner) ?? [];
      // Do not label a mixed-plan hour as either plan or split its counters proportionally.
      if (accountPeriods.some(period => [period.from, period.until].some(edge => edge !== null
        && periodInstant(edge, "plan edge") > first && periodInstant(edge, "plan edge") <= last))) {
        excludedCalls = safe(excludedCalls + safe(group.calls)); continue;
      }
      const plan = plans?.resolve("codex", owner, row.first_ts).value ?? null;
      const key = JSON.stringify([at, owner, row.model, row.service_tier, plan, row.billing_mode]);
      const point = hours.get(key) ?? { at, account: owner, model: row.model, mode: row.service_tier,
        plan, funding: row.billing_mode, calls: 0, input: 0, cached: 0, timed: 0, output: 0, ms: 0,
        longCalls: 0, longOutput: 0, longMs: 0 };
      const additions = { calls: group.calls,
        input: group.tokens.in_uncached! + group.tokens.in_cache_read! + group.tokens.in_cache_write_unknown!,
        cached: group.tokens.in_cache_read!, timed: row.timed_calls, output: row.timed_out, ms: row.timed_ms,
        longCalls: row.timed_long_calls, longOutput: row.timed_long_out, longMs: row.timed_long_ms };
      for (const field of Object.keys(additions) as Array<keyof typeof additions>) point[field] = safe(point[field] + safe(additions[field]));
      hours.set(key, point);
    }
    return { hours: [...hours.values()].sort((a,b) => a.at-b.at), excludedCalls };
  });
}
