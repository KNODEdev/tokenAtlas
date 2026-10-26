import { vendorsForScope, type VendorId } from "../sync/contracts";
import { normalizeRebuildAccounts, normalizeRebuildMeters, type RebuildAccount, type RebuildMeters } from "./rebuild-accounts";
import { TIME_RANGE_DAYS } from "./time-range-presets";

// Keep 365d valid for already persisted jobs; new controls offer the common 360-day preset.
export const REBUILD_DAYS = [1, ...TIME_RANGE_DAYS, 365, 730] as const;
export type RebuildDays = typeof REBUILD_DAYS[number];
export type RebuildScope = "all" | "week" | "month" | "custom" | `${RebuildDays}d`;
export type RebuildMode = "archive" | "collect-archive";
export type RebuildDateRange = { from: string; until: string };
export type RebuildOptions = {
  scope: RebuildScope; mode?: RebuildMode; from?: string; until?: string; vendors?: VendorId[];
  /** Historical subscription IDs; usage is rebuilt with already accepted percentage readings. */
  accounts?: RebuildAccount[];
  /** Explicitly include archived meter observations for an account rebuild. */
  meters?: RebuildMeters;
};

function utcDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid UTC date (YYYY-MM-DD)");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error("Choose a valid UTC calendar date");
  return value;
}

export function parseRebuildOptions(value: unknown): RebuildOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recalculation options");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["scope","mode","from","until","action","vendors","accounts","meters"].includes(key))
    throw new Error(`Unsupported recalculation option: ${key}`);
  if(input.action!==undefined && input.action!=="resume")throw new Error("Unsupported recalculation action");
  const scope = input.scope ?? "all", mode = input.mode ?? "archive";
  if (!["all", "week", "month", "custom", ...REBUILD_DAYS.map(days => `${days}d`)].includes(String(scope)) || typeof scope !== "string")
    throw new Error("Choose a supported recalculation period");
  if (mode !== "archive" && mode !== "collect-archive") throw new Error("Choose archive or collect-archive mode");
  if (input.vendors !== undefined && input.accounts !== undefined) throw new Error("Vendor and account rebuild selectors cannot be combined");
  const meters = normalizeRebuildMeters(input.meters);
  if (meters !== undefined && input.accounts === undefined) throw new Error("Meter archive selection requires an account rebuild selector");
  const selected = input.accounts !== undefined ? {
    accounts: normalizeRebuildAccounts(input.accounts),
    ...(meters === undefined ? {} : { meters }),
  } : input.vendors === undefined ? {} : {
    vendors: vendorsForScope({ kind: "vendors", vendors: input.vendors as VendorId[] }),
  };
  if (scope !== "custom") {
    if (input.from !== undefined || input.until !== undefined) throw new Error("Dates require a custom period");
    return { scope: scope as RebuildScope, mode, ...selected };
  }
  const from = utcDay(input.from), until = utcDay(input.until);
  if (from > until) throw new Error("The start date must be on or before the end date");
  if (until === "9999-12-31") throw new Error("The end date must allow a following UTC day");
  return { scope, mode, from, until, ...selected };
}

/** Resolve once at enqueue time; persisted ranges never move at midnight or restart. */
export function resolveRebuildRange(options: RebuildOptions, now: Date): RebuildDateRange | null {
  const selected = parseRebuildOptions(options);
  if (selected.scope === "all") return null;
  if (selected.scope === "custom") return { from: selected.from!, until: selected.until! };
  const days = selected.scope === "week" ? 7 : selected.scope === "month" ? 30 : Number.parseInt(selected.scope, 10);
  const until = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${until}T00:00:00.000Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, until };
}

export function rebuildTimeBounds(range: RebuildDateRange): { from: string; untilExclusive: string } {
  const from = utcDay(range.from), until = utcDay(range.until);
  if (from > until) throw new Error("Invalid recalculation date range");
  return { from: `${from}T00:00:00.000Z`, untilExclusive: new Date(Date.parse(`${until}T00:00:00.000Z`) + 86_400_000).toISOString() };
}
