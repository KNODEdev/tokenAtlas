import type {
  CatalogPlan,
  CatalogPlanVersion,
  CatalogProviderGroup,
  PlanCapacityResult,
  PlanLimits,
  PlanSettingRow,
  PlansCatalog,
} from "./api";
import { api } from "./api";
import type { PlanTableRow, PlanTableVersion } from "../components/PlansTable";
import type { SubscriptionTableRow } from "../components/SubscriptionsTable";
import { isNoPlan } from "../../shared/period-end";
import { noPlanLabel } from "./no-plan";
import { resolvePlanFacts, resolveProviderGroup, resolvePlanVersion } from "../../shared/plan-catalog";

/** Rows of the Settings price tables (Plans, and price and calibration per account), built from the catalog and /api/plans. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
function versionIdOf(from: string | null | undefined): string {
  return from ?? "origin";
}
function sortedVersions(plan: CatalogPlan): CatalogPlanVersion[] {
  return [...plan.versions].sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
}
const UNKNOWN_WINDOW_KIND = "unknown_window_kind";
export function windowKindOf(limits: PlanLimits | undefined | null): string | null {
  if (!limits) return null;
  if (limits.weekly_cap === true) return "weekly";
  if (limits.window_hours === 5 || limits.window_hours === "5") return "5h";
  return null;
}
function shiftDay(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms + delta * 86_400_000).toISOString().slice(0, 10);
}
function findGroup(catalog: PlansCatalog, alias: string | null | undefined): CatalogProviderGroup | null {
  const match = resolveProviderGroup(catalog, alias ?? "");
  return match.kind === "ok" ? match.group : null;
}
function catalogVersionOn(catalog: PlansCatalog, provider: string, plan: CatalogPlan, asOf: string): CatalogPlanVersion | null {
  const version = resolvePlanVersion(catalog, provider, plan.plan_id, asOf);
  return version.kind === "ok" ? version.version : null;
}
function dayInsideVersion(version: CatalogPlanVersion, nextFrom: string | null, asOf: string): string {
  const start = version.from;
  if (start) {
    if (asOf >= start && (!nextFrom || asOf < nextFrom)) return asOf;
    return start;
  }
  if (!nextFrom || asOf < nextFrom) return asOf;
  return shiftDay(nextFrom, -1);
}
export function capKey(provider: string, planId: string, windowKind: string, asOf: string): string {
  return `${provider}\t${planId}\t${windowKind}\t${asOf}`;
}
export interface CapacityJob { provider: string; plan_id: string; window_kind: string; as_of: string }
export function buildCapacityJobs(catalog: PlansCatalog, asOf: string): CapacityJob[] {
  const jobs: CapacityJob[] = [];
  const seen = new Set<string>();
  const add = (provider: string, plan_id: string, window_kind: string | null, as_of: string) => {
    if (!window_kind) return;
    const key = capKey(provider, plan_id, window_kind, as_of);
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ provider, plan_id, window_kind, as_of });
  };
  for (const group of catalog.provider_groups) {
    for (const plan of group.plans) {
      const versions = sortedVersions(plan);
      const active = catalogVersionOn(catalog, group.id, plan, asOf);
      add(group.id, plan.plan_id, windowKindOf(active?.limits), asOf);
      for (let i = 0; i < versions.length; i++) {
        const version = versions[i]!;
        const nextFrom = versions[i + 1]?.from ?? null;
        add(group.id, plan.plan_id, windowKindOf(version.limits), dayInsideVersion(version, nextFrom, asOf));
      }
    }
  }
  return jobs;
}
/**
 * Only the capacities the given subscriptions' rows read: their plan on the "As of" day. The price and
 * calibration of a few accounts must not ask for every catalog plan and version as the Plans table does.
 */
export function subscriptionCapacityJobs(declarations: PlanSettingRow[], catalog: PlansCatalog, asOf: string): CapacityJob[] {
  const jobs = new Map<string, CapacityJob>();
  for (const row of declarations) {
    const group = findGroup(catalog, row.vendor);
    const planId = row.plan_on_day.plan_id;
    const plan = group && planId ? group.plans.find((candidate) => candidate.plan_id === planId) : null;
    if (!group || !plan) continue;
    const kind = windowKindOf(catalogVersionOn(catalog, group.id, plan, asOf)?.limits);
    if (!kind) continue;
    jobs.set(capKey(group.id, plan.plan_id, kind, asOf), { provider: group.id, plan_id: plan.plan_id, window_kind: kind, as_of: asOf });
  }
  return [...jobs.values()];
}
export type CapacityMap = Map<string, PlanCapacityResult | null>;
/** One request per job; a failed one reads as "no capacity" for that plan, not as an error of the whole table. */
export async function loadCapacities(jobs: CapacityJob[]): Promise<CapacityMap> {
  const entries = await Promise.all(jobs.map(async (job) => {
    const key = capKey(job.provider, job.plan_id, job.window_kind, job.as_of);
    try {
      return [key, await api.planCapacity(job)] as const;
    } catch {
      return [key, null] as const;
    }
  }));
  return new Map(entries);
}
export function buildPlanRows(catalog: PlansCatalog, capacities: CapacityMap, asOf: string, provider: string): PlanTableRow[] {
  const rows: PlanTableRow[] = [];
  for (const group of catalog.provider_groups) {
    if (provider !== "all" && group.id !== provider) continue;
    for (const plan of group.plans) {
      const versions = sortedVersions(plan);
      const catalogActive = catalogVersionOn(catalog, group.id, plan, asOf);
      const snapshotKind = windowKindOf(catalogActive?.limits);
      const snapshot = snapshotKind
        ? capacities.get(capKey(group.id, plan.plan_id, snapshotKind, asOf)) ?? null
        : null;
      const activeId = snapshot?.cohort?.plan_version ?? (catalogActive ? versionIdOf(catalogActive.from) : null);
      const active =
        versions.find((v) => versionIdOf(v.from) === activeId) ??
        (activeId ? null : catalogActive);
      const activeIndex = active ? versions.indexOf(active) : -1;
      const activeDay = active ? dayInsideVersion(active, versions[activeIndex + 1]?.from ?? null, asOf) : asOf;
      const history: PlanTableVersion[] = versions.map((version, i) => {
        const nextFrom = versions[i + 1]?.from ?? null;
        const kind = windowKindOf(version.limits);
        const day = dayInsideVersion(version, nextFrom, asOf);
        return {
          version_id: versionIdOf(version.from),
          from: version.from,
          usd_per_month: version.usd_per_month,
          limits: version.limits ?? null,
          source: version.source ?? null,
          note: version.note ?? null,
          window_kind: kind,
          kind_absent_reason: kind ? null : UNKNOWN_WINDOW_KIND,
          capacity: kind ? capacities.get(capKey(group.id, plan.plan_id, kind, day)) ?? null : null,
        };
      });
      rows.push({
        plan_id: plan.plan_id,
        label: active ? resolvePlanFacts(catalog, group.id, plan.plan_id, activeDay).display_label : plan.label,
        provider_group: group.id,
        provider_label: group.label,
        active_version_id: active ? versionIdOf(active.from) : activeId,
        active_from: active?.from ?? snapshot?.cohort?.version_from ?? null,
        usd_per_month: active?.usd_per_month ?? null,
        limits: active?.limits ?? null,
        window_kind: snapshotKind,
        kind_absent_reason: snapshotKind ? null : UNKNOWN_WINDOW_KIND,
        capacity: snapshot,
        versions: history,
        no_version_reason: active ? null : snapshot?.deviation.reason ?? "no_version_for_day",
      });
    }
  }
  return rows;
}
/**
 * Price and calibration of each billing account on the "As of" day. The plan is the one the account
 * periods give (declared over observed) and the price is its Plans catalog version price; plans.json
 * stages are retired (27.09). A plan with no catalog price shows "price missing", never 0.
 */
export function buildSubscriptionRows(
  declarations: PlanSettingRow[],
  catalog: PlansCatalog,
  capacities: CapacityMap,
  asOf: string,
  provider: string,
): SubscriptionTableRow[] {
  const rows: SubscriptionTableRow[] = [];
  for (const row of declarations) {
    const group = findGroup(catalog, row.vendor);
    if (provider !== "all" && (group == null || group.id !== provider)) continue;
    const onDay = row.plan_on_day;
    const base = {
      id: row.subscription,
      provider_group: group?.id ?? "",
      provider_label: group?.label ?? row.vendor,
      vendor: row.vendor,
      stage_from: onDay.from,
      stage_until: onDay.until,
    };
    if (onDay.plan == null) {
      // No plan periods at all keeps the rate-card price; a day outside the periods has no plan and no price.
      const hole = onDay.basis === "gap" || onDay.basis === "uncovered";
      rows.push({
        ...base,
        stage_kind: hole ? "gap" : "unassigned",
        plan_id: null,
        plan_label: null,
        plan_query: null,
        usd_per_month: hole ? null : row.fallback_usd_per_month,
        price_source: hole ? "none" : row.fallback_usd_per_month != null ? "rate-card" : "none",
        gap_reason: onDay.basis === "gap" ? "plan_gap" : onDay.basis === "uncovered" ? "outside_plan_periods" : undefined,
        capacity: null,
      });
      continue;
    }
    if (isNoPlan(onDay.plan)) {
      // A declared "no subscription": a known $0 price and no plan whose limits could be calibrated.
      rows.push({
        ...base,
        stage_kind: "no_plan",
        plan_id: null,
        plan_label: noPlanLabel(),
        plan_query: onDay.plan,
        usd_per_month: 0,
        price_source: "no-plan",
        capacity: null,
      });
      continue;
    }
    const facts = resolvePlanFacts(catalog, row.vendor, onDay.plan, asOf);
    const match = group?.plans.find((plan) => plan.plan_id === facts.plan_id) ?? null;
    if (!group || facts.plan_id === null) {
      rows.push({
        ...base,
        stage_kind: "unmatched",
        plan_id: null,
        plan_label: null,
        plan_query: onDay.plan,
        usd_per_month: null,
        price_source: "none",
        unmatched_reason: group ? "no_match" : "unknown_provider_alias",
        capacity: null,
      });
      continue;
    }
    const active = match ? catalogVersionOn(catalog, group.id, match, asOf) : null;
    const kind = windowKindOf(active?.limits);
    const cap = kind ? capacities.get(capKey(group.id, facts.plan_id, kind, asOf)) ?? null : null;
    const price = facts.usd_per_month;
    rows.push({
      ...base,
      stage_kind: "assigned",
      plan_id: facts.plan_id,
      plan_label: facts.display_label,
      plan_query: onDay.plan,
      usd_per_month: price,
      price_source: price != null ? "version" : "none",
      capacity: cap,
      ...(onDay.basis === "observed"
        ? { observed_plan_id: facts.plan_id, observed_plan_label: facts.display_label, observed_from: onDay.from, observed_until: onDay.until }
        : {}),
    });
  }
  return rows;
}
