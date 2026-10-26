/** Exact SQL coefficients and rational arithmetic shared by the durable price ledger. */
export const NANO_UNITS = 1_000_000_000n;
export const FRACTION_RADIX = 1_000_000_000n;
const INT64_MAX = (1n << 63n) - 1n;
const MAX_TOKENS = (1n << 53n) - 1n;
const MAX_DENOMINATOR = 1_000_000_000_000_000_000n;
export const NANO_BUCKETS = ["in_uncached", "in_cache_read", "in_cache_write", "out_total"] as const;
type Bucket = typeof NANO_BUCKETS[number];
export type DecimalInput = string | number;
type Decimal = DecimalInput;
export type NanoRateInput = { in_uncached: Decimal; in_cache_read: Decimal; out_total: Decimal; in_cache_write?: Decimal | null };
export interface NanoRates {
  denominator: bigint;
  buckets: Record<Bucket, { whole: bigint; remainder: bigint } | null>;
}
export class ExactLedgerRangeError extends Error {
  constructor(message: string) { super(message); this.name = "ExactLedgerRangeError"; }
}
export interface Rational { readonly n: bigint; readonly d: bigint }
export function rational(n: bigint, d = 1n): Rational {
  if (typeof n !== "bigint" || typeof d !== "bigint" || d === 0n) throw new Error("Invalid rational denominator or numerator");
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n < 0n ? -n : n, d);
  return { n: n / divisor, d: d / divisor };
}
/** Number is only a legacy spelling adapter; configuration supplies exact decimal text. */
export function decimal(value: DecimalInput): Rational {
  if ((typeof value !== "string" && typeof value !== "number")
    || typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid decimal");
  const source = String(value);
  if (source.length > 2048) throw new ExactLedgerRangeError("Decimal input exceeds 2048 characters");
  const parsed = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(source);
  if (!parsed) throw new Error("Invalid decimal");
  const fraction = parsed[3] ?? parsed[4] ?? "", exponent = Number(parsed[5] ?? "0");
  const places = fraction.length - exponent;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 || fraction.length > 1000 || Math.abs(places) > 1000) {
    throw new ExactLedgerRangeError("Decimal exponent/precision exceeds the compiler limit");
  }
  const n = BigInt((parsed[2] ?? "0") + fraction) * (parsed[1] === "-" ? -1n : 1n);
  return places >= 0 ? rational(n, 10n ** BigInt(places)) : rational(n * 10n ** BigInt(-places));
}
export function add(a: Rational, b: Rational): Rational {
  a = rational(a.n, a.d); b = rational(b.n, b.d);
  const common = gcd(a.d, b.d);
  return rational(a.n * (b.d / common) + b.n * (a.d / common), a.d * (b.d / common));
}
export const subtract = (a: Rational, b: Rational): Rational => add(a, rational(-b.n, b.d));
export function multiply(a: Rational, b: Rational): Rational {
  a = rational(a.n, a.d); b = rational(b.n, b.d);
  const left = gcd(a.n < 0n ? -a.n : a.n, b.d), right = gcd(b.n < 0n ? -b.n : b.n, a.d);
  return rational((a.n / left) * (b.n / right), (a.d / right) * (b.d / left));
}
export const divide = (a: Rational, b: Rational): Rational => multiply(a, rational(b.d, b.n));
export function equal(a: Rational, b: Rational): boolean {
  a = rational(a.n, a.d); b = rational(b.n, b.d);
  return a.n === b.n && a.d === b.d;
}
export function serializeRational(input: Rational): { numerator: string; denominator: string; decimal: string | null } {
  const q = rational(input.n, input.d);
  let remainder = q.d, twos = 0, fives = 0;
  while (remainder % 2n === 0n) { remainder /= 2n; twos++; }
  while (remainder % 5n === 0n) { remainder /= 5n; fives++; }
  let text: string | null = null;
  if (remainder === 1n) {
    const scale = Math.max(twos, fives);
    const magnitude = (q.n < 0n ? -q.n : q.n) * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
    const digits = magnitude.toString().padStart(scale + 1, "0");
    text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "") : digits;
    if (q.n < 0n) text = `-${text}`;
  }
  return { numerator: String(q.n), denominator: String(q.d), decimal: text };
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
  const parsed = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(source);
  if (!parsed) throw new Error("Invalid nonnegative decimal rate");
  const exponent = Number(parsed[4] ?? 0), fraction = parsed[2] ?? parsed[3] ?? "";
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 || fraction.length > 1000) {
    throw new ExactLedgerRangeError("Decimal exponent/precision exceeds the compiler limit");
  }
  return { n: BigInt((parsed[1] ?? "0") + fraction), places: fraction.length - exponent };
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
function fractionSql(quantity: string, scaledRemainder: bigint, commonDenominator: bigint): { whole: string; fraction: string } {
  if (scaledRemainder === 0n) return { whole: "0", fraction: "0" };
  // The bucket's own reduced fraction keeps the product small (the common denominator of the
  // band's buckets can be 10^16 where this bucket's is 10^3): the same whole, and the fraction
  // scaled back to the common denominator, but far fewer rows need the wide multiplication.
  const scale = gcd(scaledRemainder, commonDenominator), remainder = scaledRemainder / scale, denominator = commonDenominator / scale;
  const scaled = (fraction: string) => scale === 1n ? fraction : `(${fraction})*${scale}`;
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
    fraction: scaled(`CASE WHEN ${direct} THEN (${quantity}*${remainder})%${denominator} ELSE (${loop} b FROM m WHERE q=0) END`) };
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
  // Each stage is computed once per row: OFFSET keeps SQLite from flattening the stages, which
  // would substitute every guarded sum's operands twice per level (about 15x the work per row).
  const stage = "LIMIT -1 OFFSET 0";
  return `SELECT ${selected}whole,
    CASE WHEN whole IS NOT NULL THEN (fraction%${rates.denominator})/${FRACTION_RADIX} END AS fraction_hi,
    CASE WHEN whole IS NOT NULL THEN (fraction%${rates.denominator})%${FRACTION_RADIX} END AS fraction_lo
    FROM (SELECT *,${addSql(`(${whole})`, `(fraction/${rates.denominator})`)} AS whole
      FROM (SELECT *,${addSql("w0", "w1")} AS w01,${addSql("w2", "w3")} AS w23,f0+f1+f2+f3 AS fraction
        FROM (SELECT ${selected}${fields.join(",")} FROM ${identifier(table)} ${stage}) ${stage}) ${stage})`;
}
/**
 * The USD amount `nanoValuationSql` stores for one row, computed in memory: the same coefficients and the
 * same domain (whole tokens 0..2^53-1; a bucket without a rate must be zero). Outside it, it throws where
 * the SQL form yields NULL.
 */
export function nanoValuation(rates: NanoRates, quantities: Record<Bucket, bigint>): Rational {
  let n = 0n;
  for (const bucket of NANO_BUCKETS) {
    const quantity = quantities[bucket], rate = rates.buckets[bucket];
    if (quantity < 0n || quantity > MAX_TOKENS) throw new ExactLedgerRangeError(`Token quantity outside the exact domain: ${bucket}`);
    if (!rate) { if (quantity !== 0n) throw new ExactLedgerRangeError(`No rate for a nonzero bucket: ${bucket}`); continue; }
    n += quantity * (rate.whole * rates.denominator + rate.remainder);
  }
  return rational(n, rates.denominator * NANO_UNITS);
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
