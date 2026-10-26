import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { createCodexLedgerSchema, type LedgerBaseBand } from "./codex-price-ledger";
import { codexLedgerReferenceRevision, codexReferenceValuation, type CodexLedgerReferenceValue, type CodexReferenceCall } from "./codex-ledger-reference";
import { add, compileNanoRates, decimal, equal, multiply, nanoValuationSql, rational, readNanoParts, type Rational } from "./price-ledger-exact";
import { readCodexEventRange, pricePublishedCodexEvent } from "../server/codex-priced-events";
import { compileCodexLedgerPolicy, type CodexLedgerPolicy } from "../server/codex-ledger-policy";
import { fillCodexLedgerFixture } from "../server/codex-ledger.fixture";

const api = (band: Omit<LedgerBaseBand, "basis" | "multiplier" | "evidence">): LedgerBaseBand =>
  ({ ...band, basis: "api_equivalent_usd", multiplier: "1", evidence: band.id });
/** Two periods of model m (a context threshold that moves), a model without a cache-write rate, a credit band. */
const bands = (): LedgerBaseBand[] => [
  api({ id: "old", model: "m", validFrom: "2026-01-01", validUntil: "2026-05-01", band: "normal", threshold: 100,
    rates: { in_uncached: "1", in_cache_read: "0.1", in_cache_write: "1.25", out_total: "1.7999999999999998" } }),
  ...(["normal", "long"] as const).map(band => api({ id: "new", model: "m", validFrom: "2026-05-01", band, threshold: 10,
    rates: { in_uncached: band === "long" ? "4" : "2", in_cache_read: "0.2", in_cache_write: "2.5", out_total: "1.7999999999999998" } })),
  api({ id: "nowrite", model: "n", validFrom: "2026-01-01", band: "normal", rates: { in_uncached: "3", in_cache_read: "0.3", out_total: "15" } }),
  { id: "credits", model: "m", basis: "chatgpt_credits", validFrom: "2026-01-01", band: "normal", multiplier: "1", evidence: "credits",
    rates: { in_uncached: "100", in_cache_read: "10", out_total: "200" } },
];
/** Calls across both periods and the threshold, with and without cache writes, priced and blocked. */
function fixture(): Database {
  const db = new Database(":memory:");
  createCodexLedgerSchema(db);
  db.exec(`CREATE TABLE events(home TEXT,path TEXT,source_offset INTEGER,model TEXT,ts TEXT,in_tok ANY,cached_in ANY,
    cache_write ANY,out_tok ANY,usage_status TEXT,cache_write_status TEXT) STRICT`);
  const insert = db.query("INSERT INTO events VALUES('a',?,?,?,?,?,?,?,?,?,'reported')");
  const rows: Array<[string, string, number, number, number, number, string]> = [
    ["m", "2026-04-01T12:00:00Z", 5, 1, 0, 3, "valid"], ["m", "2026-04-01T13:00:00Z", 10, 2, 2, 7, "valid"],
    ["m", "2026-04-02T09:00:00Z", 11, 0, 0, 1, "valid"], ["m", "2026-06-15T10:00:00Z", 150, 40, 9, 11, "valid"],
    ["m", "2026-06-15T11:00:00Z", 9, 0, 3, 0, "valid"], ["m", "2026-06-15T12:00:00Z", 12, 1, 0, 2, "incomplete"],
    ["m", "2026-06-16Tinvalid", 12, 1, 0, 2, "valid"], ["m", "2026-06-16T08:00:00Z", -1, 0, 0, 2, "valid"],
    ["n", "2026-06-16T09:00:00Z", 20, 5, 0, 4, "valid"], ["n", "2026-06-16T10:00:00Z", 20, 5, 6, 4, "valid"],
    ["z", "2026-06-16T11:00:00Z", 20, 5, 0, 4, "valid"],
  ];
  rows.forEach(([model, ts, input, cached, written, output, status], index) =>
    insert.run(`${model}.jsonl`, index * 100, model, ts, input, cached, written, output, status));
  fillCodexLedgerFixture(db, { bands: bands(), factsRevision: 0, rulesRevision: "rules", sourceOf: () => "source" });
  return db;
}
type Row = CodexReferenceCall & { id: number; day: string };
const calls = (db: Database) => db.query(`SELECT e.id,e.day,d.model,e.in_tok,e.uncached,e.cached,e.writes,e.output,e.common_reason
  FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id ORDER BY e.id`).all() as Row[];

/**
 * The per-call valuation the ledger stored until U3 (codex-ledger-reference-view.ts, removed): SQL nano arithmetic
 * over the stored events, band after band. It stays here as the independent oracle the in-memory valuation must equal.
 */
function storedValuation(db: Database, day: string, input: readonly LedgerBaseBand[]): Map<number, CodexLedgerReferenceValue> {
  db.exec(`DROP TABLE IF EXISTS temp.oracle; CREATE TEMP TABLE oracle(event_id INTEGER PRIMARY KEY,reason TEXT,rule_id TEXT,
    long_context INTEGER NOT NULL DEFAULT 0,denominator INTEGER,whole INTEGER,fraction_hi INTEGER,fraction_lo INTEGER)`);
  db.exec("INSERT INTO temp.oracle(event_id,reason) SELECT id,COALESCE(common_reason,'missing_rate') FROM codex_price_ledger_events");
  for (const band of input.filter(band => band.basis === "api_equivalent_usd" && band.validFrom <= day && (!band.validUntil || day < band.validUntil))) {
    const compiled = compileNanoRates(band.rates, band.multiplier);
    const filters = ["d.model=?", "e.common_reason IS NULL"], params: (string | number)[] = [band.model];
    if (band.threshold !== undefined) { filters.push(`e.in_tok${band.band === "long" ? ">" : "<="}?`); params.push(band.threshold); }
    if (band.rates.in_cache_write == null) {
      db.query(`UPDATE temp.oracle AS v SET reason='missing_cache_write_rate' FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id
        WHERE v.event_id=e.id AND ${filters.join(" AND ")} AND e.cache_write>0`).run(...params);
      filters.push("e.cache_write=0");
    }
    db.query(`WITH input AS (SELECT e.id,e.in_tok-e.cached_in-e.cache_write in_uncached,e.cached_in in_cache_read,
        e.cache_write in_cache_write,e.out_tok out_total FROM codex_price_ledger_events e CROSS JOIN codex_price_ledger_dims d ON d.id=e.dim_id
        WHERE ${filters.join(" AND ")}), valued AS (${nanoValuationSql("input", compiled, ["id"])})
      UPDATE temp.oracle AS v SET reason=NULL,rule_id=?,long_context=?,denominator=?,whole=p.whole,fraction_hi=p.fraction_hi,fraction_lo=p.fraction_lo
      FROM valued p WHERE v.event_id=p.id`).run(...params, band.id, band.band === "long" ? 1 : 0, compiled.denominator);
  }
  const rows = db.query(`SELECT event_id,reason,rule_id,long_context,CAST(denominator AS TEXT) denominator,CAST(whole AS TEXT) whole,
    CAST(fraction_hi AS TEXT) fraction_hi,CAST(fraction_lo AS TEXT) fraction_lo FROM temp.oracle`).all() as Array<Record<string, string | number | null>>;
  return new Map(rows.map(row => [Number(row.event_id), { reason: row.reason as string | null, ruleId: row.rule_id as string | null,
    longContext: !!row.long_context, amount: row.reason === null ? readNanoParts({ whole: BigInt(row.whole!), fraction_hi: BigInt(row.fraction_hi!),
      fraction_lo: BigInt(row.fraction_lo!) }, BigInt(row.denominator!)) : null }]));
}

test("the in-memory valuation equals the stored per-call valuation on every call and reference day", () => {
  const db = fixture();
  try {
    const events = calls(db);
    expect(events.length).toBe(11);
    const seen = new Set<string>();
    for (const day of ["2026-03-01", "2026-04-01", "2026-05-01", "2026-12-31"]) {
      const value = codexReferenceValuation(bands(), day), stored = storedValuation(db, day, bands());
      for (const call of events) {
        const mine = value(call), theirs = stored.get(call.id)!;
        expect({ ...mine, amount: null }).toEqual({ ...theirs, amount: null });
        expect(mine.amount === null ? null : [mine.amount.n, mine.amount.d]).toEqual(theirs.amount === null ? null : [theirs.amount.n, theirs.amount.d]);
        seen.add(mine.reason ?? (mine.longContext ? "long" : "normal"));
      }
    }
    // Every branch is exercised: both context bands, a band without a cache-write rate, common reasons, no band at all.
    expect([...seen].sort()).toEqual(["incomplete_usage", "invalid_timestamp", "invalid_tokens", "long", "missing_cache_write_rate", "missing_rate", "normal"]);
  } finally { db.close(); }
});

test("one call's price at a reference day is its buckets times that day's band, long context by input size", () => {
  const db = fixture();
  try {
    const value = codexReferenceValuation(bands(), "2026-05-01"), call = calls(db)[3]!;
    expect(call).toMatchObject({ in_tok: 150, uncached: 101, cached: 40, writes: 9, output: 11 });
    const expected = [["4", 101n], ["0.2", 40n], ["2.5", 9n], ["1.7999999999999998", 11n]] as const;
    const amount = expected.reduce<Rational>((sum, [rate, tokens]) => add(sum, multiply(decimal(rate), rational(tokens))), rational(0n));
    expect(equal(value(call).amount!, multiply(amount, rational(1n, 1_000_000n)))).toBe(true);
    expect(value(call)).toMatchObject({ reason: null, ruleId: "new", longContext: true });
  } finally { db.close(); }
});

test("the valuation is linear: sums grouped by model, context band and cache writes give the per-call total", () => {
  const db = fixture();
  try {
    for (const day of ["2026-04-01", "2026-05-01"]) {
      const value = codexReferenceValuation(bands(), day);
      const perCall = calls(db).map(value).filter(item => item.amount !== null).reduce<Rational>((sum, item) => add(sum, item.amount!), rational(0n));
      // The stored buckets of homogeneous groups (U3.0 note §5): the same band applies to every call of a group.
      const groups = db.query(`SELECT d.model,MIN(e.in_tok) in_tok,SUM(e.uncached) uncached,SUM(e.cached) cached,SUM(e.writes) writes,
          SUM(e.output) output,e.common_reason FROM codex_price_ledger_events e JOIN codex_price_ledger_dims d ON d.id=e.dim_id
        GROUP BY d.model,e.common_reason,e.in_tok>10,e.in_tok>100,e.writes>0`).all() as CodexReferenceCall[];
      const fromSums = groups.map(value).filter(item => item.amount !== null).reduce<Rational>((sum, item) => add(sum, item.amount!), rational(0n));
      expect(equal(fromSums, perCall)).toBe(true);
      expect(perCall.n).toBeGreaterThan(0n);
    }
  } finally { db.close(); }
});

test("equivalent declarations keep the reference revision; a changed coefficient in effect that day changes it", () => {
  const same = bands().map(band => ({ ...band, id: `${band.id}-renamed`, evidence: "other proof" }));
  expect(codexLedgerReferenceRevision(same, "2026-05-01")).toBe(codexLedgerReferenceRevision(bands(), "2026-05-01"));
  const later = bands(); later[2]!.rates = { ...later[2]!.rates, out_total: "3" };
  expect(codexLedgerReferenceRevision(later, "2026-05-01")).not.toBe(codexLedgerReferenceRevision(bands(), "2026-05-01"));
  expect(codexLedgerReferenceRevision(later, "2026-04-01")).toBe(codexLedgerReferenceRevision(bands(), "2026-04-01"));
});

test("the bounded event reader attaches reference amounts without writing", () => {
  const db = fixture();
  try {
    const provenance = { verified_at: "2026-01-01", sources: ["https://example.com/prices"], confidence: "official" as const };
    const input = bands();
    const text = (rates: LedgerBaseBand["rates"]) => ({ in_uncached: String(rates.in_uncached), in_cache_read: String(rates.in_cache_read),
      in_cache_write: String(rates.in_cache_write), out_total: String(rates.out_total) });
    const policy: CodexLedgerPolicy = { version: 1, tiers: ["standard"], mappings: [{ id: "default", raw_value: "default", tier: "standard" }],
      base_rules: [input[0]!, input[1]!].map(band => ({ id: band.id, model: band.model, billing_basis: band.basis,
        valid_from: band.validFrom, valid_until: band.validUntil, rates: text(band.rates), multiplier: band.multiplier, ...provenance,
        long_context: { above_input_tokens: band.id === "new" ? 10 : 100, rates: text(band.id === "new" ? input[2]!.rates : band.rates) } })),
      tier_rules: [{ id: "standard", model: "m", billing_basis: "api_equivalent_usd", tier: "standard", valid_from: "2026-01-01", multiplier: "1", ...provenance }] };
    const compiled = compileCodexLedgerPolicy(policy), config = { version: 1 as const, rules: [] };
    const changes = db.query("SELECT total_changes() n").get();
    const events = readCodexEventRange(db, config, "2026-06-15", "2026-06-16", undefined, { policy: compiled, referenceDay: "2026-05-01", rulesRevision: "rules" });
    const priced = pricePublishedCodexEvent(config, { ...events[0]!, speed: "standard" }, "api_equivalent_usd", "2026-05-01");
    expect(priced).toMatchObject({ rule_id: "new", long_context: true });
    expect(priced.amount).toBeCloseTo((101 * 4 + 40 * 0.2 + 9 * 2.5 + 11 * 1.8) / 1e6, 15);
    expect(pricePublishedCodexEvent(config, { ...events[2]!, speed: "standard" }, "api_equivalent_usd", "2026-05-01").reason).toBe("incomplete_usage");
    expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  } finally { db.close(); }
});
