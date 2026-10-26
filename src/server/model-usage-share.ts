import { contextPreviewResponse, contextRequested, type JsonResponse } from "./codex-context-preview";
import type { AppContext } from "./app-context-types";
import { modelWindowScope } from "./model-capacity";
import { readLimitWindowStarts } from "../db/limit-windows";
import { ProbeAccountIndexUnavailable } from "./current/probe-account-unavailable";
import { readModelUsageShareWindows } from "./window-usage-read";
import { type WindowModelTraffic, type WindowSlice } from "./window-usage-contracts";
import { modelUsageShare, type ModelUsageShareResponse, type ModelUsageShareWindow } from "../shared/model-usage-share";

const sliceTokens = (slice: WindowSlice) => Object.values(slice.tokens).reduce((sum, value) => sum + value, 0);

/** Stored window sums and meter readings only: never reads facts, reprices, computes window sums or enqueues work. */
export function handleModelUsageShare(ctx: AppContext, url: URL, now = Date.now()): Response {
  return contextPreviewResponse(ctx.sqlite, json => handleModelUsageShareBody(ctx, url, now, json), contextRequested(url) && (url.searchParams.get("provider") ?? "codex") === "codex", "models");
}
function handleModelUsageShareBody(ctx: AppContext, url: URL, now: number, json: JsonResponse): Response {
  const scope = modelWindowScope(url);
  if (scope instanceof Response) return scope;
  const { provider, account, counter, since, until } = scope;
  const response: ModelUsageShareResponse = { provider, account, counter, since, until, preparing_windows: 0, models: [], windows: [], detail: null };
  try { readLimitWindowStarts(ctx.sqlite, provider, account, counter); }
  catch (error) {
    if (!(error instanceof ProbeAccountIndexUnavailable)) throw error;
    return json({ ...response, preparing_windows: 1 });
  }
  const from = new Date(Date.parse(since)).toISOString(), to = new Date(Date.parse(until) + 86_400_000).toISOString();
  const stored = readModelUsageShareWindows(ctx.sqlite, provider, account, counter, from, to);
  const windows = stored.map(row => {
    const start = Date.parse(row.start_ts), end = Date.parse(row.end_ts);
    // A window keeps one traffic row per model and admission; only counted traffic takes part.
    const traffic = new Map<string | null, { api_usd: number; hours: Map<number, number> }>();
    const modelOf = (model: string | null) => {
      let entry = traffic.get(model);
      if (!entry) traffic.set(model, entry = { api_usd: 0, hours: new Map() });
      return entry;
    };
    for (const model of (row.by_model ? JSON.parse(row.by_model) : []) as WindowModelTraffic[])
      if (model.excluded === null) modelOf(model.model).api_usd += model.api_standard;
    for (const slice of (row.slices ? JSON.parse(row.slices) : []) as WindowSlice[]) {
      const hours = modelOf(slice.model).hours, hour = Date.parse(slice.hour);
      hours.set(hour, (hours.get(hour) ?? 0) + sliceTokens(slice));
    }
    const meter = (JSON.parse(row.meter ?? "[]") as Array<[string, number]>)
      .map(([hour, percent]) => [Date.parse(`${hour}:00:00.000Z`), percent] as const);
    return { row, start, end, traffic, meter };
  });
  const totals = new Map<string | null, number>();
  for (const window of windows) for (const [model, entry] of window.traffic) totals.set(model, (totals.get(model) ?? 0) + entry.api_usd);
  response.models = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || (a ?? "").localeCompare(b ?? ""));
  const chosen = url.searchParams.get("window");
  const target = windows.find(window => window.row.window_id === chosen) ?? windows.at(-1);
  for (const window of windows) {
    const { row, start, end, traffic, meter } = window;
    const preparing = !row.stored || !!row.pending;
    if (preparing) response.preparing_windows++;
    const points = modelUsageShare({ start, end, stop: Math.max(start, Math.min(end, now)), meter,
      models: response.models.map(model => {
        const entry = traffic.get(model);
        if (!row.context_hour_extra) return { api_usd: entry?.api_usd ?? 0, hours: entry ? [...entry.hours] : [] };
        const extra = new Map(row.context_hour_extra.filter(([name])=>name===model).map(([,hour,value])=>[Date.parse(hour),value]));
        const tokens = entry ? [...entry.hours.values()].reduce((sum,value)=>sum+value,0) : 0;
        const totalExtra=[...extra.values()].reduce((sum,value)=>sum+value,0), base=(entry?.api_usd??0)-totalExtra;
        const hours=new Set([...entry?.hours.keys()??[],...extra.keys()]);
        return { api_usd: entry?.api_usd ?? 0, hours: entry ? [...entry.hours] : [],
          hour_api: [...hours].map(hour=>[hour,(tokens>0?base*(entry?.hours.get(hour)??0)/tokens:0)+(extra.get(hour)??0)] as const) };
      }) });
    const last = points.at(-1)!;
    const summary: ModelUsageShareWindow = { window_id: row.window_id, start: row.start_ts, end: row.end_ts,
      plan: row.plan_mismatch ? null : row.plan, current: end > now, preparing,
      meter: meter.length ? Math.max(...meter.map(([, percent]) => percent)) : null,
      pct: last.pct, api_usd: response.models.map(model => traffic.get(model)?.api_usd ?? 0), unattributed_pct: last.unattributed };
    response.windows.push(summary);
    if (window === target) response.detail = { window_id: row.window_id,
      points: points.map(point => ({ ...point, t: new Date(point.t).toISOString() })) };
  }
  return json(response);
}
