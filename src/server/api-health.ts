import { ledgerSumsCurrent } from "./ledger-sums";
import type { AppContext } from "./app-context-types";
import { readMissingRates } from "./missing-rates";
import type { CardHistory } from "./probe-health";
import { readCardHistories, probeNotices } from "./probe-health";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-reader";
import { buildIdentityReport } from "./account-identity";
import { codexTableHomes } from "./codex-source-account";
import { apiCodexLedgerIsPending, apiCodexLedgerRows } from "./api-codex-ledger";
import { preparingDataResponse } from "./preparing-response";
import { queryRows } from "./data-groups";
import { readSparkClassifier } from "./plan-health-read";
import { rational, add as addExact } from "../db/price-ledger-exact";
import { ledgerPresentationNumber } from "../db/codex-ledger-adapters";
import { normPath, accountResolverOf } from "./account-scope";
import { round2 } from "./api-report-values";

export interface HealthUnpricedItem {
  model: string;
  observed_provider: string;
  rate_vendor: string | null;
  tokens: number;
  /** `missing_rate` (priceable in Settings) or `no_rate_card` (the vendor has no rate card). */
  reason: string;
  /** The first UTC day of such a call. */
  first_day?: string;
}

interface LedgerHealthState {
  current: boolean;
  stale: boolean;
  status: string;
  source_data_revision: number | null;
  data_revision: number | null;
}

/** Whether every ledger the sums come from has caught up with its facts (the field kept its old name, `rollups`). */
export function ledgerHealthState(ctx: AppContext): LedgerHealthState {
  let data: number | null = null;
  try {
    data = (ctx.sqlite.query("SELECT data_revision FROM sync_revisions WHERE id = 1").get() as { data_revision: number } | null)?.data_revision ?? null;
  } catch {
    data = null;
  }
  const current = ledgerSumsCurrent(ctx.sqlite);
  return { current, stale: !current, status: current ? "current" : "pending", source_data_revision: null, data_revision: data };
}

/**
 * The unpriced models of the Settings rate table and the data-sources check: the same stored missing-rate
 * valuations as `/api/missing-rates` (one source, so the alert, the table and the check cannot disagree).
 * `tokens` and `models` count the models that can be priced in Settings; `items` also lists vendors without a card.
 */
export function collectHealthUnpriced(ctx: AppContext): {
  tokens: number;
  items: HealthUnpricedItem[];
  models: Record<string, { tokens: number; reason: string; observed_provider: string; rate_vendor: string | null }>;
} {
  const summary = readMissingRates(ctx.sqlite, ctx.rateCards);
  const items: HealthUnpricedItem[] = [
    ...summary.models.map(row => ({ ...row, reason: "missing_rate" })),
    ...(summary.unpriceable ?? []).map(row => ({ ...row, reason: "no_rate_card" })),
  ];
  const models = Object.fromEntries(summary.models.map(row => [row.model,
    { tokens: row.tokens, reason: "missing_rate", observed_provider: row.observed_provider, rate_vendor: row.rate_vendor }]));
  return { tokens: summary.tokens, items, models };
}

/**
 * `/api/probe-notices`: accounts whose limit readings stopped for a reason the user fixes (an expired sign-in, a
 * profile signed in to another account), per computer. One read of the published cards; none while they prepare.
 */
export function handleProbeNotices(ctx: AppContext): Response {
  let cards: Map<string, CardHistory>;
  try { cards = readCardHistories(ctx.sqlite); }
  catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) return Response.json({ notices: [], preparing: true });
    throw error;
  }
  const name = (provider: string, subject: string) => {
    const id = subject.toLowerCase();
    const discovered = [...(ctx.vendorDiscovery?.accounts ?? []), ...(ctx.codexDiscovery?.accounts ?? [])].find(a => a.id.toLowerCase() === id);
    const declared = (ctx.accounts.subscriptions ?? []).find(s => s.id.toLowerCase() === id);
    return declared?.label ?? (discovered && "email" in discovered ? discovered.email : null) ?? declared?.account ?? null;
  };
  return Response.json({ notices: probeNotices(cards, name) });
}

/** `/api/missing-rates`: models the ledgers left unpriced for a missing rate (the status bar's and cards' alert). */
export function handleMissingRates(ctx: AppContext): Response {
  return Response.json(readMissingRates(ctx.sqlite, ctx.rateCards));
}

export function handleHealth(ctx: AppContext): Response {
  function getCount(tableName: string): number {
    try {
      const row = ctx.sqlite.query(`SELECT count(*) as count FROM "${tableName}"`).get() as { count: number } | null;
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }
  const events = getCount("events");
  const ratelimit = getCount("ratelimit");
  const claudeEvents = getCount("claude_events");
  const claudeFiles = getCount("claude_files");
  const ocEvents = getCount("oc_events");
  const files = getCount("files");
  const meta = getCount("meta");
  const unpriced = collectHealthUnpriced(ctx);
  const rollups = ledgerHealthState(ctx);
  return Response.json({
    status: ctx.homeConflict || ctx.eraErrors.length > 0 ? "degraded" : "ok",
    home_conflict: ctx.homeConflict?.message ?? null,
    era_conflicts: ctx.eraErrors,
    events,
    ratelimit,
    claude_events: claudeEvents,
    tables: {
      events,
      ratelimit,
      claude_events: claudeEvents,
      claude_files: claudeFiles,
      oc_events: ocEvents,
      files,
      meta,
    },
    unpriced,
    rollups,
    identity: buildIdentityReport(ctx),
  });
}

export function handlePlanHealth(ctx: AppContext, url: URL): Response {
  const account = url.searchParams.get("account") || "codex1";
  const declared = (ctx.subIdToHomes.get(account.toLowerCase()) || []).map(normPath);
  if (declared.length === 0) {
    return Response.json({ error: `unknown account: ${account}` }, { status: 400 });
  }
  const homes = codexTableHomes(ctx.sqlite, "ratelimit").filter((h) => declared.includes(normPath(h)));
  if (homes.length === 0) {
    return Response.json({
      account,
      generated_from: "live query",
      note: `account '${account}' is declared in accounts.json but has no rows in the index yet`,
      axes: {},
    });
  }
  if (true && apiCodexLedgerIsPending(ctx)) return preparingDataResponse();
  const ph = homes.map(() => "?").join(",");
  const CUTOFF = "2026-07-13";
  const a1 = (queryRows<Record<string,unknown>>(ctx.sqlite, `SELECT count(*) AS c, min(ts) AS first_ts FROM ratelimit
     WHERE home IN (${ph}) AND window_minutes = 300 AND limit_id = 'codex' AND ts >= ?`, [...homes, CUTOFF])[0]??{c:0,first_ts:null,m:null}) as { c: number; first_ts: string | null };
  const a1bf = (queryRows<Record<string,unknown>>(ctx.sqlite, `SELECT count(*) AS c FROM ratelimit
     WHERE home IN (${ph}) AND window_minutes = 300 AND limit_id = 'codex_bengalfox' AND ts >= ?`, [...homes, CUTOFF])[0]??{c:0,first_ts:null,m:null}) as { c: number };
  type Row = { resets_at: number; ts: string; used_percent: number; path: string };
  const rl = queryRows<Record<string,unknown>>(ctx.sqlite, `SELECT resets_at, ts, used_percent, path FROM ratelimit
     WHERE home IN (${ph}) AND window_minutes = 10080 AND limit_id = 'codex'
     ORDER BY resets_at, ts`, [...homes]) as Row[];
  type Cluster = { anchor: number; ts: string[]; pct: number[]; paths: Set<string> };
  const clusters: Cluster[] = [];
  for (const r of rl) {
    const last = clusters[clusters.length - 1];
    let c: Cluster;
    if (last && Math.abs(r.resets_at - last.anchor) <= 120) {
      c = last;
    } else {
      c = { anchor: r.resets_at, ts: [], pct: [], paths: new Set<string>() };
      clusters.push(c);
    }
    c.ts.push(r.ts);
    c.pct.push(r.used_percent);
    c.paths.add(r.path);
  }
  const qualified = clusters.filter((c) => c.ts.length >= 5);
  const isSparkCluster = readSparkClassifier(ctx.sqlite, qualified.map((c) => c.paths));
  const acct = qualified.filter((c) => !isSparkCluster(c.paths));
  const cycles: Array<{ start: string; span_pct: number; value_usd: number }> = [];
  for (const c of acct) {
    const lo = c.ts.reduce((a, b) => (a < b ? a : b));
    const hi = c.ts.reduce((a, b) => (a > b ? a : b));
    const span = Math.max(...c.pct) - Math.min(...c.pct);
    if (span < 60) continue;
    let amount = rational(0n), complete = true;
    for (const row of apiCodexLedgerRows(ctx, { fromMs: Date.parse(lo), toMs: Date.parse(hi), endInclusive: true }, undefined, accountResolverOf(ctx))) {
      if (!row.home || !homes.includes(row.home) || row.model?.includes("spark")) continue;
      if (row.group.variants.api_standard.value === null) { complete = false; break; }
      amount = addExact(amount, row.usd);
    }
    const usd = ledgerPresentationNumber(amount);
    if (complete && usd > 0) {
      cycles.push({ start: lo.slice(0, 10), span_pct: round2(span), value_usd: round2((usd / span) * 100) });
    }
  }
  cycles.sort((a, b) => (a.start < b.start ? -1 : 1));
  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const recent = cycles.slice(-5).map((c) => c.value_usd);
  const prior = cycles.slice(-10, -5).map((c) => c.value_usd);
  const medRecent = median(recent);
  const medPrior = median(prior);
  const trendPct = medPrior > 0 ? round2(((medRecent - medPrior) / medPrior) * 100) : null;
  const band = medPrior > 0 ? medPrior * 0.85 : 0;
  let consecutiveLow = 0;
  for (let i = cycles.length - 1; i >= 0 && band > 0; i--) {
    const c = cycles[i];
    if (!c || c.value_usd >= band) break;
    consecutiveLow++;
  }
  const axis2Status = consecutiveLow >= 2 ? "alert" : "ok";
  const cyclesByMonth = new Map<string, number>();
  for (const c of acct) {
    const m = c.ts.reduce((a, b) => (a < b ? a : b)).slice(0, 7);
    cyclesByMonth.set(m, (cyclesByMonth.get(m) ?? 0) + 1);
  }
  const maxTs = ((queryRows<Record<string,unknown>>(ctx.sqlite, `SELECT max(ts) AS m FROM ratelimit WHERE home IN (${ph})`, [...homes])[0]??{c:0,first_ts:null,m:null}) as { m: string | null }).m || "";
  const curMonth = maxTs.slice(0, 7);
  const daysObserved = maxTs ? Number(maxTs.slice(8, 10)) : 0;
  const daysIn = (month: string): number =>
    new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const axis3Months = [...cyclesByMonth.entries()].sort().map(([month, n]) => {
    const partial = month === curMonth;
    const dim = daysIn(month);
    return {
      month,
      cycles: n,
      is_partial: partial,
      days_observed: partial ? daysObserved : dim,
      days_in_month: dim,
      normalized_rate: partial && daysObserved > 0 ? round2(n * (dim / daysObserved)) : n,
    };
  });
  const axis4Rows = queryRows<Record<string,unknown>>(ctx.sqlite, `SELECT substr(ts,1,7) AS month, count(*) AS n,
            sum(CASE WHEN used_percent >= 99 THEN 1 ELSE 0 END) AS at99,
            sum(CASE WHEN used_percent >= 90 THEN 1 ELSE 0 END) AS at90
     FROM ratelimit WHERE home IN (${ph}) AND window_minutes = 10080 AND limit_id = 'codex'
     GROUP BY 1 ORDER BY 1`, [...homes]).filter(r=>Number(r.n)>=20) as Array<{ month: string; n: number; at99: number; at90: number }>;
  const intensity = new Map<string, number>();
  for (const r of queryRows<Record<string,unknown>>(ctx.sqlite, `SELECT substr(ts,1,7) AS month, count(*) AS c FROM events WHERE home IN (${ph}) GROUP BY 1`, [...homes]) as Array<{ month: string; c: number }>) {
    intensity.set(r.month, r.c);
  }
  const axis4 = axis4Rows.map((r) => {
    const partial = r.month === curMonth;
    const days = partial ? daysObserved : daysIn(r.month);
    return {
      month: r.month,
      is_partial: partial,
      pct_at_99: round2((r.at99 / r.n) * 100),
      pct_at_90: round2((r.at90 / r.n) * 100),
      samples: r.n,
      calls_per_day: days > 0 ? Math.round((intensity.get(r.month) ?? 0) / days) : null,
    };
  });
  const last4 = axis4[axis4.length - 1];
  const prev4 = axis4[axis4.length - 2];
  const axis4Status = last4 && prev4 && last4.pct_at_90 > prev4.pct_at_90 * 1.5 ? "watch" : "ok";
  return Response.json({
    account,
    generated_from: "live query",
    axes: {
      axis1: {
        id: "limit_5h_return",
        title: "Return of the account 5-hour limit",
        status: a1.c > 0 ? "alert" : "ok",
        current_value: a1.c,
        unit: "samples",
        first_occurrence_ts: a1.first_ts,
        spark_5h_samples_excluded: a1bf.c,
        count_if_spark_included: a1.c + a1bf.c,
        comparison_basis: `samples with window_minutes=300 and limit_id='codex' on or after ${CUTOFF}`,
        summary: a1.c > 0
          ? `The account 5-hour limit has returned; first seen ${a1.first_ts}.`
          : `Not returned. ${a1bf.c} Spark 5h sample(s) exist under limit_id='codex_bengalfox' and are excluded deliberately.`,
      },
      axis2: {
        id: "window_value",
        title: "Value of one full window",
        status: axis2Status,
        current_value: cycles.at(-1)?.value_usd ?? null,
        unit: "USD per full 0-100% window",
        median_recent: medRecent || null,
        median_prior: medPrior || null,
        trend_pct: trendPct,
        alert_band_low: band ? round2(band) : null,
        consecutive_low_cycles: consecutiveLow,
        cycles,
        comparison_basis: "median of the last 5 cycles against the 5 before them; an alert needs 2+ consecutive cycles below -15%",
        summary: trendPct === null
          ? "Not enough completed cycles to establish a trend yet."
          : `Median full-window value ${medRecent.toFixed(0)} USD, ${trendPct >= 0 ? "up" : "down"} ${Math.abs(trendPct).toFixed(1)}% on the prior five cycles.`,
      },
      axis3: {
        id: "cycles_per_month",
        title: "Cycles per month (banked resets)",
        status: "ok",
        current_value: cyclesByMonth.get(curMonth) ?? 0,
        unit: "cycles",
        months: axis3Months,
        is_context_only: true,
        context_note: "This axis mixes workload with plan generosity - fewer cycles can simply mean less work was done. Context only; it never raises an alert on its own.",
        summary: `${cyclesByMonth.get(curMonth) ?? 0} cycles so far in ${curMonth} (${daysObserved} days observed).`,
      },
      axis4: {
        id: "ceiling_pressure",
        title: "Ceiling pressure (share of working samples near the cap)",
        status: axis4Status,
        current_value: last4 ? last4.pct_at_90 : null,
        unit: "% of samples at 90% used or above",
        months: axis4,
        comparison_basis: "share of rate-limit samples taken while working, with intensity beside it",
        method_note: "Weighted by samples, not by elapsed time. A time-weighted version tracks the chosen idle-gap cutoff rather than the data, because you stop working when you are blocked.",
        summary: last4
          ? `${last4.pct_at_90.toFixed(1)}% of working samples in ${last4.month} sat at or above 90% used, at ${last4.calls_per_day ?? "?"} calls/day.`
          : "No data.",
      },
    },
  });
}
