import { ChartExport } from "./ChartExport";
import { useMemo, useState } from "react";
import type { ApiPoint } from "../lib/api";
import type { CycleView } from "../lib/cycle";
import { duration } from "../lib/format";
import { getLocale, useI18n } from "../lib/i18n";
interface Props {
  cycle: CycleView;
  points: ApiPoint[];
  showProjection?: boolean;
  height?: number;
}
const PAD = { top: 10, right: 92, bottom: 26, left: 44 };
export function ConsumptionChart({ cycle, points, showProjection = true, height = 224 }: Props) {
  const { t } = useI18n();
  const [hover, setHover] = useState<{ x: number; t: number; v: number } | null>(null);
  const geom = useMemo(() => {
    const mine = points
      .filter((p) => p.cycle === cycle.index && p.cycle_progress != null)
      .map((p) => ({ t: p.cycle_progress as number, v: p.percent, ts: p.ts }))
      .sort((a, b) => a.t - b.t);
    let run = 0;
    const actual = mine.map((p) => {
      run = Math.max(run, p.v);
      return { ...p, v: run };
    });
    const projectedEnd = cycle.projectedEndPercent ?? cycle.usedPercent;
    const yMax = Math.max(120, Math.ceil((Math.max(projectedEnd, cycle.usedPercent) + 10) / 20) * 20);
    const yv = (v: number) => (1 - Math.max(0, Math.min(yMax, v)) / yMax) * 100;
    const path = (pts: { t: number; v: number }[]) =>
      pts.map((q, i) => `${i ? "L" : "M"} ${q.t.toFixed(2)} ${yv(q.v).toFixed(2)}`).join(" ");
    const last = actual[actual.length - 1];
    const proj: { t: number; v: number }[] = [];
    if (showProjection && last && cycle.isActive && last.t < 100) {
      const end = cycle.projectedEndPercent ?? last.v;
      const span = 100 - last.t;
      for (let t = last.t; t <= 100; t += 1) {
        const k = span > 0 ? (t - last.t) / span : 1;
        proj.push({ t, v: last.v + (end - last.v) * k });
      }
    }
    const area = actual.length
      ? `${path(actual)} L ${(last?.t ?? 0).toFixed(2)} ${yv(0).toFixed(2)} L ${actual[0]!.t.toFixed(2)} ${yv(0).toFixed(2)} Z`
      : "";
    const gridVals: number[] = [];
    for (let v = 0; v <= yMax; v += 20) gridVals.push(v);
    return {
      actual,
      actualPath: path(actual),
      area,
      sustainPath: path([
        { t: 0, v: 0 },
        { t: 100, v: 100 },
      ]),
      projPath: proj.length > 1 ? path(proj) : "",
      yv,
      yMax,
      gridVals,
      last,
    };
  }, [cycle, points, showProjection]);
  const { yv, yMax, gridVals, actual, last } = geom;
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * 100;
    if (t < 0 || t > 100 || actual.length === 0) return setHover(null);
    let nearest = actual[0]!;
    for (const p of actual) if (Math.abs(p.t - t) < Math.abs(nearest.t - t)) nearest = p;
    setHover({ x: nearest.t, t: nearest.t, v: nearest.v });
  };
  if (actual.length === 0) {
    return (
      <div
        className="mono"
        style={{
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--fs-4)",
          color: "var(--muted)",
          borderRadius: "var(--r-chip)",
          background: "var(--sunk)",
        }}
      >
        {t("No gauge samples in this cycle.", "Brak próbek gauge w tym cyklu.")}
      </div>
    );
  }
  const exhaustionShown = cycle.etaExhaustionIso != null && (cycle.projectedEndPercent ?? 0) >= 100;
  return (
    <ChartExport title={t("Window consumption", "Zużycie w oknie")}><div style={{ position: "relative", height, margin: `${PAD.top}px ${PAD.right}px ${PAD.bottom}px ${PAD.left}px` }}>
      {gridVals.map((v) => (
        <div
          key={v}
          className="mono"
          style={{
            position: "absolute",
            top: `${yv(v)}%`,
            left: -PAD.left,
            width: PAD.left - 6,
            transform: "translateY(-50%)",
            textAlign: "right",
            fontFamily: "var(--font-figure)",
            fontSize: "var(--fs-1)",
            color: "var(--muted)",
          }}
        >
          {v}%
        </div>
      ))}
      {[0, 20, 40, 60, 80, 100].map((p) => (
        <div
          key={p}
          className="mono"
          style={{
            position: "absolute",
            left: `${p}%`,
            bottom: -PAD.bottom + 6,
            transform: "translateX(-50%)",
            fontFamily: "var(--font-figure)",
            fontSize: "var(--fs-1)",
            color: "var(--muted)",
          }}
        >
          {p}%
        </div>
      ))}
      <div style={{ position: "absolute", inset: 0 }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
        >
          {gridVals.map((v) => (
            <line
              key={v}
              x1="0"
              x2="100"
              y1={yv(v)}
              y2={yv(v)}
              stroke="var(--line)"
              strokeWidth="1"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1="0"
            x2="100"
            y1={yv(100)}
            y2={yv(100)}
            stroke="var(--crit)"
            strokeWidth="1"
            strokeDasharray="2 3"
            opacity="0.7"
            vectorEffect="non-scaling-stroke"
          />
          <path d={geom.sustainPath} fill="none" stroke="var(--faint)" strokeWidth="1.4" strokeDasharray="5 4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={geom.area} fill="var(--accent)" opacity="0.10" />
          <path
            d={geom.actualPath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {geom.projPath && (
            <path
              d={geom.projPath}
              fill="none"
              stroke="var(--warn)"
              strokeWidth="1.75"
              strokeDasharray="1 4"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {cycle.isActive && (
            <line
              x1={cycle.elapsedPercent}
              x2={cycle.elapsedPercent}
              y1="0"
              y2="100"
              stroke="var(--text)"
              strokeWidth="1"
              opacity="0.45"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hover && (
            <line x1={hover.x} x2={hover.x} y1="0" y2="100" stroke="var(--line2)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {last && (
          <div
            style={{
              position: "absolute",
              left: `${last.t}%`,
              top: `${yv(last.v)}%`,
              width: 9,
              height: 9,
              boxSizing: "border-box",
              marginLeft: -4.5,
              marginTop: -4.5,
              borderRadius: "var(--r-dot)",
              background: "var(--accent)",
              border: "2px solid var(--surface)",
            }}
          />
        )}
        {geom.projPath && (
          <div
            className="mono"
            style={{
              position: "absolute",
              left: "100%",
              top: `${yv(cycle.projectedEndPercent ?? 0)}%`,
              transform: "translateY(-50%)",
              marginLeft: "var(--s-4)",
              fontFamily: "var(--font-figure)",
              fontSize: "var(--fs-2)",
              color: "var(--warn)",
              whiteSpace: "nowrap",
            }}
          >
            {t("proj.", "proj.")} {(cycle.projectedEndPercent ?? 0).toLocaleString(getLocale(), { maximumFractionDigits: 0 })}%
          </div>
        )}
        {hover && (
          <div
            className="mono"
            style={{
              position: "absolute",
              left: `${hover.x}%`,
              top: 0,
              transform: `translate(${hover.x > 60 ? "-105%" : "8px"}, 0)`,
              background: "var(--surface)",
              border: "1px solid var(--pencil)",
              borderRadius: "var(--r-card)",
              padding: "var(--s-3) var(--s-5)",
              fontSize: "var(--fs-3)",
              lineHeight: 1.5,
              pointerEvents: "none",
              whiteSpace: "nowrap",
              boxShadow: "var(--shadow)",
              zIndex: 2,
            }}
          >
            <div style={{ color: "var(--muted)" }}>{hover.t.toLocaleString(getLocale(), { maximumFractionDigits: 0 })}% {t("cycle time", "czasu cyklu")}</div>
            <div style={{ color: "var(--text)", fontWeight: "var(--fw-semibold)" }}>{hover.v.toLocaleString(getLocale(), { maximumFractionDigits: 0 })}% {t("allowance", "limitu")}</div>
            <div style={{ color: hover.v > hover.t ? "var(--warn)" : "var(--ok)" }}>
              {(hover.v - hover.t >= 0 ? "+" : "−") + Math.abs(hover.v - hover.t).toLocaleString(getLocale(), { maximumFractionDigits: 0 })} pp {t("vs sustainable", "vs sustainable pace")}
            </div>
          </div>
        )}
      </div>
      {exhaustionShown && cycle.exhaustionGapHours != null && cycle.exhaustionGapHours > 0 && (
        <div
          className="mono"
          style={{
            position: "absolute",
            bottom: -PAD.bottom - 2,
            right: -PAD.right,
            fontSize: "var(--fs-2)",
            color: "var(--crit)",
            whiteSpace: "nowrap",
          }}
        >
          {t("exhaustion", "wyczerpanie")} ~{duration(cycle.exhaustionGapHours)} {t("before reset", "przed resetem")}
        </div>
      )}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }} aria-hidden>
        <span style={{ display: "none" }}>{yMax}</span>
      </div>
    </div></ChartExport>
  );
}
