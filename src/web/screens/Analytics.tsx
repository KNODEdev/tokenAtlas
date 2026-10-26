import { calendarDateLabels } from "../lib/chart-dates";
import { ChartExport } from "../components/ChartExport";
import { useMemo, useState } from "react";
import type { ScreenProps } from "../lib/screens";
import type { AtlasModel, CycleView } from "../lib/cycle";
import { Card, EmptyState, EstimateTag, Tabs, HelpDot } from "../components/ui";
import { Kpi, KpiRow, Track, unit, useWidth } from "../components/WindowStatusCard";
import { ResultBar, WindowBarChart, fittingLabel, spacedTicks, windowAxis, type WindowBar } from "../components/WindowBarChart";
import { separatedLabels, textWidth } from "../components/CapacityHistoryChart";
import { WINDOW_RESULTS, windowResult, windowResultColor, windowResultLabel } from "../lib/window-archive";
import { allowanceSummary, cycleMedianSample, medianOf, niceCeil, type AllowanceSummary } from "../lib/cycle-insights";
import { isCanonicalMedianSample } from "../lib/canonical-median";
import { cyclePlanLabel } from "../lib/codex-window-stats";
import { compact, dayMonth, duration, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import "./History.css";
import "./Insights.css";

type TrendMetric = "tokens" | "percent" | "burn" | "duration";
const METRIC_TABS: { value: TrendMetric; en: string; pl: string }[] = [
  { value: "tokens", en: "tokens", pl: "tokeny" },
  { value: "percent", en: "% of limit", pl: "% limitu" },
  { value: "burn", en: "tokens / day", pl: "tokeny / dzień" },
  { value: "duration", en: "duration", pl: "czas trwania" },
];

function metricValue(cycle: CycleView, metric: TrendMetric): number | null {
  switch (metric) {
    case "tokens": return cycle.tokensTotal;
    case "percent": return cycle.usedPercent;
    case "burn": return cycle.burnPerDay;
    case "duration": return cycle.elapsedHours;
  }
}

function metricFormat(metric: TrendMetric): (value: number) => string {
  switch (metric) {
    case "tokens": return (value) => compact(value, 1);
    case "percent": return (value) => pct(value);
    case "burn": return (value) => `${compact(value, 1)}/d`;
    case "duration": return (value) => duration(value);
  }
}

/** A card's own title: the display voice (docs/design/paper-atlas.md §2). */
const CARD_TITLE = { fontSize: "var(--fs-card-title)", color: "var(--text)" } as const;

// End-usage bins aligned with the window results: three shades of "unused" under 70%, then normal, near and exhausted.
const END_BINS: Array<{ from: number; to: number; color: string }> = [
  { from: 0, to: 25, color: "color-mix(in oklab, var(--muted) 30%, var(--surface))" },
  { from: 25, to: 50, color: "color-mix(in oklab, var(--muted) 55%, var(--surface))" },
  { from: 50, to: 70, color: "color-mix(in oklab, var(--muted) 80%, var(--surface))" },
  { from: 70, to: 90, color: windowResultColor("normal") },
  { from: 90, to: 100, color: windowResultColor("near") },
  { from: 100, to: Infinity, color: windowResultColor("exhausted") },
];

/**
 * Usage per window and the estimated full allowance (docs/ui-audit-2026-09-26.md, Analytics; decision 6):
 * four tiles, one bar per window on a dated axis, and the allowance of each window against the
 * canonical median with its middle half.
 */
export function Analytics(props: ScreenProps) {
  const { model, openDrawer } = props;
  const { t, locale } = useI18n();
  const [metric, setMetric] = useState<TrendMetric>("tokens");
  const allowance = useMemo(() => allowanceSummary(model), [model]);
  if (model.cycles.length === 0) {
    return (
      <EmptyState
        title={t("No analytics data", "Brak danych analitycznych")}
        detail={t("No reset cycles have been recorded for the selected account yet. Analytics needs the limit meter's readings across at least one window.", "W wybranym koncie nie zarejestrowano jeszcze żadnych cykli resetu. Analityka potrzebuje odczytów licznika limitu z co najmniej jednego okna.")}
      />
    );
  }
  const cycles = model.cycles.slice().reverse();
  const ticks = calendarDateLabels(cycles.map((c) => c.startIso), locale);
  const format = metricFormat(metric);
  const values = cycles.map((c) => metricValue(c, metric));
  const present = values.filter((v): v is number => v != null);
  const scale = metric === "percent" ? undefined
    : { max: metric === "duration" ? Math.max(...cycles.map((c) => c.windowHours), 1) : niceCeil(Math.max(...present, 0)), format };
  const typical = medianOf(model.typical.map((c) => metricValue(c, metric)).filter((v): v is number => v != null));
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const bars: WindowBar[] = cycles.map((c, i) => {
    const value = values[i]!;
    return {
      key: String(c.index),
      percent: value,
      color: windowResultColor(windowResult(c.usedPercent, c.isActive, c.elapsedHours, c.windowHours)),
      current: c.isActive,
      title: `#${whole.format(c.number)} · ${dayMonth(c.startIso)} · ${value == null ? "—" : format(value)} · ${c.isActive ? t("in progress", "trwa") : c.resultLabel}`,
    };
  });
  const peak = present.length ? values.indexOf(Math.max(...present)) : -1;
  const newest = cycles.at(-1)!, newestValue = values.at(-1);
  return (
    <div className="archive ui-tab-page">
      <AnalyticsTiles model={model} allowance={allowance} />
      <Card>
        <div className="archive-head">
          <div><span className="ui-display" style={CARD_TITLE}>{t("Per window", "Na okno")}</span> <HelpDot label={t("Per window", "Na okno")}>{t("Colour shows the window result. Click a window to open its panel.", "Kolor to wynik okna. Kliknij okno, aby otworzyć jego panel.")}</HelpDot> <span className="archive-sub">· {t("{0} windows", `${whole.format(cycles.length)} okien`, [whole.format(cycles.length)])}</span></div>
          <Tabs value={metric} onChange={setMetric} options={METRIC_TABS.map(({ value, en, pl }) => ({ value, label: t(en, pl) }))} />
        </div>
        <WindowBarChart bars={bars} scale={scale}
          median={typical == null ? null : { value: typical, label: [`${t("typically", "typowo")} ${format(typical)}`, format(typical)] }}
          labels={peak >= 0 && !cycles[peak]!.isActive ? [{ index: peak, text: `#${whole.format(cycles[peak]!.number)} ${format(values[peak]!)}` }] : []}
          endLabel={newest.isActive && newestValue != null ? {
            candidates: [`#${whole.format(newest.number)} · ${format(newestValue)} · ${t("in progress", "trwa")}`, `#${whole.format(newest.number)} · ${format(newestValue)}`, format(newestValue)],
            color: "var(--accent)",
          } : null}
          tick={(_, i) => ticks[i] ?? null}
          onSelect={(bar) => openDrawer(Number(bar.key))} />
        <div className="archive-legend">
          {WINDOW_RESULTS.map((result) => <span key={result}><i style={{ background: windowResultColor(result) }} />{windowResultLabel(result)}</span>)}
          <span><i className="archive-legend-line" />{t("median of the last {0} closed", `mediana ${model.typical.length} ostatnich zamkniętych`, [model.typical.length])}</span>
        </div>
      </Card>
      <AllowanceCard cycles={cycles} ticks={ticks} allowance={allowance} openDrawer={openDrawer} />
    </div>
  );
}

function AnalyticsTiles({ model, allowance }: { model: AtlasModel; allowance: AllowanceSummary }) {
  const { t, locale } = useI18n();
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const cycles = model.cycles, closed = model.closed;
  const results = WINDOW_RESULTS.map((result) => {
    const count = cycles.filter((c) => windowResult(c.usedPercent, c.isActive, c.elapsedHours, c.windowHours) === result).length;
    return { key: result, count, color: windowResultColor(result), title: `${windowResultLabel(result)} ${count}` };
  });
  const exhausted = cycles.filter((c) => c.usedPercent >= 100).length;
  const bins = END_BINS.map((bin) => {
    const count = closed.filter((c) => c.usedPercent >= bin.from && c.usedPercent < bin.to).length;
    const range = bin.to === Infinity ? "≥ 100%" : `${bin.from}–${bin.to}%`;
    return { key: range, count, color: bin.color, title: `${range}: ${count}` };
  });
  const typical = model.median.peakPercent;
  const allClosed = medianOf(closed.map((c) => c.usedPercent));
  const since = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(cycles.at(-1)!.startIso));
  const { median, latest } = allowance;
  return (
    <KpiRow columns={4}>
      <Kpi label={t("Windows", "Okna")} value={whole.format(cycles.length)} visual={<ResultBar parts={results} />}
        caption={t("{0} closed · since {1}", `${whole.format(closed.length)} zamkniętych · od ${since}`, [whole.format(closed.length), since])} />
      <Kpi label={t("Exhausted", "Wyczerpane")} color={exhausted > 0 ? "var(--crit)" : undefined}
        value={<>{whole.format(exhausted)}{unit(` ${t("of", "z")} ${whole.format(cycles.length)}`)}</>}
        visual={<ResultBar parts={bins} />}
        caption={t("end of the closed windows · ≥ 90%: {0} · < 50%: {1}",
          `koniec zamkniętych okien · ≥ 90%: ${bins[4]!.count + bins[5]!.count} · < 50%: ${bins[0]!.count + bins[1]!.count}`, [bins[4]!.count + bins[5]!.count, bins[0]!.count + bins[1]!.count])} />
      <Kpi label={t("Typical end", "Typowy koniec")} value={typical == null ? "—" : <>{whole.format(typical)}{unit("%")}</>}
        visual={typical == null ? null : <Track fill={typical} tick={allClosed} color="var(--violet)" title={t("bar: last closed windows · tick: all closed", "pasek: ostatnie zamknięte okna · kreska: wszystkie zamknięte")} />}
        caption={<>{t("median of the last {0} closed", `mediana ${model.typical.length} ostatnich zamkniętych`, [model.typical.length])}
          {allClosed != null && <><br />{t("all {0}: {1}", `wszystkie ${whole.format(closed.length)}: ${pct(allClosed)}`, [whole.format(closed.length), pct(allClosed)])}</>}</>} />
      <Kpi label={t("Full allowance · est.", "Pełny limit · szac.")} value={median.value === null ? "—" : compact(median.value)} visual={null}
        caption={median.value !== null
          ? <>{t("median of {0} reliable windows · {1}", `mediana ${median.count} wiarygodnych okien · ${median.plan}`, [median.count, median.plan])}
            {latest && latest.calibration.allowanceTokens !== null && <><br />{t("last", "ostatnie")} #{whole.format(latest.number)} · {compact(latest.calibration.allowanceTokens)}</>}</>
          : median.reason === "no_plan"
            ? t("no confirmed plan to compare within", "brak potwierdzonego planu do porównania")
            : t("{0} reliable windows · at least 2 needed", `${median.count} wiarygodnych okien · potrzebne co najmniej 2`, [median.count])} />
    </KpiRow>
  );
}

// The allowance chart shares the window axis of the bars above; heights in CSS pixels.
// Axis text in the figure voice (docs/design/paper-atlas.md, charts).
const TICK = { fontFamily: "var(--font-figure)", fontSize: 10, fill: "var(--muted)" } as const;
const PLOT_TOP = 18, PLOT_H = 140, DOT_FONT = 11;

function AllowanceCard({ cycles, ticks, allowance, openDrawer }: {
  cycles: CycleView[]; ticks: (string | null)[]; allowance: AllowanceSummary; openDrawer: (index: number) => void;
}) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(1200);
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const { median, quartiles, latest, uncalibrated, lowConfidence } = allowance;
  const confidenceLabel = (confidence: string) =>
    confidence === "high" ? t("high", "wysoka") : confidence === "medium" ? t("medium", "średnia") : t("low", "niska");
  const dots = cycles.flatMap((cycle, i) => {
    const value = cycle.calibration.allowanceTokens;
    if (value === null || cycle.isActive) return [];
    const counted = median.plan !== null && isCanonicalMedianSample(cycleMedianSample(cycle), median.plan);
    const plan = cyclePlanLabel(cycle);
    return [{ cycle, i, value, counted, solid: cycle.calibration.confidence !== "low", otherPlan: median.plan !== null && plan !== median.plan, plan }];
  });
  const head = (
    <div className="archive-head">
      <div><span className="ui-display" style={CARD_TITLE}>{t("Full allowance per window", "Pełny limit na okno")}</span> <EstimateTag title={t("Inferred from % readings and the window's events; no API returns it.", "Wyliczone z odczytów % i zdarzeń okna; żadne API go nie zwraca.")}>{t("est.", "szac.")}</EstimateTag>{" "}
        <span className="archive-sub">· {t("tokens at 100%", "tokeny przy 100%")}</span></div>
    </div>
  );
  if (dots.length === 0) {
    return <Card>{head}<div className="archive-empty" style={{ marginTop: 10 }}>
      {t("No closed window has a calibrated allowance. A calibration needs at least 20 pp of meter increase, 50 readings and little reading delay.",
        "Żadne zamknięte okno nie ma skalibrowanego limitu. Kalibracja wymaga co najmniej 20 p.p. przyrostu licznika, 50 odczytów i małego opóźnienia odczytów.")}
    </div></Card>;
  }
  const axis = windowAxis(width, cycles.length);
  // Low-confidence estimates extrapolate far; they may sit above the scale instead of flattening the rest.
  const reliable = dots.filter((dot) => dot.solid).map((dot) => dot.value);
  const max = niceCeil(Math.max(...(reliable.length ? reliable : dots.map((dot) => dot.value)), median.value ?? 0));
  const y0 = PLOT_TOP + PLOT_H, height = y0 + 22;
  const y = (value: number) => y0 - (Math.min(value, max) / max) * PLOT_H;
  const tickCenters = cycles.map((_, i) => ({ center: axis.center(i), text: ticks[i] ?? null }));
  const keptTicks = spacedTicks(tickCenters);
  const latestDot = dots.find((dot) => dot.cycle === latest);
  const latestLabel = latestDot && (() => {
    const text = `#${whole.format(latestDot.cycle.number)} ${compact(latestDot.value)}`;
    const half = textWidth(text, DOT_FONT) / 2, cx = Math.min(Math.max(axis.center(latestDot.i), axis.x0 + half), axis.x1 - half), base = Math.max(DOT_FONT + 1, y(latestDot.value) - 8);
    return { text, cx, base, box: { left: cx - half, right: cx + half, top: base - DOT_FONT, bottom: base + 2 } };
  })();
  // The label is left out when it would cover another dot.
  const showLatest = latestLabel != null && separatedLabels([latestLabel.box], dots.filter((dot) => dot !== latestDot)
    .map((dot) => ({ left: axis.center(dot.i) - 4, right: axis.center(dot.i) + 4, top: y(dot.value) - 4, bottom: y(dot.value) + 4 })))[0];
  return (
    <Card>
      {head}
      <ChartExport title={t("Allowance over time", "Limit w czasie")}><div ref={ref} className="archive-chart" style={{ minWidth: 0, overflow: "hidden" }}>
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={t("Estimated full allowance per window", "Szacowany pełny limit na okno")}>
          {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={axis.x0} x2={axis.x1} y1={y(max * f)} y2={y(max * f)} stroke="var(--line)" strokeDasharray="3 4" />)}
          <text x={axis.x0 - 8} y={y(max) + 4} textAnchor="end" {...TICK}>{compact(max)}</text>
          <text x={axis.x0 - 8} y={y(max / 2) + 4} textAnchor="end" {...TICK}>{compact(max / 2)}</text>
          <line x1={axis.x0} x2={axis.x1} y1={y0} y2={y0} stroke="var(--line2)" />
          {quartiles && <rect x={axis.x0} y={y(quartiles.q3)} width={axis.x1 - axis.x0} height={Math.max(1, y(quartiles.q1) - y(quartiles.q3))} className="insights-band" />}
          {median.value !== null && <g pointerEvents="none">
            <line x1={axis.x0} x2={axis.x1} y1={y(median.value)} y2={y(median.value)} stroke="var(--violet)" strokeWidth={1.5} strokeDasharray="6 4" />
            <text x={axis.x1 + 8} y={y(median.value) + 4} fontFamily="var(--font-figure)" fontSize={11} fontWeight={500} fill="var(--violet)">
              {fittingLabel([`${t("median", "mediana")} ${compact(median.value, 1)}`, compact(median.value, 1)], width - axis.x1 - 10, 11)}
            </text>
          </g>}
          {dots.map(({ cycle, i, value, solid, counted, otherPlan, plan }) => {
            const color = otherPlan ? "var(--muted)" : "var(--accent)";
            return <g key={cycle.index} className="archive-bar" tabIndex={0} role="button" onClick={() => openDrawer(cycle.index)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDrawer(cycle.index); } }}>
              <title>{`#${whole.format(cycle.number)} · ${dayMonth(cycle.startIso)} · ${compact(value)} · ${t("confidence", "pewność")} ${confidenceLabel(cycle.calibration.confidence)} · ${plan ?? t("plan unknown", "plan nieznany")}${counted ? ` · ${t("in the median", "w medianie")}` : ""}`}</title>
              {value > max
                ? <path d={`M${axis.center(i)},${y(max) - 4}l4,6h-8z`} fill={solid ? color : "var(--surface)"} stroke={color} strokeWidth={1.5} />
                : <circle cx={axis.center(i)} cy={y(value)} r={4} fill={solid ? color : "var(--surface)"} stroke={color} strokeWidth={1.5} />}
            </g>;
          })}
          {showLatest && latestLabel && <text x={latestLabel.cx} y={latestLabel.base} textAnchor="middle" fontFamily="var(--font-figure)" fontSize={DOT_FONT} fontWeight={500} fill="var(--accent)" pointerEvents="none">{latestLabel.text}</text>}
          {tickCenters.map(({ center, text }, i) => keptTicks[i] && <text key={i} x={center} y={height - 4} textAnchor="middle" {...TICK}>{text}</text>)}
        </svg>
      </div></ChartExport>
      <div className="archive-legend">
        <span><i className="insights-dot" />{t("medium / high confidence", "średnia / wysoka pewność")}</span>
        <span><i className="insights-dot is-hollow" />{t("low confidence", "niska pewność")}</span>
        {dots.some((dot) => dot.otherPlan) && <span><i className="insights-dot is-other" />{t("other plan", "inny plan")}</span>}
        {dots.some((dot) => dot.value > max) && <span>▲ {t("above {0}", `powyżej ${compact(max)}`, [compact(max)])}</span>}
        {quartiles && <span><i className="insights-band-swatch" />{t("middle half", "połowa środkowych wartości")}</span>}
        {median.value !== null && <span><i className="archive-legend-line" />{t("median", "mediana")}</span>}
      </div>
      <div className="insights-facts">
        <div><span>{t("median", "mediana")}</span><b>{median.value === null ? "—" : compact(median.value)}</b>
          <small>{median.value === null ? t("{0} reliable windows · at least 2 needed", `${median.count} wiarygodnych okien · potrzebne co najmniej 2`, [median.count])
            : t("{0} windows · {1} · ≥ 20 pp · medium/high confidence", `${median.count} okien · ${median.plan} · ≥ 20 p.p. · średnia/wysoka pewność`, [median.count, median.plan])}</small></div>
        <div><span>{t("middle half", "środek 50%")}</span><b>{quartiles ? `${compact(quartiles.q1)}–${compact(quartiles.q3)}` : "—"}</b>
          <small>{quartiles ? t("half of the median's windows fall here", "tu mieści się połowa okien mediany") : t("needs 4 windows", "potrzebne 4 okna")}</small></div>
        <div><span>{t("latest", "ostatnie")}</span><b>{latest?.calibration.allowanceTokens != null ? compact(latest.calibration.allowanceTokens) : "—"}</b>
          <small>{latest ? `#${whole.format(latest.number)} · ${dayMonth(latest.startIso)} · ${t("confidence", "pewność")} ${confidenceLabel(latest.calibration.confidence)}` : "—"}</small></div>
        <div><span>{t("left out", "pominięte")}</span><b>{whole.format(uncalibrated)} + {whole.format(lowConfidence)}</b>
          <small>{t("without calibration · low confidence (hollow)", "bez kalibracji · niska pewność (puste kółka)")}</small></div>
      </div>
    </Card>
  );
}
