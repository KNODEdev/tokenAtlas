import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ApiCycleReserve, ApiPoint } from "../lib/api";
import { resultOf, type CycleView } from "../lib/cycle";
import { compact, dayMonth, dayTime, duration, pct, signedPct, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { MIN_PP_FOR_RATE, usdPerPoint } from "../lib/planValue";
import { WINDOW_RAIL_W } from "../lib/useBreakpoint";
import { MIN_RAIL_SHAPE_POINTS, type RailWindow } from "../lib/windows";
import { Card, CardTitle, Eyebrow } from "./ui";
import { accountCreditsOfCycles, creditTag, railCreditsView } from "../lib/credit-pools-view";
import { pointBasisOfCycles, pointBasisTitle, type CurrentPointBasis } from "../lib/current-point-basis";
import { activeCourses } from "../lib/window-activity";
import { subscriptionPlan } from "../lib/subscription-plan";
import { activityStartsAt, activityHasZeroStart } from "../../shared/window-activity";
import "./Rail.css";
const MIN_SHAPE_POINTS = MIN_RAIL_SHAPE_POINTS;
const TREND_WINDOWS = 12;
function rate(v: number): string {
  return usd(v);
}
type Row = {
  cycle: CycleView;
  shape: ApiPoint[];
};
function reserveSummary(reserve: ApiCycleReserve): string {
  const span = reserve.first_ts && reserve.peak_ts ? ` · ${dayTime(reserve.first_ts)} → ${dayTime(reserve.peak_ts)}` : "";
  return `${translate("Reserve pool used after this window's allowance ran out", "Pula rezerwowa użyta po wyczerpaniu limitu tego okna")}: `
    + `${reserve.peak_percent != null ? pct(reserve.peak_percent) : "—"} · ${compact(reserve.tokens.total)} ${translate("tokens", "tokenów")}${span}`;
}
function useRows(cycles: CycleView[], points: ApiPoint[], limit?: number): Row[] {
  return useMemo(() => {
    const byCycle = new Map<number, ApiPoint[]>();
    for (const p of points) {
      const bucket = byCycle.get(p.cycle);
      if (bucket) bucket.push(p);
      else byCycle.set(p.cycle, [p]);
    }
    for (const bucket of byCycle.values()) {
      bucket.sort((a, b) => (a.cycle_progress ?? 0) - (b.cycle_progress ?? 0));
    }
    const shown = limit != null ? cycles.slice(0, limit) : cycles;
    return shown.map((cycle) => ({ cycle, shape: byCycle.get(cycle.index) ?? [] }));
  }, [cycles, points, limit]);
}
function Shape({
  points,
  usedPercent,
  medianPercent,
  color,
  height,
  active,
}: {
  points: ApiPoint[];
  usedPercent: number;
  medianPercent: number | null;
  color: string;
  height: number;
  active: boolean;
}) {
  const measured = points.length >= MIN_SHAPE_POINTS;
  const path = measured
    ? points
        .map((p, i) => `${i === 0 ? "M" : "L"}${(p.cycle_progress ?? 0).toFixed(2)},${(100 - p.percent).toFixed(2)}`)
        .join(" ")
    : "";
  const area = measured
    ? `${path} L${(points[points.length - 1]?.cycle_progress ?? 0).toFixed(2)},100 L${(points[0]?.cycle_progress ?? 0).toFixed(2)},100 Z`
    : "";
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="rail-shape"
      style={{ height }}
    >
      {medianPercent != null && (
        <line
          x1="0"
          x2="100"
          y1={100 - medianPercent}
          y2={100 - medianPercent}
          stroke="var(--text)"
          strokeOpacity="0.35"
          strokeWidth="1"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {measured ? (
        <>
          <path d={area} fill={color} fillOpacity={active ? 0.16 : 0.1} />
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={active ? 1.75 : 1.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : (
        <line
          x1="0"
          x2="100"
          y1={100 - usedPercent}
          y2={100 - usedPercent}
          stroke={color}
          strokeWidth="1.2"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
function RailRow({
  row,
  active,
  compactRow,
  medianPercent,
  onSelect,
  onInfo,
  onHover,
}: {
  row: Row;
  active: boolean;
  compactRow: boolean;
  medianPercent: number | null;
  onSelect: (index: number) => void;
  onInfo: (index: number) => void;
  onHover: (row: Row | null, top: number, right: number) => void;
}) {
  const { t } = useI18n();
  const c = row.cycle;
  const perPoint = usdPerPoint(c);
  const credit = creditTag(c.raw.credit_funded);
  return (
    <div
      onMouseEnter={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const rail = e.currentTarget.closest("aside")?.getBoundingClientRect(); onHover(row, rect.top, rail?.right ?? rect.right); }}
      onMouseLeave={() => onHover(null, 0, 0)}
    >
      <button
        onClick={() => onSelect(c.index)}
        type="button"
        aria-pressed={active}
        className={`rail-row${compactRow ? " is-compact" : ""}`}
      >
        <div className="rail-row-head">
          <span className="rail-row-label">#{c.number}</span>
          {c.isActive && <span className="rail-row-tag">{t("current", "trwa")}</span>}
          <span style={{ flex: 1 }} />
          {c.raw.reserve?.peak_percent != null && (
            <span className="rail-row-reserve" title={reserveSummary(c.raw.reserve)}>
              +{pct(c.raw.reserve.peak_percent)} {t("res.", "rez.")}
            </span>
          )}
          {credit && <span className="rail-row-credit" title={credit.title}>{credit.text}</span>}
          <span className="rail-row-pct" style={{ color: c.color }}>
            {c.usedPercent.toFixed(0)}%
          </span>
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onInfo(c.index);
            }}
            title={t("Full breakdown of this window in the side panel", "Pełne rozbicie tego okna w panelu bocznym")}
            className="mono"
            style={{
              fontSize: "var(--fs-1)",
              lineHeight: "12px",
              width: 14,
              height: 14,
              boxSizing: "border-box",
              textAlign: "center",
              borderRadius: "var(--r-dot)",
              border: "1px solid var(--pencil)",
              color: "var(--muted)",
              cursor: "pointer",
            }}
          >
            i
          </span>
        </div>
        <div style={{ marginTop: 4 }}>
          <Shape
            points={row.shape}
            usedPercent={c.usedPercent}
            medianPercent={medianPercent}
            color={c.isActive ? "var(--accent)" : "var(--pencil)"}
            height={compactRow ? 16 : 22}
            active={active}
          />
        </div>
        <div className="rail-row-meta">
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {dayMonth(c.startIso)} · {c.isActive ? `${c.elapsedPercent.toFixed(0)}%` : duration(c.elapsedHours)}
          </span>
          <span
            style={{ color: perPoint != null ? "var(--muted)" : "var(--faint)" }}
            title={
              perPoint != null
                ? `${usd(perPoint)} ${t("at API prices per allowance pp. Whole window at this rate", "w cenach API na 1 pp allowance. Całe okno w tym kursie")}: ${usd(perPoint * 100)}.`
                : `${t("Usage below", "Zużycie poniżej")} ${MIN_PP_FOR_RATE} pp - ${t("point rate would divide by noise.", "kurs punktu byłby dzieleniem przez szum.")}`
            }
          >
            {perPoint != null ? `${rate(perPoint)}/pp` : "—"}
          </span>
        </div>
      </button>
    </div>
  );
}
function HoverCard({ row, top, left, medianTokens }: { row: Row; top: number; left: number; medianTokens: number | null }) {
  const { t } = useI18n();
  const c = row.cycle;
  const vsMedian = medianTokens && medianTokens > 0 ? (c.tokensTotal / medianTokens - 1) * 100 : null;
  const clampedTop = Math.min(Math.max(top, 60), Math.max(60, window.innerHeight - 260));
  // Rendered into <body>: inside the sticky rail it would sit under positioned content of the main column.
  return createPortal(
    <div
      style={{
        position: "fixed",
        top: clampedTop,
        left,
        zIndex: "var(--z-overlay)",
        width: 268,
        background: "var(--surface)",
        border: "1px solid var(--pencil)",
        borderRadius: "var(--r-card)",
        boxShadow: "var(--shadow)",
        padding: "var(--s-5) var(--s-6)",
        pointerEvents: "none",
      }}
    >
      <Eyebrow>
        {c.label} · {c.resultLabel}
      </Eyebrow>
      <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: "var(--s-1)" }}>
        {dayTime(c.startIso)} → {c.isActive ? `~${dayTime(c.resetIso ?? c.endIso)}` : dayTime(c.endIso)}
      </div>
      <div style={{ marginTop: "var(--s-4)", paddingTop: "var(--s-4)", borderTop: "var(--rule)", display: "flex", flexDirection: "column", gap: "var(--s-1)" }}>
        <Fact label={t("allowance", "allowance")} value={pct(c.usedPercent)} tone={c.color} />
        {c.raw.reserve && (
          <Fact
            label={t("reserve", "rezerwa")}
            value={[c.raw.reserve.peak_percent != null ? pct(c.raw.reserve.peak_percent) : null, compact(c.raw.reserve.tokens.total)]
              .filter(Boolean).join(" · ")}
          />
        )}
        <Fact
          label={c.isActive ? t("window time", "czas okna") : t("actual time", "realny czas")}
          value={c.isActive ? `${c.elapsedPercent.toFixed(0)}% ${t("of", "z")} ${duration(c.windowHours)}` : duration(c.elapsedHours)}
        />
        <Fact label={t("pace", "tempo")} value={c.paceRatio != null ? `${c.paceRatio.toFixed(2)}×` : "—"} />
        <Fact label={t("tokens", "tokeny")} value={`${compact(c.tokensTotal)} ${t("gross", "brutto")}`} />
        <Fact label={t("without cache", "bez cache")} value={compact(c.tokensFresh)} />
        <Fact label={t("input", "input")} value={compact(Math.max(0, c.raw.tokens.in - c.raw.tokens.cached_in))} />
        <Fact label={t("cache read", "odczyt cache")} value={compact(c.raw.tokens.cached_in)} />
        <Fact label={t("cache write", "zapis cache")} value={compact(c.raw.tokens.cache_write)} />
        <Fact label={t("output", "output")} value={compact(c.raw.tokens.out)} />
        {c.raw.tokens.reasoning > 0 && (
          <Fact label={t("including reasoning", "w tym reasoning")} value={compact(c.raw.tokens.reasoning)} />
        )}
        <Fact label={t("API-equivalent", "API-eq")} value={usd(c.usd)} />
        <Fact
          label={t("point rate", "kurs punktu")}
          value={usdPerPoint(c) != null ? `${usd(usdPerPoint(c) ?? 0)}/pp` : t("too little usage", "za mało zużycia")}
        />
        <Fact label={t("calls", "wywołania")} value={c.calls.toLocaleString(getLocale())} />
        <Fact label={t("model", "model")} value={c.topModel ?? "—"} />
        {vsMedian != null && (
          <Fact
            label={t("vs median", "vs mediana")}
            value={signedPct(vsMedian)}
            tone={vsMedian > 0 ? "var(--warn)" : "var(--ok)"}
          />
        )}
        <Fact label={t("gauge samples", "próbki gauge")} value={`${row.shape.length}${row.shape.length < MIN_SHAPE_POINTS ? ` · ${t("no trace", "brak przebiegu")}` : ""}`} />
      </div>
      <div className="mono" style={{ marginTop: "var(--s-4)", paddingTop: "var(--s-3)", borderTop: "var(--rule)", fontSize: "var(--fs-2)", color: "var(--faint)" }}>
        {t("click = switch to this window · ‘i’ = full breakdown", "klik = przełącz na to okno · „i” = pełne rozbicie")}
      </div>
    </div>,
    document.body,
  );
}
function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-5)", fontSize: "var(--fs-3)" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-figure)", fontWeight: "var(--fw-medium)", letterSpacing: "var(--ls-tight)", color: tone ?? "var(--text)", textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}
/** "Kredyty" at the bottom of the rail: the account's balance, credits used in the visible windows, resets. */
function RailCredits({ cycles, visible, basis }: { cycles: CycleView[]; visible: CycleView[]; basis?: CurrentPointBasis | null }) {
  const { t } = useI18n();
  const credits = accountCreditsOfCycles(cycles, basis);
  const view = railCreditsView(credits?.account ?? null, visible.map((c) => c.raw.credit_funded));
  if (!view) return null;
  return (
    <div data-rail-credits className="rail-credits" title={view.title}>
      <div className="rail-credits-head">
        <Eyebrow>{t("Credits", "Kredyty")}</Eyebrow>
        <span className="rail-credits-balance">{view.balance}</span>
      </div>
      {view.used && <div className="rail-credits-line"><span>{t("used in the visible windows", "zużyte w widocznych oknach")}</span><span>{view.used}</span></div>}
      {view.resets && <div className="rail-credits-line"><span>{view.resets}</span>{view.resetsRight && <span>{view.resetsRight}</span>}</div>}
    </div>
  );
}
function RateTrend({ cycles, basis: supplied }: { cycles: CycleView[]; basis?: CurrentPointBasis | null }) {
  const { t } = useI18n();
  const rates = useMemo(() => {
    return [...cycles]
      .slice(0, TREND_WINDOWS)
      .reverse()
      .map((c) => ({ index: c.index, number: c.number, active: c.isActive, value: usdPerPoint(c) }));
  }, [cycles]);
  const values = rates.map((r) => r.value).filter((v): v is number => v != null);
  const basis = supplied === undefined ? pointBasisOfCycles(cycles) : supplied;
  if (values.length === 0 && !basis) {
    return (
      <div className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.5 }}>
        {pointBasisTitle(null)}
      </div>
    );
  }
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] ?? 1;
  const min = sorted[0] ?? 0;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <Eyebrow>{t("Point rate", "Kurs punktu")}</Eyebrow>
        <span title={pointBasisTitle(basis)} style={{ fontSize: "var(--fs-4)", fontFamily: "var(--font-figure)", fontWeight: "var(--fw-semibold)" }}>
          {basis ? `${basis.partial ? "≥ " : ""}${rate(basis.usd / 100)}` : "—"}
          <span style={{ color: "var(--muted)", fontWeight: "var(--fw-regular)" }}>/pp</span>
        </span>
      </div>
      <div
        style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 26, marginTop: "var(--s-2)" }}
        title={`${pointBasisTitle(basis)} · ${t("range", "zakres")} ${usd(min)} – ${usd(max)} · ${values.length} ${t("windows", "okien")}`}
      >
        {rates.map((r) => (
          <span
            key={r.index}
            style={{
              flex: 1,
              minWidth: 2,
              height: r.value != null ? `${Math.max(6, (r.value / max) * 100)}%` : "2px",
              borderRadius: "var(--r-bar)",
              background: r.value == null ? "var(--line2)" : r.active ? "var(--accent)" : "var(--line2)",
              opacity: r.value == null ? 0.5 : 1,
              display: "block",
            }}
          />
        ))}
      </div>
      <div className="mono" style={{ marginTop: "var(--s-2)", fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.5 }}>
        {usd(min)} – {usd(max)} · {t("whole window", "całe okno")} {basis?.partial ? "≥" : "≈"} {basis ? usd(basis.usd) : "—"} {t("at API prices", "w cenach API")}
      </div>
    </div>
  );
}
/**
 * The window's readings, opened at its known start: a fixed window starts at 0% (a plan-change
 * segment at the meter after the drop), so the curve does not begin at the first probe reading.
 */
function anchoredShape(window: RailWindow): RailWindow["shape"] {
  const shape = window.shape;
  if (!shape || shape.length < MIN_SHAPE_POINTS || window.source === "rolling" || !window.startIso) return shape;
  const first = shape[0]!;
  if (first.t <= 0) return shape;
  if (!activityStartsAt(window.activity, Date.parse(window.startIso))) return shape;
  if (window.activity && !activityHasZeroStart(window.activity) && (window.activity.start_basis === "partial"
    || Math.abs(Date.parse(window.resetIso ?? "") - Date.parse(window.startIso) - (window.windowHours ?? 0) * 3_600_000) > 120_000)) return shape;
  return [{ t: 0, pct: window.counterSegment?.startDrop?.after ?? 0 }, ...shape];
}
function ProbeShape({ window, color, active }: { window: RailWindow; color: string; active: boolean }) {
  const points = anchoredShape(window);
  const measured = points != null && points.length >= MIN_SHAPE_POINTS;
  const parts = measured ? activeCourses(points, window.activity, Date.parse(window.startIso ?? ""),
    Date.parse(window.resetIso ?? "") - Date.parse(window.startIso ?? "")).map(course => {
      const path = course.map((point, i) => `${i === 0 ? "M" : "L"}${point.t.toFixed(2)},${(100 - point.pct).toFixed(2)}`).join(" ");
      return { path, area: `${path} L${course.at(-1)!.t.toFixed(2)},100 L${course[0]!.t.toFixed(2)},100 Z` };
    }) : [];
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="rail-shape"
    >
      {measured ? (
        parts.map(({ path, area }, index) => <g key={index}>
          <path d={area} fill={color} fillOpacity={active ? 0.16 : 0.1} />
          <path d={path} fill="none" stroke={color} strokeWidth={active ? 1.75 : 1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>)
      ) : window.usedPercent != null ? (
        <line
          x1="0"
          x2="100"
          y1={100 - window.usedPercent}
          y2={100 - window.usedPercent}
          stroke={color}
          strokeWidth="1.2"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
function lengthLabel(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}
function railSourceLabel(window: RailWindow): string {
  if (window.source === "rolling") return translate("rolling", "bez resetu");
  if (window.source === "declared") return translate("from cadence", "z rytmu");
  return translate("probe", "probe");
}
function ProbeRailRow({ window, active, onSelect }: { window: RailWindow; active: boolean; onSelect: (window: RailWindow) => void }) {
  const { t } = useI18n();
  const result = window.usedPercent == null ? null : resultOf(window.usedPercent);
  const color = window.isCurrent ? "var(--accent)" : result?.color ?? "var(--faint)";
  const shapeColor = window.isCurrent ? "var(--accent)" : "var(--pencil)";
  const timeValue = window.isCurrent && window.elapsedPercent != null
    ? `${window.elapsedPercent.toFixed(0)}%`
    : window.windowHours != null ? duration(window.windowHours) : window.dateLabel;
  const approx = window.percentBasis === "counterfactual" || window.percentBasis === "manual" ? "≈" : "";
  return (
    <button
      onClick={() => onSelect(window)}
      type="button"
      aria-pressed={active}
      className="rail-row"
      title={window.note ?? window.dateLabel}
    >
      <div className="rail-row-head">
        <span className="rail-row-label">{window.label}</span>
        {window.isCurrent && <span className="rail-row-tag">{t("current", "trwa")}</span>}
        {window.activity && !window.isCurrent && Date.parse(window.resetIso ?? "") > Date.now()
          && <span className="rail-row-tag">{t("inactive", "nieaktywne")}</span>}
        <span style={{ flex: 1 }} />
        <span className="rail-row-pct" style={{ color }}>
          {window.usedPercent == null ? "—" : `${approx}${window.usedPercent.toFixed(0)}%`}
        </span>
      </div>
      <div style={{ marginTop: 4 }}>
        <ProbeShape window={window} color={shapeColor} active={active} />
      </div>
      {window.sublimits.length > 0 && (
        <div style={{ marginTop: "var(--s-2)", paddingTop: "var(--s-2)", borderTop: "var(--rule)", display: "flex", flexDirection: "column", gap: "var(--s-1)" }}>
          {window.sublimits.map((sub) => {
            const subColor = sub.usedPercent == null ? "var(--faint)" : resultOf(sub.usedPercent).color;
            return (
              <div
                key={sub.label}
                className="mono"
                title={sub.note ?? `${t("Sub-limit", "Sub-limit")} ${sub.label} ${t("inside this same window.", "wewnątrz tego samego okna.")}`}
                style={{ display: "flex", alignItems: "baseline", gap: "var(--s-3)", fontSize: "var(--fs-2)" }}
              >
                <span style={{ color: "var(--faint)" }}>└</span>
                <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{sub.label}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: "var(--font-figure)", fontWeight: "var(--fw-semibold)", color: subColor }}>
                  {sub.usedPercent == null
                    ? "—"
                    : `${sub.percentBasis === "counterfactual" || sub.percentBasis === "manual" ? "≈" : ""}${sub.usedPercent.toFixed(0)}%`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="rail-row-meta">
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {window.activity ? `${subscriptionPlan("claude", window.activity.plan, window.startIso?.slice(0, 10))} · ` : ""}
          {window.startIso ? dayMonth(window.startIso) : window.dateLabel}{window.activity ? "" : ` · ${timeValue}`}
        </span>
        <span>{railSourceLabel(window)}</span>
      </div>
      {window.usedPercent == null && (window.tokensTotal != null || window.usd != null) && (
        <div
          className="rail-row-meta"
          title={t(
            "The account never reported a percentage for this window. Tokens and API-equivalent cost are measured from the index.",
            "Konto nigdy nie podało procentu dla tego okna. Tokeny i koszt API-eq są zmierzone z indeksu."
          )}
        >
          <span>{window.tokensTotal != null ? compact(window.tokensTotal) : "—"}</span>
          <span>{window.usd != null ? `${usd(window.usd)} API-eq` : "—"}</span>
        </div>
      )}
    </button>
  );
}
export function WindowRail({
  windows,
  pointBasis,
  activeKey,
  cycleDetails,
  medianPercent,
  medianTokens,
  onSelect,
  onInfo,
  width = WINDOW_RAIL_W,
  headerHeight = 52,
}: {
  windows: RailWindow[];
  pointBasis?: CurrentPointBasis | null;
  activeKey: string | null;
  cycleDetails?: { cycles: CycleView[]; points: ApiPoint[] };
  medianPercent: number | null;
  medianTokens: number | null;
  onSelect: (window: RailWindow) => void;
  onInfo?: (window: RailWindow) => void;
  width?: number;
  headerHeight?: number;
}) {
  const { t } = useI18n();
  const cycleRows = useRows(cycleDetails?.cycles ?? [], cycleDetails?.points ?? []);
  const legacyCycles = windows.every((window) => window.source === "cycle") && cycleDetails != null;
  const [hover, setHover] = useState<{ row: Row; top: number; right: number } | null>(null);
  const byIndex = new Map(windows.map((window) => [Number(window.key), window]));
  const lengths = useMemo(() => {
    const set = new Set<number>();
    for (const window of windows) if (window.windowHours != null) set.add(window.windowHours);
    return [...set].sort((a, b) => b - a);
  }, [windows]);
  const [length, setLength] = useState<number | null>(null);
  const activeLength = length != null && lengths.includes(length) ? length : lengths[0] ?? null;
  const visible = useMemo(
    () =>
      activeLength == null || lengths.length < 2
        ? windows
        : windows.filter((window) => window.windowHours === activeLength),
    [windows, activeLength, lengths.length]
  );
  return (
    <aside className="window-rail" style={{ width, flexBasis: width, top: headerHeight, height: `calc(100vh - ${headerHeight}px)` }}>
      <div className={`rail-head${lengths.length > 1 ? " has-lens" : ""}`}>
        <div className="rail-caption">{legacyCycles ? t("Weekly windows", "Okna tygodniowe") : t("Limit windows", "Okna limitu")}</div>
        <div className="rail-sub">
          {visible.length} {t("windows", "okien")} · {t("click to switch", "klik przełącza")}
        </div>
        {lengths.length > 1 && (
          <div className="rail-lens">
            {lengths.map((hours) => {
              const on = hours === activeLength;
              return (
                <button
                  key={hours}
                  onClick={() => {
                    setLength(hours);
                    const next = windows.filter((window) => window.windowHours === hours);
                    const target = next.find((window) => window.isCurrent) ?? next[0];
                    if (target) onSelect(target);
                  }}
                  type="button"
                  aria-pressed={on}
                  title={`${t("Show", "Pokaż")} ${t("windows", "okna")} ${duration(hours)}`}
                >
                  {lengthLabel(hours)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="rail-list">
        {visible.length === 0 && (
          <div className="rail-empty">
            {t("No windows in the index.", "Brak okien w indeksie.")}
          </div>
        )}
        {legacyCycles
          ? cycleRows.map((row) => {
              const window = byIndex.get(row.cycle.index);
              if (!window) return null;
              return (
                <RailRow
                  key={row.cycle.index}
                  row={row}
                  active={window.key === activeKey}
                  compactRow={false}
                  medianPercent={medianPercent}
                  onSelect={() => onSelect(window)}
                  onInfo={() => onInfo?.(window)}
                  onHover={(r, top, right) => setHover(r ? { row: r, top, right } : null)}
                />
              );
            })
          : visible.map((window) => (
              <ProbeRailRow key={window.key} window={window} active={window.key === activeKey} onSelect={onSelect} />
            ))}
      </div>
      {legacyCycles ? (
        <div className="rail-foot">
          <RateTrend cycles={cycleDetails.cycles} basis={pointBasis} />
          <RailCredits cycles={cycleDetails.cycles} visible={cycleRows.map((row) => row.cycle)} basis={pointBasis} />
        </div>
      ) : (
        <div className="rail-foot rail-foot-note">
          {windows[0]?.source === "rolling"
             ? t("xAI · rolling window", "xAI · okno kroczące")
             : visible.some((window) => window.source === "declared")
               ? t("Account readings + windows reconstructed from cadence (cycles.json) - the latter are approximate", "Odczyty z konta + okna odtworzone z rytmu (cycles.json) — te drugie mają ≈")
               : t("Direct account readings", "Odczyty bezpośrednio z konta")}
        </div>
      )}
      {legacyCycles && hover && <HoverCard row={hover.row} top={hover.top} left={hover.right + 8} medianTokens={medianTokens} />}
    </aside>
  );
}
export function CycleRail({
  cycles,
  pointBasis,
  points,
  activeIndex,
  onSelect,
  onInfo,
  medianPercent,
  medianTokens,
  limit = 12,
  maxHeight = 360,
}: {
  cycles: CycleView[];
  pointBasis?: CurrentPointBasis | null;
  points: ApiPoint[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
  onInfo: (index: number) => void;
  medianPercent: number | null;
  medianTokens: number | null;
  limit?: number;
  maxHeight?: number;
}) {
  const { t } = useI18n();
  const rows = useRows(cycles, points, limit);
  const [hover, setHover] = useState<{ row: Row; top: number; right: number } | null>(null);
  return (
    <Card pad="var(--s-6) var(--s-6) var(--s-5)">
      <CardTitle
        title={t("Weekly windows", "Okna tygodniowe")}
        sub={`${cycles.length} ${t("windows in this subscription", "okien tego abonamentu")}`}
        help={t("Click a window to switch to it.", "Kliknij okno, aby się na nie przełączyć.")}
      />
      <div
        style={{
          marginTop: "var(--s-4)",
          maxHeight,
          overflowY: "auto",
          scrollbarGutter: "stable",
          paddingRight: 2,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {rows.length === 0 && (
          <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
            {t("No windows in the index.", "Brak okien w indeksie.")}
          </span>
        )}
        {rows.map((row) => (
          <RailRow
            key={row.cycle.index}
            row={row}
            active={row.cycle.index === activeIndex}
            compactRow
            medianPercent={medianPercent}
            onSelect={onSelect}
            onInfo={onInfo}
            onHover={(r, top, right) => setHover(r ? { row: r, top, right } : null)}
          />
        ))}
      </div>
      <div style={{ marginTop: "var(--s-4)", paddingTop: "var(--s-4)", borderTop: "var(--rule)" }}>
        <RateTrend cycles={cycles} basis={pointBasis} />
        <RailCredits cycles={cycles} visible={rows.map((row) => row.cycle)} basis={pointBasis} />
        {cycles.length > rows.length && (
          <div className="mono" style={{ marginTop: "var(--s-3)", fontSize: "var(--fs-2)", color: "var(--faint)" }}>
            +{cycles.length - rows.length} {t("older - full list is in the table below", "starszych — pełna lista w tabeli niżej")}
          </div>
        )}
      </div>
      {hover && <HoverCard row={hover.row} top={hover.top} left={Math.max(12, window.innerWidth - 300)} medianTokens={medianTokens} />}
    </Card>
  );
}
