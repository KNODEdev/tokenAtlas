// P0/P1a compiler only. This is not connected to production pricing or migrations.
export const NANO_UNITS = 1_000_000_000n;
export const FRACTION_RADIX = 1_000_000_000n;
const INT64_MAX = (1n << 63n) - 1n;
const MAX_TOKENS = (1n << 53n) - 1n;
const MAX_DENOMINATOR = 1_000_000_000_000_000_000n;
export const NANO_BUCKETS = ["in_uncached", "in_cache_read", "in_cache_write", "out_total"] as const;
type Bucket = typeof NANO_BUCKETS[number];
type Decimal = string | number;
export type NanoRateInput = { in_uncached: Decimal; in_cache_read: Decimal; out_total: Decimal; in_cache_write?: Decimal | null };
export interface NanoRates {
  denominator: bigint;
  buckets: Record<Bucket, { whole: bigint; remainder: bigint } | null>;
}
export class ExactLedgerRangeError extends Error {
  constructor(message: string) { super(message); this.name = "ExactLedgerRangeError"; }
}
function gcd(left: bigint, right: bigint): bigint {
  while (right) { const next = left % right; left = right; right = next; }
  return left;
}
/** Canonical legacy Number spelling is an explicit adapter; new configuration uses decimal text. */
function coefficient(value: Decimal): { n: bigint; places: number } {
  if ((typeof value !== "string" && typeof value !== "number")
    || typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error("Invalid nonnegative decimal rate");
  const source = String(value);
  if (source.length > 2048) throw new ExactLedgerRangeError("Decimal input exceeds 2048 characters");
  const parsed = /^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(source);
  if (!parsed) throw new Error("Invalid nonnegative decimal rate");
  const exponent = Number(parsed[3] ?? 0), fraction = parsed[2] ?? "";
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 || fraction.length > 1000) {
    throw new ExactLedgerRangeError("Decimal exponent/precision exceeds the compiler limit");
  }
  return { n: BigInt(parsed[1]! + fraction), places: fraction.length - exponent };
}
export function compileNanoRates(input: NanoRateInput, multiplier: Decimal = "1"): NanoRates {
  const factor = coefficient(multiplier);
  if (factor.n === 0n) throw new Error("Rule multiplier must be positive");
  const fractions = NANO_BUCKETS.map(bucket => {
    const value = input[bucket];
    if (bucket === "in_cache_write" && value == null) return null;
    if (value == null) throw new Error(`Missing required rate: ${bucket}`);
    const rate = coefficient(value);
    // Nano per token = rate per million * multiplier * 10^3.
    const places = rate.places + factor.places - 3;
    let n = rate.n * factor.n * (places < 0 ? 10n ** BigInt(-places) : 1n);
    let d = places > 0 ? 10n ** BigInt(places) : 1n;
    const divisor = gcd(n, d); n /= divisor; d /= divisor;
    return { n, d };
  });
  let denominator = 1n;
  for (const value of fractions) if (value) {
    denominator = denominator / gcd(denominator, value.d) * value.d;
    if (denominator > MAX_DENOMINATOR) throw new ExactLedgerRangeError("Exact nano remainder denominator exceeds 10^18; no rounding permitted");
  }
  const buckets = Object.fromEntries(NANO_BUCKETS.map((bucket, index) => {
    const value = fractions[index];
    if (!value) return [bucket, null];
    const whole = value.n / value.d;
    if (whole > INT64_MAX) throw new ExactLedgerRangeError("Per-token whole nano rate exceeds int64");
    return [bucket, { whole, remainder: value.n % value.d * (denominator / value.d) }];
  })) as NanoRates["buckets"];
  return { denominator, buckets };
}
function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) throw new Error("Invalid probe SQL identifier");
  return `"${value}"`;
}
const addSql = (left: string, right: string) => `(CASE WHEN ${left}<=${INT64_MAX}-${right} THEN ${left}+${right} END)`;
function fractionSql(quantity: string, remainder: bigint, denominator: bigint): { whole: string; fraction: string } {
  if (remainder === 0n) return { whole: "0", fraction: "0" };
  const direct = `${quantity}<=${INT64_MAX / remainder}`;
  // Rare wide product: bounded binary multiplication carries within denominator, avoiding REAL.
  // Every doubled/summed remainder is <2*10^18; accumulated whole is <=safe token count.
  const loop = `WITH RECURSIVE m(q,a,b,c,d) AS (
    SELECT ${quantity},0,0,0,${remainder}
    UNION ALL SELECT q/2,
      CASE WHEN q%2=1 THEN a+c+(b+d)/${denominator} ELSE a END,
      CASE WHEN q%2=1 THEN (b+d)%${denominator} ELSE b END,
      c*2+(d*2)/${denominator},(d*2)%${denominator} FROM m WHERE q>0)
    SELECT`;
  return { whole: `CASE WHEN ${direct} THEN (${quantity}*${remainder})/${denominator} ELSE (${loop} a FROM m WHERE q=0) END`,
    fraction: `CASE WHEN ${direct} THEN (${quantity}*${remainder})%${denominator} ELSE (${loop} b FROM m WHERE q=0) END` };
}
/** NULL means unrepresentable input/product, never REAL or rounded money. Caller must reject it. */
export function nanoValuationSql(table: string, rates: NanoRates, keys: readonly string[] = []): string {
  if (rates.denominator <= 0n || rates.denominator > MAX_DENOMINATOR) throw new ExactLedgerRangeError("Invalid SQL nano denominator");
  for (const rate of Object.values(rates.buckets)) if (rate
    && (rate.whole < 0n || rate.whole > INT64_MAX || rate.remainder < 0n || rate.remainder >= rates.denominator)) {
    throw new ExactLedgerRangeError("Invalid compiled SQL nano rate");
  }
  const fields: string[] = [];
  NANO_BUCKETS.forEach((bucket, index) => {
    const quantity = identifier(bucket), rate = rates.buckets[bucket];
    const valid = `typeof(${quantity})='integer' AND ${quantity}>=0 AND ${quantity}<=${MAX_TOKENS}`;
    if (!rate) {
      const empty = `CASE WHEN ${valid} AND ${quantity}=0 THEN 0 END`;
      fields.push(`${empty} AS w${index}`, `${empty} AS f${index}`);
      return;
    }
    const whole = `CASE WHEN ${valid} AND ${quantity}<=${rate.whole ? INT64_MAX / rate.whole : MAX_TOKENS} THEN ${quantity}*${rate.whole} END`;
    const remainder = fractionSql(quantity, rate.remainder, rates.denominator);
    fields.push(`${addSql(`(${whole})`, `(CASE WHEN ${valid} THEN ${remainder.whole} END)`)} AS w${index}`,
      `(CASE WHEN ${valid} THEN ${remainder.fraction} END) AS f${index}`);
  });
  const pass = keys.map(identifier).join(",");
  const selected = pass ? `${pass},` : "";
  const whole = addSql("w01", "w23");
  // Four remainders each <10^18: this intermediate remains INTEGER.
  return `SELECT ${selected}whole,
    CASE WHEN whole IS NOT NULL THEN (fraction%${rates.denominator})/${FRACTION_RADIX} END AS fraction_hi,
    CASE WHEN whole IS NOT NULL THEN (fraction%${rates.denominator})%${FRACTION_RADIX} END AS fraction_lo
    FROM (SELECT *,${addSql(`(${whole})`, `(fraction/${rates.denominator})`)} AS whole
      FROM (SELECT *,${addSql("w0", "w1")} AS w01,${addSql("w2", "w3")} AS w23,f0+f1+f2+f3 AS fraction
        FROM (SELECT ${selected}${fields.join(",")} FROM ${identifier(table)})))`;
}
export interface NanoParts { whole: bigint | null; fraction_hi: bigint | null; fraction_lo: bigint | null }
/** Aggregates sum both fraction limbs separately; reconstruction/carry uses BigInt. */
export function readNanoParts(parts: NanoParts, denominator: bigint): { n: bigint; d: bigint } {
  if (parts.whole === null || parts.fraction_hi === null || parts.fraction_lo === null) {
    throw new ExactLedgerRangeError("SQL nano valuation is outside its exact integer domain");
  }
  if (denominator <= 0n || denominator > MAX_DENOMINATOR || parts.fraction_hi < 0n || parts.fraction_lo < 0n) {
    throw new Error("Invalid nano fraction metadata");
  }
  const n = parts.whole * denominator + parts.fraction_hi * FRACTION_RADIX + parts.fraction_lo;
  const d = denominator * NANO_UNITS;
  const divisor = gcd(n < 0n ? -n : n, d);
  return { n: n / divisor, d: d / divisor };
}

export interface NanoAggregateParts {
  rows: bigint; invalid_rows: bigint; whole_hi: bigint | null; whole_lo: bigint | null;
  fraction_hi: bigint | null; fraction_lo: bigint | null;
}
/** Sum limbs, rather than whole amounts, so a correct history total may exceed signed int64. */
export function nanoAggregateSql(valuationSql: string): string {
  return `SELECT COUNT(*) AS rows,
    COALESCE(SUM(CASE WHEN whole IS NULL OR fraction_hi IS NULL OR fraction_lo IS NULL THEN 1 ELSE 0 END),0) AS invalid_rows,
    SUM(whole/${FRACTION_RADIX}) AS whole_hi,SUM(whole%${FRACTION_RADIX}) AS whole_lo,
    SUM(fraction_hi) AS fraction_hi,SUM(fraction_lo) AS fraction_lo FROM (${valuationSql})`;
}
export function readNanoAggregate(parts: NanoAggregateParts, denominator: bigint): { n: bigint; d: bigint } {
  if (denominator <= 0n || denominator > MAX_DENOMINATOR || parts.rows < 0n) throw new Error("Invalid nano aggregate metadata");
  if (parts.rows === 0n) return { n: 0n, d: 1n };
  if (parts.invalid_rows !== 0n || parts.whole_hi === null || parts.whole_lo === null) {
    throw new ExactLedgerRangeError("Aggregate includes an unrepresentable SQL valuation");
  }
  return readNanoParts({ whole: parts.whole_hi * FRACTION_RADIX + parts.whole_lo,
    fraction_hi: parts.fraction_hi, fraction_lo: parts.fraction_lo }, denominator);
}
