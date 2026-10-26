import { TOKEN_BUCKETS } from "../server/subscription-accounting-adapters";

/**
 * Stored form of the usage price register's measures (`counts`, `quality`, `tokens`).
 *
 * The named JSON form repeats every key on every row: measured on the live register it is 1.7 KB
 * of a 2.2 KB Codex contribution. The compact form is positional and drops zeros, 182 bytes for
 * the same rows, and decodes to the identical object (docs/handoff-2026-09-21b.md, section 4b).
 * Positions are part of the stored format: append to these lists, never reorder or remove.
 * The variant order keeps both the Codex and the subscription variants in the relative order
 * their producers write them, so a decoded object lists its keys as the named form did.
 */
export const USAGE_PRICE_VARIANT_ORDER = ["api_standard", "api_standard_credited", "api_actual", "api_global",
  "credits_standard", "credits_fast", "normalized_usd", "extra_credits",
  "window_api", "window_credits_low", "window_credits_high", "window_normalized"] as const;
export const USAGE_PRICE_QUALITY_KEYS = ["duplicates", "conflicts", "conflicted_identities", "approximate_time_events",
  "invalid_token_events", "unattributed_events", "unknown_speed_tokens",
  "source_events", "attribution_conflicts"] as const;
/** The disjoint buckets, plus `reasoning_out`, which is nested inside `out_total`, not disjoint. */
export const USAGE_PRICE_TOKEN_KEYS = [...TOKEN_BUCKETS, "reasoning_out"] as const;
/**
 * What a counter window counts as tokens. It is not `tokens`: a window takes an event's input,
 * cached input and output only when all three are usable and the cached part fits the input.
 */
export const USAGE_PRICE_WINDOW_TOKEN_KEYS = ["input", "cached", "output"] as const;

/** Register version 7 rebuilt every row, so writers use the compact form; readers still accept the named one. */
const WRITE_COMPACT = true;

export type StoredReason = { events: string; tokens: string };
export interface StoredAmount {
  exact?: {
    subtotal: { numerator: string; denominator: string; decimal: string | null };
    pricedSubtotal: { numerator: string; denominator: string; decimal: string | null };
    value: { numerator: string; denominator: string; decimal: string | null } | null;
  };
  subtotal: string; pricedSubtotal: string; pricedEvents: string; unpricedEvents: string;
  pricedTokens: string; unpricedTokens: string; reasons: Record<string, StoredReason>;
}
export type StoredCounts = Record<string, StoredAmount>;
export type StoredMap = Record<string, string>;

type Counter = string | number;
type PackedReasons = Record<string, [Counter, Counter]>;
type PackedAmount = Array<Counter | null | PackedReasons>;

/** Counters are decimal integer texts; only a safe one that prints back identically becomes a number. */
const counter = (text: string): Counter => {
  const value = Number(text);
  return Number.isSafeInteger(value) && String(value) === text ? value : text;
};
const text = (value: Counter | null | undefined | PackedReasons): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "0";

function packAmount(amount: StoredAmount): PackedAmount {
  const reasons: PackedReasons = {};
  for (const reason in amount.reasons) reasons[reason] = [counter(amount.reasons[reason]!.events), counter(amount.reasons[reason]!.tokens)];
  // Amounts stay decimal text: a JSON number would round them through a double.
  const packed: PackedAmount = [amount.subtotal === "0" ? 0 : amount.subtotal,
    amount.pricedSubtotal === "0" ? 0 : amount.pricedSubtotal === amount.subtotal ? null : amount.pricedSubtotal,
    counter(amount.pricedEvents), counter(amount.unpricedEvents), counter(amount.pricedTokens),
    counter(amount.unpricedTokens), Object.keys(reasons).length ? reasons : 0];
  while (packed.length && packed.at(-1) === 0) packed.pop();
  return packed;
}

function unpackAmount(packed: PackedAmount): StoredAmount {
  const subtotal = text(packed[0]);
  const reasons: Record<string, StoredReason> = {};
  const stored = packed[6];
  if (stored && typeof stored === "object") {
    for (const reason in stored) reasons[reason] = { events: text(stored[reason]![0]), tokens: text(stored[reason]![1]) };
  }
  return { subtotal, pricedSubtotal: packed[1] === null ? subtotal : text(packed[1]),
    pricedEvents: text(packed[2]), unpricedEvents: text(packed[3]), pricedTokens: text(packed[4]),
    unpricedTokens: text(packed[5]), reasons };
}

export function encodeCounts(counts: StoredCounts, compact = WRITE_COMPACT): string {
  // Exact rational compatibility rows must retain their payload; compact legacy cells contain decimals only.
  if (Object.values(counts).some(amount => amount.exact)) return JSON.stringify(counts);
  if (!compact) return JSON.stringify(counts);
  for (const variant in counts) {
    if (!(USAGE_PRICE_VARIANT_ORDER as readonly string[]).includes(variant)) throw new Error(`Unknown usage price variant: ${variant}`);
  }
  // A variant equal to an earlier one is written as that variant's position; an absent one as null.
  const seen: string[] = [];
  const packed = USAGE_PRICE_VARIANT_ORDER.map((variant): PackedAmount | number | null => {
    const amount = counts[variant];
    if (!amount) { seen.push(""); return null; }
    const own = packAmount(amount), key = JSON.stringify(own), same = seen.indexOf(key);
    seen.push(key);
    return same >= 0 ? same : own;
  });
  while (packed.length && packed.at(-1) === null) packed.pop();
  return JSON.stringify(packed);
}

export function decodeCounts(stored: string): StoredCounts {
  const parsed = JSON.parse(stored) as StoredCounts | Array<PackedAmount | number | null>;
  if (!Array.isArray(parsed)) return parsed;
  const counts: StoredCounts = {};
  parsed.forEach((entry, index) => {
    if (entry === null) return;
    const variant = USAGE_PRICE_VARIANT_ORDER[index];
    const packed = typeof entry === "number" ? parsed[entry] : entry;
    if (variant === undefined || !Array.isArray(packed)) throw new Error("Usage price counts are not decodable");
    counts[variant] = unpackAmount(packed);
  });
  return counts;
}

function encodeMap(map: StoredMap, keys: readonly string[], compact: boolean): string {
  if (!compact) return JSON.stringify(map);
  for (const key in map) if (!keys.includes(key)) throw new Error(`Unknown usage price measure: ${key}`);
  const packed = keys.map(key => counter(map[key] ?? "0"));
  while (packed.length && packed.at(-1) === 0) packed.pop();
  return JSON.stringify(packed);
}

function decodeMap(stored: string, keys: readonly string[]): StoredMap {
  const parsed = JSON.parse(stored) as StoredMap | Counter[];
  if (!Array.isArray(parsed)) return parsed;
  return Object.fromEntries(keys.map((key, index) => [key, text(parsed[index])]));
}

export const encodeQuality = (quality: StoredMap, compact = WRITE_COMPACT): string => encodeMap(quality, USAGE_PRICE_QUALITY_KEYS, compact);
export const decodeQuality = (stored: string): StoredMap => decodeMap(stored, USAGE_PRICE_QUALITY_KEYS);
export const encodeTokens = (tokens: StoredMap, compact = WRITE_COMPACT): string => encodeMap(tokens, USAGE_PRICE_TOKEN_KEYS, compact);
export const decodeTokens = (stored: string): StoredMap => decodeMap(stored, USAGE_PRICE_TOKEN_KEYS);
/** A column born with the compact form, so it has no named one; empty stands for all zeros. */
export const encodeWindowTokens = (tokens: StoredMap): string =>
  Object.values(tokens).every(value => value === "0") ? "" : encodeMap(tokens, USAGE_PRICE_WINDOW_TOKEN_KEYS, true);
export const decodeWindowTokens = (stored: string): StoredMap => decodeMap(stored || "[]", USAGE_PRICE_WINDOW_TOKEN_KEYS);
