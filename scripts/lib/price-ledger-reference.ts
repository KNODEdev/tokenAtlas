/** Synthetic P0 oracle. No production pricing, database or configuration imports. */
export type DecimalInput = string | number;
export interface Rational { readonly n: bigint; readonly d: bigint }
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};
export function rational(n: bigint, d = 1n): Rational {
  if (!d) throw new Error("Zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
export const ZERO = rational(0n), ONE = rational(1n);
export function decimal(value: DecimalInput): Rational {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid decimal");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite decimal");
  const source = String(value);
  if (source.length > 2048) throw new Error("Decimal evidence exceeds the reference parser limit");
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new Error(`Invalid decimal: ${String(value)}`);
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? 0);
  const scale = fraction.length - exponent;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 || Math.abs(scale) > 1000
    || fraction.length > 1000) throw new Error("Decimal evidence exceeds the reference parser limit");
  const digits = BigInt((match[2] ?? "0") + fraction) * (match[1] === "-" ? -1n : 1n);
  return scale >= 0 ? rational(digits, 10n ** BigInt(scale)) : rational(digits * 10n ** BigInt(-scale));
}
export const add = (a: Rational, b: Rational): Rational => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const subtract = (a: Rational, b: Rational): Rational => rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const multiply = (a: Rational, b: Rational): Rational => rational(a.n * b.n, a.d * b.d);
export const divide = (a: Rational, b: Rational): Rational => rational(a.n * b.d, a.d * b.n);
export const equal = (a: Rational, b: Rational): boolean => a.n * b.d === b.n * a.d;
export function decimalText(value: Rational): string | null {
  const q = rational(value.n, value.d);
  let denominator = q.d, twos = 0, fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
  if (denominator !== 1n) return null;
  const scale = Math.max(twos, fives);
  const magnitude = (q.n < 0n ? -q.n : q.n) * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  const digits = magnitude.toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "") : digits;
  return `${q.n < 0n ? "-" : ""}${text}`;
}
export const serializeRational = (q: Rational) => {
  const value = rational(q.n, q.d);
  return { numerator: String(value.n), denominator: String(value.d), decimal: decimalText(value) };
};

export type Basis = "chatgpt_credits" | "api_equivalent_usd";
export type Speed = "standard" | "fast";
export interface Rates {
  in_uncached: DecimalInput; in_cache_read: DecimalInput;
  in_cache_write?: DecimalInput | null; out_total: DecimalInput;
}
export interface Rule {
  id: string; model: string; billing_basis: Basis; speed: Speed;
  valid_from: string; valid_until?: string; multiplier: DecimalInput; rates: Rates;
  long_context?: { above_input_tokens: number; rates: Rates };
}
export interface ReferenceConfig { version: 1; long_context_premium?: boolean; rules: readonly Rule[] }
export interface Event {
  model: string | null; speed: string | null; ts: string;
  in_tok: number; cached_in: number; cache_write: number; out_tok: number;
  reasoning_out?: unknown; usage_status?: string | null; cache_write_status?: string | null;
  /** The raw tier the call recorded; absent or null when it recorded none. */
  service_tier?: string | null;
}
export type Reason = "unknown_speed" | "missing_rate" | "invalid_tokens" | "invalid_timestamp"
  | "cache_write_semantics_unknown" | "missing_cache_write_rate" | "incomplete_usage";
export interface Price {
  amount: Rational | null; reason: Reason | null; rule_id: string | null; long_context: boolean;
}
const RATE_KEYS = ["in_uncached", "in_cache_read", "in_cache_write", "out_total"] as const;
type ExactRates = Record<typeof RATE_KEYS[number], Rational | null>;
interface ExactRule extends Omit<Rule, "rates" | "multiplier" | "long_context"> {
  rates: ExactRates; multiplier: Rational;
  long_context?: { above_input_tokens: number; rates: ExactRates };
}
export interface CompiledReferenceConfig {
  readonly compiled: true; readonly premium: boolean;
  readonly index: ReadonlyMap<string, readonly ExactRule[]>;
}
export function isAccountingDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function exactRates(rates: Rates): ExactRates {
  return Object.fromEntries(RATE_KEYS.map(key => {
    const raw = rates[key];
    if (key === "in_cache_write" && raw == null) return [key, null];
    if (raw == null) throw new Error(`Missing rate: ${key}`);
    const value = decimal(raw);
    if (value.n < 0n) throw new Error(`Negative rate: ${key}`);
    return [key, value];
  })) as ExactRates;
}
const keyOf = (model: string | null, speed: Speed, basis: Basis) => JSON.stringify([model, speed, basis]);
export function compileReferenceConfig(config: ReferenceConfig, resolvedPremium?: boolean): CompiledReferenceConfig {
  if (config.version !== 1 || !Array.isArray(config.rules)) throw new Error("Invalid reference config");
  const premium = config.long_context_premium ?? resolvedPremium;
  if (premium !== undefined && typeof premium !== "boolean") throw new Error("Invalid premium flag");
  if (premium === undefined && config.rules.some(rule => rule.long_context)) {
    throw new Error("Resolve the legacy long-context default explicitly before compiling");
  }
  const ids = new Set<string>(), index = new Map<string, ExactRule[]>();
  for (const rule of config.rules) {
    if (!rule.id?.trim() || ids.has(rule.id) || !rule.model?.trim()) throw new Error("Invalid rule identity");
    ids.add(rule.id);
    if (!["standard", "fast"].includes(rule.speed)
      || !["chatgpt_credits", "api_equivalent_usd"].includes(rule.billing_basis)) throw new Error("Invalid basis/speed");
    if (!isAccountingDay(rule.valid_from)
      || (rule.valid_until !== undefined && (!isAccountingDay(rule.valid_until) || rule.valid_until <= rule.valid_from))) {
      throw new Error("Invalid rule dates");
    }
    const multiplier = decimal(rule.multiplier), rates = exactRates(rule.rates);
    if (multiplier.n <= 0n) throw new Error("Invalid multiplier");
    if (rule.billing_basis === "api_equivalent_usd" && !equal(multiplier, ONE)) throw new Error("API multiplier must be one");
    const long = rule.long_context;
    if (long && (!Number.isSafeInteger(long.above_input_tokens) || long.above_input_tokens <= 0)) {
      throw new Error("Invalid long-context threshold");
    }
    const longRates = long ? exactRates(long.rates) : undefined;
    if (rule.billing_basis === "chatgpt_credits" && (rates.in_cache_write !== null || longRates?.in_cache_write != null)) {
      throw new Error("Credit cache-write rate is not established");
    }
    const bucket = index.get(keyOf(rule.model, rule.speed, rule.billing_basis)) ?? [];
    if (bucket.some(other => rule.valid_from < (other.valid_until ?? "9999-12-31")
      && other.valid_from < (rule.valid_until ?? "9999-12-31"))) throw new Error(`Overlapping rule: ${rule.id}`);
    bucket.push({ ...rule, rates, multiplier,
      long_context: long && longRates ? { above_input_tokens: long.above_input_tokens, rates: longRates } : undefined });
    index.set(keyOf(rule.model, rule.speed, rule.billing_basis), bucket);
  }
  return { compiled: true, premium: premium ?? false, index };
}
type Config = ReferenceConfig | CompiledReferenceConfig;
const compiled = (config: Config): CompiledReferenceConfig => "compiled" in config ? config : compileReferenceConfig(config);
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const absent = (reason: Reason): Price => ({ amount: null, reason, rule_id: null, long_context: false });
export function priceCodexEventExact(config: Config, event: Event, basis: Basis, referenceDay?: string): Price {
  const c = compiled(config);
  if (event.model === "codex-auto-review") return absent("missing_rate");
  if (![event.in_tok, event.cached_in, event.cache_write, event.out_tok].every(safe)
    || event.cached_in + event.cache_write > event.in_tok || !Number.isSafeInteger(event.in_tok + event.out_tok)
    || event.usage_status === "invalid" || event.cache_write_status === "invalid") return absent("invalid_tokens");
  if (event.usage_status === "unknown" || event.usage_status === "incomplete") return absent("incomplete_usage");
  const day = referenceDay ?? event.ts.slice(0, 10);
  if (!isAccountingDay(day) || !isAccountingDay(event.ts.slice(0, 10)) || !Number.isFinite(Date.parse(event.ts))) {
    return absent("invalid_timestamp");
  }
  if (event.speed !== "standard" && event.speed !== "fast") return absent("unknown_speed");
  if (basis === "chatgpt_credits" && event.cache_write > 0) return absent("cache_write_semantics_unknown");
  const rule = c.index.get(keyOf(event.model, event.speed, basis))
    ?.find(candidate => day >= candidate.valid_from && (!candidate.valid_until || day < candidate.valid_until));
  if (!rule) return absent("missing_rate");
  const long = !!rule.long_context && c.premium && event.in_tok > rule.long_context.above_input_tokens;
  const rates = long ? rule.long_context!.rates : rule.rates;
  if (event.cache_write > 0 && rates.in_cache_write === null) return absent("missing_cache_write_rate");
  const counters = [event.in_tok - event.cached_in - event.cache_write, event.cached_in, event.cache_write, event.out_tok];
  const total = RATE_KEYS.reduce((sum, key, i) => add(sum, multiply(rational(BigInt(counters[i]!)), rates[key] ?? ZERO)), ZERO);
  return { amount: multiply(divide(total, rational(1_000_000n)), rule.multiplier),
    reason: null, rule_id: rule.id, long_context: long };
}

export const VARIANTS = ["api_standard", "api_standard_credited", "api_actual", "credits_standard", "credits_fast",
  "normalized_usd", "extra_credits", "window_api", "window_credits_low", "window_credits_high", "window_normalized"] as const;
export type Variant = typeof VARIANTS[number];
export interface Counter {
  subtotal: Rational; pricedSubtotal: Rational; value: Rational | null;
  pricedEvents: bigint; unpricedEvents: bigint; pricedTokens: bigint; unpricedTokens: bigint;
  reasons: Record<string, { events: bigint; tokens: bigint }>;
}
export type Counts = Record<Variant, Counter>;
type RecordedPrice = Pick<Price, "amount" | "reason">;
function record(price: RecordedPrice | null, tokens: bigint, signed = false): Counter {
  const valid = price?.amount != null && (signed || price.amount.n >= 0n);
  return { subtotal: valid ? price!.amount! : ZERO, pricedSubtotal: valid ? price!.amount! : ZERO,
    value: valid ? price!.amount! : null, pricedEvents: valid ? 1n : 0n, unpricedEvents: valid ? 0n : 1n,
    pricedTokens: valid ? tokens : 0n, unpricedTokens: valid ? 0n : tokens,
    reasons: valid ? {} : { [price?.reason ?? (price ? "invalid_valuation" : "unknown_speed")]: { events: 1n, tokens } } };
}
const ratio = (actual: Rational | null, standard: Rational | null): Rational | null =>
  actual === null || standard === null ? null : standard.n > 0n ? divide(actual, standard) : actual.n === 0n ? ONE : null;
/** Matches the legacy bucket guard, including Number coercion of stored text. */
const integer = (value: unknown): bigint => {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return safe(n) ? BigInt(n) : 0n;
};
export function referenceCodexEvent(config: Config, event: Event) {
  const day = String(event.ts ?? "").slice(0, 10);
  if (!isAccountingDay(day)) return null;
  const c = compiled(config), standard = { ...event, speed: "standard" }, fast = { ...event, speed: "fast" };
  const prices = [priceCodexEventExact(c, standard, "chatgpt_credits"), priceCodexEventExact(c, fast, "chatgpt_credits"),
    priceCodexEventExact(c, standard, "api_equivalent_usd"), priceCodexEventExact(c, fast, "api_equivalent_usd")] as const;
  const [cs, cf, api, apiFast] = prices;
  const speed = event.speed === "standard" || event.speed === "fast" ? event.speed
    : event.service_tier == null ? "standard" : "unknown";
  const actual = speed === "standard" ? cs : speed === "fast" ? cf : null;
  const apiActual = speed === "standard" ? api : speed === "fast" ? apiFast : null;
  const usable = safe(event.in_tok) && safe(event.out_tok) && Number.isSafeInteger(event.in_tok + event.out_tok);
  const reported = usable ? BigInt(event.in_tok) + BigInt(event.out_tok) : 0n;
  const burden = ratio(actual?.amount ?? null, cs.amount);
  const counts = {} as Counts;
  counts.api_standard = record(api, reported);
  counts.api_standard_credited = record(cs.amount !== null && api.amount !== null
    ? { amount: api.amount, reason: null } : { amount: null, reason: cs.amount === null ? cs.reason : api.reason }, reported);
  counts.api_actual = record(apiActual, reported);
  counts.credits_standard = record(cs, reported); counts.credits_fast = record(cf, reported);
  counts.normalized_usd = record(burden !== null && api.amount !== null
    ? { amount: multiply(api.amount, burden), reason: null }
    : { amount: null, reason: actual?.reason ?? api.reason ?? "unknown_speed" }, reported);
  counts.extra_credits = record(actual?.amount != null && cs.amount !== null
    ? { amount: subtract(actual.amount, cs.amount), reason: null }
    : { amount: null, reason: actual?.reason ?? cs.reason ?? "unknown_speed" }, reported, true);
  const low = speed === "fast" ? cf : cs, high = actual ?? cf;
  const lowRatio = ratio(low.amount, cs.amount);
  const normalized = lowRatio !== null && api.amount !== null ? multiply(api.amount, lowRatio) : null;
  const early = day < "2026-04-02";
  const blocker = early ? api.amount === null ? api : null
    : [api, low, high].find(price => price.amount === null) ?? (normalized === null ? absent("missing_rate") : null);
  const windowAmounts = [api.amount, early ? ZERO : low.amount, early ? ZERO : high.amount, early ? api.amount : normalized];
  (["window_api", "window_credits_low", "window_credits_high", "window_normalized"] as const).forEach((variant, i) => {
    counts[variant] = record(blocker ?? { amount: windowAmounts[i]!, reason: null }, reported);
  });
  const input = integer(event.in_tok), cached = integer(event.cached_in), write = integer(event.cache_write);
  const windowUsable = [event.in_tok, event.out_tok, event.cached_in].every(safe) && event.cached_in <= event.in_tok;
  return { day, speed, calls: 1n, prices, multiplier: burden, reported, counts,
    tokens: { in_uncached: input > cached + write ? input - cached - write : 0n, in_cache_read: cached,
      in_cache_write: 0n, in_cache_write_unknown: write, out_total: integer(event.out_tok), reasoning_out: integer(event.reasoning_out) },
    window_tokens: { input: windowUsable ? BigInt(event.in_tok) : 0n, cached: windowUsable ? BigInt(event.cached_in) : 0n,
      output: windowUsable ? BigInt(event.out_tok) : 0n },
    quality: { invalid_token_events: event.usage_status === "invalid" || event.cache_write_status === "invalid"
      || input < cached + write || !usable ? 1n : 0n, unknown_speed_tokens: speed === "unknown" ? reported : 0n } };
}
export function mergeCounters(a: Counter, b: Counter): Counter {
  const reasons: Counter["reasons"] = {};
  for (const key of new Set([...Object.keys(a.reasons), ...Object.keys(b.reasons)])) {
    reasons[key] = { events: (a.reasons[key]?.events ?? 0n) + (b.reasons[key]?.events ?? 0n),
      tokens: (a.reasons[key]?.tokens ?? 0n) + (b.reasons[key]?.tokens ?? 0n) };
  }
  const subtotal = add(a.subtotal, b.subtotal), unpricedEvents = a.unpricedEvents + b.unpricedEvents;
  return { subtotal, pricedSubtotal: add(a.pricedSubtotal, b.pricedSubtotal), value: unpricedEvents ? null : subtotal,
    pricedEvents: a.pricedEvents + b.pricedEvents, unpricedEvents, pricedTokens: a.pricedTokens + b.pricedTokens,
    unpricedTokens: a.unpricedTokens + b.unpricedTokens, reasons };
}
export const serializeCounter = (c: Counter) => ({
  subtotal: serializeRational(c.subtotal), pricedSubtotal: serializeRational(c.pricedSubtotal),
  value: c.value === null ? null : serializeRational(c.value), pricedEvents: String(c.pricedEvents),
  unpricedEvents: String(c.unpricedEvents), pricedTokens: String(c.pricedTokens), unpricedTokens: String(c.unpricedTokens),
  reasons: Object.fromEntries(Object.entries(c.reasons).map(([key, v]) => [key, { events: String(v.events), tokens: String(v.tokens) }])),
});
/** Audit each corresponding normal/long band separately, using effective rates. */
export function auditBandProportionality(standard: Rates, tier: Rates, standardMultiplier: DecimalInput = 1,
  tierMultiplier: DecimalInput = 1) {
  const a = exactRates(standard), b = exactRates(tier), ma = decimal(standardMultiplier), mb = decimal(tierMultiplier);
  if (ma.n <= 0n || mb.n <= 0n) throw new Error("Invalid multiplier");
  let common: Rational | null = null;
  const components: Partial<Record<typeof RATE_KEYS[number], Rational | null>> = {}, issues: string[] = [];
  for (const key of RATE_KEYS) {
    if (a[key] === null || b[key] === null) {
      if (a[key] !== b[key]) issues.push(`${key}: missing rate on one side`);
      components[key] = null; continue;
    }
    const left = multiply(a[key]!, ma), right = multiply(b[key]!, mb);
    if (!left.n) { components[key] = null; if (right.n) issues.push(`${key}: zero standard, positive tier`); continue; }
    const current = divide(right, left);
    components[key] = current;
    if (common !== null && !equal(common, current)) issues.push(`${key}: unequal exact ratio`);
    common ??= current;
  }
  return { proportional: issues.length === 0, ratio: issues.length ? null : common ?? ONE, components, issues };
}
