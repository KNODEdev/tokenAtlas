import { ChartExport } from "./ChartExport";
import { Children, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CycleBreakdownResponse } from "../lib/api";
import type { CycleView } from "../lib/cycle";
import { isContextPreviewSelected } from "../../shared/context-preview";
import { cyclePlanDescription, observationOf, windowForecast, windowTrafficSummary } from "../lib/codex-window-stats";
import { compact, dayTime, duration, full, pct, relativeTime, signedPct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { missingRateAmountTitle, missingRateIn, missingRateNote, useMissingRates } from "../lib/missing-rate";
import type { WindowInsight } from "../lib/window-insights";
import { clipAtLimit, typicalBand, typicalForecastPath, windowDays, type CoursePoint } from "../lib/window-status";
import { Card, Eyebrow, Tabs } from "./ui";
import { creditStripView, creditsAmount, windowCreditRows, type AccountCredits, type CreditStripView, type WindowCreditRow } from "../lib/credit-pools-view";
import { CHART_UNITS, dailyUnitValues, readChartUnit, unitPoolEvidence, windowCapacity, windowUnitSeries, writeChartUnit, type ChartUnit, type UnitCapacity, type UnitInput } from "../lib/window-units";
import { PoolFacts } from "./PoolFacts";
import { PoolUsageChart, PoolUsageLegend } from "./PoolUsageChart";
import { observedPoolDays, windowPoolSeries } from "../lib/pool-series";
import { activeCourses } from "../lib/window-activity";
import { activityStartsAt } from "../../shared/window-activity";
import { poolUsage } from "../../shared/pool-usage";

export const ACCENT_SOFT = "color-mix(in srgb, var(--accent) 40%, var(--surface))";

/** An observation chip under the status header; the full text is the tooltip. */
export function Chip({ tone, title, children }: { tone: string; title?: string; soft?: string; children: ReactNode }) {
  // A quiet pill: the tone is the dot, the text stays ink (docs/design/paper-atlas.md).
  return <span className="ui-pill" title={title} style={{ cursor: "help", "--pill-tone": tone } as CSSProperties}><span className="ui-pill-dot" />{children}</span>;
}

function riskColor(value: number | null): string {
  if (value == null) return "var(--text)";
  return value >= 100 ? "var(--crit)" : value >= 90 ? "var(--warn)" : "var(--text)";
}

function paceColor(pace: number | null): string {
  if (pace == null) return "var(--text)";
  return pace >= 1.5 ? "var(--crit)" : pace > 1 ? "var(--warn)" : "var(--text)";
}

export function Track({ fill, tick, color = "var(--accent)", height = 6, title, children }: {
  fill?: number | null; tick?: number | null; color?: string; height?: number; title?: string; children?: ReactNode;
}) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return (
    <div title={title} style={{ position: "relative", height, boxSizing: "border-box", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", background: "var(--sunk)", marginTop: "var(--s-4)" }}>
      {fill != null && <div style={{ position: "absolute", inset: "0 auto 0 0", width: `${clamp(fill)}%`, borderRadius: "inherit", background: color }} />}
      {tick != null && <div style={{ position: "absolute", top: -4, bottom: -4, width: 2, left: `${clamp(tick)}%`, background: "var(--text)" }} />}
      {children}
    </div>
  );
}

/** A row of headline tiles: the KPI strip's cells divided by dashed rules, never framed. */
export function KpiRow({ columns, style, children }: { columns: number; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className="ui-kpi-strip" style={{ "--kpi-columns": columns, ...style } as CSSProperties}>
      {children}
    </div>
  );
}

export function Kpi({ label, value, color, visual, caption }: { label: string; value: ReactNode; color?: string; visual: ReactNode; caption: ReactNode }) {
  return (
    <div className="ui-kpi-cell">
      <Eyebrow>{label}</Eyebrow>
      <div className="ui-figure" style={{ fontSize: "var(--fs-9)", lineHeight: 1.15, marginTop: "var(--s-2)", color }}>{value}</div>
      {visual}
      <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: "var(--s-3)" }}>{caption}</div>
    </div>
  );
}

export const unit = (text: string) => <span style={{ fontSize: "var(--fs-6)", color: "var(--muted)", fontWeight: "var(--fw-medium)", letterSpacing: 0 }}>{text}</span>;
/** "35.35B" as 35.35 with a small B, like the Overview tiles. */
export const withUnit = (text: string): ReactNode => {
  const match = /^(.*\d)([kMB])$/.exec(text);
  return match ? <>{match[1]}{unit(match[2]!)}</> : text;
};

// Chart geometry in CSS pixels; the width follows the container so labels keep their size.
const X0 = 44, RIGHT_GUTTER = 64, Y0 = 244, Y100 = 40, BAR_BASE = 300, BAR_MAX = 40, AXIS_Y = 318, HEIGHT = 330;
// A day label centred closer than this to the end line would overlap the end's date and time.
const END_LABEL_CLEARANCE = 64;
// Without daily traffic the day axis sits right under the course.
const AXIS_Y_NO_BARS = Y0 + 18, HEIGHT_NO_BARS = Y0 + 28;

export function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(480, Math.round(entry.contentRect.width))); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The unit switch and the data the other units are drawn from; absent: the chart shows "%" only. */
export interface ChartUnits {
  input: UnitInput;
  /** The units this provider can count; all of them when absent (Claude has no credit rate card). */
  options?: readonly ChartUnit[];
}

/**
 * Usage course of one window with its typical band, both forecasts and, when the index
 * has them, tokens per day. `reading` is the newest percentage on the window's time axis.
 * With `units` the chart also switches to tokens, API dollars and credits (window-units.ts).
 */
export function WindowChart({ startMs, spanMs, endMs, active, insight, reading, linearEnd, exhaustionIso, tokensByDay, units, control }: {
  startMs: number; spanMs: number; endMs: number; active: boolean; insight: WindowInsight | null;
  reading: CoursePoint; linearEnd: number | null; exhaustionIso: string | null;
  /** null: the vendor's index has no daily traffic, so no bars are drawn. */
  tokensByDay: Map<string, number> | null;
  units?: ChartUnits | null;
  /** A scope control (the project picker) at the right end of the unit row. */
  control?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const [ref, W] = useWidth(900);
  const [unit, setUnit] = useState<ChartUnit>(() => units ? readChartUnit() : "pct");
  // The unit switch's own width decides on which side of the "now" line it fits; the control keeps its right end.
  const tabsRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const [tabsWidth, setTabsWidth] = useState(0);
  const [controlWidth, setControlWidth] = useState(0);
  useLayoutEffect(() => {
    const w = tabsRef.current?.offsetWidth ?? 0; if (w !== tabsWidth) setTabsWidth(w);
    const c = controlRef.current?.offsetWidth ?? 0; if (c !== controlWidth) setControlWidth(c);
  });
  const options = units?.options ?? CHART_UNITS;
  const mode: ChartUnit = units && options.includes(unit) ? unit : "pct";
  const X1 = W - RIGHT_GUTTER;
  const x = (t: number) => X0 + (Math.max(0, Math.min(100, t)) / 100) * (X1 - X0);
  const points = (path: CoursePoint[]) => path.map((p) => `${x(p.t).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ");
  const at = (ms: number) => ((ms - startMs) / spanMs) * 100;
  const bars = tokensByDay != null;
  const axisY = bars ? AXIS_Y : AXIS_Y_NO_BARS;
  const height = bars ? HEIGHT : HEIGHT_NO_BARS;
  const floor = bars ? BAR_BASE : Y0 + 6;
  const series = units ? windowUnitSeries(mode, units.input) : null;
  const poolRows = units ? windowPoolSeries(poolUsage(units.input.pools, unitPoolEvidence(units.input)), mode, units.input)
    .filter(row => row.basis === "funded" || !row.pool.funded?.buckets.length) : [];
  const plotMax = Math.max(100, ...poolRows.flatMap(row => row.points.map(point => Math.ceil(point.pct / 25) * 25)));
  const y = (p: number) => Y0 - Math.max(0, p) / plotMax * (Y0 - Y100);
  const percent = mode === "pct";

  const band = percent ? typicalBand(insight?.comparableWindows.map((w) => w.shape) ?? []) : [];
  const startsAtReset = activityStartsAt(insight?.current.activity, startMs)
    && (!insight?.current.activity || Math.abs(spanMs - (insight.current.windowHours ?? 0) * 3_600_000) < 120_000);
  const meter: CoursePoint[] = [...(startsAtReset ? [{ t: 0, pct: 0 }] : []), ...(insight?.current.shape ?? [])
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.pct)).sort((a, b) => a.t - b.t)
    .map((p) => ({ t: p.t, pct: p.pct }))];
  if (active && Number.isFinite(reading.t) && reading.t > (meter.at(-1)?.t ?? 0)) meter.push(reading);
  // Other units draw the counted course; "%" the meter's readings.
  const actual: CoursePoint[] = percent ? meter : series?.course?.length ? series.course : [{ t: 0, pct: 0 }];
  const courses = activeCourses(actual, insight?.current.activity, startMs, spanMs);
  const last = actual.at(-1) ?? reading;

  // Forecasts are the meter's. The current pace also reads in a unit while the limit there is the estimate
  // (value so far ÷ meter percent), whose percent space is the meter's; the typical forecast stays "%" only.
  const paceInUnit = !percent && !!series?.limit?.estimate;
  const linear = (percent || paceInUnit) && active && linearEnd !== null && reading.t > 0
    ? clipAtLimit([reading, { t: 100, pct: linearEnd }]) : null;
  const typicalEnd = percent && active ? insight?.forecastPercent ?? null : null;
  const typical = typicalEnd != null ? clipAtLimit(typicalForecastPath(band, last, typicalEnd)) : null;
  const typicalNow = percent && active ? insight?.typicalAtElapsed ?? null : null;
  const nowT = active ? at(Date.now()) : null;
  const nowX = nowT != null && nowT > 0 && nowT < 100 ? x(nowT) : null;
  // Right of the line while it fits, otherwise ending at it; the plot's left edge once the window closed.
  const room = W - (controlWidth > 0 ? controlWidth + 16 : 0);
  const tabsLeft = nowX == null ? X0 : nowX + tabsWidth <= room ? nowX : Math.max(X0, Math.min(nowX, room) - tabsWidth);

  const days = windowDays(startMs, endMs);
  // The bars follow the unit: the meter's daily rise in "%", the counted daily value otherwise.
  const daily = dailyUnitValues(units ? mode : "tokens", days, units?.input ?? null, meter, tokensByDay);
  const poolDays = observedPoolDays(poolRows, days);
  const dayTotal = (key: string) => (daily.get(key)?.value ?? 0) + (daily.get(key)?.credit ?? 0) + (poolDays.get(key)?.value ?? 0);
  const peak = Math.max(0, ...days.map((d) => dayTotal(d.key)));
  const dayLabel = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" });
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const anyCredit = days.some((d) => (daily.get(d.key)?.credit ?? 0) > 0);
  // A Claude grant funds calls within the window, not "after 100%" from credits.
  const grantFunded = unitPoolEvidence(units?.input)?.kind === "grant";

  const fmt = (value: number) => mode === "tokens" ? compact(value) : mode === "usd" ? `$${compact(value)}` : `${compact(value)} ${t("cr", "kr.")}`;
  // A bar's label: one decimal of a percent point below 10, as the meter is read.
  const barLabel = (value: number) => !units || mode === "tokens" ? compact(value)
    : percent ? `${value.toLocaleString(locale, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`
    : mode === "usd" ? value < 100 ? usd(value) : `$${compact(value)}` : value < 100 ? creditsAmount(value) : compact(value);
  // Unabridged, where there is room: the 100% line and tooltips.
  const fmtFull = (value: number) => mode === "tokens" ? compact(value) : mode === "usd" ? value < 100 ? usd(value) : `$${full(value)}` : `${creditsAmount(value)} ${t("cr", "kr.")}`;
  // Axis and end labels sit in narrow gutters: the unit is in the legend.
  const short = (value: number) => mode === "usd" ? `$${compact(value, 1)}` : compact(value, mode === "tokens" ? 2 : 1);
  const valueOf = (pct: number) => series?.scale != null ? series.scale * pct / 100 : null;
  const limit = series?.limit ?? null;
  const pointLabel = (p: number) => valueOf(p) == null ? "—" : short(valueOf(p)!);

  const labelEnd = (value: number, color: string, dy: number) => (
    <text x={x(100) + 12} y={y(Math.min(100, value)) + dy} fontSize={13} fontWeight={500} fill={color}>
      {value > 100 ? "↑" : ""}{pct(value)}
    </text>
  );
  const axisLabel = (p: number) => percent ? `${p}%` : series?.scale != null ? `${p === 100 && limit?.estimate ? "≈" : ""}${short(series.scale * p / 100)}` : p === 0 ? "0" : "";
  const limitTitle = limit ? limit.estimate
    ? t("≈ {0}: local logs ÷ vendor % × 100 (the window has not reached the limit)", `≈ ${fmt(limit.value)}: lokalne logi ÷ % dostawcy × 100 (okno nie doszło do limitu)`, [fmt(limit.value)])
    : t("{0}: counted calls when the vendor's meter first reached the limit", `${fmt(limit.value)}: policzone wywołania w chwili, gdy licznik dostawcy pierwszy raz doszedł do limitu`, [fmt(limit.value)]) : null;
  return (
    <ChartExport title={t("Window course", "Przebieg okna")}><div ref={ref} style={{ minWidth: 0, overflow: "hidden" }}>
      {/* The unit switch sits at the "now" line, on whichever side has room. */}
      {(units || control) && <div style={{ display: "flex", alignItems: "flex-end", marginBottom: "var(--s-2)" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0, paddingLeft: tabsLeft }}>{units && <div ref={tabsRef} style={{ display: "inline-block" }}><Tabs value={mode} onChange={(next) => { setUnit(next); writeChartUnit(next); }} options={[
          { value: "pct" as const, label: "%", title: t("The vendor's meter", "Licznik dostawcy") },
          { value: "tokens" as const, label: t("tokens", "tokeny"), title: t("Counted tokens from this machine set's logs", "Policzone tokeny z logów tego zestawu maszyn") },
          { value: "usd" as const, label: "$", title: t("API-eq value of the counted calls, from local logs", "Wartość API-eq policzonych wywołań, z lokalnych logów") },
          { value: "credits" as const, label: t("credits", "kredyty"), title: t("Counted calls at the Codex credit rate card, from local logs", "Policzone wywołania według cennika kredytów Codex, z lokalnych logów") },
        ].filter((option) => options.includes(option.value))} /></div>}</div>
        {/* Outside the exported image, as it was above the chart. */}
        {control && <div ref={controlRef} data-capture-exclude="" style={{ flex: "none" }}>{control}</div>}
      </div>}
      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img" style={{ display: "block", fontFamily: "var(--font-figure)" }}
        aria-label={bars ? t("Window course: usage, forecasts and daily tokens", "Przebieg okna: zużycie, prognozy i tokeny dzienne")
          : t("Window course: usage and forecasts", "Przebieg okna: zużycie i prognozy")}>
        {[25, 50, 75].map((p) => <line key={p} x1={X0} x2={X1} y1={y(p)} y2={y(p)} stroke="var(--line)" strokeDasharray="3 4" />)}
        {[0, 50].map((p) => <text key={p} x={X0 - 8} y={y(p) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{axisLabel(p)}</text>)}
        <line x1={X0} x2={X1} y1={y(100)} y2={y(100)} stroke="var(--text)" strokeWidth={1.25}
          strokeDasharray={!percent && limit?.estimate ? "6 4" : undefined} strokeOpacity={!percent && !limit ? 0.35 : 1}>
          {limitTitle && <title>{limitTitle}</title>}
        </line>
        <text x={X0 - 8} y={y(100) + 4} textAnchor="end" fontSize={10} fontWeight={500} fill="var(--text)">
          {axisLabel(100)}{limitTitle && <title>{limitTitle}</title>}
        </text>
        {!percent && limit && <text x={X0 + 6} y={y(100) + 14} fontSize={11} fill="var(--muted)">
          {series?.partial ? "≥ " : limit.estimate ? "≈ " : ""}{fmtFull(limit.value)} = 100%{limitTitle && <title>{limitTitle}</title>}
        </text>}
        <line x1={X0} x2={X1} y1={Y0} y2={Y0} stroke="var(--line2)" />

        {band.length > 1 && <polygon fill="var(--accent-soft)"
          points={points([...band.map((p) => ({ t: p.t, pct: Math.min(100, p.high) })), ...[...band].reverse().map((p) => ({ t: p.t, pct: p.low }))])} />}

        {courses.map((course, index) => <g key={index} data-window-active-course="">
          <polygon points={points([{ t: course[0]!.t, pct: 0 }, ...course, { t: course.at(-1)!.t, pct: 0 }])} fill="var(--accent)" fillOpacity={0.14} />
          <polyline points={points(course)} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        </g>)}
        {insight?.current.activity?.spans.slice(1).map((span, index) => {
          const from = at(Date.parse(insight.current.activity!.spans[index]!.end)), until = at(Date.parse(span.start));
          return <rect key={index} x={x(from)} y={Y100} width={Math.max(0, x(until) - x(from))} height={Y0 - Y100} fill="transparent">
            <title>{`${t("Plan activity paused", "Przerwa w aktywności planu")} · ${dayTime(insight.current.activity!.spans[index]!.end)} → ${dayTime(span.start)}`}</title>
          </rect>;
        })}
        <PoolUsageChart rows={poolRows} mode={mode} x={x} y={y} startMs={startMs} spanMs={spanMs} />
        {/* Invisible hover targets: each reading's (or block's) date, time and value. */}
        {actual.slice(1).map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.pct)} r={6} fill="transparent">
          <title>{dayTime(new Date(startMs + (p.t / 100) * spanMs).toISOString())} · {percent ? pct(p.pct) : valueOf(p.pct) == null ? "—" : fmt(valueOf(p.pct)!)}</title>
        </circle>)}

        {linear && <>
          <polyline points={points(linear.path)} fill="none" stroke="var(--crit)" strokeWidth={1.75} strokeDasharray="7 5" strokeLinecap="round" />
          {linear.crossing && <>
            <path d={`M${x(linear.crossing.t) - 6},${y(100) - 6}L${x(linear.crossing.t) + 6},${y(100) + 6}M${x(linear.crossing.t) + 6},${y(100) - 6}L${x(linear.crossing.t) - 6},${y(100) + 6}`}
              stroke="var(--crit)" strokeWidth={1.75} strokeLinecap="round" />
            {exhaustionIso && <text x={x(linear.crossing.t)} y={y(100) - 12} textAnchor="middle" fontSize={12} fontWeight={500} fill="var(--crit)">
              {dayTime(exhaustionIso)}
            </text>}
          </>}
          {percent ? labelEnd(linearEnd!, "var(--crit)", linearEnd! > 100 ? -8 : 4)
            : <text x={x(100) + 12} y={y(Math.min(100, linearEnd!)) + (linearEnd! > 100 ? -8 : 4)} fontSize={13} fontWeight={500} fill="var(--crit)">
              {linearEnd! > 100 ? "↑" : ""}{pointLabel(linearEnd!)}
              <title>{t("Current pace until the reset: ≈ {0} ({1} of the meter)",
                `Obecne tempo do resetu: ≈ ${fmtFull(valueOf(linearEnd!)!)} (${pct(linearEnd!)} licznika)`, [fmtFull(valueOf(linearEnd!)!), pct(linearEnd!)])}</title>
            </text>}
        </>}

        {typical && typicalEnd != null && <>
          <polyline points={points(typical.path)} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeDasharray="2 5" strokeLinecap="round" />
          {!typical.crossing && <circle cx={x(100)} cy={y(typicalEnd)} r={5} fill="var(--accent)" />}
          {labelEnd(typicalEnd, "var(--accent)", typicalEnd > 100 ? 12 : 4)}
        </>}

        {typicalNow != null && <>
          <circle cx={x(reading.t)} cy={y(typicalNow)} r={4} fill="var(--surface)" stroke="var(--muted)" strokeWidth={1.5} />
          <text x={x(reading.t) - 8} y={y(typicalNow) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{t("typical", "typowo")} {pct(typicalNow)}</text>
        </>}
        <circle cx={x(last.t)} cy={y(last.pct)} r={5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
        {percent
          ? <text x={x(last.t) + 10} y={y(last.pct) + 16} fontSize={13} fontWeight={500} fill="var(--text)">{pct(last.pct)}</text>
          // A unit's value is longer than a percent: near the window's end it reads to the left of the point.
          : <text x={x(last.t) + (last.t > 90 ? -10 : 10)} y={y(last.pct) + 16} textAnchor={last.t > 90 ? "end" : "start"} fontSize={13} fontWeight={500}
            fill="var(--text)">{pointLabel(last.pct)}</text>}

        {nowT != null && nowT > 0 && nowT < 100 && <>
          <line x1={x(nowT)} x2={x(nowT)} y1={14} y2={Y0} stroke="var(--muted)" strokeDasharray="3 4" />
          <text x={x(nowT)} y={10} textAnchor="middle" fontSize={10} fill="var(--muted)">{t("now", "teraz")}</text>
        </>}
        <line x1={x(100)} x2={x(100)} y1={14} y2={floor} stroke="var(--line2)" />
        {/* The window's end reads on the day axis, under its line. */}
        <text x={x(100)} y={axisY} textAnchor="middle" fontSize={10} fill="var(--muted)">
          {active ? "⟳ " : ""}{dayLabel.format(endMs)} {clock.format(endMs)}<title>{dayTime(new Date(endMs).toISOString())}</title>
        </text>

        {days.map((day, i) => {
          const a = x(at(day.startMs)), b = x(at(day.endMs));
          const bar = daily.get(day.key);
          const value = bar?.value ?? null;
          const observed = poolDays.get(day.key);
          const fromCredits = (bar?.credit ?? 0) + (observed?.value ?? 0);
          const w = Math.max(1, b - a - 6);
          const h = value != null && peak > 0 ? Math.max(2, (value / peak) * BAR_MAX) : 0;
          const hc = fromCredits > 0 && peak > 0 ? Math.max(2, (fromCredits / peak) * BAR_MAX) : 0;
          const exact = (v: number) => percent && units ? `${v.toLocaleString(locale, { maximumFractionDigits: 1 })}%` : fmtFull(v);
          return <g key={day.key}>
            {i > 0 && <line x1={a} x2={a} y1={Y0} y2={floor} stroke="var(--line)" strokeDasharray="3 4" />}
            {bars && (value != null && value > 0 || hc > 0
              ? <>
                {value != null && value > 0 && <rect x={a + 3} y={BAR_BASE - h} width={w} height={h} rx={2} fill={dayTotal(day.key) === peak && hc === 0 ? "var(--accent)" : "var(--line2)"}>
                  <title>{`${day.key} · ${new Date(day.startMs).toISOString()} → ${new Date(day.endMs).toISOString()} · ${bar?.partial ? "≥ " : ""}${exact(value)}`}</title>
                </rect>}
                {hc > 0 && <rect data-observed-pool-bar={observed ? "" : undefined} x={a + 3} y={BAR_BASE - h - hc} width={w} height={hc} rx={2} fill="var(--violet)">
                  <title>{`${day.key} · ${new Date(day.startMs).toISOString()} → ${new Date(day.endMs).toISOString()} · ${observed?.partial ? "≥ " : ""}${observed?.estimate ? "≈ " : ""}${exact(fromCredits)} ${observed ? t("observed account spend", "zaobserwowany wydatek konta") : grantFunded ? t("funded calls valuation", "wycena wywołań z puli") : t("paid from credits", "opłacone kredytami")}`}</title>
                </rect>}
                {w > 34 && (hc > 0
                  ? <text x={a + 3 + w / 2} y={BAR_BASE - h - hc - 4} textAnchor="middle" fontSize={10} fontWeight={500} fill="var(--violet)">
                    {observed?.estimate ? "≈+" : "+"}{barLabel(fromCredits)}{w > 70 ? observed || grantFunded ? ` ${t("from pool", "z puli")}` : ` ${t("from cr.", "z kr.")}` : ""}</text>
                  : value != null && <text x={a + 3 + w / 2} y={BAR_BASE - h - 4} textAnchor="middle" fontSize={10} fontWeight={500} fill="var(--text)">
                    {bar?.partial ? "≥ " : ""}{barLabel(value)}</text>)}
              </>
              : <rect x={a + 3} y={BAR_BASE - 3} width={w} height={3} rx={1.5} fill="var(--sunk)" />)}
            {b - a > 30 && (a + b) / 2 < x(100) - END_LABEL_CLEARANCE && <text x={(a + b) / 2} y={axisY} textAnchor="middle" fontSize={10} fill="var(--muted)">{dayLabel.format(day.startMs)}</text>}
          </g>;
        })}
      </svg>
      <div style={{ display: "flex", gap: 18, fontSize: "var(--fs-3)", color: "var(--muted)", margin: "var(--s-1) 0 0 44px", flexWrap: "wrap" }}>
        <Legend line="2px solid var(--accent)">{percent ? t("usage", "zużycie") : mode === "tokens" ? t("tokens, cumulative", "tokeny narastająco")
          : mode === "usd" ? t("API-eq, cumulative", "API-eq narastająco") : t("credits, cumulative", "kredyty narastająco")}</Legend>
        {linear && <Legend line="2px dashed var(--crit)">{t("current pace", "obecne tempo")}</Legend>}
        {typical && <Legend line="2px dotted var(--accent)">{t("typical", "typowo")}</Legend>}
        {band.length > 1 && <Legend swatch="var(--accent-soft)">{t("previous windows", "poprzednie okna")}</Legend>}
        {bars && <Legend swatch="var(--line2)">{!units || mode === "tokens" ? t("tokens / day", "tokeny / dzień") : percent ? t("% / day", "% / dzień")
          : mode === "usd" ? t("API-eq / day", "API-eq / dzień") : t("credits / day", "kredyty / dzień")}</Legend>}
        {bars && anyCredit && <span style={{ color: "var(--violet)" }}><Legend swatch="var(--violet)">{grantFunded ? t("from pool", "z puli") : t("from credits (after 100%)", "z kredytów (po 100%)")}</Legend></span>}
        {bars && poolDays.size > 0 && <span style={{ color: "var(--violet)" }}><Legend swatch="var(--violet)">{t("observed account spend / day", "wydatek konta / dzień")}</Legend></span>}
        <PoolUsageLegend rows={poolRows} mode={mode} />
        {!percent && <span style={{ color: "var(--faint)" }} title={t("Tokens, dollars and credits come from this machine set's logs; % comes from the vendor.",
          "Tokeny, dolary i kredyty pochodzą z logów tego zestawu maszyn; % pochodzi od dostawcy.")}>
          {t("from local logs; % from the vendor", "z lokalnych logów; % od dostawcy")}{series?.partial ? ` · ${t("some calls unpriced (≥)", "część wywołań bez ceny (≥)")}` : ""}
          {series && series.scale == null ? ` · ${t("no data in this unit yet", "brak danych w tej jednostce")}` : ""}
        </span>}
      </div>
    </div></ChartExport>
  );
}

function Legend({ line, swatch, children }: { line?: string; swatch?: string; children: ReactNode }) {
  const mark: CSSProperties = line
    ? { width: 18, borderTop: line }
    : { width: 12, height: 8, borderRadius: "var(--r-bar)", background: swatch };
  return <span><i style={{ display: "inline-block", verticalAlign: "middle", marginRight: 6, ...mark }} />{children}</span>;
}

/** Label and value on one line; the detail (bars, notes) on a second line under the value, at its full width. */
export function StatRow({ label, value, children }: { label: ReactNode; value: ReactNode; children?: ReactNode }) {
  const detail = Children.toArray(children).length > 0;
  return (
    <div className="mono" style={{ display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: "var(--s-2) var(--s-5)", alignItems: "baseline", padding: "var(--s-4) 0", borderBottom: "var(--rule)", fontSize: "var(--fs-4)" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="ui-figure" style={{ fontSize: "var(--fs-6)" }}>{value}</span>
      {detail && <div style={{ gridColumn: 2, minWidth: 0 }}>{children}</div>}
    </div>
  );
}

/**
 * "na 100%": the window's capacity in API dollars and credits, the value on the chart's 100% line (window-units.ts).
 * `basis` is the account's conversion window (the credit strip's "1 okno ≈"), compared when it is another window.
 */
export function CapacityRow({ percent, usdCapacity, creditCapacity, basis }: {
  percent: number | null; usdCapacity: UnitCapacity | null; creditCapacity: UnitCapacity | null;
  basis: { number: number | null; credits: number } | null;
}) {
  const { t } = useI18n();
  const shown = usdCapacity ?? creditCapacity;
  if (!shown) return null;
  const mark = (c: UnitCapacity) => c.partial ? "≥ " : c.estimate ? "≈ " : "";
  const dollars = (value: number) => `$${full(value)}`;
  const cr = (value: number) => `${creditsAmount(value)} ${t("cr", "kr.")}`;
  const ranges = [usdCapacity?.range && `${dollars(usdCapacity.range.low)}–${dollars(usdCapacity.range.high)}`,
    creditCapacity?.range && `${creditsAmount(creditCapacity.range.low)}–${cr(creditCapacity.range.high)}`].filter(Boolean).join(" · ");
  const title = shown.estimate
    ? t("Estimate: counted so far ÷ {0} of the meter × 100, at this window's model and cache mix. With the reading off by 1 pp: {1}",
      `Szacunek: policzone do tej pory ÷ ${pct(percent)} licznika × 100, przy miksie modeli i cache tego okna. Przy odczycie przesuniętym o 1 p.p.: ${ranges}`, [pct(percent), ranges])
    : t("Counted calls when the vendor's meter first reached the limit.", "Policzone wywołania w chwili, gdy licznik dostawcy pierwszy raz doszedł do limitu.");
  const change = basis && creditCapacity && basis.credits > 0 ? (creditCapacity.value / basis.credits - 1) * 100 : null;
  return (
    <StatRow label={t("at 100%", "na 100%")} value={<span title={title} style={{ cursor: "help" }}>{usdCapacity ? `${mark(usdCapacity)}${dollars(usdCapacity.value)}` : "—"}</span>}>
      {creditCapacity && <span style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }} title={title}>{mark(creditCapacity)}{cr(creditCapacity.value)}</span>}
      {basis && change != null && <div style={mini} title={t(
        "The same 100% in window #{0}, the current conversion basis. The difference comes from the model and cache mix or from a changed limit; these numbers alone do not tell which.",
        `To samo 100% w oknie #${basis.number ?? "?"}, aktualnej podstawie przeliczenia. Różnica wynika z miksu modeli i cache albo ze zmiany limitu; same te liczby tego nie rozstrzygają.`, [basis.number ?? "?"])}>
        <span>{t("window", "okno")} #{basis.number ?? "?"}: {cr(basis.credits)}</span><span>{signedPct(change)}</span>
      </div>}
    </StatRow>
  );
}

/** A wash of the credit ink: the strip is the one inner well of the card (mockup 2, accepted 10.10). */
const VIOLET_WASH = "color-mix(in oklab, var(--violet) 9%, transparent)";

/** "Kredyty": the account's credits under the window's chips, for any selected window; nothing without them. */
export function CreditStrip({ view }: { view: CreditStripView | null }) {
  const { t } = useI18n();
  if (!view) return null;
  return (
    <div data-credit-strip className="mono" title={view.title} style={{ display: "flex", gap: "var(--s-3) var(--s-8)", flexWrap: "wrap", alignItems: "baseline",
      marginTop: "var(--s-4)", padding: "var(--s-3) var(--s-5)", background: VIOLET_WASH, borderRadius: "var(--r-chip)", fontSize: "var(--fs-4)", color: "var(--muted)" }}>
      {view.pools.map(pool => <PoolFacts key={pool.key} pool={pool} />)}
      {view.resets && <span>{view.resets}</span>}
    </div>
  );
}

/** The credit rows closing "To okno", in the credit ink; the strip above carries the account-level figures. */
export function WindowCreditsSection({ rows }: { rows: WindowCreditRow[] | null }) {
  if (!rows) return null;
  return (
    <div data-window-credits>
      {rows.map((row, index) => <StatRow key={row.label} label={<span title={row.title} style={{ color: "var(--violet)" }}>{row.label}</span>}
        value={<span title={row.title} style={index === 0 ? { color: "var(--violet)" } : undefined}>{row.value}</span>}>
        {/* On its own line under the value the detail has room to wrap instead of being cut. */}
        {row.detail && <div style={{ fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.5 }} title={row.detail}>{row.detail}</div>}
      </StatRow>)}
    </div>
  );
}

export function Stack({ parts }: { parts: { value: number; color: string }[] }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <div style={{ display: "flex", height: 6, boxSizing: "border-box", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden", background: "var(--sunk)" }}>
      {total > 0 && parts.map((p, i) => <span key={i} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
    </div>
  );
}

export const mini: CSSProperties = { fontSize: "var(--fs-2)", color: "var(--muted)", display: "flex", justifyContent: "space-between", gap: "var(--s-4)", marginTop: "var(--s-1)" };

/** The window's machines as a share of indexed tokens, largest first. */
export function MachineRow({ shares }: { shares: WindowInsight["current"]["trafficByMachine"] }) {
  const { t } = useI18n();
  const machines = [...shares].filter((m) => m.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = machines.reduce((sum, m) => sum + m.amount, 0);
  if (machines.length === 0) return null;
  return (
    <StatRow label={t("machines", "maszyny")} value={machines.length}>
      <Stack parts={machines.map((m, i) => ({ value: m.amount, color: i === 0 ? "var(--accent)" : i === 1 ? ACCENT_SOFT : "var(--line2)" }))} />
      <div style={mini}>{machines.slice(0, 2).map((m) => <span key={m.machine ?? "unknown"} title={m.machine ?? undefined}
        style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.machine ?? t("unknown", "nieznane")} {pct((m.amount / total) * 100)}</span>)}</div>
    </StatRow>
  );
}

/** The four headline numbers of a window, the same for every vendor with a percentage counter. */
export interface StatusKpiValues {
  active: boolean;
  usedPercent: number | null;
  /** The percentage is computed from local traffic, not read from the vendor. */
  usedEstimated?: boolean;
  elapsedPercent: number;
  /** Appended to "left N%", e.g. the remaining tokens. */
  leftNote?: string | null;
  remainingHours: number | null;
  elapsedHours: number;
  resetIso: string | null;
  resetNote?: string | null;
  endedIso: string | null;
  typicalEnd: number | null;
  linearEnd: number | null;
  baselineCount: number;
  /** Current pace against an even pace to the limit. */
  pace: number | null;
  perHour: number | null;
  remainingPerHour: number | null;
  /** Credit-funded tokens after the limit as a percent of the window's tokens (closed windows); null without any. */
  creditShare?: number | null;
}

function StatusKpis({ k }: { k: StatusKpiValues }) {
  const { t, locale } = useI18n();
  const { active } = k;
  const num = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  const ends = [k.typicalEnd, k.linearEnd].filter((v): v is number => v != null);
  const worst = ends.length ? Math.max(...ends) : null;
  const endValue = ends.length === 0 ? "—"
    : ends.length === 1 || Math.round(ends[0]!) === Math.round(ends[1]!) ? <>{num(Math.round(ends[0]!))}{unit("%")}</>
    : <>{num(Math.round(Math.min(...ends)))}–{num(Math.round(Math.max(...ends)))}{unit("%")}</>;
  const scale = (v: number) => `${Math.min(100, v / 2)}%`;
  const rateMax = Math.max(k.perHour ?? 0, k.remainingPerHour ?? 0);
  const rateBar = (v: number | null) => rateMax > 0 && v != null ? `${(v / rateMax) * 100}%` : "0%";
  const ppHour = (v: number | null) => v == null ? "—" : `${num(v)} ${t("pp/h", "p.p./h")}`;
  const used = k.usedPercent;
  const approx = k.usedEstimated ? "≈" : "";
  const usedValue = used == null ? "—" : <>{approx}{num(Math.round(used))}{unit("%")}</>;
  return (
    <KpiRow columns={4}>
      <Kpi label={t("Used", "Zużyte")} value={usedValue}
        visual={<Track fill={used} tick={active ? k.elapsedPercent : null}
          title={t("Limit used · mark: elapsed window time", "Zużyty limit · kreska: upłynięty czas okna")} />}
        caption={used == null ? t("no percentage for this window", "brak procentu dla tego okna")
          : <>{t("left", "zostało")} {approx}{pct(Math.max(0, 100 - used))}{k.leftNote ? ` ≈ ${k.leftNote}` : ""}</>} />
      <Kpi label={active ? t("Until reset", "Do resetu") : t("Window length", "Długość okna")}
        value={active ? duration(k.remainingHours) : duration(k.elapsedHours)}
        visual={<Track fill={active ? k.elapsedPercent : 100} color="var(--line2)" />}
        caption={active ? <>⟳ {dayTime(k.resetIso)}{k.resetNote ? ` · ${k.resetNote}` : ""}</> : <>{t("ended", "koniec")} {dayTime(k.endedIso)}</>} />
      {active
        ? <Kpi label={t("At reset", "Na reset")} value={endValue} color={riskColor(worst)}
          visual={<Track title={t("Scale 0–200% · mark: the 100% limit", "Skala 0–200% · kreska: limit 100%")}>
            <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", right: 0, background: "var(--crit-soft)", borderRadius: "inherit" }} />
            <div style={{ position: "absolute", top: -4, bottom: -4, width: 2, left: "50%", background: "var(--text)" }} />
            {k.typicalEnd != null && <Dot left={scale(k.typicalEnd)} color="var(--accent)" />}
            {k.linearEnd != null && <Dot left={scale(k.linearEnd)} color="var(--crit)" />}
          </Track>}
          caption={<>
            {k.typicalEnd != null ? <>··· {t("typical", "typowo")} {pct(k.typicalEnd)}</>
              : <span style={{ color: "var(--faint)" }}>··· {t("typical", "typowo")}: {Math.min(k.baselineCount, 2)}/2 {t("windows", "okien")}</span>}
            {"   "}
            {k.linearEnd != null ? <>┅ {t("current pace", "obecne tempo")} {pct(k.linearEnd)}</>
              : <span style={{ color: "var(--faint)" }}>┅ {t("refresh the limit reading", "odśwież odczyt limitu")}</span>}
          </>} />
        : <Kpi label={t("Window result", "Wynik okna")} value={usedValue}
          color={riskColor(used != null && used >= 99.5 ? 100 : null)}
          visual={<Track fill={used} />}
          caption={<>
            {used == null ? "—" : used >= 99.5 ? t("exhausted", "wyczerpany") : `${pct(100 - used)} ${t("unused", "niewykorzystane")}`}
            {k.creditShare != null && k.creditShare > 0 && <div data-credit-share style={{ color: "var(--violet)", marginTop: "var(--s-1)" }}>
              {t("then +{0}% of the window from credits", `potem +${num(Math.round(k.creditShare))}% okna z kredytów`, [num(Math.round(k.creditShare))])}</div>}
          </>} />}
      <Kpi label={t("Pace", "Tempo")}
        value={active ? k.pace == null ? "—" : <>{num(k.pace)}{unit("×")}</> : ppHour(k.perHour)}
        color={active ? paceColor(k.pace) : undefined}
        visual={active ? <div className="mono" style={{ display: "grid", gridTemplateColumns: "56px 1fr 78px", gap: "var(--s-2) var(--s-4)", alignItems: "center", marginTop: "var(--s-4)", fontSize: "var(--fs-3)" }}>
          <span style={{ color: "var(--muted)" }}>{t("now", "teraz")}</span>
          <div style={{ height: 6, borderRadius: "var(--r-bar)", width: rateBar(k.perHour), background: paceColor(k.pace) }} />
          <span>{ppHour(k.perHour)}</span>
          <span style={{ color: "var(--muted)" }}>{t("to last", "starczy")}</span>
          <div style={{ height: 6, borderRadius: "var(--r-bar)", width: rateBar(k.remainingPerHour), background: "var(--accent)" }} />
          <span>{ppHour(k.remainingPerHour)}</span>
        </div> : <Track fill={used == null ? null : Math.min(100, used)} color="var(--line2)" />}
        caption={active ? "" : t("used percentage / window duration", "zużyty procent / długość okna")} />
    </KpiRow>
  );
}

/**
 * The Overview's first block for any vendor: header with observation chips, four headline
 * numbers, the course chart and a right column with counters and this window's traffic.
 */
export function StatusFrame({ title, meta, startIso, endIso, read, chips, strip, kpis, chart, aside }: {
  title: ReactNode; startIso: string | null; endIso: string | null; read: ReactNode;
  /** Only what the context bar and the subscription picker above do not already say, e.g. a closed window's own plan. */
  meta?: ReactNode;
  chips: ReactNode[]; kpis: StatusKpiValues; chart: ReactNode; aside: ReactNode;
  /** The account's credits under the chips; nothing without them. */
  strip?: ReactNode;
}) {
  return (
    <Card frame={false}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--s-6)" }}>
        <div style={{ fontSize: "var(--fs-5)" }}>
          <span className="ui-display" style={{ fontSize: "var(--fs-card-title)", lineHeight: 1.2 }}>{title}</span>
          {meta && <span style={{ color: "var(--muted)" }}> · {meta}</span>}
          <span className="mono" style={{ color: "var(--faint)", fontSize: "var(--fs-3)", marginLeft: "var(--s-6)" }}>
            <When iso={startIso} /> → <When iso={endIso} />
          </span>
        </div>
        <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>{read}</div>
      </div>
      {chips.length > 0 && <div className="mono" style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap", marginTop: "var(--s-4)" }}>{chips}</div>}
      {strip}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px", gap: 22, marginTop: "var(--s-6)" }}>
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr", rowGap: "var(--s-7)", minWidth: 0 }}>
          <StatusKpis k={kpis} />
          {chart}
        </div>
        <aside style={{ display: "flex", flexDirection: "column", gap: "var(--s-8)", borderLeft: "var(--rule)", paddingLeft: 22 }}>{aside}</aside>
      </div>
    </Card>
  );
}

/**
 * Codex Overview's first block: the selected window's counters, both forecasts and its traffic,
 * shown as bars and one course chart instead of repeated tiles.
 */
export function WindowStatusCard({ cycle, insights, account, totals, loading, error, remainingTokens, dailyMedian, ownershipGap, observations = [], accountCredit = null, chartOverride, chartControl }: {
  cycle: CycleView; insights: WindowInsight[]; account: string;
  totals: CycleBreakdownResponse | null; loading: boolean; error: string | null;
  remainingTokens: number | null; dailyMedian: number | null;
  ownershipGap: { samples: number; text: string } | null;
  /** Short observations about recent windows; the full text is the chip's tooltip. */
  observations?: { title: string; body: string; tone: string }[];
  /** The account's credits and the number of the window its balance converts by; null without credit pools. */
  accountCredit?: { account: AccountCredits | null; basisNumber: number | null } | null;
  /** Replaces the course chart; it then carries `chartControl` itself. */
  chartOverride?: ReactNode;
  /** The project picker, at the right end of the chart's unit row. */
  chartControl?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const active = cycle.isActive;
  const insight = insights.find((i) => i.current.windowKey === String(cycle.index) && !i.isSublimit) ?? null;
  const observation = observationOf(cycle);
  const forecast = windowForecast(cycle);
  // A refresh keeps the scope's last totals on screen; useAsync never hands over another scope's data.
  const traffic = windowTrafficSummary(cycle, error ? null : totals);
  const num = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  const missing = error ? t("read failed", "błąd odczytu") : loading && !totals ? t("loading…", "odczyt…") : "—";

  const cached = totals ? Math.max(0, totals.totals.tokens - totals.totals.tokens_fresh) : null;
  const dailyChange = traffic.perDay != null && dailyMedian != null && dailyMedian > 0 ? (traffic.perDay / dailyMedian - 1) * 100 : null;
  const apiPartial = (totals?.unpriced.tokens ?? 0) > 0;
  const missingRate = missingRateIn(totals?.unpriced.models, useMissingRates());
  const credit = totals?.credit_equivalent;
  const credits = credit?.value ?? (credit && credit.priced_credits > 0 ? credit.priced_credits : null);

  const startMs = Date.parse(cycle.raw.window_start_iso ?? cycle.startIso);
  const spanMs = cycle.windowHours * 3_600_000;
  const shownTotals = error ? null : totals;
  const funded = shownTotals?.credit_funded !== undefined ? shownTotals.credit_funded : cycle.raw.credit_funded ?? null;
  const windowTokens = cycle.raw.tokens.total > 0 ? cycle.raw.tokens.total : null;
  const units: UnitInput = { startMs, spanMs, pools: cycle.raw.credit_pools, blocks: shownTotals?.sessions ?? null, usedPercent: observation.percent,
    atLimit: cycle.raw.at_limit, creditFunded: funded, windowTokens,
    counted: { tokens: cycle.raw.tokens.total, usd: cycle.raw.usd, usd_partial: (cycle.raw.unpriced_models?.length ?? 0) > 0,
      credits: cycle.raw.credits?.standard, credits_partial: (cycle.raw.credits?.unpriced_calls ?? 0) > 0 },
    ...(isContextPreviewSelected(shownTotals) ? { dailyUsd:new Map((shownTotals?.days??[]).map(day=>[day.date,day])) } : {}) };
  const creditRows = windowCreditRows({ funded, windowTokens, pools: cycle.raw.credit_pools, account: accountCredit?.account ?? null });
  const chips = [
    ...observations.map((o) => <Chip key={o.title} tone={o.tone} title={o.body}>{o.title}</Chip>),
    ...(ownershipGap ? [<Chip key="ownership" tone="var(--warn)" soft="var(--warn-soft)" title={ownershipGap.text}>
      ⓘ {t("unassigned samples", "próbki bez przypisania")}: {num(ownershipGap.samples)}</Chip>] : []),
  ];

  return (
    <StatusFrame
      title={<>{t("Window", "Okno")} #{cycle.number}</>}
      meta={active ? undefined : cyclePlanDescription(cycle)}
      startIso={cycle.startIso} endIso={active ? cycle.resetIso : cycle.raw.work_to_ts}
      read={<span title={dayTime(observation.end)}>{t("% read", "% odczyt")} {relativeTime(observation.end)}</span>}
      chips={chips}
      strip={<CreditStrip view={creditStripView(accountCredit?.account ?? null)} />}
      kpis={{
        active, usedPercent: cycle.usedPercent, elapsedPercent: cycle.elapsedPercent,
        leftNote: remainingTokens != null ? compact(remainingTokens) : null,
        remainingHours: cycle.remainingHours, elapsedHours: cycle.elapsedHours,
        resetIso: cycle.resetIso, endedIso: cycle.raw.work_to_ts,
        typicalEnd: active ? insight?.forecastPercent ?? null : null, linearEnd: active ? forecast.projected : null,
        baselineCount: insight?.baselineCount ?? 0,
        pace: forecast.pace, perHour: forecast.perHour, remainingPerHour: forecast.remainingPerHour,
        creditShare: funded && windowTokens ? funded.tokens / windowTokens * 100 : null,
      }}
      chart={chartOverride ?? <WindowChart control={chartControl} startMs={startMs} spanMs={spanMs} active={active} insight={insight}
        endMs={active ? Date.parse(cycle.resetIso ?? cycle.endIso) : startMs + spanMs}
        reading={{ t: forecast.elapsedPercent, pct: observation.percent }}
        linearEnd={forecast.projected} exhaustionIso={forecast.exhaustionIso}
        tokensByDay={new Map((shownTotals?.days ?? []).map((d) => [d.date, d.tokens]))}
        units={{ input: units }} />}
      aside={<>
        {/* One counter repeats the Used and Until reset tiles (user, 2026-10-15). */}
        {insights.length > 1 && <div>
          <Eyebrow>{t("Counters", "Liczniki")}</Eyebrow>
          {insights.map((item) => {
            const used = item.current.usedPercent;
            const reset = item.current.resetIso ? Date.parse(item.current.resetIso) : NaN;
            return <div key={item.counterKey} className="mono" style={{ display: "grid", gridTemplateColumns: "56px 1fr 44px 76px", gap: "var(--s-5)", alignItems: "center", marginTop: "var(--s-4)", fontSize: "var(--fs-4)", paddingLeft: item.isSublimit ? 12 : 0 }}>
              <b title={item.isSublimit ? t("Sub-limit with its own denominator", "Podlimit z własnym mianownikiem") : undefined}>{item.label}</b>
              <div style={{ marginTop: -8 }}><Track fill={used} tick={item.current.isCurrent ? item.current.elapsedPercent : null} height={8} /></div>
              <span style={{ fontFamily: "var(--font-figure)", letterSpacing: "var(--ls-tight)" }}>{item.current.percentBasis === "measured" ? "" : "≈"}{pct(used)}</span>
              <span style={{ color: "var(--muted)" }}>{item.current.isCurrent && Number.isFinite(reset)
                ? `⟳ ${duration(Math.max(0, reset - Date.now()) / 3_600_000)}` : t("closed", "zamknięte")}</span>
            </div>;
          })}
        </div>}

        <div>
          {/* The card is this window; the heading only separates the rows from the counters above. */}
          {insights.length > 1 && <Eyebrow>{t("This window", "To okno")}</Eyebrow>}
          <StatRow label={t("tokens", "tokeny")} value={totals ? compact(totals.totals.tokens) : missing}>
            {totals && cached != null && <>
              <Stack parts={[{ value: cached, color: ACCENT_SOFT }, { value: totals.totals.tokens_fresh, color: "var(--accent)" }]} />
              <div style={mini}><span>cache {pct(totals.totals.tokens > 0 ? (cached / totals.totals.tokens) * 100 : null)}</span><span>{compact(totals.totals.tokens_fresh)}</span></div>
            </>}
          </StatRow>
          <StatRow label={t("per day", "na dzień")} value={traffic.perDay == null ? missing : compact(traffic.perDay)}>
            {traffic.perDay != null && dailyMedian != null && <>
              <div style={{ height: 6, borderRadius: "var(--r-bar)", background: "var(--accent)", width: `${(traffic.perDay / Math.max(traffic.perDay, dailyMedian)) * 100}%` }} />
              <div style={{ height: 6, borderRadius: "var(--r-bar)", background: "var(--line2)", marginTop: "var(--s-1)", width: `${(dailyMedian / Math.max(traffic.perDay, dailyMedian)) * 100}%` }} />
              <div style={mini}><span>{signedPct(dailyChange)} {t("vs median", "vs mediana")}</span><span>{compact(dailyMedian)}</span></div>
            </>}
          </StatRow>
          <MachineRow shares={insight?.current.trafficByMachine ?? []} />
          <StatRow label={t("calls", "wywołania")} value={totals ? num(totals.totals.calls) : missing} />
          <StatRow label="API-eq" value={!totals ? missing : missingRate.tokens > 0 && !(totals.totals.usd > 0)
            ? <span style={{ color: "var(--warn)" }} title={missingRateAmountTitle(missingRate.models)}>{t("no price", "brak ceny")}</span>
            : `${apiPartial ? "≥ " : ""}${usd(totals.totals.usd)}`}>
            {missingRate.tokens > 0 && <div data-missing-rate style={{ fontSize: "var(--fs-2)", color: "var(--warn)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={missingRateAmountTitle(missingRate.models)}>{missingRateNote(missingRate.models)}</div>}
            {credits != null && <span style={{ fontSize: "var(--fs-2)", color: "var(--faint)" }}>{(credit?.unpriced_calls ?? 0) > 0 ? "≥ " : ""}{num(credits)} {t("credits", "kredytów")}</span>}
          </StatRow>
          {shownTotals && <CapacityRow percent={observation.percent} usdCapacity={windowCapacity("usd", units)} creditCapacity={windowCapacity("credits", units)}
            basis={accountCredit?.account?.basis && accountCredit.basisNumber !== cycle.number
              ? { number: accountCredit.basisNumber, credits: accountCredit.account.basis.credits } : null} />}
          <WindowCreditsSection rows={creditRows} />
        </div>
      </>}
    />
  );
}

function When({ iso }: { iso: string | null }) {
  return iso ? <time dateTime={iso}>{dayTime(iso)}</time> : <>—</>;
}

function Dot({ left, color }: { left: string; color: string }) {
  return <div style={{ position: "absolute", top: "50%", left, width: 10, height: 10, borderRadius: "var(--r-dot)", transform: "translate(-50%, -50%)", border: "2px solid var(--surface)", background: color }} />;
}
