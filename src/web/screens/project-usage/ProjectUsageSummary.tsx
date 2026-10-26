import type { ProjectCostResponse } from "../../lib/api";
import { BUCKET_NAME } from "../../../projects/bucket";
import { HelpBlock, HelpDot } from "../../components/ui";
import { ACCENT_SOFT, Kpi, KpiRow, Stack, unit, withUnit } from "../../components/WindowStatusCard";
import { compact, full, pct, usd, workTimeLine } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { polishPlural } from "../../lib/mixFormat";
import { projectConflictHint } from "../../lib/project-coverage";
import { agentParallelism } from "./model";
import { declaredPlanCostHint, hours } from "./format";

/**
 * The period's totals, each shown once (docs/design/audit-models-events-projects-mockup.html):
 * traffic with its coverage, API-eq, declared plan cost and agent session time.
 */
export function ProjectTiles({
  totalSeconds,
  idleGap,
  days,
  cost,
  loading,
  error,
}: {
  totalSeconds: number;
  idleGap: number;
  days: number | null;
  cost: ProjectCostResponse | null;
  loading: boolean;
  error: string | null;
}) {
  const { t, locale } = useI18n();
  // Whole dollars and a small "≥" keep four tiles legible in the ~810 px card body.
  const dollars = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const totals = cost?.totals ?? null;
  const cov = cost?.coverage ?? null;
  const conflictHint = projectConflictHint(cov?.conflicting_usage, t);
  const pending = loading ? "…" : error ? t("error", "błąd") : "—";
  const coverage = totals && cov ? [
    { label: t("projects", "projekty"), value: totals.non_tmp_tokens, color: "var(--accent)" },
    { label: BUCKET_NAME, value: cov.tmp_bucket.tokens, color: ACCENT_SOFT },
    { label: t("unassigned", "nieprzypisane"), value: cov.unassigned.tokens, color: "var(--warn)" },
    { label: t("no rate", "bez stawki"), value: cov.unpriced.tokens, color: "var(--line2)" },
    { label: cov.unattributable.vendor, title: t("{0}: no working directory, so no project", `${cov.unattributable.vendor}: bez katalogu roboczego, więc bez projektu`, [cov.unattributable.vendor]), value: cov.unattributable.tokens, color: "var(--muted)" },
  ].filter((part) => part.value > 0) : [];
  const coverageSum = coverage.reduce((sum, part) => sum + part.value, 0);
  const priced = cost?.subscriptions.filter((s) => s.paid_usd != null) ?? [];
  const apiLower = !!totals && (totals.api_complete === false || (cost?.unpriced.tokens ?? 0) > 0);
  const ratio = totals && totals.paid_usd > 0 && priced.length > 0 ? totals.api_usd / totals.paid_usd : null;
  const outside = totals && totals.api_usd > 0 ? (totals.unassigned_api_usd / totals.api_usd) * 100 : null;
  const parallel = agentParallelism(totalSeconds, days);
  const sessionHours = hours(totalSeconds);
  return (
    <>
      <KpiRow columns={4}>
        <Kpi
          label={t("Traffic in range", "Ruch w zakresie")}
          value={totals ? withUnit(compact(totals.tokens)) : pending}
          visual={coverage.length ? <div className="projects-tile-stack" title={coverage.map((part) => `${"title" in part ? part.title : part.label} ${full(part.value)}`).join(" · ")}>
            <Stack parts={coverage.map((part) => ({ value: part.value, color: part.color }))} /></div> : null}
          caption={<>
            {coverage.length ? coverage.map((part) => `${part.label} ${pct((part.value / coverageSum) * 100)}`).join(" · ") : "—"}
            {totals && <>{" "}<HelpDot label={t("Traffic in range", "Ruch w zakresie")}>
              <HelpBlock>{conflictHint
                ? t("Accepted traffic subtotal in the period, including the bucket:", "Suma potwierdzonego ruchu w okresie, także worek:")
                : t("All recorded traffic in the period, including the bucket:", "Całość zarejestrowanego ruchu w okresie, także worek:")} {full(totals.tokens)} {t("tokens", "tokenów")}.</HelpBlock>
              {conflictHint && <HelpBlock>{conflictHint}</HelpBlock>}
            </HelpDot></>}
          </>}
        />
        <Kpi
          label="API-eq"
          value={totals ? <>{apiLower && unit("≥ ")}{dollars.format(totals.api_usd)}</> : pending}
          visual={null}
          caption={totals ? <>
            {ratio != null ? `≈ ${ratio < 10 ? ratio.toFixed(1) : ratio.toFixed(0)}× ${t("the plan cost", "kosztu planów")}` : t("at API rates, not a bill", "po cenniku API, nie rachunek")}
            {outside != null && outside > 0 && ` · ${pct(outside, 1)} ${t("outside projects", "poza projektami")}`}
            {" "}<HelpDot label="API-eq">{t(
              "What this traffic would cost at API rates without a subscription ({0}); not the amount paid.{1}",
              `Ile ten ruch kosztowałby po cenniku API bez abonamentu (${usd(totals.api_usd)}); to nie jest kwota zapłacona.${apiLower ? " ≥: część ruchu nie ma stawki." : ""}`, [usd(totals.api_usd), apiLower ? " ≥: part of the traffic has no rate." : ""],
            )}</HelpDot>
          </> : error ? t("cost could not be loaded", "nie udało się pobrać kosztu") : "—"}
        />
        <Kpi
          label={t("Plan cost · declared", "Koszt planów · deklaracja")}
          value={totals ? (priced.length ? dollars.format(totals.paid_usd) : t("cost unavailable", "brak kosztu")) : pending}
          visual={null}
          caption={totals && cost ? <>
            {priced.length ? `${dollars.format(totals.billed_usd)} ${t("in projects", "w projektach")} · ${dollars.format(totals.unassigned_billed_usd)} ${t("unassigned", "bez przypisania")} · ` : ""}
            {priced.length}/{cost.subscriptions.length} {t("with a price", "z ceną")}
            {" "}<HelpDot label={t("Plan cost · declared", "Koszt planów · deklaracja")}>{declaredPlanCostHint(t)}</HelpDot>
          </> : "—"}
        />
        <Kpi
          label={t("Agent session time", "Czas sesji agentów")}
          value={<>{unit("≈ ")}{full(sessionHours)}{unit(" h")}</>}
          visual={null}
          caption={<>
            {parallel != null && days != null ? `≈ ${parallel.toFixed(1)} ${t("sessions in parallel over", "sesji równolegle przez")} ${days} ${t(days === 1 ? "day" : "days", polishPlural(days, "dzień", "dni", "dni"))} · ` : ""}
            {t("threshold", "próg")} {idleGap} min{" "}
            <HelpDot label={t("Agent session time", "Czas sesji agentów")}>{t(
              "Summed session time of every project in the range at the idle threshold of {0} min. Sessions running in parallel add up, so this is not working time. {1}",
              `Suma czasu sesji wszystkich projektów w zakresie przy progu bezczynności ${idleGap} min. Sesje równoległe się sumują, więc to nie jest czas pracy. ${workTimeLine(sessionHours) ?? ""}`, [idleGap, workTimeLine(sessionHours) ?? ""],
            )}</HelpDot>
          </>}
        />
      </KpiRow>
      {error && (
        <div className="projects-warn">
          {t("Cost could not be calculated:", "Koszt się nie policzył:")} {error}. {t("Token and time columns are independent and remain accurate.", "Kolumny tokenów i czasu są niezależne i pozostają prawdziwe.")}
        </div>
      )}
    </>
  );
}
/** How the amounts are counted: the explanations that used to repeat the totals under the tiles and the ranking. */
export function HowWeCount({ cost }: { cost: ProjectCostResponse | null }) {
  const { t } = useI18n();
  const unpricedSubs = cost?.subscriptions.filter((s) => s.paid_usd == null).map((s) => s.id) ?? [];
  const conflictHint = projectConflictHint(cost?.coverage.conflicting_usage, t);
  return (
    <HelpDot label={t("How we count", "Jak liczymy")}>
      <HelpBlock>{t("The bar is the API-eq, coloured by subscription. Click a row for details; tick several rows to merge them into one project.", "Pasek to API-eq w kolorach subskrypcji. Kliknij wiersz, aby otworzyć szczegóły; zaznacz kilka, aby scalić je w jeden projekt.")}</HelpBlock>
      <HelpBlock>{t("API-eq: what the same traffic would cost at API rates without a subscription. It is not the amount paid.", "API-eq: ile ten sam ruch kosztowałby po cenniku API bez abonamentu. To nie jest kwota zapłacona.")}</HelpBlock>
      <HelpBlock>{t("Plan-cost share: the declared, prorated plan cost assigned to the project. It is calculated separately in each subscription and summed afterwards; otherwise a project on a more expensive subscription would look cheaper.", "Udział w koszcie: przypisana projektowi część deklarowanego, proporcjonalnego kosztu planów. Liczona osobno w każdej subskrypcji i dopiero potem sumowana; inaczej projekt na droższym abonamencie wychodziłby tańszy.")} {declaredPlanCostHint(t)}</HelpBlock>
      {unpricedSubs.length > 0 && <HelpBlock>{t("Calendar cost unavailable:", "Koszt kalendarzowy nieustalony:")} {unpricedSubs.join(", ")}. {t("Their traffic counts toward API-eq, not toward plan cost.", "Ich ruch liczy się do API-eq, nie do kosztu planów.")}</HelpBlock>}
      <HelpBlock>{t("The {0} bucket is outside the ranking but included in the tiles.", `Worek ${BUCKET_NAME} jest poza rankingiem, ale wchodzi do kafli.`, [BUCKET_NAME])}</HelpBlock>
      {!!cost?.unpriced.tokens && <HelpBlock>{compact(cost.unpriced.tokens)} {t("tokens without a rate in the price list are included in no amount.", "tokenów bez stawki w cenniku nie wchodzi do żadnej kwoty.")}</HelpBlock>}
      {conflictHint && <HelpBlock>{conflictHint}</HelpBlock>}
    </HelpDot>
  );
}
