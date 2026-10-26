import { calendarDateLabels } from "../lib/chart-dates";
import { ChartExport } from "../components/ChartExport";
import { useMemo, useState, type ReactNode } from "react";
import type { ScreenProps } from "../lib/screens";
import type { AtlasModel } from "../lib/cycle";
import { api } from "../lib/api";
import { Card, Eyebrow, Pill, toneColor, type Tone, HelpDot } from "../components/ui";
import { Track, useWidth } from "../components/WindowStatusCard";
import { ActivityHeatmap } from "../components/ActivityHeatmap";
import { spacedTicks } from "../components/WindowBarChart";
import { separatedLabels, textWidth, type LabelBox } from "../components/CapacityHistoryChart";
import {
  ANOMALY_SEVERITY, allowanceSummary, anomalyLanes, findAnomalies, orderAnomalies, patternFindings, typicalCourse,
  type Anomaly, type AnomalyKind, type AnomalySeverity, type CoursePoint,
} from "../lib/cycle-insights";
import { windowResult, windowResultColor } from "../lib/window-archive";
import { compact, dayMonth, duration, pct, signedPct, signedPp } from "../lib/format";
import { useI18n } from "../lib/i18n";
import "./History.css";
import "./Insights.css";

/** The heatmap reads the selected subscription only (UI audit finding 1). */
export function activityRequest(account: string, project: string) {
  return { account, project_id: project || undefined };
}

/**
 * How the selected subscription works (docs/ui-audit-2026-09-26.md, Patterns; decision 8): the typical
 * window course with the windows behind it, its working hours, and anomalies with risks first.
 */
export function Patterns(props: ScreenProps) {
  const { model, openDrawer, account, project } = props;
  return (
    <div className="archive ui-tab-page">
      <CourseCard model={model} />
      <ActivityHeatmap load={(signal) => api.activity(activityRequest(account, project), signal)} deps={[account, project]} scope={account} />
      <AnomalyCard model={model} openDrawer={openDrawer} />
    </div>
  );
}

/** A card's own title: the display voice (docs/design/paper-atlas.md §2). */
const CARD_TITLE = { fontSize: "var(--fs-card-title)", color: "var(--text)" } as const;
// Axis text in the figure voice (docs/design/paper-atlas.md, charts).
const TICK = { fontFamily: "var(--font-figure)", fontSize: 10, fill: "var(--muted)" } as const;

// A course point resting on fewer windows than this is drawn thin and dashed.
const MIN_WINDOWS = 10;
// Course chart geometry in CSS pixels.
const CX0 = 40, CY_TOP = 14, CY0 = 194, STRIP_Y = 226, STRIP_H = 22, COURSE_H = 272, NOTE_FONT = 11;

function CourseCard({ model }: { model: AtlasModel }) {
  const { t, locale } = useI18n();
  const course = useMemo(() => typicalCourse(model), [model]);
  const findings = useMemo(() => patternFindings(model), [model]);
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const head = (
    <div className="archive-head">
      <div><span className="ui-display" style={CARD_TITLE}>{t("Typical window course", "Typowy przebieg okna")}</span> <HelpDot label={t("Typical window course", "Typowy przebieg okna")}>{t("X axis: share of the window's time.", "Oś X: część czasu okna.")}</HelpDot> <span className="archive-sub">· {t("average of {0} closed windows", `średnia z ${whole.format(model.closed.length)} zamkniętych okien`, [whole.format(model.closed.length)])}</span></div>
    </div>
  );
  if (course.length === 0) {
    return <Card>{head}<div className="archive-empty" style={{ marginTop: 10 }}>
      {t("Too few closed windows with readings to show a typical course. At least two are needed.", "Za mało zamkniętych okien z odczytami, by pokazać typowy przebieg. Potrzebne są co najmniej dwa.")}
    </div></Card>;
  }
  return (
    <Card><ChartExport title={t("Typical window course", "Typowy przebieg okna")}>
      {head}
      <div className="insights-course">
        <CourseChart course={course} findings={findings} />
        <Findings findings={findings} />
      </div>
      <div className="archive-legend">
        <span><i className="insights-line" />{t("average · at least {0} windows", `średnia · co najmniej ${MIN_WINDOWS} okien`, [MIN_WINDOWS])}</span>
        <span><i className="insights-line is-thin" />{t("fewer than {0} windows reached this point", `mniej niż ${MIN_WINDOWS} okien dotrwało do tego momentu`, [MIN_WINDOWS])}</span>
        <span><i className="insights-line is-even" />{t("even pace", "równe tempo")}</span>
      </div>
    </ChartExport></Card>
  );
}

function CourseChart({ course, findings }: { course: CoursePoint[]; findings: ReturnType<typeof patternFindings> }) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(720);
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const X1 = width - 12;
  const x = (share: number) => CX0 + (Math.min(Math.max(share, 0), 100) / 100) * (X1 - CX0);
  const y = (percent: number) => CY0 - (Math.min(Math.max(percent, 0), 100) / 100) * (CY0 - CY_TOP);
  const points = course.map((p) => `${x(p.t)},${y(p.v)}`);
  // The solid part ends at the last point that still rests on enough windows.
  const cut = course.findIndex((p) => p.windows < MIN_WINDOWS);
  const solidEnd = cut < 0 ? course.length : cut;
  const maxWindows = Math.max(...course.map((p) => p.windows));
  const quarter = course.find((p) => p.t === 25);
  const lastQuarter = course.find((p) => p.t === 75);
  // Labels in priority order; each takes its first position that clears the labels placed before it,
  // and one that fits nowhere is left out. The text carries a halo so crossing lines stay readable.
  const notes: Array<{ lines: [string, string]; x: number; y: number; anchor: "start" | "end"; box: LabelBox }> = [];
  const note = (lines: [string, string], px: number, positions: Array<{ py: number; preferLeft: boolean }>) => {
    const w = Math.max(textWidth(lines[0], NOTE_FONT + 1), textWidth(lines[1], NOTE_FONT - 1));
    const placed = positions.map(({ py, preferLeft }) => {
      const left = (preferLeft && px - 10 - w >= CX0) || px + 10 + w > X1;
      // Both lines stay inside the plot, above the time axis.
      const ny = Math.min(Math.max(py, CY_TOP + NOTE_FONT), CY0 - NOTE_FONT - 12);
      const nx = left ? px - 10 : px + 10, top = ny - NOTE_FONT;
      return { lines, x: nx, y: ny, anchor: left ? "end" as const : "start" as const, box: { left: left ? nx - w : nx, right: left ? nx : nx + w, top, bottom: top + 2 * NOTE_FONT + 6 } };
    });
    notes.push(placed.find((candidate) => separatedLabels([candidate.box], notes.map((n) => n.box))[0]) ?? placed[0]!);
  };
  const half = findings.halfLimit;
  if (half) note([t("50% after {0}", `50% po ${duration(half.hours)}`, [duration(half.hours)]),
    t("median · {0} windows · {1} of window", `mediana · ${whole.format(half.windows)} okien · ${pct(half.share)} okna`, [whole.format(half.windows), pct(half.share)])], x(half.share),
    // Below and right of the point: the course rises to its left.
    [{ py: y(50) + 18, preferLeft: false }, { py: y(50) - 8, preferLeft: true }]);
  if (quarter && findings.quarter) note([t("{0} after ¼ of the time", `${pct(quarter.v)} po ¼ czasu`, [pct(quarter.v)]),
    t("{0} of {1} windows above 25%", `${whole.format(findings.quarter.above)} z ${whole.format(findings.quarter.windows)} okien powyżej 25%`, [whole.format(findings.quarter.above), whole.format(findings.quarter.windows)])], x(25),
    [{ py: y(quarter.v) + 16, preferLeft: false }, { py: y(quarter.v) + 50, preferLeft: false }, { py: y(quarter.v) - 22, preferLeft: true }]);
  if (lastQuarter && lastQuarter.windows < MIN_WINDOWS) note([t("last ¼: only {0} windows", `ostatnia ¼: tylko ${whole.format(lastQuarter.windows)} okien`, [whole.format(lastQuarter.windows)]),
    t("many windows reset earlier", "wiele okien resetuje się wcześniej")], x(75),
    [{ py: y(lastQuarter.v) + 16, preferLeft: true }, { py: y(lastQuarter.v) + 50, preferLeft: true }]);
  const kept = separatedLabels(notes.map((n) => n.box));
  return (
    <div ref={ref} className="archive-chart" style={{ minWidth: 0, overflow: "hidden" }}>
      <svg viewBox={`0 0 ${width} ${COURSE_H}`} width={width} height={COURSE_H} role="img" aria-label={t("Typical window course", "Typowy przebieg okna")}>
        {[25, 50, 75, 100].map((p) => <g key={p}>
          <line x1={CX0} x2={X1} y1={y(p)} y2={y(p)} stroke={p === 100 ? "var(--text)" : "var(--line)"} strokeWidth={p === 100 ? 1.3 : 1} strokeDasharray={p === 100 ? undefined : "3 4"} />
          <text x={CX0 - 8} y={y(p) + 4} textAnchor="end" {...TICK} fill={p === 100 ? "var(--text)" : TICK.fill}>{p}%</text>
        </g>)}
        <line x1={CX0} x2={X1} y1={CY0} y2={CY0} stroke="var(--line2)" />
        {[0, 25, 50, 75, 100].map((share) => <text key={share} x={x(share)} y={CY0 + 14} textAnchor={share === 0 ? "start" : share === 100 ? "end" : "middle"} {...TICK}>
          {share === 0 ? t("start", "start") : share === 100 ? t("reset", "reset") : `${share}%`}
        </text>)}
        <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(100)} stroke="var(--muted)" strokeDasharray="3 4" />
        {solidEnd > 1 && <polyline points={points.slice(0, solidEnd).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />}
        {solidEnd < course.length && <polyline points={points.slice(Math.max(0, solidEnd - 1)).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="4 3" />}
        {quarter && <circle cx={x(25)} cy={y(quarter.v)} r={5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />}
        {half && <path d={`M${x(half.share)},${y(50) - 6}l6,6l-6,6l-6,-6z`} fill="var(--muted)" />}
        {lastQuarter && lastQuarter.windows < MIN_WINDOWS && <circle cx={x(75)} cy={y(lastQuarter.v)} r={4} fill="var(--surface)" stroke="var(--accent)" strokeWidth={1.5} />}
        {notes.map((n, i) => kept[i] && <text key={i} x={n.x} y={n.y} textAnchor={n.anchor} className="insights-halo" pointerEvents="none">
          <tspan fontSize={NOTE_FONT + 1} fontWeight={600} fill="var(--text)">{n.lines[0]}</tspan>
          <tspan x={n.x} dy={NOTE_FONT + 3} fontSize={NOTE_FONT - 1} fill="var(--muted)">{n.lines[1]}</tspan>
        </text>)}
        <text x={0} y={STRIP_Y - 4} fontSize={10} fill="var(--muted)">{t("windows", "okna")}</text>
        {course.map((p, i) => {
          const h = Math.max(1.5, (p.windows / maxWindows) * STRIP_H), w = Math.max(3, (X1 - CX0) / 21 - 3);
          return <g key={p.t}>
            <title>{t("{0}% of the time: {1} windows", `${p.t}% czasu: ${p.windows} okien`, [p.t, p.windows])}</title>
            <rect x={x(p.t) - w / 2} y={STRIP_Y + STRIP_H - h} width={w} height={h} rx={1.5} fill={p.windows < MIN_WINDOWS ? "var(--line2)" : "color-mix(in srgb, var(--accent) 45%, var(--surface))"} />
            {(i % 4 === 0 || i === course.length - 1) && <text x={x(p.t)} y={STRIP_Y + STRIP_H + 12} textAnchor="middle" {...TICK}>{p.windows}</text>}
          </g>;
        })}
      </svg>
    </div>
  );
}

function Finding({ label, value, visual, caption }: { label: string; value: ReactNode; visual: ReactNode; caption: ReactNode }) {
  return (
    <div className="insights-finding">
      <Eyebrow>{label}</Eyebrow>
      <div className="ui-figure insights-finding-value">{value}</div>
      {visual}
      <div className="mono insights-finding-caption">{caption}</div>
    </div>
  );
}

function Findings({ findings }: { findings: ReturnType<typeof patternFindings> }) {
  const { t, locale } = useI18n();
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const { lastClosed, headroom, pace, halfLimit, quarter } = findings;
  const exhausted = lastClosed.filter((c) => c.usedPercent >= 100).length;
  return (
    <div className="insights-findings">
      <Eyebrow>{t("Findings · closed windows", "Wnioski · zamknięte okna")}</Eyebrow>
      {lastClosed.length > 0 && <Finding label={t("Exhausted", "Wyczerpane")} value={t("{0} of {1}", `${exhausted} z ${lastClosed.length}`, [exhausted, lastClosed.length])}
        visual={<div className="insights-squares">{lastClosed.slice().reverse().map((c) => (
          <span key={c.index} title={`#${whole.format(c.number)} · ${pct(c.usedPercent)}`} style={{ background: windowResultColor(windowResult(c.usedPercent, false, c.elapsedHours, c.windowHours)) }} />
        ))}</div>}
        caption={t("the last {0}, oldest → newest", `ostatnie ${lastClosed.length}, od najstarszego`, [lastClosed.length])} />}
      {headroom && <Finding label={t("Headroom at reset", "Zapas przy resecie")} value={pct(headroom.median)}
        visual={<Track fill={100 - headroom.median} tick={70} color="var(--violet)" />}
        caption={t("median · {0} of {1} ended under 70%", `mediana · ${whole.format(headroom.under70)} z ${whole.format(headroom.windows)} poniżej 70%`, [whole.format(headroom.under70), whole.format(headroom.windows)])} />}
      {pace && <Finding label={t("Daily pace", "Tempo dzienne")} value={signedPct(pace.change)}
        visual={<div className="insights-pair">
          <Track fill={(pace.older / Math.max(pace.older, pace.recent)) * 100} color="var(--line2)" title={`${compact(pace.older)}/d`} />
          <Track fill={(pace.recent / Math.max(pace.older, pace.recent)) * 100} color="var(--accent)" title={`${compact(pace.recent)}/d`} />
        </div>}
        caption={t("{0} → {1}/d · {2} vs {3} windows", `${compact(pace.older, 1)} → ${compact(pace.recent, 1)}/d · ${pace.windows / 2} vs ${pace.windows / 2} okien`, [compact(pace.older, 1), compact(pace.recent, 1), pace.windows / 2, pace.windows / 2])} />}
      {halfLimit && <Finding label={t("50% of the limit after", "50% limitu po")} value={duration(halfLimit.hours)}
        visual={<Track fill={halfLimit.share} color="var(--muted)" />}
        caption={t("median of {0} windows · {1} of the window", `mediana ${whole.format(halfLimit.windows)} okien · ${pct(halfLimit.share)} okna`, [whole.format(halfLimit.windows), pct(halfLimit.share)])} />}
      {quarter && <Finding label={t("After ¼ of the time", "Po ¼ czasu")} value={pct(quarter.value)}
        visual={<Track fill={quarter.value} tick={25} color="var(--accent)" title={t("tick: even pace", "kreska: równe tempo")} />}
        caption={t("{0} of {1} windows above even pace", `${whole.format(quarter.above)} z ${whole.format(quarter.windows)} okien powyżej równego tempa`, [whole.format(quarter.above), whole.format(quarter.windows)])} />}
    </div>
  );
}

const SEVERITY_TONE: Record<AnomalySeverity, Tone> = { risk: "crit", noteworthy: "warn", informational: "accent" };
const LIST_ROWS = 6;
// Lane map geometry in CSS pixels; the left column holds the lane names, the right one their counts.
const LX0 = 136, L_RIGHT = 40, LANE_H = 22, LANE_TOP = 8;

function AnomalyCard({ model, openDrawer }: { model: AtlasModel; openDrawer: (index: number) => void }) {
  const { t, locale } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [ref, width] = useWidth(720);
  const anomalies = useMemo(() => orderAnomalies(findAnomalies(model, allowanceSummary(model))), [model]);
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const kindLabel = (kind: AnomalyKind) => {
    switch (kind) {
      case "exhausted": return t("exhausted", "wyczerpane");
      case "near": return t("≥ 95% of limit", "≥ 95% limitu");
      case "tokens": return t("token spike", "skok tokenów");
      case "pace": return t("intense pace", "intensywne tempo");
      case "allowance": return t("allowance outlier", "limit poza zakresem");
      case "lag": return t("delayed readings", "opóźnione odczyty");
    }
  };
  const severityLabel = (severity: AnomalySeverity) =>
    severity === "risk" ? t("risk", "ryzyko") : severity === "noteworthy" ? t("noteworthy", "warte uwagi") : t("informational", "informacyjne");
  const describe = (a: Anomaly): [string, string] => {
    const c = a.cycle;
    switch (a.kind) {
      case "exhausted": return [t("Limit exhausted before reset", "Limit wyczerpany przed resetem"), t("100% in {0}", `100% w ${duration(c.elapsedHours)}`, [duration(c.elapsedHours)])];
      case "near": return [t("Usage reached {0}", `Zużycie doszło do ${pct(c.usedPercent)}`, [pct(c.usedPercent)]),
        model.median.peakPercent == null ? "≥ 95%" : t("{0} vs typical end", `${signedPp(c.usedPercent - model.median.peakPercent)} vs typowy koniec`, [signedPp(c.usedPercent - model.median.peakPercent)])];
      case "tokens": return [t("Token spike ({0})", `Skok tokenów (${compact(c.tokensTotal)})`, [compact(c.tokensTotal)]),
        a.ratio === null ? "—" : t("{0}× a typical window", `${decimal.format(a.ratio)}× typowe okno`, [decimal.format(a.ratio)])];
      case "pace": return [t("Intense daily pace ({0}/d)", `Intensywne tempo dzienne (${compact(c.burnPerDay)}/d)`, [compact(c.burnPerDay)]),
        t("{0} vs typical", `${signedPct(((a.ratio ?? 1) - 1) * 100)} vs typowe`, [signedPct(((a.ratio ?? 1) - 1) * 100)])];
      case "allowance": return [t("Allowance outside the usual range ({0})", `Limit poza typowym zakresem (${compact(c.calibration.allowanceTokens)})`, [compact(c.calibration.allowanceTokens)]),
        t("{0} vs median", `${signedPct(a.ratio)} vs mediana`, [signedPct(a.ratio)])];
      case "lag": return [t("Delayed gauge readings", "Opóźnione odczyty licznika"), t("{0} of readings delayed", `${pct((a.ratio ?? 0) * 100)} odczytów opóźnionych`, [pct((a.ratio ?? 0) * 100)])];
    }
  };
  const lanes = anomalyLanes(anomalies);
  const windows = new Set(anomalies.map((a) => a.cycle.index)).size;
  const risks = anomalies.filter((a) => ANOMALY_SEVERITY[a.kind] === "risk").length;
  const cycles = model.cycles.slice().reverse();
  const slot = new Map(cycles.map((c, i) => [c.index, i]));
  const x1 = width - L_RIGHT, step = (x1 - LX0) / Math.max(1, cycles.length);
  const cx = (i: number) => LX0 + i * step + step / 2;
  const laneY = (i: number) => LANE_TOP + i * LANE_H + LANE_H / 2;
  const tickY = LANE_TOP + lanes.length * LANE_H + 14, height = tickY + 6;
  const tickTexts = calendarDateLabels(cycles.map((c) => c.startIso), locale).map((text, i) => ({ center: cx(i), text }));
  const keptTicks = spacedTicks(tickTexts);
  const shown = showAll ? anomalies : anomalies.slice(0, LIST_ROWS);
  return (
    <Card>
      <div className="archive-head">
        <div><span className="ui-display" style={CARD_TITLE}>{t("Anomalies", "Anomalie")}</span>{anomalies.length > 0 && <> <HelpDot label={t("Anomalies", "Anomalie")}>{t("Risks first. Click a row to open the window panel.", "Najpierw ryzyka. Kliknij wiersz, aby otworzyć panel okna.")}</HelpDot></>} <span className="archive-sub">· {anomalies.length === 0
          ? t("none in {0} windows", `brak w ${whole.format(model.cycles.length)} oknach`, [whole.format(model.cycles.length)])
          : t("{0} in {1} windows · {2} risks",
            `${whole.format(anomalies.length)} w ${whole.format(windows)} oknach · ${whole.format(risks)} ryzyk`, [whole.format(anomalies.length), whole.format(windows), whole.format(risks)])}</span></div>
      </div>
      {anomalies.length > 0 && <>
        <ChartExport title={t("Anomalies by window", "Anomalie według okien")}><div ref={ref} className="archive-chart" style={{ minWidth: 0, overflow: "hidden" }}>
          <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={t("Anomalies by window", "Anomalie według okien")}>
            {lanes.map((lane, li) => {
              const color = toneColor(SEVERITY_TONE[ANOMALY_SEVERITY[lane.kind]]);
              return <g key={lane.kind}>
                <line x1={LX0} x2={x1} y1={laneY(li)} y2={laneY(li)} stroke="var(--line)" strokeDasharray="3 4" />
                <text x={LX0 - 10} y={laneY(li) + 4} textAnchor="end" fontSize={11} fill={color}>{kindLabel(lane.kind)}</text>
                <text x={x1 + 8} y={laneY(li) + 4} fontFamily="var(--font-figure)" fontSize={11} fontWeight={500} fill={color}>{whole.format(lane.indices.length)}</text>
                {lane.indices.map((index) => {
                  const cycle = model.cycles.find((c) => c.index === index)!;
                  return <g key={index} className="archive-bar" tabIndex={0} role="button" onClick={() => openDrawer(index)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDrawer(index); } }}>
                    <title>{`${kindLabel(lane.kind)} · #${whole.format(cycle.number)} · ${dayMonth(cycle.startIso)}`}</title>
                    <circle cx={cx(slot.get(index) ?? 0)} cy={laneY(li)} r={Math.min(4, Math.max(2, step / 2 - 0.5))} fill={color} />
                  </g>;
                })}
              </g>;
            })}
            {tickTexts.map(({ center, text }, i) => keptTicks[i] && <text key={i} x={center} y={tickY} textAnchor="middle" {...TICK}>{text}</text>)}
          </svg>
        </div></ChartExport>
        <div className="insights-anomalies">
          {shown.map((a) => {
            const [title, metric] = describe(a);
            const severity = ANOMALY_SEVERITY[a.kind];
            return (
              <button key={`${a.kind}:${a.cycle.index}`} type="button" className="insights-anomaly" onClick={() => openDrawer(a.cycle.index)}>
                <Pill tone={SEVERITY_TONE[severity]}>{severityLabel(severity)}</Pill>
                <span className="insights-anomaly-title">{title}</span>
                <span className="mono archive-muted">{metric}</span>
                <span className="mono archive-faint">#{whole.format(a.cycle.number)} · {dayMonth(a.cycle.startIso)}</span>
              </button>
            );
          })}
        </div>
        {anomalies.length > LIST_ROWS && (
          <button type="button" className="archive-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? t("fold to {0} ▴", `zwiń do ${LIST_ROWS} ▴`, [LIST_ROWS]) : t("show all {0} ▾", `pokaż wszystkie ${anomalies.length} ▾`, [anomalies.length])}
          </button>
        )}
      </>}
    </Card>
  );
}
