import { useI18n } from "../lib/i18n";
import { PICK_LIMIT, speedSection, type SpeedCompare } from "../lib/speed-matrix";
import { SpeedMatrix, type SpeedMatrixItem } from "./SpeedMatrix";
import type { ComponentProps } from "react";

/** `mode` names a speed mode other than standard or fast (unknown, mixed); fast is the ⚡ mark. */
export interface SpeedChip { key: string; name: string; effort: string; fast: boolean; mode: string | null; label: string; color: string; dash: string | undefined; value: string }

/**
 * The chart's legend as chips (docs/design/mockups/speed-series-picker.html): × takes a series off, hovering picks its
 * line out. In a comparison mode × first turns what the chart shows into an own selection.
 */
export function SpeedChips({ chips, compare, highlight, onRemove, onHover, onAdd }: {
  chips: SpeedChip[]; compare: SpeedCompare; highlight: string | null;
  onRemove: (key: string) => void; onHover: (key: string | null) => void; onAdd: () => void;
}) {
  const { t } = useI18n();
  return <div className="speed-chips" onMouseLeave={() => onHover(null)}>
    {chips.map(chip => <span key={chip.key} className={`speed-chip${highlight === chip.key ? " is-hot" : ""}`} title={chip.label}
      onMouseEnter={() => onHover(chip.key)}>
      <svg width={16} height={6} aria-hidden="true">
        <line x1={1} x2={15} y1={3} y2={3} stroke={chip.color} strokeWidth={chip.dash ? 2.25 : 2} strokeDasharray={chip.dash} strokeLinecap={chip.dash ? "butt" : "round"} />
      </svg>
      {/* A comparison mode names only what differs: the effort within one model, the model within one effort. */}
      {compare !== "model" && <span>{chip.name}</span>}
      {compare !== "effort" && <span className={compare === "custom" ? "speed-chip-effort" : undefined}>{chip.effort}</span>}
      {chip.fast && <span aria-label="fast">⚡</span>}
      {chip.mode && <span className="speed-chip-effort">{chip.mode}</span>}
      <span className="speed-chip-value">{chip.value}</span>
      <button type="button" className="speed-chip-remove" onClick={() => onRemove(chip.key)} aria-label={t("Remove {0} from the chart", `Usuń ${chip.label} z wykresu`, [chip.label])}
        title={compare === "custom" ? t("Remove from the chart", "Usuń z wykresu") : t("Remove and keep the rest as an own selection", "Usuń i zachowaj resztę jako własny wybór")}>×</button>
    </span>)}
    {compare === "custom"
      ? <button type="button" className="speed-chip-add" onClick={onAdd}>{t("+ add series", "+ dodaj serię")}</button>
      : <span className="speed-chips-hint">{t("× or “Series” keeps this set as an own selection", "× albo „Serie” zachowuje ten zestaw jako własny wybór")}</span>}
  </div>;
}

/** The drawer's content: search, the measured-only filter, presets and the matrix of every series in the period. */
export function SpeedSeriesPicker({ items, picked, search, onSearch, onlyMeasured, onOnlyMeasured, presets, ...matrix }: {
  items: SpeedMatrixItem[]; picked: number; search: string; onSearch: (value: string) => void;
  onlyMeasured: boolean; onOnlyMeasured: (value: boolean) => void; presets: { label: string; title: string; apply: () => void }[];
} & Omit<ComponentProps<typeof SpeedMatrix>, "items" | "actions">) {
  const { t } = useI18n();
  const query = search.trim().toLowerCase();
  const matching = items.filter(item => !query || item.name.toLowerCase().includes(query));
  // A matrix row (model in one speed mode) stays when any of its series has a value in the period.
  const row = (item: SpeedMatrixItem) => `${speedSection(item.series)}\n${item.name}`;
  const measuredRows = new Set(matching.filter(item => item.value !== null).map(row));
  const shown = onlyMeasured ? matching.filter(item => measuredRows.has(row(item))) : matching;
  const unmeasured = [...new Set(matching.filter(item => !measuredRows.has(row(item))).map(row))].map(id => id.split("\n")[1]!);
  return <div className="speed-picker">
    <div className="speed-picker-tools">
      <input type="search" className="ui-input" value={search} onChange={event => onSearch(event.target.value)}
        placeholder={t("Search models…", "Szukaj modelu…")} aria-label={t("Search models", "Szukaj modelu")} />
      <label className="speed-split"><input type="checkbox" checked={onlyMeasured} onChange={event => onOnlyMeasured(event.target.checked)} />
        {t("only models measured in the period", "tylko modele z pomiarami w okresie")}</label>
    </div>
    <div className="speed-picker-presets">
      {presets.map(preset => <button key={preset.label} type="button" className="ui-legend-all" title={preset.title} onClick={preset.apply}>{preset.label}</button>)}
      {picked > PICK_LIMIT && <span className="speed-picker-warn" role="status">
        {t("{0} series: the chart gets hard to read", `${picked} serii: wykres robi się nieczytelny`, [picked])}</span>}
    </div>
    {shown.length ? <SpeedMatrix items={shown} actions={null} {...matrix} />
      : <div className="archive-empty">{t("No model matches.", "Żaden model nie pasuje.")}</div>}
    {onlyMeasured && unmeasured.length > 0 && <p className="speed-picker-hidden">
      {t("{0} models without measurements in this period are hidden", `Ukryto modele bez pomiarów w tym okresie: ${unmeasured.length}`, [unmeasured.length])}
      {" "}<button type="button" className="ui-legend-all" title={[...new Set(unmeasured)].join(", ")} onClick={() => onOnlyMeasured(false)}>{t("show", "pokaż")}</button></p>}
  </div>;
}
