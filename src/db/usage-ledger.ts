import type { Database } from "bun:sqlite";
import { ACTIVITY_CUTOFF_MINUTES, ACTIVITY_INTERVALS_SCHEMA } from "./activity-intervals";
import { BUILT_IN_LEDGER_PROVIDERS, usageLedgerProviderIds } from "../server/subscription-accounting-adapters";

/**
 * The usage ledger: Claude, Gemini, Grok and GLM usage as typed facts with exact stored
 * valuations and day aggregates (docs/shared-register-plan-2026-10-03.md). It replaces the JSON
 * fact versions, the JSON per-event valuations and the decimal-text contributions of the old
 * register. Codex keeps its own ledger; the arithmetic and the read shapes are shared.
 *
 * Money is one fixed unit for every rate, stored in three limbs as the Codex ledger stores its own:
 * whole dollars, nano-dollars below one dollar and femto-dollars below one nano (`*_usd`, `*_nano`,
 * `*_femto`), so a day's sum of any limb stays far inside SQLite's integers. A card rate in USD per 1M tokens with at most nine decimal places
 * is an integer number of femto-dollars per token, so every product and sum is an exact integer
 * and aggregates add in SQL without per-rule denominators. A rate that does not fit is never
 * rounded: the event is unpriced with reason `invalid_valuation`.
 */
export const USAGE_LEDGER_VERSION = 2;
/** A provider of the shared ledger: the id of a registered adapter (`subscriptionAccountingAdapters`). */
export type UsageLedgerProvider = string;
/** Stored variant prefixes: dated standard-mode API rates, actual-mode rates, global usage's own rates. */
export const USAGE_LEDGER_VARIANTS = { api_standard: "std", api_actual: "act", api_global: "glb" } as const;
export type UsageLedgerVariant = keyof typeof USAGE_LEDGER_VARIANTS;

export const FEMTO_PER_NANO = 1_000_000n;
export const FEMTO_PER_USD = 1_000_000_000_000_000n;
const FEMTO_PER_TOKEN_SCALE = 9; // USD per 1M tokens -> femto-dollars per token: x 10^15 / 10^6

/**
 * A provider literal for SQL. Fact-table predicates name the provider literally so SQLite can use
 * the provider's partial indexes; the value comes from the fixed provider list, never from input.
 */
export function sqlProvider(provider: string): string {
  if (!usageLedgerProviderIds().includes(provider) || !/^[a-z0-9_]+$/.test(provider)) throw new Error(`Unknown usage ledger provider: ${provider}`);
  return `'${provider}'`;
}
/**
 * The secondary indexes of a provider's facts, partial so a first fill can build its own after
 * the backfill: maintained row by row they cost 5-6x the inserts themselves (03.10, 342k Claude
 * facts: 31 s with both, 9 s without plus 3-5 s to build them afterwards). The source-day index
 * finds the facts of a changed source day, including those whose source row is gone; the session index the
 * calls of a session whose activity gaps are recomputed (migration 0066).
 */
export function usageLedgerFactIndexes(provider: string): { names: string[]; create: string[] } {
  const literal = sqlProvider(provider);
  return { names: [`usage_ledger_facts_identity_${provider}`, `usage_ledger_facts_day_${provider}`, `usage_ledger_facts_src_day_${provider}`,
    `usage_ledger_facts_session_${provider}`],
    create: [`CREATE INDEX IF NOT EXISTS usage_ledger_facts_identity_${provider} ON usage_ledger_facts(identity) WHERE provider=${literal}`,
      `CREATE INDEX IF NOT EXISTS usage_ledger_facts_day_${provider} ON usage_ledger_facts(day) WHERE provider=${literal}`,
      `CREATE INDEX IF NOT EXISTS usage_ledger_facts_src_day_${provider} ON usage_ledger_facts(src_day) WHERE provider=${literal}`,
      `CREATE INDEX IF NOT EXISTS usage_ledger_facts_session_${provider} ON usage_ledger_facts(session, ts) WHERE provider=${literal}`] };
}

const valuationColumns = (prefix: string) =>
  `${prefix}_key INTEGER, ${prefix}_reason TEXT, ${prefix}_usd INTEGER, ${prefix}_nano INTEGER, ${prefix}_femto INTEGER`;
const amountColumns = (prefix: string) => `${prefix}_priced_events INTEGER NOT NULL DEFAULT 0,
  ${prefix}_unpriced_events INTEGER NOT NULL DEFAULT 0, ${prefix}_priced_tokens INTEGER NOT NULL DEFAULT 0,
  ${prefix}_unpriced_tokens INTEGER NOT NULL DEFAULT 0, ${prefix}_sub_usd INTEGER NOT NULL DEFAULT 0,
  ${prefix}_sub_nano INTEGER NOT NULL DEFAULT 0, ${prefix}_sub_femto INTEGER NOT NULL DEFAULT 0,
  ${prefix}_priced_usd INTEGER NOT NULL DEFAULT 0, ${prefix}_priced_nano INTEGER NOT NULL DEFAULT 0,
  ${prefix}_priced_femto INTEGER NOT NULL DEFAULT 0`;

/**
 * Timed calls of a day or hour (migration 0065): canonical calls with a known response time (`resp_ms`), their
 * output tokens and milliseconds, all of them and those with at least `LONG_CALL_OUT` output tokens. Speed is
 * `out * 1000 / ms` of these sums, never an average of per-call speeds.
 */
export const TIMED_SUMS = ["timed_calls", "timed_out", "timed_ms", "timed_long_calls", "timed_long_out", "timed_long_ms"] as const;
/** Output tokens from which a call counts as long: below it latency, not generation, dominates its time. */
export const LONG_CALL_OUT = 256;
export type TimedSums = Record<typeof TIMED_SUMS[number], number>;
const TIMED_COLUMNS = TIMED_SUMS.map(column => `${column} INTEGER NOT NULL DEFAULT 0`).join(", ");

/**
 * Stored activity (migration 0066, docs/stored-activity-plan-2026-10-07.md): the idle cutoffs a reader may select,
 * in minutes. A fact keeps its gap to its chain predecessor (`gap_ms`, `gap_from`); a day row keeps, per cutoff,
 * the sum of min(gap, cutoff) over its calls' positive gaps in integer milliseconds, the earliest predecessor
 * instant of those gaps (`gap_from_ts`) and its calls whose source day differs from their UTC day (`src_shift_calls`).
 */
export { ACTIVITY_CUTOFF_MINUTES } from "./activity-intervals";
export type ActivityCutoff = typeof ACTIVITY_CUTOFF_MINUTES[number];
export const activityColumn = (minutes: ActivityCutoff) => `active_${minutes}m_ms` as const;
const ACTIVITY_DAY_COLUMNS = [...ACTIVITY_CUTOFF_MINUTES.map(minutes => `${activityColumn(minutes)} INTEGER NOT NULL DEFAULT 0`),
  "gap_from_ts TEXT", "src_shift_calls INTEGER NOT NULL DEFAULT 0"].join(", ");

/**
 * The schema migrations leave (0046, extended by 0054, 0057, 0065 (response times), 0066 (stored activity), 0068 (repository and
 * group in the dimension key), 0069 (dimensions keyed by place: `subject` and `project_id` stay empty, `shift` is the calls'
 * raw day less their UTC day), 0070 (`act_key`: the actual-mode rate key a day row's eligible calls share, NULL without one), reconciled from source
 * days by 0060, and carrying the Codex price ledger's state and queue by 0062); tests compare them. `covered` is the source table's
 * whole-table change revision the ledger has reconciled (fact-day-revisions.ts); `usage_ledger_source_days`
 * holds each source day's revision the ledger has reconciled, its durable resume point. The `codex` rows
 * (state, queue kinds `copy`, `blocked` and `rules`, its bands as keys, `rules_json`) belong to the Codex
 * price ledger, whose facts and sums stay in its own tables (codex-ledger-state.ts). Queue kinds `session` (a session
 * whose gaps are recomputed) and `activity` (a day whose activity sums alone are re-summed) belong to stored activity;
 * `usage_ledger_mixed_sessions` lists the sessions with calls in more than one chain, whose activity stays out of the
 * day sums and is read from their facts.
 */
export const USAGE_LEDGER_SCHEMA_SQL = `
${ACTIVITY_INTERVALS_SCHEMA}
CREATE TABLE IF NOT EXISTS usage_ledger_state (
  provider TEXT PRIMARY KEY, version INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('backfill','resolve','revalue','reconcile')),
  status TEXT NOT NULL CHECK(status IN ('pending','ready')),
  covered INTEGER NOT NULL, bookmark TEXT NOT NULL, rules_digest TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, published_revision INTEGER NOT NULL DEFAULT 0, rules_json TEXT,
  activity_published INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_source_days (
  provider TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(provider, day)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_keys (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, key TEXT NOT NULL, rates TEXT NOT NULL,
  UNIQUE(provider, key)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_dims (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, key TEXT NOT NULL,
  source TEXT, identity TEXT, model TEXT, speed TEXT, subject TEXT, vendor TEXT,
  home TEXT, project_id TEXT, project TEXT, cwd TEXT, repo TEXT, repo_group TEXT, shift INTEGER,
  UNIQUE(provider, key)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_facts (
  provider TEXT NOT NULL, row_id INTEGER NOT NULL,
  identity TEXT NOT NULL, source_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  ts TEXT NOT NULL, day TEXT NOT NULL, accounting INTEGER NOT NULL,
  model TEXT, speed TEXT NOT NULL, source TEXT, account_key TEXT, identity_conflict INTEGER NOT NULL,
  eligible INTEGER NOT NULL, vendor TEXT NOT NULL, home TEXT NOT NULL, source_id TEXT NOT NULL,
  q_uncached INTEGER NOT NULL, q_cache_read INTEGER NOT NULL, q_write_5m INTEGER NOT NULL,
  q_write_1h INTEGER NOT NULL, q_write_unknown INTEGER NOT NULL, q_out INTEGER NOT NULL, q_thinking INTEGER NOT NULL,
  usage_valid INTEGER NOT NULL, precise_time INTEGER NOT NULL,
  product TEXT, subject TEXT, session TEXT, repo TEXT, repo_group TEXT, project TEXT,
  reported_raw REAL, reported_unit TEXT, reported_provenance TEXT,
  copy_state TEXT NOT NULL CHECK(copy_state IN ('pending','canonical','duplicate','conflict')),
  dim_id INTEGER, copies INTEGER, flagged INTEGER, conflict_first INTEGER,
  m_product TEXT, m_reported_raw REAL, m_reported_conflict INTEGER, cwd TEXT, project_name TEXT,
  src_day TEXT NOT NULL, src_hash TEXT NOT NULL,
  ${valuationColumns("std")}, ${valuationColumns("act")}, ${valuationColumns("glb")}, resp_ms INTEGER,
  gap_ms INTEGER, gap_from TEXT, billing_mode TEXT,
  PRIMARY KEY(provider, row_id)
) STRICT;
${BUILT_IN_LEDGER_PROVIDERS.flatMap(provider => usageLedgerFactIndexes(provider).create).join(";\n")};
CREATE TABLE IF NOT EXISTS usage_ledger_days (
  provider TEXT NOT NULL, day TEXT NOT NULL, dim_id INTEGER NOT NULL,
  calls INTEGER NOT NULL, first_ts TEXT NOT NULL, first_key TEXT NOT NULL, last_ts TEXT NOT NULL,
  t_uncached INTEGER NOT NULL, t_cache_read INTEGER NOT NULL, t_write_5m INTEGER NOT NULL,
  t_write_1h INTEGER NOT NULL, t_write_unknown INTEGER NOT NULL, t_out INTEGER NOT NULL, t_thinking INTEGER NOT NULL,
  tokens_reported INTEGER NOT NULL,
  duplicates INTEGER NOT NULL, conflicts INTEGER NOT NULL, conflicted_identities INTEGER NOT NULL,
  approximate_time_events INTEGER NOT NULL, invalid_token_events INTEGER NOT NULL,
  unknown_speed_tokens INTEGER NOT NULL, source_events INTEGER NOT NULL, attribution_conflicts INTEGER NOT NULL,
  ${amountColumns("std")}, ${amountColumns("act")}, ${amountColumns("glb")}, ${TIMED_COLUMNS}, ${ACTIVITY_DAY_COLUMNS}, act_key INTEGER,
  PRIMARY KEY(provider, day, dim_id)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_hours (
  provider TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, dim_id INTEGER NOT NULL,
  calls INTEGER NOT NULL, first_ts TEXT NOT NULL, last_ts TEXT NOT NULL,
  t_uncached INTEGER NOT NULL, t_cache_read INTEGER NOT NULL, t_write_5m INTEGER NOT NULL,
  t_write_1h INTEGER NOT NULL, t_write_unknown INTEGER NOT NULL, t_out INTEGER NOT NULL, t_thinking INTEGER NOT NULL,
  ${TIMED_COLUMNS},
  PRIMARY KEY(provider, day, hour, dim_id)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_day_reasons (
  provider TEXT NOT NULL, day TEXT NOT NULL, dim_id INTEGER NOT NULL, variant TEXT NOT NULL, reason TEXT NOT NULL,
  events INTEGER NOT NULL, tokens INTEGER NOT NULL,
  PRIMARY KEY(provider, day, dim_id, variant, reason)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_dirty (
  provider TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('identity','day','copy','blocked','rules','session','activity')), value TEXT NOT NULL,
  PRIMARY KEY(provider, kind, value)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_ledger_mixed_sessions (
  provider TEXT NOT NULL, session TEXT NOT NULL,
  PRIMARY KEY(provider, session)
) STRICT;`;

export function ensureUsageLedgerSchema(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_ledger_dirty'").get()) return;
  db.transaction(() => db.exec(USAGE_LEDGER_SCHEMA_SQL)).immediate();
}

/**
 * A card rate (USD per 1M tokens) as femto-dollars per token, or null when it has more than nine
 * decimal places and so no exact integer form. The number's shortest round-trip spelling is the
 * rate, as the Codex ledger reads a legacy numeric card.
 */
export function femtoPerToken(rate: number | string): bigint | null {
  const text = typeof rate === "number" ? String(rate) : rate.trim();
  const parsed = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!parsed) return null;
  const digits = parsed[1]! + (parsed[2] ?? ""), exponent = Number(parsed[3] ?? 0) - (parsed[2]?.length ?? 0) + FEMTO_PER_TOKEN_SCALE;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return null;
  if (exponent >= 0) return BigInt(digits) * 10n ** BigInt(exponent);
  const divisor = 10n ** BigInt(-exponent), value = BigInt(digits);
  return value % divisor === 0n ? value / divisor : null;
}

export interface LedgerMoney { usd: bigint; nano: bigint; femto: bigint }
export function splitFemto(total: bigint): LedgerMoney {
  if (total < 0n) throw new Error("Usage ledger amounts are never negative");
  return { usd: total / FEMTO_PER_USD, nano: total % FEMTO_PER_USD / FEMTO_PER_NANO, femto: total % FEMTO_PER_NANO };
}
/** Exact USD decimal text of three limbs (sums may carry a lower limb past its radix). */
export function ledgerMoneyDecimal(usd: bigint | number | string, nano: bigint | number | string, femto: bigint | number | string): string {
  const total = BigInt(usd) * FEMTO_PER_USD + BigInt(nano) * FEMTO_PER_NANO + BigInt(femto);
  const negative = total < 0n, magnitude = negative ? -total : total;
  const whole = magnitude / 10n ** 15n, fraction = (magnitude % 10n ** 15n).toString().padStart(15, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
