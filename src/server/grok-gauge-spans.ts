import fs from "fs";
import path from "path";
import { configFile } from "../config/paths";
import { HOUR_MS } from "../providers/core/limit";

export interface GrokGaugeObservation {
  ts: string;
  percent: number;
  visible_share?: number;
  source?: string;
  note?: string;
}
export interface GrokResetAnchor {
  ts: string;
  precision?: "exact" | "day";
  last_refusal_ts?: string;
  first_success_ts?: string;
  source?: string;
  note?: string;
}
export interface GrokGaugeConfig {
  vendor?: string;
  subscription?: string;
  store?: string;
  plan?: string;
  window_hours?: number;
  reset_anchor?: GrokResetAnchor;
  observations?: GrokGaugeObservation[];
  caveats?: string[];
}
export function loadGrokGauge(rootDir?: string): GrokGaugeConfig {
  const file = rootDir ? path.join(rootDir, "grok-gauge.json") : configFile("grok-gauge.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as GrokGaugeConfig;
  } catch {
    return {};
  }
}

/**
 * The spans the Grok gauge reads (plan U1.4). xAI's Billing reading, when there is one, is a limit
 * window of `limit_windows`; everything else here is evidence the window producer keeps as intervals
 * of `window_usage`, so the gauge reads stored sums and never the calls:
 * - a manual observation of grok-gauge.json covers `[start, ts)` of its own window (`gauge:<ts>`);
 * - without a reading, a rolling fallback covers the last `minutes` up to and including the account's
 *   newest call (`rolling:<minutes>`), recomputed by the producer when calls arrive; it is never a
 *   measurement, and its end is the newest call, not the clock;
 * - with a declared reset anchor, the anchored period holding the newest call (`anchored:<start>`).
 */
export const grokGaugeAccount = (cfg: GrokGaugeConfig): string => (cfg.subscription || cfg.store || "grok").toLowerCase();
/** The declared window length; a live reading may report another length for its own window only. */
export const grokDeclaredWindowHours = (cfg: GrokGaugeConfig): number => cfg.window_hours && cfg.window_hours > 0 ? cfg.window_hours : 168;
/** Rolling fallbacks kept for every Grok account: the card's week and five hours, and a declared length. */
export function grokRollingMinutes(cfg: GrokGaugeConfig): number[] {
  return [...new Set([10080, 300, Math.round(grokDeclaredWindowHours(cfg) * 60)])].sort((a, b) => a - b);
}
export const grokRollingId = (minutes: number) => `rolling:${minutes}`;
export const grokObservationId = (ts: string) => `gauge:${ts}`;
export const grokAnchoredId = (start: string) => `anchored:${start}`;

/** The anchored period of `hours` that holds `atMs`, or null without a usable anchor. */
export function grokAnchoredWindow(anchor: GrokResetAnchor | undefined, hours: number, atMs: number): { startIso: string; endIso: string } | null {
  if (!anchor?.ts) return null;
  const anchorMs = new Date(anchor.ts).getTime();
  const lenMs = hours * HOUR_MS;
  if (!Number.isFinite(anchorMs) || !(lenMs > 0) || !Number.isFinite(atMs)) return null;
  const startMs = anchorMs + Math.floor((atMs - anchorMs) / lenMs) * lenMs;
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(startMs + lenMs).toISOString() };
}

/**
 * The span a manual observation was measured over: its anchored period when a reset is declared,
 * otherwise the declared length back from the observation itself — never from the clock.
 */
export function grokObservationSpan(cfg: GrokGaugeConfig, observation: GrokGaugeObservation): { start: string; end: string } | null {
  const tsMs = new Date(observation.ts).getTime();
  if (!Number.isFinite(tsMs)) return null;
  const hours = grokDeclaredWindowHours(cfg);
  const anchored = grokAnchoredWindow(cfg.reset_anchor, hours, tsMs);
  return { start: anchored ? anchored.startIso : new Date(tsMs - hours * HOUR_MS).toISOString(), end: observation.ts };
}
/** Observations of the shape the calibration accepts. */
export const grokGaugeObservations = (cfg: GrokGaugeConfig): GrokGaugeObservation[] =>
  (cfg.observations || []).filter((o) => o?.ts && typeof o.percent === "number");
