import { useDisclosure } from "../lib/disclosure";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { capacityWithContext, contextPremiumIncluded } from "../lib/capacity-context";
import { useAsync } from "../lib/useAsync";
import { compact, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { subscriptionPlan } from "../lib/subscription-plan";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../shared/time-range-presets";
import { useRecordedRange } from "../lib/recorded-range";
import { TableRow, Card, Table, Th, Td, ErrorState, LoadingCard, Tabs, HelpDot, HelpBlock, Field, Selector, Disclosure, Stepper, GhostButton } from "./ui";
import { CodexWindowTable } from "./CodexWindowTable";
import { CAPACITY_REPORT_TABS, readCapacityReportTab, writeCapacityReportTab, type CapacityReportTab } from "./CodexCapacitySummary";
import { CodexUsageTimeline } from "./CodexUsageTimeline";
import { CodexPromotionTimeline } from "./CodexPromotionHistory";
import { CODEX_PROMOTIONS_VERIFIED_AT } from "../../shared/codex-promotions";
import { capacityUnitLabel } from "./CodexCapacitySummary";
import { codexPricingGaps } from "../lib/codex-pricing-gaps";
import "./SubscriptionStats.css";
import type { CapacityBasis } from "../../shared/codex-promotions";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
import type { CodexCapacityReport } from "../../shared/codex-capacity";
import { capacityMarkers, CapacityMilestones } from "./CapacityAnnotations";
import { CAPACITY_MEASURE_COLOR, capacityPlanLabel, DEFAULT_MIN_OBSERVED_PERCENT, filterCapacityWindows, normalizeCapacityMinObservedPercent, type CapacityUnit } from "../lib/codex-capacity";
import type { DataSettingsTarget } from "../lib/data-settings";
import { CodexDataIssues } from "./CodexDataIssues";
import "./CodexSpeedStats.css";
import { subscriptionAnalysisAdapter } from "../lib/subscription-analysis";
import { ModelUsage } from "./ModelUsage";
import { ModelUnitCost } from "./ModelUnitCost";
import { filterWindowQuality, type WindowQuality } from "../../shared/subscription-quality";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { SubscriptionRevaluation } from "./SubscriptionRevaluation";
import { ManualCapacityMeasurements, type ManualCapacityProps } from "./ManualCapacityMeasurements";
import { ModelCapacity } from "./ModelCapacity";
import { CapacityCycleFilter } from "./CapacityCycleFilter";
import { CapacityFiltersDrawer } from "./CapacityFiltersDrawer";
import { legacyCapacityMinimum, readCapacityPreferences, writeCapacityPreferences, type CapacityFilterPreferences } from "../lib/capacity-filter-preferences";
import { useContextPreview } from "../lib/context-premium";
import type { ApiAccount } from "../lib/api";
import { modelReportAccounts, readAllModelReports } from "../lib/all-model-reports";

const planFilterKey = (window: CodexComparisonWindow): string => JSON.stringify([
  window.plan_detail?.status ?? null, window.plan_detail?.label ?? window.plan, window.plan_detail?.multiplier ?? null,
]);

interface SubscriptionStatsProps {
  dataRevision?: number; section?: "capacity" | "models"; account: string;
  /** Models: the one view a page tab shows; without it both views stay as inner tabs. */
  modelsView?: "usage" | "trends" | "cost"; provider?: string; project?: string;
  accounts?: readonly ApiAccount[];
  openDataSettings?: (target: DataSettingsTarget) => void; initialRange?: NonNullable<DataSettingsTarget["returnRange"]>;
  /** Models: opens Usage events for this subscription, a model and the selected dates. */
  onModelEvents?: (model: string, range: { since: string; until: string }) => void;
  /** Models: opens the Overview's "Models and traffic" tab, where the selected window's models live. */
  onOverview?: () => void;
}

export function SubscriptionStats(props: SubscriptionStatsProps) {
  return <SubscriptionStatsView key={JSON.stringify([subscriptionAnalysisAdapter(props.provider ?? "codex").id, props.account])} {...props} />;
}

function SubscriptionStatsView({ account, project, openDataSettings, initialRange, provider = "codex", section = "capacity", modelsView, dataRevision, onModelEvents, onOverview, accounts = [] }: SubscriptionStatsProps) {
  const { language, locale, t } = useI18n();
  const id = useId();
  const adapter = subscriptionAnalysisAdapter(provider);
  const isCodex = adapter.id === "codex";
  const all = adapter.id === "all" && section === "models";
  const reportAccounts = modelReportAccounts(accounts);
  const accountsKey = JSON.stringify(reportAccounts);
  const business = isCodex && account.endsWith("::business");
  const today = new Date().toISOString().slice(0, 10);
  const [view, setView] = useState<"capacity" | "model-capacity" | "measurements" | "trends" | "usage" | "cost" | "methodology">(section === "models" ? modelsView ?? "usage" : "capacity");
  const [preferences, setPreferences] = useState<CapacityFilterPreferences>(() => {
    const saved = readCapacityPreferences(adapter.id, account, {
      unit: "api_standard", quality: "all", basis: "observed", minimum: legacyCapacityMinimum(),
      days: business ? 360 : 30, custom: { since: new Date(Date.parse(today) - 89 * 86400000).toISOString().slice(0, 10), until: today }, plans: {}, hidden: {},
    });
    return initialRange ? { ...saved, days: 0, custom: { since: initialRange.since, until: initialRange.until },
      counter: initialRange.counter ?? saved.counter, quality: initialRange.quality ?? saved.quality } : saved;
  });
  const [saveError, setSaveError] = useState(false);
  useEffect(() => { setSaveError(!writeCapacityPreferences(adapter.id, account, preferences)); }, [adapter.id, account, preferences]);
  const { unit, counter, quality, basis: capacityBasis, minimum: minObservedPercent, days, custom } = preferences;
  const patchPreferences = (patch: Partial<CapacityFilterPreferences>) => setPreferences(current => ({ ...current, ...patch }));
  const setUnit = (unit: CapacityUnit) => patchPreferences({ unit });
  const setCounter = (counter: string | undefined) => patchPreferences({ counter });
  const setQuality = (quality: "all" | WindowQuality) => patchPreferences({ quality });
  const setCapacityBasis = (basis: CapacityBasis) => patchPreferences({ basis });
  const setDays = (days: number) => patchPreferences({ days });
  const setCustom = (custom: CapacityFilterPreferences["custom"]) => patchPreferences({ custom });
  const [referenceDay, setReferenceDay] = useState(initialRange?.reference_day);
  const [referenceDraft, setReferenceDraft] = useState(initialRange?.reference_day ?? today);
  const [referenceError, setReferenceError] = useState(false);
  const [priceCycles, setPriceCycles] = useState(initialRange?.price_cycles);
  const [minObservedInput, setMinObservedInput] = useState(() => String(preferences.minimum));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dataOpen, setDataOpen] = useDisclosure("capacity:data", false); // Opening it reads the accounting report, so it waits to be asked.
  const views = [
    { id: "capacity", label: t("Capacity", "Pojemność"), detail: t("Usage, the value of 1% and estimated allowance capacity across full reset cycles, in the selected unit.", "Zużycie, wartość 1% i szacowana pojemność abonamentu w kolejnych pełnych cyklach resetu, w wybranej jednostce.") },
    { id: "model-capacity", label: t("By model", "Według modeli"), detail: t("Capacity at 100% from disjoint single-model measurements.", "Pojemność 100% z rozłącznych pomiarów jednego modelu.") },
    { id: "measurements", label: t("Measurements", "Pomiary"), detail: t("The complete measurement table, column selection, CSV export and details of every observation.", "Pełna tabela pomiarów, wybór kolumn, eksport CSV i szczegóły każdej obserwacji.") },
    { id: "trends", label: t("Traffic history", "Historia ruchu"), detail: t("Explore changes over time and compare them with model appearances and your own markers.", "Prześledź zmiany w czasie, pojawienie się modeli i własne znaczniki.") },
    { id: "usage", label: t("Models & sources", "Modele i źródła"), detail: t("See which models, modes and computers contributed to the recorded usage.", "Sprawdź, które modele, tryby i komputery złożyły się na zapisane zużycie.") },
    { id: "cost", label: t("Cost per 1M", "Koszt / 1M"), detail: t("What 1M tokens of each model cost at Standard API prices over the selected dates, against the list price of each token type.", "Ile kosztuje 1M tokenów każdego modelu po cenach Standard API w wybranych datach, na tle ceny cennikowej każdego typu tokenów.") },
    { id: "methodology", label: t("Methodology", "Metodyka"), detail: t("Definitions, assumptions and checks against the measured account limit.", "Definicje, założenia i sprawdzenie względem zmierzonego limitu konta.") },
  ] as const;
  const availableViews = views.filter(item => section === "models" ? modelsView ? item.id === modelsView : item.id === "usage" || item.id === "trends"
    : item.id !== "usage" && item.id !== "trends" && item.id !== "cost" && (item.id !== "model-capacity" || !business && (isCodex || adapter.id === "claude")));
  // One tab row (user, 2026-10-21): Capacity's own views take its place, the remaining tools follow after a rule.
  const [capacityTab, setCapacityTabState] = useState(readCapacityReportTab);
  const capacityTabLabels: Record<CapacityReportTab, string> = {
    history: t("Over time", "W czasie"), cycles: t("Cycles", "Cykle"),
    "token-types": t("Token types", "Typy tokenów"), compare: t("Comparison", "Porównanie"),
  };
  const isCapacityTab = (value: string): value is CapacityReportTab => (CAPACITY_REPORT_TABS as readonly string[]).includes(value);
  const tabValue: string = view === "capacity" ? capacityTab : view;
  const tabOptions = availableViews.flatMap((item, index) => item.id === "capacity"
    ? CAPACITY_REPORT_TABS.map(tab => ({ value: tab as string, label: capacityTabLabels[tab] }))
    : [{ value: item.id as string, label: item.label, groupStart: availableViews[index - 1]?.id === "capacity" }]);
  const chooseTab = (value: string) => {
    if (!isCapacityTab(value)) { setView(value as typeof view); return; }
    setView("capacity"); setCapacityTabState(value); writeCapacityReportTab(value);
  };
  const reasons = useMemo<Record<string, string>>(
    () => ({
      eligible: t("full sample", "pełna próbka"),
      reset_boundary: t("reset boundary", "granica resetu"),
      counter_decreased: t("counter decreased", "spadek licznika"),
      plan_unknown_or_changed: t("plan changed or unknown", "zmiana lub nieznany plan"),
      probe_gap_over_2h: t("probe gap > 2 h", "przerwa odczytów > 2 h"),
      pricing_boundary: t("pricing change", "zmiana cennika"),
      incomplete_pricing_or_speed: t("incomplete rates or mode", "niepełne stawki lub tryb"),
      no_indexed_usage: t("no indexed traffic", "brak ruchu w indeksie"),
      percent_span_too_small: t("change < 5 pp", "zmiana < 5 p.p."),
    }),
    [language, t],
  );
  const roles = useMemo(
    () => ({
      training: t("calibration", "kalibracja"),
      validation: t("validation", "weryfikacja"),
      excluded: t("excluded", "pominięta"),
    }),
    [language, t],
  );
  const [draft, setDraft] = useState(custom);
  const [dateError, setDateError] = useState(false);
  const directCapacity = isCodex && !business && !project && !referenceDay && section === "capacity";
  const whole = useRecordedRange(days === -1, all ? undefined : account, !all, directCapacity ? counter ?? null : undefined);
  const until = days === -1 ? whole.data?.until ?? today : days === 0 ? custom.until : today;
  const since = days === -1 ? whole.data?.since ?? today : days === 0 ? custom.since : new Date(Date.parse(until) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const openSettings = (target: DataSettingsTarget) => openDataSettings?.({ ...target, returnRange: { since, until, ...(counter ? { counter } : {}), ...(quality !== "all" ? { quality } : {}), ...(referenceDay ? { reference_day: referenceDay, ...(priceCycles ? { price_cycles: priceCycles } : {}) } : {}) } });
  const observedDataRevision = useRef(dataRevision);
  const needsAccounting = view === "methodology" || dataOpen;
  const state = useAsync<CodexAccountingReport | CodexCapacityReport | null>(signal => {
    if (!whole.ready) return Promise.resolve(null);
    if (all) return readAllModelReports(accounts, { since, until, account, project: project || undefined,
      ...(referenceDay ? { reference_day: referenceDay } : {}) }, signal);
    if (directCapacity) return adapter.readCapacity({ since, until, account, counter }, signal);
    return adapter.read({ since, until, account, project: project || undefined, counter,
      ...(referenceDay ? { reference_day: referenceDay } : {}) }, signal);
  }, [adapter.id, account, project, since, until, counter, referenceDay, whole.ready, directCapacity, all, accountsKey]);
  // Opening diagnostics must preserve the ready cycle chart while its larger report is read.
  const accounting = useAsync(signal => !directCapacity || !needsAccounting || !whole.ready ? Promise.resolve(null)
    : adapter.read({ since, until, account, counter }, signal),
  [adapter.id, account, since, until, counter, whole.ready, directCapacity, needsAccounting]);
  useEffect(() => {
    if (observedDataRevision.current === dataRevision) return;
    observedDataRevision.current = dataRevision;
    // A publication refreshes this scope; it must not hide the last complete report.
    state.reload();
    if (directCapacity && needsAccounting) accounting.reload();
  }, [dataRevision, state.reload, accounting.reload, directCapacity, needsAccounting]);
  const markerState = useAsync(() => all ? Promise.resolve(null) : adapter.markers(), [adapter.id, account, since, until, all]);
  const data = whole.ready && state.data?.scope.account === account && state.data.scope.since === since && state.data.scope.until === until
    && (state.data.scope.project ?? "") === (project ?? "") && (all || !counter || state.data.provider?.counter === counter)
    && state.data.scope.reference_day === referenceDay ? state.data : null;
  const markers = capacityMarkers(markerState.data, since, until, adapter.id, Date.now(), data?.windows ?? []);
  const fullData = data && !("projection" in data) ? data : accounting.data;
  // The header's "OpenAI context in price" preview adds the long-context uplift over the whole report (tiles, chart,
  // median, list); off, the amounts stay as the provider setting priced them. Undefined when no cycle has long requests.
  const contextPriced = useMemo(() => data?.windows ? contextPremiumIncluded(data.windows) : null, [data?.windows]);
  const contextPreview = useContextPreview();
  const contextImpact = contextPriced === null ? undefined : contextPreview || contextPriced;
  const pricedWindows = useMemo(() => data?.windows && contextImpact !== undefined
    ? data.windows.map(w => capacityWithContext(w, contextImpact).window) : data?.windows ?? null, [data?.windows, contextImpact]);
  const updating = !!data && "updating" in data && data.updating;
  useEffect(() => {
    if (!updating || filtersOpen) return;
    const timer = setInterval(state.reload, 2000);
    return () => clearInterval(timer);
  }, [updating, filtersOpen, state.reload]);
  const planOptions = [...new Map((pricedWindows ?? []).map(window => [planFilterKey(window),
    { value: planFilterKey(window), label: capacityPlanLabel(window) }])).values()]
    .sort((a, b) => a.label.localeCompare(b.label, language, { numeric: true }));
  const planScope = JSON.stringify([adapter.id, account, data?.provider?.counter ?? counter]);
  const counterScope = data?.provider?.counter ?? counter ?? "default";
  const savedPlan = preferences.plans[counterScope];
  const selectedPlan = planOptions.some(option => option.value === savedPlan) ? savedPlan! : "all";
  const planWindows = (pricedWindows ?? []).filter(window => selectedPlan === "all" || planFilterKey(window) === selectedPlan);
  const hiddenCycleIds = new Set(preferences.hidden[counterScope] ?? []);
  const activeFilterCount = [quality !== "all", capacityBasis !== "observed", minObservedPercent !== DEFAULT_MIN_OBSERVED_PERCENT,
    Object.values(preferences.plans).some(plan => plan !== "all"), Object.values(preferences.hidden).some(ids => ids.length > 0)].filter(Boolean).length;
  const resetFilters = () => {
    patchPreferences({ quality: "all", basis: "observed", minimum: DEFAULT_MIN_OBSERVED_PERCENT, plans: {}, hidden: {} });
    setMinObservedInput(String(DEFAULT_MIN_OBSERVED_PERCENT));
  };
  const selectedWindows = planWindows.filter(window => !hiddenCycleIds.has(window.id));
  const qualityWindows = filterWindowQuality(selectedWindows, quality);
  const capacityWindows = data?.windows === null ? null : data ? filterCapacityWindows(qualityWindows, minObservedPercent) : null;
  const hasCycleFilterEmpty = !!planWindows.length && selectedWindows.length === 0;
  const hasCapacityFilterEmpty = !!selectedWindows.length && capacityWindows?.length === 0;
  const hasQualityFilterEmpty = !!selectedWindows.length && qualityWindows.length === 0;
  const filterView = view === "capacity" || view === "measurements" || view === "methodology";
  const promotionView = view === "capacity";
  const priceForm = !business && view === "capacity";
  const dataIssues = !!fullData && isCodex && !!openDataSettings && (view === "capacity" || view === "methodology" || view === "usage");
  const unresolvedPlans = data?.windows?.filter(w => !w.plan_detail || w.plan_detail.status !== "resolved").length ?? 0;
  const gapCount = fullData && isCodex ? codexPricingGaps(fullData).length + unresolvedPlans : null;
  const dataPanel = !!openDataSettings || priceForm || dataIssues;
  const counters = !business && data?.provider?.counters?.length ? data.provider : null;
  // Manual percentage readings (not for Codex, which reads its meter itself): the Capacity view opens the editor
  // from a button, the Measurements view edits and removes them in place.
  const manual: ManualCapacityProps | undefined = data && !isCodex && !project ? {
    provider: data.provider?.id ?? provider, account, counter: data.provider?.counter, counters: data.provider?.counters, windows: data.windows ?? [],
    onSaved: (next, increase, range) => {
      setCounter(next || undefined); setQuality("all");
      if (increase !== undefined && increase < minObservedPercent) setMinimum(String(increase));
      if (range && (range.until < since || range.since > until)) { setDays(0); setCustom(range); setDraft(range); }
      state.reload();
    },
  } : undefined;
  const setMinimum = (raw: string) => {
    setMinObservedInput(raw);
    if (!raw.trim()) return;
    const value = normalizeCapacityMinObservedPercent(raw);
    patchPreferences({ minimum: value }); setMinObservedInput(String(value));
  };
  // A view under its own page tab (Models) has no inner tabs, so its period controls share one row with
  // the scope instead of a head band of their own; Traffic history keeps its help on the chart title.
  const compactHead = availableViews.length < 2;
  // Unit, context, filters and data share the views' row, so the report has one control row (user, 2026-10-21).
  const reportControls = <>
    {(state.loading || updating) && data && <span className="stats-count" role="status">{t("Refreshing measurements…", "Odświeżanie pomiarów…")}</span>}
    {data && view === "capacity" && !!qualityWindows.length && <Field label={t("Unit", "Jednostka")}>
      <Tabs value={isCodex ? unit : unit === "credits_low" ? "api_standard" : unit} onChange={setUnit}
        options={(isCodex ? ["api_standard", "credits_low", "tokens"] as const : ["api_standard", "tokens"] as const).map(value => ({ value, label: capacityUnitLabel(value, t) }))} />
    </Field>}
    {data && filterView && <button type="button" className="ui-link-button" aria-haspopup="dialog" aria-expanded={filtersOpen} aria-controls={`${id}-filters`}
      aria-label={t("Advanced filters", "Zaawansowane filtry")} onClick={() => setFiltersOpen(true)}>
      {t("Filters", "Filtry")}{activeFilterCount > 0 && <span className="stats-count"> · {activeFilterCount}</span>}
    </button>}
    {saveError && filterView && <span className="ui-alert" role="status">{t("Cannot save filters", "Nie można zapisać filtrów")}</span>}
    {dataPanel && <Disclosure open={dataOpen} onToggle={() => setDataOpen(!dataOpen)} controls={`${id}-data`}>
      {t("Data and prices", "Dane i ceny")}{gapCount !== null ? ` · ${gapCount} ${t("gaps", "luk")}` : ""}
    </Disclosure>}
  </>;
  const headControls = <div className="ui-toolbar stats-head-controls">
        <Field label={t("Period", "Okres")}>
          <Selector ariaLabel={t("Analysis period", "Okres analizy")} value={String(days)} onChange={value => setDays(Number(value))} options={[
            { value: "1", label: t("Today", "Dzisiaj") },
            ...TIME_RANGE_DAYS.map(value => ({ value: String(value), label: timeRangeLabel(value, t) })),
            { value: "-1", label: t("All", "Całość") },
            { value: "0", label: t("Custom dates", "Własne daty") },
          ]} />
        </Field>
        {counters && <Field label={t("Counter", "Licznik")}>
          <Selector ariaLabel={t("Subscription counter", "Licznik abonamentu")} value={counters.counter ?? ""} onChange={setCounter}
            options={counters.counters!.map(item => ({ value: item.id, label: item.label }))} />
          {isCodex && <HelpDot label={t("Counter", "Licznik")}>{t("5h, weekly and 30-day limits have separate percentages. Capacity and traffic history follow this counter; model totals follow the selected dates.", "Limity 5h, tygodniowy i 30-dniowy mają osobne procenty. Pojemność i historia ruchu dotyczą tego licznika; sumy modeli dotyczą wybranych dat.")}</HelpDot>}
        </Field>}
        {!compactHead && reportControls}
      </div>;
  const customRange = days === 0 && <form className="ui-toolbar stats-custom" onSubmit={e => {
      e.preventDefault();
      const span = (Date.parse(draft.until) - Date.parse(draft.since)) / 86400000 + 1;
      if (!draft.since || !draft.until || !Number.isFinite(span) || span < 1 || span > 366) { setDateError(true); return; }
      setDateError(false); setCustom(draft);
    }}>
      <label className="stats-date">{t("From", "Od")} <input className="ui-date-input" type="date" required value={draft.since} onChange={e => setDraft({ ...draft, since: e.target.value })} /></label>
      <label className="stats-date">{t("To", "Do")} <input className="ui-date-input" type="date" required value={draft.until} onChange={e => setDraft({ ...draft, until: e.target.value })} /></label>
      <GhostButton type="submit">{t("Apply range", "Zastosuj zakres")}</GhostButton>
      {dateError && <span role="alert" className="ui-alert">{t("Choose ordered dates, up to 366 days in one comparison.", "Wybierz uporządkowane daty, maksymalnie 366 dni w jednym porównaniu.")}</span>}
    </form>;
  // `clip`, not `hidden`: it trims the same edges without becoming a scroll box, so the tab row can stay pinned.
  return <Card pad="0" style={{ overflow: "clip" }}>
    {!compactHead && <div className="stats-head">
      <div className="stats-head-views">
        {/* A page tab that owns one view names it already; a lone inner tab would repeat it. */}
        {availableViews.length > 1 && <Tabs value={tabValue} onChange={chooseTab} options={tabOptions}
          tablist={{ label: t("Subscription analysis views", "Widoki analizy abonamentu"), idBase: id, panelId: `${id}-panel` }} />}
        <HelpDot label={t("About this view", "O tym widoku")}>{availableViews.find(item => item.id === view)?.detail}</HelpDot>
      </div>
      {headControls}
    </div>}
    {!compactHead && customRange}
    <div className="stats-meta">
      {/* Models' single views keep their one scope row; Capacity's controls all sit in the head row above. */}
      {compactHead && <div className="ui-toolbar stats-meta-row">
        {headControls}
        <span className="stats-scope">{since} – {until} UTC · {all ? t("All subscriptions", "Wszystkie subskrypcje") : account}{project ? ` · ${t("project", "projekt")} ${project}` : ""}</span>
        {view !== "trends" && <HelpDot label={t("About this view", "O tym widoku")}>{availableViews[0]?.detail}</HelpDot>}
        <span className="ui-spacer" />
        {reportControls}
      </div>}
      {data && filterView && filtersOpen && <CapacityFiltersDrawer id={`${id}-filters`} onClose={() => setFiltersOpen(false)}
        activeCount={activeFilterCount} onReset={resetFilters}>
        <div className="stats-filter-controls">
        {planOptions.length > 0 && <Field label={t("Plan", "Plan")}>
          <Selector ariaLabel={t("Subscription plan filter", "Filtr planu abonamentu")} value={selectedPlan}
            onChange={value => setPreferences(current => ({ ...current, plans: { ...current.plans, [counterScope]: value } }))}
            options={[{ value: "all", label: t("All plans", "Wszystkie plany") }, ...planOptions]} />
        </Field>}
        {promotionView && <Field label={t("Capacity basis", "Pojemność")}>
          <Selector ariaLabel={t("Capacity basis", "Pojemność")} value={capacityBasis} onChange={value => setCapacityBasis(value as CapacityBasis)} options={[
            { value: "observed", label: t("Observed capacity", "Zaobserwowana pojemność") }, { value: "regular", label: t("Without promotions", "Bez promocji") },
          ]} />
          <HelpDot label={t("Promotion adjustment", "Korekta promocji")}>
            <HelpBlock>{t("For a confirmed 2× allowance, divide the observed 100% capacity and per-1% conversion by 2. Actual usage and vendor percentages do not change. A free reset is another cycle, not a 2× multiplier.", "Przy potwierdzonym limicie 2× dzielimy zaobserwowaną pojemność 100% i przelicznik 1% przez 2. Rzeczywiste zużycie i procent vendora nie zmieniają się. Darmowy reset daje kolejny cykl, nie mnożnik 2×.")}</HelpBlock>
            <HelpBlock>{t("Edit dated account terms in Settings → Accounts → Promotions and capacity. No entry means unknown, not confirmed absence of a promotion. API values retain historical configured prices; this switch removes allowance boosts, not API price discounts.", "Edytuj okresy konta w Ustawienia → Konta → Promocje i pojemność. Brak wpisu oznacza niewiadomą, nie potwierdzony brak promocji. Kwoty API zachowują historyczne skonfigurowane ceny; ten przełącznik usuwa zwiększenie limitu, nie rabaty cen API.")}</HelpBlock>
          </HelpDot>
        </Field>}
        <Field label={t("Min used %", "Minimalne zużycie %")} title={t("Filters the chart by meter increase; smaller cycles remain in the list as tentative estimates.", "Filtruje wykres według wzrostu licznika; mniejsze cykle pozostają na liście jako wstępne szacunki.")}>
          <Stepper ariaLabel={t("Minimum observed usage percentage", "Minimalne zaobserwowane zużycie procentowe")} min={0} max={100} value={minObservedInput}
            onChange={setMinimum} onStep={delta => setMinimum(String(Math.round(minObservedPercent) + delta))}
            onBlur={() => { if (!minObservedInput.trim()) setMinObservedInput(String(minObservedPercent)); }} />
          <HelpDot label={t("Minimum observed usage filter", "Filtr minimalnego zużycia")}>{t("Min used % uses the meter increase from end minus start for each whole-account reset cycle, across all sessions and computers. It does not mean a single chat's usage; source traffic totals remain unchanged.", "Minimalne zużycie % korzysta ze wzrostu licznika: koniec minus początek, dla każdego cyklu całego konta, ze wszystkich sesji i komputerów. Nie oznacza zużycia pojedynczego czatu; sumy ruchu źródeł pozostają bez zmian.")}</HelpDot>
        </Field>
        <Field label={t("Measurement quality", "Jakość pomiarów")}>
          <Selector ariaLabel={t("Measurement quality", "Jakość pomiarów")} value={quality} onChange={value => setQuality(value as "all" | WindowQuality)} options={[
            { value: "all", label: t("All evidence", "Wszystkie dane") }, { value: "comparable", label: t("Comparable measurements", "Porównywalne pomiary") },
            { value: "partial", label: t("Partial evidence", "Częściowe dane") }, { value: "insufficient", label: t("Insufficient evidence", "Niewystarczające dane") },
          ]} />
        </Field>
        <span className="stats-count">{selectedWindows.filter(w => w.promotion?.status === "configured").length}/{selectedWindows.length} {t("cycles with declared terms", "cykli z zadeklarowanymi warunkami")}</span>
        </div>
        {planWindows.length > 0 && <CapacityCycleFilter key={planScope} windows={planWindows} hidden={hiddenCycleIds} unit={unit} basis={capacityBasis}
          onChange={ids => setPreferences(current => ({ ...current, hidden: { ...current.hidden, [counterScope]: ids } }))} />}
      </CapacityFiltersDrawer>}
      {dataPanel && <div className="ui-inset stats-data" id={`${id}-data`} hidden={!dataOpen}>
        <div className="ui-toolbar stats-data-row">
          {openDataSettings && <>
            <button type="button" className="ui-link-button" onClick={() => openSettings({ area: "data", account, since, until })}>{t("Complete data / events", "Uzupełnij dane / zdarzenia")}</button>
            <button type="button" className="ui-link-button" onClick={() => openSettings({ area: "rates", account, since, until })}>{t("Edit dated prices", "Edytuj ceny w czasie")}</button>
          </>}
          {data && !isCodex && openDataSettings && !!data.windows?.some(window => window.plan_detail?.status !== "resolved") && <button type="button" className="ui-link-button" onClick={() => openSettings({ area: "subscriptions", account, since, until, issue: t("Confirm the historical plan and multiplier for cycles with unknown terms.", "Potwierdź historyczny plan i mnożnik dla cykli o nieustalonych warunkach.") })}>{t("Complete historical plan / multiplier", "Uzupełnij historyczny plan / mnożnik")}</button>}
          {priceForm && <form className="ui-toolbar stats-price" aria-label={t("Reference price date controls", "Data cennika porównawczego")} onSubmit={event => {
            event.preventDefault();
            const timestamp = Date.parse(referenceDraft);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDraft) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== referenceDraft) { setReferenceError(true); return; }
            setReferenceError(false); setReferenceDay(referenceDraft);
          }}>
            <label className="stats-date">{t("Price models as of", "Przelicz według cen z dnia")} <input className="ui-date-input" type="date" aria-label={t("Reference price date", "Referencyjna data cennika")} required value={referenceDraft} onChange={event => { setReferenceDraft(event.target.value); setReferenceError(false); }} /></label>
            <GhostButton type="submit">{t("Apply", "Zastosuj")}</GhostButton>
            {referenceDay && <GhostButton onClick={() => { setReferenceDay(undefined); setReferenceError(false); }}>{t("Clear price comparison", "Wyczyść porównanie cen")}</GhostButton>}
            {referenceDay && <span className="stats-count">{t("priced as of ", "wycena z dnia ")}{referenceDay}</span>}
            {referenceError && <span role="alert" className="ui-alert">{t("Enter a valid calendar date.", "Wpisz poprawną datę kalendarzową.")}</span>}          </form>}
        </div>
        {directCapacity && accounting.error && <ErrorState message={accounting.error} onRetry={accounting.reload} />}
        {directCapacity && accounting.loading && needsAccounting && !fullData && <LoadingCard height={80} />}
        {dataIssues && <CodexDataIssues data={fullData!} open={openSettings} />}
      </div>}
    </div>
    {compactHead && customRange}
    <div role={availableViews.length > 1 ? "tabpanel" : undefined} className="stats-body" id={`${id}-panel`}
      aria-labelledby={availableViews.length > 1 ? `${id}-${tabValue}` : undefined}>
    {whole.error && <ErrorState message={whole.error} onRetry={whole.reload} />}
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    {(state.loading || !whole.ready && !whole.error) && !data && <LoadingCard label={t("Loading subscription analysis…", "Wczytywanie analizy abonamentu…")} height={320} shape="kpi" />}
    {data && <>
      {counters?.counter_reason && <p role="status" className="codex-view-description">{counters.counter_reason}</p>}
      {!isCodex && fullData && <div className="ui-toolbar stats-provider">
        <span>{all ? t("All subscriptions", "Wszystkie subskrypcje") : data.provider?.label}</span>
        <HelpDot label={all ? t("All subscriptions", "Wszystkie subskrypcje") : data.provider?.label}>{t("No provider credit conversion is configured. API equivalents and tokens describe recorded work, not a fixed subscription budget.", "Brak skonfigurowanego przelicznika kredytów dostawcy. Ekwiwalent API i tokeny opisują zapisany ruch, nie stały budżet abonamentu.")}</HelpDot>
        {!data.provider?.counters?.length && data.provider?.counter_reason && <span role="status">{data.provider.counter_reason}</span>}
        {!!fullData.normalization.standard_api_usd.unpriced_events && <span role="status">{fullData.normalization.standard_api_usd.unpriced_events} {t("events without complete pricing; see Models & sources for missing rates.", "zdarzeń bez pełnej wyceny; brakujące stawki zobaczysz w Modelach i źródłach.")}</span>}
      </div>}
      {business && fullData && <p className="codex-view-description">{t("Business credits", "Kredyty Business")} · {compact(fullData.tokens)} {t("tokens", "tokenów")} · {fullData.normalization.standard_api_usd.unpriced_events ? "≥ " : ""}{usd(fullData.normalization.standard_api_usd.priced_subtotal)} API · {t("No weekly subscription allowance.", "Bez tygodniowego limitu abonamentu.")}</p>}
      {!isCodex && fullData && (view === "capacity" || view === "measurements") && <>
        <p className="stats-line" aria-label={t("Recorded usage", "Zapisane zużycie")}>
          {t("Recorded in selected dates", "Zapisane w wybranych datach")}: {compact(fullData.tokens)} {t("tokens", "tokenów")} · {fullData.events.toLocaleString(locale)} {t("requests", "wywołań")} · API: {fullData.normalization.standard_api_usd.priced_events
            ? `${fullData.normalization.standard_api_usd.unpriced_events ? "≥ " : ""}${usd(fullData.normalization.standard_api_usd.priced_subtotal)}` : t("missing prices", "brak wyceny")}
          {!data.windows?.length && <> · {t("Capacity needs a percentage reading. Recorded usage remains available.", "Pojemność wymaga pomiaru procentowego. Zapisane zużycie jest dostępne.")}</>}
        </p>
        {manual && view === "capacity" && <ManualCapacityMeasurements {...manual} />}
      </>}
      {promotionView && markerState.error && <ErrorState message={markerState.error} onRetry={markerState.reload} />}
      {hasCycleFilterEmpty && filterView && <p className="codex-view-description" role="status">{t("All windows hidden", "Wszystkie okna ukryte")}</p>}
      {(view === "capacity" ? hasQualityFilterEmpty : hasCapacityFilterEmpty) && filterView && <>
        <p className="codex-view-description" role="status">{quality === "all" ? t("No cycles meet the minimum observed usage filter. Lower Min used % to include smaller meter samples.", "Żaden cykl nie spełnia minimalnego filtra zużycia. Zmniejsz Minimalne zużycie %, aby uwzględnić mniejsze próbki licznika.") : t("No cycles meet both the quality and minimum usage filters. Choose All evidence to inspect the reasons.", "Żaden cykl nie spełnia jednocześnie filtra jakości i minimalnego zużycia. Wybierz Wszystkie dane, aby sprawdzić przyczyny.")}</p>
        {view === "methodology" && <CapacityMilestones markers={markers} />}
      </>}
      {view === "model-capacity" && <ModelCapacity provider={adapter.id} account={account} counter={data.provider?.counter ?? counter} since={since} until={until} dataRevision={dataRevision} project={project} />}
      {section === "capacity" && view !== "model-capacity" && view !== "cost" && <div hidden={hasCycleFilterEmpty || (view === "capacity" ? hasQualityFilterEmpty : hasCapacityFilterEmpty)}><CodexWindowTable analysisScope={{ provider: adapter.id, options: { ...data.scope, counter: data.provider?.counter ?? undefined } }} openDataSettings={openDataSettings ? openSettings : undefined} creditsAvailable={isCodex} key={`${account}:${data.provider?.counter ?? "weekly"}`} markers={markers} basis={capacityBasis} windows={view === "capacity" && data.windows !== null ? qualityWindows : capacityWindows} view={view}
        allWindows={data.windows === null ? undefined : selectedWindows} unit={unit} minObservedPercent={minObservedPercent} range={{ since, until }} manual={manual} contextImpact={contextImpact}
        capacityTab={capacityTab} /></div>}
      {!business && view === "capacity" && referenceDay && <section aria-label={t("Compare at one price date", "Porównanie przy jednym cenniku")}>
        <h3 className="stats-section-title">{t("Compare at one price date", "Porównanie przy jednym cenniku")}</h3>
        <SubscriptionRevaluation key={`${account}:${data.provider?.counter ?? "weekly"}`} windows={capacityWindows} referenceDay={referenceDay} initialSelection={priceCycles} onSelectionChange={setPriceCycles} openDataSettings={openDataSettings ? openSettings : undefined} />
      </section>}
      {isCodex && view === "methodology" && <section className="capacity-section" aria-label={t("Provider promotions and resets", "Promocje i resety dostawcy")}>
        <div className="capacity-section-head">
          <h3 className="stats-section-title">{t("Provider promotions and resets", "Promocje i resety dostawcy")}</h3>
          <span className="capacity-section-sub">{t("reviewed", "sprawdzono")} {CODEX_PROMOTIONS_VERIFIED_AT}</span>
          <HelpDot label={t("Provider promotions and resets", "Promocje i resety dostawcy")}>{t("Announcements, not a complete entitlement history. The dated Pro $100 launch offer is matched automatically to historical 5× plans; the others are context. Hover a point for its terms; click it for the source.", "Ogłoszenia, nie kompletna historia uprawnień. Promocja premierowa Pro 100 USD jest automatycznie dopasowana do historycznych planów 5×; pozostałe są kontekstem. Wskaż punkt, aby zobaczyć warunki; kliknij, aby otworzyć źródło.")}</HelpDot>
        </div>
        <CodexPromotionTimeline />
      </section>}
      {view === "trends" && fullData && <CodexUsageTimeline key={`${account}:${data.provider?.counter ?? "weekly"}`} data={fullData}
        markerProviders={all ? [...new Set(reportAccounts.map(item => item.provider))] : undefined}
        help={availableViews.length === 1 ? availableViews[0]?.detail : undefined} />}
      {view === "usage" && fullData && <ModelUsage data={fullData} codex={isCodex} account={account} project={project} since={since} until={until}
        aggregateCodexAccounts={all ? reportAccounts.filter(item => item.provider === "codex").map(item => item.account) : undefined}
        openDataSettings={openDataSettings ? openSettings : undefined} onOverview={onOverview} vendor={all ? undefined : provider}
        onModelEvents={onModelEvents ? model => onModelEvents(model, { since, until }) : undefined} />}
      {view === "cost" && fullData && <ModelUnitCost data={fullData} codex={isCodex} vendor={all ? undefined : provider} />}
      {view === "methodology" && directCapacity && !fullData && <>{accounting.error ? <ErrorState message={accounting.error} onRetry={accounting.reload} /> : <LoadingCard height={160} />}</>}
      {view === "methodology" && fullData && <section className="capacity-section">
        {/* The report's own provenance (sources, attribution, deduplication, limits) is reference text: help dot only. */}
        {(() => {
          const provenance = <HelpDot label={t("Data sources", "Źródła danych")}>
            {[fullData.quantity_basis, fullData.account_attribution, fullData.deduplication, ...fullData.limitations].map((note, i) => <HelpBlock key={i}>{note}</HelpBlock>)}
          </HelpDot>;
          return isCodex ? <h3 className="stats-section-title">{t("Check the multiplier against the measured limit", "Sprawdzenie przelicznika względem rzeczywistego limitu")}
            <HelpDot label={t("Calibration", "Kalibracja")}>{t("Account-level calibration. A reset, plan change, probe gap over two hours, or incomplete pricing excludes a sample. The check requires three separate reset windows.", "Kalibracja na poziomie konta. Reset, zmiana planu, przerwa sond ponad 2 godziny i niepełna wycena wykluczają próbkę. Sprawdzenie wymaga trzech osobnych okien resetu.")}</HelpDot>
            {provenance}
          </h3> : <h3 className="stats-section-title">{t("Data sources", "Źródła danych")}{provenance}</h3>;
        })()}
        {isCodex && <>
        {!fullData.calibration ? <p>{t("Select the whole account to compare it with its limit.", "Wybierz całe konto, aby porównać z jego limitem.")}</p> : <>
          {!fullData.calibration.models.length && <p>{t("There are no complete samples for converting credits to %. The measured Codex reading remains authoritative.", "Brak pełnych próbek do przeliczenia kredytów na %. Rzeczywisty odczyt Codex pozostaje obowiązujący.")}</p>}
            {fullData.calibration.models.map(m => <p key={m.key}>{m.window_minutes === 300 ? t("5 hours", "5 godzin") : t("Week", "Tydzień")} · {subscriptionPlan("codex", m.plan)}:
            {" "}{m.credits_per_1pct?.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {t("credits / 1 pp", "kredytów / 1 p.p.")} · {usd(m.standard_normalized_usd_per_1pct ?? 0)} {t("Standard / 1 pp", "Standard / 1 p.p.")} ·
            {" "}{m.status === "validated" ? t("matches a separate window", "zgodne z osobnym oknem") : t("working estimate - unconfirmed", "robocze — brak potwierdzenia")}
            {m.validation_mae_pp != null && ` · ${t("mean error", "średni błąd")} ${m.validation_mae_pp.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${t("pp", "p.p.")}`}</p>)}
          <Table tableId="SubscriptionStats:0"><thead><TableRow header><Th columnId="c0">{t("UTC interval", "Przedział UTC")}</Th><Th columnId="c1">{t("Measured pp", "Pomiar p.p.")}</Th><Th columnId="c2">{t("Forecast pp", "Prognoza p.p.")}</Th><Th columnId="c3">{t("Result", "Wynik")}</Th></TableRow></thead><tbody>
            {fullData.calibration.intervals.map(r => <TableRow key={JSON.stringify([r.account,r.window_minutes,r.start_ts,r.end_ts])}><Td mono title={`${r.start_ts} → ${r.end_ts}`}>{r.start_ts.replace("T", " ").slice(5, 16)} → {r.end_ts.replace("T", " ").slice(5, 16)}</Td><Td mono>{r.observed_pp.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Td><Td mono>{r.predicted_pp?.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}</Td><Td>{roles[r.role]} · {reasons[r.reason] ?? r.reason}</Td></TableRow>)}
          </tbody></Table>
        </>}
      </>}
      </section>}
    </>}
    </div>
  </Card>;
}
