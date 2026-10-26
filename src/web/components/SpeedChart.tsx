import { useI18n } from "../lib/i18n";
import { useWidth } from "./WindowStatusCard";
import { speedDayAxis } from "../lib/speed-axis";
import { MIN_POINT_CALLS, chartBuckets, joined, outlierSeries, speedScaleMax, speedScaleStep,
  type ModelSpeedSeries, type SpeedKind, type SpeedGrain } from "../lib/model-speed";

export interface SpeedChartRow {
  key: string; label: string; color: string; dash: string | undefined; series: ModelSpeedSeries;
}

// Chart geometry in CSS pixels; the width follows the card.
// Axis text in the figure voice (docs/design/paper-atlas.md, charts).
const TICK = { fontFamily: "var(--font-figure)", fontSize: 10, fill: "var(--muted)" } as const;
const HEIGHT = 340, LEFT = 44, RIGHT = 12, TOP = 10, BOTTOM = 24;

/** `span` is the chosen period (first and last UTC day): the axis covers all of it, so quiet days at its ends stay visible. */
export function SpeedChart({ rows, kind, grain, span, reference, announcement, challenge }: { rows: SpeedChartRow[]; kind: SpeedKind; grain: SpeedGrain; span: [string, string] | null; reference?: { value: number; label: string }; announcement?: { at: string; label: string }; challenge?: { from: string; days: number } }) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(1200);
  const series = rows.map(row => ({ row, points: chartBuckets(row.series.points, grain, kind) })).filter(item => item.points.length);
  const all = series.flatMap(item => item.points);
  // The measured wrapper stays mounted whatever it shows, so its width keeps being observed.
  if (!all.length) {
    return <div ref={ref} className="speed-chart"><div className="archive-empty" style={{ marginTop: 10 }}>
      {t("No visible model has a bucket with at least {0} calls of this kind.", `Żaden widoczny model nie ma przedziału z co najmniej ${MIN_POINT_CALLS} wywołaniami tego rodzaju.`, [MIN_POINT_CALLS])}
    </div></div>;
  }
  // A model far faster than the rest (codex-spark) would flatten every other line: it is drawn clipped at the top.
  const outlier = outlierSeries(series.map(item => ({ key: item.row.key, values: item.points.map(point => point.speed) })));
  const values = series.filter(item => item.row.key !== outlier?.key).flatMap(item => item.points.map(point => point.speed));
  const max = speedScaleMax(reference && Number.isFinite(reference.value) && reference.value > 0 ? [...values, reference.value] : values);
  const step = speedScaleStep(max);
  const times = [...all.map(point => point.at), ...(span ?? [])].map(at => Date.parse(`${at}T00:00:00Z`));
  const x0 = Math.min(...times), x1 = Math.max(...times);
  const x = (at: string) => LEFT + (x1 === x0 ? 0.5 : (Date.parse(`${at}T00:00:00Z`) - x0) / (x1 - x0)) * (width - LEFT - RIGHT);
  const bottom = challenge ? BOTTOM + 18 : BOTTOM;
  const y = (value: number) => TOP + (1 - Math.min(value, max) / max) * (HEIGHT - TOP - bottom);
  const gridValues = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const axis = speedDayAxis(new Date(x0).toISOString().slice(0, 10), new Date(x1).toISOString().slice(0, 10), width - LEFT - RIGHT, challenge);
  const oneDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const outlierRow = outlier ? series.find(item => item.row.key === outlier.key)!.row : null;
  return (
    <div ref={ref} className="speed-chart" style={{ minWidth: 0, overflow: "hidden" }}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img" aria-label={t("Speed over time", "Prędkość w czasie")}>
        {gridValues.map(value => <g key={value}>
          <line x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeDasharray="3 4" />
          <text x={LEFT - 6} y={y(value) + 3} textAnchor="end" {...TICK}>{value}</text>
        </g>)}
        {axis.ticks.map(tick => <line key={tick.at} x1={x(tick.at)} x2={x(tick.at)} y1={HEIGHT - bottom} y2={HEIGHT - bottom + 4} stroke="var(--pencil)" />)}
        {axis.labels.map((tick, index) => <g key={tick.at}>
          <text x={x(tick.at)} y={HEIGHT - bottom + 16} textAnchor={index === 0 ? "start" : index === axis.labels.length - 1 ? "end" : "middle"} {...TICK}><title>{tick.at}</title>{tick.label}</text>
          {tick.day !== null && <text x={x(tick.at)} y={HEIGHT - 6} textAnchor={index === axis.labels.length - 1 ? "end" : "middle"} {...TICK}>{t("D{0}", `D${tick.day}`, [tick.day])}</text>}
        </g>)}
        {reference && Number.isFinite(reference.value) && reference.value > 0 && <g>
          <line x1={LEFT} x2={width - RIGHT} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--warn)" strokeDasharray="6 4" />
          <text x={width - RIGHT} y={Math.max(TOP + 12, y(reference.value) - 6)} textAnchor="end" {...TICK}>{reference.label}</text>
        </g>}
        {announcement && announcement.at >= new Date(x0).toISOString().slice(0, 10) && announcement.at <= new Date(x1).toISOString().slice(0, 10) && <g>
          <line x1={x(announcement.at)} x2={x(announcement.at)} y1={TOP} y2={HEIGHT - bottom} stroke="var(--pencil)" strokeDasharray="3 4" />
          <text x={Math.max(LEFT, Math.min(width - RIGHT, x(announcement.at)))} y={TOP + 25} textAnchor={x(announcement.at) > width / 2 ? "end" : "start"} {...TICK}>{announcement.label}</text>
        </g>}
        {series.map(({ row, points }) => {
          const path = points.map((point, i) => `${i && joined(points[i - 1]!.at, point.at, grain) ? "L" : "M"}${x(point.at).toFixed(1)},${y(point.speed).toFixed(1)}`).join("");
          return <g key={row.key}>
            <path d={path} fill="none" stroke={row.color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap={row.dash ? "butt" : "round"} strokeDasharray={row.dash} />
            {points.map(point => <g key={point.at} className="speed-point">
              <title>{`${row.label}\n${grain === "week" ? t("week of {0}", `tydzień od ${point.at}`, [point.at]) : point.at}\n${oneDecimal.format(point.speed)} tok/s\n${
                kind === "long" ? t("{0} long calls", `${whole.format(point.n)} długich wywołań`, [whole.format(point.n)]) : t("{0} calls", `${whole.format(point.n)} wywołań`, [whole.format(point.n)])
              } · ${t("measured", "zmierzone")} ${point.calls ? whole.format(point.timed / point.calls * 100) : "—"}%`}</title>
              <circle cx={x(point.at)} cy={y(point.speed)} r={7} fill="transparent" />
              <circle cx={x(point.at)} cy={y(point.speed)} r={points.length > 40 ? 1.6 : 2.6} fill={row.color} />
            </g>)}
          </g>;
        })}
        {outlier && outlierRow && <text x={width - RIGHT} y={TOP + 8} textAnchor="end" {...TICK} fontFamily="var(--font-sans)">
          {t("{0} ≈ {1} tok/s · above the scale ↑", `${outlierRow.label} ≈ ${whole.format(outlier.median)} tok/s · ponad skalą ↑`, [outlierRow.label, whole.format(outlier.median)])}
        </text>}
        <text x={LEFT} y={TOP + 2} dx={4} dy={6} {...TICK}>tok/s</text>
      </svg>
    </div>
  );
}
