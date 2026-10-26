import type { ReactNode } from "react";
import type { AccountHistoryPoint } from "../../lib/api";
import { Card, CardTitle } from "../../components/ui";
import { Kpi as Tile, KpiRow } from "../../components/WindowStatusCard";
import { compact } from "../../lib/format";
import { useI18n } from "../../lib/i18n";
import { bucketLabel, lowerBound, type Priced, type Tinted } from "./format";
import { Legend, StackedBars } from "./StackedBars";

export function AnalyticsView({
  points,
  accounts,
  group,
  money,
  fmt,
  totals,
  granularity,
}: {
  points: AccountHistoryPoint[];
  accounts: Tinted[];
  group: string;
  money: boolean;
  fmt: (v: number) => string;
  totals: Priced & { tokens: number };
  granularity: ReactNode;
}) {
  const { t } = useI18n();
  const completeMoney = !money || points.every((p) => p.usd !== null);
  const bound = (i: number) => (money && points[i]?.usd === null ? "≥ " : "");
  const vals = points.map((p) => (money ? p.usd ?? p.priced_usd ?? 0 : p.tokens));
  const peakIdx = vals.indexOf(Math.max(...vals));
  const avg = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  const closed = vals.slice(0, -1);
  const prev = closed.length >= 2 ? closed[closed.length - 2]! : null;
  const last = closed.length >= 1 ? closed[closed.length - 1]! : null;
  const lastIdx = closed.length - 1;
  // Two lower bounds give no change; it is shown only between fully priced periods.
  const comparable = !bound(lastIdx) && !bound(lastIdx - 1);
  const delta = comparable && prev != null && last != null && prev > 0 ? (last - prev) / prev : null;
  const unitName = group === "day" ? t("day", "dzień") : group === "week" ? t("week", "tydzień") : t("month", "miesiąc");
  // Tile values are compact so they fit a quarter of the card; exact values are in the bars' tooltips.
  const tile = (v: number) => (money ? `$${compact(v)}` : compact(v));
  const totalValue = money ? totals.usd ?? totals.priced_usd ?? null : totals.tokens;
  const labels = new Map<number, string>();
  if (peakIdx >= 0) labels.set(peakIdx, lowerBound(vals[peakIdx] ?? 0, bound(peakIdx), tile));
  if (lastIdx >= 0 && last != null) labels.set(lastIdx, lowerBound(last, bound(lastIdx), tile));
  return (
    <>
      <KpiRow columns={4}>
        <Tile label={`${t("Average per", "Średnio na")} ${unitName}`} value={lowerBound(avg, completeMoney ? "" : "≥ ", tile)} visual={null}
          caption={t("{0} periods with activity", `${points.length} okresów z ruchem`, [points.length])} />
        <Tile label={t("Peak", "Szczyt")} value={lowerBound(vals[peakIdx] ?? 0, bound(peakIdx), tile)} visual={null}
          caption={points[peakIdx] ? bucketLabel(points[peakIdx]!.bucket, group) : "—"} />
        <Tile label={t("Last closed period", "Ostatni zamknięty okres")} value={lowerBound(last, bound(lastIdx), tile)} visual={null}
          caption={
            !comparable
              ? t("Partly priced, no change shown", "częściowo wycenione, bez zmiany")
              : delta == null
              ? t("Too few closed periods", "za mało zamkniętych okresów")
              : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}% ${t("vs previous", "vs poprzedni")}`
          } />
        <Tile label={money ? t("API-eq in total", "API-eq łącznie") : t("Tokens in total", "Tokeny łącznie")}
          value={lowerBound(totalValue, money && totals.usd === null ? "≥ " : "", tile)} visual={null}
          caption={money ? t("at API pricing, not an invoice", "po cenniku API, nie rachunek") : t("all indexed usage", "całe zaindeksowane zużycie")} />
      </KpiRow>
      <Card>
        <CardTitle
          title={`${t("Pace", "Tempo")}: ${money ? t("API-equivalent", "API-eq") : t("tokens", "tokeny")} ${t("per", "na")} ${unitName}`}
          help={t(
            "The line is the average for the full range. A bar above it means a heavier-than-usual period, not an exceeded limit because there is no limit here.",
            "Linia to średnia z całego zakresu. Słupek powyżej niej znaczy okres cięższy niż typowy — a nie „przekroczony limit”, bo tu żadnego limitu nie ma."
          )}
          right={granularity}
        />
        <StackedBars points={points} accounts={accounts} group={group} money={money} fmt={fmt} avg={completeMoney ? avg : undefined} labels={labels} />
        <Legend accounts={accounts} />
      </Card>
    </>
  );
}
