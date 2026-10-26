// Frozen starting handler; keep independent of the candidate classifier.
import type { AppContext } from "../../src/server/api";
import { getCodexRate } from "../../src/server/pricing";
function normPath(p: string): string { return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
export function referencePlanHealth(ctx: AppContext, url: URL): Response {
  const account = url.searchParams.get("account") || "codex1";
  const declared = (ctx.subIdToHomes.get(account.toLowerCase()) || []).map(normPath);
  if (declared.length === 0) {
    return Response.json({ error: `unknown account: ${account}` }, { status: 400 });
  }
  const homes = (ctx.sqlite.query(`SELECT DISTINCT home AS h FROM ratelimit`).all() as Array<{ h: string }>)
    .map((r) => r.h)
    .filter((h) => declared.includes(normPath(h)));
  if (homes.length === 0) {
    return Response.json({
      account,
      generated_from: "live query",
      note: `account '${account}' is declared in accounts.json but has no rows in the index yet`,
      axes: {},
    });
  }
  const ph = homes.map(() => "?").join(",");
  const CUTOFF = "2026-07-13";
  const a1 = ctx.sqlite.query(
    `SELECT count(*) AS c, min(ts) AS first_ts FROM ratelimit
     WHERE home IN (${ph}) AND window_minutes = 300 AND limit_id = 'codex' AND ts >= ?`
  ).get(...homes, CUTOFF) as { c: number; first_ts: string | null };
  const a1bf = ctx.sqlite.query(
    `SELECT count(*) AS c FROM ratelimit
     WHERE home IN (${ph}) AND window_minutes = 300 AND limit_id = 'codex_bengalfox' AND ts >= ?`
  ).get(...homes, CUTOFF) as { c: number };
  type Row = { resets_at: number; ts: string; used_percent: number; path: string };
  const rl = ctx.sqlite.query(
    `SELECT resets_at, ts, used_percent, path FROM ratelimit
     WHERE home IN (${ph}) AND window_minutes = 10080 AND limit_id = 'codex'
     ORDER BY resets_at, ts`
  ).all(...homes) as Row[];
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
  const isSparkCluster = (c: Cluster): boolean => {
    const p = [...c.paths];
    if (p.length === 0) return false;
    const q = p.map(() => "?").join(",");
    const row = ctx.sqlite.query(
      `SELECT count(*) AS tot, sum(CASE WHEN model LIKE '%spark%' THEN 1 ELSE 0 END) AS sp
       FROM events WHERE path IN (${q})`
    ).get(...p) as { tot: number; sp: number | null };
    return row.tot > 0 && (row.sp ?? 0) / row.tot > 0.5;
  };
  const acct = clusters.filter((c) => c.ts.length >= 5 && !isSparkCluster(c));
  const cycles: Array<{ start: string; span_pct: number; value_usd: number }> = [];
  for (const c of acct) {
    const lo = c.ts.reduce((a, b) => (a < b ? a : b));
    const hi = c.ts.reduce((a, b) => (a > b ? a : b));
    const span = Math.max(...c.pct) - Math.min(...c.pct);
    if (span < 60) continue;
    const rows = ctx.sqlite.query(
      `SELECT model, sum(in_tok) AS i, sum(cached_in) AS ca, sum(out_tok) AS o
       FROM events WHERE home IN (${ph}) AND ts >= ? AND ts <= ?
         AND (model IS NULL OR model NOT LIKE '%spark%')
       GROUP BY model`
    ).all(...homes, lo, hi) as Array<{ model: string | null; i: number; ca: number; o: number }>;
    let usd = 0;
    for (const r of rows) {
      const rate = getCodexRate(ctx.rateCards, r.model);
      if (!rate) continue;
      usd += ((r.i - r.ca) / 1e6) * rate.in_uncached
        + (r.ca / 1e6) * rate.in_cache_read
        + (r.o / 1e6) * rate.out_total;
    }
    if (usd > 0) {
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
  const maxTs = (ctx.sqlite.query(
    `SELECT max(ts) AS m FROM ratelimit WHERE home IN (${ph})`
  ).get(...homes) as { m: string | null }).m || "";
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
  const axis4Rows = ctx.sqlite.query(
    `SELECT substr(ts,1,7) AS month, count(*) AS n,
            sum(CASE WHEN used_percent >= 99 THEN 1 ELSE 0 END) AS at99,
            sum(CASE WHEN used_percent >= 90 THEN 1 ELSE 0 END) AS at90
     FROM ratelimit WHERE home IN (${ph}) AND window_minutes = 10080 AND limit_id = 'codex'
     GROUP BY 1 HAVING count(*) >= 20 ORDER BY 1`
  ).all(...homes) as Array<{ month: string; n: number; at99: number; at90: number }>;
  const intensity = new Map<string, number>();
  for (const r of ctx.sqlite.query(
    `SELECT substr(ts,1,7) AS month, count(*) AS c FROM events WHERE home IN (${ph}) GROUP BY 1`
  ).all(...homes) as Array<{ month: string; c: number }>) {
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
