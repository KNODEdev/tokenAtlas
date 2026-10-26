import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { configFile } from "../src/config/paths";
import { Database } from "../src/db/sqlite";
import { resolveCodexAccountingConfig } from "../src/server/codex-accounting-pricing";
import type { RateCard } from "../src/server/pricing";

// P0 probe only: no live database connection, migrations or configuration writes.
// Run: bun scripts/price-ledger-numeric-probe.ts
const int64Max = (1n << 63n) - 1n;
const int64Min = -(1n << 63n);
const checks: string[] = [];
function check(name: string, run: () => void): void {
  run();
  checks.push(name);
}

/** Independent rational oracle; preserve supplied decimal values, including float artefacts. */
function decimalFraction(text: string): { numerator: bigint; denominator: bigint } {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  assert(match, `Invalid nonnegative decimal: ${text}`);
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  assert(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 1000 && fraction.length <= 1000);
  const scale = fraction.length - exponent;
  return {
    numerator: BigInt(match[1]! + fraction) * (scale < 0 ? 10n ** BigInt(-scale) : 1n),
    denominator: scale > 0 ? 10n ** BigInt(scale) : 1n,
  };
}
function scaledRate(rate: string, multiplier: string, unitsPerWhole: bigint): bigint | null {
  const r = decimalFraction(rate), m = decimalFraction(multiplier);
  const numerator = r.numerator * m.numerator * unitsPerWhole;
  const denominator = r.denominator * m.denominator * 1_000_000n;
  return numerator % denominator === 0n ? numerator / denominator : null;
}

const exact = new Database(":memory:", { safeIntegers: true });
const ordinary = new Database(":memory:");
type Scalar = { value: bigint | number | string; kind: string };
try {
  check("USD per million converts to pico-USD per token, without rounding", () => {
    assert.equal(scaledRate("1.875", "1", 10n ** 12n), 1_875_000n);
    assert.equal(scaledRate("1.875", "2.5", 10n ** 12n), 4_687_500n);
    assert.equal(scaledRate("1.875", "2.5", 10n ** 9n), null);
    assert.equal(scaledRate("1", "1.0000001", 10n ** 12n), null);
    assert.equal(scaledRate("0", "2.5", 10n ** 12n), 0n);
    assert.equal(scaledRate("1e-3", "2.5", 10n ** 12n), 2_500n);
  });
  check("Bun safeIntegers preserves both signed int64 boundaries", () => {
    for (const value of [int64Min, int64Max, 9_007_199_254_740_993n]) {
      const row = exact.query<Scalar, [bigint, bigint]>("SELECT ? AS value, typeof(?) AS kind").get(value, value);
      assert.equal(row?.value, value);
      assert.equal(row?.kind, "integer");
    }
  });
  check("ordinary Number reads lose integer precision above 2^53", () => {
    const row = ordinary.query<{ value: number }, [bigint]>("SELECT ? AS value").get(9_007_199_254_740_993n);
    assert.equal(typeof row?.value, "number");
    assert.equal(Number.isSafeInteger(row!.value), false);
    assert.notEqual(BigInt(row!.value), 9_007_199_254_740_993n);
  });
  check("SQLite multiplication silently promotes an overflowing product to REAL", () => {
    const query = exact.query<Scalar, [bigint, bigint, bigint, bigint]>("SELECT ? * ? AS value, typeof(? * ?) AS kind");
    const safe = query.get(int64Max / 2n, 2n, int64Max / 2n, 2n);
    assert.equal(safe?.kind, "integer");
    assert.equal(safe?.value, int64Max - 1n);
    const overflow = query.get(int64Max, 2n, int64Max, 2n);
    assert.equal(overflow?.kind, "real");
  });
  check("integer SUM throws on overflow; TOTAL would silently use REAL", () => {
    exact.exec("CREATE TABLE amounts(value INTEGER NOT NULL) STRICT");
    const insert = exact.query("INSERT INTO amounts VALUES (?)");
    insert.run(int64Max);
    insert.run(1n);
    assert.throws(() => exact.query("SELECT SUM(value) FROM amounts").get(), /integer overflow/i);
    assert.equal(exact.query<{ kind: string }, []>("SELECT typeof(TOTAL(value)) AS kind FROM amounts").get()?.kind, "real");
    exact.exec("DELETE FROM amounts");
    insert.run(4_687_500n);
    insert.run(-1_875_000n);
    assert.equal(exact.query<{ value: bigint }, []>("SELECT SUM(value) AS value FROM amounts").get()?.value, 2_812_500n);
  });
  check("JSON transports int64 as decimal text, never as Number or raw BigInt", () => {
    assert.throws(() => JSON.stringify({ value: int64Max }), /BigInt/i);
    const row = exact.query<{ value: string }, [bigint]>("SELECT CAST(? AS TEXT) AS value").get(int64Max);
    assert.equal(JSON.parse(JSON.stringify(row)).value, "9223372036854775807");
  });
} finally {
  ordinary.close();
  exact.close();
}

const cardPath = configFile("rate-cards.json");
const cardBytes = readFileSync(cardPath);
const card = JSON.parse(cardBytes.toString("utf8")) as RateCard;
const config = resolveCodexAccountingConfig(card);
const candidates = [9, 12].map(places => {
  let checked = 0;
  const notRepresentable: { rule: string; band: string; bucket: string; rate: string; multiplier: string }[] = [];
  let maxUnitsPerToken = 0n;
  for (const rule of config.rules) {
    const bands = [{ name: "base", rates: rule.rates },
      ...(rule.long_context ? [{ name: "long_context", rates: rule.long_context.rates }] : [])];
    for (const band of bands) {
      for (const [bucket, value] of Object.entries(band.rates)) {
        if (value == null) continue;
        const rate = String(value), multiplier = String(rule.multiplier);
        const units = scaledRate(rate, multiplier, 10n ** BigInt(places));
        checked++;
        if (units === null) notRepresentable.push({ rule: rule.id, band: band.name, bucket, rate, multiplier });
        else if (units > maxUnitsPerToken) maxUnitsPerToken = units;
      }
    }
  }
  return { places, checked, notRepresentable, maxUnitsPerToken: String(maxUnitsPerToken),
    // A conservative per-sum bound, not evidence that live event/group totals fit it.
    conservativeMaxTokensPerSum: maxUnitsPerToken > 0n ? String(int64Max / maxUnitsPerToken) : null };
});
console.log(JSON.stringify({ status: "passed", bun: Bun.version, sqlite: (() => {
  const db = new Database(":memory:");
  try { return db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()!.version; }
  finally { db.close(); }
})(), checks, cardPath, cardSha256: createHash("sha256").update(cardBytes).digest("hex"),
  rules: config.rules.length, candidates,
  limitation: "Arithmetic/transport probe only. No event audit, exact variant reference, scale approval or P1a acceptance. Rates remain unchanged." }, null, 2));
