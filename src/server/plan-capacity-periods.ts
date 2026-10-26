import type { PlansCatalog } from "./plans-catalog";
import { resolvePlanVersion, matchPlanAlias, resolveProviderGroup } from "./plans-catalog";
import type { PeriodIndex } from "./account-periods";
import { canonicalPeriodPlan, isNoPlan } from "../shared/period-end";
import { periodInstant } from "./account-periods";

const DAY_MS = 86_400_000;

export function inclusiveEndDay(startTs: string, endTs: string): string {
  const startDay = startTs.slice(0, 10);
  const endMs = Date.parse(endTs);
  if (!Number.isFinite(endMs)) return startDay;
  const last = new Date(Math.max(Date.parse(startTs) || endMs, endMs - 1)).toISOString().slice(0, 10);
  return last < startDay ? startDay : last;
}

function utcDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function versionIdOf(from: string | null): string {
  return from ?? "origin";
}

export function versionOnDay(
  catalog: PlansCatalog,
  provider: string,
  planId: string,
  day: string
): string | null {
  const resolved = resolvePlanVersion(catalog, provider, planId, day);
  if (resolved.kind !== "ok") return null;
  return resolved.version_id;
}

/** The same catalog match as the period's tier in Settings, so an observed Codex `pro` is Pro (20x). */
function planIdAt(catalog: PlansCatalog, index: PeriodIndex, providerAlias: string, subscriptionId: string, at: string): string | null {
  const value = index.resolve(providerAlias, subscriptionId, at).value;
  if (!value) return null;
  const match = matchPlanAlias(catalog, providerAlias, canonicalPeriodPlan(value));
  return match.kind === "ok" ? match.plan_id : null;
}

interface MembershipRun {
  startIso: string;
  endIso: string;
  plan_id: string | null;
  version_id: string | null;
  /** A declared "no subscription": no plan claims the run, yet it is no gap in the plan history either. */
  no_plan: boolean;
}

export function membershipRuns(
  catalog: PlansCatalog,
  providerAlias: string,
  subscriptionId: string,
  startIso: string,
  endIso: string,
  planIndex: PeriodIndex | null = null
): MembershipRun[] {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const startDay = startIso.slice(0, 10);
  const lastDay = inclusiveEndDay(startIso, endIso);
  const cuts = new Set<number>([utcDayMs(startDay), utcDayMs(lastDay) + DAY_MS]);
  const periods = planIndex?.periodsOf(providerAlias, subscriptionId) ?? [];
  // Period edges are instants, so a plan change inside a day splits the window exactly there.
  for (const period of periods) {
    for (const edge of [period.from, period.until]) {
      if (edge == null) continue;
      const at = periodInstant(edge, "plan period edge");
      if (at > startMs && at < endMs) cuts.add(at);
    }
  }
  const group = resolveProviderGroup(catalog, providerAlias);
  const plansList = group.kind === "ok" ? group.group.plans : [];
  for (const plan of plansList) {
    for (const version of plan.versions) {
      if (!version.from) continue;
      const t = utcDayMs(version.from);
      if (t > utcDayMs(startDay) && t <= utcDayMs(lastDay)) cuts.add(t);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const raw: MembershipRun[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const fromDay = utcDay(points[i]!);
    const runStart = Math.max(startMs, points[i]!);
    const runEnd = Math.min(endMs, points[i + 1]!);
    if (runEnd <= runStart) continue;
    // Without plan periods the account has no plan history, so no plan claims the window.
    const at = new Date(runStart).toISOString();
    const noPlan = periods.length > 0 && isNoPlan(planIndex!.resolve(providerAlias, subscriptionId, at).value);
    const planId = periods.length && !noPlan
      ? planIdAt(catalog, planIndex!, providerAlias, subscriptionId, at)
      : null;
    const versionId = planId ? versionOnDay(catalog, providerAlias, planId, fromDay) : null;
    raw.push({
      startIso: new Date(runStart).toISOString(),
      endIso: new Date(runEnd).toISOString(),
      plan_id: planId,
      version_id: versionId,
      no_plan: noPlan,
    });
  }
  const merged: MembershipRun[] = [];
  for (const run of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.plan_id === run.plan_id && prev.version_id === run.version_id && prev.no_plan === run.no_plan && prev.endIso === run.startIso) {
      prev.endIso = run.endIso;
    } else merged.push({ ...run });
  }
  return merged;
}
