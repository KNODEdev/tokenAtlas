import { useMemo } from "react";
import type { ScreenProps } from "../lib/screens";
import type { CycleView } from "../lib/cycle";
import { railWindowsFromCycles, type RailWindow } from "../lib/windows";
import {
  comparedCycles,
  courseAt,
  medianCourse,
  toggleCompared,
  windowEndHours,
  windowHoursCourse,
  windowResult,
  windowResultColor,
  type HoursPoint,
} from "../lib/window-archive";
import { COMPARED_COLORS, CourseChart, SameMomentTable, type CourseLine, type SameMomentRow } from "../components/CourseCompare";
import { Card, EmptyState, HelpDot } from "../components/ui";
import { compact, dayMonth, duration, pct } from "../lib/format";
import { getLocale, useI18n } from "../lib/i18n";
import "./History.css";

const number = (value: number) => value.toLocaleString(getLocale(), { maximumFractionDigits: 0 });

/** At `hours` since start: a reading or a value between two, and a closed window's end once it is over. */
export function usageAtHours(course: readonly HoursPoint[], endHours: number | null, endPercent: number, hours: number): { value: number; exact: boolean } | null {
  if (endHours != null && hours >= endHours) return { value: endPercent, exact: true };
  return courseAt(course, hours);
}

/**
 * Codex cycles side by side: the current one and up to four chosen ones on one hour axis, with the
 * median course of the last closed cycles and the same moment as now in a table (UI audit, Compare).
 */
export function Compare(props: ScreenProps) {
  const { model, compare, setCompare } = props;
  const { t } = useI18n();
  const windows = useMemo(
    () => railWindowsFromCycles(model.cycles, model.series.points, model.series.activity ?? [], model.series.traffic ?? []),
    [model],
  );
  if (model.cycles.length === 0) {
    return (
      <EmptyState
        title={t("No cycles to compare", "Brak cykli do porównania")}
        detail={t("No cycles were found for the selected window and account. Change the account or window length in the top bar.", "W wybranym oknie i koncie nie znaleziono żadnych cykli. Zmień konto albo długość okna w pasku u góry.")}
      />
    );
  }
  const windowOf = (cycle: CycleView): RailWindow | null => windows.find((window) => window.key === String(cycle.index)) ?? null;
  const current = model.current;
  const chosen = comparedCycles(model.cycles, compare);
  const colorOf = (cycle: CycleView) => cycle.isActive ? "var(--accent)" : COMPARED_COLORS[chosen.indexOf(cycle.index) % COMPARED_COLORS.length] ?? "var(--muted)";
  const shown = [...(current ? [current] : []), ...chosen.flatMap((index) => model.cycles.find((cycle) => cycle.index === index) ?? [])];
  const chips = model.cycles.filter((cycle, i) => i < 12 || chosen.includes(cycle.index));
  const hours = current?.windowHours ?? shown[0]?.windowHours ?? 168;
  const nowHours = current ? windowEndHours(windowOf(current)!) : null;
  // A cycle without readings has no course; only its end would flatten the median's start.
  const typicalCourses = model.typical.flatMap((cycle) => { const window = windowOf(cycle); return window?.shape ? [windowHoursCourse(window)] : []; });
  const median = medianCourse(typicalCourses, hours / 48);
  const typicalEnd = median.at(-1)?.[1] ?? null;

  const lines: CourseLine[] = shown.flatMap((cycle) => {
    const window = windowOf(cycle);
    if (!window) return [];
    const endHours = windowEndHours(window);
    const label = cycle.isActive ? `#${number(cycle.number)} · ${pct(cycle.usedPercent)}` : `#${number(cycle.number)} · ${pct(cycle.usedPercent)} · ${duration(cycle.elapsedHours)}`;
    return [{
      key: window.key, color: colorOf(cycle), current: cycle.isActive, points: windowHoursCourse(window), label,
      title: `#${number(cycle.number)} · ${cycle.dateLabel} · ${pct(cycle.usedPercent)} · ${duration(cycle.elapsedHours)}`,
      end: endHours == null ? null : { hours: endHours, percent: cycle.usedPercent, mark: cycle.isActive ? "current" : cycle.usedPercent >= 100 ? "exhausted" : "ended" },
    }];
  });
  const rows: SameMomentRow[] = shown.map((cycle) => {
    const window = windowOf(cycle);
    const at = cycle.isActive ? { value: cycle.usedPercent, exact: true }
      : window && nowHours != null ? usageAtHours(windowHoursCourse(window), windowEndHours(window), cycle.usedPercent, nowHours) : null;
    return {
      key: String(cycle.index), label: `#${number(cycle.number)}`, sub: dayMonth(cycle.startIso), color: colorOf(cycle), current: cycle.isActive, at,
      end: cycle.usedPercent,
      endText: cycle.isActive ? t("in progress", "trwa") : `${pct(cycle.usedPercent)} ${t("after", "po")} ${duration(cycle.elapsedHours)}`,
      extra: [compact(cycle.tokensTotal), cycle.topModel ?? "—"],
    };
  });
  if (typicalEnd != null) {
    const typicalAt = nowHours == null ? null : courseAt(median, nowHours);
    rows.push({
      key: "typical", label: t("typically", "typowo"), sub: t("median of {0} windows", `mediana ${typicalCourses.length} okien`, [typicalCourses.length]),
      color: "var(--violet)", at: typicalAt && { value: typicalAt.value, exact: false },
      end: typicalEnd, extra: ["—", "—"],
    });
  }
  const now = current?.usedPercent ?? null;
  return (
    <div className="archive ui-tab-page">
      <Card>
        <div className="archive-head">
          <div><b>{t("Compare with", "Porównaj z")}</b> <HelpDot label={t("Compare with", "Porównaj z")}>{t("The current window is always included; up to 5 windows. The window rail selects the same windows.", "Bieżące okno jest zawsze zaznaczone; do 5 okien. Szyna okien u góry wybiera to samo.")}</HelpDot></div>
          <div className="archive-chips">
            {chips.map((cycle) => {
              const on = cycle.isActive || chosen.includes(cycle.index);
              const result = windowResult(cycle.usedPercent, cycle.isActive, cycle.elapsedHours, cycle.windowHours);
              return (
                <button key={cycle.index} type="button" className="archive-chip" aria-pressed={on}
                  disabled={!cycle.isActive && !windowOf(cycle)?.shape}
                  title={!cycle.isActive && !windowOf(cycle)?.shape ? t("No readings to draw", "Brak odczytów do narysowania") : `${cycle.dateLabel} · ${pct(cycle.usedPercent)}`}
                  onClick={cycle.isActive ? undefined : () => setCompare(toggleCompared(chosen, cycle.index))}>
                  <i style={{ background: on ? colorOf(cycle) : windowResultColor(result) }} />
                  #{number(cycle.number)} {pct(cycle.usedPercent)}{cycle.isActive ? ` · ${t("current", "bieżące")}` : ""}
                </button>
              );
            })}
          </div>
        </div>
      </Card>
      <Card>
        <div className="archive-head">
          <div><b>{t("Usage since window start", "Zużycie od startu okna")}</b> <HelpDot label={t("Usage since window start", "Zużycie od startu okna")}>{t("Axis: hours since start (the window lasts up to {0}). ✕ = exhausted, ○ = reset early.", `Oś: godziny od startu (okno trwa do ${duration(hours)}). ✕ = wyczerpane, ○ = reset wcześniej.`, [duration(hours)])}</HelpDot></div>
        </div>
        <CourseChart hours={hours} lines={lines} nowHours={nowHours}
          median={typicalEnd == null ? null : { points: median, label: `${t("typically", "typowo")} ${pct(typicalEnd)}` }} forecast={null} />
      </Card>
      <Card>
        <div className="archive-head">
          <div><b>{nowHours != null ? t("At the same moment - {0} from start", `W tym samym momencie — ${duration(nowHours)} od startu`, [duration(nowHours)]) : t("Compared windows", "Porównywane okna")}</b>{" "}
            <HelpDot>{t("≈ = between two readings, nothing beyond them.", "≈ = między dwoma odczytami, nic poza nimi.")}</HelpDot></div>
        </div>
        <SameMomentTable rows={rows} now={now} atLabel={nowHours != null ? t("usage after {0}", `zużycie po ${duration(nowHours)}`, [duration(nowHours)]) : t("usage", "zużycie")}
          extraHeaders={[t("tokens", "tokeny"), t("model", "model")]} />
      </Card>
    </div>
  );
}
