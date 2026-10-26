import { codexTableHomes } from "./codex-source-account";
import { WhereClause, queryRows } from "./data-groups";
import { codexReadingEvidenceSql } from "../db/codex-ledger-canonical";
import { readCodexLedgerFileModels } from "../db/codex-price-ledger";
import type { AppContext } from "./app-context-types";
import { parseCommonDateParams } from "./api-request-params";
import { normPath } from "./account-scope";

export function handleGauge(ctx: AppContext, url: URL): Response {
  const dateParams = parseCommonDateParams(url);
  if (dateParams.error) {
    return Response.json({ error: dateParams.error }, { status: 400 });
  }
  const { since, until } = dateParams;
  const accountParam = url.searchParams.get("account") || "codex1";
  const windowParam = url.searchParams.get("window");
  let windowMinutes: number | undefined;
  if (windowParam) {
    windowMinutes = parseInt(windowParam, 10);
    if (isNaN(windowMinutes) || windowMinutes <= 0) {
      return Response.json({ error: `Invalid 'window' parameter: '${windowParam}'` }, { status: 400 });
    }
  }
  const targetSubId = accountParam.toLowerCase();
  const matchedHomes = ctx.subIdToHomes.get(targetSubId) || [];
  const wanted = matchedHomes.length > 0 ? matchedHomes.map(normPath) : [normPath(accountParam)];
  // The stored spellings of those homes (a handful, one index seek each), so the samples are read by the home index
  // instead of normalizing every row's home.
  const homes = codexTableHomes(ctx.sqlite, "ratelimit").filter(home => (ctx.sqlite.query(
    `SELECT REPLACE(LOWER(?), char(92), '/') IN (${wanted.map(() => "?").join(", ")}) AS hit`).get(home, ...wanted) as { hit: number }).hit === 1);
  const window = new WhereClause();
  window.add(homes.length ? `home IN (${homes.map(() => "?").join(", ")})` : "0", homes);
  if (windowMinutes !== undefined) window.add("window_minutes = ?", [windowMinutes]);
  if (since) window.add("substr(ts, 1, 10) >= ?", [since]);
  if (until) window.add("substr(ts, 1, 10) <= ?", [until]);
  window.add(codexReadingEvidenceSql(ctx.sqlite, "ratelimit"), []);
  const whereClause = window.clause();
  interface SampleRow {
    path: string;
    ts: string;
    window_minutes: number;
    used_percent: number;
    resets_at: number | null;
    plan_type: string | null;
    limit_id: string | null;
    limit_name: string | null;
  }
  let samples: SampleRow[] = [];
  try {
    // Equal instants keep the order of the time index the whole-table read used.
    samples = queryRows(ctx.sqlite, `SELECT path, ts, window_minutes, used_percent, resets_at, plan_type, limit_id, limit_name
         FROM ratelimit
         ${whereClause}
         ORDER BY ts ASC, rowid ASC`, window.params) as SampleRow[];
  } catch {
    samples = [];
  }
  interface GaugeCluster {
    anchor: number;
    resets_at_iso: string;
    sample_count: number;
    min_percent: number;
    max_percent: number;
    first_percent: number;
    last_percent: number;
    start_ts: string;
    end_ts: string;
    paths: Set<string>;
    limit_ids: Set<string>;
    limit_names: Set<string>;
    plan_types: Set<string>;
    models: string[];
  }
  const clusters: GaugeCluster[] = [];
  for (const sample of samples) {
    if (sample.resets_at == null || isNaN(sample.resets_at)) continue;
    const r = Math.floor(sample.resets_at);
    let match = clusters.find((c) => Math.abs(c.anchor - r) <= 120);
    if (match) {
      match.sample_count++;
      match.min_percent = Math.min(match.min_percent, sample.used_percent);
      match.max_percent = Math.max(match.max_percent, sample.used_percent);
      match.last_percent = sample.used_percent;
      match.end_ts = sample.ts;
      match.paths.add(sample.path);
      if (sample.limit_id) match.limit_ids.add(sample.limit_id);
      if (sample.limit_name) match.limit_names.add(sample.limit_name);
      if (sample.plan_type) match.plan_types.add(sample.plan_type);
    } else {
      const newCluster: GaugeCluster = {
        anchor: r,
        resets_at_iso: new Date(r * 1000).toISOString(),
        sample_count: 1,
        min_percent: sample.used_percent,
        max_percent: sample.used_percent,
        first_percent: sample.used_percent,
        last_percent: sample.used_percent,
        start_ts: sample.ts,
        end_ts: sample.ts,
        paths: new Set([sample.path]),
        limit_ids: new Set(sample.limit_id ? [sample.limit_id] : []),
        limit_names: new Set(sample.limit_name ? [sample.limit_name] : []),
        plan_types: new Set(sample.plan_type ? [sample.plan_type] : []),
        models: [],
      };
      clusters.push(newCluster);
    }
  }
  // The models of each sampled file, from the Codex ledger's stored file rows (which models each file's calls used),
  // instead of every event's distinct path and model (1.6 s).
  let pathToModels = new Map<string, Set<string>>();
  try { pathToModels = readCodexLedgerFileModels(ctx.sqlite, homes); } catch { /* No ledger yet: no models. */ }
  for (const c of clusters) {
    const modelsSet = new Set<string>();
    for (const p of c.paths) {
      const mSet = pathToModels.get(p);
      if (mSet) {
        for (const m of mSet) modelsSet.add(m);
      }
    }
    c.models = Array.from(modelsSet).sort();
  }
  return Response.json({
    account: accountParam,
    window_minutes: windowMinutes ?? null,
    cluster_count: clusters.length,
    clusters: clusters.map((c) => ({
      anchor: c.anchor,
      resets_at_iso: c.resets_at_iso,
      sample_count: c.sample_count,
      percent_range: {
        min: c.min_percent,
        max: c.max_percent,
        start: c.first_percent,
        end: c.last_percent,
      },
      time_span: {
        start: c.start_ts,
        end: c.end_ts,
        duration_seconds: Math.max(
          0,
          Math.round((new Date(c.end_ts).getTime() - new Date(c.start_ts).getTime()) / 1000)
        ),
      },
      models: c.models,
      limit_ids: Array.from(c.limit_ids),
      limit_names: Array.from(c.limit_names),
      plan_types: Array.from(c.plan_types),
    })),
    unpriced: {
      tokens: 0,
      models: {},
    },
  });
}
