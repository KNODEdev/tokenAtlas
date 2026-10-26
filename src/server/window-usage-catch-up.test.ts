import { afterEach, expect, test } from "bun:test";
import { advanceWindowUsage } from "./window-usage";
import { addEvent, card, COUNTER, database, opened, publishLedger, settle } from "./window-usage-codex.fixture";
import { markWindowUsageDirty, WINDOW_USAGE_ALL, WINDOW_USAGE_BEGINNING } from "../db/window-usage";

/** The trial start of 05.10: Codex window sums must catch up with each sync cycle (plan U4.4 follow-up). */
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const rows = (db: ReturnType<typeof database>) => db.query("SELECT window_id, cycle FROM window_usage ORDER BY window_id").all();

test("window sums wait while the Codex ledger has not taken in new calls, then store the new totals", () => {
  const db = database();
  settle(db);
  const before = rows(db);
  // A sync published a call the ledger has not priced yet: the facts are newer than the ledger.
  addEvent(db, { ts: "2026-09-16T06:00:00.000Z" });
  db.exec("UPDATE usage_ledger_state SET covered=-1 WHERE provider='codex'");
  db.exec("CREATE TABLE IF NOT EXISTS vendor_sync_revisions(vendor TEXT PRIMARY KEY, data_revision INTEGER)");
  db.exec("INSERT INTO vendor_sync_revisions VALUES('codex', 99) ON CONFLICT(vendor) DO UPDATE SET data_revision=99");
  markWindowUsageDirty(db, { provider: "codex", account: "codex1", counter: COUNTER, fromMs: Date.parse("2026-09-16T06:00:00.000Z") });
  const waiting = advanceWindowUsage(db, { rateCards: card, budgetMs: 1e9 });
  expect(waiting).toEqual({ progressed: false, pending: true });
  expect(rows(db)).toEqual(before);
  // The ledger catches up and republishes the call's hour.
  publishLedger(db, card);
  settle(db);
  const open = db.query("SELECT cycle FROM window_usage WHERE start_ts>='2026-09-15' ").get() as { cycle: string };
  expect(JSON.parse(open.cycle).cycle_usage.events).toBe(2);
});

test("open windows and windows without a stored row are computed before recomputations of closed windows", () => {
  const db = database();
  settle(db);
  db.exec("DELETE FROM window_usage WHERE start_ts<'2026-09-08'");
  markWindowUsageDirty(db, { provider: "codex", account: WINDOW_USAGE_ALL, fromMs: WINDOW_USAGE_BEGINNING });
  // One window per turn: the open window first, then the one without a row, then the closed window with a row.
  const order: string[] = [];
  for (let turn = 0; turn < 10; turn++) {
    // Queued work not yet turned into pending windows (the first turn applies it) covers every window.
    const before = new Set((db.query(`SELECT window_id FROM window_usage_pending UNION
      SELECT window_id FROM limit_windows WHERE EXISTS(SELECT 1 FROM window_usage_dirty)`).all() as Array<{ window_id: string }>).map(row => row.window_id));
    const result = advanceWindowUsage(db, { rateCards: card, budgetMs: 0, nowMs: Date.parse("2026-09-16T12:00:00.000Z") });
    const after = new Set((db.query("SELECT window_id FROM window_usage_pending").all() as Array<{ window_id: string }>).map(row => row.window_id));
    order.push(...[...before].filter(id => !after.has(id)));
    if (!result.pending) break;
  }
  const start = (id: string) => (db.query("SELECT start_ts FROM limit_windows WHERE window_id=?").get(id) as { start_ts: string }).start_ts;
  expect(order.map(start)).toEqual(["2026-09-15T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z"]);
});

