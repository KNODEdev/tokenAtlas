import { displayPlanCatalog } from "./plan-catalog";
import { resolvePlanFacts, resolveProviderGroup } from "../../shared/plan-catalog";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { capacityFull, capacityIsLowerBound, capacityPlanEstablished, type CapacityUnit } from "./codex-capacity";

/**
 * The capacity battle: the plans of two providers tier by tier. Each plan shows the cycles the viewer attached to it,
 * nothing else; a plan without attached cycles may be derived from another plan of the same provider on request.
 */
export const BATTLE_PROVIDERS = ["codex", "claude"] as const;
export type BattleProvider = typeof BATTLE_PROVIDERS[number];
export const BATTLE_KEY = "tokenatlas.capacity-battle.v1";

/** Average weeks in a month: a weekly window repeats this often within one monthly payment. */
const WEEKS_PER_MONTH = 365.25 / 12 / 7;

/** A catalog tier of one provider: the newest version's monthly price and the plan name without its multiplier. */
export interface CatalogTier { tier: number; label: string; usdPerMonth: number | null }

/**
 * Tiers the active catalog lists for a provider. Claude Pro carries no multiplier in the catalog; it is the ×1 base the
 * Max multipliers refer to (as in `subscriptionPlan` and the server's `planTier`). A multiplier listed by more than one plan
 * keeps no price, since it cannot be told which one applies.
 */
export function catalogTiers(provider: string, day = new Date().toISOString().slice(0, 10)): CatalogTier[] {
  const catalog = displayPlanCatalog();
  const match = catalog ? resolveProviderGroup(catalog, provider) : null;
  const group = match?.kind === "ok" ? match.group : null;
  const tiers = new Map<number, CatalogTier & { plans: number }>();
  for (const plan of group?.plans ?? []) {
    const facts = resolvePlanFacts(catalog!, provider, plan.plan_id, day);
    const tier = facts.multiplier;
    if (tier === null) continue;
    const usd = facts.usd_per_month;
    const known = tiers.get(tier);
    tiers.set(tier, known ? { ...known, usdPerMonth: null, plans: known.plans + 1 }
      : { tier, label: plan.label.replace(/\s*\(?\d+x\)?/gi, "").trim(), usdPerMonth: usd, plans: 1 });
  }
  return [...tiers.values()].map(({ plans: _plans, ...tier }) => tier).sort((a, b) => a.tier - b.tier);
}

/** The usage tier of a cycle, only when its plan is confirmed and carries a multiplier. */
export function cycleTier(window: CodexComparisonWindow): number | null {
  const detail = window.plan_detail;
  if (!detail || detail.status !== "resolved" || !capacityPlanEstablished(window)) return null;
  return typeof detail.multiplier === "number" && detail.multiplier > 0 ? detail.multiplier : null;
}

/** What the viewer attached to one plan: cycle ids, or the tier of the same provider it is derived from. */
export interface PlanPick { cycles: string[]; from: number | null }
/** Picks per counter length ("10080" or "300"), then per plan (`provider:tier`). */
export type BattlePicks = Record<string, Record<string, PlanPick>>;
export const planKey = (provider: string, tier: number) => `${provider}:${tier}`;
export const EMPTY_PICK: PlanPick = { cycles: [], from: null };

export function readBattlePicks(storage: Storage | null = browserStorage()): BattlePicks {
  try {
    const value = JSON.parse(storage?.getItem(BATTLE_KEY) ?? "null") as { v?: number; picks?: BattlePicks } | null;
    return value?.v === 1 && value.picks && typeof value.picks === "object" ? value.picks : {};
  } catch { return {}; }
}
export function writeBattlePicks(picks: BattlePicks, storage: Storage | null = browserStorage()): void {
  try { storage?.setItem(BATTLE_KEY, JSON.stringify({ v: 1, picks })); } catch { /* The picks still apply for this visit. */ }
}
function browserStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export interface BattleCell {
  provider: BattleProvider;
  tier: number;
  label: string;
  usdPerMonth: number | null;
  /** Attached cycles found in the loaded range. */
  attached: CodexComparisonWindow[];
  /** Attached cycles with an estimate in the unit: the ones the value is the median of. */
  counted: number;
  value: number | null;
  source: "attached" | "derived" | "empty";
  /** Tier the value is derived from, when `source` is "derived". */
  from: number | null;
  /** API-equivalent $ per $ of the monthly price; only for weekly windows in $. */
  perDollar: number | null;
}
export interface BattleRow {
  tier: number;
  cells: Record<BattleProvider, BattleCell | null>;
  /** The provider with the larger value when both have one, and by how many percent it is larger. */
  winner: BattleProvider | null;
  lead: number | null;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * Rows of the battle for one counter: per tier and provider, the median full window of the attached cycles (a single
 * cycle shows that cycle). A plan without such a value takes, if the viewer asked for it, another plan's attached value
 * divided by that plan's tier and multiplied by its own; derived values are never derived from again.
 */
export function battleRows(windows: ReadonlyMap<string, CodexComparisonWindow>, picks: Record<string, PlanPick>,
  unit: CapacityUnit, basis: CapacityBasis, windowMinutes: number): BattleRow[] {
  const measured = new Map<string, BattleCell>();
  for (const provider of BATTLE_PROVIDERS) {
    for (const entry of catalogTiers(provider)) {
      const pick = picks[planKey(provider, entry.tier)] ?? EMPTY_PICK;
      const attached = pick.cycles.map(id => windows.get(id)).filter((window): window is CodexComparisonWindow => window !== undefined);
      const values = attached.filter(window => !capacityIsLowerBound(window, unit)).map(window => capacityFull(window, unit, basis))
        .filter((value): value is number => value !== null);
      measured.set(planKey(provider, entry.tier), { provider, tier: entry.tier, label: entry.label, usdPerMonth: entry.usdPerMonth, attached,
        counted: values.length, value: values.length ? median(values) : null, source: values.length ? "attached" : "empty", from: null, perDollar: null });
    }
  }
  const cell = (provider: BattleProvider, tier: number): BattleCell | null => {
    const own = measured.get(planKey(provider, tier));
    if (!own) return null;
    const from = picks[planKey(provider, tier)]?.from ?? null;
    const source = own.value === null && from !== null && from !== tier ? measured.get(planKey(provider, from)) : undefined;
    const done = source?.value != null ? { ...own, value: source.value / from! * tier, source: "derived" as const, from } : own;
    const usd = done.usdPerMonth;
    return { ...done, perDollar: done.value !== null && usd !== null && usd > 0 && unit === "api_standard" && windowMinutes === 10080
      ? done.value * WEEKS_PER_MONTH / usd : null };
  };
  const tiers = [...new Set([...measured.values()].map(item => item.tier))].sort((a, b) => a - b);
  return tiers.map(tier => {
    const cells = { codex: cell("codex", tier), claude: cell("claude", tier) };
    const a = cells.codex?.value ?? null, b = cells.claude?.value ?? null;
    const winner = a !== null && b !== null && a !== b ? (a > b ? "codex" : "claude") : null;
    return { tier, cells, winner, lead: winner && a && b ? (Math.max(a, b) / Math.min(a, b) - 1) * 100 : null };
  });
}

/** Tiers of the same provider that can serve as the source of a derived value: those with attached values. */
export function deriveSources(row: BattleRow[], provider: BattleProvider, tier: number): number[] {
  return row.flatMap(item => {
    const cell = item.cells[provider];
    return cell && cell.tier !== tier && cell.source === "attached" ? [cell.tier] : [];
  });
}
