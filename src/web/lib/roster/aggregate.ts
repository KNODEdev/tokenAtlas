import { translate } from "../i18n";
import { subscriptionCountLabel, paceColorOf, localizedNumber } from "./presentation";
import type { RosterCard, RosterGroup } from "./types";

export const ALL_ACCOUNT = "__all__";
export function selectedAccountId(requested: string, available: readonly string[]): string {
  return requested === ALL_ACCOUNT || available.includes(requested)
    ? requested : available[0] ?? requested;
}
function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((n): n is number => n != null && Number.isFinite(n));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function sum(xs: (number | null)[]): number | null {
  const v = xs.filter((n): n is number => n != null && Number.isFinite(n));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) : null;
}
/**
 * The portfolio row. Inactive subscriptions are deliberately absent: a closed
 * subscription has no live window, so averaging it in would dilute the percent
 * with a denominator that no longer exists (TALK-004 — ALL·portfel = active only).
 */
export function buildAllCard(cards: RosterCard[]): RosterCard {
  const real = cards.filter((c) => c.id !== ALL_ACCOUNT && c.active);
  const withData = real.filter((c) => c.usedPercent != null);
  const usedPercent = mean(withData.map((c) => c.usedPercent));
  const elapsedPercent = mean(withData.map((c) => c.elapsedPercent));
  const ppAhead = usedPercent != null && elapsedPercent != null ? usedPercent - elapsedPercent : null;
  const paceRatio =
    usedPercent != null && elapsedPercent != null && elapsedPercent > 1 ? usedPercent / elapsedPercent : null;
  const resets = real.map((c) => c.remainingHours).filter((h): h is number => h != null);
  const soonest = resets.length > 0 ? Math.min(...resets) : null;
  const soonestCard = soonest != null ? real.find((c) => c.remainingHours === soonest) ?? null : null;
  const spentCount = real.filter((c) => c.spent).length;
  return {
    id: ALL_ACCOUNT,
    vendor: "all",
    plan: subscriptionCountLabel(real.length),
    color: "var(--violet)",
    basis: "inferred",
    percentMeasured: false,
    probe: null,
    percentFromProbe: false,
    estimatePercent: null,
    second: null,
    live: null,
    spent: spentCount > 0 && spentCount === real.length,
    usedPercent,
    elapsedPercent,
    ppAhead,
    paceRatio,
    paceColor: paceColorOf(ppAhead),
    projectedEndPercent: mean(real.map((c) => c.projectedEndPercent)),
    remainingHours: soonest,
    resetIso: soonestCard?.resetIso ?? null,
    tokensTotal: sum(real.map((c) => c.tokensTotal)),
    tokensFresh: sum(real.map((c) => c.tokensFresh)),
    allowanceTokens: null,
    usd: sum(real.map((c) => c.usd)),
    unpricedModels: real.flatMap((c) => c.unpricedModels),
    usdAt100: sum(real.map((c) => c.usdAt100)),
    remainingUsd: sum(real.map((c) => c.remainingUsd)),
    calls: sum(real.map((c) => c.calls)),
    health: null,
    healthColor: "var(--violet)",
    confidence: "none",
    note:
      spentCount > 0
        ? translate("{0} exhausted", `${localizedNumber(spentCount)} wyczerpanych`, [localizedNumber(spentCount)])
        : translate(
            "nearest reset: {0}",
            `najbliższy reset: ${soonestCard?.id ?? "—"}`, [soonestCard?.id ?? "—"],
          ),
    noteLong: translate(
      "Aggregate row, not an account. The percentage is the AVERAGE of windows. Percentages from different subscriptions do not add up. Dollars and calls add up cleanly (API-eq prices the same work for every vendor); gross tokens do not, because Codex counts cache reads inside input while Claude counts them separately.",
      "Wiersz zbiorczy, nie konto. Procent to ŚREDNIA z okien — procenty różnych subskrypcji się nie sumują. " +
        "Dolary i wywołania sumują się uczciwie (API-eq wycenia to samo u każdego vendora); tokeny brutto nie, " +
        "bo Codex liczy odczyty cache wewnątrz inputu, a Claude osobno.",
    ),
    emptyReason:
      withData.length === 0
        ? translate("no subscription has data in this window", "żadna subskrypcja nie ma danych w tym oknie")
        : null,
    cycleLabel: translate("all windows", "wszystkie okna"),
    group: "all",
    windowLabel: null,
    shadow: null,
    model: null,
    claude: null,
    gemini: null,
    grok: null,
    glm: null,
    active: true,
    vendorAccount: null,
    vendorAccountObserved: false,
    firstSeen: null,
    lastSeen: null,
    cycleCount: 0,
  };
}
const GROUP_ORDER = ["all", "codex", "claude", "gemini", "glm", "grok"];
/**
 * A vendor section survives on inactive subscriptions alone — history must stay
 * reachable from the rail even after the last live subscription of a vendor closes.
 */
export function groupRoster(cards: RosterCard[]): RosterGroup[] {
  const by = new Map<string, RosterCard[]>();
  for (const c of cards) {
    const list = by.get(c.group) ?? [];
    list.push(c);
    by.set(c.group, list);
  }
  const keys = [...by.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((k) => {
    const all = by.get(k)!;
    return {
      key: k,
      label: k === "all" ? translate("Portfolio", "Portfel") : k,
      active: all.filter((c) => c.active),
      inactive: all.filter((c) => !c.active),
    };
  });
}
