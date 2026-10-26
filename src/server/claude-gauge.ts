import fs from "fs";
import path from "path";
import { configFile } from "../config/paths";

/** claude-gauge.json: the configured Claude account, its declared limits, boosts and manual observations. */
export interface ClaudeGaugeLimit {
  label?: string;
  share_of_all?: number;
  models?: string[];
  note?: string;
}
export interface ClaudeGaugeBoost {
  from?: string | null;
  until?: string | null;
  factor?: number;
  note?: string;
}
export interface ClaudeGaugeObservation {
  ts: string;
  reset_ts: string;
  window_start_ts?: string;
  percent: { all?: number; fable?: number };
  session_percent?: number;
  plan?: string;
  boost_factor?: number;
  source?: string;
  note?: string;
}
export interface ClaudeGaugeConfig {
  vendor?: string;
  subscription?: string;
  plan?: string;
  window_hours?: number;
  session_hours?: number;
  limits?: { all?: ClaudeGaugeLimit; fable?: ClaudeGaugeLimit };
  boosts?: ClaudeGaugeBoost[];
  observations?: ClaudeGaugeObservation[];
  caveats?: string[];
}
/** The provider name was historically used as an account id without identity evidence. */
export function claudeAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.toLowerCase() !== "claude" ? id : null;
}
export function loadClaudeGauge(rootDir?: string): ClaudeGaugeConfig {
  const file = rootDir ? path.join(rootDir, "claude-gauge.json") : configFile("claude-gauge.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ClaudeGaugeConfig;
  } catch {
    return {};
  }
}

/** The weekly window length the gauge declares; 168 hours without a valid declaration. */
export const claudeGaugeWindowHours = (cfg: ClaudeGaugeConfig): number => cfg.window_hours && cfg.window_hours > 0 ? cfg.window_hours : 168;

/**
 * The span a manual gauge observation measures: from its window start (declared, else the reset minus
 * the window length) up to the observation, kept inside the window. `[start, cutoff)`.
 */
export function claudeGaugeObservationSpan(obs: ClaudeGaugeObservation, windowHours: number): { start: string; cutoff: string } | null {
  const resetMs = Date.parse(obs.reset_ts);
  if (!Number.isFinite(resetMs)) return null;
  const startMs = obs.window_start_ts ? Date.parse(obs.window_start_ts) : resetMs - windowHours * 3_600_000;
  if (!Number.isFinite(startMs)) return null;
  const obsMs = Date.parse(obs.ts);
  const cutoffMs = Number.isFinite(obsMs) ? Math.min(Math.max(obsMs, startMs), resetMs) : resetMs;
  return { start: new Date(startMs).toISOString(), cutoff: new Date(cutoffMs).toISOString() };
}
/** The stored interval id of a gauge observation. */
export const claudeGaugeObservationId = (obs: ClaudeGaugeObservation): string =>
  `gauge:${JSON.stringify([obs.reset_ts, obs.ts, obs.window_start_ts ?? null])}`;
