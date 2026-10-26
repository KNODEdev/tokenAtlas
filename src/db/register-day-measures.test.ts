import { expect, test } from "bun:test";
import { ARCHIVE_LOGICAL_ROOT } from "../config/paths";
import { createClaudeCodeAcceptanceFixture } from "../server/claude-code-capacity.fixture";
import { fillUsageLedger } from "../server/usage-ledger.fixture";
import { loadAccountResolver } from "../server/account-resolver";
import { TOKEN_BUCKETS } from "../server/subscription-accounting-adapters";
import { ACCOUNT_PERIODS, loadPeriods, replaceDeclaredPeriods } from "./period-store";
import { readRegisterDayMeasures, readRegisterDays } from "./usage-price-read-account";
import { decodeCounts, decodeQuality, decodeTokens } from "./usage-price-measures";

/** What the account history read of `readRegisterDays` before it read `readRegisterDayMeasures`. */
const projected = (rows: ReturnType<typeof readRegisterDays>) => rows.map(row => {
  const amount = decodeCounts(row.counts).api_actual!, tokens = decodeTokens(row.tokens);
  return { day: row.day, dim: row.dim, model: row.model, vendor: row.vendor, account: row.account, calls: row.calls,
    first_ts: row.first_ts, last_ts: row.last_ts, tokens: TOKEN_BUCKETS.reduce((sum, key) => sum + Number(tokens[key] ?? "0"), 0),
    conflicts: Number(decodeQuality(row.quality).conflicts ?? "0"),
    actual: { priced: Number(amount.pricedSubtotal), unpricedTokens: Number(amount.unpricedTokens), unpricedEvents: Number(amount.unpricedEvents) } };
});
const measured = (rows: ReturnType<typeof readRegisterDayMeasures>) => rows.map(({ actual, ...row }) =>
  ({ ...row, actual: { priced: Number(actual.pricedSubtotal), unpricedTokens: actual.unpricedTokens, unpricedEvents: actual.unpricedEvents } }));

test("register day measures are readRegisterDays' rows, accounts and order, cut days and conflicts included", () => {
  const fixture = createClaudeCodeAcceptanceFixture();
  try {
    const db = fixture.db;
    // A conflicting second copy of a call (a conflict marker on its day) and a period boundary inside a day.
    db.query(`INSERT INTO claude_events (store,call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached,out_total)
      SELECT 'fixture-copy',call_id,session_id,path,ts,model,speed,subscription_id,entrypoint,cc_version,in_uncached+1,out_total
      FROM claude_events WHERE call_id='at-first'`).run();
    fillUsageLedger(db, "claude", fixture.rates, ARCHIVE_LOGICAL_ROOT);
    const periods = loadPeriods(db, ACCOUNT_PERIODS).filter(period => period.origin === "declared")
      .map(period => period.subject === "claude/account-a" ? { ...period, until: "2026-09-16T12:30:00.000Z" } : period);
    periods.push({ provider: "claude", subject: "claude/account-a", value: "account-c", from: "2026-09-16T12:30:00.000Z", until: null,
      origin: "declared", firstSeen: null, lastSeen: null, readings: 0, evidence: "fixture" });
    replaceDeclaredPeriods(db, ACCOUNT_PERIODS, periods);
    const resolver = loadAccountResolver(db, []);
    const range = { since: "2026-01-01", until: "2026-12-31" };
    const reference = projected(readRegisterDays(db, "usage-ledger:claude", "claude", resolver, range));
    const rows = measured(readRegisterDayMeasures(db, "claude", resolver, range));
    expect(rows).toEqual(reference);
    // The cut day splits account-a's source at the boundary.
    const cut = new Set(rows.filter(row => row.day === "2026-09-16").map(row => row.account));
    expect(cut.has("account-a") && cut.has("account-c")).toBe(true);
    expect(rows.some(row => row.conflicts > 0)).toBe(true);
  } finally { fixture.teardown(); }
}, 60_000);
