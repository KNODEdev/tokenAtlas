import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { capacityFull, capacityIsLowerBound, capacityPeriodLabel, capacityUnitFormat, deviationColor, signedDeviation, type CapacityUnit } from "../lib/codex-capacity";
import { readCapacityReference, saveCapacityReference, referenceDifference, referencePercent, resolveReference, snapReference, type CapacityReference, type SavedCapacityReference } from "../lib/capacity-reference";
import { useI18n } from "../lib/i18n";
import { Dropdown } from "./ui";
import "./CapacityReference.css";

/**
 * One draggable reference line over a measure's cycle bars, plus an optional dashed second line of the same measure
 * read against it; `maximum` is that measure's bar scale (capacity at 100%).
 */
export function useCapacityReference(rows: CodexComparisonWindow[], measure: CapacityUnit, basis: CapacityBasis, maximum: number, initialPercent: number, scope = "default") {
  const key = `tokenatlas:capacity-reference:v2:${scope}:${basis}:${measure}`;
  const [saved, setSaved] = useState(() => ({ key, value: readCapacityReference(key, initialPercent) }));
  const reference = saved.key === key ? saved.value : readCapacityReference(key, initialPercent);
  useEffect(() => {
    if (saved.key === key) saveCapacityReference(key, saved.value);
  }, [key, saved]);
  const update = (patch: Partial<SavedCapacityReference>) => {
    setSaved(previous => {
      const value = { ...(previous.key === key ? previous.value : readCapacityReference(key, initialPercent)), ...patch };
      return { key, value };
    });
  };
  const setReference = (value: CapacityReference) => update(value);
  const setBadgePosition = (badgePosition: number) => update({ badgePosition });
  // Each candidate is the end of one cycle's bar, so a dragged line snaps onto it.
  const candidates = rows.flatMap(row => {
    const value = capacityFull(row, measure, basis);
    return value === null ? [] : [{ id: row.id, value }];
  });
  const resolved = resolveReference(reference, candidates, maximum);
  const comparison = reference.compare ? resolveReference(reference.compare, candidates, maximum) : null;
  const setComparison = (compare: CapacityReference | null) => update({ compare });
  return { ...resolved, reference, setReference, comparison, setComparison, badgePosition: reference.badgePosition, setBadgePosition, candidates, maximum, rows, measure };
}
export type CapacityReferenceModel = ReturnType<typeof useCapacityReference>;

function useAmount(model: CapacityReferenceModel, pinnedId = model.pinned?.id) {
  const { t, locale } = useI18n();
  const row = model.rows.find(row => row.id === pinnedId);
  const format = capacityUnitFormat(model.measure, locale);
  const prefix = row && capacityIsLowerBound(row, model.measure) ? "≥ " : "≈ ";
  const unit = model.measure === "credits_low" ? ` ${t("credits", "kredytów")}` : "";
  const signed = (value: number, text: (value: number) => string) => (value > 0 ? "+" : value < 0 ? "−" : "") + text(Math.abs(value)) + unit;
  return { row, full: (value: number) => prefix + format.full(value) + unit, per: (value: number) => prefix + format.per(value) + unit,
    difference: (value: number) => signed(value, format.full), differencePer: (value: number) => signed(value, format.per) };
}

const FREE_COMPARISON = "free";

/** Which side of its line each badge takes, so the two badges of one measure never cover each other. */
function badgeLayout(model: CapacityReferenceModel) {
  const second = model.comparison;
  if (!second) return { firstRight: false, secondRight: false, stacked: false };
  const firstRight = model.percent > second.percent && model.percent <= 75;
  const secondRight = second.percent > model.percent && second.percent <= 75;
  return { firstRight, secondRight, stacked: !firstRight && !secondRight };
}

const cycleEndLabel = (row: CodexComparisonWindow) => `${(row.cycle_end ?? row.reset).replace("T", " ").slice(0, 16)} UTC`;

export function CapacityReferenceControl({ model, label, color, describe }: { model: CapacityReferenceModel; label: string; color: string;
  /** Names a cycle in the pin list; the period alone is ambiguous when cycles of several subscriptions are listed. */
  describe?: (row: CodexComparisonWindow) => string }) {
  const { t, locale } = useI18n();
  const { row, full, per, difference, differencePer } = useAmount(model);
  const comparedRow = model.rows.find(item => item.id === model.comparison?.pinned?.id);
  const cycleOptions = [...model.rows].reverse().filter(row => model.candidates.some(candidate => candidate.id === row.id))
    .map(row => ({ value: row.id, label: describe ? describe(row) : capacityPeriodLabel(row, locale) }));
  const gap = model.comparison && model.candidates.length ? referenceDifference(model.value, model.comparison.value) : null;
  const lineName = (pinned: CodexComparisonWindow | undefined) => pinned ? cycleEndLabel(pinned) : t("free line", "swobodna linia");
  return <div className="capacity-reference-control" style={{ "--reference-color": color } as CSSProperties}>
    <strong>{label}</strong>
    <label>{t("Scale", "Skala")} <input type="number" min={1} max={100} step={1} aria-label={`${label} ${t("scale percent", "procent skali")}`} value={Math.round(model.percent * 10) / 10} disabled={!model.candidates.length}
      onChange={event => model.setReference({ percent: referencePercent(Number(event.target.value)), cycleId: null })} />%</label>
    <span className="mono">{model.candidates.length ? <>100%: {full(model.value)} · 1%: {per(model.value / 100)}</> : t("No estimate", "Brak szacunku")}</span>
    <label>{t("Pin to cycle end", "Przypnij do końca cyklu")}
      <Dropdown className="" value={model.pinned?.id ?? ""} disabled={!model.candidates.length} onChange={value => model.setReference({ percent: model.percent, cycleId: value || null })} options={[
        { value: "", label: t("Free line", "Swobodna linia") }, ...cycleOptions,
      ]} />
    </label>
    <label>{t("Compare with", "Porównaj z")}
      <Dropdown className="" value={model.comparison ? model.comparison.pinned?.id ?? FREE_COMPARISON : ""} disabled={!model.candidates.length}
        onChange={value => model.setComparison(!value ? null : value === FREE_COMPARISON
          ? { percent: model.comparison?.percent ?? referencePercent(model.percent + (model.percent <= 90 ? 10 : -10)), cycleId: null }
          : { percent: model.percent, cycleId: value })}
        options={[{ value: "", label: t("Off", "Wyłączone") }, { value: FREE_COMPARISON, label: t("Free line", "Swobodna linia") }, ...cycleOptions]} />
    </label>
    {gap && <span className="mono capacity-reference-difference" style={{ color: deviationColor(gap.relative) }}
      title={`${t("Second line − first line", "Druga linia − pierwsza linia")}: ${lineName(comparedRow)} − ${lineName(row)}`}>
      Δ {difference(gap.value)} · {signedDeviation(gap.relative, locale)} · 1%: {differencePer(gap.value / 100)}</span>}
    {row && <span>{t("End", "Koniec")}: {cycleEndLabel(row)}
      {row.cycle_end_basis === "scheduled" ? ` · ${t("scheduled", "planowany")}` : row.cycle_end_basis === "uncertain" ? ` · ${t("uncertain", "niepewny")}` : ""}</span>}
    {!model.pinned && model.reference.cycleId && <span>{t("Pinned cycle unavailable in this view", "Przypięty cykl niedostępny w tym widoku")}</span>}
  </div>;
}

export function CapacityReferenceLine({ model, label, color, lane = 0, second = false }: { model: CapacityReferenceModel; label: string; color: string; lane?: number;
  /** The dashed comparison line instead of the measure's first line. */
  second?: boolean }) {
  const { t } = useI18n();
  const drag = useRef({ coordinate: 0, percent: 0 });
  const badge = useRef<HTMLSpanElement>(null);
  const { badgePosition, setBadgePosition } = model;
  const line = second ? model.comparison : model;
  const setLine = second ? model.setComparison : model.setReference;
  const { row: pinnedRow, full, per } = useAmount(model, line?.pinned?.id);
  const pinLabel = pinnedRow ? cycleEndLabel(pinnedRow) : "";
  if (!line || !model.candidates.length || model.maximum <= 0) return null;
  const layout = badgeLayout(model);
  const badgeRight = second ? layout.secondRight : layout.firstRight;
  const name = second ? `${label} ${t("comparison line", "linia porównania")}` : `${label} ${t("reference line", "linia odniesienia")}`;
  const positionBadge = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    const badgeSize = badge.current?.offsetHeight ?? 76;
    setBadgePosition(bounds.height > 0 ? Math.max(0, Math.min(bounds.height - badgeSize, event.clientY - bounds.top + 10)) / bounds.height : 0);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    positionBadge(event);
    const pixels = event.currentTarget.parentElement!.getBoundingClientRect().width;
    const percent = drag.current.percent + (event.clientX - drag.current.coordinate) / pixels * 100;
    setLine(snapReference(percent, model.candidates, model.maximum, pixels));
  };
  return <div className={second ? "capacity-reference-line capacity-reference-line-second" : "capacity-reference-line"} role="slider" tabIndex={0}
    title={`${label} · 100%: ${full(line.value)} · 1%: ${per(line.value / 100)}${pinLabel ? ` · ${pinLabel}` : ""}`}
    aria-label={name} aria-orientation="horizontal"
    aria-valuemin={1} aria-valuemax={100} aria-valuenow={Math.round(line.percent * 10) / 10}
    aria-valuetext={`${pinLabel || label} · 100%: ${full(line.value)} · 1%: ${per(line.value / 100)}`}
    style={{ "--reference-color": color, "--reference-lane": lane, "--reference-stack": second && layout.stacked ? 1 : 0, left: `${line.percent}%` } as CSSProperties}
    onClick={event => event.stopPropagation()}
    onPointerDown={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); positionBadge(event); drag.current = { coordinate: event.clientX, percent: line.percent }; }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onKeyDown={event => {
      const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
      if (!direction && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      setLine({ percent: event.key === "Home" ? 1 : event.key === "End" ? 100 : referencePercent(line.percent + direction * (event.shiftKey ? 10 : 1)), cycleId: null });
    }}>
    <span ref={badge} className={badgeRight ? "capacity-reference-badge capacity-reference-badge-right" : "capacity-reference-badge"} style={badgePosition === null ? undefined : { top: `${badgePosition * 100}%` }}>
      <small className="capacity-reference-date">{pinLabel || t("Free line · no pinned period", "Swobodna linia · bez przypiętego okresu")}</small>
      <strong>{label} · 100%: {full(line.value)}</strong>
      {pinnedRow?.cycle_end_basis === "scheduled" && <small>{t("Scheduled end", "Planowany koniec")}</small>}
      {pinnedRow?.cycle_end_basis === "uncertain" && <small>{t("Uncertain end", "Niepewny koniec")}</small>}
    </span>
  </div>;
}

/** The bracket between a measure's two lines, labelled with the second line minus the first. */
export function CapacityReferenceDifference({ model, lane = 0 }: { model: CapacityReferenceModel; lane?: number }) {
  const { locale } = useI18n();
  const { difference } = useAmount(model);
  const second = model.comparison;
  if (!second || !model.candidates.length || model.maximum <= 0) return null;
  const gap = referenceDifference(model.value, second.value);
  const stacked = badgeLayout(model).stacked;
  return <div className={stacked ? "capacity-reference-difference-bracket capacity-reference-difference-stacked" : "capacity-reference-difference-bracket"} aria-hidden="true"
    style={{ "--reference-lane": lane, color: deviationColor(gap.relative),
      left: `${Math.min(model.percent, second.percent)}%`, width: `${Math.abs(second.percent - model.percent)}%`,
      top: model.badgePosition === null ? undefined : `${model.badgePosition * 100}%` } as CSSProperties}>
    <span>{difference(gap.value)} · {signedDeviation(gap.relative, locale)}</span>
  </div>;
}
