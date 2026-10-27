import { useMemo } from "react";
import { usePlanCatalog } from "../../lib/use-plan-catalog";
import type { ProjectCostResponse, SubjectRow, SubjectSubscriptionSlice, SubscriptionSpend } from "../../lib/api";
import type { I18nValue } from "../../lib/i18n";
import { translate } from "../../lib/i18n";
import { subscriptionPlanHistory } from "../../lib/subscription-plan";
import { calibrationSummary, MONEY_HINT, noCalibrationLabel } from "../../lib/mixFormat";
import { convert, planUnits } from "../../lib/planUnits";
import { projectConflictHint } from "../../lib/project-coverage";
import type { RosterCard } from "../../lib/roster";
import { subscriptionColor } from "../mix";
import { subjectKey } from "./format";
import { type SplitLine, planHistoryLine, currentPlan, planPeriodsTooltip } from "./subscriptions";
import type { WhatIfRow } from "./WhatIfTable";
import { projectShares } from "./shares";

interface CostInput {
  subject: SubjectRow;
  cost: ProjectCostResponse | null;
  costLoading: boolean;
  costError: string | null;
  cards: RosterCard[];
  since?: string;
  rangeDays: number | null;
}

interface Presentation extends Pick<I18nValue, "t" | "language"> {
  nameOf: (id: string) => string;
}

/** Projects the supplied cost report; request matching and all memo dependencies stay local to this view. */
export function useProjectDrawerCost(
  { subject, cost, costLoading, costError, cards, since, rangeDays }: CostInput,
  { t, language, nameOf }: Presentation,
) {
  const isCostMatching = cost != null && (cost.since ?? null) === (since ?? null);
  const isCostFailed = costError != null && costError !== "";
  const effectiveCost = isCostMatching && !costLoading && !isCostFailed ? cost : null;
  const isCostPending = !isCostFailed && (costLoading || !isCostMatching || cost == null);
  const subjectCost = useMemo(() => {
    return effectiveCost?.subjects.find((s) => s.subject === subjectKey(subject)) ?? null;
  }, [effectiveCost, subject]);
  const billedUsd = subjectCost != null ? subjectCost.billed_usd : null;
  const billedComplete = subjectCost?.billed_complete ?? true;
  const apiUsd = subjectCost != null ? subjectCost.api_usd : null;
  const conflictHint = projectConflictHint(effectiveCost?.coverage.conflicting_usage, t);
  const hasConflictingSubjectAccount =
    billedComplete === false &&
    subjectCost != null &&
    (effectiveCost?.coverage.conflicting_usage?.accounts ?? []).some(({ account }) =>
      Object.keys(subjectCost.subscriptions).some((subId) => subId.toLowerCase() === account.toLowerCase()),
    );
  const billedTitle =
    hasConflictingSubjectAccount && conflictHint
      ? conflictHint
      : isCostFailed
        ? costError ?? t("Could not load cost", "nie udało się pobrać kosztu")
        : billedUsd == null && subjectCost != null
          ? t("Calendar cost cannot be allocated from the available plan history and usage. Details are shown for each subscription.", "Dostępna historia planów i zużycia nie pozwala przydzielić kosztu kalendarzowego. Szczegóły są przy poszczególnych abonamentach.")
          : billedComplete === false
            ? `${MONEY_HINT.billed} ${t("The known subscription total is incomplete.", "Suma znanych abonamentów. Brakuje wyceny.")}`
            : MONEY_HINT.billed;
  const subSlices = useMemo(() => {
    const entries = Object.entries(subjectCost?.subscriptions ?? {}) as Array<[string, SubjectSubscriptionSlice]>;
    const dates = new Map((effectiveCost?.subscriptions ?? []).map(subscription => [subscription.id, subscription.last_day ?? ""]));
    entries.sort(
      ([a], [b]) => (dates.get(b) ?? "").localeCompare(dates.get(a) ?? "") || a.localeCompare(b),
    );
    return entries;
  }, [subjectCost, effectiveCost]);
  const catalog = usePlanCatalog();
  const units = useMemo(() => planUnits(cards, effectiveCost?.subscriptions ?? []), [cards, effectiveCost, language, t, catalog]);
  const spendOfSub = useMemo(() => {
    const map = new Map<string, SubscriptionSpend>();
    for (const s of effectiveCost?.subscriptions ?? []) {
      map.set(s.id.toLowerCase(), s);
    }
    return map;
  }, [effectiveCost]);
  const vendorBySub = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of effectiveCost?.subscriptions ?? []) {
      if (!s.vendor) continue;
      m[s.id] = s.vendor;
      m[s.id.toLowerCase()] = s.vendor;
    }
    return m;
  }, [effectiveCost]);
  const distinctSubIds = useMemo(() => {
    const set = new Set<string>();
    for (const [subId] of subSlices) set.add(subId);
    for (const s of effectiveCost?.subscriptions ?? []) set.add(s.id);
    return Array.from(set);
  }, [subSlices, effectiveCost]);
  const leverage = billedComplete && apiUsd != null && billedUsd != null && billedUsd > 0 ? apiUsd / billedUsd : null;
  const receiptLines = useMemo<SplitLine[]>(
    () =>
      subSlices.map(([subId, slice]) => ({
        subId,
        plan: subscriptionPlanHistory(spendOfSub.get(subId.toLowerCase())),
        planHistory: planHistoryLine(spendOfSub.get(subId.toLowerCase()) ?? null),
        planTooltip: planPeriodsTooltip(spendOfSub.get(subId.toLowerCase()) ?? null),
        tokens: slice.tokens,
        color: subscriptionColor(subId),
        billedUsd: slice.billed_usd,
        billedComplete: slice.billed_complete,
        planPeriods: slice.plan_periods,
        vendor: spendOfSub.get(subId.toLowerCase())?.vendor,
        lastActivityDay: spendOfSub.get(subId.toLowerCase())?.last_day,
        billingUnavailableReasons: slice.billing_unavailable_reasons,
        costAtFullUseUsd: slice.cost_at_full_use_usd,
        apiUsd: slice.api_usd,
        equivalents: slice.equivalents,
        provenance: slice.provenance,
        seatTime: slice.seat_time,
        tokensByType: slice.tokens_by_type,
        usdByType: slice.usd_by_type,
      })),
    [subSlices, spendOfSub, vendorBySub, catalog],
  );
  const uncalibrated = useMemo(() => {
    if (receiptLines.length === 0) return null;
    const summaries = receiptLines.map((l) => calibrationSummary(l.provenance));
    if (summaries.some((s) => s.usable)) return null;
    const reasons = new Set(summaries.map((s) => s.label));
    if (reasons.size === 1 && reasons.has(translate("outside period", "poza okresem"))) {
      return t("Window capacity calibration has no day in common with this range, so conversion would transfer someone else's measurement. Narrow the range to the period in which these subscriptions were measured.", "Kalibracja pojemności okna nie ma z tym zakresem ani jednego wspólnego dnia, więc przeliczenie byłoby przeniesieniem cudzego pomiaru. Zawęź zakres do okresu, w którym te abonamenty były mierzone.");
    }
    if (reasons.size === 1 && reasons.has(noCalibrationLabel())) {
      return t("None of these plans has enough data to calculate window capacity. The vendor did not provide a counter history.", "Żaden z tych planów nie ma z czego policzyć pojemności okna. Vendor nie oddał przebiegu licznika.");
    }
    return t("Each plan has a different reason. Hover its calibration badge in the row.", "Każdy z tych planów ma inny powód. Najedź na odznakę kalibracji w jego wierszu.");
  }, [receiptLines, language, t]);
  const whatIfRows = useMemo<WhatIfRow[]>(
    () =>
      distinctSubIds.map((subId) => {
        const spend = spendOfSub.get(subId.toLowerCase()) ?? null;
        const unit = units.find((u) => u.id.toLowerCase() === subId.toLowerCase()) ?? null;
        return {
          subId,
          name: nameOf(subId),
          color: subscriptionColor(subId),
          plan: currentPlan({ plan: subscriptionPlanHistory(spend), planHistory: planHistoryLine(spend) }),
          planTooltip: planPeriodsTooltip(spend),
          unit,
          conv: unit && apiUsd != null ? convert(apiUsd, unit, rangeDays) : null,
        };
      }),
    [distinctSubIds, spendOfSub, units, nameOf, apiUsd, rangeDays, catalog],
  );
  const shares = useMemo(
    () => subjectCost ? projectShares(subjectCost, effectiveCost?.subscriptions ?? [], (count) => `${t("other", "pozostałe")} (${count})`) : null,
    [subjectCost, effectiveCost, language, t],
  );
  const subscriptionCount = !isCostPending && !isCostFailed ? subSlices.length : null;
  return {
    summary: {
      billedUsd, billedComplete, apiUsd, billedTitle, conflictHint, leverage,
      hasSubjectCost: subjectCost != null, hasConflictingSubjectAccount,
      isCostPending, isCostFailed, costError, subscriptionCount,
    },
    receipt: { lines: receiptLines, uncalibrated },
    units, vendorBySub, whatIfRows, shares,
  };
}

export type ProjectDrawerCostModel = ReturnType<typeof useProjectDrawerCost>;
