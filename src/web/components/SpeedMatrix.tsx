import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { compact } from "../lib/format";
import { NO_EXECUTION, UNKNOWN_EFFORT, effortColumn, isNewRow, matrixLayout, type MatrixSeries } from "../lib/speed-matrix";

/** `ink` is the model's own colour (the row swatch); `color` the series' shade of it. */
export interface SpeedMatrixItem extends MatrixSeries { label: string; ink: string; color: string; dash: string | undefined; value: number | null }

/**
 * The chart's legend as model × effort (docs/design/mockups/speed-legend-matrix.html): a cell toggles one series, a row
 * name its model in that speed mode, a column head that effort everywhere. Hovering a cell picks its line out on the chart.
 */
export function SpeedMatrix({ items, hidden, onToggle, onHover, firstDay, today, format, valueTitle, countLabel, actions }: {
  items: SpeedMatrixItem[]; hidden: ReadonlySet<string>; onToggle: (keys: string[]) => void; onHover: (key: string | null) => void;
  /** The first day of a series in the whole history, for the "new" mark. */
  firstDay: (key: string) => string | null; today: string;
  /** `calls` of each item are what `countLabel` names (calls, or measured turns for first-token metrics). */
  format: (value: number) => string; valueTitle: string; countLabel: string; actions: ReactNode;
}) {
  const { t } = useI18n();
  const { columns, sections } = matrixLayout(items);
  const all = (keys: string[]) => keys.every(key => !hidden.has(key));
  const heading = (column: string) => column === UNKNOWN_EFFORT ? { label: "?", title: t("unknown effort", "effort nieznany") }
    : column === NO_EXECUTION ? { label: "—", title: t("No reasoning setting recorded", "Brak zapisanego poziomu rozumowania") }
    : { label: column, title: column };
  const sectionName = (section: string) => section === "fast" ? "⚡ fast" : section === "mixed" ? t("mixed", "mieszany")
    : section.startsWith("unknown:") ? `${t("unknown", "nieznany")} (${section.slice(8)})` : section === "unknown" ? t("unknown", "nieznany") : section;
  const showHide = (on: boolean) => on ? t("Hide from the chart", "Ukryj na wykresie") : t("Show on the chart", "Pokaż na wykresie");
  return <div className="speed-matrix" onMouseLeave={() => onHover(null)}>
    <table>
      <thead><tr>
        <th className="speed-matrix-name" />
        {columns.map(column => {
          const keys = items.filter(item => effortColumn(item.series) === column).map(item => item.key);
          const { label, title } = heading(column);
          return <th key={column}><button type="button" className="speed-matrix-head" aria-pressed={all(keys)}
            title={`${title} · ${showHide(all(keys))}`} onClick={() => onToggle(keys)}>{label}</button></th>;
        })}
        <th className="speed-matrix-calls" title={valueTitle}>{countLabel}</th>
      </tr></thead>
      {sections.map(({ section, rows }, index) => <tbody key={section}>
        {(index > 0 || section !== "standard") && <tr className="speed-matrix-section"><td colSpan={columns.length + 2}>
          {sectionName(section)} <span>{t("{0} models · {1} series", `${rows.length} modele · ${rows.reduce((sum, row) => sum + row.cells.size, 0)} serii`,
            [rows.length, rows.reduce((sum, row) => sum + row.cells.size, 0)])}</span>
        </td></tr>}
        {rows.map(row => {
          const keys = [...row.cells.values()].map(item => item.key);
          const first = keys.map(firstDay).filter((day): day is string => day !== null).sort()[0] ?? null;
          return <tr key={row.id}>
            <th className="speed-matrix-name"><button type="button" className="speed-matrix-row" aria-pressed={all(keys)}
              title={`${row.name} · ${showHide(all(keys))}`} onClick={() => onToggle(keys)}>
              <span className="speed-swatch" style={{ background: [...row.cells.values()][0]!.ink }} />
              <span className="speed-matrix-label">{row.name}</span>
              {isNewRow(first, today) && <span className="speed-matrix-new" title={t("First calls on {0}", `Pierwsze wywołania ${first}`, [first])}>
                {t("new", "nowy")}</span>}
            </button></th>
            {columns.map(column => {
              const item = row.cells.get(column);
              if (!item) return <td key={column}><span className="speed-matrix-none" aria-hidden="true">·</span></td>;
              const on = !hidden.has(item.key);
              return <td key={column}><button type="button" className={`speed-cell${on ? "" : " is-off"}`} aria-pressed={on} aria-label={item.label}
                title={`${item.label} · ${compact(item.calls)} ${countLabel}\n${showHide(on)}`}
                onClick={() => onToggle([item.key])} onMouseEnter={() => onHover(on ? item.key : null)} onFocus={() => onHover(on ? item.key : null)}>
                <svg width={16} height={6} aria-hidden="true">
                  <line x1={1} x2={15} y1={3} y2={3} stroke={item.color} strokeWidth={item.dash ? 2.25 : 2} strokeDasharray={item.dash}
                    strokeLinecap={item.dash ? "butt" : "round"} />
                </svg>
                <span>{item.value === null ? "–" : format(item.value)}</span>
              </button></td>;
            })}
            <td className="speed-matrix-calls">{compact(row.calls)}</td>
          </tr>;
        })}
      </tbody>)}
    </table>
    <div className="speed-matrix-actions">{actions}</div>
    <div className="speed-matrix-key">
      <svg width={22} height={6} aria-hidden="true"><line x1={1} x2={21} y1={3} y2={3} stroke="var(--text)" strokeWidth={1.75} strokeLinecap="round" /></svg>
      {" standard · "}
      <svg width={22} height={6} aria-hidden="true"><line x1={1} x2={21} y1={3} y2={3} stroke="var(--text)" strokeWidth={2.25} strokeDasharray="5 3" /></svg>
      {" fast · "}{t("colour = model, darker = higher effort", "kolor = model, ciemniej = wyższy effort")}
    </div>
  </div>;
}
