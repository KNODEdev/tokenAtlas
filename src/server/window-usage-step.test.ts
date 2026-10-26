import { afterEach, expect, test } from "bun:test";
import { advanceWindowUsage, cachedWindowEventReader, emptyWindowUsageStats, WindowEventDays, windowSumsFromLedgers,
  type WindowEventReader } from "./window-usage";
import { addEvent, card, COUNTER, database, opened, publishLedger, settle } from "./window-usage-codex.fixture";
import { markWindowUsageDirty } from "../db/window-usage";
import { limitWindowFromRow, type LimitWindowRow } from "../db/limit-windows";
import { loadAccountResolver } from "./account-resolver";
import { codexLedgerReadContext } from "../db/codex-ledger-adapters";
import { prepareCodexPricing, resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { readCodexEventRange, resolveCodexLedgerEventOwner } from "./codex-priced-events";
import type { Database } from "../db/sqlite";

/** A window's computation is one bounded step of the background turn (the trial start of 05.10). */
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

/** The source passes to codex2 in the middle of the second week; one call of codex1 is paid from business credits. */
function sharedSource(): Database {
  const db = database();
  addEvent(db, { ts: "2026-09-09T05:00:00.000Z", billing: "business_credits" });
  addEvent(db, { ts: "2026-09-13T06:00:00.000Z" });
  addEvent(db, { ts: "2026-09-13T07:00:00.000Z", home: "/laptop" });
  db.exec(`UPDATE account_periods SET until_ts='2026-09-13T05:30:00Z';
    INSERT INTO account_periods(provider,source,account,from_ts,origin,evidence) VALUES('codex','codex/fixture','codex2','2026-09-13T05:30:00Z','declared','fixture')`);
  publishLedger(db, card);
  return db;
}
const windowRows = (db: Database) => db.query("SELECT * FROM limit_windows WHERE provider='codex' AND account='codex1' AND counter=? ORDER BY seq")
  .all(COUNTER) as LimitWindowRow[];

test("window sums read only their account's calls and equal the sums computed from every call of the span", () => {
  const db = sharedSource();
  settle(db);
  const resolver = loadAccountResolver(db), config = prepareCodexPricing(resolveCodexAccountingConfig(card)), ledger = codexLedgerReadContext(card);
  // The reference: every canonical call of the span, owned by the account, as the reader worked before.
  const everyCall: WindowEventReader = {
    codex: (account, start, end) => readCodexEventRange(db, config, start, end, event => resolveCodexLedgerEventOwner(resolver, event), ledger)
      .filter(event => (event as { copy_state?: unknown }).copy_state === "canonical" && event.account === account.toLowerCase()),
    ledger: () => [],
  };
  const rows = windowRows(db), stored = new Map((db.query("SELECT window_id,cycle,rail,readings,slices FROM window_usage").all() as
    Array<Record<string, string>>).map(row => [row.window_id!, row]));
  expect(rows.length).toBe(3);
  for (const [index, row] of rows.entries()) {
    const sums = windowSumsFromLedgers(everyCall, card, "codex", limitWindowFromRow(row), rows.slice(0, index).map(limitWindowFromRow)).sums;
    const row_ = stored.get(row.window_id)!;
    expect({ cycle: JSON.parse(row_.cycle!), rail: JSON.parse(row_.rail!), readings: JSON.parse(row_.readings!), slices: JSON.parse(row_.slices!) })
      .toEqual({ cycle: sums.cycle, rail: sums.rail, readings: sums.readings, slices: sums.slices });
  }
  // The second week holds calls of codex1, its business pool and codex2: the read loads codex1's own range only.
  const days = new WindowEventDays("test"), reader = cachedWindowEventReader(db, card, resolver, days);
  const second = limitWindowFromRow(rows[1]!);
  const calls = reader.codex("codex1", second.start, second.end);
  const owned = readCodexEventRange(db, config, second.start, second.end, event => resolveCodexLedgerEventOwner(resolver, event), ledger);
  expect(owned.some(event => event.account === "codex2")).toBe(true);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(event => event.account === "codex1")).toBe(true);
  expect(days.loaded).toBeLessThan(owned.length);
});

test("a request for the writer stops the producer after the window it is computing, and that window is written", () => {
  const run = (holdsWriter: boolean) => {
    const db = database();
    // Ledger and reference valuation ready; then every window is computed again.
    settle(db);
    db.exec("DELETE FROM window_usage");
    markWindowUsageDirty(db, { provider: "codex", account: "codex1", counter: COUNTER, fromMs: 0 });
    // How many writer checks a turn makes up to the first window: one window per turn with no budget left.
    let checks = 0;
    advanceWindowUsage(db, { rateCards: card, budgetMs: 0, canWrite: () => { checks++; return true; }, stats: emptyWindowUsageStats() });
    db.exec("DELETE FROM window_usage");
    markWindowUsageDirty(db, { provider: "codex", account: "codex1", counter: COUNTER, fromMs: 0 });
    // The same turn again with time to spare; the request arrives while the first window is being computed.
    let calls = 0;
    const result = advanceWindowUsage(db, { rateCards: card, budgetMs: 1e9, canWrite: () => ++calls < checks,
      ...(holdsWriter ? { holdsWriter: () => true } : {}) });
    return { rows: (db.query("SELECT COUNT(*) n FROM window_usage").get() as { n: number }).n, pending: result.pending };
  };
  expect(run(true)).toEqual({ rows: 1, pending: true });
  // Without the holder's answer the computed window was dropped and computed again on the next turn.
  expect(run(false)).toEqual({ rows: 0, pending: true });
});
