import { chartDateFormatter, calendarTimeTicks } from "../lib/chart-dates";
import { ChartExport } from "./ChartExport";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import type { CodexComparisonWindow as Window, TimelineMarker } from "../../shared/codex-accounting";
import type { CapacityBasis } from "../../shared/codex-promotions";
import type { CanonicalMedian } from "../lib/canonical-median";
import { capacityFull, capacityIsLowerBound, capacityMeasurement, capacityPeriodLabel, capacityPlanColor, capacityPlanEstablished, capacityPlanKey, capacityPlanLabel, capacityTierColor, capacityUnitFormat, type CapacityUnit } from "../lib/codex-capacity";
import { translate, useI18n } from "../lib/i18n";
import { configuredPriceModel, isCycleResetMarker, isPolicyMarker, isPromotionMarker, isProviderResetMarker, markerDisplayLabel, markerKindLabel, markerTimestamp, markerUtcLabel, useCapacityEventDrawer } from "./CapacityAnnotations";
import { useWidth } from "./WindowStatusCard";
import { CheckGroup, Disclosure } from "./ui";
import { capacityContextParts } from "../lib/capacity-context";
import { CAPACITY_MARKER_TYPES, capacityMarkerType, readCapacityMarkerTypes, writeCapacityMarkerTypes, type CapacityMarkerType } from "../lib/capacity-marker-visibility";

/** What the chart plots per cycle: capacity at 100%, the value of 1 pp, or 1 pp divided by the plan tier. */
export type CapacityChartScale = "full" | "point" | "tier";

/** One cycle's plotted value; the tier scale needs a recorded tier (×1, ×5, ×20). */
export function capacityChartValue(window: Window, unit: CapacityUnit, basis: CapacityBasis, scale: CapacityChartScale): number | null {
  const full = capacityFull(window, unit, basis);
  if (full === null || scale === "full") return full;
  const tier = scale === "tier" ? window.plan_detail?.multiplier : 1;
  return tier ? full / 100 / tier : null;
}

const TIERS = [1, 5, 20] as const;

// The chosen scale is a per-viewer convenience; without browser storage the chart starts at 100%.
const SCALE_KEY = "tokenAtlas.capacityChartScale";
function storedScale(): CapacityChartScale {
  try {
    const value = typeof localStorage === "undefined" ? null : localStorage.getItem(SCALE_KEY);
    return value === "point" || value === "tier" ? value : "full";
  } catch { return "full"; }
}
function storeScale(scale: CapacityChartScale) {
  try { localStorage.setItem(SCALE_KEY, scale); } catch { /* Private browsing can deny storage. */ }
}

// Chart geometry in CSS pixels; the width follows the card and the right gutter holds the median label.
const X0 = 70, RIGHT_GUTTER = 150, PLOT_HEIGHT = 206, AXIS_HEIGHT = 30;
// Event labels stack in up to four lanes over the plot; the band grows only by the lanes in use.
const MARKER_LANES = 4, LANE_HEIGHT = 13;
const DAY = 86_400_000;
const MARKER_FONT = 10, VALUE_FONT = 11, FULL_FONT = 9, LABEL_GAP = 6;

/** The chart font is monospace, so a label's width follows from its length: 0.6 em per glyph. */
export const textWidth = (text: string, fontSize: number) => text.length * fontSize * 0.6;

export interface MarkerDay { time: number; markers: TimelineMarker[]; label: string; short: string }

type MarkerCategory = "model" | "price" | "event";
function markerCategory(marker: TimelineMarker): MarkerCategory {
  return marker.id.startsWith("model:") ? "model" : marker.id.startsWith("price") || marker.pricing?.length ? "price" : "event";
}

/**
 * A day's label on the chart: "+" for a new model and "$" for a price change, then the first name and "+N" for the rest.
 * A price change of a model first seen the same day is named once, by the model.
 */
export function markerShortLabel(group: TimelineMarker[]): string {
  if (group.every(isProviderResetMarker)) return `↻ ${markerDisplayLabel(group[0]!)}`;
  if (group.every(isPromotionMarker)) return `% ${markerDisplayLabel(group[0]!)}`;
  const name = (marker: TimelineMarker) => markerCategory(marker) === "event" ? markerDisplayLabel(marker)
    : configuredPriceModel(marker) ?? marker.label.split(" · ")[0]!.trim();
  const models = group.filter(marker => markerCategory(marker) === "model").map(name);
  const events = group.filter(marker => markerCategory(marker) === "event").map(name);
  const prices = group.filter(marker => markerCategory(marker) === "price").map(name)
    .filter(price => !models.some(model => price.endsWith(model)));
  const names = [...new Set([...models, ...events, ...prices])].filter(Boolean);
  const glyphs = `${models.length ? "+" : ""}${group.some(marker => markerCategory(marker) === "price") ? "$" : ""}`;
  return [glyphs, names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : ""].filter(Boolean).join(" ");
}

/** Ordinary points share a UTC day; resets and promotion notices remain separate. */
export function markerDays(markers: TimelineMarker[]): MarkerDay[] {
  const days = new Map<string, TimelineMarker[]>();
  for (const marker of markers) {
    const time = markerTimestamp(marker);
    if (!Number.isFinite(time)) continue;
    const day = isProviderResetMarker(marker) || isPromotionMarker(marker) ? marker.id : new Date(time).toISOString().slice(0, 10);
    days.set(day, [...days.get(day) ?? [], marker]);
  }
  return [...days.values()].map(group => {
    // Configured price changes on a shared day collapse into one trailing part; the tooltip names the models.
    const configured = group.some(marker => configuredPriceModel(marker) !== null);
    const parts = group.length === 1 ? [markerDisplayLabel(group[0]!)]
      : [...new Set(group.filter(marker => configuredPriceModel(marker) === null).map(marker => marker.label)), ...configured ? [translate("price change", "zmiana cen")] : []];
    return { time: Math.min(...group.map(markerTimestamp)), markers: group, label: parts.join(" + "), short: markerShortLabel(group) };
  }).sort((a, b) => a.time - b.time);
}

/**
 * Each label takes the lowest free lane (0 sits just above the plot) and is pulled left at the chart edge.
 * A label that fits no lane is left out: its line stays and the hover card names it.
 */
export function markerLaneLayout(days: Array<{ left: number; text: string; level?: number }>, right: number, lanes = MARKER_LANES): Array<{ lane: number; text: string; start: number } | null> {
  const levels = [...new Set(days.map(day => day.level ?? 0))].sort((a, b) => a - b);
  const perLevel = levels.length > 1 ? Math.min(2, lanes) : lanes;
  const ends = Array<number>(perLevel * levels.length).fill(-Infinity);
  return days.map(({ left, text, level = 0 }) => {
    const width = textWidth(text, MARKER_FONT);
    const start = Math.max(0, Math.min(left, right - width));
    const first = levels.indexOf(level) * perLevel;
    const lane = ends.findIndex((end, index) => index >= first && index < first + perLevel && end + LABEL_GAP <= start);
    if (lane < 0) return null;
    ends[lane] = start + width;
    return { lane, text, start };
  });
}

export interface LabelBox { left: number; right: number; top: number; bottom: number }
const overlaps = (a: LabelBox, b: LabelBox) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** In priority order, keeps each label that overlaps neither an obstacle nor a label kept before it. */
export function separatedLabels(boxes: LabelBox[], obstacles: LabelBox[] = []): boolean[] {
  const kept: LabelBox[] = [...obstacles];
  return boxes.map(box => {
    if (kept.some(other => overlaps(box, other))) return false;
    kept.push(box);
    return true;
  });
}

/** What a marker line stands for, in the legend's words, with the glyph its label starts with. */
function markerKind(marker: TimelineMarker): string {
  if (isProviderResetMarker(marker)) return isCycleResetMarker(marker) ? `↻ ${translate("global reset", "globalny reset")}` : translate("reset notice · boundary unobserved", "komunikat o resecie · brak odczytu granicy");
  if (isPromotionMarker(marker)) return `% ${isPolicyMarker(marker) ? translate("plan change", "zmiana planu") : translate("promotion", "promocja")}`;
  const category = markerCategory(marker);
  return category === "model" ? `+ ${translate("new model", "nowy model")}` : category === "price" ? `$ ${translate("price change", "zmiana cen")}` : translate("event", "zdarzenie");
}

/** A compared subscription: its segments take its colour instead of the plan tier's. */
export interface ChartSubject { label: string; color: string }

/** Every mark the chart draws: plans or compared subscriptions (a hatch for a plan not established), sample style, median, events. */
function HistoryLegend({ windows, median, markerDays: days, subjects, context }: { windows: Window[]; median: { value: number | null; plan: string | null }; markerDays: MarkerDay[]; subjects?: ChartSubject[]; context: boolean }) {
  const { t } = useI18n();
  // Colour = tier: every tier is listed with the plans drawn in it; plans without a tier follow by name.
  const tierPlans = (tier: number) => [...new Set(windows.filter(window => window.plan_detail?.multiplier === tier && window.plan_detail.status !== "mixed")
    .map(window => capacityPlanLabel(window).replace(/\s*×\d+$/, "")))];
  const plans = [...new Map(windows.filter(window => window.plan_detail?.multiplier == null || window.plan_detail.status === "mixed")
    .map(window => [capacityPlanLabel(window), window])).values()];
  const events = new Map<string, { color: string; solid: boolean; kinds: Set<string> }>();
  for (const marker of days.flatMap(day => day.markers)) {
    const solid = isCycleResetMarker(marker), key = `${marker.color}:${solid}`;
    const entry = events.get(key) ?? { color: marker.color, solid, kinds: new Set<string>() };
    entry.kinds.add(markerKind(marker)); events.set(key, entry);
  }
  return <div className="capacity-legend is-below">
    {subjects?.map(subject => <span key={subject.label}><i style={{ background: subject.color }} />{subject.label}</span>)}
    {!subjects && TIERS.map(tier => {
      const names = tierPlans(tier);
      return <span key={tier} title={t("Plan tier", "Wariant planu")}><i style={{ background: capacityTierColor(tier) }} />×{tier}{names.length ? ` · ${names.join(", ")}` : ""}</span>;
    })}
    {plans.filter(window => !subjects || !capacityPlanEstablished(window)).map(window => {
      const label = capacityPlanLabel(window);
      if (!capacityPlanEstablished(window)) return <span key={label} title={t("No dated plan period covers these cycles, so their plan and tier are unknown. They stay out of the median.", "Żaden datowany okres planu nie obejmuje tych cykli, więc ich plan i wariant są nieznane. Nie wchodzą do mediany.")}>
        <i className="is-unknown" />{t("plan not established for this period", "plan nieustalony dla tego okresu")}</span>;
      const tierless = window.plan_detail?.multiplier == null;
      return <span key={label} title={tierless ? t("Grey: this plan has no usage tier (×1, ×5, ×20) on record.", "Szary: ten plan nie ma zapisanego wariantu zużycia (×1, ×5, ×20).") : undefined}>
        <i style={{ background: capacityPlanColor(window) }} />{label}</span>;
    })}
    <span><i className="is-tentative" />{t("sample < 20 pp or not from 0%", "próbka < 20 p.p. lub nie od 0%")}</span>
    {context && <span title={t("The part of each segment that comes from long-context requests (Context impact).", "Część odcinka pochodząca z wywołań z długim kontekstem (Wpływ kontekstu).")}>
      <i className="is-context capacity-context-hatch" style={{ "--bar": "var(--muted)" } as CSSProperties} />{t("context impact", "wpływ kontekstu")}</span>}
    {median.value !== null && <span><i className="is-median" />{t("median", "mediana")} {median.plan}</span>}
    {[...events].map(([key, { color, solid, kinds }]) => <span key={key}><i className="is-event" style={{ borderColor: `var(--${color})`, borderLeftStyle: solid ? "solid" : undefined }} />{[...kinds].join(" / ")}</span>)}
  </div>;
}

/**
 * Estimated capacity at 100% of every cycle as one segment from reset to reset, with the canonical
 * median as a labelled line, dated events as vertical lines and a legend of every mark it draws.
 */
export function CapacityHistoryChart({ windows, unit, basis, median, markers, since, until, subjectOf, title, subtitle, eventVisibility, contextImpact = false }: {
  windows: Window[]; unit: CapacityUnit; basis: CapacityBasis; median: CanonicalMedian; markers: TimelineMarker[]; since: string; until: string;
  /** The section heading; the scale choice closes its row on the right. */
  title: ReactNode; subtitle: string;
  /** Cycles of several subscriptions: each segment in its subscription's colour, listed in the legend. */
  subjectOf?: (window: Window) => ChartSubject;
  /** The capacity report shares this selection with its cycle dividers. */
  eventVisibility?: { types: readonly CapacityMarkerType[]; onChange: (types: readonly CapacityMarkerType[]) => void };
  /** The report's Context impact switch: hatches the long-context part on top of each segment. */
  contextImpact?: boolean;
}) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(1200);
  const hatchId = `capacity-hatch-${useId().replace(/:/g, "")}`;
  const [scale, setScaleState] = useState<CapacityChartScale>(storedScale);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const { openEvents, eventDrawer } = useCapacityEventDrawer();
  const [ownMarkerTypes, setOwnMarkerTypes] = useState(readCapacityMarkerTypes);
  const markerTypes = eventVisibility?.types ?? ownMarkerTypes;
  const [eventsOpen, setEventsOpen] = useState(false);
  const eventsId = useId();
  const changeMarkerTypes = (types: readonly CapacityMarkerType[]) => {
    if (eventVisibility) eventVisibility.onChange(types);
    else { setOwnMarkerTypes(types); writeCapacityMarkerTypes(types); }
    setActiveDay(null);
  };
  const setScale = (value: CapacityChartScale) => { setScaleState(value); storeScale(value); };
  const unitFormat = capacityUnitFormat(unit, locale);
  const format = { full: scale === "full" ? unitFormat.full : unitFormat.per };
  const scaleChoice = <div className="ui-choice" role="group" aria-label={t("Chart scale", "Skala wykresu")}>
    {([
      ["full", t("At 100%", "Przy 100%"), t("Estimated capacity of the whole limit", "Szacowana pojemność całego limitu")],
      ["point", t("Per 1%", "Na 1%"), t("Value of one meter point: capacity ÷ 100", "Wartość jednego punktu licznika: pojemność ÷ 100")],
      ["tier", t("Per 1% as ×1", "Na 1% jako ×1"), t("One meter point divided by the plan tier (×5 → ÷5, ×20 → ÷20), so tiers share one scale. Cycles without a recorded tier are left out.", "Jeden punkt licznika podzielony przez wariant planu (×5 → ÷5, ×20 → ÷20), więc warianty mają wspólną skalę. Cykle bez zapisanego wariantu są pominięte.")],
    ] as const).map(([value, label, hint]) => <button key={value} type="button" title={hint} aria-pressed={scale === value} onClick={() => setScale(value)}>{label}</button>)}
  </div>;
  const head = <div className="capacity-section-head capacity-chart-head">
    <h3>{title}</h3><span className="capacity-section-sub">{subtitle}</span><span className="ui-spacer" />
    {markers.length > 0 && <Disclosure open={eventsOpen} onToggle={() => setEventsOpen(!eventsOpen)} controls={eventsId}>
      {t("Events", "Wydarzenia")} · {markerTypes.length}/{CAPACITY_MARKER_TYPES.length}
    </Disclosure>}
    {scaleChoice}
  </div>;
  const eventControls = markers.length > 0 && eventsOpen && <CheckGroup id={eventsId} label={t("Chart events", "Wydarzenia na wykresie")}
    title={eventVisibility
      ? t("Show events on the chart and in the cycle list", "Pokaż wydarzenia na wykresie i liście cykli")
      : t("Show event lines and labels on this chart", "Pokaż linie i opisy wydarzeń na tym wykresie")}
    value={markerTypes} onChange={changeMarkerTypes} options={[
      { value: "reset", label: t("Global resets", "Globalne resety") },
      { value: "promotion", label: t("Promotions", "Promocje") },
      { value: "price", label: t("Price changes", "Zmiany cen") },
      { value: "model", label: t("Models", "Modele") },
      { value: "event", label: t("Other events", "Pozostałe wydarzenia") },
    ] satisfies { value: CapacityMarkerType; label: string }[]} />;
  const segments = windows.flatMap(window => {
    const value = capacityChartValue(window, unit, basis, scale);
    const start = Date.parse(window.cycle_start ?? window.start), end = Date.parse(window.cycle_end ?? window.reset);
    // Only API $ and tokens split by context; the hatched top is the uplift (API) or long requests' tokens.
    const context = contextImpact && value !== null ? capacityContextParts(window, unit, value) : null;
    return value !== null && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? [{ window, value, start, end, context: context && context.extra > 0 ? context : null }] : [];
  });
  // One stripe pattern per segment colour: a pattern's strokes cannot take the colour of the shape that uses it.
  const contextColors = [...new Set(segments.flatMap(segment => segment.context ? [subjectOf?.(segment.window).color ?? capacityPlanColor(segment.window)] : []))];
  const contextPattern = (color: string) => `url(#${hatchId}-context-${contextColors.indexOf(color)})`;
  const withoutTier = scale === "tier" ? windows.filter(window => capacityFull(window, unit, basis) !== null && !window.plan_detail?.multiplier).length : 0;
  const tierNote = withoutTier > 0 && <p className="capacity-note">{t("Cycles without a recorded tier (×1, ×5, ×20) left out: {0}. Declare their plan periods in Settings.", `Pominięto cykle bez zapisanego wariantu (×1, ×5, ×20): ${withoutTier}. Okresy planu ustawisz w Ustawieniach.`, [withoutTier])}</p>;
  if (!segments.length) return <ChartExport title={t("Capacity history", "Historia pojemności")} available={false}><div ref={ref} className="capacity-chart">{head}{eventControls}{tierNote || <p className="capacity-note">{t("No estimate to plot. Prices, traffic or a meter increase above 1 pp may be missing.", "Brak szacunku do pokazania. Może brakować cen, ruchu lub przyrostu licznika powyżej 1 p.p.")}</p>}</div></ChartExport>;
  // The median is taken at 100%; on the tier scale it is divided by its own plan's tier.
  const medianTier = windows.find(window => median.plan !== null && capacityPlanKey(window) === median.plan)?.plan_detail?.multiplier ?? null;
  const medianValue = median.value === null || scale === "full" ? median.value
    : scale === "point" ? median.value / 100 : medianTier ? median.value / 100 / medianTier : null;
  const valueLabel = scale === "full" ? "100%" : scale === "point" ? "1%" : t("1% as ×1", "1% jako ×1");
  const X1 = width - RIGHT_GUTTER;
  const from = Math.min(Date.parse(`${since}T00:00:00Z`), ...segments.map(segment => segment.start));
  const to = Math.max(Date.parse(`${until}T00:00:00Z`) + DAY, ...segments.map(segment => segment.end));
  const x = (time: number) => X0 + (time - from) / (to - from) * (X1 - X0);
  const days = markerDays(markers.filter(marker => markerTypes.includes(capacityMarkerType(marker))
    && markerTimestamp(marker) >= from && markerTimestamp(marker) <= to));
  const markerLabels = markerLaneLayout(days.map(day => ({ left: x(day.time) + 5, text: day.short,
    level: day.markers.some(isCycleResetMarker) ? 0 : day.markers.some(isPromotionMarker) ? 1 : 2 })), width);
  const lanesUsed = Math.max(0, ...markerLabels.map(label => label ? label.lane + 1 : 0));
  const YT = Math.max(44, 22 + lanesUsed * LANE_HEIGHT), Y0 = YT + PLOT_HEIGHT, HEIGHT = Y0 + AXIS_HEIGHT;
  const laneY = (lane: number) => YT - 11 - lane * LANE_HEIGHT;
  // Samples under 20 pp extrapolate far; they may leave the scale instead of flattening the rest.
  const substantial = segments.filter(segment => segment.window.observed_pp >= 20);
  const scaleMaximum = Math.max(0, ...(substantial.length ? substantial : segments).map(segment => segment.value));
  const max = Math.max(scaleMaximum, medianValue ?? 0) * 1.15 || 1;
  const y = (value: number) => Y0 - Math.min(value, max) / max * (Y0 - YT);
  const dayFormat = chartDateFormatter(locale, from, to);
  const ticks = calendarTimeTicks(from, to, X1 - X0, locale).map(tick => tick.time);
  const newest = segments.reduce((latest, segment) => segment.start > latest.start ? segment : latest);

  const markerBoxes = markerLabels.flatMap(label => label === null ? []
    : [{ left: label.start, right: label.start + textWidth(label.text, MARKER_FONT), top: laneY(label.lane) - MARKER_FONT, bottom: laneY(label.lane) + 2 }]);

  // Value labels: the newest cycle first, then other plans, then the rest newest to oldest; a label that would overlap is left out.
  const valueLabels = segments.map(({ window, value, start, end }) => {
    const a = x(start), b = Math.max(x(end), a + 3), top = y(value);
    const otherPlan = median.plan !== null && capacityPlanKey(window) !== median.plan;
    const text = `${value > max ? "↑ " : ""}${otherPlan ? `${capacityPlanEstablished(window) ? capacityPlanLabel(window) : "?"} ` : ""}${format.full(value)}`;
    const half = textWidth(text, VALUE_FONT) / 2;
    // Kept inside the plot so the newest label does not run into the median label in the gutter.
    const center = Math.min(Math.max((a + b) / 2, X0 + half), X1 - half);
    const eligible = b - a > 40 || window === newest.window || otherPlan;
    return { window, text, center, otherPlan, eligible, box: { left: center - half - 2, right: center + half + 2, top: top - 6 - VALUE_FONT, bottom: top - 4 } };
  });
  const ordered = valueLabels.filter(label => label.eligible)
    .sort((a, b) => Number(b.window === newest.window) - Number(a.window === newest.window) || Number(b.otherPlan) - Number(a.otherPlan)
      || Date.parse(b.window.cycle_start ?? b.window.start) - Date.parse(a.window.cycle_start ?? a.window.start));
  const [newestLabel, ...others] = ordered;
  const keptOthers = separatedLabels(others.map(label => label.box), [...markerBoxes, ...(newestLabel ? [newestLabel.box] : [])]);
  const shownValues = new Set([...(newestLabel ? [newestLabel.window] : []), ...others.filter((_, index) => keptOthers[index]).map(label => label.window)]);
  // "100%" under a segment's line ranks below every other label and is left out where it would overlap one.
  const fullMarks = segments.flatMap(({ window, value, start, end }) => {
    const a = x(start), b = Math.max(x(end), a + 3), top = y(value);
    return window.end_percent >= 100 && b - a > 30 ? [{ window, box: { left: b - 2 - textWidth("100%", FULL_FONT), right: b - 2, top: top + 12 - FULL_FONT, bottom: top + 14 } }] : [];
  });
  const keptFull = separatedLabels(fullMarks.map(mark => mark.box), [...markerBoxes, ...valueLabels.filter(label => shownValues.has(label.window)).map(label => label.box)]);
  const shownFull = new Set(fullMarks.filter((_, index) => keptFull[index]).map(mark => mark.window));

  const active = activeDay === null ? null : days[activeDay] ?? null;
  const activeLabel = activeDay === null ? null : markerLabels[activeDay] ?? null;
  // Clipped sideways only, so the event card may run below the chart.
  return <ChartExport title={t("Capacity history", "Historia pojemności")}><div ref={ref} className="capacity-chart" style={{ minWidth: 0, overflowX: "clip" }}>
    {head}
    {eventControls}
    {tierNote}
    <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="group" style={{ display: "block", fontFamily: "var(--font-figure)" }}
      aria-label={t("Estimated capacity at 100% by cycle", "Szacowana pojemność 100% w kolejnych cyklach")}>
      <defs>
        <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={6} stroke="var(--muted)" strokeWidth={1.5} strokeOpacity={0.4} />
        </pattern>
        {contextColors.map((color, index) => <pattern key={color} id={`${hatchId}-context-${index}`} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(-25)">
          <line x1={0} y1={0} x2={0} y2={4} stroke={color} strokeWidth={2} strokeOpacity={0.55} />
        </pattern>)}
      </defs>
      {[0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction}>
        <line x1={X0} x2={X1} y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--line)" strokeDasharray="3 4" />
        <text x={X0 - 8} y={y(max * fraction) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{format.full(max * fraction)}</text>
      </g>)}
      <line x1={X0} x2={X1} y1={Y0} y2={Y0} stroke="var(--line2)" />
      {ticks.map(time => <g key={time}>
        <line x1={x(time)} x2={x(time)} y1={Y0} y2={Y0 + 4} stroke="var(--line2)" />
        <text x={x(time)} y={Y0 + 17} textAnchor="middle" fontSize={10} fill="var(--muted)">{dayFormat.format(time)}</text>
      </g>)}
      {days.map((day, index) => {
        const left = x(day.time), color = `var(--${day.markers[0]!.color})`, label = markerLabels[index]!;
        const top = label ? laneY(label.lane) + 2 : YT - 6, on = activeDay === index;
        const show = () => setActiveDay(index), hide = () => setActiveDay(current => current === index ? null : current);
        return <g key={day.markers[0]!.id} className="capacity-marker" tabIndex={0} role="button" aria-haspopup="dialog" aria-label={day.markers.map(markerDisplayLabel).join(", ")}
          onClick={event => openEvents(day.markers, event.currentTarget)} onKeyDown={event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault(); openEvents(day.markers, event.currentTarget);
          }}
          opacity={activeDay !== null && !on ? 0.3 : 1} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
          {/* A wide transparent stroke makes the thin dashed line easy to hover. */}
          <line x1={left} x2={left} y1={top} y2={Y0} stroke="transparent" strokeWidth={9} />
          <line x1={left} x2={left} y1={top} y2={Y0} stroke={color} strokeWidth={on || day.markers.some(isCycleResetMarker) ? 1.5 : 1} strokeDasharray={on || day.markers.some(isCycleResetMarker) ? undefined : "3 4"} />
          {label && <text x={label.start} y={laneY(label.lane)} fontSize={MARKER_FONT} fontWeight={on ? 600 : 400} fill={color}>{label.text}</text>}
        </g>;
      })}
      {medianValue !== null && <g pointerEvents="none">
        <line x1={X0} x2={X1 + 4} y1={y(medianValue)} y2={y(medianValue)} stroke="var(--text)" strokeWidth={1.5} strokeDasharray="6 4" strokeLinecap="round" />
        <text x={X1 + 10} y={y(medianValue) + 4} fontSize={12} fontWeight={500} fill="var(--text)">{t("median", "mediana")} ≈ {format.full(medianValue)}</text>
        <text x={X1 + 10} y={y(medianValue) + 18} fontSize={10} fill="var(--muted)">{median.plan}{scale === "tier" ? ` ÷ ${medianTier}` : ""} · ≥ 20 {t("pp", "p.p.")}</text>
      </g>}
      {segments.map(({ window, value, start, end, context }, index) => {
        const subject = subjectOf?.(window);
        const a = x(start), b = Math.max(x(end), a + 3), top = y(value), color = subject?.color ?? capacityPlanColor(window);
        const tentative = window.observed_pp < 20 || window.start_percent > 0;
        // A plan not established is hatched, so grey is never its only mark.
        const established = capacityPlanEstablished(window);
        const label = valueLabels[index]!;
        const sample = capacityMeasurement(window);
        return <g key={window.id}>
          <title>{`${subject ? `${subject.label} · ` : ""}${capacityPeriodLabel(window, locale)} UTC · ${capacityPlanLabel(window)} · ${sample.start_percent}→${sample.end_percent}% · ${valueLabel} ${capacityIsLowerBound(window, unit) ? "≥" : "≈"} ${format.full(value)} · ${sample.start} → ${sample.end}${context
            ? `
${t("Context impact", "Wpływ kontekstu")}: ${format.full(context.extra)} (${unit === "tokens" ? `${context.share.toLocaleString(locale, { maximumFractionDigits: 1 })}%` : t("price uplift", "podwyżka ceny")})` : ""}`}</title>
          <rect x={a} y={top} width={b - a} height={Y0 - top} fill={established ? color : `url(#${hatchId})`} fillOpacity={established ? 0.1 : 1} />
          {context && y(context.base) > top && <rect x={a} y={top} width={b - a} height={y(context.base) - top} fill={contextPattern(color)} />}
          <line x1={a} x2={b} y1={top} y2={top} stroke={color} strokeWidth={2.25} strokeDasharray={tentative ? "4 3" : undefined} strokeLinecap={tentative ? "butt" : "round"} />
          {shownFull.has(window) && <text x={b - 2} y={top + 12} textAnchor="end" fontSize={FULL_FONT} fill="var(--muted)">100%</text>}
          {shownValues.has(window) && <text x={label.center} y={top - 6} textAnchor="middle" fontSize={VALUE_FONT} fontWeight={window === newest.window ? 600 : 500} fill={label.otherPlan || subject ? color : "var(--text)"}>
            {label.text}
          </text>}
        </g>;
      })}
    </svg>
    {active && <div className="capacity-event-card" role="tooltip"
      style={{ left: Math.max(0, Math.min(x(active.time) + 8, width - 340)), top: activeLabel ? laneY(activeLabel.lane) + 8 : YT }}>
      <strong className="mono">{dayFormat.format(active.time)}</strong>
      {active.markers.map(marker => <div key={marker.id}>
        <span style={{ color: `var(--${marker.color})` }}>{markerDisplayLabel(marker)}</span>
        <small>{markerKindLabel(marker)} · <span className="mono">{markerUtcLabel(marker)}</span></small>
        {marker.note && configuredPriceModel(marker) === null && <small className="capacity-event-note-preview">{marker.note}</small>}
      </div>)}
      <small>{t("Click for full details", "Kliknij, aby otworzyć pełny opis")}</small>
    </div>}
    <HistoryLegend windows={segments.map(segment => segment.window)} median={{ ...median, value: medianValue }} markerDays={days} context={contextColors.length > 0}
      subjects={subjectOf && [...new Map(segments.map(segment => subjectOf(segment.window)).map(subject => [subject.label, subject])).values()]} />
    {eventDrawer}
  </div></ChartExport>;
}
