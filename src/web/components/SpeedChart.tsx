import { useI18n } from "../lib/i18n";
import { useWidth } from "./WindowStatusCard";
import { speedDayAxis } from "../lib/speed-axis";
import { MIN_POINT_CALLS, modelChartBuckets, joined, latencyAxis, leadingStrays, outlierSeries, speedScaleMax, speedScaleStep,
  type ModelSpeedSeries, type SpeedKind, type SpeedGrain, type SpeedChartMetric, type SpeedYScale } from "../lib/model-speed";

export interface SpeedChartRow {
  key: string; label: string; color: string; dash: string | undefined; series: ModelSpeedSeries;
}

// Chart geometry in CSS pixels; the width follows the card.
// Axis text in the figure voice (docs/design/paper-atlas.md, charts).
const TICK = { fontFamily: "var(--font-figure)", fontSize: 10, fill: "var(--muted)" } as const;
const HEIGHT = 340, LEFT = 44, RIGHT = 12, TOP = 10, BOTTOM = 24;
/** Room above the plot for the values of first-token points beyond the capped scale. */
const CAPPED_TOP = 30, CAP_LABEL_GAP = 34;
/** Day labels closer than this collide ("30.0882.06"): the later one goes, except the last, which replaces its neighbour. */
const DAY_LABEL_GAP = 46;

/**
 * `span` is the chosen period (first and last UTC day): the axis covers all of it, so quiet days at its ends stay visible.
 * Without a period a few stray points before a long silent gap stay off the axis and are named instead. `yScale` applies
 * to every metric; `highlight` picks one line out and dims the rest.
 */
export function SpeedChart({ rows, kind, grain, span, reference, announcement, challenge, metric = "speed", yScale = "full", highlight = null }: { rows: SpeedChartRow[]; kind: SpeedKind; grain: SpeedGrain; span: [string, string] | null; reference?: { value: number; label: string }; announcement?: { at: string; label: string }; challenge?: { from: string; days: number }; metric?: SpeedChartMetric; yScale?: SpeedYScale; highlight?: string | null }) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(1200);
  const latency = metric !== "speed", chartUnit = latency ? "s" : "tok/s";
  const chartTitle = latency ? t("Time to first token", "Czas do pierwszego tokena") : t("Speed over time", "Prędkość w czasie");
  const buckets = rows.map(row => ({ row, points: modelChartBuckets(row.series.points, grain, kind, metric) }));
  const strays = span === null ? leadingStrays(buckets.flatMap(item => item.points.map(point => point.at))) : null;
  const series = buckets.map(item => strays ? { ...item, points: item.points.filter(point => point.at >= strays.from) } : item)
    .filter(item => item.points.length);
  const all = series.flatMap(item => item.points);
  // The measured wrapper stays mounted whatever it shows, so its width keeps being observed.
  if (!all.length) {
    return <div ref={ref} className="speed-chart"><div className="archive-empty" style={{ marginTop: 10 }}>
      {latency ? t("No verified first-token measurements in this selection.", "Brak pewnych pomiarów pierwszego tokena w tym wyborze.")
        : t("No visible model has a bucket with at least {0} calls of this kind.", `Żaden widoczny model nie ma przedziału z co najmniej ${MIN_POINT_CALLS} wywołaniami tego rodzaju.`, [MIN_POINT_CALLS])}
    </div></div>;
  }
  // On the capped tok/s scale a model far faster than the rest (codex-spark) would flatten every other line: it is drawn clipped at the top.
  const outlier = latency || yScale !== "capped" ? null : outlierSeries(series.map(item => ({ key: item.row.key, values: item.points.map(point => point.value) })));
  const values = series.filter(item => item.row.key !== outlier?.key).flatMap(item => item.points.map(point => point.value));
  const withReference = reference && Number.isFinite(reference.value) && reference.value > 0 ? [...values, reference.value] : values;
  const axisScale = latency ? latencyAxis(values, yScale) : yScale === "log" ? latencyAxis(withReference, "log") : null;
  const max = axisScale ? axisScale.max : speedScaleMax(yScale === "full" ? [Math.max(...withReference)] : withReference);
  const step = speedScaleStep(max);
  // Points beyond a capped scale: a marker with the value at the top edge, never a flattened chart. The clipped outlier
  // model is named once instead of counted point by point.
  const above = yScale === "capped" ? series.filter(item => item.row.key !== outlier?.key)
    .flatMap(({ row, points }) => points.filter(point => point.value > max).map(point => ({ row, point }))) : [];
  const top = above.length ? CAPPED_TOP : TOP;
  const times = [...all.map(point => point.at), ...(span ?? [])].map(at => Date.parse(`${at}T00:00:00Z`));
  const x0 = Math.min(...times), x1 = Math.max(...times);
  const x = (at: string) => LEFT + (x1 === x0 ? 0.5 : (Date.parse(`${at}T00:00:00Z`) - x0) / (x1 - x0)) * (width - LEFT - RIGHT);
  const bottom = challenge ? BOTTOM + 18 : BOTTOM;
  const y = (value: number) => {
    const share = axisScale?.log ? (Math.log10(Math.max(value, axisScale.min)) - Math.log10(axisScale.min)) / (Math.log10(max) - Math.log10(axisScale.min))
      : Math.min(value, max) / max;
    return top + (1 - Math.min(share, 1)) * (HEIGHT - top - bottom);
  };
  const gridValues = axisScale ? axisScale.ticks : Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  let lastLabel = -Infinity;
  const labelled = new Set(above.slice().sort((a, b) => x(a.point.at) - x(b.point.at)).filter(({ point }) => {
    if (x(point.at) - lastLabel < CAP_LABEL_GAP) return false;
    lastLabel = x(point.at); return true;
  }).map(({ point }) => point));
  const axis = speedDayAxis(new Date(x0).toISOString().slice(0, 10), new Date(x1).toISOString().slice(0, 10), width - LEFT - RIGHT, challenge);
  const dayLabels = axis.labels.reduce<typeof axis.labels>((kept, tick, index) => {
    const last = index === axis.labels.length - 1;
    while (kept.length && x(tick.at) - x(kept.at(-1)!.at) < DAY_LABEL_GAP) { if (!last || kept.length === 1) return kept; kept.pop(); }
    return [...kept, tick];
  }, []);
  const oneDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const outlierRow = outlier ? series.find(item => item.row.key === outlier.key)!.row : null;
  return (
    <div ref={ref} className="speed-chart" style={{ minWidth: 0, overflow: "hidden" }}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img" aria-label={chartTitle}>
        {gridValues.map(value => <g key={value}>
          <line x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeDasharray="3 4" />
          <text x={LEFT - 6} y={y(value) + 3} textAnchor="end" {...TICK}>{latency ? seconds.format(value) : value}</text>
        </g>)}
        {axis.ticks.map(tick => <line key={tick.at} x1={x(tick.at)} x2={x(tick.at)} y1={HEIGHT - bottom} y2={HEIGHT - bottom + 4} stroke="var(--pencil)" />)}
        {dayLabels.map((tick, index) => <g key={tick.at}>
          <text x={x(tick.at)} y={HEIGHT - bottom + 16} textAnchor={index === 0 ? "start" : index === dayLabels.length - 1 ? "end" : "middle"} {...TICK}><title>{tick.at}</title>{tick.label}</text>
          {tick.day !== null && <text x={x(tick.at)} y={HEIGHT - 6} textAnchor={index === dayLabels.length - 1 ? "end" : "middle"} {...TICK}>{t("D{0}", `D${tick.day}`, [tick.day])}</text>}
        </g>)}
        {reference && Number.isFinite(reference.value) && reference.value > 0 && <g>
          <line x1={LEFT} x2={width - RIGHT} y1={y(reference.value)} y2={y(reference.value)} stroke="var(--warn)" strokeDasharray="6 4" />
          <text x={width - RIGHT} y={Math.max(TOP + 12, y(reference.value) - 6)} textAnchor="end" {...TICK}>{reference.label}</text>
        </g>}
        {announcement && announcement.at >= new Date(x0).toISOString().slice(0, 10) && announcement.at <= new Date(x1).toISOString().slice(0, 10) && <g>
          <line x1={x(announcement.at)} x2={x(announcement.at)} y1={TOP} y2={HEIGHT - bottom} stroke="var(--pencil)" strokeDasharray="3 4" />
          <text x={Math.max(LEFT, Math.min(width - RIGHT, x(announcement.at)))} y={TOP + 25} textAnchor={x(announcement.at) > width / 2 ? "end" : "start"} {...TICK}>{announcement.label}</text>
        </g>}
        {[...series].sort((a, b) => Number(a.row.key === highlight) - Number(b.row.key === highlight)).map(({ row, points }) => {
          const dim = highlight !== null && row.key !== highlight;
          const path = points.map((point, i) => `${i && joined(points[i - 1]!.at, point.at, grain) ? "L" : "M"}${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
          return <g key={row.key} opacity={dim ? 0.15 : 1}>
            <path d={path} fill="none" stroke={row.color} strokeWidth={row.key === highlight ? 2.5 : 1.75} strokeLinejoin="round" strokeLinecap={row.dash ? "butt" : "round"} strokeDasharray={row.dash} />
            {points.map(point => <g key={point.at} className="speed-point">
              <title>{`${row.label}\n${grain === "week" ? t("week of {0}", `tydzień od ${point.at}`, [point.at]) : point.at}\n${oneDecimal.format(point.value)} ${chartUnit}\n${
                latency ? t("{0} measured turns", `${whole.format(point.n)} zmierzonych tur`, [whole.format(point.n)])
                  : kind === "long" ? t("{0} long calls", `${whole.format(point.n)} długich wywołań`, [whole.format(point.n)]) : t("{0} calls", `${whole.format(point.n)} wywołań`, [whole.format(point.n)])
              } · ${t("measured", "zmierzone")} ${point.total ? whole.format(point.measured / point.total * 100) : "—"}%`}</title>
              <circle cx={x(point.at)} cy={y(point.value)} r={7} fill="transparent" />
              {point.value > max && !axisScale?.log ? <>
                <path d={`M${x(point.at) - 5},${top + 1}L${x(point.at) + 5},${top + 1}L${x(point.at)},${top - 7}Z`} fill="var(--warn)" stroke={row.color} strokeWidth={1.2} />
                {labelled.has(point) && <text x={x(point.at)} y={top - 11} textAnchor="middle" {...TICK} fill="var(--text)">{whole.format(point.value)}{latency ? " s" : ""}</text>}
              </> : <circle cx={x(point.at)} cy={y(point.value)} r={points.length > 40 ? 1.6 : 2.6} fill={row.color} />}
            </g>)}
          </g>;
        })}
        {outlier && outlierRow && <text x={width - RIGHT} y={TOP + 8} textAnchor="end" {...TICK} fontFamily="var(--font-sans)">
          {t("{0} ≈ {1} tok/s · above the scale ↑", `${outlierRow.label} ≈ ${whole.format(outlier.median)} tok/s · ponad skalą ↑`, [outlierRow.label, whole.format(outlier.median)])}
        </text>}
        {above.length > 0 && <line x1={LEFT} x2={width - RIGHT} y1={top} y2={top} stroke="var(--warn)" strokeDasharray="2 3" />}
        <text x={LEFT} y={top + 2} dx={4} dy={6} {...TICK}>{chartUnit}</text>
      </svg>
      {(above.length > 0 || strays) && <div className="speed-chart-note">
        {above.length > 0 && t("▲ above {1}: {0}", `▲ powyżej ${seconds.format(max)} ${chartUnit}: ${above.length}`, [above.length, `${seconds.format(max)} ${chartUnit}`])}
        {above.length > 0 && strays && " · "}
        {strays && t("◂ off the axis: {0} from {1}", `◂ poza osią: ${strays.count} od ${strays.earliest}`, [strays.count, strays.earliest])}
      </div>}
    </div>
  );
}
