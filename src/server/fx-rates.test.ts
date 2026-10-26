import { afterEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "../db/sqlite";
import { applyDrizzleMigrations } from "../db/migrate";
import { FX_RATES_SCHEMA_SQL, readFxRates } from "../db/fx-rates";
import { PLAN_PERIODS, replaceDeclaredPeriods } from "../db/period-store";
import { advanceBillingCycles, computeBillingCyclesFull, resetBillingCycleClock } from "./billing-cycle-producer";
import { buildBillingCyclesView } from "./billing-cycles-view";
import { advanceFxRates, fetchNbpRates, fxRateNeeds, resetFxRatesState, settleFxRates } from "./fx-rates";
import { CATALOG } from "./billing-cycles.fixture";

const NOW = Date.parse("2026-10-18T12:00:00Z");
afterEach(() => resetFxRatesState());

function database(): Database {
  const db = new Database(":memory:");
  applyDrizzleMigrations(drizzle(db));
  return db;
}
/** codex1 pays 813 PLN a month from 16.09 (repeated on 16.10); codex2 pays in USD. */
function seed(db: Database) {
  const row = (account: string, amountMinor: number, currency: string) => ({ provider: "codex", subject: account, from: "2026-09-16", until: null,
    value: "pro", origin: "declared" as const, firstSeen: null, lastSeen: null, readings: 0, evidence: "invoice", amountMinor, currency });
  replaceDeclaredPeriods(db, PLAN_PERIODS, [row("codex1", 81300, "PLN"), row("codex2", 20000, "USD")]);
}
/** NBP answers for USD: tables of 15.09 (3.6512) and 15.10 (3.7); every request is recorded. */
function nbp(requests: string[]) {
  const tables = [{ no: "179/A/NBP/2026", effectiveDate: "2026-09-15", mid: 3.6512 }, { no: "200/A/NBP/2026", effectiveDate: "2026-10-15", mid: 3.7 }];
  return async (url: string) => {
    requests.push(url);
    const [, currency, from, until] = url.match(/rates\/a\/(\w+)\/([\d-]+)\/([\d-]+)/)!;
    const rates = currency === "usd" ? tables.filter((t) => t.effectiveDate >= from! && t.effectiveDate <= until!) : [];
    return { ok: rates.length > 0, status: rates.length ? 200 : 404, json: async () => ({ rates }) };
  };
}
const prices = (db: Database) => buildBillingCyclesView(db, { provider: "codex", account: "codex1" }, NOW).accounts[0]!.cycles
  .map((cycle) => [cycle.start.slice(0, 10), cycle.price.amount, cycle.price.currency, cycle.price.source, cycle.price.usd]);

test("migration 0083 creates fx_rates as the schema module declares it", () => {
  const db = database(), reference = new Database(":memory:");
  reference.exec(FX_RATES_SCHEMA_SQL);
  const sql = (d: Database) => (d.query("SELECT sql FROM sqlite_master WHERE name='fx_rates'").get() as { sql: string }).sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "");
  expect(sql(db)).toBe(sql(reference));
});

test("a PLN payment without a rate is unknown in USD; the job fetches the rate of the day before, stores it and the cycles convert", async () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  // Repeated, never 0 and never the catalog's USD; its dollars wait for the rate.
  expect(prices(db)).toEqual([["2026-09-16", 813, "PLN", "declared", null], ["2026-10-16", 813, "PLN", "repeated", null]]);
  expect(fxRateNeeds(db)).toEqual([{ currency: "USD", day: "2026-09-16" }, { currency: "USD", day: "2026-10-16" }]);

  const requests: string[] = [];
  const first = advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp(requests) });
  expect(first).toMatchObject({ stored: 0, waiting: 2, fetching: true });
  await settleFxRates();
  // One request for both days of one currency, looking back 14 days.
  expect(requests).toEqual(["https://api.nbp.pl/api/exchangerates/rates/a/usd/2026-09-02/2026-10-15/?format=json"]);
  expect(advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp(requests) })).toMatchObject({ stored: 2, waiting: 0 });
  expect([...readFxRates(db).values()].map((r) => [r.forDay, r.plnPerUnit, r.effectiveDay, r.tableNo]))
    .toEqual([["2026-09-16", 3.6512, "2026-09-15", "179/A/NBP/2026"], ["2026-10-16", 3.7, "2026-10-15", "200/A/NBP/2026"]]);

  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  expect(prices(db)).toEqual([["2026-09-16", 813, "PLN", "declared", 222.67], ["2026-10-16", 813, "PLN", "repeated", 219.73]]);
  const cycle = buildBillingCyclesView(db, { provider: "codex", account: "codex1" }, NOW).accounts[0]!.cycles[1]!;
  expect(cycle.price.fx).toEqual({ currency: "PLN", day: "2026-10-16", rate: 1, usd_rate: 3.7, effective_day: "2026-10-15", table: "200/A/NBP/2026" });
  expect(cycle.flags).not.toContain("fx_rate_missing");
  // The USD account never needed a rate.
  expect(buildBillingCyclesView(db, { provider: "codex", account: "codex2" }, NOW).accounts[0]!.cycles.map((c) => c.price.usd)).toEqual([200, 200]);

  // Incremental equals the full reference; a later turn (restart) asks nothing again and changes no row.
  const stored = db.query("SELECT * FROM billing_cycles ORDER BY account, start_ts").all();
  const strip = (rows: unknown[]) => rows.map((row) => ({ ...(row as object), computed_at: null }));
  expect(strip(stored)).toEqual(strip(computeBillingCyclesFull(db, { catalog: CATALOG, now: NOW })));
  resetFxRatesState();
  resetBillingCycleClock();
  expect(advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp(requests) })).toMatchObject({ stored: 0, waiting: 0, fetching: false });
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  expect(requests.length).toBe(1);
  expect(strip(db.query("SELECT * FROM billing_cycles ORDER BY account, start_ts").all())).toEqual(strip(stored));
});

test("offline: the request fails, the dollars stay unknown and the day is asked again only after the retry time", async () => {
  const db = database();
  seed(db);
  resetBillingCycleClock();
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  let calls = 0;
  const offline = async () => { calls++; throw new Error("network down"); };
  advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: offline });
  await settleFxRates();
  expect(advanceFxRates(db, { canWrite: () => true, now: NOW + 60_000, fetchImpl: offline })).toMatchObject({ stored: 0, waiting: 0, error: "network down" });
  expect(calls).toBe(1);
  expect(prices(db).map((row) => row[4])).toEqual([null, null]);
  advanceFxRates(db, { canWrite: () => true, now: NOW + 16 * 60_000, fetchImpl: offline });
  await settleFxRates();
  expect(calls).toBe(2);
  // No network at all: nothing is requested.
  resetFxRatesState();
  expect(advanceFxRates(db, { canWrite: () => true, now: NOW, network: false, fetchImpl: offline })).toMatchObject({ fetching: false });
  expect(calls).toBe(2);
});

test("a failed range keeps the others; a failed write keeps the fetched rates for the next turn", async () => {
  const answer = async (url: string) => url.includes("/eur/") ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ rates: [{ no: "1", effectiveDate: "2026-10-15", mid: 3.7 }] }) };
  const errors: unknown[] = [];
  const rates = await fetchNbpRates([{ currency: "EUR", day: "2026-10-16" }, { currency: "USD", day: "2026-10-16" }], answer, (error) => errors.push(error));
  expect(rates.map((r) => [r.currency, r.plnPerUnit])).toEqual([["USD", 3.7]]);
  expect(errors.length).toBe(1);

  const db = database();
  seed(db);
  resetBillingCycleClock();
  advanceBillingCycles(db, { catalog: CATALOG, now: NOW, budgetMs: 10_000 });
  const requests: string[] = [];
  advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp(requests) });
  await settleFxRates();
  db.run("DROP TABLE fx_rates");
  db.run("CREATE TABLE fx_rates (currency TEXT NOT NULL CHECK(currency = 'none'), for_day TEXT, pln_per_unit REAL, effective_day TEXT, source TEXT, table_no TEXT, fetched_at TEXT)");
  expect(() => advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp(requests) })).toThrow();
  db.run("DROP TABLE fx_rates");
  db.exec(FX_RATES_SCHEMA_SQL);
  // Stored on the next turn without a new request.
  expect(advanceFxRates(db, { canWrite: () => true, now: NOW, fetchImpl: nbp(requests) })).toMatchObject({ stored: 2 });
  expect(requests.length).toBe(1);
});

test("a weekend or holiday payment takes the last table before it; a cross-currency payment needs both rates", async () => {
  const requests: string[] = [];
  const answer = async (url: string) => {
    requests.push(url);
    const eur = url.includes("/eur/");
    return { ok: true, status: 200, json: async () => ({ rates: [{ no: "1", effectiveDate: "2026-12-23", mid: eur ? 4.2 : 3.9 },
      { no: "2", effectiveDate: "2026-12-24", mid: eur ? 4.21 : 3.91 }] }) };
  };
  const rates = await fetchNbpRates([{ currency: "USD", day: "2026-12-27" }, { currency: "EUR", day: "2026-12-27" }, { currency: "USD", day: "2026-12-24" }], answer);
  expect(rates.map((r) => [r.currency, r.forDay, r.effectiveDay, r.plnPerUnit])).toEqual([
    ["USD", "2026-12-24", "2026-12-23", 3.9], ["USD", "2026-12-27", "2026-12-24", 3.91], ["EUR", "2026-12-27", "2026-12-24", 4.21]]);
  expect(requests.length).toBe(2);
});
