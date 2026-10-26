/** Frozen pre-optimization SQL from api.ts at 5c3ff57; diagnostic/test oracle only.
 * Never imported by the application. Keep predicates, selected fields and ORDER BY intact.
 */
import { createHash } from "node:crypto";

export const OVERVIEW_REFERENCE_SHA = "5c3ff575359c1f4c83d24af69f0b16b980e8e732";
export const OVERVIEW_REFERENCE_SQL_SHA256 = "a72ce60004c7e25c136a1367bfa3517a99ad003bdd1e13fcb31b083cf1405664";
export const FROZEN_ATTRIBUTED_PROBE_SQL = "COALESCE(era_unattributed, 0) = 0";
export const FROZEN_ATTRIBUTED_PROBE_SQL_SHA256 = "5e77f6aa064ab2a7c34dafdb5aafc6f8f53f6edab0bfbfe925045cf6d01aeb3f";
export const READ_PATH_BREAKDOWN_ROUTE = "/api/breakdown?since_ts=2020-01-01T00%3A00%3A00.000Z&until_ts=2020-01-02T00%3A00%3A00.000Z&dim=account&vendor=codex";
export const READ_PATH_BREAKDOWN_REFERENCE_SHA256 = "7edf3348b93cf5db73982ae95d1c297def4c711053c13f6a6fdcbc7883e8b376";
export const READ_PATH_BREAKDOWN_REFERENCE = {
  dim: "account",
  vendor: "codex",
  account: null,
  scope: {
    since: null,
    until: null,
    since_ts: "2020-01-01T00:00:00.000Z",
    until_ts: "2020-01-02T00:00:00.000Z",
    homes: [],
  },
  rows: [{
    name: "oracle",
    vendor: "codex",
    calls: 2,
    usd: 20.63,
    tokens: 3_300_000,
    token_details: {
      in_tok: 3_000_000,
      cached_in: 750_000,
      fresh_in: 2_250_000,
      cache_write: 30_000,
      out_tok: 300_000,
      reasoning_out: 75_000,
    },
  }],
  totals: { calls: 2, usd: 20.63, tokens: 3_300_000 },
  unpriced: { tokens: 0, models: {} },
} as const;
export const READ_PATH_CYCLE_BREAKDOWN_ROUTE = "/api/cycle-breakdown?since_ts=2020-01-01T12%3A00%3A00.000Z&until_ts=2020-01-01T18%3A00%3A00.000Z&account=oracle&limit_id=codex&session_window=1440";
export const READ_PATH_CYCLE_BREAKDOWN_REFERENCE_SHA256 = "fd3091b19ae49c9df89c689709aa7a3297579ee61b79a77b026363d7e0d1f804";
export const READ_PATH_CYCLE_BREAKDOWN_REFERENCE = {
  account: "oracle",
  since_ts: "2020-01-01T12:00:00.000Z",
  until_ts: "2020-01-01T18:00:00.000Z",
  limit_id: "codex",
  session_window_minutes: 1440,
  bucketing: "local time",
  dow_origin: "monday",
  days: [{
    date: "2020-01-01",
    dow: 2,
    from_ts: "2020-01-01T12:00:00.000Z",
    to_ts: "2020-01-01T18:00:00.000Z",
    hours: 6,
    calls: 1,
    tokens: 2_200_000,
    tokens_fresh: 1_700_000,
    usd: 13.75,
    top_model: "gpt-5.5",
    gauge_end: null,
    gauge_delta: null,
    gauge_samples: 0,
    is_today: false,
  }],
  sessions: [{
    index: 0,
    start_ts: "2020-01-01T12:00:00.000Z",
    end_ts: "2020-01-01T18:00:00.000Z",
    active: false,
    calls: 1,
    tokens: 2_200_000,
    tokens_fresh: 1_700_000,
    usd: 13.75,
    top_model: "gpt-5.5",
    reported_percent: null,
    reported_samples: 0,
    reported_reset_ts: null,
  }],
  short_counter: { reported: false, last_reported_ts: null, live: null, other: [] },
  burn_windows: [
    { label: "1h", hours: 1, calls: 0, tokens: 0, tokens_fresh: 0 },
    { label: "6h", hours: 6, calls: 0, tokens: 0, tokens_fresh: 0 },
    { label: "24h", hours: 24, calls: 0, tokens: 0, tokens_fresh: 0 },
    { label: "7d", hours: 168, calls: 0, tokens: 0, tokens_fresh: 0 },
  ],
  totals: { calls: 1, tokens: 2_200_000, tokens_fresh: 1_700_000, usd: 13.75 },
  unpriced: { tokens: 0, models: {} },
  note: null,
} as const;
export const REFERENCE_ACCOUNT_STATE_SQL = `SELECT p.subject AS account, p.limit_group AS limit_id, p.scope AS limit_name,
                p.plan AS plan_type, p.kind AS slot, p.window_minutes,
                p.used_percent, p.resets_at, p.rate_limit_reached, p.reset_credits, p.ts, p.machine
         FROM probe_windows p
         JOIN (
           SELECT subject, MAX(ts) AS ts
           FROM probe_windows
           WHERE provider = 'codex' AND kind <> 'error' AND COALESCE(ok, 1) = 1 AND COALESCE(era_unattributed, 0) = 0
           GROUP BY subject
         ) newest
           ON newest.subject = p.subject AND newest.ts = p.ts
         WHERE p.provider = 'codex' AND p.kind <> 'error' AND COALESCE(era_unattributed, 0) = 0
         ORDER BY p.subject, p.limit_group, p.kind`;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The application predicate is intentionally checked against an independent literal and hash.
 * The historical SQL never interpolates the mutable application constant.
 */
export function overviewOracleGuard(options: {
  attributedProbeSql?: string;
  referenceSql?: string;
} = {}) {
  const attributedProbeSql = options.attributedProbeSql ?? FROZEN_ATTRIBUTED_PROBE_SQL;
  const referenceSql = options.referenceSql ?? REFERENCE_ACCOUNT_STATE_SQL;
  const attributedPredicateMatches =
    attributedProbeSql === FROZEN_ATTRIBUTED_PROBE_SQL &&
    digest(attributedProbeSql) === FROZEN_ATTRIBUTED_PROBE_SQL_SHA256;
  const referenceMatches = digest(referenceSql) === OVERVIEW_REFERENCE_SQL_SHA256;
  return {
    status: attributedPredicateMatches && referenceMatches ? "pass" as const : "blocked" as const,
    attributed_predicate_matches: attributedPredicateMatches,
    reference_sql_matches: referenceMatches,
    baseline_sha: OVERVIEW_REFERENCE_SHA,
  };
}

export function overviewRouteOracleGuard(reference: unknown = READ_PATH_BREAKDOWN_REFERENCE) {
  return {
    status: digest(JSON.stringify(reference)) === READ_PATH_BREAKDOWN_REFERENCE_SHA256 ? "pass" as const : "blocked" as const,
    reference_sha256: READ_PATH_BREAKDOWN_REFERENCE_SHA256,
  };
}

export function overviewCycleRouteOracleGuard(reference: unknown = READ_PATH_CYCLE_BREAKDOWN_REFERENCE) {
  return {
    status: digest(JSON.stringify(reference)) === READ_PATH_CYCLE_BREAKDOWN_REFERENCE_SHA256 ? "pass" as const : "blocked" as const,
    reference_sha256: READ_PATH_CYCLE_BREAKDOWN_REFERENCE_SHA256,
  };
}

export function sameRows(a: unknown[], b: unknown[]): boolean {
  // ORDER BY ties were unspecified in the original SQL. Compare all rows, retaining duplicates.
  const canonical = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
