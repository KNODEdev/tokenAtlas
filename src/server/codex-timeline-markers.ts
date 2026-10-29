import { readModelTimeline } from "../db/model-timeline";
import type { TimelineMarker, TimelineMarkerStore, TimelineMarkersResponse } from "../shared/codex-accounting";
export type { TimelineMarker, TimelineMarkerStore, TimelineMarkersResponse } from "../shared/codex-accounting";
import fs from "node:fs";
import path from "node:path";
import { atomicArchiveWrite } from "../sync/archive-publication";
import type { Database } from "bun:sqlite";
import { CONFIG_ROOT } from "../config/paths";
import { isAccountingDay } from "./codex-accounting-pricing";
import { CODEX_PRICE_CHANGES } from "../shared/codex-price-changes";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import type { RateCard } from "./pricing";
import type { CodexAccountingRule, TimelinePriceTransition } from "../shared/codex-accounting";
import { subscriptionAccountingAdapter } from "./subscription-accounting-adapters";

const filename = "codex-timeline-markers.json";
export function configuredPriceMarkers(card?: RateCard): TimelineMarker[] {
  const result = CODEX_PRICE_CHANGES.map(change => ({ ...change.marker }));
  if (!card) return result;
  const rules = resolveCodexAccountingConfig(card).rules;
  const tracks = new Map<string, CodexAccountingRule[]>();
  for (const rule of rules) {
    const key = JSON.stringify([rule.model, rule.billing_basis, rule.speed]);
    const track = tracks.get(key) ?? []; track.push(rule); tracks.set(key, track);
  }
  const values = (rule: CodexAccountingRule | null) => rule ? JSON.stringify([
    rule.rates.in_uncached, rule.rates.in_cache_read, rule.rates.out_total, rule.multiplier,
    rule.long_context?.above_input_tokens, rule.long_context?.rates.in_uncached,
    rule.long_context?.rates.in_cache_read, rule.long_context?.rates.out_total,
  ]) : null;
  for (const track of tracks.values()) {
    const dates = new Set(track.flatMap(rule => [rule.valid_from, ...(rule.valid_until ? [rule.valid_until] : [])]));
    for (const day of dates) {
      const before = track.find(rule => rule.valid_from < day && (!rule.valid_until || rule.valid_until >= day)) ?? null;
      const after = track.find(rule => rule.valid_from <= day && (!rule.valid_until || rule.valid_until > day)) ?? null;
      if (values(before) === values(after) || (!before && after?.confidence !== "user")) continue;
      const model = track[0]!.model;
      const known = CODEX_PRICE_CHANGES.find(change => change.marker.day === day && change.models.some(m => m.name.toLowerCase().replace(/ /g, "-") === model));
      const id = known?.marker.id ?? `price:configured:${model}:${day}`;
      let marker = result.find(m => m.id === id);
      if (!marker) {
        marker = { id, day, label: `${model.slice(0, 92)} · configured price change`, color: "warn", visible: true,
          note: "Zmiana wynikająca z obowiązujących okresów cennika aplikacji. Wpływ na abonament wymaga osobnej deklaracji; nie wynika automatycznie ze zmiany ceny API." };
        result.push(marker);
      }
      const transition: TimelinePriceTransition = { model, basis: track[0]!.billing_basis, speed: track[0]!.speed, before, after };
      (marker.pricing ??= []).push(transition);
    }
  }
  return result;
}
function readStore(root: string, filename: string): TimelineMarkerStore {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, filename), "utf8"));
    if (typeof value.revision !== "string" || !Array.isArray(value.markers) || !value.markers.every(validMarker)) throw new Error("Nieprawidłowy plik punktów osi czasu");
    return value;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { revision: "empty", markers: [] }; throw e; }
}
function validMarker(m: unknown): m is TimelineMarker {
  if (!m || typeof m !== "object") return false;
  const r = m as TimelineMarker;
  return typeof r.id === "string" && /^(model:|price:|custom:)[a-zA-Z0-9_.:/-]{1,180}$/.test(r.id) && isAccountingDay(r.day)
    && typeof r.label === "string" && r.label.trim().length > 0 && r.label.length <= 120
    && typeof r.note === "string" && r.note.length <= 1000 && ["accent", "violet", "warn", "ok"].includes(r.color) && typeof r.visible === "boolean";
}
export async function handleCodexTimelineMarkers(sqlite: Database, req: Request, root = CONFIG_ROOT, card?: RateCard, provider = "codex"): Promise<Response> {
  let pending = false;
  const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store",
    "X-Data-Freshness": pending || status === 202 ? "pending;model-timeline" : "current",
    ...(status === 202 ? { "X-Analysis": "preparing", "X-Analysis-Poll-Ms": "100" } : {}) } });
  if (req.method !== "GET" && req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  let payload: { revision?: string; marker?: TimelineMarker; remove?: string } | undefined;
  if (req.method === "POST") {
    try { payload = await req.json(); } catch { return response({ error: "Oczekiwano JSON" }, 400); }
    if (!payload || typeof payload.revision !== "string" || (payload.remove ? typeof payload.remove !== "string" || !payload.remove.startsWith("custom:") : !validMarker(payload.marker))) return response({ error: "Nieprawidłowy punkt osi czasu" }, 400);
  }
  try {
    const adapter = provider === "codex" ? null : subscriptionAccountingAdapter(provider);
    const markerFile = adapter ? `${adapter.id}-timeline-markers.json` : filename;
    const timeline = readModelTimeline(sqlite, adapter?.id ?? "codex");
    pending = timeline.pending;
    if (!timeline.ready) return response({ status: "preparing" }, 202);
    let store = readStore(root, markerFile);
    if (payload) {
      if (payload.revision !== store.revision) return response({ error: "Punkty zmieniły się od ostatniego odczytu. Odśwież listę przed zapisem." }, 409);
      const id = payload.remove ?? payload.marker!.id;
      const markers = store.markers.filter(m => m.id !== id);
      if (!payload.remove) {
        const { pricing: _derived, ...editable } = payload.marker!;
        markers.push(editable);
      }
      if (markers.length > 500) return response({ error: "Maksymalnie 500 własnych ustawień punktów" }, 400);
      store = { revision: crypto.randomUUID(), markers };
      atomicArchiveWrite(path.join(root, markerFile), JSON.stringify(store, null, 2) + "\n");
    }
    const models = timeline.models;
    const automatic: TimelineMarker[] = models.filter(m => isAccountingDay(m.first_ts.slice(0, 10))).map(m => ({
      id: `model:${m.model}`, observed_at: m.first_ts, day: m.first_ts.slice(0, 10), label: m.model.replace(/^gpt-/, ""),
      note: `Pierwsza obserwacja w całym zaindeksowanym archiwum ${adapter?.label ?? "Codex"}: ${m.first_ts}. Nie jest to potwierdzona data premiery.`,
      color: m.model.includes("astra") ? "accent" : "violet", visible: adapter ? true : ["gpt-6-astra", "gpt-6.1-terra", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"].includes(m.model),
    }));
    const prices: TimelineMarker[] = adapter ? Object.entries(card?.vendors[adapter.rateVendor]?.models ?? {}).flatMap(([model, rate]) => {
      if (!rate.until || !rate.after || !isAccountingDay(rate.until)) return [];
      const day = new Date(Date.parse(rate.until) + 86400000).toISOString().slice(0, 10);
      return [{ id: `price:configured:${model}:${day}`, day, label: `${model} · API price change`.slice(0, 120), visible: true, color: "warn" as const,
        note: `Configured API rates per 1M tokens changed at this UTC day boundary. Before: ${JSON.stringify({ in_uncached: rate.in_uncached, in_cache_read: rate.in_cache_read, in_cache_write_5m: rate.in_cache_write_5m, in_cache_write_1h: rate.in_cache_write_1h, out_total: rate.out_total })}. After: ${JSON.stringify(rate.after)}. Impact on subscription allowance: unverified; an API price change alone does not establish a quota change.` }];
    }) : configuredPriceMarkers(card);
    return response({ ...store, automatic: [...automatic, ...prices] } satisfies TimelineMarkersResponse);
  } catch (e) { return response({ error: (e as Error).message }, 503); }
}

export function timelineMarkerFilesStamp():unknown {
  if(!fs.existsSync(CONFIG_ROOT))return [];
  return fs.readdirSync(CONFIG_ROOT).filter(name=>name.endsWith("timeline-markers.json")).sort()
    .map(name=>[name,fs.readFileSync(path.join(CONFIG_ROOT,name),"utf8")]);
}
