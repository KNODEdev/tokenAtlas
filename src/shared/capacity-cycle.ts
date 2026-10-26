import type { WindowUsage } from "./codex-accounting";

/** The meter's first ceiling bounds calibration; it says nothing about later calls' funding. */
export function firstSaturatedReading<T>(readings: readonly T[], percent: (reading: T) => number | null): T | undefined {
  return readings.find(reading => (percent(reading) ?? -1) >= 100);
}

export interface CapacityCycleModel extends WindowUsage {
  name: string;
  cache_write: number | null;
  cache_write_in_input: boolean;
  pricing_issues: Record<string, { events: number; tokens: number }>;
}

/** Exact event times and real meter readings, loaded for one cycle on demand. */
export interface CapacityUsagePoint {
  ts: number;
  events: number;
  tokens: number;
  api_standard: number;
  api_normalized?: number;
  credits_low: number;
  credits_high: number;
  unpriced_events: number;
  /** See WindowUsage: credits did not exist for these events, they are not zero. */
  credits_unavailable_events?: number;
  unknown_tokens: number;
}

export interface CapacityMeterPoint {
  ts: number;
  percent: number;
  source: "session" | "probe" | "manual" | "limit_hit";
  limit_hit?: { call_id: string };
}

/** All counted traffic of the cycle from one archive source (one profile on one computer). */
export interface CapacityCycleSource extends WindowUsage {
  /** The source as events name it: an archive folder path or a ledger source key. */
  name: string;
  /** The computer whose archive folder this is; null when no known computer matches its name. */
  machine: string | null;
  first: string;
  last: string;
}

export interface CapacityCycleTimeline {
  readings: CapacityMeterPoint[];
  usage: CapacityUsagePoint[];
  models?: CapacityCycleModel[];
  sources?: CapacityCycleSource[];
}

export type CapacityCycleMetric = "tokens" | "api_standard" | "credits_low" | "credits_high";
