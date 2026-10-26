import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "./sqlite";
import { applyDrizzleMigrations } from "./migrate";
import { BILLING_CYCLES_SCHEMA_SQL } from "./billing-cycles";
import { PLAN_PERIODS, loadPeriods, replaceDeclaredPeriods } from "./period-store";
import { parsePeriodDeclarations } from "../server/period-declarations";
import type { DatedPeriod } from "../server/account-periods";

function migrated(): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  return db;
}
const tables = (db: Database) => (db.query("SELECT name, sql FROM sqlite_master WHERE name IN ('billing_cycles','billing_cycle_dirty') ORDER BY name").all() as Array<{ name: string; sql: string }>)
  .map((row) => [row.name, row.sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "")]);

test("migration 0073 adds the billing tables as the schema module declares them, and the plan columns", () => {
  const db = migrated(), reference = new Database(":memory:");
  reference.exec(BILLING_CYCLES_SCHEMA_SQL);
  expect(tables(db)).toEqual(tables(reference));
  const columns = (db.query("SELECT name FROM pragma_table_info('plan_periods')").all() as Array<{ name: string }>).map((c) => c.name);
  expect(columns).toContain("anchor_ts");
  expect(columns).toContain("cycle_months");
  expect(fs.readFileSync(path.resolve(import.meta.dir, "../../drizzle/0073_billing_cycles.sql"), "utf8")).toContain("ALTER TABLE plan_periods ADD COLUMN anchor_ts TEXT");
});

const plan = (account: string, value: string, from: string, until: string | null, extra: Partial<DatedPeriod> = {}): DatedPeriod => ({
  provider: "claude", subject: account, from, until, value, origin: "declared", firstSeen: null, lastSeen: null, readings: 0,
  evidence: "payment", ...extra });
const dirty = (db: Database) => db.query("SELECT provider, account, from_ms, until_ms FROM billing_cycle_dirty ORDER BY account").all();

test("declared anchors and annual cycles round-trip through the table; a change marks only that account's cycles from its start", () => {
  const db = migrated();
  replaceDeclaredPeriods(db, PLAN_PERIODS, [plan("acc-a", "max-20x", "2026-09-24T09:55:57.164Z", null, { anchor: "2026-09-12T13:35:26.181Z" }),
    plan("acc-b", "pro", "2026-01-15", null, { cycleMonths: 12 })]);
  expect(loadPeriods(db, PLAN_PERIODS).map((p) => [p.subject, p.anchor ?? null, p.cycleMonths ?? null]))
    .toEqual([["acc-a", "2026-09-12T13:35:26.181Z", null], ["acc-b", null, 12]]);
  db.exec("DELETE FROM billing_cycle_dirty");
  // Only the anchor of acc-a moves: acc-a's cycles from the earlier of the old and new anchor; acc-b untouched.
  replaceDeclaredPeriods(db, PLAN_PERIODS, [plan("acc-a", "max-20x", "2026-09-24T09:55:57.164Z", null, { anchor: "2026-09-24T09:55:57.164Z" }),
    plan("acc-b", "pro", "2026-01-15", null, { cycleMonths: 12 })]);
  expect(dirty(db)).toEqual([{ provider: "claude", account: "acc-a", from_ms: Date.parse("2026-09-12T13:35:26.181Z"), until_ms: null }]);
  // An unchanged file changes nothing.
  db.exec("DELETE FROM billing_cycle_dirty");
  expect(replaceDeclaredPeriods(db, PLAN_PERIODS, [plan("acc-a", "max-20x", "2026-09-24T09:55:57.164Z", null, { anchor: "2026-09-24T09:55:57.164Z" }),
    plan("acc-b", "pro", "2026-01-15", null, { cycleMonths: 12 })])).toBe(false);
  expect(dirty(db)).toEqual([]);
});

test("the declarations file accepts an anchor and a cycle length and refuses bad ones", () => {
  const row = (extra: Record<string, unknown>) => JSON.stringify({ version: 1, plans: [{ provider: "claude", account: "acc", plan: "max-5x",
    from: "2026-09-12T13:35:26.181Z", until: null, evidence: "payment", ...extra }] });
  const good = parsePeriodDeclarations(row({ anchor: "2026-09-09", cycle_months: 12 }));
  expect(good.errors).toEqual([]);
  expect(good.plans.map((p) => [p.anchor, p.cycleMonths])).toEqual([["2026-09-09", 12]]);
  expect(parsePeriodDeclarations(row({})).plans[0]).not.toHaveProperty("anchor");
  expect(parsePeriodDeclarations(row({ anchor: "soon" })).errors).toEqual(["plans[0]: nieprawidłowa data odnowienia \"anchor\": 'soon'"]);
  expect(parsePeriodDeclarations(row({ cycle_months: 3 })).errors).toEqual(['plans[0]: "cycle_months" musi być 1 (miesięczny) albo 12 (roczny)']);
});
