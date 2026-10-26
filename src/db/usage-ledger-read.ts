import type { Database } from "bun:sqlite";
import { FEMTO_PER_NANO, FEMTO_PER_USD, ledgerMoneyDecimal, sqlProvider, USAGE_LEDGER_VERSION, type UsageLedgerProvider } from "./usage-ledger";
import { encodeCounts, encodeQuality, encodeTokens, type StoredAmount, type StoredCounts } from "./usage-price-measures";
import type { UsagePriceDimension } from "./usage-price-totals";
import { subscriptionRulesDigest } from "./usage-price-totals";
import { subscriptionAccountingAdapters, usageLedgerProviderIds } from "../server/subscription-accounting-adapters";
import type { RateCard } from "../server/pricing";

/**
 * Readers of the usage ledger in the register's shapes (`RegisterDayRow` measures encoded as
 * `usage-price-measures` encodes them), so the day readers keep one algorithm for every provider.
 * Nothing here prepares, prices or scans more than one source day of facts.
 */
export const isUsageLedgerProvider = (provider: string): boolean => usageLedgerProviderIds().includes(provider);
/** The ledger provider a provider name or alias denotes (`anthropic` is Claude), or null (Codex, unknown). */
export function usageLedgerProviderOf(provider: string): UsageLedgerProvider | null {
  const id = subscriptionAccountingAdapters().find(adapter => adapter.aliases.includes(provider.toLowerCase()))?.id;
  return id && isUsageLedgerProvider(id) ? id as UsageLedgerProvider : null;
}
export const usageLedgerScope = (provider: string) => `usage-ledger:${provider}`;
const VARIANTS = { api_standard: "std", api_actual: "act", api_global: "glb" } as const;
const QUALITY = ["duplicates", "conflicts", "conflicted_identities", "approximate_time_events", "invalid_token_events",
  "unknown_speed_tokens", "source_events", "attribution_conflicts"] as const;
const TOKENS = { in_uncached: "t_uncached", in_cache_read: "t_cache_read", in_cache_write_5m: "t_write_5m",
  in_cache_write_1h: "t_write_1h", in_cache_write_unknown: "t_write_unknown", out_total: "t_out", reasoning_out: "t_thinking" } as const;

export type LedgerHead = { scope: string; provider: string; version: number; cursor: number; phase: string; status: string;
  rules_digest: string; sources: string; mirror_policy: number };
export type LedgerReadiness =
  | { state: "absent"; head: null; reason: "usage-price-register-absent" }
  | { state: "pending"; head: LedgerHead | null; reason: string }
  | { state: "ready"; head: LedgerHead; reason: null };

const exists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * Ready means readable: published once (complete at some revision) under this card's rules. Newer facts
 * being processed leave the published day sums readable; `head.status` and `head.cursor` say so, and
 * the response's freshness header names it (read-freshness.ts). A first build and a price change
 * (revaluation under new rules) are "pending".
 */
export function usageLedgerReadiness(db: Database, provider: string, card: RateCard): LedgerReadiness {
  // The revisions outlive the source table: a ledger keeps serving after its raw rows are gone.
  if (!exists(db, "usage_ledger_state") || !exists(db, "fact_day_revisions")) return { state: "absent", head: null, reason: "usage-price-register-absent" };
  const state = db.query("SELECT * FROM usage_ledger_state WHERE provider=?").get(provider) as
    { version: number; covered: number; phase: string; status: string; rules_digest: string; published_revision: number } | null;
  if (!state) return { state: "absent", head: null, reason: "usage-price-register-absent" };
  const head: LedgerHead = { scope: usageLedgerScope(provider), provider, version: state.version, cursor: state.covered,
    phase: state.phase, status: state.status, rules_digest: state.rules_digest, sources: "", mirror_policy: 0 };
  const pending = (reason: string): LedgerReadiness => ({ state: "pending", head, reason });
  if (state.version !== USAGE_LEDGER_VERSION || !state.published_revision) return pending("usage-price-preparation-required");
  if (card.currency !== "USD" || !["per 1M", "USD per 1,000,000 tokens"].includes(card.unit)) return pending("usage-price-unsupported-currency-or-unit");
  if (state.rules_digest !== subscriptionRulesDigest(card, provider)) return pending("usage-price-rules-pending");
  return { state: "ready", head, reason: null };
}

export function usageLedgerDimensions(db: Database, provider: string): Map<string, UsagePriceDimension> {
  return new Map((db.query("SELECT id,source,identity,model,speed,subject,vendor FROM usage_ledger_dims WHERE provider=?").all(provider) as
    Array<{ id: number; source: string | null; identity: string | null; model: string | null; speed: string | null; subject: string | null;
      vendor: string | null }>).map(({ id, ...dimension }) =>
    [String(id), { ...dimension, billing_mode: null, surface: null, nested: null }]));
}

type Measures = Record<string, number | string | null | undefined>;
function amountOf(row: Measures, prefix: string, reasons: Record<string, [number, number]>): StoredAmount {
  const money = (kind: string) => ledgerMoneyDecimal(row[`${prefix}_${kind}_usd`] ?? 0, row[`${prefix}_${kind}_nano`] ?? 0, row[`${prefix}_${kind}_femto`] ?? 0);
  return { subtotal: money("sub"), pricedSubtotal: money("priced"),
    pricedEvents: String(row[`${prefix}_priced_events`] ?? 0), unpricedEvents: String(row[`${prefix}_unpriced_events`] ?? 0),
    pricedTokens: String(row[`${prefix}_priced_tokens`] ?? 0), unpricedTokens: String(row[`${prefix}_unpriced_tokens`] ?? 0),
    reasons: Object.fromEntries(Object.entries(reasons).map(([reason, [events, tokens]]) => [reason, { events: String(events), tokens: String(tokens) }])) };
}
/** One stored measure row (a day aggregate or a single contribution) in the register's encoded form. */
function encoded(row: Measures, reasons: Record<string, Record<string, [number, number]>>) {
  const counts: StoredCounts = Object.fromEntries(Object.entries(VARIANTS).map(([variant, prefix]) =>
    [variant, amountOf(row, prefix, reasons[variant] ?? {})]));
  return { tokens: encodeTokens(Object.fromEntries(Object.entries(TOKENS).map(([key, column]) => [key, String(row[column] ?? 0)]))),
    tokens_reported: String(row.tokens_reported ?? 0), counts: encodeCounts(counts),
    quality: encodeQuality(Object.fromEntries(QUALITY.map(key => [key, String(row[key] ?? 0)]))) };
}

const DAY_SUMS = [...Object.values(TOKENS), "tokens_reported", ...QUALITY, ...Object.values(VARIANTS).flatMap(prefix =>
  ["priced_events", "unpriced_events", "priced_tokens", "unpriced_tokens", "sub_usd", "sub_nano", "sub_femto", "priced_usd", "priced_nano", "priced_femto"]
    .map(field => `${prefix}_${field}`))];
export interface LedgerStoredDay { day: string; dim: string; copy: string | null; calls: number; calls_exact: string; first_ts: string;
  first_key: string; last_ts: string; tokens: string; tokens_reported: string; counts: string; quality: string }
export function usageLedgerStoredDays(db: Database, provider: string, since: string, until: string): LedgerStoredDay[] {
  const reasons = new Map<string, Record<string, Record<string, [number, number]>>>();
  for (const r of db.query(`SELECT day,dim_id,variant,reason,events,tokens FROM usage_ledger_day_reasons WHERE provider=? AND day>=? AND day<=?`)
    .all(provider, since, until) as Array<{ day: string; dim_id: number; variant: string; reason: string; events: number; tokens: number }>) {
    const key = `${r.day}|${r.dim_id}`, byVariant = reasons.get(key) ?? reasons.set(key, {}).get(key)!;
    (byVariant[r.variant] ??= {})[r.reason] = [r.events, r.tokens];
  }
  // Summed counters and money are read as text: a sum can pass 2^53, which a JS number would round.
  return (db.query(`SELECT day,dim_id,calls,first_ts,first_key,last_ts,${DAY_SUMS.map(column => `CAST(${column} AS TEXT) ${column}`).join(",")}
    FROM usage_ledger_days WHERE provider=? AND day>=? AND day<=?`).all(provider, since, until) as Measures[])
    .map(row => ({ day: String(row.day), dim: String(row.dim_id), copy: null, calls: Number(row.calls), calls_exact: String(row.calls),
      first_ts: String(row.first_ts), first_key: String(row.first_key), last_ts: String(row.last_ts),
      ...encoded(row, reasons.get(`${row.day}|${row.dim_id}`) ?? {}) }));
}

/** The day sums an account history reads (`readRegisterDayMeasures`), in `usageLedgerStoredDays` order; money limbs as text. */
export interface LedgerDayMeasures { day: string; dim_id: number; calls: number; first_ts: string; last_ts: string; conflicts: number;
  t_uncached: number; t_cache_read: number; t_write_5m: number; t_write_1h: number; t_write_unknown: number; t_out: number;
  act_priced_usd: string; act_priced_nano: string; act_priced_femto: string; act_unpriced_tokens: number; act_unpriced_events: number }
export function usageLedgerDayMeasures(db: Database, provider: string, since: string, until: string): LedgerDayMeasures[] {
  return db.query(`SELECT day,dim_id,calls,first_ts,last_ts,conflicts,t_uncached,t_cache_read,t_write_5m,t_write_1h,t_write_unknown,t_out,
      CAST(act_priced_usd AS TEXT) act_priced_usd,CAST(act_priced_nano AS TEXT) act_priced_nano,CAST(act_priced_femto AS TEXT) act_priced_femto,
      act_unpriced_tokens,act_unpriced_events
    FROM usage_ledger_days WHERE provider=? AND day>=? AND day<=?`).all(provider, since, until) as LedgerDayMeasures[];
}
/** One contribution of a source day as an account history reads it (`readRegisterDayMeasures`). */
export interface LedgerContributionMeasures { dim_id: number; ts: string; source_key: string; marker: boolean; eligible: boolean;
  priced: boolean; tokens: bigint; total: bigint; femto: bigint }
/** The contributions of `usageLedgerContributions` (same facts, same order) with the history's measures only. */
export function usageLedgerContributionMeasures(db: Database, provider: string, source: string | null, day: string): LedgerContributionMeasures[] {
  const rows = db.query(`SELECT dim_id,ts,source_key,copy_state,usage_valid,eligible,q_uncached,q_cache_read,q_write_5m,q_write_1h,q_write_unknown,q_out,
      act_reason,CAST(act_usd AS TEXT) act_usd,CAST(act_nano AS TEXT) act_nano,CAST(act_femto AS TEXT) act_femto
    FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
    WHERE provider=${sqlProvider(provider)} AND day=? AND source IS ? AND dim_id IS NOT NULL
      AND ((copy_state='canonical' AND accounting=1) OR (copy_state='conflict' AND conflict_first IS NOT NULL))`)
    .all(day, source) as Array<{ dim_id: number; ts: string; source_key: string; copy_state: string; usage_valid: number; eligible: number;
      q_uncached: number; q_cache_read: number; q_write_5m: number; q_write_1h: number; q_write_unknown: number; q_out: number;
      act_reason: string | null; act_usd: string | null; act_nano: string | null; act_femto: string | null }>;
  return rows.map(fact => {
    const marker = fact.copy_state === "conflict";
    const tokens = BigInt(fact.q_uncached) + BigInt(fact.q_cache_read) + BigInt(fact.q_write_5m) + BigInt(fact.q_write_1h)
      + BigInt(fact.q_write_unknown) + BigInt(fact.q_out);
    return { dim_id: fact.dim_id, ts: marker ? `${day}T00:00:00.000Z` : String(fact.ts), source_key: String(fact.source_key), marker,
      eligible: fact.eligible === 1, priced: fact.act_reason === null, tokens, total: fact.usage_valid === 1 ? tokens : 0n,
      femto: BigInt(fact.act_usd ?? 0) * FEMTO_PER_USD + BigInt(fact.act_nano ?? 0) * FEMTO_PER_NANO + BigInt(fact.act_femto ?? 0) };
  });
}

/**
 * One source day's contributions, as the day aggregate counted them: canonical facts on an
 * accounting day, and one marker per conflicted identity. A period-cut day is split from these.
 */
export interface LedgerContribution { dim: string; copy: string; ts: string; source_key: string; calls: number; calls_exact: string;
  tokens: string; tokens_reported: string; counts: string; quality: string }
const CONTRIBUTION_COLUMNS = ["dim_id", "ts", "source_key", "copy_state", "usage_valid", "eligible", "speed", "precise_time", "copies", "flagged",
  "conflict_first", "q_uncached", "q_cache_read", "q_write_5m", "q_write_1h", "q_write_unknown", "q_out", "q_thinking",
  ...Object.values(VARIANTS).flatMap(prefix => ["reason", "usd", "nano", "femto"].map(field => `${prefix}_${field}`))].join(",");
export function usageLedgerContributions(db: Database, provider: string, source: string | null, day: string, speedTracked: boolean): LedgerContribution[] {
  const P = sqlProvider(provider);
  // Only the columns a contribution reads: the fact rows are wide, and materializing all of them was most of a cut day's cost.
  const rows = db.query(`SELECT ${CONTRIBUTION_COLUMNS} FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
    WHERE provider=${P} AND day=? AND source IS ? AND dim_id IS NOT NULL
      AND ((copy_state='canonical' AND accounting=1) OR (copy_state='conflict' AND conflict_first IS NOT NULL))`)
    .all(day, source) as Measures[];
  return rows.map(fact => {
    const marker = fact.copy_state === "conflict";
    const valid = fact.usage_valid === 1;
    const total = valid ? ["q_uncached", "q_cache_read", "q_write_5m", "q_write_1h", "q_write_unknown", "q_out"]
      .reduce((sum, column) => sum + Number(fact[column]), 0) : 0;
    const variant = (prefix: string, applies: boolean): Measures => {
      if (marker || !applies) return {};
      const priced = fact[`${prefix}_reason`] === null;
      return { [`${prefix}_priced_events`]: priced ? 1 : 0, [`${prefix}_unpriced_events`]: priced ? 0 : 1,
        [`${prefix}_priced_tokens`]: priced ? total : 0, [`${prefix}_unpriced_tokens`]: priced ? 0 : total,
        ...Object.fromEntries(["usd", "nano", "femto"].flatMap(limb => [[`${prefix}_sub_${limb}`, fact[`${prefix}_${limb}`]],
          [`${prefix}_priced_${limb}`, priced ? fact[`${prefix}_${limb}`] : 0]])) };
    };
    const eligible = fact.eligible === 1;
    const measures: Measures = marker
      ? { conflicts: 1, conflicted_identities: fact.conflict_first, source_events: fact.copies, attribution_conflicts: fact.flagged }
      : { t_uncached: fact.q_uncached, t_cache_read: fact.q_cache_read, t_write_5m: fact.q_write_5m, t_write_1h: fact.q_write_1h,
        t_write_unknown: fact.q_write_unknown, t_out: fact.q_out, t_thinking: fact.q_thinking, tokens_reported: total,
        duplicates: Number(fact.copies) - 1, approximate_time_events: 1 - Number(fact.precise_time), invalid_token_events: valid ? 0 : 1,
        unknown_speed_tokens: speedTracked && fact.speed !== "standard" && fact.speed !== "fast" ? total : 0,
        source_events: fact.copies, attribution_conflicts: fact.flagged,
        ...variant("std", eligible), ...variant("act", eligible), ...variant("glb", true) };
    const reasons: Record<string, Record<string, [number, number]>> = {};
    if (!marker) for (const [name, prefix] of Object.entries(VARIANTS)) {
      const reason = fact[`${prefix}_reason`];
      if (reason !== null && (eligible || prefix === "glb")) reasons[name] = { [String(reason)]: [1, total] };
    }
    return { dim: String(fact.dim_id), copy: JSON.stringify(["", source ?? ""]), ts: marker ? `${day}T00:00:00.000Z` : String(fact.ts),
      source_key: String(fact.source_key), calls: 1, calls_exact: "1", ...encoded(measures, reasons) };
  });
}

/** First and last day of a provider's ledger. */
export function usageLedgerDayBounds(db: Database, provider: string): { since: string | null; until: string | null } {
  return db.query("SELECT MIN(day) since,MAX(day) until FROM usage_ledger_days WHERE provider=?").get(provider) as
    { since: string | null; until: string | null };
}

/** Conflicted identities with a marker on a day of the range; one per identity however many days it spans. */
export function usageLedgerConflictedIdentities(db: Database, provider: string, since: string, until: string): number {
  return (db.query(`SELECT COUNT(DISTINCT identity) n FROM usage_ledger_facts INDEXED BY usage_ledger_facts_day_${provider}
    WHERE provider=${sqlProvider(provider)} AND day>=? AND day<=? AND copy_state='conflict' AND conflict_first IS NOT NULL`)
    .get(since, until) as { n: number }).n;
}
