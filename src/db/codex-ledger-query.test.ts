import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema } from "./codex-price-ledger";
import { codexReadings, codexUsageSeries, serializeCodexLedgerAmount } from "./codex-ledger-query";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";

function fixture(run: (db: Database, policy: ReturnType<typeof compileCodexLedgerPolicy>) => void) {
  const db = new Database(":memory:");
  const declaration: CodexLedgerPolicy = { version: 1, tiers: ["standard", "fast"],
    mappings: [{ id: "default", raw_value: "default", tier: "standard" }], tier_rules: [],
    base_rules: ["api_equivalent_usd", "chatgpt_credits"].map(billing_basis => ({ id: billing_basis,
      model: "model", billing_basis: billing_basis as "api_equivalent_usd" | "chatgpt_credits", valid_from: "2026-01-01",
      rates: { in_uncached: "1.5", in_cache_read: "0", out_total: "3" }, multiplier: "1", confidence: "official",
      sources: ["https://example.test/rates"], verified_at: "2026-10-01" })) };
  const policy = compileCodexLedgerPolicy(declaration);
  try {
    db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,ts TEXT,model TEXT,service_tier TEXT,
        in_tok INTEGER,cached_in INTEGER,cache_write INTEGER,out_tok INTEGER,reasoning_out INTEGER,usage_status TEXT,cache_write_status TEXT)`);
    const insert = db.query("INSERT INTO events VALUES('archive','session',?,?,'model','default',100,0,0,20,0,'valid','missing')");
    insert.run(1, "2026-10-25T02:10:00+02:00");
    insert.run(2, "2026-10-25T02:10:00+01:00");
    createCodexLedgerSchema(db);
    fillCodexLedgerFixture(db, { bands: policy.baseBands, policy: policy.policy,
      factsRevision: 0, rulesRevision: "fixture", sourceOf: () => "codex/fixture" });
    run(db, policy);
  } finally { db.close(); }
}

test("hour and minute bins keep repeated DST hours distinct and read only stored prices", () => fixture((db, policy) => {
  const bounds = { fromMs: Date.parse("2026-10-25T00:00:00Z"), toMs: Date.parse("2026-10-25T02:00:00Z") };
  const original = db.query("SELECT api_whole,api_fraction_hi,api_fraction_lo,credit_whole FROM codex_price_ledger_events ORDER BY id").all();
  const hours = codexUsageSeries(db, policy, { ...bounds, grain: "hour" });
  expect(hours.map(bucket => bucket.calls)).toEqual([1n, 1n]);
  expect(hours[0]!.label).toContain("02:00");
  expect(hours[1]!.label).toContain("02:00");
  expect(hours[0]!.label).not.toBe(hours[1]!.label);
  const minutes = codexUsageSeries(db, policy, { ...bounds, grain: "minute" });
  expect(minutes.map(bucket => bucket.fromMs)).toEqual([Date.parse("2026-10-25T00:10:00Z"), Date.parse("2026-10-25T01:10:00Z")]);
  expect(serializeCodexLedgerAmount(hours[0]!.variants.api_standard).value?.decimal).toBe("0.00021");
  expect(db.query("SELECT api_whole,api_fraction_hi,api_fraction_lo,credit_whole FROM codex_price_ledger_events ORDER BY id").all()).toEqual(original);
}));

test("chart [from,to) and reading (start,end] use their established opposite endpoints", () => fixture((db, policy) => {
  const start = Date.parse("2026-10-25T00:10:00Z"), end = Date.parse("2026-10-25T01:10:00Z");
  expect(codexUsageSeries(db, policy, { fromMs: start, toMs: end, grain: "hour" }).reduce((n, bucket) => n + bucket.calls, 0n)).toBe(1n);
  const reading = codexReadings(db, policy, { startMs: start, endMs: end });
  expect(reading.calls).toBe(1n);
  expect(reading.tokens).toBe(120n);
  expect(() => codexUsageSeries(db, policy, { fromMs: start, toMs: start, grain: "hour" })).toThrow();
  expect(() => codexUsageSeries(db, policy, { fromMs: start, toMs: start + 60_000 * 10_001, grain: "minute" })).toThrow();
}));
