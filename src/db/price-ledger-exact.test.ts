import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { compileNanoRates, nanoValuationSql, readNanoParts, nanoAggregateSql, readNanoAggregate,
  type NanoRateInput, type NanoParts, type NanoAggregateParts } from "./price-ledger-exact";
import { decimal, multiply, rational, add, divide, equal, decimalText } from "../../scripts/lib/price-ledger-reference";
import * as exact from "./price-ledger-exact";

test("reduced fractions preserve signed operations, artifacts and nonterminating ratios", () => {
  expect(exact.rational(6n, -8n)).toEqual({ n: -3n, d: 4n });
  expect(exact.add(exact.rational(1n, 3n), exact.rational(1n, 6n))).toEqual({ n: 1n, d: 2n });
  expect(exact.subtract(exact.rational(1n, 7n), exact.rational(2n, 7n))).toEqual({ n: -1n, d: 7n });
  expect(exact.multiply(exact.rational(-21n, 4n), exact.rational(2n, 7n))).toEqual({ n: -3n, d: 2n });
  expect(exact.divide(exact.rational(3n, 2n), exact.rational(9n, 4n))).toEqual({ n: 2n, d: 3n });
  expect(exact.serializeRational(exact.decimal("1.7999999999999998"))).toEqual({
    numerator: "8999999999999999", denominator: "5000000000000000", decimal: "1.7999999999999998" });
  expect(exact.serializeRational(exact.rational(-1n, 8n)).decimal).toBe("-0.125");
  expect(exact.serializeRational(exact.rational(1n, 3n)).decimal).toBeNull();
  expect(exact.serializeRational(exact.rational(0n, 8n)).decimal).toBe("0");
  expect(exact.equal(exact.decimal("+.125E+1"), exact.rational(5n, 4n))).toBe(true);
  expect(exact.equal(exact.decimal("-12.5e-2"), exact.rational(-1n, 8n))).toBe(true);
  expect(exact.equal(exact.decimal(1.7999999999999998), decimal("1.7999999999999998"))).toBe(true);
  for (let n = -25; n <= 25; n++) for (let d = 1; d <= 11; d++) {
    const a = { n: BigInt(n), d: BigInt(d) }, b = { n: 23n, d: 17n };
    expect(equal(exact.add(a, b), add(a, b))).toBe(true);
    expect(equal(exact.multiply(a, b), multiply(a, b))).toBe(true);
    expect(equal(exact.divide(a, b), divide(a, b))).toBe(true);
  }
});

test("exact parsing and arithmetic reject invalid or unbounded evidence", () => {
  for (const value of [NaN, Infinity, "", " 1", "1/3", "0x10", "1e1001", `0.${"1".repeat(1001)}`, "1".repeat(2049)]) {
    expect(() => exact.decimal(value)).toThrow();
  }
  expect(() => exact.rational(1n, 0n)).toThrow();
  expect(() => exact.divide(exact.rational(1n), exact.rational(0n))).toThrow();
  expect(() => exact.equal({ n: 0n, d: 0n }, exact.rational(0n))).toThrow();
  expect(exact.serializeRational(exact.decimal("1e-1000")).decimal).toBe(`0.${"0".repeat(999)}1`);
  expect(compileNanoRates({ in_uncached: ".125e1", in_cache_read: "0", out_total: "0" }).buckets.in_uncached!.whole).toBe(1250n);
});

test("SQL preserves raw Luna decimal evidence, ordinary rates and exact standard multipliers", () => {
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE input(id INTEGER,in_uncached INTEGER,in_cache_read INTEGER,in_cache_write INTEGER,out_total INTEGER) STRICT");
  const insert = db.query("INSERT INTO input VALUES (?,?,?,?,?)");
  const vectors = [[0, 0, 0, 0], [1, 1, 0, 1], [1234, 8123, 0, 777], [447105, 445952, 0, 36347]];
  vectors.forEach((tokens, index) => insert.run(index, ...tokens));
  const cards: NanoRateInput[] = [
    { in_uncached: "1.875", in_cache_read: "0.125", out_total: "1.7999999999999998" },
    { in_uncached: "3.75", in_cache_read: "0.25", out_total: "3.5999999999999996" },
    { in_uncached: 125, in_cache_read: 12.5, out_total: 1250 },
    { in_uncached: "0.000000001", in_cache_read: "0.000000002", out_total: "0.000000003" },
    { in_uncached: 0, in_cache_read: 0, out_total: 0 },
  ];
  try {
    for (const card of cards) for (const multiplier of ["1", "2.5"]) {
      const compiled = compileNanoRates(card, multiplier);
      const rows = db.query(nanoValuationSql("input", compiled, ["id"])).all() as (NanoParts & { id: bigint })[];
      rows.forEach(row => {
        const tokens = vectors[Number(row.id)]!;
        const expected = divide(multiply(tokens.reduce((sum, token, index) =>
          add(sum, multiply(rational(BigInt(token)), decimal([card.in_uncached, card.in_cache_read, 0, card.out_total][index]!))), rational(0n)),
        decimal(multiplier)), rational(1_000_000n));
        expect(equal(readNanoParts(row, compiled.denominator), expected)).toBe(true);
        // Editable tier multipliers stay outside the stored base and retain arbitrary decimal precision.
        const tier = decimal("1.0000001");
        expect(equal(multiply(readNanoParts(row, compiled.denominator), tier), multiply(expected, tier))).toBe(true);
      });
      const aggregate = db.query(`SELECT SUM(whole) whole,SUM(fraction_hi) fraction_hi,SUM(fraction_lo) fraction_lo
        FROM (${nanoValuationSql("input", compiled)})`).get() as NanoParts;
      expect(equal(readNanoParts(aggregate, compiled.denominator), rows.reduce((sum, row) =>
        add(sum, readNanoParts(row, compiled.denominator)), rational(0n)))).toBe(true);
    }
  } finally { db.close(); }
});

test("guarded SQL rejects overflowing products/sums, noninteger tokens and absent positive writes", () => {
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE input(in_uncached,cached,in_cache_read,in_cache_write,out_total)");
  const cases: [NanoRateInput, unknown[]][] = [
    [{ in_uncached: "9223372036854775", in_cache_read: 0, out_total: 0 }, [2, 0, 0, 0]],
    [{ in_uncached: "9223372036854775", in_cache_read: "9223372036854775", out_total: 0 }, [1, 1, 0, 0]],
    [{ in_uncached: 1, in_cache_read: 1, out_total: 1 }, [0.5, 0, 0, 0]],
    [{ in_uncached: 1, in_cache_read: 1, out_total: 1 }, [1, 0, 1, 0]],
    [{ in_uncached: 1, in_cache_read: 1, out_total: "1.7999999999999998" }, [0, 0, 0, 9007199254740991]],
  ];
  try {
    for (const [card, tokens] of cases) {
      db.exec("DELETE FROM input");
      db.query("INSERT INTO input(in_uncached,in_cache_read,in_cache_write,out_total) VALUES (?,?,?,?)")
        .run(...tokens as [number, number, number, number]);
      const compiled = compileNanoRates(card);
      const result = db.query(nanoValuationSql("input", compiled)).get() as NanoParts;
      expect(result.whole).toBeNull();
      expect(() => readNanoParts(result, compiled.denominator)).toThrow("exact integer domain");
    }
    expect(() => compileNanoRates({ in_uncached: "0.00000000000000000000001", in_cache_read: 0, out_total: 0 })).toThrow("denominator");
    expect(() => compileNanoRates({ in_uncached: 0, in_cache_read: 0, out_total: "1.7999999999999998" }, "1.0000001")).toThrow("denominator");
    const zero = compileNanoRates({ in_uncached: 0, in_cache_read: 0, out_total: 0 });
    db.exec("DELETE FROM input; INSERT INTO input VALUES(0,0,0,0,0)");
    expect(decimalText(readNanoParts(db.query(nanoValuationSql("input", zero)).get() as NanoParts, zero.denominator))).toBe("0");
  } finally { db.close(); }
});

test("wide fractional intermediate uses exact bounded SQL carry when the final amount fits", () => {
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE input(in_uncached INTEGER,in_cache_read INTEGER,in_cache_write INTEGER,out_total INTEGER) STRICT");
  const tokens = 9007199254740991n;
  db.query("INSERT INTO input VALUES (?,0,0,0)").run(tokens);
  const card = { in_uncached: "0.000123456789012345", in_cache_read: 0, out_total: 0 };
  try {
    const compiled = compileNanoRates(card), result = db.query(nanoValuationSql("input", compiled)).get() as NanoParts;
    expect(result.whole).not.toBeNull();
    expect(equal(readNanoParts(result, compiled.denominator), divide(multiply(rational(tokens), decimal(card.in_uncached)), rational(1_000_000n)))).toBe(true);
  } finally { db.close(); }
});

test("integer limb aggregates preserve sums beyond int64 and cannot hide an invalid priced row", () => {
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE input(in_uncached INTEGER,in_cache_read INTEGER,in_cache_write INTEGER,out_total INTEGER) STRICT");
  const compiled = compileNanoRates({ in_uncached: "9223372036854775", in_cache_read: 0, out_total: 0 });
  const sql = nanoValuationSql("input", compiled);
  try {
    expect(readNanoAggregate(db.query(nanoAggregateSql(sql)).get() as NanoAggregateParts, compiled.denominator)).toEqual({ n: 0n, d: 1n });
    db.exec("INSERT INTO input VALUES (1,0,0,0),(1,0,0,0)");
    expect(() => db.query(`SELECT SUM(whole) FROM (${sql})`).get()).toThrow("integer overflow");
    const exact = readNanoAggregate(db.query(nanoAggregateSql(sql)).get() as NanoAggregateParts, compiled.denominator);
    expect(equal(exact, divide(multiply(decimal("9223372036854775"), rational(2n)), rational(1_000_000n)))).toBe(true);
    db.exec("INSERT INTO input VALUES (2,0,0,0)");
    expect(() => readNanoAggregate(db.query(nanoAggregateSql(sql)).get() as NanoAggregateParts, compiled.denominator)).toThrow("unrepresentable");
  } finally { db.close(); }
});


test("a band whose buckets have very different denominators values every token count exactly", () => {
  const db = new Database(":memory:", { safeIntegers: true });
  db.exec("CREATE TABLE input(id INTEGER,in_uncached INTEGER,in_cache_read INTEGER,in_cache_write INTEGER,out_total INTEGER) STRICT");
  // A float artifact (denominator 10^13) beside short decimals: the common denominator is far larger than each bucket's own.
  const card = { in_uncached: "1.7999999999999998", in_cache_read: "0.125", in_cache_write: "0.18749999999999997", out_total: "10" };
  const counts = [0n, 1n, 921n, 922n, 123_456n, 999_999n, 47_123_456_789n, 9_007_199_254_740n];
  const insert = db.query("INSERT INTO input VALUES (?,?,?,?,?)");
  counts.forEach((count, index) => insert.run(index, count, counts[(index + 3) % counts.length]!, counts[(index + 5) % counts.length]!, count % 1000n));
  try {
    const compiled = compileNanoRates(card);
    const rows = db.query(`SELECT v.*,i.in_uncached,i.in_cache_read,i.in_cache_write,i.out_total FROM (${nanoValuationSql("input", compiled, ["id"])}) v
      JOIN input i ON i.id=v.id ORDER BY v.id`).all() as (NanoParts & Record<"in_uncached" | "in_cache_read" | "in_cache_write" | "out_total", bigint>)[];
    expect(rows).toHaveLength(counts.length);
    for (const row of rows) {
      const expected = (["in_uncached", "in_cache_read", "in_cache_write", "out_total"] as const).reduce((sum, bucket) =>
        add(sum, divide(multiply(rational(row[bucket]), decimal(card[bucket])), rational(1_000_000n))), rational(0n));
      expect(row.whole).not.toBeNull();
      expect(equal(readNanoParts(row, compiled.denominator), expected)).toBe(true);
    }
  } finally { db.close(); }
});
