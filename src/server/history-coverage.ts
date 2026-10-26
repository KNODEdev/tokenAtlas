import { queryRows } from "./data-groups";
import { codexReadingEvidenceSql } from "../db/codex-ledger-canonical";
import type { Database } from "bun:sqlite";
import { readPreparedProbeCoverage, ProbeAccountIndexUnavailable, ProbeAccountReadLimitExceeded } from "./current/probe-account-reader";
import { codexAccountSelector, type CodexAccountSelector } from "./codex-source-account";
import { resolvePlanVersion, type PlansCatalog } from "./plans-catalog";
import { capacityRegimesFor, catalogPlanPrice, type PlansConfig } from "./plans";
import { periodInstant, planPeriodIndex, type PeriodIndex } from "./account-periods";
import { loadPeriods, PLAN_PERIODS } from "../db/period-store";
import { NO_PLAN } from "../shared/period-end";
import { subscriptionDailyUsage, subscriptionUsageUnavailableResponse, SubscriptionUsageUnavailable,
  type SubscriptionUsageContext } from "./subscription-usage";

type GaugeBasis = "vendor-history" | "probe-history" | "none";
type CoverageAction =
  | "declare-plan-history"
  | "review-observed-plan-history"
  | "confirm-capacity-regimes"
  | "collect-reset-anchors"
  | "start-gauge-collection";

interface SubscriptionDeclaration {
  id: string;
  vendor?: string;
}

export interface HistoryCoverageContext extends SubscriptionUsageContext {
  accounts: { subscriptions?: SubscriptionDeclaration[] };
  plans: PlansConfig;
  plansCatalog: PlansCatalog;
}

export interface HistoryCoverageRow {
  subscription: string;
  vendor: string;
  usage: {
    first_day: string | null;
    last_day: string | null;
    active_days: number;
    calls: number;
    tokens: number;
  };
  gauge: {
    basis: GaugeBasis;
    first_at: string | null;
    last_at: string | null;
    samples: number;
    reset_samples: number;
    plan_samples: number;
    actual_fill_available_from: string | null;
    history_before_first_gauge: "unknown" | "none" | "not-applicable";
    gap_days: number;
    utilization_semantics: "observed-lower-bound" | "unavailable";
  };
  plan_history: {
    status: "covered" | "partial" | "missing" | "not-applicable";
    /** Effective plan periods of the account (declared and observed). */
    plan_periods: number;
    uncovered_usage_days: number;
    uncovered_ranges: Array<{ since: string; until: string; days: number }>;
  };
  capacity_history: {
    declared_regimes: number;
    status: "explicit" | "ordinary-1x-assumed";
    assumption: string | null;
  };
  normalized_trend: {
    available: boolean;
    reason: "no-gauge" | "reset-history-missing" | "plan-history-missing" | null;
  };
  actions: CoverageAction[];
}

export interface HistoryCoverageResponse {
  generated_at: string;
  subscriptions: HistoryCoverageRow[];
}

interface GaugeSummary {
  basis: GaugeBasis;
  first_at: string | null;
  last_at: string | null;
  samples: number;
  reset_samples: number;
  plan_samples: number;
}

function normalizeVendor(value: string | undefined): string {
  const vendor = value?.trim().toLowerCase() ?? "";
  if (vendor === "openai") return "codex";
  if (vendor === "anthropic") return "claude";
  if (vendor === "xai") return "grok";
  if (vendor === "google") return "gemini";
  return vendor;
}

function columnExists(sqlite: Database, table: string, column: string): boolean {
  try {
    return (sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
      (candidate) => candidate.name === column,
    );
  } catch {
    return false;
  }
}

function emptyGauge(): GaugeSummary {
  return { basis: "none", first_at: null, last_at: null, samples: 0, reset_samples: 0, plan_samples: 0 };
}

function asGaugeSummary(row: Record<string, string | number | null> | null, basis: GaugeBasis): GaugeSummary {
  const samples = Number(row?.samples ?? 0);
  if (!(samples > 0)) return emptyGauge();
  return {
    basis,
    first_at: row?.first_at == null ? null : String(row.first_at),
    last_at: row?.last_at == null ? null : String(row.last_at),
    samples,
    reset_samples: Number(row?.reset_samples ?? 0),
    plan_samples: Number(row?.plan_samples ?? 0),
  };
}

function codexGauge(sqlite: Database, selector: CodexAccountSelector, subscription: string): GaugeSummary {
  try {
    const planExpression = columnExists(sqlite, "ratelimit", "plan_type")
      ? "SUM(CASE WHEN r.plan_type IS NOT NULL AND trim(r.plan_type) <> '' THEN 1 ELSE 0 END)"
      : "0";
    // The weekly counter of the account's sources during its periods.
    const owned = selector.ownedBy(subscription, { alias: "r" });
    const row = queryRows<Record<string, string | number | null>>(sqlite, `SELECT MIN(r.ts) AS first_at, MAX(r.ts) AS last_at, COUNT(*) AS samples,
            SUM(CASE WHEN r.resets_at IS NOT NULL AND trim(CAST(r.resets_at AS TEXT)) <> '' THEN 1 ELSE 0 END)
              AS reset_samples,
            ${planExpression} AS plan_samples
       FROM ratelimit r
      WHERE r.used_percent IS NOT NULL AND r.window_minutes = 10080 AND r.limit_id = 'codex' AND ${owned.sql}
        AND ${codexReadingEvidenceSql(sqlite, "r")}`, owned.params)[0] ?? null;
    return asGaugeSummary(row, "vendor-history");
  } catch {
    return emptyGauge();
  }
}

function probeGauge(sqlite: Database, subscription: string, provider: string): GaugeSummary {
  const row = readPreparedProbeCoverage(sqlite, provider, subscription);
  if (!row) throw new ProbeAccountIndexUnavailable();
  return asGaugeSummary({ ...row }, "probe-history");
}

function gaugeSummary(sqlite: Database, codex: () => CodexAccountSelector, subscription: string, vendor: string): GaugeSummary {
  if (vendor === "codex") {
    const native = codexGauge(sqlite, codex(), subscription);
    if (native.samples > 0) return native;
  }
  return probeGauge(sqlite, subscription, vendor);
}

/**
 * A usage day has plan history when the account's plan periods name, through the whole UTC day,
 * a catalog plan with a version for that day. A plan change inside the day is checked on both sides.
 */
function planDayCovered(
  index: PeriodIndex | null,
  catalog: PlansCatalog,
  vendor: string,
  subscription: string,
  day: string,
): boolean {
  const periods = index?.periodsOf(vendor, subscription) ?? [];
  if (!index || periods.length === 0) return false;
  const start = Date.parse(`${day}T00:00:00.000Z`), end = start + 86_400_000;
  const instants = [start, ...periods.flatMap((period) => [period.from, period.until])
    .filter((edge): edge is string => edge !== null).map((edge) => periodInstant(edge, "plan period edge"))
    .filter((at) => at > start && at < end)];
  return instants.every((at) => {
    const plan = index.resolve(vendor, subscription, new Date(at).toISOString()).value;
    const match = plan === null ? null : catalogPlanPrice(catalog, vendor, plan, day);
    // A declared "no subscription" is a known plan with a known ($0) price, not a gap.
    return match !== null && (match.plan_id === NO_PLAN || resolvePlanVersion(catalog, vendor, match.plan_id, day).kind === "ok");
  });
}

function dayDistance(from: string, until: string): number {
  const distance = Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(distance) && distance > 0 ? Math.floor(distance / 86_400_000) : 0;
}

function uncoveredRanges(days: string[]): Array<{ since: string; until: string; days: number }> {
  const ranges: Array<{ since: string; until: string; days: number }> = [];
  for (const day of days) {
    const last = ranges.at(-1);
    if (last && dayDistance(last.until, day) === 1) { last.until = day; last.days++; }
    else ranges.push({ since: day, until: day, days: 1 });
  }
  return ranges;
}

export function buildHistoryCoverage(
  ctx: HistoryCoverageContext,
  options: { subscription?: string | null; now?: string } = {},
): HistoryCoverageResponse {
  const requested = options.subscription?.trim().toLowerCase() ?? null;
  // Coverage needs dates and quantities, not a full historical price calculation.
  const usageBySubscription = subscriptionDailyUsage(ctx, { price: false });
  let selector: CodexAccountSelector | null = null;
  const codex = () => selector ??= codexAccountSelector(ctx);
  // Plan history lives in the account periods only; an unreadable table leaves every day uncovered.
  let planIndex: PeriodIndex | null = null;
  try { planIndex = planPeriodIndex(loadPeriods(ctx.sqlite, PLAN_PERIODS)); }
  catch (error) { console.warn("[history-coverage] plan periods unreadable:", error instanceof Error ? error.message : error); }
  const declarations = new Map<string, SubscriptionDeclaration>();
  for (const subscription of ctx.accounts.subscriptions ?? []) {
    const key = subscription.id.trim().toLowerCase();
    if (!declarations.has(key) || (!declarations.get(key)?.vendor && subscription.vendor)) declarations.set(key, subscription);
  }
  const subscriptions = [...declarations.values()]
    .filter((subscription) => !requested || subscription.id.trim().toLowerCase() === requested)
    .map((subscription): HistoryCoverageRow => {
      const id = subscription.id.trim();
      const vendor = normalizeVendor(subscription.vendor);
      const usageRows = usageBySubscription.get(id.toLowerCase()) ?? [];
      const usageDays = [...new Set(usageRows.map((row) => row.day))].sort();
      const firstUsage = usageDays[0] ?? null;
      const lastUsage = usageDays.at(-1) ?? null;
      const gauge = gaugeSummary(ctx.sqlite, codex, id, vendor);
      const firstGaugeDay = gauge.first_at?.slice(0, 10) ?? null;
      const historyBeforeGauge = firstUsage == null
        ? "not-applicable" as const
        : firstGaugeDay != null && firstGaugeDay <= firstUsage
          ? "none" as const
          : "unknown" as const;
      const planPeriods = planIndex?.periodsOf(vendor, id).length ?? 0;
      const uncoveredDays = usageDays.filter(
        (day) => !planDayCovered(planIndex, ctx.plansCatalog, vendor, id, day),
      );
      const uncoveredUsageDays = uncoveredDays.length;
      const planStatus = usageDays.length === 0
        ? "not-applicable" as const
        : uncoveredUsageDays === 0
          ? "covered" as const
          : uncoveredUsageDays === usageDays.length
            ? "missing" as const
            : "partial" as const;
      const regimes = capacityRegimesFor(ctx.plans, id);
      const actions: CoverageAction[] = [];
      if (usageDays.length > 0 && gauge.samples === 0) actions.push("start-gauge-collection");
      if (gauge.samples > 0 && gauge.reset_samples === 0) actions.push("collect-reset-anchors");
      if (planStatus === "missing" || planStatus === "partial") {
        actions.push(gauge.plan_samples > 0 ? "review-observed-plan-history" : "declare-plan-history");
      }
      if (usageDays.length > 0 && regimes.length === 0) actions.push("confirm-capacity-regimes");
      const normalizedAvailable = gauge.reset_samples > 0 && planStatus === "covered";
      return {
        subscription: id,
        vendor,
        usage: {
          first_day: firstUsage,
          last_day: lastUsage,
          active_days: usageDays.length,
          calls: usageRows.reduce((sum, row) => sum + row.calls, 0),
          tokens: usageRows.reduce((sum, row) => sum + row.tokens, 0),
        },
        gauge: {
          ...gauge,
          actual_fill_available_from: gauge.first_at,
          history_before_first_gauge: historyBeforeGauge,
          gap_days: firstUsage == null
            ? 0
            : firstGaugeDay == null
              ? dayDistance(firstUsage, lastUsage ?? firstUsage) + 1
              : firstGaugeDay > firstUsage
                ? dayDistance(firstUsage, firstGaugeDay)
                : 0,
          utilization_semantics: gauge.reset_samples > 0 ? "observed-lower-bound" : "unavailable",
        },
        plan_history: {
          status: planStatus,
          plan_periods: planPeriods,
          uncovered_usage_days: uncoveredUsageDays,
          uncovered_ranges: uncoveredRanges(uncoveredDays),
        },
        capacity_history: {
          declared_regimes: regimes.length,
          status: regimes.length > 0 ? "explicit" : "ordinary-1x-assumed",
          assumption: regimes.length > 0
            ? null
            : "No dated exception is declared; normalization assumes ordinary 1x capacity.",
        },
        normalized_trend: {
          available: normalizedAvailable,
          reason: normalizedAvailable
            ? null
            : gauge.samples === 0
              ? "no-gauge"
              : gauge.reset_samples === 0
                ? "reset-history-missing"
                : "plan-history-missing",
        },
        actions,
      };
    });
  return {
    generated_at: options.now ?? new Date().toISOString(),
    subscriptions,
  };
}

export function handleHistoryCoverage(ctx: HistoryCoverageContext, url: URL): Response {
  const requested = url.searchParams.get("subscription")?.trim() ?? null;
  if (requested && !(ctx.accounts.subscriptions ?? []).some(
    (subscription) => subscription.id.trim().toLowerCase() === requested.toLowerCase(),
  )) {
    return Response.json({ error: `subscription '${requested}' not found` }, { status: 404 });
  }
  try {
    return Response.json(buildHistoryCoverage(ctx, { subscription: requested }));
  } catch (error) {
    if (error instanceof ProbeAccountIndexUnavailable) throw error;
    if (error instanceof ProbeAccountReadLimitExceeded)
      return Response.json({ error: error.code }, { status: 503 });
    if (!(error instanceof SubscriptionUsageUnavailable)) throw error;
    return subscriptionUsageUnavailableResponse(error);
  }
}
