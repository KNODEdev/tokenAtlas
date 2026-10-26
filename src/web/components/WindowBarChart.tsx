import { ChartExport } from "./ChartExport";
import { useI18n } from "../lib/i18n";
import { useWidth } from "./WindowStatusCard";
import { separatedLabels, textWidth } from "./CapacityHistoryChart";
import "../screens/History.css";

export interface WindowBar {
  key: string;
  /** Usage at the end (or the latest reading), or the value on the chart's `scale`; null draws a dashed frame: the window has no value. */
  percent: number | null;
  color: string;
  current?: boolean;
  /** Last reading before the window ended: drawn lighter. */
  dim?: boolean;
  /** A sublimit's percentage in the same window, drawn as a diamond. */
  sub?: number | null;
  /** Era band text (main model or plan); consecutive equal values share one band. */
  band?: string | null;
  /** Value of the lane under the bars (duration or tokens); null leaves it empty. */
  lane?: number | null;
  laneColor?: string;
  title: string;
}

// Chart geometry in CSS pixels; the right gutter holds the median and end labels.
const X0 = 44, RIGHT_GUTTER = 96, BAND_H = 16, PLOT_H = 140, LANE_GAP = 16, LANE_H = 36, TICK_H = 16, END_FONT = 11, TICK_FONT = 10, LABEL_FONT = 11;

/** The first label that fits `room` pixels, or none; the chart font is monospace. */
export function fittingLabel(candidates: string[], room: number, fontSize: number): string | null {
  return candidates.find((text) => textWidth(text, fontSize) <= room) ?? null;
}

/** The window axis: one slot per window, oldest on the left. Charts drawn under each other share it. */
export function windowAxis(width: number, count: number) {
  const x1 = width - RIGHT_GUTTER, step = (x1 - X0) / Math.max(1, count);
  const barWidth = Math.max(3, Math.min(26, step - 3));
  return { x0: X0, x1, step, barWidth, center: (i: number) => X0 + i * step + step / 2 };
}

/** In axis order, keeps each tick text that does not run into the tick kept before it. */
export function spacedTicks(ticks: Array<{ center: number; text: string | null }>, fontSize = TICK_FONT): boolean[] {
  const present = ticks.map((tick) => tick.text !== null);
  const kept = separatedLabels(ticks.filter((tick) => tick.text !== null).map(({ center, text }) => {
    const half = textWidth(text!, fontSize) / 2 + 3;
    return { left: center - half, right: center + half, top: 0, bottom: 1 };
  }));
  let next = 0;
  return present.map((has) => has && kept[next++]!);
}

/**
 * One bar per window, oldest on the left, with an optional era band, lane and typical-end line.
 * Without `scale` a bar is a percentage of the limit; with it, a value up to `scale.max`.
 */
export function WindowBarChart({ bars, median, laneMax, laneLabel, laneNote, endLabel, labels, scale, tick, onSelect }: {
  bars: WindowBar[];
  /** A label list is read longest first; the first that fits the gutter is drawn. */
  median: { value: number; label: string | string[] } | null;
  laneMax?: number;
  laneLabel?: string;
  laneNote?: string;
  /** The newest window's label in the right gutter, longest first; the first that fits is drawn. */
  endLabel?: { candidates: string[]; color: string } | null;
  /** Texts above single bars in priority order; one that would overlap a kept one is left out. */
  labels?: Array<{ index: number; text: string }>;
  scale?: { max: number; format: (value: number) => string };
  tick: (bar: WindowBar, index: number) => string | null;
  onSelect?: (bar: WindowBar) => void;
}) {
  const { t } = useI18n();
  const [ref, width] = useWidth(1200);
  const hasBand = bars.some((bar) => bar.band !== undefined);
  const hasLane = laneMax != null && laneMax > 0 && bars.some((bar) => bar.lane != null);
  const top = hasBand ? BAND_H + 14 : 14, y100 = top + 10, y0 = y100 + PLOT_H, lane = y0 + LANE_GAP;
  const height = (hasLane ? lane + LANE_H : y0) + TICK_H + 6;
  const { x1, step, barWidth, center } = windowAxis(width, bars.length);
  const x = (i: number) => center(i) - barWidth / 2;
  const level = (value: number) => (scale ? (value / scale.max) * 100 : value);
  const y = (p: number) => y0 - (Math.min(Math.max(p, 0), 100) / 100) * (y0 - y100);
  const bands: Array<{ from: number; to: number; text: string | null }> = [];
  if (hasBand) {
    let start = 0;
    for (let i = 1; i <= bars.length; i++) {
      if (i < bars.length && bars[i]!.band === bars[start]!.band) continue;
      bands.push({ from: start, to: i, text: bars[start]!.band ?? null });
      start = i;
    }
  }
  const last = bars.at(-1);
  const medianText = median && (Array.isArray(median.label) ? fittingLabel(median.label, width - (x1 + 8) - 2, 11) : median.label);
  const ticks = bars.map((bar, i) => ({ center: center(i), text: tick(bar, i) }));
  const keptTicks = spacedTicks(ticks);
  const barLabels = (labels ?? []).flatMap(({ index, text }) => {
    const value = bars[index]?.percent;
    if (value == null) return [];
    const half = textWidth(text, LABEL_FONT) / 2, cx = Math.min(Math.max(center(index), X0 + half), x1 - half), base = y(level(value)) - 5;
    return [{ text, cx, base, box: { left: cx - half - 2, right: cx + half + 2, top: base - LABEL_FONT, bottom: base + 2 } }];
  });
  const keptLabels = separatedLabels(barLabels.map((label) => label.box));
  return (
    <ChartExport title={t("Windows over time", "Okna w czasie")}><div ref={ref} className="archive-chart" style={{ minWidth: 0, overflow: "hidden" }}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={t("One bar per window", "Jeden słupek na okno")} style={{ fontFamily: "var(--font-figure)" }}>
        {[25, 50, 75].map((p) => <line key={p} x1={X0} x2={x1} y1={y(p)} y2={y(p)} stroke="var(--line)" strokeDasharray="3 4" />)}
        {scale ? <>
          <line x1={X0} x2={x1} y1={y(100)} y2={y(100)} stroke="var(--line)" strokeDasharray="3 4" />
          <text x={X0 - 8} y={y(100) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{scale.format(scale.max)}</text>
          <text x={X0 - 8} y={y(50) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{scale.format(scale.max / 2)}</text>
        </> : <>
          <line x1={X0} x2={x1} y1={y(100)} y2={y(100)} stroke="var(--text)" strokeWidth={1.3} />
          <text x={X0 - 8} y={y(100) + 4} textAnchor="end" fontSize={10} fontWeight={500} fill="var(--text)">100%</text>
          <text x={X0 - 8} y={y(50) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">50%</text>
        </>}
        <line x1={X0} x2={x1} y1={y0} y2={y0} stroke="var(--line2)" />
        {bands.map(({ from, to, text }) => {
          const a = X0 + from * step + 1, b = X0 + to * step - 1;
          const label = text ?? "—";
          return <g key={from}>
            <title>{label}</title>
            <rect x={a} y={4} width={Math.max(1, b - a)} height={BAND_H} rx={3} fill={text ? "var(--sunk)" : "none"} stroke="var(--line)" />
            {b - a > textWidth(label, 10) + 8 && <text x={(a + b) / 2} y={15.5} textAnchor="middle" fontSize={10} fill="var(--muted)">{label}</text>}
          </g>;
        })}
        {bars.map((bar, i) => {
          const select = onSelect ? () => onSelect(bar) : undefined;
          const top = bar.percent != null ? y(level(bar.percent)) : null;
          return (
            <g key={bar.key} className={onSelect ? "archive-bar" : undefined} tabIndex={onSelect ? 0 : undefined} role={onSelect ? "button" : undefined}
              aria-label={onSelect ? bar.title : undefined} onClick={select}
              onKeyDown={select ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } } : undefined}>
              <title>{bar.title}</title>
              {top != null ? <>
                <rect x={x(i)} y={top} width={barWidth} height={Math.max(1.5, y0 - top)} rx={2} fill={bar.color} opacity={bar.dim ? 0.55 : 1} />
                {bar.current && <rect x={x(i) - 2} y={top - 2} width={barWidth + 4} height={y0 - top + 4} rx={3} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 2" />}
              </> : <rect x={x(i)} y={y(100)} width={barWidth} height={y0 - y(100)} rx={2} fill="none" stroke="var(--line2)" strokeDasharray="3 3" />}
              {bar.sub != null && <path d={`M${x(i) + barWidth / 2},${y(bar.sub) - 5}l5,5l-5,5l-5,-5z`} fill="var(--violet)" stroke="var(--surface)" strokeWidth={1} />}
              {hasLane && bar.lane != null && (() => {
                const h = (Math.min(bar.lane, laneMax!) / laneMax!) * LANE_H;
                return <rect x={x(i)} y={lane + LANE_H - h} width={barWidth} height={Math.max(1, h)} rx={1.5} fill={bar.laneColor ?? "var(--line2)"} />;
              })()}
              {/* A transparent hit area so thin and missing bars stay clickable. */}
              {onSelect && <rect x={X0 + i * step} y={y100} width={step} height={(hasLane ? lane + LANE_H : y0) - y100} fill="transparent" />}
            </g>
          );
        })}
        {barLabels.map((label, i) => keptLabels[i] && <text key={i} x={label.cx} y={label.base} textAnchor="middle" fontSize={LABEL_FONT} fontWeight={500} fill="var(--text)" pointerEvents="none">{label.text}</text>)}
        {median && <g pointerEvents="none">
          <line x1={X0} x2={x1} y1={y(level(median.value))} y2={y(level(median.value))} stroke="var(--violet)" strokeWidth={1.5} strokeDasharray="6 4" strokeLinecap="round" />
          <text x={x1 + 8} y={y(level(median.value)) + 4} fontSize={11} fontWeight={500} fill="var(--violet)">{medianText}</text>
        </g>}
        {endLabel && last && (() => {
          const endY = y(last.percent != null ? level(last.percent) : 100) + 4;
          // Moved below the median label when the two would overlap in the gutter.
          const medianY = median != null ? y(level(median.value)) + 4 : null;
          const clash = medianY != null && Math.abs(endY - medianY) < 13;
          const text = fittingLabel(endLabel.candidates, width - (x1 + 8) - 2, END_FONT);
          return text && <text x={x1 + 8} y={clash ? medianY! + 14 : endY} fontSize={END_FONT} fontWeight={500} fill={endLabel.color} pointerEvents="none">{text}</text>;
        })()}
        {hasLane && laneLabel && <text x={X0 - 8} y={lane + LANE_H - 2} textAnchor="end" fontSize={10} fill="var(--muted)">{laneLabel}</text>}
        {hasLane && laneNote && <text x={x1 + 8} y={lane + LANE_H - 2} fontSize={10} fill="var(--muted)">{laneNote}</text>}
        {ticks.map(({ center: cx, text }, i) => keptTicks[i] && <text key={bars[i]!.key} x={cx} y={height - 6} textAnchor="middle" fontSize={TICK_FONT} fill="var(--muted)">{text}</text>)}
      </svg>
    </div></ChartExport>
  );
}

/** Shares as one stacked bar, e.g. window results in a headline tile. */
export function ResultBar({ parts }: { parts: Array<{ key: string; count: number; color: string; title: string }> }) {
  return (
    <div className="archive-seg">
      {parts.filter((part) => part.count > 0).map((part) => <span key={part.key} title={part.title} style={{ flex: part.count, background: part.color }} />)}
    </div>
  );
}
