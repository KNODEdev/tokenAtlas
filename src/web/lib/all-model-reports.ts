import type { AmountCoverage, CodexAccountingReport, CodexNormalization, CodexTrafficPeriod, TimelineMarkersResponse } from "../../shared/codex-accounting";
import type { SubscriptionAccountingOptions } from "../../shared/subscription-accounting";
import type { ApiAccount } from "./api";
import { subscriptionAnalysisAdapter } from "./subscription-analysis";

export function modelReportAccounts(accounts: readonly ApiAccount[]) {
  return [...new Map(accounts.filter(account => account.has_events && !["all", "__all__"].includes(account.id.toLowerCase()))
    .map(account => [account.id, { account: account.id, provider: subscriptionAnalysisAdapter(account.vendor ?? "unknown").id }])).values()];
}

function coverage(parts: readonly AmountCoverage[]): AmountCoverage {
  const total: AmountCoverage = { value: null, priced_subtotal: 0, status: "empty", priced_events: 0, unpriced_events: 0, priced_tokens: 0, unpriced_tokens: 0, reasons: {} };
  for (const part of parts) {
    for (const key of ["priced_subtotal", "priced_events", "unpriced_events", "priced_tokens", "unpriced_tokens"] as const) total[key] += part[key];
    for (const [reason, counts] of Object.entries(part.reasons)) {
      const prior = total.reasons[reason] ?? { events: 0, tokens: 0 };
      total.reasons[reason] = { events: prior.events + counts.events, tokens: prior.tokens + counts.tokens };
    }
  }
  total.status = total.unpriced_events ? total.priced_events ? "partial" : "unpriced" : total.priced_events ? "complete" : "empty";
  total.value = total.status === "complete" ? total.priced_subtotal : null;
  return total;
}

/** Combine published reports only; daily buckets avoid overlapping subscriptions' reset periods. */
export function aggregateModelReports(reports: readonly CodexAccountingReport[], scope: SubscriptionAccountingOptions): CodexAccountingReport {
  const sum = (key: "events" | "tokens" | "known_speed_events" | "known_speed_tokens" | "unknown_speed_events" | "unknown_speed_tokens" | "excluded_mirror_events" | "unattributed_events") => reports.reduce((value, report) => value + report[key], 0);
  const unavailable = (): AmountCoverage => ({ ...coverage([]), status: sum("events") ? "unpriced" : "empty", unpriced_events: sum("events"), unpriced_tokens: sum("tokens") });
  const standard = coverage(reports.map(report => report.normalization.standard_api_usd));
  const normalization: CodexNormalization = { standard_api_usd: standard, normalized_usd: unavailable(), standard_credits: unavailable(), extra_credits: unavailable() };
  const breakdown = reports.flatMap(report => report.breakdown.map(row => ({ ...row,
    home: row.home ? `${report.provider?.id ?? "codex"} · ${row.home}` : null })));
  const daily = new Map<string, CodexTrafficPeriod>();
  for (const row of breakdown) {
    const amount = row.normalization.standard_api_usd;
    const period = daily.get(row.day) ?? { account: scope.account ?? "all", start: `${row.day}T00:00:00.000Z`,
      end: new Date(Date.parse(row.day) + 86400000).toISOString(), start_reset: false, end_reset: false,
      events: 0, tokens: 0, fast_tokens: 0, unknown_tokens: 0, api: 0, credits: 0, priced_tokens: 0, priced_events: 0, models: {} };
    period.events += row.events; period.tokens += row.tokens; period.api += amount.priced_subtotal;
    period.priced_events += amount.priced_events; period.priced_tokens += amount.priced_tokens;
    period.fast_tokens += row.speed === "fast" ? row.tokens : 0;
    period.unknown_tokens += !["standard", "fast"].includes(row.speed) ? row.tokens : 0;
    period.models[row.model ?? "?"] = (period.models[row.model ?? "?"] ?? 0) + row.tokens;
    daily.set(row.day, period);
  }
  return {
    schema_version: 1, scope, quantity_basis: "published subscription reports", tier_evidence: "recorded", quota_verified: false,
    source: "published subscription reports", account_attribution: "dated account periods", deduplication: "shared register",
    rule_source: "shared stored valuations", events: sum("events"), tokens: sum("tokens"),
    known_speed_events: sum("known_speed_events"), known_speed_tokens: sum("known_speed_tokens"),
    unknown_speed_events: sum("unknown_speed_events"), unknown_speed_tokens: sum("unknown_speed_tokens"),
    excluded_mirror_events: sum("excluded_mirror_events"), unattributed_events: sum("unattributed_events"),
    source_home_count: new Set(breakdown.flatMap(row => row.home ? [row.home] : [])).size,
    amounts: { api_equivalent_usd: coverage(reports.map(report => report.amounts.api_equivalent_usd)), chatgpt_credits: unavailable() },
    normalization, breakdown, windows: null, traffic_periods: [...daily.values()].sort((a, b) => a.start.localeCompare(b.start)),
    // Applied rates stay for the list prices of each model; identical rules from two subscriptions are one.
    calibration: null, applied_rules: [...new Map(reports.flatMap(report => report.applied_rules).map(rule => [JSON.stringify(rule), rule])).values()], subjects: [], limitations: [...new Set(reports.flatMap(report => report.limitations))],
    model_details: reports.flatMap(report => (report.model_details ?? []).map(row => ({ ...row, source: `${report.provider?.id} · ${row.source}` }))),
    provider: { id: "all", label: "All subscriptions", credits: false, speed: reports.some(report => report.provider?.speed), counter: null, counter_reason: null },
  };
}

export async function readAllModelReports(accounts: readonly ApiAccount[], scope: SubscriptionAccountingOptions, signal?: AbortSignal) {
  const selected = modelReportAccounts(accounts), reports: CodexAccountingReport[] = [];
  for (let index = 0; index < selected.length; index += 4) {
    signal?.throwIfAborted();
    reports.push(...await Promise.all(selected.slice(index, index + 4).map(async item => {
      try { return await subscriptionAnalysisAdapter(item.provider).read({ ...scope, account: item.account, counter: undefined }, signal); }
      catch (error) { if (signal?.aborted) throw error; throw new Error(`${item.account}: ${error instanceof Error ? error.message : String(error)}`); }
    })));
  }
  return aggregateModelReports(reports, scope);
}

export async function allModelMarkers(providers: readonly string[]): Promise<TimelineMarkersResponse> {
  const results = await Promise.all(providers.map(provider => subscriptionAnalysisAdapter(provider).markers()));
  const combine = (key: "automatic" | "markers") => results.flatMap((result, index) => result[key].map(marker => ({ ...marker, id: `${providers[index]}:${marker.id}` })));
  return { revision: "", automatic: combine("automatic"), markers: combine("markers") };
}
