import {isFinalContextDatabase} from "./codex-context-final-store";
import type { Database } from "bun:sqlite";
import { claudeCodeProductShareFromExtra, sameResetWindow } from "../providers/adapters/claude";
import { HOUR_MS } from "./plan-capacity-contracts";
import type { AccountResolver } from "./account-resolver";
import { loadAccountResolver } from "./account-resolver";
import type { PlanCapacityCollectContext, PlanWindowObservation, ObservationSlice } from "./plan-capacity-contracts";
import { planPeriodIndex } from "./account-periods";
import { resolveCodexAccountingConfig } from "./codex-accounting-pricing";
import { resolveProviderGroup, TOKEN_TYPES } from "./plans-catalog";
import { readCodexLimitWindows, codexLimitCounter } from "./codex-limit-windows";
import { codexCounterMinutes } from "../shared/codex-counters";
import { readWindowSums } from "./window-usage-read";
import type { TokenVector } from "./plans-catalog";
import { membershipRuns } from "./plan-capacity-periods";
import { normEraVendor } from "./eras";
import { readLimitWindowsWhere } from "../db/limit-windows";
import type { WindowSums } from "./window-usage-contracts";
import { readPreparedProbeAccountHistory, ProbeAccountIndexUnavailable } from "./current/probe-account-reader";

function tableExists(sqlite: Database, name: string): boolean {
  try {
    return sqlite.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`).get(name) != null;
  } catch {
    return false;
  }
}

function kindAliases(kind: string): string[] {
  const k = kind.toLowerCase();
  if (["weekly", "weekly_all", "weekly_scoped", "seven_day"].includes(k)) {
    return ["weekly", "weekly_all", "weekly_scoped", "seven_day"];
  }
  if (["5h", "session", "five_hour"].includes(k)) return ["5h", "session", "five_hour"];
  return [kind];
}

function gaugeFromPercents(percents: number[]): {
  first_percent: number;
  peak_percent: number;
  sample_count: number;
  lag_fraction: number;
  distinct_steps: number;
} {
  let peak = percents[0] ?? 0;
  let below = 0;
  const steps = new Set<number>();
  for (const p of percents) {
    if (p < peak) below += 1;
    if (p > peak) peak = p;
    steps.add(Math.floor(p));
  }
  return {
    first_percent: percents[0] ?? 0,
    peak_percent: peak,
    sample_count: percents.length,
    lag_fraction: percents.length > 0 ? below / percents.length : 0,
    distinct_steps: steps.size,
  };
}

interface ProbeRow {
  provider: string;
  subject: string;
  ts: string;
  kind: string;
  used_percent: number | null;
  window_minutes: number | null;
  resets_at: string | null;
  extra?: string | null;
}

/** Latest Code share read for exactly this weekly window; null when none was observed. */
function claudeWindowShare(samples: ProbeRow[], resetsAt: string): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const share = claudeCodeProductShareFromExtra(samples[i]!.extra ?? null);
    if (!share) continue;
    const end = new Date(Date.parse(share.window_started_at) + 7 * 24 * HOUR_MS).toISOString();
    if (sameResetWindow(end, resetsAt)) return share.percent;
  }
  return null;
}

function accountResolverOf(ctx: PlanCapacityCollectContext): AccountResolver {
  return ctx.resolver ?? loadAccountResolver(ctx.sqlite, (ctx.accounts?.subscriptions ?? [])
    .map((sub) => ({ id: sub.id, vendor: sub.vendor ?? undefined, account_key: sub.account_key })));
}

/**
 * Codex plan observations: the stored windows of each Codex account (limit_windows) with their stored token
 * slices (window_usage), so the canonical admission applies and nothing reads events here. A window of one
 * plan takes its traffic paired with the meter. A window whose plan changes inside it is split by plan
 * period at UTC hours: each part takes its paired traffic, or all its traffic when no reading falls in it.
 */
function codexPlanWindowObservations(ctx: PlanCapacityCollectContext, query: { provider: string; plan_id: string; window_kind: string },
  minutes: 300 | 10080 | 43200): PlanWindowObservation[] {
  const resolver = accountResolverOf(ctx), planIndex = planPeriodIndex(ctx.planPeriods);
  const firstPricedDay = ctx.rateCards ? resolveCodexAccountingConfig(ctx.rateCards).rules.map(rule => rule.valid_from).sort()[0] : null;
  const out: PlanWindowObservation[] = [];
  for (const subId of resolver.accounts("codex")) {
    const providerAlias = (ctx.accounts?.subscriptions ?? []).find(sub => sub.id.toLowerCase() === subId.toLowerCase())?.vendor || "codex";
    const aliasGroup = resolveProviderGroup(ctx.plansCatalog, providerAlias);
    if (aliasGroup.kind !== "ok" || aliasGroup.group.id !== "openai") continue;
    const windows = readCodexLimitWindows(ctx.sqlite, subId, minutes);
    const sums = readWindowSums(ctx.sqlite, "codex", subId, codexLimitCounter(minutes), windows, ["slices"]);
    for (const window of windows) {
      const runs = membershipRuns(ctx.plansCatalog, providerAlias, subId, window.start, window.end, planIndex);
      const uniform = runs.length === 1 && runs[0]!.plan_id === query.plan_id;
      for (const gap of runs.filter(run => run.plan_id == null && !run.no_plan)) out.push({ window_id: `${subId}|${query.window_kind}|${gap.endIso}|plan_period_gap`,
        subscription_id: subId, provider_alias: providerAlias, plan_id: query.plan_id, window_kind: query.window_kind,
        start_ts: gap.startIso, end_ts: gap.endIso, first_percent: 0, peak_percent: 0, sample_count: 0, tokens: {},
        cadence_hours: minutes / 60, exclusion_reason: "plan_period_gap" });
      for (const run of runs.filter(run => run.plan_id === query.plan_id)) {
        const readings = uniform ? window.readings : window.readings.filter(reading => reading.ts >= run.startIso && reading.ts < run.endIso);
        const percents = readings.map(reading => reading.percent);
        const gauge = gaugeFromPercents(percents);
        const measuredStart = readings[0]?.ts ?? run.startIso, measuredEnd = readings.at(-1)?.ts ?? run.endIso;
        const predatesPricing = firstPricedDay != null && measuredEnd.slice(0, 10) < firstPricedDay;
        const stored = sums.get(window.id)!.slices.filter(slice => uniform ? slice.paired
          : slice.hour >= run.startIso && slice.hour < run.endIso && (slice.paired || !readings.length));
        const byDay = new Map<string, ObservationSlice>();
        if (!predatesPricing) for (const slice of stored) {
          const day = slice.hour.slice(0, 10), key = JSON.stringify([slice.model, slice.speed, day, ...(slice.context_classified ? [slice.context_rates] : [])]);
          const row = byDay.get(key) ?? { model: slice.model, speed: slice.speed, day, tokens: {},
            ...(slice.context_classified ? {rates:slice.context_rates,context_classified:true} : isFinalContextDatabase(ctx.sqlite) ? {context_classified:false} : {}) };
          for (const type of TOKEN_TYPES) row.tokens[type] = (row.tokens[type] ?? 0) + slice.tokens[type];
          byDay.set(key, row);
        }
        const slices = [...byDay.values()];
        const tokens: Partial<TokenVector> = {};
        for (const slice of slices) for (const type of TOKEN_TYPES) tokens[type] = (tokens[type] ?? 0) + (slice.tokens[type] ?? 0);
        out.push({ window_id: `${subId}|${query.window_kind}|${run.endIso}`, subscription_id: subId, provider_alias: providerAlias,
          plan_id: query.plan_id, window_kind: query.window_kind, start_ts: measuredStart, end_ts: measuredEnd,
          exclusion_reason: predatesPricing ? "missing_rate" : percents.some((p, i) => i > 0 && p < percents[i - 1]!) ? "counter_decreased" : undefined,
          first_percent: gauge.first_percent, peak_percent: gauge.peak_percent, sample_count: gauge.sample_count,
          lag_fraction: gauge.lag_fraction, distinct_steps: gauge.distinct_steps, tokens,
          slices: slices.length ? slices : undefined, cadence_hours: minutes / 60 });
      }
    }
  }
  return out;
}

export function collectPlanWindowObservations(
  ctx: PlanCapacityCollectContext,
  query: { provider: string; plan_id: string; window_kind: string }
): PlanWindowObservation[] {
  if (!tableExists(ctx.sqlite, "probe_windows")) return [];
  const group = resolveProviderGroup(ctx.plansCatalog, query.provider);
  if (group.kind !== "ok") return [];
  if (group.group.id === "openai") {
    const minutes = query.window_kind === "session" ? 300 : codexCounterMinutes(query.window_kind);
    return minutes === null ? [] : codexPlanWindowObservations(ctx, query, minutes);
  }
  return storedPlanWindowObservations(ctx, query, group.group.id, [...new Set([group.group.id, ...group.group.aliases].map(normEraVendor))]);
}

/**
 * Plan observations of the other providers (plan U4.4): the stored windows of each account's counters of
 * the requested kind (limit_windows, the canonical window definition) with, for Claude, their stored token
 * slices (window_usage), so nothing reads events here. A window of one plan takes its traffic paired with
 * the meter; a window whose plan changes inside it is split by plan period at UTC hours, each part taking
 * its paired traffic, or all its traffic when no reading falls in it. With the vendor's Code share of a
 * Claude week only the Claude Code part of the slices counts. A Claude window with traffic no account owns
 * gets an excluded row. Other providers keep windows without tokens (their meters are not token-based).
 */
function storedPlanWindowObservations(ctx: PlanCapacityCollectContext, query: { provider: string; plan_id: string; window_kind: string },
  groupId: string, providers: readonly string[]): PlanWindowObservation[] {
  const kinds = new Set(kindAliases(query.window_kind).map(kind => kind.toLowerCase()));
  // A Claude counter scoped to a model (the Fable weekly sublimit) is not the plan's window; only the account-wide meter is.
  const anthropic = groupId === "anthropic";
  const resolver = accountResolverOf(ctx), planIndex = planPeriodIndex(ctx.planPeriods);
  const out: PlanWindowObservation[] = [];
  for (const provider of providers) for (const subId of resolver.accounts(provider)) {
    const providerAlias = (ctx.accounts?.subscriptions ?? []).find(sub => sub.id.toLowerCase() === subId.toLowerCase())?.vendor || provider;
    const aliasGroup = resolveProviderGroup(ctx.plansCatalog, providerAlias);
    if (aliasGroup.kind !== "ok" || aliasGroup.group.id !== groupId) continue;
    const windows = readLimitWindowsWhere(ctx.sqlite, provider, subId, counter => {
      const kind = String((JSON.parse(counter) as unknown[])[0]).toLowerCase();
      return kinds.has(kind) && !(anthropic && kind === "weekly_scoped");
    });
    const tokensKept = anthropic && provider === "claude";
    const byCounter = new Map<string, typeof windows>();
    for (const window of windows) byCounter.set(window.counter, [...byCounter.get(window.counter) ?? [], window]);
    const sums = new Map<string, Pick<WindowSums, "slices" | "rail">>();
    if (tokensKept) for (const [counter, rows] of byCounter)
      for (const [id, row] of readWindowSums(ctx.sqlite, provider, subId, counter, rows, ["slices", "rail"])) sums.set(id, row);
    // The vendor's Code share is a reading's own evidence; it is read only for the weekly account meter.
    const shareSamples = tokensKept && query.window_kind === "weekly" ? claudeShareSamples(ctx, provider, subId, kinds) : [];
    for (const window of windows) {
      const runs = membershipRuns(ctx.plansCatalog, providerAlias, subId, window.start, window.end, planIndex);
      const matching = runs.filter(run => run.plan_id === query.plan_id), gaps = runs.filter(run => run.plan_id == null && !run.no_plan);
      if (!matching.length && !gaps.length) continue;
      const uniform = runs.length === 1 && runs[0]!.plan_id === query.plan_id;
      const cadenceHours = window.window_minutes / 60;
      const blank = { subscription_id: subId, provider_alias: providerAlias, plan_id: query.plan_id, window_kind: query.window_kind,
        first_percent: 0, peak_percent: 0, sample_count: 0, tokens: {}, cadence_hours: cadenceHours };
      for (const gap of gaps) out.push({ ...blank, window_id: `${subId}|${query.window_kind}|${gap.endIso}|plan_period_gap`,
        start_ts: gap.startIso, end_ts: gap.endIso, exclusion_reason: "plan_period_gap" });
      const stored = sums.get(window.id);
      if ((stored?.rail.unowned?.events ?? 0) > 0) out.push({ ...blank, window_id: `${subId}|${query.window_kind}|${window.end}|unmapped`,
        start_ts: window.start, end_ts: window.end, exclusion_reason: "unmapped_claude_events" });
      const share = tokensKept && query.window_kind === "weekly" && uniform ? claudeWindowShare(shareSamples, window.reset) : null;
      for (const run of matching) {
        const readings = uniform ? window.readings : window.readings.filter(reading => reading.ts >= run.startIso && reading.ts < run.endIso);
        const percents = readings.map(reading => reading.percent);
        const gauge = gaugeFromPercents(percents);
        const byDay = new Map<string, ObservationSlice>();
        for (const slice of stored?.slices ?? []) {
          if (uniform ? !slice.paired : !(slice.hour >= run.startIso && slice.hour < run.endIso && (slice.paired || !readings.length))) continue;
          const counted = share != null ? slice.code : slice.tokens;
          if (!counted) continue;
          const day = slice.hour.slice(0, 10), key = JSON.stringify([slice.model, slice.speed, day, ...(slice.context_classified ? [slice.context_rates] : [])]);
          const row = byDay.get(key) ?? { model: slice.model, speed: slice.speed, day, tokens: {},
            ...(slice.context_classified ? {rates:slice.context_rates,context_classified:true} : isFinalContextDatabase(ctx.sqlite) ? {context_classified:false} : {}) };
          for (const type of TOKEN_TYPES) row.tokens[type] = (row.tokens[type] ?? 0) + counted[type];
          byDay.set(key, row);
        }
        const slices = [...byDay.values()].filter(slice => TOKEN_TYPES.some(type => (slice.tokens[type] ?? 0) > 0));
        const tokens: Partial<TokenVector> = {};
        for (const slice of slices) for (const type of TOKEN_TYPES) tokens[type] = (tokens[type] ?? 0) + (slice.tokens[type] ?? 0);
        out.push({ window_id: `${subId}|${query.window_kind}|${run.endIso}`, subscription_id: subId, provider_alias: providerAlias,
          plan_id: run.plan_id!, window_kind: query.window_kind, start_ts: readings[0]?.ts ?? run.startIso, end_ts: readings.at(-1)?.ts ?? run.endIso,
          // A meter that fell inside one run was reset or rescaled (a Claude plan change keeps the reset
          // time), so its peak no longer corresponds to the run's traffic.
          exclusion_reason: percents.some((p, i) => i > 0 && p < percents[i - 1]!) ? "counter_decreased" : undefined,
          first_percent: gauge.first_percent, peak_percent: gauge.peak_percent, sample_count: gauge.sample_count,
          lag_fraction: gauge.lag_fraction, distinct_steps: gauge.distinct_steps, tokens,
          slices: slices.length ? slices : undefined, cadence_hours: cadenceHours,
          ...(tokensKept && query.window_kind === "weekly" ? { local_share_percent: share } : {}) });
      }
    }
  }
  return out;
}

/** The account's weekly readings that carry the vendor's Claude Code share. */
function claudeShareSamples(ctx: PlanCapacityCollectContext, provider: string, account: string, kinds: ReadonlySet<string>): ProbeRow[] {
  const prepared = readPreparedProbeAccountHistory(ctx.sqlite, provider, account);
  if (!prepared) throw new ProbeAccountIndexUnavailable();
  return prepared.rows.filter(row => kinds.has(row.kind.toLowerCase()) && row.kind !== "weekly_scoped" && (row.scope == null || row.scope === "") && row.extra)
    .map(row => ({ provider: row.provider, subject: account, ts: row.ts, kind: row.kind, used_percent: row.used_percent as number | null,
      window_minutes: row.window_minutes as number | null, resets_at: row.resets_at as string | null, extra: row.extra as string | null }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
