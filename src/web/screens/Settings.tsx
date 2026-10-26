import { useEffect, useMemo, useState } from "react";
import type {
  CatalogProviderGroup,
  PlanCapacityResult,
  PlansCatalog,
} from "../lib/api";
import { api, refreshApiData } from "../lib/api";
import { buildCapacityJobs, buildPlanRows, loadCapacities, todayUtc } from "../lib/settings-rows";
import type { ScreenProps } from "../lib/screens";
import { useAsync } from "../lib/useAsync";
import { setMissingRates, unpricedTableRows } from "../lib/missing-rate";
import { peekSettingsTab, settingsPlace, takeSettingsTab, type SettingsPlace, type SettingsTab } from "../lib/settings-link";
import { PlanCatalogPanel } from "../components/PlanCatalogPanel";
import { PlansTable } from "../components/PlansTable";
import { RateCardsPanel } from "../components/RateCardsPanel";
import { DetailTabs, ErrorState, LoadingCard, Tabs } from "../components/ui";
import { useI18n } from "../lib/i18n";
import { Setup } from "./Setup";
import { CodexPricingPeriods } from "../components/CodexPricingPeriods";
import { HistoryDataSettings } from "../components/HistoryDataSettings";
import { AnalysisRebuildControl } from "../components/AnalysisRebuildControl";
import { AccountPeriodsSettings } from "../components/AccountPeriodsSettings";
import { accountSectionTabs, AllAccountsSettings } from "../components/AccountSettingsSections";
import type { SectionRequest } from "../components/AccountPeriodGroups";
import { SourceHealthPanel } from "../components/SourceHealthPanel";
import type { DataSettingsTarget } from "../lib/data-settings";
type Translate = (en: string, pl: string) => string;
const SETTINGS_TABS: Record<SettingsTab, { en: string; pl: string; titleEn: string; titlePl: string }> = {
  accounts: { en: "Accounts", pl: "Konta", titleEn: "Each account's plan and computer periods, price and calibration, promotions and window rhythm", titlePl: "Okresy planów i komputerów, cena i kalibracja, promocje i rytm okien każdego konta" },
  computers: { en: "Computers and data", pl: "Komputery i dane", titleEn: "Computers, application profiles and the subscriptions they feed; archive history and events", titlePl: "Komputery, profile aplikacji i abonamenty, które zasilają; historia archiwum i zdarzenia" },
  pricing: { en: "Price lists", pl: "Cenniki", titleEn: "Provider plans with their calibration, and model rate cards $/1M", titlePl: "Plany dostawców z kalibracją i cenniki modeli $/1M" },
};
/** Three tabs without group labels (user decision 2026-10-08): one account is no longer spread over four tabs. */
const SETTINGS_TAB_ORDER: SettingsTab[] = ["accounts", "computers", "pricing"];
export function settingsTabOptions(t: Translate) {
  return SETTINGS_TAB_ORDER.map((value) => ({ value, label: t(SETTINGS_TABS[value].en, SETTINGS_TABS[value].pl), title: t(SETTINGS_TABS[value].titleEn, SETTINGS_TABS[value].titlePl) }));
}
const PROVIDER_ORDER = ["openai", "anthropic", "google", "xai", "zai"];
/** The switch names providers as the rest of the app does (Codex, Claude…), not by the catalog's company names. */
const PROVIDER_PRODUCT: Record<string, string> = { openai: "Codex", anthropic: "Claude", google: "Gemini", xai: "Grok", zai: "GLM" };
export { buildCapacityJobs, buildPlanRows, buildSubscriptionRows, windowKindOf } from "../lib/settings-rows";
export function planEditorTarget(
  planId: string,
  versionId?: string
): { planId: string; versionId: string | null; view: "catalog" } {
  return {
    planId,
    versionId: versionId ?? null,
    view: "catalog",
  };
}
function orderedGroups(catalog: PlansCatalog): CatalogProviderGroup[] {
  const rank = new Map(PROVIDER_ORDER.map((id, i) => [id, i]));
  return [...catalog.provider_groups].sort((a, b) => {
    const ia = rank.get(a.id) ?? 100;
    const ib = rank.get(b.id) ?? 100;
    if (ia !== ib) return ia - ib;
    return a.label.localeCompare(b.label);
  });
}
/** Links that name an account land on that account in Accounts. */
const ACCOUNT_AREAS = new Set<DataSettingsTarget["area"]>(["periods", "subscriptions", "cadence", "windows"]);
export function Settings(props: ScreenProps) {
  const { t } = useI18n();
  const [initial] = useState(() => settingsPlace(props.dataSettings?.area ?? peekSettingsTab() ?? "accounts"));
  const [tab, setTab] = useState<SettingsTab>(initial.tab);
  const [localTarget, setLocalTarget] = useState<DataSettingsTarget | undefined>(props.dataSettings ?? undefined);
  const [pricingView, setPricingView] = useState<"plans" | "models">(initial.pricing ?? "plans");
  const [plansView, setPlansView] = useState<"table" | "catalog">("table");
  const [focusedPlanId, setFocusedPlanId] = useState<string | null>(null);
  const [focusedVersionId, setFocusedVersionId] = useState<string | null>(null);
  const [provider, setProvider] = useState("all");
  const [asOf, setAsOf] = useState(props.dataSettings?.since ?? todayUtc);
  // The account tab a link asked for: opened under the account's timeline and brought into view once.
  const [sectionRequest, setSectionRequest] = useState<SectionRequest | null>(() => initial.sections?.[0] ? { key: initial.sections[0], seq: 0 } : null);
  // A link to the data area opens its subscription's archive history (every account's range without one).
  const dataTab = (account?: string | null) => account && account !== "all" ? { subscription: account, tab: "history" } : { subscription: null, tab: "archive" };
  const [dataRequest, setDataRequest] = useState<{ subscription: string | null; tab: string; seq: number } | null>(() =>
    initial.data ? { ...dataTab(props.dataSettings?.account ?? props.account), seq: 0 } : null);
  const goTo = (place: SettingsPlace, account?: string | null) => {
    setTab(place.tab);
    if (place.pricing) setPricingView(place.pricing);
    const section = place.sections?.[0];
    if (section) setSectionRequest((request) => ({ key: section, seq: (request?.seq ?? 0) + 1 }));
    if (place.data) setDataRequest((request) => ({ ...dataTab(account ?? props.account), seq: (request?.seq ?? 0) + 1 }));
  };
  const navigateData = (target: DataSettingsTarget) => {
    setLocalTarget(target); goTo(settingsPlace(target.area), target.account); setProvider("all");
    if (target.since) setAsOf(target.since);
  };
  useEffect(() => {
    const requested = takeSettingsTab();
    if (props.dataSettings) navigateData(props.dataSettings);
    else { setLocalTarget(undefined); goTo(settingsPlace(requested ?? "accounts")); }
  }, [props.dataSettings]);
  const accountTarget = localTarget && ACCOUNT_AREAS.has(localTarget.area) ? localTarget : undefined;
  const pricingPlans = tab === "pricing" && pricingView === "plans";
  const pricingModels = tab === "pricing" && pricingView === "models";
  // Each tab reads only its own data; Computers and data needs no catalog.
  const catalogState = useAsync(async () => tab !== "computers" ? api.plansCatalog() : null, [tab === "computers"]);
  // Each subscription's plan on the "As of" day comes from its account periods; only Accounts reads it.
  const plansState = useAsync(async () => tab === "accounts" ? api.plans(asOf) : null, [tab === "accounts", asOf]);
  const ratesState = useAsync(async () => pricingModels ? api.rateCards() : null, [pricingModels]);
  // The unpriced rows are the alert's own summary (/api/missing-rates), so the table and the alert cannot disagree.
  const missingRatesState = useAsync(async () => pricingModels ? api.missingRates() : null, [pricingModels]);
  useEffect(() => { if (missingRatesState.data) setMissingRates(missingRatesState.data); }, [missingRatesState.data]);
  const catalog = catalogState.data?.catalog ?? null;
  const capacityState = useAsync(async () => {
    if (!catalog || !pricingPlans) return new Map<string, PlanCapacityResult | null>();
    return loadCapacities(buildCapacityJobs(catalog, asOf));
  }, [catalog, asOf, pricingPlans]);
  const providerOptions = useMemo(() => {
    const groups = catalog ? orderedGroups(catalog) : [];
    return [
      { value: "all", label: t("All", "Wszyscy") },
      ...groups.map((g) => ({ value: g.id, label: PROVIDER_PRODUCT[g.id] ?? g.label })),
    ];
  }, [catalog, t]);
  const selectedProviderGroup = useMemo(() => {
    if (!catalog || !provider || provider === "all") return null;
    const want = provider.toLowerCase();
    return (
      catalog.provider_groups.find(
        (g) => g.id.toLowerCase() === want || (g.aliases ?? []).some((a) => a.toLowerCase() === want)
      ) ?? null
    );
  }, [catalog, provider]);
  const providerAliases = useMemo(() => {
    if (!selectedProviderGroup) return [];
    return [selectedProviderGroup.id, ...(selectedProviderGroup.aliases ?? [])];
  }, [selectedProviderGroup]);
  const planRows = useMemo(() => {
    if (!catalog) return [];
    return buildPlanRows(catalog, capacityState.data ?? new Map(), asOf, provider);
  }, [catalog, capacityState.data, asOf, provider]);
  const loading = catalogState.loading && !catalog;
  const error = catalogState.error;
  const subscriptions = plansState.data?.rows ?? null;
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--s-8)" }}
      data-screen="settings"
      data-settings-tab={tab}
    >
      {localTarget && (tab !== "computers" || localTarget.area === "data") && <div className="capacity-history-info" role="status">
        <span>{localTarget.account} · {localTarget.since ?? "—"} — {localTarget.until ?? "—"} UTC{localTarget.issue ? ` · ${localTarget.issue}` : ""}</span>
        {props.returnFromSettings && <button type="button" onClick={props.returnFromSettings}>{t("Return to analysis and recalculate", "Wróć do analizy i przelicz")}</button>}
      </div>}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div data-settings-tabs="1" style={{ display: "flex", flex: "1 1 auto", flexWrap: "wrap", alignItems: "center", gap: "var(--s-3) var(--s-7)" }}>
          <Tabs variant="sections" value={tab} onChange={setTab} options={settingsTabOptions(t)} />
        </div>
        {/* The provider filter applies to Accounts and Price lists; Accounts shows its "As of" day beside the tables it changes. */}
        {tab !== "computers" && <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Tabs value={provider} onChange={setProvider} options={providerOptions} />
          {tab === "pricing" && <label className="ui-selector">
            <span className="ui-selector-label">
              {t("As of", "Stan na dzień")}
            </span>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value || todayUtc())}
              aria-label={t("As of date", "Stan na dzień")}
              className="mono"
              style={{
                width: 138,
                padding: "0 var(--s-2)",
                border: "none",
                background: "transparent",
                color: "var(--text)",
                fontSize: "var(--fs-5)",
                outline: "none",
              }}
            />
          </label>}
        </div>}
      </div>
      {tab !== "computers" && error && <ErrorState message={error} onRetry={catalogState.reload} />}
      {/* The account card loads its own data; only the provider selector above waits for the catalog. */}
      {tab === "pricing" && loading && <LoadingCard label={t("Loading Plan catalog…", "Wczytuję katalog Planów…")} shape="table" />}
      {tab === "accounts" && <>
        {plansState.error && <ErrorState message={plansState.error} onRetry={plansState.reload} />}
        <AccountPeriodsSettings provider={provider} providerAliases={providerAliases} extras={{
          selectAccount: accountTarget?.account ?? null,
          accountSections: (account) => accountSectionTabs({ account, subscriptions, asOf, onAsOf: setAsOf, target: accountTarget, t }),
          requestedSection: sectionRequest,
          allAccountsSections: (accounts) => <AllAccountsSettings accounts={accounts} subscriptions={subscriptions} asOf={asOf} onAsOf={setAsOf} provider={provider} />,
        }} />
      </>}
      {/* Computers and data: the subscriptions beside the chosen one's computers and archive history; the rail's first
          entry holds what applies to every account. */}
      {tab === "computers" && <SourceHealthPanel initialSubscription={localTarget?.account ?? props.account} request={dataRequest}
        history={(subscription) => <section data-settings-section="data" aria-label={t("Data and events", "Dane i zdarzenia")}>
          <HistoryDataSettings account={subscription} since={localTarget?.since} until={localTarget?.until} onNavigate={navigateData} />
        </section>}
        overview={[
          { key: "rebuild", label: t("Recalculate data", "Przeliczanie danych"), render: () => <AnalysisRebuildControl /> },
          { key: "archive", label: t("Archive history range", "Zakres historii archiwum"), render: () => <section data-settings-section="data" aria-label={t("Data and events", "Dane i zdarzenia")}>
            <HistoryDataSettings account="all" since={localTarget?.since} until={localTarget?.until} onNavigate={navigateData} />
          </section> },
          { key: "setup", label: t("Advanced configuration", "Zaawansowana konfiguracja"),
            render: () => <Setup heading={t("Advanced source configuration", "Zaawansowana konfiguracja źródeł")} onDone={refreshApiData} /> },
        ]} />}
      {tab === "pricing" && (
        <div className="ui-sheet settings-pricing">
          {/* One switcher (paper-atlas §7): the plans' table and catalog editor, then the models' rates. */}
          <DetailTabs label={t("Price lists", "Cenniki")} active={pricingView === "models" ? "models" : plansView === "catalog" ? "plans-catalog" : "plans-table"}
            onChange={(key) => { setPricingView(key === "models" ? "models" : "plans"); if (key !== "models") setPlansView(key === "plans-catalog" ? "catalog" : "table"); }}
            groups={[{ label: t("Plans", "Plany"), tabs: [
              { key: "plans-table", label: t("Table and calibration", "Tabela i kalibracja"), render: () => !loading && !error && <>
              {capacityState.error && <ErrorState message={capacityState.error} onRetry={capacityState.reload} />}
              <PlansTable
                rows={planRows}
                asOf={asOf}
                onEditPlan={(planId, versionId) => {
                  const target = planEditorTarget(planId, versionId);
                  setFocusedPlanId(target.planId);
                  setFocusedVersionId(target.versionId);
                  setPlansView(target.view);
                }}
              />
            </> },
              { key: "plans-catalog", label: t("Plan catalog editor", "Edytor katalogu Planów"), render: () => !loading && !error && catalog && <PlanCatalogPanel
              catalog={catalog}
              provider={provider}
              focusedPlanId={focusedPlanId ?? undefined}
              focusedVersionId={focusedVersionId ?? undefined}
              onSaved={() => {
                catalogState.reload();
                capacityState.reload();
              }}
            /> },
            ] }, { label: t("Models", "Modele"), tabs: [
              { key: "models", label: t("Model rates $/1M", "Stawki modeli $/1M"), render: () => <>
              {(provider === "all" || providerAliases.some(alias => ["codex", "openai"].includes(alias))) && <CodexPricingPeriods
                key={JSON.stringify(localTarget ?? null)} target={localTarget}
                onSaved={() => { ratesState.reload(); capacityState.reload(); missingRatesState.reload(); }} />}
              {ratesState.error && <ErrorState message={ratesState.error} onRetry={ratesState.reload} />}
              {ratesState.loading && !ratesState.data ? (
                <LoadingCard label={t("Loading model rate cards…", "Wczytuję cenniki modeli…")} shape="table" />
              ) : ratesState.data ? (
                <RateCardsPanel
                  data={ratesState.data}
                  asOf={asOf}
                  onSaved={() => { ratesState.reload(); capacityState.reload(); missingRatesState.reload(); }}
                  provider={provider}
                  providerAliases={providerAliases}
                  unpriced={unpricedTableRows(missingRatesState.data)}
                  onPriceCodexModel={(model, since) => navigateData({ area: "rates", account: localTarget?.account ?? props.account ?? "all",
                    model, since, basis: "api_equivalent_usd", speed: "standard", newPeriod: true,
                    issue: t("Price for a model without a rate", "Cena modelu bez stawki") })}
                />
              ) : null}
            </> },
            ] }]} />
        </div>
      )}
    </div>
  );
}
