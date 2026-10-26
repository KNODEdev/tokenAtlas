import type { CapacityBasis } from "../../shared/codex-promotions";
import type { WindowQuality } from "../../shared/subscription-quality";
import { TIME_RANGE_DAYS } from "../../shared/time-range-presets";
import { codexCounterMinutes } from "../../shared/codex-counters";
import { DEFAULT_MIN_OBSERVED_PERCENT, normalizeCapacityMinObservedPercent, type CapacityUnit } from "./codex-capacity";

export interface CapacityFilterPreferences {
  unit: CapacityUnit;
  counter?: string;
  quality: "all" | WindowQuality;
  basis: CapacityBasis;
  minimum: number;
  days: number;
  custom: { since: string; until: string };
  plans: Record<string, string>;
  hidden: Record<string, string[]>;
}

export const capacityPreferencesKey = (provider: string, account: string): string =>
  `tokenatlas.capacity-filters.v1:${JSON.stringify([provider, account])}`;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function readCapacityPreferences(provider: string, account: string, defaults: CapacityFilterPreferences): CapacityFilterPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(capacityPreferencesKey(provider, account)) ?? "null");
    if (!record(raw)) return defaults;
    const custom = record(raw.custom) && day(raw.custom.since) && day(raw.custom.until)
      && Date.parse(raw.custom.until) >= Date.parse(raw.custom.since)
      && Date.parse(raw.custom.until) - Date.parse(raw.custom.since) < 366 * 86400000
      ? { since: raw.custom.since, until: raw.custom.until } : defaults.custom;
    return {
      unit: raw.unit === "api_standard" || raw.unit === "credits_low" || raw.unit === "tokens" ? raw.unit : defaults.unit,
      counter: typeof raw.counter === "string" && raw.counter && (provider !== "codex" || codexCounterMinutes(raw.counter) !== null) ? raw.counter : defaults.counter,
      quality: raw.quality === "all" || raw.quality === "comparable" || raw.quality === "partial" || raw.quality === "insufficient" ? raw.quality : defaults.quality,
      basis: raw.basis === "observed" || raw.basis === "regular" ? raw.basis : defaults.basis,
      minimum: normalizeCapacityMinObservedPercent(raw.minimum ?? defaults.minimum),
      days: typeof raw.days === "number" && [-1, 0, 1, ...TIME_RANGE_DAYS].includes(raw.days) ? raw.days : defaults.days,
      custom,
      plans: record(raw.plans) ? Object.fromEntries(Object.entries(raw.plans).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {},
      hidden: record(raw.hidden) ? Object.fromEntries(Object.entries(raw.hidden).filter(([, ids]) => Array.isArray(ids))
        .map(([counter, ids]) => [counter, [...new Set((ids as unknown[]).filter((id): id is string => typeof id === "string"))]])) : {},
    };
  } catch { return defaults; }
}

export function writeCapacityPreferences(provider: string, account: string, preferences: CapacityFilterPreferences): boolean {
  try { localStorage.setItem(capacityPreferencesKey(provider, account), JSON.stringify(preferences)); return true; }
  catch { return false; }
}

/** Copy the retired global minimum once; subsequent changes belong to one subscription. */
export function legacyCapacityMinimum(): number {
  try { return normalizeCapacityMinObservedPercent(localStorage.getItem("tokenatlas.codex-capacity-min-observed-percent.v1")); }
  catch { return DEFAULT_MIN_OBSERVED_PERCENT; }
}
