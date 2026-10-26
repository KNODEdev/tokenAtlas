import { ChartExport } from "./ChartExport";
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { CodexComparisonWindow as Window, TimelineMarker } from "../../shared/codex-accounting";
import { configuredPriceModel, isCycleResetMarker, isProviderResetMarker, markerDisplayLabel, markerKindLabel, markerUtcLabel, useCapacityEventDrawer } from "./CapacityAnnotations";
import { markerDays, type MarkerDay } from "./CapacityHistoryChart";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { CyclePromotionNote, PromotionImpactNote, promotionLabel } from "./CodexPromotionHistory";
import type { CanonicalMedian } from "../lib/canonical-median";
import { capacityEstimate, capacityFull, capacityIsLowerBound, capacityLocalLowerBound, capacityMeasurement, capacityMissingReason, capacityPeriodLabel, capacityPlanColor, capacityPlanEstablished, capacityPlanKey,
  capacityPlanLabel, capacityScaleMaximum, capacityUnitFormat, capacityUsed, creditsUnavailable, projectCycleShare, promotionImpact, relativeChange, usageShare, CAPACITY_MEASURE_COLOR,
  deviationColor, signedDeviation, type CapacityUnit } from "../lib/codex-capacity";
import { pct as percent, usd } from "../lib/format";
import { polishPlural } from "../lib/mixFormat";
import { useI18n } from "../lib/i18n";
import { TableRow, Field, HelpBlock, HelpDot, Table, Td, Th } from "./ui";
import { WindowEvidenceDetails } from "./WindowEvidenceDetails";
import type { DataSettingsTarget } from "../lib/data-settings";
import type { CycleAnalysisScope } from "../lib/capacity-cycle";
import { CapacityCycleDrawer } from "./CapacityCycleDrawer";
import { CapacityReferenceControl, CapacityReferenceDifference, CapacityReferenceLine, useCapacityReference } from "./CapacityReference";
import { capacityContextParts, capacityWithContext } from "../lib/capacity-context";
import { TableGridCells, useTableColumns } from "./DataTable";

type Translate = (en: string, pl: string) => string;
const metrics = ["api_standard", "credits_low", "credits_high", "tokens"] as const;
type SummaryMetric = typeof metrics[number];
const cycleStart = (w: Window) => Date.parse(w.cycle_start ?? w.start);
const cycleEnd = (w: Window) => Date.parse(w.cycle_end ?? w.reset);
/** What each cycle row shows, any number at once; the token-type split has its own chart below the list. */
const cycleMeasures: CapacityUnit[] = ["api_standard", "credits_low", "tokens"];
function initialMeasures(storageKey: string, creditsAvailable: boolean, fallback: CapacityUnit[]): CapacityUnit[] {
  const allowed = cycleMeasures.filter(measure => creditsAvailable || measure !== "credits_low");
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const chosen = Array.isArray(stored) ? allowed.filter(measure => stored.includes(measure)) : [];
    if (chosen.length) return chosen;
  } catch { /* No stored choice: use the default. */ }
  return fallback.filter(measure => allowed.includes(measure));
}

export function capacityUnitLabel(unit: CapacityUnit, t: Translate): string {
  return unit === "api_standard" ? "API $" : unit === "credits_low" ? "Credits" : t("Tokens", "Tokeny");
}

export { deviationColor, signedDeviation };

/** UTC day and time of an instant, as the cycle column shows its bounds (`24.10 13:05`). */
const utcDayTime = (iso: string) => {
  const at = new Date(iso), two = (value: number) => String(value).padStart(2, "0");
  return `${two(at.getUTCDate())}.${two(at.getUTCMonth() + 1)} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
};

/** Deviations worth a glance; everything shared by all rows lives in the chips above the list. */
function cycleFlags(w: Window, t: Translate, locale: string, minimum: number): Array<{ text: string; warn: boolean; title?: string }> {
  const n = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const flags: Array<{ text: string; warn: boolean; title?: string }> = [];
  const cycleEvents = (w.cycle_usage ?? w.usage).events;
  if (w.end_percent >= 100) flags.push({ text: `▲ ${t("100% reached", "100% osiągnięte")}`, warn: false });
  if (w.cycle_start === null || w.cycle_end_basis === "uncertain") flags.push({ text: `? ${t("uncertain boundary", "niepewna granica")}`, warn: true });
  if (w.cycle_end_basis === "scheduled") flags.push({ text: t("scheduled end", "planowany koniec"), warn: false });
  if (w.max_gap_hours >= 2) flags.push({ text: `${t("gap in limit readings", "przerwa w odczytach limitu")}: ${n(w.max_gap_hours)} h`, warn: true });
  // Traffic outside the meter sample only matters when it is a noticeable share of the cycle.
  if (w.unpaired_events && cycleEvents > 0 && w.unpaired_events / cycleEvents >= 0.05) flags.push({ text: `${w.unpaired_events.toLocaleString(locale)} ${t("events outside the sample", "zdarz. poza próbką")}`, warn: true });
  if (w.observed_pp < minimum) flags.push({ text: `${t("below minimum", "poniżej minimum")} ${n(w.observed_pp)} < ${n(minimum)} ${t("pp · tentative estimate", "p.p. · wstępny szacunek")}`, warn: true });
  else if (w.observed_pp < 20) flags.push({ text: `${t("small sample", "mała próbka")} ${n(w.observed_pp)} ${t("pp", "p.p.")}`, warn: true });
  if (w.start_percent > 0) flags.push({ text: `${t("from", "od")} ${n(w.start_percent)}%`, warn: false });
  // Paid from the provider's promotional credit, so outside the plan's capacity and this cycle's sums.
  const funded = w.credit_funded;
  if (funded && funded.calls > 0) flags.push({ warn: false,
    text: `${t("from promotional credit", "z kredytu promocyjnego")}: ${funded.api_unpriced ? "≥ " : ""}${funded.api_standard.toLocaleString(locale, { maximumFractionDigits: funded.api_standard < 10 ? 2 : 0 })} USD`,
    title: `${funded.calls.toLocaleString(locale)} ${t(funded.calls === 1 ? "call" : "calls", polishPlural(funded.calls, "wywołanie", "wywołania", "wywołań"))}`
      + ` · ${utcDayTime(funded.first)} → ${utcDayTime(funded.last)} UTC` });
  return flags;
}

type CycleMedians = { reference: CanonicalMedian; byMeasure: Map<CapacityUnit, CanonicalMedian> };

/** The subscription a compared cycle comes from: its colour replaces the measure colour of the bars. */
export interface CycleSubject {
  key: string; label: string; detail?: string; color: string;
  /** Codex bills in credits; other providers show "n/a" for them. */
  creditsAvailable: boolean;
  scope?: CycleAnalysisScope;
}

/**
 * One row per cycle, newest first, with a line per chosen measure and a draggable reference line per measure.
 * With `medians` it is one subscription's list (deviation column, plan colour); with `subjectOf` the rows come from
 * several subscriptions on one shared scale, each bar in its subscription's colour and without a median.
 */
export function CapacityCycleList({ windows, basis, creditsAvailable, medians, subjectOf, referenceScope, measuresKey, defaultMeasures, analysisScope, openDataSettings, empty, subtitle, markers = [], minObservedPercent = 0, contextImpact }: {
  /** Oldest first. */
  windows: Window[];
  minObservedPercent?: number;
  /** The chart's dated events, drawn as divider lines between the cycles they fall in or between. */
  markers?: TimelineMarker[];
  basis: CapacityBasis;
  /** Whether the credit measure can be chosen at all. */
  creditsAvailable: boolean;
  medians?: CycleMedians;
  subjectOf?: (w: Window) => CycleSubject;
  referenceScope: string;
  measuresKey: string;
  defaultMeasures: CapacityUnit[];
  analysisScope?: CycleAnalysisScope;
  openDataSettings?: (target: DataSettingsTarget) => void;
  empty: ReactNode;
  subtitle: string;
  /**
   * The screen's context-impact preview the windows were already priced with: true with the long-context uplift
   * (drawn hatched), false without it; absent leaves each cycle as its provider's setting priced it.
   */
  contextImpact?: boolean;
}) {
  const { t, locale } = useI18n();
  const { openEvents, eventDrawer } = useCapacityEventDrawer();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [chosenMeasures, setChosenMeasures] = useState(() => initialMeasures(measuresKey, creditsAvailable, defaultMeasures));
  const availableMeasures = cycleMeasures.filter(measure => creditsAvailable || measure !== "credits_low");
  const chosen = availableMeasures.filter(measure => chosenMeasures.includes(measure));
  // A stored choice may name only credits, which a later selection without Codex no longer offers.
  const shownMeasures = chosen.length ? chosen : availableMeasures.slice(0, 1);
  const toggleMeasure = (measure: CapacityUnit, checked: boolean) => {
    const next = availableMeasures.filter(item => item === measure ? checked : shownMeasures.includes(item));
    if (!next.length) return;
    setChosenMeasures(next);
    try { localStorage.setItem(measuresKey, JSON.stringify(next)); } catch { /* The choice still applies for this visit. */ }
  };
  const compared = !!subjectOf;
  const projectName = windows.find(w => w.project_usage)?.project_usage!.project ?? null;
  const columns = [
    { id: "cycle", label: t("Cycle · UTC", "Cykl · UTC"), width: "calc(var(--s-10) * 4)" },
    { id: "plan", label: compared ? t("Subscription · plan", "Abonament · plan") : t("Plan", "Plan"), width: compared ? "calc(var(--s-9) * 9)" : "calc(var(--s-5) * 9)" },
    { id: "meter", label: t("Meter", "Licznik"), width: "calc(var(--s-10) * 3)" },
    // With a project filter the cycles stay the account's; this column is the project's part of each.
    ...(projectName ? [{ id: "project", label: `${t("Project", "Projekt")} · ${projectName}`, width: "calc(var(--s-10) * 5)" }] : []),
    { id: "measures", label: t("Usage and capacity", "Zużycie i pojemność"), width: `minmax(calc(var(--s-8) * ${compared ? 25 : 26}), 1fr)` },
    { id: "deviations", label: t("Deviations", "Odstępstwa"), width: "minmax(calc(var(--s-4) * 11), 0.28fr)" },
  ];
  const columnSettings = useTableColumns(compared ? "CapacityCycleList:compared" : "CapacityCycleList:selected", columns);
  const rowTemplate = { "--capacity-row-columns": columnSettings.selected.map(id => columns.find(column => column.id === id)!.width).join(" ") } as CSSProperties;
  const gridCells = { columns, selected: columnSettings.selected };
  // Only cycles whose provider classifies request context carry the split.
  const contextOffered = windows.some(w => w.usage.context_known_tokens !== undefined);
  const showContext = contextImpact !== false;
  // Compared bars take their subscription's colour, so measures are told apart by name and the lines stay neutral.
  const measureColor = (measure: CapacityUnit) => compared ? "var(--text)" : CAPACITY_MEASURE_COLOR[measure];
  const measureLabel = (measure: CapacityUnit) => measure === "api_standard" ? "API $" : measure === "credits_low" ? t("Credits", "Kredyty") : t("Tokens", "Tokeny");
  const cycleMoment = useMemo(() => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }), [locale]);
  // One line per period: "27.09 11:00 → 04.10 11:00".
  const moment = (time: number) => Number.isFinite(time) ? cycleMoment.format(time).replace(",", "") : "?";
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }), [locale]);
  const n = (value: number | null, digits = 1) => value === null || !Number.isFinite(value) ? t("No data", "Brak danych")
    : value.toLocaleString(locale, { maximumFractionDigits: digits });
  const date = (s: string) => dateFormat.format(new Date(s));
  const rows = windows;
  const activeMedians = medians;
  const median = activeMedians?.reference ?? null;
  const priceNote = creditsAvailable
    ? t("Recorded API usage uses Standard prices. API capacity and per-1% values normalize each request by its configured Fast credit multiplier. Credits preserve known modes; unknown mode assumes Standard. ≥ marks incomplete pricing, ≈ an estimate. Pricing coverage does not confirm that every computer's logs are present.", "Zapisane zużycie API stosuje ceny Standard. Pojemność API i przelicznik 1% normalizują każde żądanie według skonfigurowanego mnożnika kredytów Fast. Credits zachowują znane tryby; nieznany tryb przyjmuje Standard. ≥ oznacza niepełną wycenę, ≈ szacunek. Pokrycie wyceny nie potwierdza obecności logów ze wszystkich komputerów.")
    : t("API uses configured prices for priced traffic; tokens remain observed usage. ≥ marks incomplete pricing, ≈ an estimate. Pricing coverage does not confirm that every computer's logs are present.", "API stosuje skonfigurowane ceny dla wycenionego ruchu, a tokeny pozostają zaobserwowanym użyciem. ≥ oznacza niepełną wycenę, ≈ szacunek. Pokrycie wyceny nie potwierdza obecności logów ze wszystkich komputerów.");
  const metricLabel = (key: SummaryMetric, credits: boolean) => key === "api_standard" ? t("API equivalent (USD)", "Ekwiwalent API (USD)")
    : key === "tokens" ? t(credits ? "Million tokens" : "Tokens", credits ? "Miliony tokenów" : "Tokeny")
      : key === "credits_low" ? t("Credits (unknown mode = Standard)", "Credits (nieznany tryb = Standard)")
        : t("Credits (unknown mode = Fast)", "Credits (nieznany tryb = Fast)");
  const scales = new Map(cycleMeasures.map(measure => [measure, Math.max(capacityScaleMaximum(rows, measure, basis) * 100, activeMedians?.byMeasure.get(measure)?.value ?? 0) * 1.1]));
  const barPercent = (measure: CapacityUnit, value: number) => {
    const scale = scales.get(measure) ?? 0;
    return scale > 0 ? Math.min(100, value / scale * 100) : 0;
  };
  // One reference line per measure; hooks run for every measure.
  const references = new Map<CapacityUnit, ReturnType<typeof useCapacityReference>>([
    ["api_standard", useCapacityReference(rows, "api_standard", basis, scales.get("api_standard") ?? 0, 50, referenceScope)],
    ["credits_low", useCapacityReference(rows, "credits_low", basis, scales.get("credits_low") ?? 0, 75, referenceScope)],
    ["tokens", useCapacityReference(rows, "tokens", basis, scales.get("tokens") ?? 0, 60, referenceScope)],
  ]);
  // Newest first: each event day sits above the newest cycle that started on or before it; older days close the list.
  const newestFirst = [...rows].reverse();
  const eventsAbove = new Map<string, MarkerDay[]>();
  const eventsBelow = new Map<string, MarkerDay[]>();
  const eventsAfter: MarkerDay[] = [];
  for (const day of markerDays(markers).reverse()) {
    if (day.markers.some(isProviderResetMarker)) {
      const boundary = day.markers[0]?.reset_boundary;
      if (boundary && newestFirst.some(window => window.id === boundary.cycle_id)) {
        eventsBelow.set(boundary.cycle_id, [...eventsBelow.get(boundary.cycle_id) ?? [], day]);
        continue;
      }
    }
    const cycle = newestFirst.find(w => cycleStart(w) <= day.time);
    if (cycle) eventsAbove.set(cycle.id, [...eventsAbove.get(cycle.id) ?? [], day]);
    else eventsAfter.push(day);
  }
  const dayMoment = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  // Weekly cycles touch, so nearly every event falls inside the cycle below it; the date alone places it.
  const eventLine = (day: MarkerDay) => {
    return <div key={day.markers[0]!.id} className="capacity-event" style={{ color: `var(--${day.markers[0]!.color})` }}
      title={day.markers.map(marker => `${markerDisplayLabel(marker)} · ${markerUtcLabel(marker)} · ${markerKindLabel(marker)}${marker.note && configuredPriceModel(marker) === null ? ` · ${marker.note}` : ""}`).join("\n")}>
      <span className="mono">{dayMoment.format(day.time)}</span>
      <button type="button" className="ui-open-row-button" style={{ color: "inherit", font: "inherit" }} aria-haspopup="dialog"
        onClick={event => openEvents(day.markers, event.currentTarget)}>{day.label}</button>
      <i className="capacity-event-rule" aria-hidden="true" style={{ borderTopStyle: day.markers.some(isCycleResetMarker) ? "solid" : undefined }} />
    </div>;
  };
  const projectCell = (w: Window) => {
    const share = projectCycleShare(w);
    if (!share) return <span className="capacity-faint">—</span>;
    const lower = share.partial ? "≥ " : "";
    const title = [`${share.project} · ${capacityUnitFormat("tokens", locale).full(share.tokens)} ${t("tokens", "tokenów")} (${percent(share.tokenShare, 1)})`,
      `API ${lower}${usd(share.api)} (${percent(share.apiShare, 1)})`,
      share.meterPoints === null ? t("No per-1% estimate for this cycle", "Brak szacunku na 1% dla tego cyklu")
        : `≈ ${n(share.meterPoints)} ${t("pp of the meter", "p.p. licznika")} (${n(w.end_percent)}%)`].join("\n");
    return <>
      <span className="mono capacity-meter-value" title={title}><b>{share.meterPoints === null ? "—" : `≈ ${n(share.meterPoints)}`}</b> <span className="capacity-muted capacity-meter-pp">{t("pp", "p.p.")}</span> <span className="capacity-muted">{lower}{usd(share.api)}</span></span>
      <span className="mono capacity-muted capacity-meter-pp" title={title}>{percent(share.tokenShare)} tok · {percent(share.apiShare)} API</span>
    </>;
  };
  // A pinned cycle is named with its subscription when the list mixes several.
  const describe = subjectOf ? (w: Window) => `${subjectOf(w).label} · ${capacityPeriodLabel(w, locale)}` : undefined;

  return <div className="capacity-section">
    {eventDrawer}
    <div className="capacity-section-head">
      <h3>{t("Cycles", "Cykle")}</h3>
      <span className="capacity-section-sub">{subtitle}</span>
      <HelpDot label={t("How to read this list", "Jak czytać tę listę")}>
        <HelpBlock>{t("One row covers one cycle, from reset to reset, across all sessions and computers on this account. For a running cycle, the readings available so far determine the estimate.", "Jeden wiersz obejmuje cykl od resetu do resetu oraz wszystkie sesje i komputery tego konta. W trwającym cyklu szacunek opiera się na dotychczasowych odczytach.")}</HelpBlock>
        {compared
          ? <HelpBlock>{t("Used in cycle = all traffic of the whole cycle. Capacity at 100% = the traffic paired with the meter ÷ its increase in pp × 100; hover a value for its basis. Each bar takes its subscription's colour (shades of the provider's hue) and a measure's bars share one scale across every chosen subscription. Drag a measure's reference line over the bars: it snaps to the end of the nearest cycle's bar, or pin it to a cycle above the list. Dates are UTC.", "Zużyto w cyklu = cały ruch cyklu. Pojemność 100% = ruch dopasowany do licznika ÷ jego przyrost w p.p. × 100; wskaż wartość, aby zobaczyć podstawę. Każdy pasek ma kolor swojego abonamentu (odcień barwy dostawcy), a paski jednej miary mają wspólną skalę dla wszystkich wybranych abonamentów. Przeciągnij linię odniesienia miary nad paskami: dociąga do końca paska najbliższego cyklu; możesz też przypiąć ją do cyklu nad listą. Daty są w UTC.")}</HelpBlock>
          : <HelpBlock>{t("Used in cycle = all traffic of the whole cycle. Capacity at 100% = the traffic paired with the meter ÷ its increase in pp × 100, so it can rest on less traffic than the whole cycle; hover a value for its basis. Each measure has its own colour and its bars share one scale. Drag a measure's reference line over the bars: it snaps to the end of the nearest cycle's bar, or pin it to a cycle above the list. Dates are UTC.", "Zużyto w cyklu = cały ruch cyklu. Pojemność 100% = ruch dopasowany do licznika ÷ jego przyrost w p.p. × 100, więc może opierać się na mniejszym ruchu niż cały cykl; wskaż wartość, aby zobaczyć podstawę. Każda miara ma własny kolor, a jej paski wspólną skalę. Przeciągnij linię odniesienia miary nad paskami: dociąga do końca paska najbliższego cyklu; możesz też przypiąć ją do cyklu nad listą. Daty są w UTC.")}</HelpBlock>}
        {projectName && <HelpBlock>{t("The meter counts the whole account. {0}: its share of the cycle's tokens and API value, and ≈ pp: its API value ÷ the cycle's API per 1% (the meter points it used). Without a per-1% estimate the points stay empty.", `Licznik liczy całe konto. ${projectName}: udział w tokenach i wartości API cyklu oraz ≈ p.p.: jego wartość API ÷ API cyklu na 1% (punkty licznika, które zużył). Bez szacunku na 1% punkty zostają puste.`, [projectName])}</HelpBlock>}
        {!compared && <HelpBlock>{t("The median uses cycles of the same plan with a sample of at least 20 pp and medium or high confidence (comparable or partial evidence). Cycles outside the median's plan, including cycles whose plan is not established, are not compared with it.", "Mediana obejmuje cykle tego samego planu z próbką co najmniej 20 p.p. oraz średnią lub wysoką pewnością (dane porównywalne lub częściowe). Cykli spoza planu mediany, także z nieustalonym planem, nie porównujemy z nią.")}</HelpBlock>}
        <HelpBlock>{priceNote}</HelpBlock>
        {contextOffered && <HelpBlock>{t("Context impact (the switch beside Period, shared by every subscription) on: API values include the price uplift of requests above their model's input threshold (Codex 272K, Claude Haiku 100K); the hatched end of the API bar and the hatched top of a chart segment are that uplift, and for tokens the tokens of those requests (whole requests, including cached input and output). Off: API values at normal-context rates; tokens and credits do not change. It previews the difference only; each provider's own setting in Data and prices decides the values everywhere else. The split uses traffic paired with the meter; missing classification is reported separately.",
          "Wpływ kontekstu (przełącznik obok Okresu, wspólny dla wszystkich abonamentów) włączony: wartości API obejmują podwyżkę za wywołania ponad próg wejścia danego modelu (Codex 272K, Claude Haiku 100K); kreskowany koniec paska API i kreskowany wierzch odcinka wykresu to ta podwyżka, a dla tokenów — tokeny tych wywołań (całe wywołania, razem z cache i wyjściem). Wyłączony: wartości API według zwykłych stawek; tokeny i kredyty się nie zmieniają. To tylko podgląd różnicy; o wartościach w pozostałych miejscach decyduje ustawienie dostawcy w Dane i ceny. Rozbicie dotyczy ruchu dopasowanego do licznika; brak klasyfikacji pokazujemy osobno.")}</HelpBlock>}
      </HelpDot>
      <span className="ui-spacer" />
      {/* Same unit tabs as the report's Unit choice, several at once; each swatch is its bar colour. The last
          shown measure stays on. Context impact is the report-wide switch above. */}
      <Field label={t("Show", "Pokaż")}>
        <div className="ui-choice" role="group" aria-label={t("Measures shown in the cycles", "Miary pokazane w cyklach")}>
          {availableMeasures.map(measure => {
            const on = shownMeasures.includes(measure);
            return <button key={measure} type="button" className="capacity-measure-choice" aria-pressed={on} onClick={() => toggleMeasure(measure, !on)}>
              {!compared && <i className="capacity-swatch" style={{ background: CAPACITY_MEASURE_COLOR[measure] }} />}{measureLabel(measure)}
            </button>;
          })}
        </div>
      </Field>
    </div>
    <div className="capacity-reference-controls">
      {shownMeasures.map(measure => <CapacityReferenceControl key={measure} model={references.get(measure)!} label={measureLabel(measure)} color={measureColor(measure)} describe={describe} />)}
    </div>
    {columnSettings.drawer}
    <ChartExport title={t("Cycle capacities", "Pojemności cykli")} available={rows.length > 0}><div className={compared ? "capacity-rows capacity-rows-compared" : "capacity-rows"} style={rowTemplate}>
    <div className="capacity-row capacity-row-head"><TableGridCells {...gridCells} trigger={columnSettings.trigger}>
      <span>{t("Cycle · UTC", "Cykl · UTC")}</span><span>{compared ? t("Subscription · plan", "Abonament · plan") : t("Plan", "Plan")}</span><span>{t("Meter", "Licznik")}</span>
      {projectName && <span>{t("Project", "Projekt")} · {projectName}</span>}
      <span className="capacity-measure-line">
        <span />
        <span className="capacity-right">{t("Used in cycle", "Zużyto w cyklu")}</span>
        <span className="capacity-right">{t("Capacity at 100%", "Pojemność 100%")}</span>
        <span className="capacity-right">{t("per 1%", "na 1%")}</span>
        <span>{t("Chart", "Wykres")}</span>
        {/* The median's plan is named once here; rows of other plans show only "—" with the reason on hover. */}
        {!compared && <span className="capacity-right">{t("vs median", "vs mediana")}{median?.plan && <span className="capacity-faint capacity-median-plan">{median.plan}</span>}</span>}
      </span>
      <span>{t("Deviations", "Odstępstwa")}</span>
    </TableGridCells></div>
    {newestFirst.map(w => {
      const subject = subjectOf?.(w);
      const rowCredits = subject?.creditsAvailable ?? creditsAvailable;
      const visibleMetrics: SummaryMetric[] = rowCredits ? [...metrics] : ["api_standard", "tokens"];
      const expanded = expandedId === w.id;
      const detailsId = "capacity-cycle-" + encodeURIComponent(w.id);
      const period = capacityPeriodLabel(w, locale);
      const toggle = () => setExpandedId(expanded ? null : w.id);
      const samePlan = median !== null && median.plan !== null && capacityPlanKey(w) === median.plan;
      const established = capacityPlanEstablished(w);
      const impact = promotionImpact(w);
      const promotion = impact && impact.factor > 1 ? impact : null;
      const coverage = usageShare(w.usage, "priced_tokens");
      const sample = capacityMeasurement(w);
      // A missing estimate has one reason per cycle: name it on the first measure only.
      const firstMeasure = shownMeasures[0];
      const notCompared = !established
        ? t("Plan not established for this period: not compared with the median", "Plan nieustalony dla tego okresu: bez porównania z medianą")
        : t("Outside the median's plan ({0}): not compared", `Poza planem mediany (${median?.plan}): bez porównania`, [median?.plan]);
      const measureLine = (measure: CapacityUnit) => {
        const format = capacityUnitFormat(measure, locale);
        const full = capacityFull(w, measure, basis);
        const used = capacityUsed(w, measure);
        const paired = capacityEstimate(w, measure, basis).total;
        const pricedUnit = measure !== "tokens";
        const partial = pricedUnit && w.usage.unpriced_events > 0;
        const samplePartial = capacityIsLowerBound(w, measure);
        const measureMedian = activeMedians?.byMeasure.get(measure) ?? null;
        const dev = samePlan && measureMedian?.value != null && !samplePartial ? relativeChange(full, measureMedian.value) : null;
        const floor = full === null ? capacityLocalLowerBound(w, measure) : null;
        const missing = full !== null || measure !== firstMeasure ? null
          : w.observed_pp <= 1 ? "—" : capacityMissingReason(w, basis) ?? t("No estimate", "Brak szacunku");
        const noCredits = measure === "credits_low" && (!rowCredits || creditsUnavailable(w.cycle_usage ?? w.usage));
        const barColor = subject?.color ?? CAPACITY_MEASURE_COLOR[measure];
        const rowContext = w.usage.context_known_tokens !== undefined;
        const context = showContext && rowContext && full !== null ? capacityContextParts(w, measure, full) : null;
        // An API value without a drawn uplift is at normal-context rates when its split is complete.
        const contextFree = rowContext && measure === "api_standard" && !context ? capacityWithContext(w, false) : null;
        const contextNote = contextFree && (!showContext || contextFree.window.usage === w.usage)
          ? contextFree.complete ? t("Normal-context rates, without the context price uplift", "Zwykłe stawki, bez podwyżki za kontekst")
            : t("Context price split unavailable: the value keeps its provider's pricing", "Rozbicie ceny kontekstu niedostępne: wartość zostaje według ustawienia dostawcy")
          : !showContext || !rowContext || measure === "credits_low" ? "" : context
          ? [measure === "api_standard" ? `${t("Normal-context rates", "Zwykłe stawki")}: ${format.full(context.base)} + ${t("context price uplift", "podwyżka za kontekst")}: ${format.full(context.extra)}` : "",
            `${t("Tokens from long-context requests", "Tokeny z długich wywołań")}: ${capacityUnitFormat("tokens", locale).full(context.longTokens)} (${n(context.share)}%${context.unknownTokens > 0 ? "; " + t("minimum", "minimum") : ""}) · ${n(context.longEvents, 0)} ${t("calls", "wywołań")}`,
            context.unknownTokens > 0 ? `${t("Context not classified", "Kontekst nieustalony")}: ${capacityUnitFormat("tokens", locale).full(context.unknownTokens)}` : ""].filter(Boolean).join("\n")
          : t("Context breakdown unavailable for this sample", "Rozbicie kontekstu niedostępne dla tej próbki");
        // "Used" covers the whole cycle; the estimate only the traffic paired with the meter sample.
        const pairedPart = used !== null && paired !== null && used > 0 && Math.abs(used - paired) / used > 0.02;
        const basisNote = paired === null ? "" : `${t("Paired with the meter", "Dopasowane do licznika")}: ${samplePartial ? "≥ " : ""}${format.full(paired)} ${t("over", "na")} ${n(sample.observed_pp)} ${t("pp", "p.p.")} (${n(sample.start_percent)} → ${n(sample.end_percent)}%) · ${date(sample.start)} → ${date(sample.end)} UTC`;
        const usedTitle = [pricedUnit && coverage !== null ? `${t("priced", "wyceniono")} ${percent(coverage, 1)} ${t("of tokens", "tokenów")}` : "",
          pairedPart ? `${t("Whole cycle, including traffic outside the meter sample", "Cały cykl, także ruch poza próbką licznika")}. ${basisNote}` : "",
          !showContext ? contextNote : ""].filter(Boolean).join(" · ");
        const estimateTitle = full === null ? undefined : [`${format.per(full / 100)} / 1% × 100`, basisNote, contextNote,
          pairedPart && used !== null ? `${t("Used in the whole cycle", "Zużyto w całym cyklu")}: ${partial ? "≥ " : ""}${format.full(used)}` : ""].filter(Boolean).join("\n");
        // Only Codex bills in credits: another provider's cycle has nothing to show there.
        if (measure === "credits_low" && !rowCredits) return <div key={measure} className="capacity-measure-line">
          <span className="capacity-measure-name">{measureLabel(measure)}</span>
          <span className="capacity-right"><span className="capacity-unavailable" title={t("This provider does not bill subscriptions in credits.", "Ten dostawca nie rozlicza abonamentu w kredytach.")}>{t("n/a", "nie dotyczy")}</span></span>
          <span className="capacity-measure-missing" />
        </div>;
        return <div key={measure} className="capacity-measure-line">
          <span className="capacity-measure-name">{!compared && <i className="capacity-swatch" style={{ background: CAPACITY_MEASURE_COLOR[measure] }} />}{measureLabel(measure)}</span>
          <span className="capacity-right" title={usedTitle || undefined}>
            {used === null ? <span className="capacity-unavailable" title={noCredits
              ? t("Codex billed subscriptions per message until 2 April 2026, so this cycle has no credit value to show.", "Do 2 kwietnia 2026 Codex rozliczał subskrypcje per wiadomość, więc ten cykl nie ma wartości w kredytach.") : undefined}>
              {noCredits ? t("n/a", "nie dotyczy") : t("No data", "Brak danych")}</span>
              : <span className={`mono${pairedPart ? " capacity-used-wider" : ""}`}>{partial ? "≥ " : ""}{format.full(used)}</span>}
          </span>
          {full === null ? <span className="capacity-measure-missing">{missing ?? (floor === null && "—")}
            {floor !== null && <>{missing && " · "}<span className="mono" title={t("Local traffic ÷ meter increase. Other products may have used part of the meter, so the capacity is at least this.", "Ruch lokalny ÷ przyrost licznika. Inne produkty mogły zużyć część licznika, więc pojemność jest co najmniej taka.")}>≥ {format.full(floor)}</span> {t("from local traffic", "z ruchu lokalnego")}</>}</span> : <>
            <b className="mono capacity-right" title={estimateTitle}>{samplePartial ? "≥" : "≈"} {format.full(full)}</b>
            <span className="mono capacity-right capacity-faint" title={estimateTitle}>{samplePartial ? "≥ " : ""}{format.per(full / 100)}</span>
            <span className="capacity-bar" title={`${subject ? subject.label + " · " : ""}${capacityUnitLabel(measure, t)} · ${samplePartial ? "≥" : "≈"} ${format.full(full)}${samePlan && measureMedian?.value != null ? ` · ${t("median", "mediana")} ${format.full(measureMedian.value)}` : ""}${contextNote ? "\n" + contextNote : ""}`}>
              <span className="capacity-bar-fill" style={{ width: `${barPercent(measure, full)}%`, background: barColor }} />
              {context && context.extra > 0 && <span className="capacity-bar-fill capacity-context-hatch" data-context-segment={measure === "tokens" ? "tokens" : "api-uplift"}
                style={{ left: `${barPercent(measure, context.base)}%`, width: `${barPercent(measure, context.extra)}%`, "--bar": barColor } as CSSProperties} />}
            </span>
          </>}
          {!compared && <span className="capacity-right mono" style={{ color: deviationColor(dev) }}
            title={!samePlan ? notCompared : measureMedian?.value == null ? t("No median for this plan", "Brak mediany dla tego planu") : undefined}>
            {signedDeviation(dev, locale)}
          </span>}
        </div>;
      };
      // The whole row opens the cycle detail for pointer users; the date is the keyboard control.
      const pinned = shownMeasures.some(measure => [references.get(measure)!.pinned, references.get(measure)!.comparison?.pinned].some(line => line?.id === w.id));
      const plan = established
        ? <span className="capacity-plan-name" style={{ color: subject ? undefined : capacityPlanColor(w) }}
          title={w.plan_detail?.multiplier == null ? t("Grey: this plan has no usage tier (×1, ×5, ×20) on record.", "Szary: ten plan nie ma zapisanego wariantu zużycia (×1, ×5, ×20).") : undefined}>{capacityPlanLabel(w)}</span>
        : <span className="capacity-plan-unknown" title={t("No dated plan period covers this cycle, so its plan and tier are unknown. It is drawn hatched in the chart and stays out of the median.", "Żaden datowany okres planu nie obejmuje tego cyklu, więc jego plan i wariant są nieznane. Na wykresie jest kreskowany i nie wchodzi do mediany.")}>
          <i aria-hidden="true">?</i>{t("plan not established", "plan nieustalony")}</span>;
      return <Fragment key={w.id}>{eventsAbove.get(w.id)?.map(eventLine)}<article className="capacity-row" data-reference={pinned || undefined} aria-current={expanded || undefined} onClick={event => {
        if ((event.target as Element).closest?.("button, a, dialog, .ui-help")) return;
        toggle();
      }}>
        <TableGridCells {...gridCells}><div className="capacity-cell">
          <button type="button" className="capacity-heading-date mono" aria-label={t("Cycle details", "Szczegóły cyklu") + ": " + (subject ? subject.label + " · " : "") + period} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={detailsId} onClick={toggle}
            title={`${date(w.cycle_start ?? w.start)} → ${date(w.cycle_end ?? w.reset)} UTC`}>
            {moment(cycleStart(w))}<span className="capacity-faint">→ {moment(cycleEnd(w))}</span>
          </button>
        </div>
        <div className="capacity-cell">
          {subject && <span className="capacity-subject" title={subject.detail ? `${subject.label} · ${subject.detail}` : subject.label}>
            <i className="capacity-swatch" style={{ background: subject.color }} /><span>{subject.label}</span></span>}
          {plan}
          {/* The promotion explains the cycle's capacity, so it sits with the plan rather than among the deviations. */}
          {promotion && <span className="ui-tag capacity-plan-promo" title={[promotionLabel(w.promotion), ...(w.promotion?.notes ?? [])].join("\n")}>promo {promotion.factor.toLocaleString(locale)}×</span>}
        </div>
        <div className="capacity-cell">
          <span className="mono capacity-meter-value"><b>{n(w.end_percent)}%</b> <span className="capacity-muted capacity-meter-pp">{n(w.observed_pp)} {t("pp", "p.p.")}</span></span>
          <div className="capacity-meter-bar" title={t("Meter {0} → {1}%", `Licznik ${n(w.start_percent)} → ${n(w.end_percent)}%`, [n(w.start_percent), n(w.end_percent)])}><span style={{ left: `${Math.max(0, w.start_percent)}%`, width: `${Math.max(0, Math.min(100, w.end_percent) - w.start_percent)}%` }} /></div>
        </div>
        {projectName && <div className="capacity-cell">{projectCell(w)}</div>}
        <div className="capacity-cell capacity-measures">
          {shownMeasures.map(measureLine)}
        </div>
        <div className="capacity-cell capacity-flags">{cycleFlags(w, t, locale, minObservedPercent).map(flag => <span key={flag.text} className="capacity-flag" data-warn={flag.warn || undefined} title={flag.title}>{flag.text}</span>)}</div></TableGridCells>
        {expanded && <CapacityCycleDrawer id={detailsId} cycle={w} basis={basis} scope={subject?.scope ?? analysisScope} creditsAvailable={rowCredits} onClose={() => setExpandedId(null)}><div className="capacity-cycle-details">
          <WindowEvidenceDetails window={w} open={openDataSettings} />
          <p>{t("Cycle boundaries", "Granice cyklu")}: {w.cycle_start === null ? t("Unknown start", "Nieustalony początek") : date(w.cycle_start ?? w.start)} → {date(w.cycle_end ?? w.reset)} UTC
            {w.cycle_end_basis === "uncertain" ? " · " + t("next reset time uncertain", "czas kolejnego resetu niepewny") : w.cycle_end_basis === "scheduled" ? " · " + t("scheduled end", "planowany koniec") : ""}.</p>
          <p>{t("Calculation interval", "Przedział obliczenia")}: {date(sample.start)} → {date(sample.end)} UTC · {n(sample.observed_pp)} {t("percentage points", "punktów procentowych")}.</p>
          <CyclePromotionNote promotion={w.promotion} />
          {promotionImpact(w) && promotionImpact(w)!.factor > 1 && <PromotionImpactNote used={w.end_percent} factor={promotionImpact(w)!.factor} />}
          <Table tableId="CapacityCycleList:0"><thead><TableRow header><Th columnId="c0">{t("Measure", "Miara")}</Th><Th columnId="c1">{t("Used in cycle", "Zużyto w cyklu")}</Th><Th columnId="c2">{t("Used for conversion", "Do przelicznika")}</Th><Th columnId="c3">{t("Per 1%", "Na 1%")}</Th><Th columnId="c4">{t("Estimated capacity at 100%", "Szacowana pojemność 100%")}</Th></TableRow></thead><tbody>
            {visibleMetrics.map(key => {
              const estimate = capacityEstimate(w, key, basis), divisor = key === "tokens" ? 1e6 : 1;
              const usage = w.cycle_usage ?? w.usage;
              const total = usage.events > (key === "tokens" ? 0 : usage.unpriced_events) ? usage[key] : null;
              const samplePartial = capacityIsLowerBound(w, key);
              const prefix = samplePartial ? "≥ " : "≈ ";
              return <TableRow key={key}><Td>{metricLabel(key, rowCredits)}</Td><Td mono>{total === null ? n(null) : (key !== "tokens" && usage.unpriced_events > 0 ? "≥ " : "") + n(total / divisor, 2)}</Td><Td mono>{estimate.total === null ? n(null) : (samplePartial ? "≥ " : "") + n(estimate.total / divisor, 2)}</Td><Td mono>{estimate.perPoint === null ? n(null) : prefix + n(estimate.perPoint / divisor, 2)}</Td><Td mono>{estimate.full === null ? n(null) : prefix + n(estimate.full / divisor, 2)}</Td></TableRow>;
            })}
          </tbody></Table>
          {w.models.filter(model => model.unpriced_events > 0).map(model => <p key={model.name} className="capacity-note">{model.name}: {n(model.tokens - model.priced_tokens, 0)} {t("tokens without valuation", "tokenów bez wyceny")} ({n(model.unpriced_events, 0)} {t("requests", "żądań")}).</p>)}
          {!!w.meter_sources?.length && <p className="capacity-note">{t("Percentage readings", "Odczyty procentowe")}: {w.meter_sources.map(source => source === "manual" ? t("manual readings", "pomiary ręczne") : source === "session" ? t("session logs", "logi sesji") : t("periodic measurements", "osobne pomiary")).join(" + ")}. {t("Reset clocks within two minutes are grouped; scheduled boundaries are not confirmed reset events.", "Zegary resetu różniące się do dwóch minut są grupowane; planowana granica nie jest potwierdzeniem wykonanego resetu.")}</p>}
          <p className="capacity-note">{rowCredits
            ? t("Token capacity follows this cycle's model and cache mix. It is not a fixed token allowance. The credit scenarios keep known modes and assign unknown traffic to Standard or Fast.", "Pojemność w tokenach zależy od modeli i udziału cache w tym cyklu. Nie jest stałym limitem tokenów. Scenariusze kredytów zachowują znane tryby, a nieznany ruch przypisują do Standard albo Fast.")
            : t("Token capacity follows this cycle's model and cache mix. It is not a fixed token allowance. API is a configured price equivalent, while tokens remain observed traffic.", "Pojemność w tokenach zależy od modeli i udziału cache w tym cyklu. Nie jest stałym limitem tokenów. API jest ekwiwalentem według skonfigurowanych cen, a tokeny pozostają zaobserwowanym ruchem.")}</p>
          <p className="capacity-note">{t("Sources", "Źródła")}: {w.sources.map(s => s.name.split(/[\\/]/).at(-1)).join(", ") || n(null)}.</p>
          <p className="capacity-note">{t("Models", "Modele")}: {w.models.map(m => m.name).join(", ") || n(null)}.</p>
        </div></CapacityCycleDrawer>}
      </article>{eventsBelow.get(w.id)?.map(eventLine)}</Fragment>;
    })}
    {!!rows.length && eventsAfter.map(eventLine)}
    {!!rows.length && columnSettings.selected.includes("measures") && <div className="capacity-reference-overlay"><div style={{ gridColumn: columnSettings.selected.indexOf("measures") + 1 }}><div>
      {shownMeasures.map((measure, index) => {
        // A measure with a second line takes two badge rows, so the next measure's badges start below both.
        const lane = shownMeasures.slice(0, index).reduce((rows, previous) => rows + (references.get(previous)!.comparison ? 2 : 1), 0);
        return <Fragment key={measure}>
          <CapacityReferenceLine model={references.get(measure)!} label={measureLabel(measure)} color={measureColor(measure)} lane={lane} />
          <CapacityReferenceLine model={references.get(measure)!} label={measureLabel(measure)} color={measureColor(measure)} lane={lane} second />
          <CapacityReferenceDifference model={references.get(measure)!} lane={lane} />
        </Fragment>;
      })}
    </div></div></div>}
    </div></ChartExport>
    {!rows.length && <p>{empty}</p>}
  </div>;
}
