import { expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { billingContextPrice, contextPriceOfSpan, readContextRows } from "./context-price-read";
import { storedContextPrice } from "../shared/context-price";
import type { WindowUsage } from "../shared/codex-accounting";

const ts = (hour: number) => `2026-10-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
function usage(stored: number, extra: number, normalized = stored): WindowUsage {
  return { events: 1, tokens: 100, priced_tokens: 100, unpriced_events: 0, api_standard: stored,
    api_normalized: normalized, context_api_base: normalized, context_api_extra: extra,
    context_priced_tokens: 100 } as WindowUsage;
}
function row() {
  return { start_ts: ts(0), end_ts: ts(6), reset_ts: ts(6), start_drop: null,
    cycle: JSON.stringify({ usage: usage(60, 12), cycle_usage: usage(100, 50) }),
    readings: JSON.stringify([{ ts: ts(1), usage: usage(20, 2) }, { ts: ts(3), usage: usage(60, 12) }, { ts: ts(5), usage: usage(100, 50) }]),
    meter: JSON.stringify([{ ts: ts(1), percent: 10, source: "probe" }, { ts: ts(3), percent: 100, source: "probe" }, { ts: ts(5), percent: 100, source: "probe" }]) };
}

test("whole windows and paired reading spans use different stored splits", () => {
  expect(contextPriceOfSpan([row()], ts(0), ts(6), false)).toEqual({ base: 100, extra: 50, stored: 100 });
  const afterFirst = new Date(Date.parse(ts(1)) + 1).toISOString();
  expect(contextPriceOfSpan([row()], afterFirst, ts(3), true)).toEqual({ base: 40, extra: 10, stored: 40 });
  expect(contextPriceOfSpan([row()], ts(2), ts(3), true)).toBeUndefined();
  expect(contextPriceOfSpan([row()], afterFirst, ts(3), false)).toBeUndefined();
});

test("billing uses paired usage, holding running sums at the first limit reading", () => {
  expect(billingContextPrice([row()], ts(0), ts(6), 60)).toEqual({ base: 60, extra: 12, stored: 60 });
  expect(billingContextPrice([row()], ts(2), ts(4), 40)).toEqual({ base: 40, extra: 10, stored: 40 });
  expect(billingContextPrice([row()], ts(4), ts(6), 0)).toEqual({ base: 0, extra: 0, stored: 0 });
  expect(billingContextPrice([row()], ts(0), ts(6), 70)).toBeUndefined();
});

test("partial classification, missing windows and corrections cannot label stale amounts", () => {
  const incomplete = row(), cycle = JSON.parse(incomplete.cycle);
  cycle.usage.context_priced_tokens = 99;
  cycle.cycle_usage.context_priced_tokens = 99;
  incomplete.cycle = JSON.stringify(cycle);
  expect(billingContextPrice([incomplete], ts(0), ts(6), 60)).toBeUndefined();
  expect(contextPriceOfSpan([incomplete], ts(0), ts(6), false)).toBeUndefined();
  expect(billingContextPrice([{ ...row(), cycle: null }], ts(0), ts(6), 60)).toBeUndefined();
  expect(storedContextPrice(usage(100, 5, 10))).toEqual({ base: 100, extra: 50, stored: 100 });
});

test("mixed normalization subtracts the stored split before scaling a boundary part to Standard dollars", () => {
  const stored = row();
  stored.readings = JSON.stringify([{ ts: ts(1), usage: usage(20, 1, 10) }, { ts: ts(3), usage: usage(100, 10, 20) }]);
  const afterFirst = new Date(Date.parse(ts(1)) + 1).toISOString();
  const expected = { base: 80, extra: 72, stored: 80 }; // (10 + 9) normalized / 10 × $80 Standard.
  expect(contextPriceOfSpan([stored], afterFirst, ts(3), true)).toEqual(expected);
  expect(billingContextPrice([stored], ts(2), ts(4), 80)).toEqual(expected);
});

test("the split reader works with only stored window tables, scopes account/counter and writes nothing", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE limit_windows(provider,account,counter,window_id,start_ts,end_ts,reset_ts,readings,start_drop);
      CREATE TABLE window_usage(provider,account,counter,window_id,cycle,readings);`);
    const stored = row();
    for (const [account, counter] of [["one", "weekly"], ["one", "5h"], ["two", "weekly"]] as const) {
      db.query("INSERT INTO limit_windows VALUES('codex',?,?,?, ?,?,?,?,?)")
        .run(account!, counter!, account + counter, stored.start_ts, stored.end_ts, stored.reset_ts, stored.meter, stored.start_drop);
      db.query("INSERT INTO window_usage VALUES('codex',?,?,?,?,?)").run(account!, counter!, account + counter, stored.cycle, stored.readings);
    }
    const changes = db.query("SELECT total_changes() n").get();
    for (let i = 0; i < 2; i++) {
      const rows = readContextRows(db, "one", "weekly", ts(0), ts(6));
      expect(rows).toHaveLength(1);
      expect(contextPriceOfSpan(rows, ts(0), ts(6), false)).toEqual({ base: 100, extra: 50, stored: 100 });
    }
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally { db.close(); }
});
