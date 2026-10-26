import type { SubjectRow } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { compact, duration, full, workTimeLine, WORKDAY_HOURS } from "../../lib/format";
import { formatMoney, MONEY_HINT } from "../../lib/mixFormat";
import { EstimateTag, KpiStrip } from "../ui";
import { hours, localizedPlural } from "./format";
import { QuestionSection } from "./presentation";
import type { ProjectDrawerCostModel } from "./drawer-cost-model";

export function ProjectCostSummary({ subject, since, idleGap, time, cost }: {
  subject: SubjectRow;
  since?: string;
  idleGap: number;
  time: { activeSeconds: number | null; error: string | null };
  cost: ProjectDrawerCostModel["summary"];
}) {
  const { t } = useI18n();
  const { activeSeconds, error: historyError } = time;
  const { billedUsd, billedComplete, apiUsd, billedTitle, conflictHint, leverage,
    hasSubjectCost, hasConflictingSubjectAccount, isCostPending, isCostFailed, costError, subscriptionCount } = cost;
  const summedSeconds = subject.session_seconds ?? subject.active_seconds;
  // The label follows the preset's start date, not the recorded range span.
  const sinceDays = since ? Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(since)) / 86_400_000) : null;
  const rangeLabel = since
    ? sinceDays != null && Number.isFinite(sinceDays) && sinceDays > 0
      ? t(sinceDays === 1 ? "Last day" : "Last {0} days", sinceDays === 1 ? "Ostatni dzień" : `Ostatnie ${sinceDays} dni`, [sinceDays])
      : t("Since {0}", `Od ${since}`, [since])
    : t("All time", "Cały okres");
  const summarySentence = `${rangeLabel}: ${activeSeconds != null ? `${duration(hours(activeSeconds))} ${t("of work", "pracy")}, ` : ""}${compact(subject.tokens)} ${t("tokens", "tokenów")}${
    subscriptionCount ? ` ${t("across", "na")} ${subscriptionCount} ${localizedPlural(subscriptionCount, "subscription", "subscriptions", "subskrypcji", "subskrypcjach", "subskrypcjach")}` : ""
  }.`;
  return (
    <QuestionSection first data="cost" title={t("How much did this project cost?", "Ile kosztował ten projekt?")}>
      <div data-summary="" style={{ fontSize: "var(--fs-5)", color: "var(--muted)", lineHeight: 1.5 }}>
        {summarySentence}
      </div>
      <KpiStrip
        items={[
          {
            label: t("Cost from your subscriptions", "Koszt z Twoich abonamentów"),
            title: billedTitle,
            absent: billedUsd == null,
            value: (
              <span data-main-figure="">
                {billedUsd != null ? formatMoney(billedUsd) : isCostFailed ? t("error", "błąd") : isCostPending ? "…" : "—"}
              </span>
            ),
            note:
              hasSubjectCost && billedComplete === false ? (
                <>
                  {billedUsd != null ? (
                    <span data-billed-incomplete="" style={{ color: "var(--warn)" }}>{t("incomplete", "niepełne")}</span>
                  ) : (
                    <span data-billed-unavailable="">{t("unavailable", "niedostępne")}</span>
                  )}
                  {" · "}
                  {hasConflictingSubjectAccount
                    ? t("allocation unavailable: conflicting usage", "podział niedostępny: sprzeczne dane użycia")
                    : billedUsd != null
                      ? t("known subscription total is incomplete", "suma znanych abonamentów - brakuje wyceny")
                      : t("no subscription has a declared price", "żaden abonament nie ma zadeklarowanej ceny")}
                </>
              ) : undefined,
          },
          {
            label: t("Value at API prices", "Wartość wg cennika API"),
            title: `${isCostFailed ? costError ?? t("Could not load cost", "nie udało się pobrać kosztu") : MONEY_HINT.api}${conflictHint ? ` ${conflictHint}` : ""}`,
            absent: apiUsd == null,
            value: apiUsd != null ? formatMoney(apiUsd) : isCostFailed ? t("error", "błąd") : isCostPending ? "…" : "—",
            note:
              leverage != null
                ? `= ${leverage.toFixed(0)}× ${t("what you paid", "tego, co zapłacono")}`
                : t("at API rates, without a subscription", "po cenniku API, bez abonamentu"),
          },
          {
            label: t("Active time", "Czas aktywny"),
            title: t("Estimated wall-clock active time with an idle threshold of {0} min: the gaps between calls, each capped by the threshold, with sessions running at the same time on one computer counted once; the computers add up. Sessions summed: each session's time added separately. A workday is counted as {1} h.", `Szacowany czas aktywny wg zegara przy progu bezczynności ${idleGap} min: przerwy między wywołaniami, każda przycięta progiem, a sesje działające naraz na jednym komputerze liczone raz; komputery się sumują. Suma sesji: czas każdej sesji dodany osobno. Dzień roboczy liczony jako ${WORKDAY_HOURS} h.`, [idleGap, WORKDAY_HOURS]),
            value: activeSeconds != null ? `≈ ${duration(hours(activeSeconds))}` : historyError ? "—" : "…",
            note: (
              <>
                {activeSeconds != null && <>{workTimeLine(hours(activeSeconds))}{" · "}</>}
                <span data-summed-sessions>{t("sessions summed", "suma sesji")} ≈ {duration(hours(summedSeconds))}</span>{" "}
                <EstimateTag title={`${t("Idle threshold", "Próg bezczynności")}: ${idleGap} min`}>{t("threshold", "próg")} {idleGap}m</EstimateTag>
              </>
            ),
          },
          {
            label: t("Traffic", "Ruch"),
            title: `${full(subject.tokens)} ${localizedPlural(subject.tokens, "token", "tokens", "token", "tokeny", "tokenów")}`,
            value: `${compact(subject.tokens)} ${t("tokens", "tok")}`,
            note: `${full(subject.calls)} ${localizedPlural(subject.calls, "call", "calls", "wywołanie", "wywołania", "wywołań")}`,
          },
        ]}
      />
    </QuestionSection>
  );
}
