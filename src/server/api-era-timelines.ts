import type { Database } from "../db/sqlite";
import { cardSubscriptionActivity, readCardHistories } from "./probe-health";
import { cycleStarts } from "./probe-limit-windows";
import { LimitWindowsPreparing } from "../db/limit-windows";
import { readPreparedProbeActivity, ProbeAccountIndexUnavailable, readPreparedProbeAccountHistory } from "./current/probe-account-reader";
import type { AppContext } from "./app-context-types";
import { normPath } from "./account-scope";
import type { DayUsage } from "./subscription-usage";
import { round2 } from "./api-report-values";
import type { EraDeclaration } from "./eras";
import { subscriptionDailyUsage, isUsageProvider, SubscriptionUsageUnavailable, subscriptionUsageUnavailableResponse } from "./subscription-usage";
import { periodEras } from "./subscription-maps";
import { normEraVendor } from "./eras";
import { observedVendorAccounts } from "./account-identity";

export interface SubscriptionActivity {
  first_seen: string | null;
  last_seen: string | null;
  cycle_count: number;
}

export const EMPTY_SUBSCRIPTION_ACTIVITY: SubscriptionActivity = {
  first_seen: null,
  last_seen: null,
  cycle_count: 0,
};

/**
 * How long a subscription has been sampled (its current card's first and last reading) and how many
 * cycles it has been through: its stored limit windows of the main weekly counter (`cycleStarts`).
 */
export function subscriptionActivity(sqlite: Database): Map<string, SubscriptionActivity> {
  return cardSubscriptionActivity(readCardHistories(sqlite), storedCycles(sqlite));
}

/** An account's cycle starts; none while its windows are being prepared (the card shows no cycle count then). */
export const storedCycles = (sqlite: Database) => (provider: string, subject: string): string[] => {
  try { return cycleStarts(sqlite, provider, subject); }
  catch (error) { if (error instanceof LimitWindowsPreparing) return []; throw error; }
};

export interface EraSegmentStats {
  cycles: number;
  tokens: number;
  usd: number | null;
  calls: number;
  unpriced_calls: number;
  unpriced_tokens: number;
  usd_reason: "missing-rate-card" | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface EraSegment {
  key: string;
  subscription_id: string;
  vendor: string;
  home: string | null;
  from: string | null;
  until: string | null;
  /** false = no accounts.json entry at all, i.e. one implicit open era. */
  declared: boolean;
  vendor_account: string | null;
  vendor_account_source: "declared" | "observed" | null;
  stats: EraSegmentStats;
}

export interface SubscriptionEraTimeline {
  subscription_id: string;
  vendor: string;
  active: boolean;
  segments: EraSegment[];
}

export interface VendorAccountTimeline {
  key: string;
  vendor_account: string | null;
  source: "declared" | "observed" | null;
  lanes: SubscriptionEraTimeline[];
}

export interface EraTimelinesPayload {
  today: string;
  subscriptions: SubscriptionEraTimeline[];
  vendor_accounts: VendorAccountTimeline[];
  notes: string[];
}

interface ProbeDay {
  day: string;
  source: string | null;
  first_ts: string | null;
  last_ts: string | null;
  resets: Set<string>;
}

/**
 * Per subscription, per day: the probe span and the distinct weekly reset
 * instants seen that day. Cycles of an era segment are the distinct resets
 * across its days, which is the same rule `subscriptionActivity` uses for the
 * whole subscription — an era just narrows the day set.
 */
export function subscriptionProbeDays(ctx: AppContext): Map<string, ProbeDay[]> {
  const out = new Map<string, Map<string, ProbeDay>>();
  const bump = (id: string, source: string | null, day: string): ProbeDay => {
    const key = id.toLowerCase();
    const byDay = out.get(key) ?? new Map<string, ProbeDay>();
    const rowKey = `${day}\u0000${normPath(source ?? "")}`;
    const cur = byDay.get(rowKey) ?? {
      day,
      source,
      first_ts: null,
      last_ts: null,
      resets: new Set<string>(),
    };
    byDay.set(rowKey, cur);
    out.set(key, byDay);
    return cur;
  };
  const days = readPreparedProbeActivity(ctx.sqlite);
  if (!days) throw new ProbeAccountIndexUnavailable();
  for (const row of days) {
    const entry = bump(row.account, row.source, row.day);
    if (!entry.first_ts || row.first_ts < entry.first_ts) entry.first_ts = row.first_ts;
    if (!entry.last_ts || row.last_ts > entry.last_ts) entry.last_ts = row.last_ts;
    for (const reset of Object.keys(row.resets)) entry.resets.add(reset);
  }
  return new Map(
    [...out].map(([key, byDay]) => [key, [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))])
  );
}

/** `from` inclusive, `until` exclusive — the era convention, not a third one. */
export function dayInEra(day: string, from: string | null, until: string | null): boolean {
  if (from && day < from) return false;
  if (until && day >= until) return false;
  return true;
}

type EraSegmentSourceScope =
  | { kind: "path"; sources: string[] }
  | null;

function sourceInSegment(source: string | null, scope: EraSegmentSourceScope): boolean {
  // Every provider's register retains physical archive-source provenance.
  if (scope == null) return true;
  const { sources } = scope;
  const candidate = normPath(source ?? "");
  if (!candidate) return sources.includes("");
  return sources.some(
    (raw) => candidate === raw || candidate.startsWith(`${raw}/`) || raw.startsWith(`${candidate}/`)
  );
}

export function eraSegmentStats(
  usage: Map<string, DayUsage[]>,
  probes: Map<string, ProbeDay[]>,
  subscriptionId: string,
  from: string | null,
  until: string | null,
  sourceScope: EraSegmentSourceScope = null
): EraSegmentStats {
  const key = subscriptionId.toLowerCase();
  let tokens = 0;
  let usd = 0;
  let calls = 0;
  let unpricedCalls = 0;
  let unpricedTokens = 0;
  for (const row of usage.get(key) ?? []) {
    if (!dayInEra(row.day, from, until) || !sourceInSegment(row.source, sourceScope)) continue;
    tokens += row.tokens;
    usd += row.usd;
    calls += row.calls;
    unpricedCalls += row.unpriced_calls;
    unpricedTokens += row.unpriced_tokens;
  }
  const resets = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  for (const probe of probes.get(key) ?? []) {
    if (!dayInEra(probe.day, from, until) || !sourceInSegment(probe.source, sourceScope)) continue;
    for (const reset of probe.resets) resets.add(reset);
    if (probe.first_ts && (!first || probe.first_ts < first)) first = probe.first_ts;
    if (probe.last_ts && (!last || probe.last_ts > last)) last = probe.last_ts;
  }
  return {
    cycles: resets.size,
    tokens,
    usd: unpricedCalls > 0 ? null : round2(usd),
    calls,
    unpriced_calls: unpricedCalls,
    unpriced_tokens: unpricedTokens,
    usd_reason: unpricedCalls > 0 ? "missing-rate-card" : null,
    first_seen: first,
    last_seen: last,
  };
}

/** Keep prepared whole days; only cut-day probes need individual timestamp checks. */
function segmentProbeDays(ctx: AppContext, prepared: Map<string, ProbeDay[]>, provider: string,
  account: string, within: { from: number; until: number }): Map<string, ProbeDay[]> {
  const key = account.toLowerCase(), days = prepared.get(key) ?? [], result: ProbeDay[] = [];
  const cutDays = new Set<string>(), dayMs = 86_400_000;
  for (const row of days) {
    const start = Date.parse(row.day), earliest = start - dayMs, latest = start + 2 * dayMs;
    if (latest <= within.from || earliest >= within.until) continue;
    if (earliest >= within.from && latest <= within.until) result.push(row);
    else cutDays.add(row.day);
  }
  for (const day of cutDays) {
    const untilDay = new Date(Date.parse(day) + dayMs).toISOString().slice(0, 10);
    const selected = readPreparedProbeAccountHistory(ctx.sqlite, provider, account, day, untilDay);
    if (!selected) throw new ProbeAccountIndexUnavailable();
    const bySource = new Map<string, ProbeDay>();
    for (const row of selected.rows) {
      const instant = Date.parse(row.ts);
      if (!(within.from <= instant && instant < within.until)) continue;
      let source: string | null = null;
      try { const home = JSON.parse(String(row.extra ?? "null"))?.home; if (typeof home === "string") source = home; }
      catch { /* The prepared activity contract retains unknown source labels. */ }
      const sourceKey = normPath(source ?? "");
      const current = bySource.get(sourceKey) ?? { day, source, first_ts: null, last_ts: null, resets: new Set<string>() };
      if (!current.first_ts || instant < Date.parse(current.first_ts)) current.first_ts = row.ts;
      if (!current.last_ts || instant > Date.parse(current.last_ts)) current.last_ts = row.ts;
      if (typeof row.resets_at === "string" && (row.window_minutes === 10080
        || (row.window_minutes == null && row.kind.toLowerCase().includes("week")))) current.resets.add(row.resets_at);
      bySource.set(sourceKey, current);
    }
    result.push(...bySource.values());
  }
  return new Map([[key, result]]);
}

function sortedEraEntries(entries: EraDeclaration[]): EraDeclaration[] {
  return [...entries].sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
}

function eraSegmentSourceScope(
  entries: EraDeclaration[],
  entry: EraDeclaration
): EraSegmentSourceScope {
  if (entries.length <= 1) return null;
  const allPhysical = new Set(
    entries.flatMap((candidate) =>
      [candidate.home, candidate.source_home]
        .filter((source): source is string => Boolean(source))
        .map(normPath)
    )
  );
  const current = [entry.home, entry.source_home]
    .filter((source): source is string => Boolean(source))
    .map(normPath);
  if (allPhysical.size <= 1) current.push(normPath(entry.id), "");
  return { kind: "path", sources: [...new Set(current)] };
}

/**
 * Both halves of the same truth: per subscription its eras („kto ją zasilał"),
 * and per Konto vendora the subscriptions it carried, each as its own lane.
 * Nothing is summed across lanes or segments — a Konto vendora is a label, not
 * an aggregation axis, so every segment carries only its own numbers.
 */
export function buildEraTimelines(ctx: AppContext): EraTimelinesPayload {
  const usage = subscriptionDailyUsage(ctx);
  const probes = subscriptionProbeDays(ctx);

  const intervalUsage = new Map<string, Map<string, DayUsage[]>>();
  const declared = ctx.accounts.subscriptions || [];
  const periods = periodEras(ctx.sqlite, ctx.accounts);
  const observed = observedVendorAccounts(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const entry of declared) {
    const key = entry.id.toLowerCase();
    if (!entry.id || seenIds.has(key)) continue;
    seenIds.add(key);
    ids.push(entry.id);
  }
  const subscriptions: SubscriptionEraTimeline[] = ids.map((id) => {
    const key = id.toLowerCase();
    const entries = sortedEraEntries(periods.filter((entry) => entry.id.toLowerCase() === key));
    const metadata = declared.find(entry => entry.id.toLowerCase() === key)!;
    const observedAccount = observed.get(key) ?? null;
    const segments: EraSegment[] = entries.map((entry, index) => {
      const account = metadata.account?.trim() || null;
      const from = entry.from ?? null, until = entry.until ?? null;
      const within = { from: from ? Date.parse(from) : -Infinity, until: until ? Date.parse(until) : Infinity };
      const exact = [within.from, within.until].some(value => Number.isFinite(value) && value % 86_400_000 !== 0);
      // Segment stats read only this subscription's usage, so an exact interval reads only its account.
      const vendor = normEraVendor(entry.vendor);
      const only = isUsageProvider(vendor) ? { provider: vendor, account: id } : undefined;
      const intervalKey = `${only ? `${vendor}|${key}` : ""}|${within.from}|${within.until}`;
      if (exact && !intervalUsage.has(intervalKey)) intervalUsage.set(intervalKey, subscriptionDailyUsage(ctx, { within, ...(only ? { only } : {}) }));
      const segmentUsage = exact ? intervalUsage.get(intervalKey)! : usage;
      const segmentProbes = exact ? segmentProbeDays(ctx, probes, normEraVendor(entry.vendor), id, within) : probes;
      return {
        key: `${id}#${index}`,
        subscription_id: id,
        vendor: normEraVendor(entry.vendor),
        home: entry.source_home ?? entry.home ?? null,
        from,
        until,
        declared: true,
        vendor_account: account ?? observedAccount,
        vendor_account_source: account ? "declared" : observedAccount ? "observed" : null,
        stats: eraSegmentStats(
          segmentUsage,
          segmentProbes,
          id,
          exact || !from ? null : new Date(within.from).toISOString().slice(0, 10),
          exact || !until ? null : new Date(within.until).toISOString().slice(0, 10),
          eraSegmentSourceScope(entries, entry)
        ),
      };
    });
    return {
      subscription_id: id,
      vendor: normEraVendor(metadata.vendor),
      active: metadata.status ? metadata.status === "active" : entries.some(entry => !entry.until),
      segments,
    };
  });
  const groups = new Map<string, VendorAccountTimeline>();
  for (const timeline of subscriptions) {
    const byAccount = new Map<string, EraSegment[]>();
    for (const segment of timeline.segments) {
      const account = segment.vendor_account?.trim().toLowerCase() ?? "";
      byAccount.set(account, [...(byAccount.get(account) ?? []), segment]);
    }
    for (const [account, segments] of byAccount) {
      const groupKey = account || "nieznane";
      const source = segments.find((s) => s.vendor_account_source === "declared")
        ? "declared"
        : segments.find((s) => s.vendor_account_source === "observed")
          ? "observed"
          : null;
      const group =
        groups.get(groupKey) ??
        ({
          key: groupKey,
          vendor_account: segments.find((s) => s.vendor_account)?.vendor_account ?? null,
          source,
          lanes: [],
        } satisfies VendorAccountTimeline);
      // A declaration anywhere in the group makes the whole Konto vendora
      // declared; observation only fills a gap.
      if (source === "declared") group.source = "declared";
      group.lanes.push({
        subscription_id: timeline.subscription_id,
        vendor: timeline.vendor,
        active: timeline.active,
        segments,
      });
      groups.set(groupKey, group);
    }
  }
  return {
    today,
    subscriptions,
    vendor_accounts: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)),
    notes: [
      "Konto vendora jest etykietą, nie osią sumowania — każdy odcinek pokazuje własne liczby swojej Subskrypcji.",
      "Daty er: from włącznie, until wyłącznie (YYYY-MM-DD), tak jak w ProjectMatch.",
    ],
  };
}

export function handleEraTimelines(ctx: AppContext): Response {
  try {
    return Response.json(buildEraTimelines(ctx), {
      headers: { "X-Usage-Source": "register-v8" },
    });
  } catch (error) {
    if (!(error instanceof SubscriptionUsageUnavailable)) throw error;
    return subscriptionUsageUnavailableResponse(error);
  }
}
