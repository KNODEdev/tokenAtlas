import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import type { CapacityBasis } from "../../shared/codex-promotions";
import type { CapacityCycleMetric } from "../../shared/capacity-cycle";
import { analyseCycleSelection, cycleBounds, cycleMetricValue, loadCapacityCycle, parseUtcDateTimeInput, resolutionMinutes, utcDateTimeInput,
  type CycleAnalysisScope, type CycleResolution, type DetailedCapacityCycle, type TimeRange } from "../lib/capacity-cycle";
import { capacityFull, capacityIsLowerBound, capacityPlanLabel, capacityUnitFormat, capacityUsed } from "../lib/codex-capacity";
import { countLabel } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { capacityWithContext, usageWithContext } from "../lib/capacity-context";
import { useContextPreview } from "../lib/context-premium";
import { CapacityCycleBrush, CapacityCycleChart } from "./CapacityCycleChart";
import { CapacityCycleMachines, cycleMachines, machineShares } from "./CapacityCycleMachines";
import { CapacityCycleModels } from "./CapacityCycleModels";
import { Dropdown, KpiStrip, Tabs, type KpiSpec } from "./ui";
import "./CapacityCycleDrawer.css";

function RangeDates({ range, bounds, onChange }: { range: TimeRange; bounds: TimeRange; onChange: (range: TimeRange) => void }) {
  const { t } = useI18n();
  const [invalid, setInvalid] = useState(false);
  return <form className="capacity-cycle-dates" onSubmit={e => {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const next = { from: parseUtcDateTimeInput(String(fields.get("from"))), to: parseUtcDateTimeInput(String(fields.get("to"))) };
    if (!Number.isFinite(next.from) || !Number.isFinite(next.to) || next.from < bounds.from || next.to > bounds.to || next.from >= next.to) { setInvalid(true); return; }
    setInvalid(false); onChange(next);
  }}>
    <label>{t("From (UTC)", "Od (UTC)")}<input name="from" type="datetime-local" step="0.001" required min={utcDateTimeInput(bounds.from)} max={utcDateTimeInput(bounds.to)} defaultValue={utcDateTimeInput(range.from)} /></label>
    <label>{t("To (UTC)", "Do (UTC)")}<input name="to" type="datetime-local" step="0.001" required min={utcDateTimeInput(bounds.from)} max={utcDateTimeInput(bounds.to)} defaultValue={utcDateTimeInput(range.to)} /></label>
    <button type="submit">{t("Apply range", "Ustaw zakres")}</button>
    <button type="button" onClick={() => onChange(bounds)}>{t("Whole cycle", "Cały cykl")}</button>
    {invalid && <p role="alert">{t("Choose an ordered time range within this cycle.", "Wybierz uporządkowany zakres czasu wewnątrz tego cyklu.")}</p>}
  </form>;
}

export function CapacityCycleExplorer({ cycle, creditsAvailable }: { cycle: DetailedCapacityCycle; creditsAvailable: boolean }) {
  const { t, locale } = useI18n();
  const bounds = cycleBounds(cycle);
  const [range, setRange] = useState(bounds);
  const [metric, setMetric] = useState<CapacityCycleMetric>("tokens");
  const [resolution, setResolution] = useState<CycleResolution>("auto");
  const result = analyseCycleSelection(cycle, range, metric);
  const unit = metric === "tokens" ? t("tokens", "tokenów") : metric === "api_standard" ? "USD" : "credits";
  const amount = (value: number | null) => value === null ? "—" : value.toLocaleString(locale, { maximumFractionDigits: metric !== "tokens" && value < 1 ? 4 : 2 }) + " " + unit;
  const date = (time: number) => utcDateTimeInput(time).replace("T", " ");
  const reasons = {
    missing_readings: t("At least two distinct meter readings inside the selection are needed. A scheduled reset is not a measured zero.", "Potrzebne są co najmniej dwa odczyty z różnych chwil wewnątrz zaznaczenia. Planowany reset nie jest zmierzonym zerem."),
    decreased: t("The meter decreases inside this sample. Capacity is unavailable for this selection.", "Licznik spada wewnątrz próbki. Pojemność dla tego zaznaczenia jest niedostępna."),
    plan_changed: t("This cycle contains a plan change; a common allowance is unconfirmed.", "Cykl obejmuje zmianę planu; wspólny limit nie jest potwierdzony."),
    small_sample: t("The meter increased by at most 1 percentage point. Select a larger sample.", "Licznik wzrósł najwyżej o 1 punkt procentowy. Wybierz większą próbkę."),
    no_traffic: t("No recorded traffic between the selected meter readings.", "Brak zapisanego ruchu między wybranymi odczytami licznika."),
    unpriced: t("No configured prices for the matched traffic. Token usage is still available.", "Brak skonfigurowanych cen dla dopasowanego ruchu. Zużycie w tokenach pozostaje dostępne."),
  };
  const minutes = resolutionMinutes(range, resolution);
  return <section className="capacity-cycle-explorer" aria-label={t("Cycle range analysis", "Analiza zakresu cyklu")}>
    <div className="capacity-cycle-controls">
      <label>{t("Measure", "Miara")}<Dropdown className="" value={metric} onChange={value => setMetric(value as CapacityCycleMetric)} options={[
        { value: "tokens", label: t("Tokens", "Tokeny") }, { value: "api_standard", label: t("API equivalent (USD)", "Ekwiwalent API (USD)") },
        ...(creditsAvailable ? [{ value: "credits_low", label: t("Credits · unknown = Standard", "Credits · nieznany = Standard") }, { value: "credits_high", label: t("Credits · unknown = Fast", "Credits · nieznany = Fast") }] : []),
      ]} /></label>
      <label>{t("Bar resolution", "Szerokość słupka")}<Dropdown className="" value={String(resolution)} onChange={value => setResolution(value === "auto" ? "auto" : Number(value) as CycleResolution)} options={[
        { value: "auto", label: "Auto" }, { value: "30", label: "30 min" }, { value: "60", label: "1 h" }, { value: "120", label: "2 h" },
      ]} /></label>
      <span>{t("One bar", "Jeden słupek")}: {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}</span>
    </div>
    <CapacityCycleChart points={cycle.timeline.usage} readings={cycle.timeline.readings} range={range} minutes={minutes} metric={metric} unit={unit} />
    <CapacityCycleBrush points={cycle.timeline.usage} bounds={bounds} range={range} metric={metric} onChange={setRange} />
    <RangeDates key={`${range.from}:${range.to}`} range={range} bounds={bounds} onChange={setRange} />
    <div className="capacity-cycle-selection-label">{date(range.from)} → {date(range.to)} UTC · {((range.to - range.from) / 3600000).toLocaleString(locale, { maximumFractionDigits: 2 })} h</div>
    <dl className="capacity-cycle-results">
      <div><dt>{t("Recorded in selection", "Zapisane w zaznaczeniu")}</dt><dd className="ui-figure">{metric !== "tokens" && result.selected.unpriced_events > 0 && cycleMetricValue(result.selected, metric) !== null ? "≥ " : ""}{amount(cycleMetricValue(result.selected, metric))}</dd></div>
      <div><dt>{t("Meter increase", "Przyrost licznika")}</dt><dd className="ui-figure">{result.matched ? `${result.matched.pp.toLocaleString(locale, { maximumFractionDigits: 2 })} ${t("pp", "p.p.")}` : "—"}</dd></div>
      <div><dt>{t("Per 1% of allowance", "Na 1% limitu")}</dt><dd className="ui-figure">{result.perPoint === null ? "—" : `${result.partial ? "≥" : "≈"} ${amount(result.perPoint)}`}</dd></div>
      <div><dt>{t("Estimated capacity at 100%", "Szacowana pojemność 100%")}</dt><dd className="ui-figure">{result.full === null ? "—" : `${result.partial ? "≥" : "≈"} ${amount(result.full)}`}</dd></div>
    </dl>
    {result.matched && <p className="capacity-cycle-matched">{t("Calculation uses", "Przelicznik używa")}: <strong>{date(result.matched.from)} → {date(result.matched.to)} UTC</strong><br />
      {result.matched.startPercent}% → {result.matched.endPercent}% · {result.matched.readings} {t("readings", "odczytów")} · {t("matched usage", "dopasowane zużycie")}: {result.partial && cycleMetricValue(result.matchedUsage, metric) !== null ? "≥ " : ""}{amount(cycleMetricValue(result.matchedUsage, metric))}.
      {" "}{t("Traffic at the first reading is excluded; traffic at the last reading is included.", "Ruch z chwili pierwszego odczytu jest pomijany; z chwili ostatniego jest uwzględniany.")}</p>}
    {result.reason && <p className="capacity-cycle-notice" role="status">{reasons[result.reason]}</p>}
    {result.matched && result.matched.pp > 1 && result.matched.pp < 20 && <p className="capacity-cycle-notice">{t("Small sample (under 20 pp): rounding can substantially change the estimate.", "Mała próbka (poniżej 20 p.p.): zaokrąglenia mogą istotnie zmienić szacunek.")}</p>}
    {result.matched && result.matched.maxGapMinutes > 120 && <p className="capacity-cycle-notice">{t("Largest gap between readings", "Największa przerwa między odczytami")}: {(result.matched.maxGapMinutes / 60).toLocaleString(locale, { maximumFractionDigits: 1 })} h. {t("There are no intermediate meter measurements in that gap.", "W tej przerwie nie ma pośrednich pomiarów licznika.")}</p>}
    {metric !== "tokens" && result.selected.unpriced_events > 0 && <p className="capacity-cycle-notice">{result.selected.unpriced_events} {t("events have no complete valuation. Amounts cover only the priced portion.", "zdarzeń nie ma pełnej wyceny. Kwoty obejmują tylko wycenioną część.")}</p>}
    <p className="capacity-cycle-note" title={result.conditional ? t("Conditional estimate from the provider's Claude Code product share.", "Warunkowy szacunek z udziału Claude Code podanego przez dostawcę.") : undefined}>{t("Capacity uses the observed account meter and this sample's model and cache mix. API and credits are configured equivalents. Missing traffic, including work in a browser, can lower the estimate. Empty bars mean no recorded events, not confirmed inactivity.", "Pojemność korzysta z obserwowanego licznika konta oraz modeli i cache tej próbki. API i credits są skonfigurowanymi ekwiwalentami. Brakujący ruch, w tym praca w przeglądarce, może zaniżać szacunek. Puste słupki oznaczają brak zapisanych zdarzeń, nie potwierdzony brak pracy.")}</p>
  </section>;
}

type DrawerTab = "overview" | "models" | "machines" | "evidence";

/** The cycle in numbers above the tabs: API usage, meter, capacity, and each computer's share once the cycle is read. */
function cycleSummary(cycle: CodexComparisonWindow, basis: CapacityBasis, detail: DetailedCapacityCycle | null,
  t: (en: string, pl: string) => string, locale: string, contextImpact: boolean): KpiSpec[] {
  const format = capacityUnitFormat("api_standard", locale);
  const usage = cycle.cycle_usage ?? cycle.usage;
  const used = capacityUsed(cycle, "api_standard"), capacity = capacityFull(cycle, "api_standard", basis);
  const partial = capacityIsLowerBound(cycle, "api_standard"), pp = cycle.observed_pp.toLocaleString(locale, { maximumFractionDigits: 1 });
  const items: KpiSpec[] = [
    { label: t("Used in cycle · API", "Zużyto w cyklu · API"), value: used === null ? "—" : `${usage.unpriced_events > 0 ? "≥ " : ""}${format.full(used)}`,
      absent: used === null, note: countLabel(usage.events, ["request", "requests"], ["żądanie", "żądania", "żądań"]) },
    { label: t("Meter", "Licznik"), value: `${cycle.end_percent.toLocaleString(locale)}%`,
      note: `${cycle.start_percent.toLocaleString(locale)} → ${cycle.end_percent.toLocaleString(locale)}% · ${pp} ${t("pp", "p.p.")}` },
    { label: t("Capacity at 100% · API", "Pojemność 100% · API"), value: capacity === null ? "—" : `${partial ? "≥" : "≈"} ${format.full(capacity)}`,
      absent: capacity === null, note: cycle.observed_pp < 20 ? t("small sample", "mała próbka") : undefined },
    { label: t("Per 1% · API", "Na 1% · API"), value: capacity === null ? "—" : `${partial ? "≥" : "≈"} ${format.per(capacity / 100)}`, absent: capacity === null },
  ];
  const machines = detail?.timeline.sources ? cycleMachines(detail.timeline.sources.map(row => contextImpact ? usageWithContext(row, true) : row)) : [];
  // A share in dollars when anything is priced, else in tokens; at most three computers fit beside the figures.
  const metric = machines.some(m => m.usage.events > m.usage.unpriced_events) ? "api_standard" : "tokens";
  const shares = machineShares(machines, metric);
  for (const m of machines.slice(0, 3)) {
    const share = shares.get(m.machine);
    items.push({ label: m.machine ?? t("unknown computer", "nieznany komputer"), title: m.machine ?? undefined,
      value: share == null ? "—" : `${(100 * share).toLocaleString(locale, { maximumFractionDigits: share < .1 ? 1 : 0 })}%`, absent: share == null,
      note: metric === "api_standard" ? t("share of API", "udział w API") : t("share of tokens", "udział w tokenach") });
  }
  return items;
}

export function CapacityCycleDrawer({ cycle, scope, basis = "observed", creditsAvailable, onClose, children, id }: {
  cycle: CodexComparisonWindow; scope?: CycleAnalysisScope; basis?: CapacityBasis; creditsAvailable: boolean; onClose: () => void; children: ReactNode; id: string;
}) {
  const { t, locale } = useI18n();
  const titleId = useId(), tabsId = useId();
  const [tab, setTab] = useState<DrawerTab>("overview");
  const contextPreview = useContextPreview();
  const contextImpact = contextPreview && scope?.provider === "codex";
  const pricedCycle = contextImpact ? capacityWithContext(cycle, true).window : cycle;
  const dialog = useRef<HTMLDialogElement>(null);
  const state = useAsync(() => loadCapacityCycle(scope, cycle.id), [cycle.id, scope?.provider, scope?.options.account, scope?.options.since,
    scope?.options.until, scope?.options.counter, scope?.options.window_minutes, scope?.options.reference_day]);
  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    return () => { node.close(); previous?.focus(); };
  }, []);
  return <dialog id={id} ref={dialog} className="capacity-cycle-drawer" aria-labelledby={titleId} onCancel={onClose}
    onClick={e => {
      if (e.target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
    }}>
    <header className="capacity-cycle-drawer-header"><div><h2 id={titleId}>{t("Cycle details", "Szczegóły cyklu")} · {capacityPlanLabel(cycle)}</h2>
      <p>{cycle.account} · {(cycle.cycle_start ?? cycle.start).slice(0, 10)} → {(cycle.cycle_end ?? cycle.reset).slice(0, 10)} UTC · {t("Models, usage and capacity", "Modele, zużycie i pojemność")}</p></div>
      <button type="button" onClick={onClose} aria-label={t("Close cycle details", "Zamknij szczegóły cyklu")}>✕</button></header>
    <div className="capacity-cycle-drawer-body">
      <KpiStrip items={cycleSummary(pricedCycle, basis, state.data ?? null, t, locale, contextImpact)} />
      <div className="capacity-cycle-tabs">
        <Tabs value={tab} onChange={setTab} tablist={{ label: t("Cycle details sections", "Sekcje szczegółów cyklu"), idBase: tabsId, panelId: `${tabsId}-panel` }} options={[
          { value: "overview", label: t("Overview", "Przegląd") },
          { value: "models", label: t("Models", "Modele"), badge: state.data?.timeline.models?.length },
          { value: "machines", label: t("Computers", "Komputery"), badge: state.data?.timeline.sources ? cycleMachines(state.data.timeline.sources).length : undefined },
          { value: "evidence", label: t("Measurements and sources", "Pomiary i źródła") },
        ]} />
      </div>
      {/* One panel; inactive sections stay mounted and hidden, so a chosen range survives switching tabs. */}
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} className="capacity-cycle-panel">
        {tab !== "evidence" && (state.loading && !state.data ? <p role="status">{t("Loading usage and meter readings…", "Wczytywanie zużycia i odczytów licznika…")}</p>
          : state.error ? <div role="alert"><p>{state.error}</p><button type="button" onClick={state.reload}>{t("Retry", "Ponów")}</button></div> : null)}
        {state.data && !state.error && <>
          <div hidden={tab !== "overview"}><CapacityCycleExplorer key={cycle.id} cycle={state.data} creditsAvailable={creditsAvailable} /></div>
          <div hidden={tab !== "models"}><CapacityCycleModels models={state.data.timeline.models ?? []} creditsAvailable={creditsAvailable} contextImpact={contextImpact} /></div>
          <div hidden={tab !== "machines"}><CapacityCycleMachines sources={state.data.timeline.sources ?? []} creditsAvailable={creditsAvailable} contextImpact={contextImpact} /></div>
        </>}
        <div hidden={tab !== "evidence"} className="capacity-cycle-evidence">{children}</div>
      </div>
    </div>
  </dialog>;
}
