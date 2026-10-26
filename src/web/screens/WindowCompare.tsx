import { useMemo, useState } from "react";
import { buildWindowInsights, sampleCurveAt, windowRegimeKey } from "../lib/window-insights";
import type { RailWindow } from "../lib/windows";
import { medianCourse, windowCounters, windowEndHours, windowHoursCourse, windowPlanKey, windowPlanLabel } from "../lib/window-archive";
import { COMPARED_COLORS, CourseChart, SameMomentTable, type CourseLine, type SameMomentRow } from "../components/CourseCompare";
import { Card, EmptyState, Pill, Tabs, HelpDot } from "../components/ui";
import { clockTime, dayMonth, dayTime, duration, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import "./History.css";

const SHOWN_CLOSED = 4;

/** Plan of a window as a short label; the provider is the counter key's prefix. */
function planOf(window: RailWindow): string {
  return windowPlanLabel(window.counterKey?.split(":")[0] ?? "", windowPlanKey(window), window.startIso?.slice(0, 10));
}

/**
 * Closed windows worth drawing next to the current one: the newest with readings. Windows of another
 * plan or cadence stay in grey and out of the typical course (UI audit decision 13).
 */
export function comparedWindows(rows: RailWindow[], reference: RailWindow | null): Array<{ window: RailWindow; comparable: boolean }> {
  const regime = reference ? windowRegimeKey(reference) : null;
  return rows
    .filter((row) => row !== reference && !row.isCurrent && row.percentBasis === "measured" && (row.shape?.length ?? 0) > 0)
    .slice(0, SHOWN_CLOSED)
    .map((window) => ({ window, comparable: regime != null && windowRegimeKey(window) === regime }));
}

/**
 * Windows of vendors without a cycle series (Claude, Gemini, GLM) on one hour axis: the current
 * window, the newest closed ones and the typical course of windows with the same plan and cadence.
 */
export function WindowCompare({ windows, account }: { windows: RailWindow[]; account: string }) {
  const { t } = useI18n();
  const counters = useMemo(
    () => windowCounters(windows, "shortest").filter((counter) => counter.rows.some((row) => row.isCurrent || (row.percentBasis === "measured" && row.shape))),
    [windows],
  );
  const [counterKey, setCounterKey] = useState<string | null>(null);
  const active = counters.find((counter) => counter.key === counterKey) ?? counters[0] ?? null;
  if (!active) {
    return (
      <EmptyState
        title={`${account} ${t("has no windows to compare yet", "nie ma jeszcze okien do porównania")}`}
        detail={t("Comparison needs windows with percentage readings from the account. Windows reconstructed from the cadence stay in History.", "Porównanie potrzebuje okien z odczytami procentu z konta. Okna odtworzone z rytmu zostają w Historii.")}
      />
    );
  }
  const tabs = counters.length > 1 && (
    <div role="region" aria-label={t("Comparison counter selection", "Wybór licznika porównania")} tabIndex={0} style={{ maxWidth: "100%", overflowX: "auto", paddingBottom: 2 }}>
      <Tabs value={active.key} onChange={setCounterKey} options={counters.map((counter) => ({ value: counter.key, label: counter.label }))} />
    </div>
  );
  const current = active.rows.find((row) => row.isCurrent && row.usedPercent != null) ?? null;
  const reference = current ?? active.rows.find((row) => row.percentBasis === "measured" && row.shape) ?? null;
  const insight = current ? buildWindowInsights(active.rows).find((item) => !item.isSublimit && item.current.windowKey === current.key) ?? null : null;
  const closed = comparedWindows(active.rows, reference);
  const hours = reference?.windowHours ?? active.windowHours ?? 168;
  const nowHours = current ? windowEndHours(current) : null;
  const elapsed = current?.elapsedPercent ?? null;
  const typicalWindows = insight && !insight.buildingHistory
    ? insight.comparableWindows.flatMap((item) => active.rows.find((row) => row.key === item.windowKey) ?? [])
    : [];
  const median = medianCourse(typicalWindows.map(windowHoursCourse), hours / 48);
  const typicalEnd = insight?.typicalEndPercent ?? null;
  const short = hours < 24;
  const when = (window: RailWindow) => short ? dayTime(window.startIso) : dayMonth(window.startIso);
  let colorIndex = 0;
  const colored = closed.map((item) => ({ ...item, color: item.comparable ? COMPARED_COLORS[colorIndex++ % COMPARED_COLORS.length]! : "var(--faint)" }));
  const otherBadge = (window: RailWindow) => (
    <Pill tone="neutral">{reference && windowPlanKey(window) !== windowPlanKey(reference) ? `${t("other plan", "inny plan")} · ${planOf(window)}` : t("other cadence", "inny rytm")}</Pill>
  );

  const lines: CourseLine[] = colored.map(({ window, comparable, color }) => {
    const course = windowHoursCourse(window);
    const last = course.at(-1);
    return {
      key: window.key, color, muted: !comparable, points: course,
      label: `${short ? clockTime(window.startIso) : dayMonth(window.startIso)} · ${pct(window.usedPercent)}`,
      title: `${dayTime(window.startIso)} → ${dayTime(window.resetIso)} · ${planOf(window)} · ${pct(window.usedPercent)}`,
      end: last ? { hours: last[0], percent: last[1], mark: last[1] >= 100 ? "exhausted" : "ended" } : null,
    };
  });
  if (current && nowHours != null) {
    lines.push({
      key: current.key, color: "var(--accent)", current: true, points: windowHoursCourse(current),
      label: `${t("now", "teraz")} ${pct(current.usedPercent)}`, title: `${dayTime(current.startIso)} → ${dayTime(current.resetIso)} · ${planOf(current)}`,
      end: { hours: nowHours, percent: current.usedPercent!, mark: "current" },
    });
  }
  const forecast = current && nowHours != null && insight?.forecastPercent != null
    ? { from: [nowHours, current.usedPercent!] as const, to: [hours, insight.forecastPercent] as const, label: `≈ ${pct(insight.forecastPercent)}` }
    : null;
  const rows: SameMomentRow[] = [
    ...(current ? [{
      key: current.key, label: t("current", "bieżące"), sub: dayTime(current.startIso), color: "var(--accent)", current: true,
      at: { value: current.usedPercent!, exact: current.percentBasis === "measured" }, end: insight?.forecastPercent ?? null,
      endText: insight?.forecastPercent != null ? `≈ ${pct(insight.forecastPercent)} (${t("forecast", "prognoza")})` : "—",
    }] : []),
    ...colored.map(({ window, comparable, color }): SameMomentRow => {
      const sample = elapsed == null ? null : sampleCurveAt(window.shape, elapsed, window.activityShape);
      return {
        key: window.key, label: when(window), color, muted: !comparable, badge: comparable ? undefined : otherBadge(window),
        at: sample && { value: sample.value, exact: sample.basis === "measured" }, end: window.usedPercent,
      };
    }),
    ...(typicalEnd != null ? [{
      key: "typical", label: t("typically", "typowo"), sub: t("median of {0} windows", `mediana ${insight!.baselineCount} okien`, [insight!.baselineCount]),
      color: "var(--violet)", at: insight!.typicalAtElapsed == null ? null : { value: insight!.typicalAtElapsed, exact: false }, end: typicalEnd,
    }] : []),
  ];
  const plan = reference ? planOf(reference) : null;
  return (
    <div className="archive ui-tab-page">
      {tabs}
      <Card>
        <div className="archive-head">
          <div>
            <b>{short ? t("Usage since session start", "Zużycie od startu sesji") : t("Usage since window start", "Zużycie od startu okna")}</b>{" "}
            <span className="archive-sub">· {t("the same plan ({0}) and cadence", `ten sam plan (${plan}) i rytm`, [plan])}</span>{" "}
            <HelpDot>{t("○ = end of the window. Grey = another plan, left out of the typical course.", "○ = koniec okna. Szare = inny plan, poza typowym przebiegiem.")}{forecast ? ` ┅ = ${t("forecast of the current window.", "prognoza bieżącego okna.")}` : ""}</HelpDot>
          </div>
        </div>
        <CourseChart hours={hours} lines={lines} nowHours={nowHours}
          median={typicalEnd != null && median.length > 1 ? { points: median, label: `${t("typically", "typowo")} ${pct(typicalEnd)}` } : null}
          forecast={forecast} />
        {insight?.buildingHistory && (
          <div className="archive-note">
            {t("Building history: {0}/2 closed windows with the same plan and cadence. Until then there is no typical course or forecast.",
              `Buduję historię: ${Math.min(insight.baselineCount, 2)}/2 zamkniętych okien z tym samym planem i rytmem. Do tego czasu nie ma typowego przebiegu ani prognozy.`, [Math.min(insight.baselineCount, 2)])}
          </div>
        )}
      </Card>
      <Card>
        <div className="archive-head">
          <div>
            <b>{nowHours != null && elapsed != null
              ? t("At the same moment - {0} from start ({1} of the window)", `W tym samym momencie — ${duration(nowHours)} od startu (${pct(elapsed)} okna)`, [duration(nowHours), pct(elapsed)])
              : t("Compared windows", "Porównywane okna")}</b>{" "}
            <HelpDot>{t("≈ = between two readings, nothing beyond them.", "≈ = między dwoma odczytami, nic poza nimi.")}</HelpDot>
          </div>
        </div>
        <SameMomentTable rows={rows} now={current?.usedPercent ?? null}
          atLabel={nowHours != null ? t("usage after {0}", `zużycie po ${duration(nowHours)}`, [duration(nowHours)]) : t("usage", "zużycie")} />
      </Card>
    </div>
  );
}
