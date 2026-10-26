import { calendarTimeTicks } from "../lib/chart-dates";
import { useWidth } from "./WindowStatusCard";
import { ChartExport } from "./ChartExport";
import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { CapacityCycleMetric, CapacityMeterPoint, CapacityUsagePoint } from "../../shared/capacity-cycle";
import { bucketCycleUsage, cycleMetricValue, resolutionMinutes, type TimeRange } from "../lib/capacity-cycle";
import { useI18n } from "../lib/i18n";

const WIDTH = 900, LEFT = 68, RIGHT = 56, PLOT = WIDTH - LEFT - RIGHT;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function CapacityCycleChart({ points, readings, range, minutes, metric, unit }: {
  points: CapacityUsagePoint[]; readings: CapacityMeterPoint[]; range: TimeRange;
  minutes: number; metric: CapacityCycleMetric; unit: string;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const [chartRef,chartWidth] = useWidth(WIDTH);
  const buckets = bucketCycleUsage(points, range, minutes);
  const max = buckets.reduce((max, b) => Math.max(max, cycleMetricValue(b.usage, metric) ?? 0), 0) || 1;
  const meter = readings.filter(p => p.ts >= range.from && p.ts <= range.to);
  const x = (time: number) => LEFT + (time - range.from) / (range.to - range.from) * PLOT;
  const format = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  const date = (time: number) => new Date(time).toISOString().replace("T", " ").slice(0, 19);
  return <ChartExport title={t("Cycle usage", "Zużycie w cyklu")}><div ref={chartRef}><figure className="capacity-cycle-chart">
    <figcaption><span>{unit} · {t("recorded usage", "zapisane zużycie")}</span><span>{t("Account meter", "Licznik konta")} %</span></figcaption>
    <svg viewBox={`0 0 ${WIDTH} 270`} role="img" aria-labelledby={id}>
      <title id={id}>{t("Usage bars and account percentage readings in the selected time range", "Słupki zużycia i odczyty procentowe konta w wybranym czasie")}</title>
      {[0, 0.5, 1].map(f => <g key={f}>
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={218 - f * 190} y2={218 - f * 190} stroke="var(--line)" strokeDasharray="3 4" />
        <text x={LEFT - 9} y={222 - f * 190} textAnchor="end">{(max * f).toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 })}</text>
        <text x={WIDTH - RIGHT + 9} y={222 - f * 190}>{f * 100}%</text>
      </g>)}
      {buckets.map(b => {
        const value = cycleMetricValue(b.usage, metric), height = value === null ? 4 : Math.max(value > 0 ? 1 : 0, value / max * 190);
        const partial = metric !== "tokens" && b.usage.unpriced_events > 0;
        return <rect key={b.from} x={x(b.from) + 0.5} y={218 - height} width={Math.max(0.5, x(b.to) - x(b.from) - 1)} height={height}
          fill={partial ? "var(--muted)" : "var(--accent)"} opacity={value === null ? 0.5 : 0.8}>
          <title>{date(b.from)} → {date(b.to)} UTC{"\n"}{value === null ? t("Missing prices", "Brak wyceny") : `${partial ? "≥ " : ""}${format(value)} ${unit}`}{"\n"}{b.usage.events} {t("events", "zdarzeń")}{partial ? ` · ${b.usage.unpriced_events} ${t("unpriced", "bez wyceny")}` : ""}</title>
        </rect>;
      })}
      {meter.slice(1).map((p, i) => <line key={`${p.ts}-${i}`} x1={x(meter[i]!.ts)} y1={218 - meter[i]!.percent * 1.9}
        x2={x(p.ts)} y2={218 - p.percent * 1.9} stroke="var(--warn)" strokeWidth={1.75} strokeLinecap="round"
        strokeDasharray={p.ts - meter[i]!.ts > 7200000 ? "5 5" : undefined} />)}
      {meter.map((p, i) => <circle key={`${p.ts}-${i}`} cx={x(p.ts)} cy={218 - p.percent * 1.9} r={3} fill="var(--warn)">
        <title>{date(p.ts)} UTC · {format(p.percent)}% · {p.source === "manual" ? t("manual reading", "pomiar ręczny") : p.source === "session" ? t("session reading", "odczyt sesji") : t("account reading", "pomiar konta")}</title>
      </circle>)}
      {calendarTimeTicks(range.from,range.to,Math.min(chartWidth,WIDTH)*PLOT/WIDTH,locale).map(tick => <text key={tick.time} x={x(tick.time)} y={247} style={{ fontSize: `calc(var(--fs-2) * ${WIDTH / Math.min(chartWidth, WIDTH)})` }} textAnchor={tick.time===range.from?"start":tick.time===range.to?"end":"middle"}><title>{date(tick.time)} UTC</title>{tick.label}</text>)}
    </svg>
    <p>{t("UTC · Hover for exact values. Lines connect recorded meter readings; dashed segments mark gaps over 2 h.", "UTC · Najedź, aby zobaczyć dokładne wartości. Linia łączy zapisane odczyty; odcinki przerywane oznaczają przerwy powyżej 2 h.")}</p>
  </figure></div></ChartExport>;
}

export function CapacityCycleBrush({ points, bounds, range, metric, onChange }: {
  points: CapacityUsagePoint[]; bounds: TimeRange; range: TimeRange; metric: CapacityCycleMetric; onChange: (range: TimeRange) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const drag = useRef<{ edge: "from" | "to" | "new"; anchor: number; initial: TimeRange } | null>(null);
  const buckets = bucketCycleUsage(points, bounds, resolutionMinutes(bounds, "auto"));
  const max = buckets.reduce((max, b) => Math.max(max, cycleMetricValue(b.usage, metric) ?? 0), 0) || 1;
  const x = (time: number) => LEFT + (time - bounds.from) / (bounds.to - bounds.from) * PLOT;
  const format = (time: number) => new Date(time).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  function timeAt(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = ((e.clientX - rect.left) / rect.width * WIDTH - LEFT) / PLOT;
    return clamp(Math.round((bounds.from + ratio * (bounds.to - bounds.from)) / 60000) * 60000, bounds.from, bounds.to);
  }
  function move(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    const time = timeAt(e);
    if (d.edge === "from") onChange({ from: Math.min(time, d.initial.to - 1000), to: d.initial.to });
    else if (d.edge === "to") onChange({ from: d.initial.from, to: Math.max(time, d.initial.from + 1000) });
    else if (time !== d.anchor) onChange({ from: Math.min(time, d.anchor), to: Math.max(time, d.anchor) });
  }
  function keyMove(e: KeyboardEvent<SVGRectElement>, edge: "from" | "to") {
    const direction = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!direction && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const min = edge === "from" ? bounds.from : range.from + 1000;
    const max = edge === "to" ? bounds.to : range.to - 1000;
    const value = e.key === "Home" ? min : e.key === "End" ? max : clamp(range[edge] + direction * (e.shiftKey ? 300000 : 60000), min, max);
    onChange({ ...range, [edge]: value });
  }
  return <div className="capacity-cycle-brush">
    <p id={id}>{t("Select time on the cycle chart below. Drag a new selection or either handle. Arrow keys move a focused handle by 1 min (Shift: 5 min).", "Zaznacz czas na wykresie cyklu poniżej. Przeciągnij nowe zaznaczenie lub jego uchwyty. Strzałki przesuwają aktywny uchwyt o 1 min (Shift: 5 min).")}</p>
    <svg viewBox={`0 0 ${WIDTH} 108`} role="group" aria-label={t("Cycle time selection", "Wybór czasu w cyklu")} aria-describedby={id}
      onPointerDown={e => {
        if (e.button !== 0) return;
        const target = e.target as Element;
        let edge = target.closest("[data-edge]")?.getAttribute("data-edge");
        const anchor = timeAt(e);
        if (!edge) {
          const nearest = Math.abs(anchor - range.from) < Math.abs(anchor - range.to) ? "from" : "to";
          if (Math.abs(x(anchor) - x(range[nearest])) <= 14) edge = nearest;
        }
        drag.current = { edge: edge === "from" || edge === "to" ? edge : "new", anchor, initial: range };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={move} onPointerUp={e => { move(e); drag.current = null; }}
      onPointerCancel={() => { if (drag.current) onChange(drag.current.initial); drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}>
      <rect x={LEFT} y={10} width={PLOT} height={66} fill="var(--sunk)" />
      {buckets.map(b => <rect key={b.from} x={x(b.from)} y={72 - (cycleMetricValue(b.usage, metric) ?? 0) / max * 56}
        width={Math.max(0.5, x(b.to) - x(b.from) - 1)} height={(cycleMetricValue(b.usage, metric) ?? 0) / max * 56} fill="var(--accent)" opacity={0.45} />)}
      <rect x={x(range.from)} y={9} width={x(range.to) - x(range.from)} height={68} fill="var(--accent)" fillOpacity={0.12} stroke="var(--accent)" />
      {(["from", "to"] as const).map(edge => <rect key={edge} data-edge={edge} x={x(range[edge]) - 7} y={8} width={14} height={70} rx={4}
        fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} role="slider" tabIndex={0} aria-orientation="horizontal"
        aria-label={edge === "from" ? t("Selection start", "Początek zaznaczenia") : t("Selection end", "Koniec zaznaczenia")}
        aria-valuemin={edge === "from" ? 0 : (range.from - bounds.from) / 1000 + 1} aria-valuemax={((edge === "to" ? bounds.to : range.to - 1000) - bounds.from) / 1000}
        aria-valuenow={(range[edge] - bounds.from) / 1000} aria-valuetext={format(range[edge])} onKeyDown={e => keyMove(e, edge)}>
        <title>{format(range[edge])}</title>
      </rect>)}
      <text x={LEFT} y={100}>{format(bounds.from).slice(0, 16)}</text>
      <text x={WIDTH - RIGHT} y={100} textAnchor="end">{format(bounds.to).slice(0, 16)} UTC</text>
    </svg>
  </div>;
}
