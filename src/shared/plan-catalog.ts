import { NO_PLAN, canonicalPeriodPlan, isFreePlan, isNoPlan } from "./period-end";
import { formatPlanLabel } from "./plan-label";

export const TOKEN_TYPES = [
  "in_uncached",
  "in_cache_read",
  "in_cache_write_5m",
  "in_cache_write_1h",
  "out_total",
] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];
export type TokenVector = Record<TokenType, number>;
export type DefaultReferencePresent = {
  tokens_per_1pct: TokenVector;
  source: string;
  notes?: string | null;
};
export type DefaultReferenceAbsent = {
  absent: true;
  reason: string;
};
export type DefaultReference = DefaultReferencePresent | DefaultReferenceAbsent;
export type PlanLimits = Record<string, string | number | boolean | null>;
export interface PlanVersion {
  from: string | null;
  usd_per_month: number | null;
  usd_per_month_annual?: number | null;
  limits?: PlanLimits;
  source?: string | null;
  note?: string | null;
  default_reference?: DefaultReference | null;
}
export interface CatalogPlan {
  plan_id: string;
  label: string;
  aliases?: string[];
  versions: PlanVersion[];
}
export interface ProviderGroup {
  id: string;
  label: string;
  aliases: string[];
  plans: CatalogPlan[];
}
export interface PlansCatalog {
  _comment?: string[];
  provider_groups: ProviderGroup[];
}
export type ProviderGroupResult =
  | { kind: "ok"; group: ProviderGroup }
  | { kind: "unassigned"; reason: "unknown_provider_alias"; alias: string };
export type PlanMatch =
  | { kind: "ok"; plan_id: string; plan: CatalogPlan; group: ProviderGroup }
  | { kind: "unassigned"; reason: "unknown_provider_alias"; alias: string }
  | { kind: "unassigned"; reason: "no_match" | "ambiguous_match"; query: string; group: ProviderGroup };
export type PlanVersionResult =
  | {
      kind: "ok";
      group: ProviderGroup;
      plan: CatalogPlan;
      version: PlanVersion;
      version_from: string | null;
      version_id: string;
    }
  | { kind: "unassigned"; reason: "unknown_provider_alias"; alias: string }
  | { kind: "unassigned"; reason: "unknown_plan"; plan_id: string; group: ProviderGroup }
  | { kind: "no_version_for_day"; plan_id: string; day: string; group: ProviderGroup; plan: CatalogPlan };

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayMs(value)) && new Date(dayMs(value)).toISOString().slice(0, 10) === value;
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}
export function resolveProviderGroup(catalog: PlansCatalog, alias: string): ProviderGroupResult {
  const want = norm(alias);
  if (!want) return { kind: "unassigned", reason: "unknown_provider_alias", alias };
  for (const group of catalog.provider_groups) {
    const names = [group.id, ...(group.aliases ?? [])].map(norm);
    if (names.includes(want)) return { kind: "ok", group };
  }
  return { kind: "unassigned", reason: "unknown_provider_alias", alias };
}
export function matchPlanAlias(catalog: PlansCatalog, providerAlias: string, alias: string): PlanMatch {
  const groupResult = resolveProviderGroup(catalog, providerAlias);
  if (groupResult.kind !== "ok") return groupResult;
  // "No subscription" is built in, never a catalog plan: it must not borrow any plan's limits or tier.
  if (isNoPlan(canonicalPeriodPlan(alias.trim()))) return { kind: "unassigned", reason: "no_match", query: alias, group: groupResult.group };
  const query = norm(canonicalPeriodPlan(alias.trim()));
  const hits = new Map<string, CatalogPlan>();
  for (const plan of groupResult.group.plans) {
    // A plan's own id names it too (declarations and fixtures may use it); labels are display text.
    if ([plan.plan_id, ...(plan.aliases ?? [])].map(norm).includes(query)) hits.set(plan.plan_id.toLowerCase(), plan);
  }
  if (hits.size === 1) {
    const plan = [...hits.values()][0]!;
    return { kind: "ok", plan_id: plan.plan_id, plan, group: groupResult.group };
  }
  if (hits.size === 0) return { kind: "unassigned", reason: "no_match", query: alias, group: groupResult.group };
  return { kind: "unassigned", reason: "ambiguous_match", query: alias, group: groupResult.group };
}
function sortedVersions(plan: CatalogPlan): PlanVersion[] {
  return [...plan.versions].sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
}
function versionIdOf(version: PlanVersion): string {
  return version.from ?? "origin";
}
export function resolvePlanVersion(
  catalog: PlansCatalog,
  providerAlias: string,
  planId: string,
  day: string
): PlanVersionResult {
  const groupResult = resolveProviderGroup(catalog, providerAlias);
  if (groupResult.kind !== "ok") return groupResult;
  const want = norm(planId);
  const plan = groupResult.group.plans.find((p) => norm(p.plan_id) === want);
  if (!plan) return { kind: "unassigned", reason: "unknown_plan", plan_id: planId, group: groupResult.group };
  if (!isDay(day)) return { kind: "no_version_for_day", plan_id: plan.plan_id, day, group: groupResult.group, plan };
  const target = dayMs(day);
  let chosen: PlanVersion | null = null;
  for (const version of sortedVersions(plan)) {
    const start = version.from ? dayMs(version.from) : Number.NEGATIVE_INFINITY;
    if (target >= start) chosen = version;
  }
  if (!chosen) return { kind: "no_version_for_day", plan_id: plan.plan_id, day, group: groupResult.group, plan };
  return {
    kind: "ok",
    group: groupResult.group,
    plan,
    version: chosen,
    version_from: chosen.from,
    version_id: versionIdOf(chosen),
  };
}

export type PlanFactsIssue = "unknown_provider_alias" | "no_match" | "ambiguous_match" | "no_version_for_day";
/** Global offer facts. An account's dated entitlement and payment are separate facts. */
export interface PlanFacts {
  provider: string;
  plan_id: string | null;
  version_id: string | null;
  label: string;
  display_label: string;
  multiplier: number | null;
  usd_per_month: number | null;
  usd_per_month_annual: number | null;
  source: "catalog" | "builtin";
  issue: PlanFactsIssue | null;
}

/** One alias/date/variant resolver for server calculations and browser presentation. */
export function resolvePlanFacts(catalog: PlansCatalog, provider: string, value: string, day: string): PlanFacts {
  const alias = canonicalPeriodPlan(value.trim());
  const group = resolveProviderGroup(catalog, provider);
  const providerId = group.kind === "ok" ? group.group.id : norm(provider);
  const base: PlanFacts = { provider: providerId, plan_id: null, version_id: null, label: alias, display_label: alias,
    multiplier: null, usd_per_month: null, usd_per_month_annual: null, source: "catalog", issue: null };
  // These intrinsic zero-cost states need no paid-offer catalog entry or multiplier.
  if (isNoPlan(alias)) return { ...base, plan_id: NO_PLAN, label: "No subscription", display_label: "No subscription",
    usd_per_month: 0, source: "builtin" };
  if ((providerId === "openai" || providerId === "codex") && isFreePlan(alias)) {
    return { ...base, plan_id: "codex-free", label: "Free", display_label: "Free", usd_per_month: 0, source: "builtin" };
  }
  const match = matchPlanAlias(catalog, provider, alias);
  if (match.kind !== "ok") return { ...base, issue: match.reason };
  const known = { ...base, plan_id: match.plan_id, label: match.plan.label, display_label: match.plan.label };
  const version = resolvePlanVersion(catalog, provider, match.plan_id, day.slice(0, 10));
  if (version.kind !== "ok") return { ...known, issue: "no_version_for_day" };
  const factor = version.version.limits?.credits_multiplier;
  const multiplier = typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor
    : match.plan_id === "claude-pro" ? 1 : null;
  const price = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return { ...known, version_id: version.version_id, multiplier, display_label: formatPlanLabel(match.plan.label, multiplier),
    usd_per_month: price(version.version.usd_per_month), usd_per_month_annual: price(version.version.usd_per_month_annual) };
}
