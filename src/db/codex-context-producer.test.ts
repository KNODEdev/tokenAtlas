import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, valueCodexLedgerBand } from "./codex-price-ledger";
import { contextAmount, processCodexContextBatch, readCodexContextState } from "./codex-context-producer";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { readCodexContextPrices } from "../server/codex-context-read";
import { advanceCodexContextPrices } from "../server/codex-context-producer";
import { add, decimal, equal, rational } from "./price-ledger-exact";

const evidence = { verified_at: "2026-01-01", confidence: "official" as const, sources: ["https://example.test/pricing"] };
const policy = (premium = false): CodexLedgerPolicy => ({ version: 1, long_context_premium: premium, tiers: ["standard", "fast"],
  mappings: [{ id: "default", raw_value: "default", tier: "standard" }], tier_rules: [],
  base_rules: ["m", "other", "zero"].map(model => ({ id: `${model}-api`, model, billing_basis: "api_equivalent_usd",
    valid_from: "2026-01-01", rates: { in_uncached: model === "zero" ? "0" : "1", in_cache_read: "0.1", in_cache_write: "1.25", out_total: "5" },
    multiplier: "1", long_context: { above_input_tokens: 1000, rates: { in_uncached: "2", in_cache_read: "0.2", in_cache_write: "2.5", out_total: "7.5" } }, ...evidence })) });
const connections: Database[] = [];
afterEach(() => connections.splice(0).forEach(db => db.close(true)));
function fixture(input = policy()) {
  const db = new Database(":memory:"); connections.push(db);
  createCodexLedgerSchema(db);
  db.exec(fs.readFileSync(new URL("../../drizzle/0086_codex_context_prices.sql", import.meta.url), "utf8"));
  db.query("INSERT INTO usage_ledger_state(provider,version,phase,status,covered,bookmark,rules_digest,rules_json) VALUES('codex',1,'reconcile','ready',0,'','fixture',?)").run(JSON.stringify(input));
  const compiled = compileCodexLedgerPolicy(input);
  function seed(options: { input?: number; cached?: number; writes?: number; out?: number; model?: string; raw?: string | null;
    day?: string; state?: string; reason?: string; offset?: boolean } = {}) {
    const model = options.model ?? "m", raw = options.raw === undefined ? "default" : options.raw;
    const dim = db.query("INSERT INTO codex_price_ledger_dims(key,model,service_tier,source,home,surface) VALUES(?,?,?,'source','home','cli') RETURNING id").get(String(Math.random()), model, raw) as { id: number };
    const n = options.input ?? 1001, cached = options.cached ?? 0, writes = options.writes ?? 0, out = options.out ?? 10;
    const day = options.day ?? "2026-09-01", ts = `${day}T12:00:00${options.offset ? '+02:00' : 'Z'}`;
    const row = db.query(`INSERT INTO codex_price_ledger_events(copy_id,source_offset,dim_id,ts,day,instant_ms,admitted,
      in_tok,cached_in,cache_write,out_tok,reported,uncached,cached,writes,output,reasoning,window_input,window_cached,window_output,
      invalid_tokens,common_reason,credit_reason,copy_state) VALUES(1,?,?,?, ?,?,1,?,?,?,?,?,?,?,?,?,0,?,?,?,0,?,'missing_rate',?) RETURNING id`)
      .get(dim.id, dim.id, ts, day, Date.parse(ts), n, cached, writes, out, n + out, n - cached - writes, cached, writes, out,
        n, cached, out, options.reason ?? null, options.state ?? "canonical") as { id: number };
    db.transaction(() => { for (const band of compiled.baseBands) valueCodexLedgerBand(db, band, [row.id]); })();
    return row.id;
  }
  function drain(next = compiled, limit = 2) {
    let total = 0;
    for (let i = 0; i < 10000; i++) {
      const result = processCodexContextBatch(db, { policy: next, limit }); total += result.eventsWritten;
      if (!result.pending) return total;
    }
    throw new Error("Did not finish");
  }
  const event = (id: number) => db.query("SELECT * FROM codex_context_events WHERE event_id=?").get(id) as import("./codex-context-producer").ContextEvent;
  return { db, seed, compiled, drain, event };
}
const changes = (db: Database) => db.query("SELECT total_changes() n").get();

for (const n of [999, 1000, 1001]) test(`strict request threshold ${n}`, () => {
  const f = fixture(), id = f.seed({ input: n }); f.drain();
  expect(contextAmount(f.event(id), "extra")!.n > 0n).toBe(n > 1000);
  expect(f.event(id).long_tokens).toBe(n > 1000 ? String(n + 10) : "0");
});
test("disjoint cached read/write and output buckets use exact dated arithmetic", () => {
  const f = fixture(), id = f.seed({ input: 2000, cached: 1000, writes: 400, out: 100 }); f.drain();
  expect(equal(contextAmount(f.event(id), "base")!, decimal("0.0017"))).toBe(true);
  expect(equal(contextAmount(f.event(id), "extra")!, decimal("0.00145"))).toBe(true);
});
test("missing model and missing cache-write rates stay unknown", () => {
  const p = policy(); delete p.base_rules[0]!.rates.in_cache_write; delete p.base_rules[0]!.long_context!.rates.in_cache_write;
  const f = fixture(p), a = f.seed({ model: "missing" }), b = f.seed({ writes: 10 }); f.drain();
  expect(f.event(a).base_n).toBeNull(); expect(f.event(a).reason).toBe("missing_rate");
  expect(f.event(b).extra_n).toBeNull(); expect(f.event(b).reason).toBe("missing_cache_write_rate");
  const sum = readCodexContextPrices(f.db); expect(sum.extra).toBeNull(); expect(sum.missingCalls).toBe(2);
});
test("unknown and unmapped modes preserve Standard split and quality", () => {
  const f = fixture(); f.seed({ raw: null }); f.seed({ raw: "mystery" }); f.drain();
  const sum = readCodexContextPrices(f.db); expect(sum.unknownModeCalls).toBe(2); expect(sum.missingCalls).toBe(0); expect(sum.extra!.n).toBeGreaterThan(0n);
});
for (const included of [false, true]) test(`stored premium included=${included} is recorded per published band`, () => {
  const f = fixture(policy(included)), id = f.seed(); f.drain(); const row = f.event(id);
  expect(row.included).toBe(included ? 1 : 0);
  expect(equal(contextAmount(row, "stored")!, included ? add(contextAmount(row, "base")!, contextAmount(row, "extra")!) : contextAmount(row, "base")!)).toBe(true);
});
test("zero values are priced zeros; mixed cohorts reconcile both grains", () => {
  const f = fixture(); f.seed({ model: "zero", input: 0, out: 0 }); f.seed({ input: 999 }); f.seed({ input: 2000 }); f.drain();
  const day = readCodexContextPrices(f.db), hour = readCodexContextPrices(f.db, { grain: "hour" });
  expect(day.calls).toBe(3); expect(day.extra).toEqual(hour.extra); expect(day.base).toEqual(hour.base);
  expect(readCodexContextPrices(f.db, { models: ["zero"] }).base).toEqual(rational(0n));
});
test("duplicate/conflict copies never count; canonical replacement removes old contribution", () => {
  const f = fixture(), a = f.seed(), b = f.seed({ state: "duplicate" }); f.seed({ state: "conflict" }); f.drain();
  expect(readCodexContextPrices(f.db).calls).toBe(1);
  const before = readCodexContextPrices(f.db).extra;
  f.db.query("UPDATE codex_price_ledger_events SET copy_state='duplicate' WHERE id=?").run(a);
  f.db.query("UPDATE codex_price_ledger_events SET copy_state='canonical' WHERE id=?").run(b);
  f.drain(); expect(readCodexContextPrices(f.db).extra).toEqual(before); expect(f.event(a)).toBeNull();
});
test("interruption resumes a durable checkpoint and unchanged restart writes nothing", () => {
  const f = fixture(); for (let i = 0; i < 5; i++) f.seed();
  expect(processCodexContextBatch(f.db, { policy: f.compiled, limit: 2 }).processed).toBe(2);
  expect(readCodexContextState(f.db)!.filled).toBe(0); expect(readCodexContextPrices(f.db).ready).toBe(false);
  f.drain(); expect(readCodexContextPrices(f.db).calls).toBe(5);
  const before = changes(f.db); expect(f.drain()).toBe(0); expect(changes(f.db)).toEqual(before);
});
test("rate edit invalidates only its model/date scope and preserves stored money", () => {
  const f = fixture(), old = f.seed({ day: "2026-08-01" }), changed = f.seed(), other = f.seed({ model: "other" }); f.drain();
  const frozen = f.db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all();
  const first = f.event(old), unrelated = f.event(other), previous = f.event(changed);
  const next = policy(); const oldRule = next.base_rules[0]!; oldRule.valid_until = "2026-09-01";
  next.base_rules.push({ ...structuredClone(oldRule), id: "m-new", valid_from: "2026-09-01", valid_until: undefined,
    long_context: { above_input_tokens: 1000, rates: { in_uncached: "3", in_cache_read: "0.3", in_cache_write: "3.75", out_total: "10" } } });
  expect(f.drain(compileCodexLedgerPolicy(next))).toBe(1);
  expect(f.event(old)).toEqual(first); expect(f.event(other)).toEqual(unrelated); expect(contextAmount(f.event(changed), "extra")).not.toEqual(contextAmount(previous, "extra"));
  expect(f.db.query("SELECT * FROM codex_price_ledger_events ORDER BY id").all()).toEqual(frozen);
});
test("late correction, deletion, identical retry and null instants update only old/new contributions", () => {
  const f = fixture(), id = f.seed(); f.seed({ day: "2026-09-02" }); f.drain();
  f.db.query("UPDATE codex_price_ledger_events SET day='2026-09-03',instant_ms=NULL WHERE id=?").run(id); f.drain();
  expect(readCodexContextPrices(f.db, { fromDay: "2026-09-01", untilDay: "2026-09-02" }).calls).toBe(0);
  expect(readCodexContextPrices(f.db, { grain: "hour" }).calls).toBe(1);
  const before = changes(f.db); f.db.query("UPDATE codex_price_ledger_events SET day=day WHERE id=?").run(id);
  expect(f.drain()).toBe(0); expect((changes(f.db) as { n: number }).n).toBe((before as { n: number }).n + 1);
  f.db.query("DELETE FROM codex_price_ledger_events WHERE id=?").run(id); f.drain(); expect(readCodexContextPrices(f.db).calls).toBe(1);
});
test("source revision and policy fences reject stale computation without partial publication", () => {
  const f = fixture(); f.seed(); let checked = 0;
  expect(() => processCodexContextBatch(f.db, { policy: f.compiled, policyIsCurrent: () => ++checked < 3 })).toThrow("stale");
  expect(f.db.query("SELECT count(*) n FROM codex_context_events").get()).toEqual({ n: 0 });
  f.drain(); const before = readCodexContextPrices(f.db);
  f.db.query("UPDATE codex_price_ledger_events SET in_tok=in_tok+1").run();
  let writes = 0;
  const hook = () => { if (++writes === 2) f.db.query("UPDATE codex_price_ledger_events SET in_tok=in_tok+1").run(); return true; };
  expect(() => processCodexContextBatch(f.db, { policy: f.compiled, canWrite: hook })).toThrow("stale");
  expect(readCodexContextPrices(f.db).subtotal).toEqual(before.subtotal); f.drain();
});
test("read helper is aggregate-only, bounded by day/hour/source/model, and writes nothing", () => {
  const f = fixture(); f.seed({ day: "2026-09-01", offset: true }); f.seed({ model: "other", day: "2026-09-02" }); f.drain();
  const before = changes(f.db), calls = spyOn(f.db, "query");
  const sum = readCodexContextPrices(f.db, { grain: "hour", fromHour: Date.parse("2026-09-01T10:00:00Z") / 3600000,
    untilHour: Date.parse("2026-09-01T11:00:00Z") / 3600000, sources: ["source"], models: ["m"] });
  expect(sum.calls).toBe(1); expect(changes(f.db)).toEqual(before);
  expect(calls.mock.calls.some(([sql]) => /FROM codex_price_ledger_events/.test(sql))).toBe(false); calls.mockRestore();
});
test("registry entry point resumes without a server, and respects writer yield", () => {
  const f = fixture(); f.seed(); const before = changes(f.db);
  expect(advanceCodexContextPrices(f.db, { canWrite: () => false })).toBeNull(); expect(changes(f.db)).toEqual(before);
  expect(advanceCodexContextPrices(f.db)!.eventsWritten).toBe(1);
  const ready = changes(f.db); expect(advanceCodexContextPrices(f.db)!.eventsWritten).toBe(0); expect(changes(f.db)).toEqual(ready);
});
test("a failed aggregate publication rolls back the event and checkpoint together", () => {
  const f = fixture(); f.seed();
  f.db.exec("CREATE TRIGGER reject_context BEFORE INSERT ON codex_context_aggregates BEGIN SELECT RAISE(ABORT,'fixture interruption'); END");
  expect(() => processCodexContextBatch(f.db, { policy: f.compiled })).toThrow("fixture interruption");
  expect(f.db.query("SELECT count(*) n FROM codex_context_events").get()).toEqual({ n: 0 });
  expect(readCodexContextState(f.db)!.cursor).toBe(-1);
  f.db.exec("DROP TRIGGER reject_context"); f.drain(); expect(readCodexContextPrices(f.db).calls).toBe(1);
});
test("tier mapping edits reclassify read quality without rewriting Standard projections", () => {
  const f = fixture(); f.seed({ raw: "mystery" }); f.drain();
  const next = policy(); next.mappings.push({ id: "mystery", raw_value: "mystery", tier: "standard" });
  f.db.query("UPDATE usage_ledger_state SET rules_json=? WHERE provider='codex'").run(JSON.stringify(next));
  const before = changes(f.db); expect(advanceCodexContextPrices(f.db)!.eventsWritten).toBe(0); expect(changes(f.db)).toEqual(before);
  expect(readCodexContextPrices(f.db).unknownModeCalls).toBe(0);
});
test("a newly published API rule makes reads provisional before its background turn", () => {
  const f = fixture(); f.seed(); f.drain();
  const next = policy(); next.base_rules[0]!.long_context!.rates.in_uncached = "3";
  f.db.query("UPDATE usage_ledger_state SET rules_json=? WHERE provider='codex'").run(JSON.stringify(next));
  expect(readCodexContextPrices(f.db).ready).toBe(false);
  expect(advanceCodexContextPrices(f.db)!.eventsWritten).toBe(1); expect(readCodexContextPrices(f.db).ready).toBe(true);
});
test("an unfinished original rule publication keeps context work provisional", () => {
  const f = fixture(); f.seed(); f.drain();
  f.db.exec("INSERT INTO usage_ledger_dirty(provider,kind,value) VALUES('codex','rules','fixture')");
  const before = changes(f.db);
  expect(advanceCodexContextPrices(f.db)).toMatchObject({ pending: true, processed: 0 });
  expect(changes(f.db)).toEqual(before); expect(readCodexContextPrices(f.db).ready).toBe(false);
});
test("new requests update their own contributions; prior completed projections survive", () => {
  const f = fixture(), first = f.seed({ input: 1000 }); f.drain(); const completed = f.event(first);
  const next = f.seed({ input: 1001, day: "2026-09-02" });
  expect(readCodexContextPrices(f.db).ready).toBe(false);
  expect(f.drain()).toBe(1); expect(f.event(first)).toEqual(completed);
  expect(readCodexContextPrices(f.db).calls).toBe(2); expect(f.event(next).reason).toBeNull();
});
test("invalid evidence and malformed scope bounds remain explicit", () => {
  const f = fixture(); f.seed({ reason: "incomplete_usage" }); f.drain();
  expect(readCodexContextPrices(f.db).reasons).toEqual({ incomplete_usage: 1 });
  expect(readCodexContextPrices(f.db).extra).toBeNull();
  expect(() => readCodexContextPrices(f.db, { fromDay: "invalid" })).toThrow("day");
  expect(() => readCodexContextPrices(f.db, { fromHour: 1 })).toThrow("Hour");
  expect(() => readCodexContextPrices(f.db, { grain: "hour", fromHour: 0.5 })).toThrow("hour");
});
