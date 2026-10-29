import { useMemo, useState } from "react";
import type { CodexComparisonWindow as Window, TimelineMarker } from "../../shared/codex-accounting";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { assessWindowQuality } from "../../shared/subscription-quality";
import { canonicalMedian, type CanonicalMedian } from "../lib/canonical-median";
import { filterCapacityWindows, capacityEstimate, capacityFull, capacityIsLowerBound, capacityMedianSample, capacityMissingReason, capacityPeriodLabel,
  capacityPlanKey, capacityPlanLabel, capacityReferencePlan, capacityUnitFormat, compareCapacity,
  dimensionComparison, relativeChange, type CapacityUnit } from "../lib/codex-capacity";
import { useI18n } from "../lib/i18n";
import { polishPlural } from "../lib/mixFormat";
import { Dropdown, HelpBlock, HelpDot } from "./ui";
import { usageModelLabel } from "../lib/format";
import { Kpi, KpiRow, Track, unit as unitMark } from "./WindowStatusCard";
import { CapacityHistoryChart } from "./CapacityHistoryChart";
import "./CodexCapacitySummary.css";
import type { DataSettingsTarget } from "../lib/data-settings";
import type { CycleAnalysisScope } from "../lib/capacity-cycle";
import { CapacityTokenTypes } from "./CapacityTokenTypes";
import { CapacityCycleList, capacityUnitLabel, deviationColor, signedDeviation } from "./CapacityCycleList";
import { capacityMarkerType, readCapacityMarkerTypes, writeCapacityMarkerTypes, type CapacityMarkerType } from "../lib/capacity-marker-visibility";
import { CapacityBeforeAfter } from "./CapacityBeforeAfter";

const cycleStart = (w: Window) => Date.parse(w.cycle_start ?? w.start);
const cycleEnd = (w: Window) => Date.parse(w.cycle_end ?? w.reset);
const measuresStorageKey = "tokenatlas.capacity-measures.v1";
/** The capacity result's views; they share the screen's one tab row with By model, Measurements and Methodology. */
export const CAPACITY_REPORT_TABS = ["history", "cycles", "token-types", "compare", "before-after"] as const;
export type CapacityReportTab = typeof CAPACITY_REPORT_TABS[number];
const reportTabKey = "tokenatlas.capacity-report-tab.v1";
export function readCapacityReportTab(): CapacityReportTab {
  try {
    const saved = localStorage.getItem(reportTabKey);
    return CAPACITY_REPORT_TABS.find(tab => tab === saved) ?? "history";
  } catch { return "history"; }
}
export function writeCapacityReportTab(tab: CapacityReportTab) {
  try { localStorage.setItem(reportTabKey, tab); } catch { /* The choice still applies for this visit. */ }
}

export { capacityUnitLabel };

/** Running cycle, latest closed measurement and the canonical median. */
function CapacityTiles({ rows, allRows, unit, basis, median, minObservedPercent }: {
  rows: Window[]; allRows: Window[]; unit: CapacityUnit; basis: CapacityBasis; median: CanonicalMedian; minObservedPercent: number;
}) {
  const { t, locale } = useI18n();
  const unitFormat = capacityUnitFormat(unit, locale);
  // Dollars carry "$" and tokens a magnitude suffix; a bare credit count needs its unit named.
  const credits = unit === "credits_low" ? t("credits", "kred.") : null;
  const withUnit = (text: string) => credits ? `${text} ${credits}` : text;
  const format = { full: (value: number) => withUnit(unitFormat.full(value)), per: (value: number) => withUnit(unitFormat.per(value)) };
  const big = (prefix: string, value: number) => <>{prefix} {unitFormat.full(value)}{credits && unitMark(` ${credits}`)}</>;
  const moment = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
  const when = (time: number) => Number.isFinite(time) ? moment.format(time) : "?";
  const n = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const now = Date.now();
  const running = [...allRows].filter(w => cycleEnd(w) > now && cycleStart(w) <= now).sort((a, b) => cycleStart(b) - cycleStart(a))[0];
  const last = [...rows].filter(w => cycleEnd(w) <= now).sort((a, b) => cycleStart(b) - cycleStart(a))[0];
  const deviation = (w: Window, value: number | null) => median.value !== null && capacityPlanKey(w) === median.plan ? relativeChange(value, median.value) : null;

  const runningTile = (() => {
    if (!running) return <Kpi label={t("Current cycle", "Bieżący cykl")} value="—" visual={<Track />} caption={t("no running cycle in this range", "brak trwającego cyklu w tym zakresie")} />;
    const elapsed = (now - cycleStart(running)) / (cycleEnd(running) - cycleStart(running)) * 100;
    const full = capacityFull(running, unit, basis);
    const reset = `${running.cycle_end_basis === "scheduled" ? t("scheduled reset", "reset planowo") : t("reset", "reset")} ${when(cycleEnd(running))}`;
    const estimate = full !== null
      ? `${capacityIsLowerBound(running, unit) ? "≥" : "≈"} ${format.full(full)} ${t("at 100% so far", "przy 100% na razie")}${running.observed_pp < minObservedPercent ? ` · ${t("below minimum · tentative estimate", "poniżej minimum · wstępny szacunek")}` : ""}`
      : capacityMissingReason(running, basis) ?? t("no capacity estimate yet", "brak szacunku pojemności");
    return <Kpi label={`${t("Current cycle", "Bieżący cykl")} · ${t("since", "od")} ${when(cycleStart(running))}`}
      value={<>{n(running.end_percent)}{unitMark("%")}</>}
      visual={<Track fill={running.end_percent} tick={elapsed} title={t("Meter used · mark: elapsed cycle time", "Zużyty licznik · kreska: czas, który minął")} />}
      caption={`${reset} · ${estimate}`} />;
  })();

  const lastTile = (() => {
    const full = last ? capacityFull(last, unit, basis) : null;
    if (!last || full === null) return <Kpi label={t("Last measurement", "Ostatni pomiar")} value="—" visual={<Track />}
      caption={last ? capacityMissingReason(last, basis) ?? t("no estimate", "brak szacunku") : t("no closed cycle in this range", "brak zamkniętego cyklu w tym zakresie")} />;
    const { rounding } = assessWindowQuality(last);
    const matched = full * last.observed_pp / 100;
    const band = rounding.lower_pp > 0 ? { low: matched * 100 / rounding.upper_pp, high: matched * 100 / rounding.lower_pp } : null;
    const scale = Math.max(band?.high ?? full, median.value ?? 0, full) * 1.25;
    const at = (value: number) => `${Math.min(100, value / scale * 100)}%`;
    const dev = deviation(last, full);
    const partial = capacityIsLowerBound(last, unit);
    const ending = last.cycle_end_basis === "scheduled" ? t("scheduled end", "planowy koniec")
      : last.cycle_end_basis === "uncertain" ? t("uncertain end", "niepewny koniec")
        : cycleEnd(last) - cycleStart(last) < (last.window_minutes ?? 10080) * 60_000 - 60_000 ? t("early reset", "reset wcześniej") : t("reset", "reset");
    return <Kpi label={`${t("Last measurement", "Ostatni pomiar")} · ${when(cycleStart(last))} → ${when(cycleEnd(last))}`}
      value={big(partial ? "≥" : "≈", full)}
      visual={<Track height={12} title={band ? t("Band ±1 pp at each boundary: {0} – {1}", `Pasmo ±1 p.p. na każdej granicy: ${unitFormat.full(band.low)} – ${format.full(band.high)}`, [unitFormat.full(band.low), format.full(band.high)]) : undefined}>
        {band && <div className="capacity-band" style={{ left: at(band.low), width: `calc(${at(band.high)} - ${at(band.low)})` }} />}
        {dev !== null && <div className="capacity-median-tick" style={{ left: at(median.value!) }} />}
        <div className="capacity-dot" style={{ left: at(full) }} />
      </Track>}
      caption={<>
        {format.per(full / 100)} {t("per 1%", "na 1%")} · {t("sample", "próbka")} {n(last.start_percent)} → {n(last.end_percent)}% ({ending})
        {dev !== null && <> · <span style={{ color: deviationColor(dev) }}>{signedDeviation(dev, locale)}</span> {t("vs median", "vs mediana")}</>}
        {band && <> · ±1 {t("pp", "p.p.")}: {unitFormat.full(band.low)}–{format.full(band.high)}</>}
      </>} />;
  })();

  const medianTile = (() => {
    if (median.value === null) return <Kpi label={t("Median", "Mediana")} value="—" visual={<Track />}
      caption={median.reason === "no_plan" ? t("the newest cycle's plan is not confirmed", "plan najnowszego cyklu nie jest potwierdzony")
        : t("fewer than 2 cycles of {0} with ≥ 20 pp and medium or high confidence", `mniej niż 2 cykle ${median.plan} z ≥ 20 p.p. i średnią lub wysoką pewnością`, [median.plan])} />;
    const top = median.values.at(-1)! * 1.05;
    return <Kpi label={`${t("Median", "Mediana")} · ${median.plan} · ${median.count} ${t(median.count === 1 ? "cycle" : "cycles", polishPlural(median.count, "cykl", "cykle", "cykli"))} ≥ 20 ${t("pp", "p.p.")}`}
      value={big("≈", median.value)}
      visual={<div className="capacity-strip" title={t("Each dot is one cycle in the median; the line is the median", "Każda kropka to jeden cykl mediany; kreska to mediana")}>
        {median.values.map((value, index) => <span key={index} className="capacity-strip-dot" style={{ left: `${value / top * 100}%` }} title={format.full(value)} />)}
        <span className="capacity-strip-median" style={{ left: `${median.value / top * 100}%` }} />
      </div>}
      caption={`${t("spread", "rozrzut")} ${unitFormat.full(median.values[0]!)} – ${format.full(median.values.at(-1)!)} · ${t("same plan, samples ≥ 20 pp, medium or high confidence", "ten sam plan, próbki ≥ 20 p.p., średnia lub wysoka pewność")}`} />;
  })();

  return <KpiRow columns={3}>{runningTile}{lastTile}{medianTile}</KpiRow>;
}

export function CodexCapacitySummary({ windows, allWindows, baseline, current, onBaseline, onCurrent, mode = "all", basis = "observed", markers = [], minObservedPercent = 0, creditsAvailable = true, unit = "api_standard", range, openDataSettings, analysisScope, contextImpact, tab = "history" }: {
  windows: Window[];
  /** Every cycle of the range before the display filters: the running cycle and the median come from here. */
  allWindows?: Window[];
  baseline?: Window; current?: Window; onBaseline: (id: string) => void; onCurrent: (id: string) => void;
  mode?: "overview" | "methodology" | "all";
  basis?: CapacityBasis; markers?: TimelineMarker[]; minObservedPercent?: number; creditsAvailable?: boolean;
  unit?: CapacityUnit; range?: { since: string; until: string };
  openDataSettings?: (target: DataSettingsTarget) => void;
  analysisScope?: CycleAnalysisScope;
  /** The screen's context-impact preview the windows were priced with; see CapacityCycleList. */
  contextImpact?: boolean;
  /** Overview: the view chosen in the screen's tab row; the others stay mounted and hidden. */
  tab?: CapacityReportTab;
}) {
  const { t, locale } = useI18n();
  const [markerTypes, setMarkerTypes] = useState(readCapacityMarkerTypes);
  const changeMarkerTypes = (types: readonly CapacityMarkerType[]) => {
    setMarkerTypes(types); writeCapacityMarkerTypes(types);
  };
  const visibleMarkers = markers.filter(marker => markerTypes.includes(capacityMarkerType(marker)));
  const activeUnit: CapacityUnit = unit === "credits_low" && !creditsAvailable ? "api_standard" : unit;
  const cycleMoment = useMemo(() => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }), [locale]);
  // One line per period: "27.09 11:00 → 04.10 11:00".
  const moment = (time: number) => Number.isFinite(time) ? cycleMoment.format(time).replace(",", "") : "?";
  const n = (value: number | null, digits = 1) => value === null || !Number.isFinite(value) ? t("No data", "Brak danych")
    : value.toLocaleString(locale, { maximumFractionDigits: digits });
  const allRows = [...windows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const rows = filterCapacityWindows(allRows, minObservedPercent);
  const everyCycle = allWindows ?? allRows;
  const referencePlan = capacityReferencePlan(everyCycle);
  const medianOf = (measure: CapacityUnit, cycles = everyCycle) => canonicalMedian(cycles.map(w => capacityMedianSample(w, measure, basis)), referencePlan);
  const median = medianOf(activeUnit);
  const medians = new Map((["api_standard", "credits_low", "tokens"] as const).map(measure => [measure, measure === activeUnit ? median : medianOf(measure)]));
  const baselineSelection = baseline && rows.some(w => w.id === baseline.id) ? baseline : undefined;
  const currentSelection = current && rows.some(w => w.id === current.id) ? current : undefined;
  const label = (w: Window) => capacityPeriodLabel(w, locale) + " · " + capacityPlanLabel(w) + " · " + n(w.end_percent) + "%";
  const result = baselineSelection && currentSelection ? compareCapacity(baselineSelection, currentSelection, basis) : null;
  const earlier = currentSelection ? rows.filter(w => compareCapacity(w, currentSelection).compatible) : [];
  const later = baselineSelection ? rows.filter(w => compareCapacity(baselineSelection, w).compatible) : [];
  const since = range?.since ?? allRows[0]?.start.slice(0, 10) ?? "";
  const until = range?.until ?? allRows.at(-1)?.end.slice(0, 10) ?? "";
  const last = [...rows].reverse().find(w => cycleEnd(w) <= Date.now());
  const lastRounding = last ? assessWindowQuality(last).rounding : null;
  const units: CapacityUnit[] = creditsAvailable ? ["api_standard", "credits_low", "tokens"] : ["api_standard", "tokens"];

  return <section className="capacity-report" aria-label={t("Subscription capacity comparison", "Porównanie pojemności subskrypcji")}>
    {mode !== "methodology" && <>
      <CapacityTiles rows={rows} allRows={everyCycle} unit={activeUnit} basis={basis} median={median} minObservedPercent={minObservedPercent} />

      {/* Every view stays mounted (hidden when not chosen), so choices made in one survive a switch. */}
      <div className="capacity-tab-panel">
      {since && until && <div className="capacity-history" hidden={tab !== "history"}>
        <CapacityHistoryChart windows={rows} unit={activeUnit} basis={basis} median={median} markers={markers} since={since} until={until}
          eventVisibility={{ types: markerTypes, onChange: changeMarkerTypes }} contextImpact={contextImpact}
          title={`${t("Capacity at 100% in successive cycles", "Pojemność 100% w kolejnych cyklach")} · ${capacityUnitLabel(activeUnit, t)}`}
          subtitle={t("one segment per cycle, from reset to reset · colour = plan", "odcinek = cykl od resetu do resetu · kolor = plan")} />
      </div>}

      <div hidden={tab !== "cycles"}><CapacityCycleList windows={allRows} minObservedPercent={minObservedPercent} basis={basis} creditsAvailable={creditsAvailable} medians={{ reference: median, byMeasure: medians }} contextImpact={contextImpact}
        referenceScope={JSON.stringify(["capacity", allRows[0]?.account, allRows[0]?.plan, allRows[0]?.window_minutes])}
        measuresKey={measuresStorageKey} defaultMeasures={creditsAvailable ? ["api_standard", "credits_low"] : ["api_standard", "tokens"]}
        analysisScope={analysisScope} openDataSettings={openDataSettings} markers={visibleMarkers}
        subtitle={t("newest first · click a row to open the cycle details", "najnowsze na górze · kliknij wiersz, aby otworzyć szczegóły cyklu")}
        empty={allRows.length
          ? t("No cycles meet the minimum observed usage filter. Lower Min used % to include smaller meter samples.", "Żaden cykl nie spełnia minimalnego filtra zużycia. Zmniejsz Minimalne zużycie %, aby uwzględnić mniejsze próbki licznika.")
          : t("No cycle data yet. Expand the date range or synchronize the account's history.", "Brak danych cykli. Poszerz zakres dat lub zsynchronizuj historię konta.")} /></div>

      <div hidden={tab !== "token-types"}><CapacityTokenTypes windows={rows} moment={moment} /></div>

      <div hidden={tab !== "compare"} className="capacity-detail capacity-comparison">
        <div className="capacity-compare-head">
          <Dropdown ariaLabel={t("Earlier cycle", "Wcześniejszy cykl")} value={baselineSelection?.id ?? ""} onChange={value => onBaseline(value)} options={[
            { value: "", label: t("Earlier cycle", "Wcześniejszy cykl"), disabled: true },
            ...rows.map(w => ({ value: w.id, label: label(w), disabled: w.id !== baselineSelection?.id && !earlier.includes(w) })),
          ]} />
          <span aria-hidden="true">→</span>
          <Dropdown ariaLabel={t("Later cycle", "Późniejszy cykl")} value={currentSelection?.id ?? ""} onChange={value => onCurrent(value)} options={[
            { value: "", label: t("Later cycle", "Późniejszy cykl"), disabled: true },
            ...rows.map(w => ({ value: w.id, label: label(w), disabled: w.id !== currentSelection?.id && !later.includes(w) })),
          ]} />
          <HelpDot label={t("About the comparison", "O porównaniu")}>
            <HelpBlock>{t("Choose an earlier and a later cycle on the same account and plan; the cycles must not overlap. The choice does not change the other views.", "Wybierz wcześniejszy i późniejszy cykl tego samego konta i planu; cykle nie mogą się nakładać. Wybór nie zmienia pozostałych widoków.")}</HelpBlock>
            <HelpBlock>{creditsAvailable
              ? t("Dollar and credit changes compare recorded value at each cycle's rates. They do not directly measure a change in the amount of work. Price-change points distinguish API, credit rates and declared included-usage effects; unknown Pro budgets remain unknown. These observations alone do not prove a quota change.", "Zmiany dolarów i kredytów porównują wartość zapisanego ruchu według cen każdego cyklu. Nie mierzą bezpośrednio zmiany ilości pracy. Punkty zmian cen rozdzielają API, stawki kredytowe i zadeklarowany wpływ na zużycie abonamentu; nieznany budżet Pro pozostaje nieznany. Same obserwacje nie dowodzą zmiany limitu.")
              : t("API and token changes compare recorded value at each cycle's rates. They do not directly measure a change in the amount of work. Price-change points distinguish configured API rates and declared included-usage effects. These observations alone do not prove a quota change.", "Zmiany API i tokenów porównują wartość zapisanego ruchu według cen każdego cyklu. Nie mierzą bezpośrednio zmiany ilości pracy. Punkty zmian cen rozdzielają skonfigurowane stawki API i zadeklarowany wpływ na zużycie abonamentu. Same obserwacje nie dowodzą zmiany limitu.")}</HelpBlock>
            <HelpBlock>{t("Model contributions: API USD per 1% of the meter from each model's own traffic in the cycle; a dash means the model was not used or has no price.", "Wkład modeli: USD API na 1% licznika z ruchu danego modelu w cyklu; kreska oznacza, że model nie był używany albo nie ma ceny.")}</HelpBlock>
          </HelpDot>
        </div>
        {baselineSelection && currentSelection && result?.compatible ? <>
          <KpiRow columns={units.length}>{units.map(key => {
            const before = capacityEstimate(baselineSelection, key, basis).full, after = capacityEstimate(currentSelection, key, basis).full;
            const format = capacityUnitFormat(key, locale), change = result.change(key);
            const value = (w: Window, amount: number | null) => amount === null ? "—" : `${capacityIsLowerBound(w, key) ? "≥ " : ""}${format.full(amount)}`;
            const top = Math.max(before ?? 0, after ?? 0) * 1.15;
            const at = (amount: number) => `${top > 0 ? amount / top * 100 : 0}%`;
            const fast = key === "credits_low" ? [baselineSelection, currentSelection].map(w => capacityEstimate(w, "credits_high", basis).full) : null;
            return <Kpi key={key} label={`${capacityUnitLabel(key, t)} · ${t("at 100%", "przy 100%")}`}
              value={<>{value(baselineSelection, before)} <span className="capacity-compare-arrow">→</span> {value(currentSelection, after)}</>}
              visual={<Track height={12}>
                {before !== null && <div className="capacity-compare-before" style={{ left: at(before) }} />}
                {after !== null && <div className="capacity-dot" style={{ left: at(after) }} />}
              </Track>}
              caption={(() => {
                // Calls without a price make a value a lower bound (≥); the change of the priced parts is then approximate.
                const lower = capacityIsLowerBound(baselineSelection, key) || capacityIsLowerBound(currentSelection, key);
                const shown = change ?? (lower ? relativeChange(after, before) : null);
                const coverage = (w: Window) => w.usage.tokens > 0 ? `${n(w.usage.priced_tokens / w.usage.tokens * 100)}%` : "—";
                const title = [
                  ...(lower && change === null ? [`${t("Calls without a price: priced share of tokens", "Wywołania bez ceny: wyceniony udział tokenów")} ${coverage(baselineSelection)} → ${coverage(currentSelection)}. ${t("The change compares the priced parts only.", "Zmiana porównuje tylko wycenione części.")}`] : []),
                  ...(fast ? [`${t("Credits, unknown mode = Fast", "Kredyty, nieznany tryb = Fast")}: ${fast.map(amount => amount === null ? "—" : format.full(amount)).join(" → ")}`] : []),
                ].join("\n") || undefined;
                return <span title={title} style={{ color: shown === null ? undefined : deviationColor(shown) }}>
                  {shown === null ? "—" : `${change === null ? "≈ " : ""}${signedDeviation(shown, locale)}`}
                  {lower && change === null && shown !== null && <span className="capacity-faint"> · {t("priced part", "wyceniona część")}</span>}
                </span>;
              })()} />;
          })}</KpiRow>
          {(() => {
            const models = dimensionComparison(baselineSelection, currentSelection, "models", basis)
              .filter(row => row.before !== null || row.after !== null)
              .sort((a, b) => Math.max(b.before ?? 0, b.after ?? 0) - Math.max(a.before ?? 0, a.after ?? 0));
            if (!models.length) return null;
            const top = Math.max(...models.map(row => Math.max(row.before ?? 0, row.after ?? 0))) * 1.05;
            const at = (value: number) => `${top > 0 ? value / top * 100 : 0}%`;
            return <div className="capacity-section">
              <div className="capacity-section-head">
                <h3>{t("Model contributions", "Wkład modeli")}</h3>
                <span className="capacity-section-sub">USD / 1%</span>
                <span className="ui-spacer" />
                <span className="capacity-legend"><span><i className="capacity-compare-before is-legend" />{t("earlier", "wcześniej")}</span><span><i className="capacity-dot is-legend" />{t("later", "później")}</span></span>
              </div>
              <div className="capacity-dumbbells" role="table" aria-label={t("Model contributions", "Wkład modeli")}>
                {models.map(row => <div key={row.name} className="capacity-dumbbell" role="row">
                  <span role="cell" className="mono">{usageModelLabel(row.name)}</span>
                  <span role="cell" className="capacity-dumbbell-track">
                    {row.before !== null && row.after !== null && <span className="capacity-dumbbell-link"
                      style={{ left: at(Math.min(row.before, row.after)), width: `calc(${at(Math.max(row.before, row.after))} - ${at(Math.min(row.before, row.after))})` }} />}
                    {row.before !== null && <span className="capacity-compare-before" style={{ left: at(row.before) }} />}
                    {row.after !== null && <span className="capacity-dot" style={{ left: at(row.after) }} />}
                  </span>
                  <span role="cell" className="mono capacity-right">{row.before === null ? "—" : n(row.before, 2)} → {row.after === null ? "—" : n(row.after, 2)}</span>
                </div>)}
              </div>
            </div>;
          })()}
        </> : <p className="capacity-note" role="status">{t("Choose two cycles of the same plan", "Wybierz dwa cykle tego samego planu")}</p>}
      </div>

      <div hidden={tab !== "before-after"}><CapacityBeforeAfter windows={allRows} unit={activeUnit} basis={basis} markers={markers} range={range}
        provider={analysisScope?.provider ?? "codex"} account={analysisScope?.options.account ?? allRows[0]?.account ?? ""} active={tab === "before-after"} /></div>
      </div>
    </>}
    {mode !== "overview" && <section className="capacity-section" aria-label={t("How capacity is estimated", "Jak szacujemy pojemność")}>
      <div className="capacity-section-head">
        <h3>{t("How capacity is estimated", "Jak szacujemy pojemność")}</h3>
        <span className="capacity-section-sub">{t("example", "przykład")}</span>
      </div>
      {/* The calculation as five steps carrying the worked example; each step's rule sits in its help dot. */}
      <ol className="capacity-steps">
        <li><span>{t("Cycle", "Cykl")}<HelpDot label={t("Cycle", "Cykl")}>{creditsAvailable ? t("A cycle runs from reset to reset on the selected main 5h or weekly meter. A new reset closes the previous cycle, including early resets. Delayed readings from superseded resets are ignored. Spark has a separate allowance and is excluded.", "Cykl biegnie od resetu do resetu wybranego głównego licznika 5h lub tygodniowego. Nowy reset zamyka poprzedni cykl, także przy wcześniejszym resecie. Opóźnione odczyty zastąpionych resetów są pomijane. Spark ma osobny limit i jest pominięty.") : t("A cycle belongs to the selected provider counter. Its reset and any earlier reset determine its boundaries. Independent model counters are not combined.", "Cykl należy do wybranego licznika dostawcy. Granice wyznaczają jego reset i ewentualny wcześniejszy reset. Niezależne liczniki modeli nie są sumowane.")}</HelpDot></span>
          <b>{t("reset → reset", "reset → reset")}</b></li>
        <li><span>{t("Account traffic", "Ruch konta")}<HelpDot label={t("Account traffic", "Ruch konta")}>{creditsAvailable ? t("Cycle usage sums indexed traffic from all computers assigned to this account at the event time. The date filter selects overlapping cycles; up to seven days on either side are read to include both boundaries. An unknown boundary or missing beginning is marked explicitly.", "Zużycie cyklu sumuje ruch komputerów przypisanych do konta w chwili zdarzenia. Filtr dat wybiera cykle przecinające ten zakres; odczytujemy też do siedmiu dni po obu stronach, aby uwzględnić obie granice. Nieznana granica lub brak początku są oznaczone.") : t("Cycle usage includes attributed traffic across the complete overlapping cycle. Boundary context extends up to 14 days around the selected dates. Model/source totals retain the requested dates. Imprecise timestamps and unassigned accounts cannot establish capacity.", "Zużycie cyklu obejmuje przypisany ruch w całym przecinającym zakres cyklu. Kontekst granic sięga do 14 dni wokół wybranych dat. Sumy modeli i źródeł zachowują żądany zakres dat. Niedokładne daty i nieprzypisane konta nie pozwalają ustalić pojemności.")}</HelpDot></span>
          <b>1 400 USD</b></li>
        <li><span>{t("Meter", "Licznik")}<HelpDot label={t("Meter", "Licznik")}>{t("For the conversion, match traffic from cycle start to the latest meter reading, or the first 100% reading. A reading at 0% is unnecessary when the reset time is known. If only a fragment is available, divide that fragment's usage by its meter increase.", "Do przelicznika dopasowujemy ruch od początku cyklu do ostatniego odczytu albo pierwszego odczytu 100%. Odczyt 0% nie jest potrzebny, gdy znamy czas resetu. Gdy dostępny jest tylko fragment, dzielimy jego zużycie przez wzrost licznika.")}</HelpDot></span>
          <b>+70 {t("pp", "p.p.")}</b></li>
        <li><span>{t("Per 1%", "Na 1%")}<HelpDot label={t("Per 1%", "Na 1%")}>{creditsAvailable
          ? t("API uses Standard prices. Credits preserve known modes and assume Standard for unknown mode; details also show the Fast scenario. ≥ marks incomplete pricing. Pricing coverage does not confirm that every computer's logs are present.", "API stosuje ceny Standard. Credits zachowują znane tryby i przyjmują Standard dla nieznanego trybu; szczegóły pokazują też scenariusz Fast. ≥ oznacza niepełną wycenę. Pokrycie wyceny nie potwierdza obecności logów ze wszystkich komputerów.")
          : t("API uses configured prices for priced traffic; tokens remain observed usage. ≥ marks incomplete pricing. Pricing coverage does not confirm that every computer's logs are present.", "API stosuje skonfigurowane ceny dla wycenionego ruchu, a tokeny pozostają zaobserwowanym użyciem. ≥ oznacza niepełną wycenę. Pokrycie wyceny nie potwierdza obecności logów ze wszystkich komputerów.")}</HelpDot></span>
          <b>20 USD</b></li>
        <li><span>× 100<HelpDot label={t("Capacity at 100%", "Pojemność 100%")}>{creditsAvailable
          ? t("Example: USD 1,400 and 35,000 credits at 70% give USD 20 and 500 credits per 1%. Capacity at 100% is estimated at USD 2,000 and 50,000 credits, with the same model, cache and mode mix.", "Przykład: 1400 USD i 35 000 kredytów przy 70% daje 20 USD i 500 kredytów na 1%. Szacowana pojemność 100% to 2000 USD i 50 000 kredytów przy tej samej strukturze modeli, cache i trybów.")
          : t("Example: USD 1,400 and 70,000 tokens at 70% give USD 20 and 1,000 tokens per 1%. Capacity at 100% is estimated at USD 2,000 and 100,000 tokens, with the same model and cache mix.", "Przykład: 1400 USD i 70 000 tokenów przy 70% daje 20 USD i 1000 tokenów na 1%. Szacowana pojemność 100% to 2000 USD i 100 000 tokenów przy tej samej strukturze modeli i cache.")}</HelpDot></span>
          <b>≈ 2 000 USD</b></li>
      </ol>
    </section>}
    {mode !== "overview" && last && lastRounding && <section className="capacity-section" aria-label={t("Uncertainty of the last measurement", "Niepewność ostatniego pomiaru")}>
      <div className="capacity-section-head">
        <h3>{t("Uncertainty of the last measurement", "Niepewność ostatniego pomiaru")}</h3>
        <span className="capacity-section-sub">±1 {t("pp", "p.p.")} {t("at each boundary", "na każdej granicy")}</span>
        <HelpDot label={t("Estimate uncertainty and meter rounding", "Niepewność szacunku i zaokrąglenia licznika")}>
          <HelpBlock>{t("Historical variation is not a statistical error margin. Values depend on the model mix, cache, recorded traffic and historical prices. Missing logs can lower the estimate. API equivalents are not charges; token capacity is not a fixed token allowance.", "Rozrzut historyczny nie jest statystycznym marginesem błędu. Wyniki zależą od miksu modeli, cache, zapisanego ruchu i historycznych cen. Brakujące logi mogą zaniżać szacunek. Ekwiwalent API nie jest opłatą, a pojemność w tokenach nie jest stałą pulą tokenów.")}</HelpBlock>
          <HelpBlock>{t("The band assumes each boundary reading can differ by 1 percentage point (the measured change by up to 2 pp). This is a scenario, not a confidence interval. Samples of 2 pp or less do not yield an estimate.", "Pasmo zakłada odchylenie każdego odczytu granicznego o 1 punkt procentowy (przyrostu łącznie o 2 p.p.). To scenariusz, nie przedział ufności. Dla próbek do 2 p.p. nie pokazujemy szacunku.")}</HelpBlock>
        </HelpDot>
      </div>
      <div className="capacity-bands">{units.map(item => {
        const value = capacityFull(last, item, basis), itemFormat = capacityUnitFormat(item, locale);
        const matched = value === null ? null : value * last.observed_pp / 100;
        const band = matched === null || lastRounding.lower_pp <= 0 ? null
          : { low: matched * 100 / lastRounding.upper_pp, high: matched * 100 / lastRounding.lower_pp };
        const top = Math.max(band?.high ?? 0, value ?? 0) * 1.25;
        const at = (amount: number) => `${top > 0 ? amount / top * 100 : 0}%`;
        return <div key={item} className="capacity-band-row">
          <span className="capacity-measure-name">{capacityUnitLabel(item, t)}</span>
          <span className="capacity-band-track">
            {band && <span className="capacity-band" style={{ left: at(band.low), width: `calc(${at(band.high)} - ${at(band.low)})` }} />}
            {band && value !== null && <span className="capacity-dot" style={{ left: at(value) }} />}
          </span>
          <span className="mono capacity-right">{band ? `${itemFormat.full(band.low)} – ${itemFormat.full(band.high)}` : t("No estimate", "Brak szacunku")}</span>
        </div>;
      })}</div>
    </section>}
  </section>;
}
