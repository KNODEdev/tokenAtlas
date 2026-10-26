import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "../../src/db/sqlite";
import { codexCallsScene, card, openedDatabases } from "../../src/server/codex-window-calls.fixture";
import { prepareCodexLedgerFixture } from "../../src/server/codex-ledger.fixture";
import { subscriptionDeclarations } from "../../src/server/capacity-equivalents";
import { readModelCacheHistory } from "../../src/server/model-cache-history";
import { readTiboMeasurements } from "./read-tibo-measurements";

afterEach(() => { for (const db of openedDatabases.splice(0)) db.close(); });
function scene() {
  const { db, base } = codexCallsScene();
  db.exec("ALTER TABLE events ADD COLUMN resp_ms INTEGER");
  db.exec("UPDATE events SET ts=strftime('%Y-%m-%dT%H:%M:%fZ',ts,'+30 days'),resp_ms=2000 + rowid * 13");
  prepareCodexLedgerFixture(db, card, base.homeToSubId!);
  const accounts = { version: 2 as const, sources: subscriptionDeclarations(base.homeToSubId!),
    subscriptions: ["acct", "before", "other"].map(id => ({ id, vendor: "codex" })) };
  return { db, base, ctx: { sqlite: db, rateCards: card, accounts } };
}
const totals = (rows: { input: number; cached: number; calls: number }[]) => rows.reduce((s, row) =>
  ({ input: s.input + row.input, cached: s.cached + row.cached, calls: s.calls + row.calls }), { input: 0, cached: 0, calls: 0 });

test("challenge cache and ownership agree with the production cache reader, including unpriced models and business isolation", () => {
  const { ctx } = scene();
  for (const account of ["acct", "other", "acct::business"]) {
    const result = readTiboMeasurements(ctx, account);
    expect(result.hours.every(row => row.account.toLowerCase() === account)).toBe(true);
    for (const model of ["gpt-6-astra", "not-shipped-model", "codex-auto-review"]) {
      const reference = readModelCacheHistory(ctx, { account, model, since: "2026-10-10", until: "2026-10-13" });
      expect(totals(result.hours.filter(row => row.model === model))).toEqual(totals(reference.hours));
    }
  }
  const all = readTiboMeasurements(ctx, "__all__");
  expect(all.hours.length).toBeGreaterThan(0);
  expect(all.hours.some(row => row.timed > 0)).toBe(true);
  expect(all.hours.some(row => row.mode === null)).toBe(true);
  expect(all.hours.every(row => row.plan === null)).toBe(true);
  const invalid = ctx.sqlite.query("SELECT COUNT(*) n FROM codex_price_ledger_events WHERE copy_state='canonical' AND admitted=1 AND invalid_tokens>0").get() as { n: number };
  expect(invalid.n).toBeGreaterThan(0);
  expect(all.excludedCalls).toBe(invalid.n);
});

test("readonly restart repeats the actual reader without writes, repricing or raw events", () => {
  const { ctx, db } = scene(), expected = readTiboMeasurements(ctx, "acct");
  // Everything the screen needs is already published. A new read does not parse source events.
  db.exec("DROP TABLE events");
  const readonly = Database.deserialize(db.serialize(), { readonly: true });
  try {
    const changes = () => (readonly.query("SELECT total_changes() n").get() as { n: number }).n;
    const before = changes();
    expect(readTiboMeasurements({ ...ctx, sqlite: readonly }, "acct")).toEqual(expected);
    expect(changes()).toBe(before);
  } finally { readonly.close(); }
});

test("corrected stored data agrees with cache and a fresh full-reference publication without changing unrelated accounts", () => {
  const { ctx, db, base } = scene();
  const other = readTiboMeasurements(ctx, "other");
  db.query("UPDATE events SET cached_in=0 WHERE home='c:/own' AND rowid=(SELECT MIN(rowid) FROM events WHERE home='c:/own')").run();
  prepareCodexLedgerFixture(db, card, base.homeToSubId!);
  expect(readTiboMeasurements(ctx, "other")).toEqual(other);
  const actual = readTiboMeasurements(ctx, "acct");
  const models = [...new Set(actual.hours.map(row => row.model))].filter((m): m is string => m !== null);
  for (const model of models) expect(totals(actual.hours.filter(row => row.model === model))).toEqual(totals(readModelCacheHistory(ctx,
    { account: "acct", model, since: "2026-10-10", until: "2026-10-13" }).hours));
  const reference = Database.deserialize(db.serialize());
  try {
    // A fresh fixture handle has no producer memo and refills every canonical cohort from frozen raw facts.
    prepareCodexLedgerFixture(reference, card, base.homeToSubId!);
    expect(readTiboMeasurements({ ...ctx, sqlite: reference }, "acct")).toEqual(actual);
  } finally { reference.close(); }
});

test("dated plan history overrides event stamps and a cohort spanning a plan edge is excluded", () => {
  const { ctx, db, base } = scene();
  db.exec(`CREATE TABLE plan_periods(id INTEGER PRIMARY KEY,provider TEXT,account TEXT,from_ts TEXT,until_ts TEXT,plan TEXT,
    origin TEXT,first_seen TEXT,last_seen TEXT,readings INTEGER,evidence TEXT,amount_minor INTEGER,currency TEXT)`);
  db.exec(`INSERT INTO plan_periods VALUES(1,'codex','acct','2026-09-01',NULL,'plus','declared',NULL,NULL,0,'fixture',NULL,NULL)`);
  const dated = readTiboMeasurements(ctx, "acct");
  expect(dated.hours.length).toBeGreaterThan(0);
  expect(dated.hours.every(row => row.plan === "plus")).toBe(true);
  const columns = (db.query("PRAGMA table_info(events)").all() as { name: string }[]).map(row => row.name);
  const original = db.query("SELECT * FROM events WHERE home='c:/own' AND cached_in <= in_tok AND speed='standard' LIMIT 1").get() as Record<string, unknown>;
  const insert = db.query(`INSERT INTO events(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
  for (const [index, ts] of ["2026-10-13T08:10:00Z", "2026-10-13T08:50:00Z"].entries()) {
    const values: Record<string, unknown> = { ...original, path: 'c:/own/plan-crossing.jsonl', ts, source_offset: 100_000 + index };
    insert.run(...columns.map(column => values[column]) as (string | number | null)[]);
  }
  prepareCodexLedgerFixture(db, card, base.homeToSubId!);
  const before = readTiboMeasurements(ctx, "acct");
  db.exec(`UPDATE plan_periods SET until_ts='2026-10-13T08:30:00Z';
    INSERT INTO plan_periods VALUES(2,'codex','acct','2026-10-13T08:30:00Z',NULL,'pro','declared',NULL,NULL,0,'fixture',NULL,NULL)`);
  const after = readTiboMeasurements(ctx, "acct");
  expect(after.excludedCalls - before.excludedCalls).toBe(2);
  expect(after.hours.filter(row => row.at === Date.parse("2026-10-13T08:00:00Z"))).toEqual([]);
});
