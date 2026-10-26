import { contextPreviewResponse, contextRequested, type JsonResponse } from "./codex-context-preview";
import type { AppContext } from "./app-context-types";
import { CODEX_COUNTERS, codexCounterMinutes, isCodexWindowMinutes } from "../shared/codex-counters";
import { MODEL_CAPACITY_MIN_PP, MODEL_CAPACITY_VERSION, modelCapacitySpread,
  type ModelCapacityResponse, type ModelCapacityRow, type ModelCapacitySample, type ModelCapacityWindow } from "../shared/model-capacity";
import { codexLimitCounter } from "./probe-limit-windows";
import { readLimitWindowStarts } from "../db/limit-windows";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-unavailable";
import { capacityPromotionForSpan } from "./codex-promotions";
import { loadPlans } from "./plans";
import { loadPlansCatalog } from "./plans-catalog";
import { CODEX_PROMOTIONS } from "../shared/codex-promotions";
import { readModelCapacityWindows } from "./window-usage-read";

const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day))
  && new Date(Date.parse(day)).toISOString().slice(0, 10) === day;
const modeOf = (sample: ModelCapacitySample): ModelCapacityRow["mode"] => sample.unknown_mode_tokens > 0
  ? sample.unknown_mode_tokens === sample.tokens ? "unknown" : "mixed"
  : sample.fast_tokens > 0 ? sample.fast_tokens === sample.tokens ? "fast" : "mixed" : "standard";

export interface ModelWindowScope { provider: "codex" | "claude"; account: string; counter: string; minutes: number; since: string; until: string }
/** One subscription's account-wide counter over whole UTC days; a Response for an invalid request. */
export function modelWindowScope(url: URL): ModelWindowScope | Response {
  const provider = url.searchParams.get("provider") ?? "codex";
  const account = (url.searchParams.get("account") ?? "").trim().toLowerCase();
  const since = url.searchParams.get("since") ?? "", until = url.searchParams.get("until") ?? "";
  let counter = url.searchParams.get("counter") ?? (provider === "codex" ? "weekly" : '["weekly_all","weekly",10080]');
  const codexMinutes = codexCounterMinutes(counter);
  if (provider === "codex" && codexMinutes !== null) counter = codexLimitCounter(codexMinutes);
  let parts: unknown;
  try { parts = JSON.parse(counter); } catch { return Response.json({ error: "Invalid counter" }, { status: 400 }); }
  const allowed = Array.isArray(parts) && parts.length === 3 && (provider === "codex"
    ? parts[0] === "codex" && parts[1] === "codex" && isCodexWindowMinutes(parts[2])
    : (parts[0] === "weekly_all" && parts[1] === "weekly" && parts[2] === 10080 || parts[0] === "session" && parts[1] === "session" && parts[2] === 300));
  if (!["codex", "claude"].includes(provider) || !account || ["all", "__all__"].includes(account) || account.endsWith("::business")
    || !allowed || !validDay(since) || !validDay(until) || since > until || Date.parse(until) - Date.parse(since) > 36599 * 86_400_000
    || url.searchParams.has("project")) return Response.json({ error: "Expected a Codex/Claude subscription, account-wide counter and up to 36600 UTC days" }, { status: 400 });
  return { provider: provider as "codex" | "claude", account, counter, minutes: (parts as number[])[2]!, since, until };
}

/** Prepared samples only: range reads never inspect facts, compute window sums, or enqueue work. */
export function handleModelCapacity(ctx: AppContext, url: URL): Response {
  return contextPreviewResponse(ctx.sqlite, json => handleModelCapacityBody(ctx, url, json), contextRequested(url) && (url.searchParams.get("provider") ?? "codex") === "codex", "models");
}
function handleModelCapacityBody(ctx: AppContext, url: URL, json: JsonResponse): Response {
  const scope = modelWindowScope(url);
  if (scope instanceof Response) return scope;
  const { provider, account, counter, since, until, minutes } = scope;
  const response: ModelCapacityResponse = { provider, account, counter, since, until,
    minimum_pp: MODEL_CAPACITY_MIN_PP, preparing_windows: 0, rows: [] };
  try { readLimitWindowStarts(ctx.sqlite, provider, account, counter); }
  catch (error) {
    if (!(error instanceof ProbeAccountIndexUnavailable)) throw error;
    return json({ ...response, preparing_windows: 1 });
  }
  const start = Date.parse(since), end = Date.parse(until) + 86_400_000;
  const stored = readModelCapacityWindows(ctx.sqlite, provider, account, counter, new Date(start).toISOString(), new Date(end).toISOString());
  const plans = ctx.plans ?? loadPlans(), catalog = ctx.plansCatalog ?? loadPlansCatalog();
  type Sample = ModelCapacitySample & { window_id: string };
  const groups = new Map<string, { row: ModelCapacityRow; full: Sample[]; small: Sample[]; cohort: string }>();
  for (const window of stored) {
    const prepared: ModelCapacityWindow | null = window.samples === null ? null : JSON.parse(window.samples);
    if (prepared?.version !== MODEL_CAPACITY_VERSION) { response.preparing_windows++; continue; }
    if (window.pending) response.preparing_windows++;
    // Catalog announcements split observational cohorts; they never grant an entitlement or multiplier.
    const announcementsAt = (at: string) => provider === "codex" ? CODEX_PROMOTIONS.filter(p => ["allowance", "window"].includes(p.kind)
      && p.announced <= at.slice(0, 10) && (!p.until || p.until >= at.slice(0, 10))).map(p => p.id) : [];
    const candidates = prepared.uncertain_events ? [] : prepared.samples.filter(sample => Date.parse(sample.from) >= start && Date.parse(sample.through) < end);
    const ensure = (model: string, mode: ModelCapacityRow["mode"], sample?: ModelCapacitySample) => {
      const promotion = capacityPromotionForSpan({ account, plan: window.plan, start: sample?.from ?? window.start_ts,
        end: sample ? new Date(Date.parse(sample.through) + 1).toISOString() : window.end_ts },
      plans, catalog, provider, provider === "codex" && isCodexWindowMinutes(minutes) ? CODEX_COUNTERS[minutes].id : minutes === 300 ? "session" : "weekly");
      const first = announcementsAt(sample?.from ?? window.start_ts), last = announcementsAt(sample?.through ?? window.end_ts);
      const crossing = JSON.stringify(first) !== JSON.stringify(last);
      const terms = crossing ? "mixed" : promotion.status;
      const plan = window.plan_mismatch ? null : window.plan;
      const termsKey = JSON.stringify([terms, promotion.factor, promotion.regime_ids, first, terms === "mixed" ? [window.window_id, sample?.from] : null]);
      const cohort = JSON.stringify([provider, account, counter, model, plan, !plan ? window.window_id : null, window.manual !== null, termsKey]);
      const key = JSON.stringify([cohort, mode]);
      let group = groups.get(key);
      if (!group) {
        const reasons: string[] = [];
        if (!plan) reasons.push("unknown_plan");
        if (terms !== "configured") reasons.push("unknown_terms");
        if (window.manual !== null) reasons.push("manual");
        if (prepared.uncertain_events) reasons.push("uncertain_traffic");
        groups.set(key, group = { row: { key, model, plan, mode, terms, allowance_factor: crossing ? null : promotion.factor, samples: 0, small_samples: 0,
          priced_samples: 0, windows: 0, observed_pp: 0, events: 0, from: null, through: null, tokens: null, api_usd: null, tentative: true, reasons },
          full: [], small: [], cohort });
      }
      return group;
    };
    for (const sample of candidates) {
      const group = ensure(sample.model, modeOf(sample), sample);
      if (group.row.terms === "mixed" || group.row.terms === "invalid") {
        if (!group.row.reasons.includes("changing_terms")) group.row.reasons.push("changing_terms");
        continue;
      }
      (sample.observed_pp >= MODEL_CAPACITY_MIN_PP ? group.full : group.small).push({ ...sample, window_id: window.window_id });
      const row = group.row;
      row.observed_pp += sample.observed_pp; row.events += sample.events;
      if (row.from === null || sample.from < row.from) row.from = sample.from;
      if (row.through === null || sample.through > row.through) row.through = sample.through;
      for (const [condition, reason] of [[sample.max_gap_minutes > 30, "meter_gap"], [sample.unpriced_events > 0, "partial_prices"],
        [sample.unknown_mode_tokens > 0, "unknown_mode"], [sample.reaches_100, "first_100"]] as const)
        if (condition && !row.reasons.includes(reason)) row.reasons.push(reason);
    }
    // Mixed-only models still have an explicit unavailable row, without a fictitious capacity.
    if (Date.parse(window.start_ts) >= start && Date.parse(window.end_ts) <= end)
      for (const model of prepared.models) if (!candidates.some(sample => sample.model === model)) ensure(model, "unknown");
  }
  for (const group of groups.values()) {
    const row = group.row, samples = group.full.length ? group.full : group.small;
    row.samples = group.full.length; row.small_samples = group.small.length;
    row.windows = new Set(samples.map(sample => sample.window_id)).size;
    row.observed_pp = samples.reduce((sum, sample) => sum + sample.observed_pp, 0);
    row.events = samples.reduce((sum, sample) => sum + sample.events, 0);
    row.from = samples.length ? samples.reduce((first, sample) => Date.parse(sample.from) < Date.parse(first) ? sample.from : first, samples[0]!.from) : null;
    row.through = samples.length ? samples.reduce((last, sample) => Date.parse(sample.through) > Date.parse(last) ? sample.through : last, samples[0]!.through) : null;
    row.tokens = modelCapacitySpread(samples.map(sample => sample.tokens * 100 / sample.observed_pp));
    const priced = samples.filter(sample => sample.unpriced_events === 0);
    row.priced_samples = priced.length;
    row.api_usd = modelCapacitySpread(priced.map(sample => sample.api_usd * 100 / sample.observed_pp));
    if (samples.length === 0) row.reasons.push("no_single_model_sample");
    if (group.full.length < 3 || row.windows < 2) row.reasons.push("small_sample");
    // Local traffic is always conditional on source coverage; it is never a vendor entitlement.
    if (provider === "claude") row.reasons.push("local_traffic");
    row.tentative = row.reasons.some(reason => reason !== "first_100");
    response.rows.push(row);
  }
  const available = new Set([...groups.values()].filter(group => group.row.tokens !== null).map(group => group.cohort));
  response.rows = response.rows.filter(row => row.tokens !== null || row.reasons.includes("uncertain_traffic")
    || row.reasons.includes("changing_terms") || !available.has(groups.get(row.key)!.cohort));
  response.rows.sort((a, b) => a.model.localeCompare(b.model) || (b.from ?? "").localeCompare(a.from ?? "") || a.key.localeCompare(b.key));
  return json(response);
}
