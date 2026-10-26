import type { ApiAccount } from "./api";
import type { CycleView } from "./cycle";
import type { ScreenId } from "./screens";
import { dayTime } from "./format";
import { translate } from "./i18n";

export const EVENT_VENDORS = ["all", "codex", "claude", "opencode", "gemini", "grok"] as const;
export type EventVendor = (typeof EVENT_VENDORS)[number];
export type EventOrder = "ts_desc" | "ts_asc" | "tokens_desc";

/** Usage events opened from another screen: whose events, which UTC dates and where the user came from. */
export interface EventsTarget {
  account: string;
  since: string;
  until: string;
  model?: string;
  /**
   * Exact bounds of the clicked window, `[fromTs, untilTs)` in UTC (IA-2026-10-19 v1.1, IA-30); without
   * `untilTs` the window still runs. The dates above stay as the days these instants touch.
   */
  fromTs?: string;
  untilTs?: string;
  /** The "came from" line, e.g. "History › codex1 › #69 · 12.09 14:05 → 19.09 14:05". */
  origin: string;
  returnScreen: ScreenId;
}

export interface EventFilters {
  /** A Codex or Claude subscription; the server resolves its events through the account periods. */
  account: string | null;
  /** The provider when no subscription is chosen. */
  vendor: EventVendor;
  model: string;
  project: string;
  since: string;
  until: string;
  /** Exact instants from a window; editing the dates drops them. */
  fromTs?: string;
  untilTs?: string;
  order: EventOrder;
}

const isAll = (account: string) => account === "all" || account === "__all__";

/** Only Codex and Claude events carry an account (UI audit decision 14, `/api/events?account=`). */
export function accountFilterable(vendor: string | null | undefined): boolean {
  return vendor === "codex" || vendor === "openai" || vendor === "claude" || vendor === "anthropic";
}

/** The events provider of a subscription the account filter does not cover. */
function vendorOf(vendor: string | null | undefined): EventVendor {
  if (vendor === "codex" || vendor === "openai") return "codex";
  if (vendor === "claude" || vendor === "anthropic") return "claude";
  if (vendor === "grok" || vendor === "xai") return "grok";
  if (vendor === "gemini" || vendor === "antigravity") return "gemini";
  if (vendor === "glm" || vendor === "opencode") return "opencode";
  return "all";
}

/**
 * The first filters of Usage events: the target another screen opened it with, else the header
 * subscription. A target for another subscription than the header's is stale and ignored.
 */
export function eventFiltersFor(headerAccount: string, accounts: ApiAccount[], project: string, target: EventsTarget | null): EventFilters {
  const scoped = target && target.account === headerAccount ? target : null;
  const vendor = isAll(headerAccount) ? null : accounts.find(account => account.id === headerAccount)?.vendor ?? null;
  const byAccount = !isAll(headerAccount) && accountFilterable(vendor);
  return {
    account: byAccount ? headerAccount : null,
    vendor: byAccount ? "all" : vendorOf(vendor),
    model: scoped?.model ?? "",
    project,
    since: scoped?.since ?? "",
    until: scoped?.until ?? "",
    ...(scoped?.fromTs ? { fromTs: scoped.fromTs, ...(scoped.untilTs ? { untilTs: scoped.untilTs } : {}) } : {}),
    order: "ts_desc",
  };
}

/** The `/api/events` parameters of one page; an account replaces the provider, which it implies. */
export function eventsRequest(filters: EventFilters, offset: number, limit: number) {
  return {
    ...(filters.account ? { account: filters.account } : { vendor: filters.vendor }),
    order: filters.order,
    model: filters.model || undefined,
    project_id: filters.project || undefined,
    // Exact instants replace the whole-day dates; the server refuses a mix of both.
    ...(filters.fromTs ? { from_ts: filters.fromTs, until_ts: filters.untilTs }
      : { since: filters.since || undefined, until: filters.until || undefined }),
    limit,
    offset,
  };
}

/**
 * The UTC dates covering a window from `startIso` to its exclusive end, never past today:
 * `/api/events` filters whole UTC days, so the list can include calls just outside the window.
 */
export function windowDates(startIso: string, endIso: string | null, nowMs = Date.now()): { since: string; until: string } {
  const start = Date.parse(startIso);
  const end = Math.min(endIso ? Date.parse(endIso) : nowMs, nowMs);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { since: day(start), until: day(Math.max(start, end - 1)) };
}

/** Usage events of one History window: its subscription, its exact bounds (and the UTC days they touch) and a way back. */
export function historyEventsTarget(account: string, startIso: string, endIso: string | null, label?: string): EventsTarget {
  const span = `${dayTime(startIso)} → ${endIso ? dayTime(endIso) : translate("now", "teraz")}`;
  return {
    account,
    ...windowDates(startIso, endIso),
    fromTs: startIso,
    ...(endIso ? { untilTs: endIso } : {}),
    origin: [translate("History", "Historia"), account, label ? `${label} · ${span}` : span].join(" › "),
    returnScreen: "history",
  };
}

/**
 * A closed cycle ends at its own end, exclusive; it runs to now while active. Its last work is the last counted
 * call, so using it as an exclusive end would drop that call (03 IA-29, T-11).
 */
export function cycleEventsTarget(account: string, cycle: Pick<CycleView, "number" | "startIso" | "endIso" | "isActive" | "raw">): EventsTarget {
  return historyEventsTarget(account, cycle.startIso, cycle.isActive ? null : cycle.endIso, `#${cycle.number}`);
}
