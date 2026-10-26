import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import { useWidth } from "../WindowStatusCard";
import { EmptyState, Tabs } from "../ui";
import { CaptureControls, ChartHead } from "./presentation";
import { useProjectMixModel, type MixChartData } from "./mix-chart-model";
import { ProjectMixPlot } from "./ProjectMixPlot";
import { ProjectMixHover, ProjectMixLegend } from "./ProjectMixDetails";

interface ProjectMixChartProps extends MixChartData {
  initialUnit?: "usd" | "pct";
  colorOf: (subId: string) => string;
  nameOf?: (id: string) => string;
  idleGap: number;
  hideValues?: boolean;
  fileName: string;
  /** Shown in the card (and its PNG) beside the explanation dot. */
  title?: string;
}

export function ProjectMixChart({
  title,
  points,
  totalsBySub,
  vendorCoverage = [],
  vendorBySub = {},
  granularity,
  colorOf,
  nameOf = id => id,
  idleGap,
  hideValues = false,
  fileName,
  units = [],
  initialUnit = "usd",
}: ProjectMixChartProps) {
  const { t, locale } = useI18n();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [unitMode, setUnitMode] = useState<"usd" | "pct">(initialUnit);
  const [cardRef, chartWidth] = useWidth(1000);
  const model = useProjectMixModel(
    { points, totalsBySub, units, vendorCoverage, vendorBySub, granularity },
    { unitMode, chartWidth, hoverIdx, hideValues, idleGap, nameOf, t, locale },
  );
  if (!model) return <div ref={cardRef}><EmptyState title={t("No data in this range", "Brak danych w tym zakresie")} /></div>;
  const { heading, axis: { dateLabels, keptDates }, plot, hover, legend } = model;
  const { pctMode, shownTitle, measureLabel } = heading;
  return (
    <div
      ref={cardRef}
      style={{
        background: "var(--surface)",
        padding: "var(--s-2) 0 var(--s-3)",
      }}
    >
      <ChartHead
        title={title ? shownTitle : title}
        help={
          pctMode
            ? t(
                "Bars: each subscription's spend at API prices in the period as a percent of ONE full window of its own plan, side by side - limits differ, so the bars are not summed. Dashed line: 100% = one full window. A dimmed bar rests on a single reading; a subscription with no measured window has no bar. Line: active time ≈ (threshold {0}m) - its own scale.",
                `Słupki: wydatek każdej subskrypcji wg cennika API w okresie jako procent JEDNEGO pełnego okna jej planu, obok siebie - limity są różne, więc słupków się nie sumuje. Przerywana linia: 100% = jedno pełne okno. Przygaszony słupek opiera się na jednym odczycie; subskrypcja bez zmierzonego okna nie ma słupka. Linia: czas aktywny ≈ (próg ${idleGap}m) — własna skala.`, [idleGap],
              )
            : t(
                "Bars: $ split by subscription ({0}). Dots: period before subscription data collection - this is not zero usage. Line: active time ≈ (threshold {1}m) - its own scale shows work shape over time.",
                `Słupki: $ z podziałem na subskrypcje (${measureLabel}). Kropkowanie: okres przed zbieraniem danych abonamentu — to nie jest zerowe zużycie. Linia: czas aktywny ≈ (próg ${idleGap}m) — własna skala, pokazuje kształt pracy w czasie.`, [measureLabel, idleGap],
              )
        }
        controls={
          <>
            <span data-capture-exclude="" style={{ display: "inline-flex" }}>
              <Tabs
                value={unitMode}
                onChange={setUnitMode}
                options={[
                  { value: "usd", label: "$", title: t("Dollars per period", "Dolary na okres") },
                  { value: "pct", label: t("% of window limit", "% limitu okna"), title: t("Each subscription's spend as a share of one full window of its plan", "Wydatek każdej subskrypcji jako część jednego pełnego okna jej planu") },
                ]}
              />
            </span>
            <CaptureControls targetRef={cardRef} fileName={fileName} label={t("usage history ($)", "historia zużycia ($)")} />
          </>
        }
      />
      <ProjectMixHover hover={hover} hideValues={hideValues} idleGap={idleGap} />
      <ProjectMixPlot plot={plot} hoverIdx={hoverIdx} onHover={setHoverIdx} colorOf={colorOf} />
      <div style={{ display: "flex", fontFamily: "var(--font-figure)", fontSize: "var(--fs-1)", color: "var(--muted)", marginTop: "var(--s-2)" }}>
        {points.map((p, i) => (
          <div key={p.bucket} title={Number.isFinite(Date.parse(p.bucket)) ? new Date(p.bucket).toISOString().slice(0, 10) + " UTC" : p.bucket} style={{ flex: 1, minWidth: 0, textAlign: i === 0 ? "left" : i === points.length - 1 ? "right" : "center", whiteSpace: "nowrap" }}>
            {keptDates[i] ? dateLabels[i] : ""}
          </div>
        ))}
      </div>
      <ProjectMixLegend legend={legend} hideValues={hideValues} idleGap={idleGap} colorOf={colorOf} />
    </div>
  );
}
