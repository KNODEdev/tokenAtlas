import type { SubscriptionSpend } from "./api";
import { planValue } from "./planValue";
import { ALL_ACCOUNT, subscriptionName, type RosterCard } from "./roster";
import { translate } from "./i18n";
import { subscriptionPlan } from "./subscription-plan";
import { displayPlanCatalog } from "./plan-catalog";
import { resolvePlanFacts } from "../../shared/plan-catalog";
export interface PlanUnit {
  id: string;
  label: string;
  color: string;
  windowValue: number | null;
  windowHours: number | null;
  usdPerMonth: number | null;
  basis: "measured" | "single" | "none";
  note: string;
}
function windowHoursOf(card: RosterCard): number | null {
  if (card.pointBasis) return card.pointBasis.windowHours;
  const cycle = card.model?.current ?? card.model?.typical?.[0] ?? card.model?.closed?.[0] ?? null;
  if (cycle && Number.isFinite(cycle.windowHours) && cycle.windowHours > 0) return cycle.windowHours;
  const claude = card.claude?.window_hours;
  if (claude != null && Number.isFinite(claude) && claude > 0) return claude;
  return null;
}
function capacityOf(
  card: RosterCard,
  spend: SubscriptionSpend | null,
): { windowValue: number | null; windowHours: number | null; basis: PlanUnit["basis"]; note: string } {
  const server = spend?.capacity?.weekly_window_value_usd ?? null;
  if (card.group !== "codex" && server != null && server > 0) {
    return {
      windowValue: server,
      windowHours: spend?.capacity?.window_hours ?? windowHoursOf(card),
      basis: spend?.provenance?.capacity ?? "single",
      note: translate("window capacity measured by the server as a sliding window", "pojemność okna zmierzona serwerowo, jako okno przesuwne"),
    };
  }
  const value = planValue(card);
  return {
    windowValue: value.windowValue,
    windowHours: windowHoursOf(card),
    basis: value.basis,
    note: value.note,
  };
}
export function planUnits(cards: RosterCard[], spend: SubscriptionSpend[]): PlanUnit[] {
  const priceOf = new Map(spend.map((s) => [s.id.toLowerCase(), s]));
  const out: PlanUnit[] = [];
  for (const card of cards) {
    if (card.id === ALL_ACCOUNT) continue;
    const s = priceOf.get(card.id.toLowerCase()) ?? null;
    const cap = capacityOf(card, s);
    const period = s?.plan_periods.findLast(period => period.plan !== null);
    const query = period?.plan ?? s?.plan?.split(" → ").at(-1) ?? card.plan ?? null;
    const provider = s?.vendor ?? card.vendor;
    const onDay = period?.until ?? new Date().toISOString().slice(0, 10);
    const plan = subscriptionPlan(provider, query, onDay);
    const catalog = displayPlanCatalog();
    const offer = catalog && query ? resolvePlanFacts(catalog, provider, query, onDay) : null;
    // A counterfactual prices the offer, never the completeness or FX of this account's historical bill.
    // Only a legacy account with no dated plan at all retains its established undated fallback (rule D).
    const monthly = offer?.plan_id != null ? offer.usd_per_month : s?.plan_periods.length === 0 ? s.usd_per_month : null;
    out.push({
      id: card.id,
      label: plan ? `${subscriptionName(card)} · ${plan}` : subscriptionName(card),
      color: card.color,
      windowValue: cap.windowValue,
      windowHours: cap.windowHours,
      usdPerMonth: monthly,
      basis: cap.basis,
      get note() {
        return capacityOf(card, s).note;
      },
    });
  }
  return out.sort((a, b) => {
    if ((a.windowValue == null) !== (b.windowValue == null)) return a.windowValue == null ? 1 : -1;
    return (b.windowValue ?? 0) - (a.windowValue ?? 0);
  });
}
export interface Converted {
  windows: number | null;
  parallel: number | null;
  usd: number | null;
}
export function convert(apiUsd: number, unit: PlanUnit | null, rangeDays: number | null): Converted {
  if (!unit || unit.windowValue == null || unit.windowValue <= 0) {
    return { windows: null, parallel: null, usd: null };
  }
  const windows = apiUsd / unit.windowValue;
  if (rangeDays == null || rangeDays <= 0 || unit.windowHours == null || unit.windowHours <= 0) {
    return { windows, parallel: null, usd: null };
  }
  const windowsAvailable = (rangeDays * 24) / unit.windowHours;
  const parallel = windowsAvailable > 0 ? windows / windowsAvailable : null;
  const usd =
    parallel != null && unit.usdPerMonth != null ? parallel * unit.usdPerMonth * (rangeDays / 30.44) : null;
  return { windows, parallel, usd };
}
