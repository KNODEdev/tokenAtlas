import { ChartExport } from "./ChartExport";
import type { ReactNode } from "react";
import type { HoursPoint } from "../lib/window-archive";
import { getLocale, useI18n } from "../lib/i18n";
import { duration } from "../lib/format";
import { useWidth } from "./WindowStatusCard";
import { textWidth } from "./CapacityHistoryChart";
import { TableRow, Table, Td, Th } from "./ui";
import "../screens/History.css";

/** Colours of the compared windows; the current one is always the accent. */
export const COMPARED_COLORS = ["var(--ok)", "var(--muted)", "var(--claude)", "var(--warn)"];

export interface CourseLine {
  key: string;
  color: string;
  points: readonly HoursPoint[];
  current?: boolean;
  /** Drawn thin and grey: shown for context, left out of the typical course. */
  muted?: boolean;
  /** ✕ exhausted, ○ ended below 100%, ● the current window. */
  end: { hours: number; percent: number; mark: "current" | "exhausted" | "ended" } | null;
  label: string;
  title: string;
}

// Chart geometry in CSS pixels; the right gutter holds the end-point labels.
const X0 = 44, RIGHT_GUTTER = 150, Y0 = 262, Y100 = 36, HEIGHT = 300, LABEL_FONT = 11;

/** Hour ticks for an axis of `hours`: whole days for multi-day windows, whole hours otherwise. */
export function hourTicks(hours: number): Array<[number, string]> {
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return Array.from({ length: days + 1 }, (_, day): [number, string] => [day * 24, day ? `${day}d` : "0"]);
  }
  const step = hours > 12 ? 3 : 1;
  return Array.from({ length: Math.floor(hours / step) + 1 }, (_, i): [number, string] => [i * step, `${i * step}h`]);
}

/** Usage since each window's start on one hour axis, with labelled end points. */
export function CourseChart({ hours, lines, nowHours, median, forecast }: {
  hours: number;
  lines: CourseLine[];
  nowHours: number | null;
  median: { points: readonly HoursPoint[]; label: string } | null;
  forecast: { from: HoursPoint; to: HoursPoint; label: string } | null;
}) {
  const { t } = useI18n();
  const [ref, width] = useWidth(1000);
  const x1 = width - RIGHT_GUTTER;
  const x = (h: number) => X0 + (Math.min(Math.max(h, 0), hours) / hours) * (x1 - X0);
  const y = (p: number) => Y0 - (Math.min(Math.max(p, 0), 100) / 100) * (Y0 - Y100);
  const path = (points: readonly HoursPoint[]) => points.map(([h, v]) => `${x(h).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  // Muted lines first so the compared windows and the current one stay on top.
  const ordered = [...lines].sort((a, b) => Number(!a.muted) - Number(!b.muted) || Number(!!a.current) - Number(!!b.current));
  const placed: Array<{ x: number; y: number; w: number }> = [];
  const labels = ordered.flatMap((line) => {
    if (!line.end) return [];
    const cx = x(line.end.hours), w = textWidth(line.label, LABEL_FONT);
    let ly = y(line.end.percent) - 9;
    // Lift a label while it would overlap one placed before it.
    while (placed.some((other) => Math.abs(other.y - ly) < 13 && cx < other.x + other.w + 8 && other.x < cx + w + 8)) ly -= 13;
    placed.push({ x: cx, y: ly, w });
    return [{ line, x: Math.min(cx + 7, width - w - 2), y: Math.max(12, ly) }];
  });
  return (
    <ChartExport title={t("Window comparison", "Porównanie okien")}><div ref={ref} className="archive-chart" style={{ minWidth: 0, overflow: "hidden" }}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img" aria-label={t("Usage since the window started", "Zużycie od startu okna")}>
        {[25, 50, 75].map((p) => <line key={p} x1={X0} x2={x1} y1={y(p)} y2={y(p)} stroke="var(--line)" strokeDasharray="3 4" />)}
        {[0, 50].map((p) => <text key={p} x={X0 - 8} y={y(p) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{p}%</text>)}
        <line x1={X0} x2={x1} y1={y(100)} y2={y(100)} stroke="var(--text)" strokeWidth={1.25} />
        <text x={X0 - 8} y={y(100) + 4} textAnchor="end" fontSize={10} fontWeight={500} fill="var(--text)">100%</text>
        <line x1={X0} x2={x1} y1={Y0} y2={Y0} stroke="var(--line2)" />
        {hourTicks(hours).map(([h, label]) => <g key={h}>
          <line x1={x(h)} x2={x(h)} y1={Y0} y2={Y0 + 4} stroke="var(--line2)" />
          <text x={x(h)} y={Y0 + 16} textAnchor="middle" fontSize={10} fill="var(--muted)">{label}</text>
        </g>)}
        {median && median.points.length > 1 && <g pointerEvents="none">
          <polyline points={path(median.points)} fill="none" stroke="var(--violet)" strokeWidth={1.75} strokeDasharray="6 4" strokeLinecap="round" />
          <text x={x(median.points.at(-1)![0]) + 8} y={y(median.points.at(-1)![1]) + 4} fontSize={LABEL_FONT} fontWeight={500} fill="var(--violet)">{median.label}</text>
        </g>}
        {nowHours != null && <g pointerEvents="none">
          <line x1={x(nowHours)} x2={x(nowHours)} y1={18} y2={Y0} stroke="var(--muted)" strokeDasharray="2 3" />
          <text x={x(nowHours)} y={12} textAnchor={nowHours / hours < 0.05 ? "start" : "middle"} fontSize={10} fill="var(--muted)">
            {t("now", "teraz")} · {duration(nowHours)}
          </text>
        </g>}
        {ordered.map((line) => {
          const color = line.muted ? "var(--faint)" : line.color;
          const end = line.end;
          return <g key={line.key}>
            <title>{line.title}</title>
            {line.points.length > 1 && <polyline points={path(line.points)} fill="none" stroke={color} strokeWidth={line.current ? 2.5 : line.muted ? 1.25 : 1.75}
              strokeLinejoin="round" strokeLinecap="round" strokeDasharray={line.muted ? "4 3" : undefined} opacity={line.muted ? 0.8 : line.current ? 1 : 0.9} />}
            {end && (end.mark === "current"
              ? <circle cx={x(end.hours)} cy={y(end.percent)} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} />
              : end.mark === "exhausted"
                ? <path d={`M${x(end.hours) - 5},${y(end.percent) - 5}L${x(end.hours) + 5},${y(end.percent) + 5}M${x(end.hours) + 5},${y(end.percent) - 5}L${x(end.hours) - 5},${y(end.percent) + 5}`} stroke={color} strokeWidth={2} strokeLinecap="round" />
                : <circle cx={x(end.hours)} cy={y(end.percent)} r={4} fill="var(--surface)" stroke={color} strokeWidth={2} />)}
          </g>;
        })}
        {forecast && <g pointerEvents="none">
          <line x1={x(forecast.from[0])} y1={y(forecast.from[1])} x2={x(forecast.to[0])} y2={y(forecast.to[1])} stroke="var(--crit)" strokeWidth={1.75} strokeDasharray="7 5" strokeLinecap="round" />
          <text x={x(forecast.to[0]) + 8} y={y(forecast.to[1]) + 4} fontSize={LABEL_FONT} fontWeight={500} fill="var(--crit)">{forecast.label}</text>
        </g>}
        {labels.map(({ line, x: lx, y: ly }) => (
          <text key={line.key} x={lx} y={ly} fontSize={LABEL_FONT} fontWeight={500} fill={line.muted ? "var(--faint)" : line.color} pointerEvents="none">{line.label}</text>
        ))}
      </svg>
    </div></ChartExport>
  );
}

export interface SameMomentRow {
  key: string;
  label: string;
  sub?: string;
  color: string;
  current?: boolean;
  muted?: boolean;
  badge?: ReactNode;
  /** Usage at the compared moment; `exact` is a reading, otherwise it lies between two readings. */
  at: { value: number; exact: boolean } | null;
  end: number | null;
  endText?: string;
  extra?: string[];
}

function amount(value: number): string {
  return value.toLocaleString(getLocale(), { maximumFractionDigits: value < 10 ? 1 : 0 });
}

/** Each window at the same hour since its start as the current one, with its end and the gap to now. */
export function SameMomentTable({ rows, now, atLabel, extraHeaders = [] }: {
  rows: SameMomentRow[];
  /** The current window's usage now; null when nothing is in progress. */
  now: number | null;
  atLabel: string;
  extraHeaders?: string[];
}) {
  const { t } = useI18n();
  return (
    <Table tableId="CourseCompare:0">
      <thead>
        <TableRow header>
          <Th columnId="c0">{t("window", "okno")}</Th>
          {/* Two lines: the one-line legend alone was wider than the bar needs. */}
          <Th columnId="c1">{atLabel}<br />● {t("end", "koniec")}{now != null ? ` · ┃ ${t("now", "teraz")} ${amount(now)}%` : ""}</Th>
          <Th columnId="c2" align="right">{t("then", "wtedy")}</Th>
          <Th columnId="c3" align="right">{t("end", "koniec")}</Th>
          <Th columnId="c4" align="right">{t("Δ to now", "Δ do teraz")}</Th>
          {extraHeaders.map((header, index) => <Th columnId={`extra:${index}`} key={index} align="right">{header}</Th>)}
        </TableRow>
      </thead>
      <tbody>
        {rows.map((row) => {
          const color = row.muted ? "var(--faint)" : row.color;
          const delta = row.current || row.at == null || now == null ? null : now - row.at.value;
          return (
            <TableRow key={row.key} style={{ background: row.current ? "var(--accent-soft)" : undefined, color: row.muted ? "var(--muted)" : undefined }}>
              <Td mono>
                <i className="archive-swatch" style={{ background: color }} />
                <b>{row.label}</b> {row.sub && <span className="archive-muted">{row.sub}</span>} {row.badge}
              </Td>
              <Td>
                <div className="archive-track">
                  {row.at != null && <div className="archive-fill" style={{ width: `${Math.min(100, row.at.value)}%`, background: color, opacity: 0.75 }} />}
                  {row.end != null && <div className="archive-end" style={{ left: `${Math.min(100, row.end)}%`, background: color }} />}
                  {now != null && <div className="archive-now" style={{ left: `${Math.min(100, now)}%` }} />}
                </div>
              </Td>
              <Td mono align="right">
                {row.at == null
                  ? <span className="archive-faint" title={t("No readings at this moment - nothing is filled in", "Brak odczytów w tym momencie — nic nie jest dopowiadane")}>{t("no coverage", "brak pokrycia")}</span>
                  : `${row.at.exact ? "" : "≈"}${amount(row.at.value)}%`}
              </Td>
              <Td mono align="right"><b>{row.endText ?? (row.end == null ? "—" : `${amount(row.end)}%`)}</b></Td>
              <Td mono align="right" style={{ color: delta == null ? "var(--faint)" : delta > 0 ? "var(--crit)" : "var(--ok)" }}>
                {delta == null ? "—" : `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`}
              </Td>
              {(row.extra ?? []).map((value, i) => <Td key={i} mono align="right" style={{ color: "var(--muted)" }}>{value}</Td>)}
            </TableRow>
          );
        })}
      </tbody>
    </Table>
  );
}
