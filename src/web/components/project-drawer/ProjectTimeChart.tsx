import type { CalendarGranularity, RepoBucketPoint } from "../../lib/api";
import { WORKDAY_HOURS, duration, workTimeLine } from "../../lib/format";
import { calendarDateLabels } from "../../lib/chart-dates";
import { spacedTicks } from "../WindowBarChart";
import { useWidth } from "../WindowStatusCard";
import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import { hours, MASK } from "./format";
import { CaptureControls, ChartHead } from "./presentation";

const FULL_TIME_HOURS: Record<CalendarGranularity, number> = {
  day: WORKDAY_HOURS,
  week: 5 * WORKDAY_HOURS,
  month: Math.round(21.7 * WORKDAY_HOURS),
};

/** The server's key for active time whose source names no computer. */
const UNKNOWN_MACHINE = "?";

/** Time bars per computer: the chart's violet, then lighter mixes with the surface, as computer shares are drawn elsewhere. */
const MACHINE_COLORS = [
  "var(--violet)",
  "color-mix(in oklab, var(--violet) 55%, var(--surface))",
  "color-mix(in oklab, var(--violet) 30%, var(--surface))",
];

export function ProjectTimeChart({
  title,
  points,
  granularity,
  idleGap,
  hideValues = false,
  fileName,
}: {
  points: RepoBucketPoint[];
  granularity: CalendarGranularity;
  idleGap: number;
  hideValues?: boolean;
  fileName: string;
  /** Shown in the card (and its PNG) beside the explanation dot. */
  title?: string;
}) {
  const { t, locale } = useI18n();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [cardRef, chartWidth] = useWidth(1000);
  // Bars show wall-clock time (parallel sessions on one computer once); the per-session sum stays as a secondary figure.
  const totalSeconds = points.reduce((a, p) => a + (p.active_seconds || 0), 0);
  const summedSeconds = points.reduce((a, p) => a + (p.session_seconds || 0), 0);
  // Computers by their time in the range, largest first (the bottom segment); one without a name goes last.
  const machineSeconds = new Map<string, number>();
  for (const p of points) {
    for (const [machine, seconds] of Object.entries(p.active_by_machine ?? {})) {
      machineSeconds.set(machine, (machineSeconds.get(machine) ?? 0) + seconds);
    }
  }
  const machines = [...machineSeconds.keys()].sort((a, b) =>
    Number(a === UNKNOWN_MACHINE) - Number(b === UNKNOWN_MACHINE) || machineSeconds.get(b)! - machineSeconds.get(a)! || a.localeCompare(b));
  const machineColor = (machine: string) =>
    machine === UNKNOWN_MACHINE ? "var(--line2)" : MACHINE_COLORS[machines.indexOf(machine) % MACHINE_COLORS.length]!;
  const machineName = (machine: string) => (machine === UNKNOWN_MACHINE ? t("unknown computer", "nieznany komputer") : machine);
  const machineParts = (p: RepoBucketPoint) =>
    machines.map((machine) => ({ machine, seconds: p.active_by_machine?.[machine] ?? 0 })).filter((part) => part.seconds > 0);
  const fullTime = FULL_TIME_HOURS[granularity];
  const maxHours = Math.max(...points.map((p) => hours(p.active_seconds || 0)), fullTime * 1.05, 0.1);
  const W = 100;
  const H = 130;
  const padTop = 8;
  const padBottom = 18;
  const plotH = H - padTop - padBottom;
  const slot = W / points.length;
  const barW = Math.max(slot * 0.65, 0.7);
  const refY = padTop + plotH * (1 - fullTime / maxHours);
  const dateLabels = calendarDateLabels(points.map(point => point.bucket), locale);
  const keptDates = spacedTicks(dateLabels.map((text, index) => ({ text, center: (index + 0.5) * chartWidth / points.length })));
  const hoveredPoint = hoverIdx != null ? points[hoverIdx] : null;
  const granLabel =
    granularity === "day" ? t("day", "dzień") : granularity === "week" ? t("week", "tydzień") : t("month", "miesiąc");
  return (
    <div
      ref={cardRef}
      style={{
        background: "var(--surface)",
        padding: "var(--s-2) 0 var(--s-3)",
      }}
    >
      <ChartHead
        title={title}
        help={t(
          "Bars: wall-clock active hours per {0}, one segment per computer. Sessions running at the same time on one computer (subagents, reviews) count once; \"sessions summed\" adds each session's own time. Dashed line: full work capacity ({1} h per {2}, {3}h/workday) - reference, not a target.",
          `Słupki: godziny aktywne wg zegara na ${granLabel}, jeden odcinek na komputer. Sesje działające naraz na jednym komputerze (subagenty, przeglądy) liczą się raz; „suma sesji" dodaje czas każdej sesji osobno. Przerywana linia: pełny wymiar pracy (${fullTime} h na ${granLabel}, ${WORKDAY_HOURS}h/dzień rob.) — odniesienie, nie cel.`, [granLabel, fullTime, granLabel, WORKDAY_HOURS],
        )}
        controls={<CaptureControls targetRef={cardRef} fileName={fileName} label={t("time spent on the project", "czas spędzony na projekcie")} />}
      />
      <div style={{ marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          {hoveredPoint ? (
            <div
              className="mono"
              style={{
                fontSize: "var(--fs-3)",
                padding: "var(--s-2) var(--s-4)",
                background: "var(--sunk)",
                borderRadius: "var(--r-chip)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <span style={{ fontWeight: 600, color: "var(--text)" }}>{hoveredPoint.bucket}</span>
              {hideValues ? (
                <span style={{ color: "var(--faint)" }}>{t("values hidden", "liczby ukryte")}</span>
              ) : (
                <>
                  <span style={{ color: "var(--violet)" }}>
                    ≈ <strong>{duration(hours(hoveredPoint.active_seconds))}</strong>
                  </span>
                  {machineParts(hoveredPoint).map(({ machine, seconds }) => (
                    <span key={machine} data-hover-machine={machine} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted)" }}>
                      <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: machineColor(machine), display: "inline-block" }} />
                      {machineName(machine)} ≈ {duration(hours(seconds))}
                    </span>
                  ))}
                  <span style={{ color: "var(--faint)" }}>
                    {t("sessions summed", "suma sesji")} ≈ {duration(hours(hoveredPoint.session_seconds))}
                  </span>
                  <span style={{ color: "var(--muted)" }}>{workTimeLine(hours(hoveredPoint.active_seconds))}</span>
                </>
              )}
            </div>
          ) : (
            <div style={{ height: 26 }} />
          )}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 130, display: "block", overflow: "visible" }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {[0, 0.5, 1].map((pct) => {
          const y = padTop + plotH * (1 - pct);
          return (
            <line
              key={pct}
              x1={0}
              x2={W}
              y1={y}
              y2={y}
              stroke="var(--line)"
              strokeWidth={1}
              strokeDasharray={pct > 0 ? "3 4" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        <line
          x1={0}
          x2={W}
          y1={refY}
          y2={refY}
          stroke="var(--warn)"
          strokeWidth={1}
          strokeDasharray="4,3"
          vectorEffect="non-scaling-stroke"
          opacity={0.7}
        />
        {points.map((p, i) => {
          const x = i * slot + (slot - barW) / 2;
          const isHovered = hoverIdx === i;
          // One segment per computer, stacked from the bottom; a point without the split stays one bar.
          const parts = machines.length ? machineParts(p) : [{ machine: "", seconds: p.active_seconds || 0 }];
          let base = padTop + plotH;
          return (
            <g
              key={p.bucket}
              onMouseEnter={() => setHoverIdx(i)}
              style={{ cursor: "pointer", opacity: hoverIdx == null || isHovered ? 1 : 0.55 }}
            >
              <title>
                {hideValues
                  ? `${p.bucket}\n${t("values hidden", "liczby ukryte")}`
                  : `${p.bucket}\n` +
                    `${t("Active time", "Czas aktywny")}: ≈ ${duration(hours(p.active_seconds))} (${t("threshold", "próg")} ${idleGap}m)\n` +
                    machineParts(p).map(({ machine, seconds }) => `${machineName(machine)}: ≈ ${duration(hours(seconds))}\n`).join("") +
                    `${t("Sessions summed", "Suma sesji")}: ≈ ${duration(hours(p.session_seconds))}\n` +
                    `${workTimeLine(hours(p.active_seconds)) ?? ""}`}
              </title>
              <rect x={i * slot} y={padTop} width={slot} height={plotH} fill="transparent" />
              {parts.map(({ machine, seconds }) => {
                const h = (plotH * hours(seconds)) / maxHours;
                if (h <= 0) return null;
                base -= h;
                return (
                  <rect
                    key={machine}
                    data-machine={machine || undefined}
                    x={x}
                    y={base}
                    width={barW}
                    height={Math.max(h, 0.1)}
                    fill={machine ? machineColor(machine) : "var(--violet)"}
                    stroke="var(--surface)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    rx={0.3}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", fontFamily: "var(--font-figure)", fontSize: "var(--fs-1)", color: "var(--muted)", marginTop: "var(--s-2)" }}>
        {points.map((p, i) => (
          <div key={p.bucket} title={Number.isFinite(Date.parse(p.bucket)) ? new Date(p.bucket).toISOString().slice(0, 10) + " UTC" : p.bucket} style={{ flex: 1, minWidth: 0, textAlign: i === 0 ? "left" : i === points.length - 1 ? "right" : "center", whiteSpace: "nowrap" }}>
            {keptDates[i] ? dateLabels[i] : ""}
          </div>
        ))}
      </div>
      <div
        className="mono"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "4px 14px",
          marginTop: "var(--s-5)",
          paddingTop: "var(--s-4)",
          borderTop: "var(--rule)",
          fontSize: "var(--fs-3)",
        }}
      >
        <span style={{ color: "var(--text)", fontWeight: 600 }}>
          {t("total", "razem")} ≈ {hideValues ? MASK : duration(hours(totalSeconds))}
        </span>
        {!hideValues && <span style={{ color: "var(--muted)" }}>{workTimeLine(hours(totalSeconds))}</span>}
        {machines.map((machine) => (
          <span key={machine} data-legend-machine={machine} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: machineColor(machine), display: "inline-block" }} />
            <span style={{ color: "var(--text)" }}>{machineName(machine)}</span>
            <span style={{ color: "var(--faint)" }}>≈ {hideValues ? MASK : duration(hours(machineSeconds.get(machine) ?? 0))}</span>
          </span>
        ))}
        <span data-summed-sessions style={{ color: "var(--faint)" }}>
          {t("sessions summed", "suma sesji")} ≈ {hideValues ? MASK : duration(hours(summedSeconds))}
        </span>
        <span style={{ color: "var(--faint)" }}>{t("threshold", "próg")} {idleGap}m</span>
      </div>
    </div>
  );
}
