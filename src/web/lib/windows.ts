import type { ApiActivityPoint, ApiMachineTraffic, ApiPoint } from "./api";
import type { CycleView } from "./cycle";
import { getLocale } from "./i18n";
import type { ClaudeAccountMeters, ClaudeAccountSplit } from "../../shared/claude-code-capacity";
import type { CreditPoolsOfRange } from "../../shared/credit-pools";
import type { ContextPrice } from "../../shared/context-price";
export interface RailTrafficShare {
  machine: string | null;
  amount: number;
}
/** "manual": the newest reading comes from a manual measurement, not from the vendor. */
export type RailPercentBasis = "measured" | "manual" | "counterfactual" | null;
export interface RailSublimit {
  counterKey?: string;
  label: string;
  usedPercent: number | null;
  percentBasis: RailPercentBasis;
  shape?: Array<{ t: number; pct: number; activity?: number }> | null;
  activityShape?: Array<{ t: number; amount: number }> | null;
  regimeKey?: string | null;
  sampledAtIso?: string | null;
  sampleMachine?: string | null;
  trafficByMachine?: RailTrafficShare[];
  tokensTotal: number | null;
  usd: number | null;
  note: string | null;
}
export interface RailWindow {
  activity?: import("../../shared/window-activity").WindowActivity;
  /** Codex's whole-window jointly priced split, used as a ratio for its rail dollars. */
  context_price?: ContextPrice;
  /** Claude: the same sample, valuation basis and model results used by Capacity. */
  claude_capacity?: import("../../shared/claude-capacity-result").ClaudeCapacityResult;
  key: string;
  counterKey?: string;
  parentCounterKey?: string | null;
  counterLabel?: string;
  label: string;
  dateLabel: string;
  source: "cycle" | "probe" | "rolling" | "declared";
  isCurrent: boolean;
  usedPercent: number | null;
  percentBasis: RailPercentBasis;
  /** The account's plan period over the whole window; null when unknown or when it changed inside. */
  plan?: string | null;
  elapsedPercent: number | null;
  ppAhead: number | null;
  windowHours: number | null;
  startIso: string | null;
  resetIso: string | null;
  shape: Array<{ t: number; pct: number; activity?: number }> | null;
  activityShape?: Array<{ t: number; amount: number }> | null;
  regimeKey?: string | null;
  sampledAtIso?: string | null;
  sampleMachine?: string | null;
  trafficByMachine?: RailTrafficShare[];
  tokensTotal: number | null;
  usd: number | null;
  note: string | null;
  scope: string | null;
  sublimits: RailSublimit[];
  /** Claude weekly windows: the whole account split by surface, from the window's last reading. */
  accountSplit?: ClaudeAccountSplit | null;
  /**
   * Claude: one counter segment of a server window that a plan change cut without moving the
   * reset. `startDrop` is the meter drop this segment starts at, `endDrop` the one that ends it.
   */
  counterSegment?: { startDrop: RailCounterDrop | null; endDrop: RailCounterDrop | null } | null;
  /** Claude current weekly window: the account's other meters from the same reading. */
  accountMeters?: ClaudeAccountMeters | null;
  /** Credit pools at the window's newest reading and their movement within the window. */
  creditPools?: CreditPoolsOfRange | null;
}
export interface RailCounterDrop {
  before: number;
  after: number;
}
export const MIN_RAIL_SHAPE_POINTS = 3;

function localizedNumber(value: number, fractionDigits = 0): string {
  return value
    .toLocaleString(getLocale(), {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
    .replace(/\u00a0/g, " ");
}
function localizedQuantity(value: number): string {
  return value.toLocaleString(getLocale(), { maximumFractionDigits: 10 }).replace(/\u00a0/g, " ");
}
function localizedDate(value: string, fallback: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? fallback
    : new Intl.DateTimeFormat(getLocale(), {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
}

function effectiveAllowanceBand(cycle: CycleView): string {
  const allowance = cycle.calibration.allowanceTokens;
  if (
    allowance == null ||
    !Number.isFinite(allowance) ||
    allowance <= 0 ||
    cycle.calibration.confidence === "none"
  ) {
    // An unknown effective capacity must not silently join a historical baseline.
    return `unobserved-${cycle.index}`;
  }
  // Token mix makes the estimate noisy. Logarithmic 50% bands still separate
  // meaningful allowance changes without inventing false per-token precision.
  return `band-${Math.round(Math.log(allowance) / Math.log(1.5))}`;
}

export function railWindowsFromCycles(
  cycles: CycleView[],
  points: ApiPoint[],
  activity: ApiActivityPoint[] = [],
  traffic: ApiMachineTraffic[] = []
): RailWindow[] {
  const byCycle = new Map<number, ApiPoint[]>();
  const activityByCycle = new Map<number, ApiActivityPoint[]>();
  const trafficByCycle = new Map<number, RailTrafficShare[]>();
  for (const point of points) {
    const bucket = byCycle.get(point.cycle);
    if (bucket) bucket.push(point);
    else byCycle.set(point.cycle, [point]);
  }
  for (const point of activity) {
    const bucket = activityByCycle.get(point.cycle);
    if (bucket) bucket.push(point);
    else activityByCycle.set(point.cycle, [point]);
  }
  for (const row of traffic) {
    const bucket = trafficByCycle.get(row.cycle);
    const share = { machine: row.machine, amount: row.amount };
    if (bucket) bucket.push(share);
    else trafficByCycle.set(row.cycle, [share]);
  }
  return cycles.map((cycle) => {
    const samples = [...(byCycle.get(cycle.index) ?? [])]
      .sort((a, b) => (a.cycle_progress ?? 0) - (b.cycle_progress ?? 0));
    const activitySamples = [...(activityByCycle.get(cycle.index) ?? [])]
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.amount))
      .sort((a, b) => a.t - b.t);
    const planKey = [...cycle.raw.plan_types].map((plan) => plan.trim().toLowerCase()).sort().join("+") || `unknown-plan@${cycle.index}`;
    const limitKey = cycle.raw.limit_id ?? "unknown-limit";
    const limitNameKey = [...cycle.raw.limit_names].map((name) => name.trim().toLowerCase()).sort().join("+") || "unknown-name";
    const allowanceKey = effectiveAllowanceBand(cycle);
    const label = cycle.windowHours % 24 === 0
      ? `${localizedNumber(cycle.windowHours / 24)}d`
      : `${localizedQuantity(cycle.windowHours)}h`;
    return {
      key: String(cycle.index),
      counterKey: `codex:${limitKey}:${cycle.windowHours}h`,
      counterLabel: limitKey === "codex" ? label : `${label} · ${limitKey}`,
      label: `#${localizedNumber(cycle.number)}`,
      dateLabel: localizedDate(cycle.raw.label, cycle.dateLabel),
      source: "cycle",
      isCurrent: cycle.isActive,
      usedPercent: cycle.usedPercent,
      percentBasis: "measured",
      elapsedPercent: cycle.elapsedPercent,
      ppAhead: cycle.ppAhead,
      windowHours: cycle.windowHours,
      startIso: cycle.startIso,
      resetIso: cycle.resetIso,
      shape:
        samples.length >= MIN_RAIL_SHAPE_POINTS
          ? samples.map((point) => ({ t: point.cycle_progress ?? 0, pct: point.percent }))
          : null,
      activityShape:
        activitySamples.length > 1
          ? activitySamples.map((point) => ({ t: point.t, amount: point.amount }))
          : null,
      regimeKey: `codex:${limitKey}:${cycle.windowHours}h:${planKey}:${limitNameKey}:allowance=${allowanceKey}`,
      sampledAtIso: samples.at(-1)?.ts ?? null,
      sampleMachine: null,
      trafficByMachine: trafficByCycle.get(cycle.index) ?? [],
      tokensTotal: cycle.tokensTotal,
      usd: cycle.usd,
      note: null,
      scope: null,
      sublimits: [],
    } satisfies RailWindow;
  });
}
