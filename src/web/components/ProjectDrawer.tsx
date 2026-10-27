import type { ProjectCostResponse, SubjectRow, CalendarGranularity, RepoHistoryResponse } from "../lib/api";
import { type RosterCard, subscriptionNameLookup } from "../lib/roster";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import { subscriptionColor } from "./mix";
import { DetailTabs, ErrorState, EstimateTag, Eyebrow, HelpBlock, HelpDot, LoadingCard, Tabs, type DetailTab } from "./ui";
import { granularityOptions, localizedPlural, captureFileName } from "./project-drawer/format";
import { usedHint, windowMeasurementHint } from "./project-drawer/subscriptions";
import { SubscriptionSplitTable } from "./project-drawer/SubscriptionSplitTable";
import { QuestionSection, ValuesToggle } from "./project-drawer/presentation";
import { WhatIfTable } from "./project-drawer/WhatIfTable";
import { isAbortError, repoHistoryUrl, fetchRepoHistory, historyForRequest } from "./project-drawer/history";
import { ProjectMixChart } from "./project-drawer/ProjectMixChart";
import { ProjectTimeChart } from "./project-drawer/ProjectTimeChart";
import { useProjectDrawerCost } from "./project-drawer/drawer-cost-model";
import { ProjectCostSummary } from "./project-drawer/ProjectCostSummary";
import { ProjectSharesSection } from "./project-drawer/ProjectShares";
import { ProjectPlanPanel } from "../screens/ProjectPlanPanel";
import { useContextCompanion } from "../lib/use-context-companion";

/** The drawer's page tabs (IA-2026-10-19 PR-2): Summary, Timeline, Cost and subscriptions, Plan simulation. */
export const PROJECT_DRAWER_TABS = ["summary", "timeline", "cost", "simulation"] as const;
export type ProjectDrawerTab = (typeof PROJECT_DRAWER_TABS)[number];
const drawerTabKey = "tokenatlas.project-drawer-tab.v1";
export function readProjectDrawerTab(): ProjectDrawerTab {
  try {
    const saved = localStorage.getItem(drawerTabKey);
    return PROJECT_DRAWER_TABS.find(tab => tab === saved) ?? "summary";
  } catch { return "summary"; }
}
function writeProjectDrawerTab(tab: ProjectDrawerTab) {
  try { localStorage.setItem(drawerTabKey, tab); } catch { /* The choice still applies for this visit. */ }
}

export interface ProjectDrawerProps {
  subject: SubjectRow;
  cost: ProjectCostResponse | null;
  costLoading?: boolean;
  costError?: string | null;
  onCostRetry?: () => void;
  cards?: RosterCard[];
  since?: string;
  rangeDays: number | null;
  idleGap: number;
  onClose: () => void;
  /** Opens on this tab instead of the remembered one. */
  initialTab?: ProjectDrawerTab;
}

export function ProjectDrawer({
  subject,
  cost,
  costLoading = false,
  costError = null,
  onCostRetry,
  cards = [],
  since,
  rangeDays,
  idleGap,
  onClose,
  initialTab,
}: ProjectDrawerProps) {
  const { t, language } = useI18n();
  const granularityChoices = granularityOptions();
  const nameOf = useMemo(() => subscriptionNameLookup(cards), [cards]);
  const [granularity, setGranularity] = useState<CalendarGranularity>("week");
  const [moreColumns, setMoreColumns] = useState(false);
  const [hideChartValues, setHideChartValues] = useState(false);
  const [tab, setTab] = useState<ProjectDrawerTab>(() => initialTab ?? readProjectDrawerTab());
  const chooseTab = useCallback((key: string) => {
    const next = PROJECT_DRAWER_TABS.find(item => item === key) ?? "summary";
    setTab(next);
    writeProjectDrawerTab(next);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [historyState, setHistoryState] = useState<{
    data: RepoHistoryResponse | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  const [historyNonce, setHistoryNonce] = useState(0);
  const reloadHistory = useCallback(() => setHistoryNonce((n) => n + 1), []);
  // The summary's active time reads this history too, so it loads whichever tab is open.
  useEffect(() => {
    const controller = new AbortController();
    setHistoryState((prev) => ({ ...prev, loading: true }));
    fetchRepoHistory(repoHistoryUrl({ subject, granularity, idleGap, since }), controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setHistoryState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || isAbortError(e)) return;
        setHistoryState((prev) => ({
          ...prev,
          error: e instanceof Error ? e.message : String(e),
          loading: false,
        }));
      });
    return () => {
      controller.abort();
    };
  }, [subject.kind, subject.id, granularity, idleGap, since, historyNonce]);
  const storedHistory = historyForRequest(historyState, { subject, granularity, idleGap, since });
  const historyPreview = useContextCompanion(storedHistory);
  const history = historyPreview.data;
  // Wall-clock time comes with the history of the same range and threshold; until then the KPI waits.
  const activeSeconds = history?.totals.active_seconds ?? null;
  const { summary, receipt: { lines: receiptLines, uncalibrated }, units, vendorBySub, whatIfRows, shares } = useProjectDrawerCost(
    { subject, cost, costLoading, costError, cards, since, rangeDays },
    { t, language, nameOf },
  );
  const { isCostPending, isCostFailed, apiUsd } = summary;
  const costFailure = <ErrorState message={costError ?? t("Could not load cost", "nie udało się pobrać kosztu")} onRetry={onCostRetry} />;
  const renderSummary = () => (
    <>
      <ProjectCostSummary subject={subject} since={since} idleGap={idleGap}
        time={{ activeSeconds, error: historyState.error }} cost={summary} />
      <ProjectSharesSection shares={shares} pending={isCostPending}
        error={isCostFailed ? costError ?? t("Could not load cost", "nie udało się pobrać kosztu") : null} onRetry={onCostRetry} />
    </>
  );
  const renderTimeline = () => (
    <QuestionSection
      first
      data="time"
      title={t("How did it spread over time?", "Jak to się rozkładało w czasie?")}
      controls={
        <>
          <Tabs value={granularity} onChange={(v) => setGranularity(v as CalendarGranularity)} options={granularityChoices} />
          <ValuesToggle hidden={hideChartValues} onToggle={() => setHideChartValues((v) => !v)} />
        </>
      }
    >
      {!history ? (
        historyState.error ? (
          <ErrorState message={historyState.error} onRetry={reloadHistory} />
        ) : (
          <LoadingCard label={`${t("Loading usage history", "Wczytuję historię zużycia")} (${granularity})...`} height={190} shape="chart" />
        )
      ) : (
        <>
          <ProjectMixChart
            title={t("usage history ($)", "historia zużycia ($)")}
            points={history.points}
            totalsBySub={history.totals.by_sub}
            vendorCoverage={history.vendor_coverage}
            vendorBySub={vendorBySub}
            granularity={granularity}
            colorOf={subscriptionColor}
            nameOf={nameOf}
            idleGap={idleGap}
            hideValues={hideChartValues}
            units={units}
            fileName={captureFileName(subject.name, "zuzycie", granularity)}
          />
          {history.points.length > 0 && (
            <ProjectTimeChart
              title={t("time spent on the project (≈)", "czas spędzony na projekcie (≈)")}
              points={history.points}
              granularity={granularity}
              idleGap={idleGap}
              hideValues={hideChartValues}
              fileName={captureFileName(subject.name, "czas", granularity)}
            />
          )}
        </>
      )}
    </QuestionSection>
  );
  const renderCost = () => (
    <QuestionSection
      first
      data="subscriptions"
      title={t("Which subscriptions carried it?", "Które subskrypcje to niosły?")}
      help={
        <HelpDot label={t("About this table", "O tej tabeli")}>
          <HelpBlock>{t("Actual usage, sorted by $ · equivalents in subscription units. Hover a column header for its definition and a plan chip for its periods.", "Rzeczywiste zużycie, posortowane wg $ · ekwiwalenty w sztukach abonamentu. Najedź na nagłówek kolumny po definicję, a na plan po jego okresy.")}</HelpBlock>
          <HelpBlock>{usedHint()}</HelpBlock>
          <HelpBlock>{windowMeasurementHint()}</HelpBlock>
        </HelpDot>
      }
      controls={
        !isCostFailed && !isCostPending && receiptLines.length > 0 ? (
          <button
            type="button"
            className="ui-button"
            aria-pressed={moreColumns}
            onClick={() => setMoreColumns((v) => !v)}
            title={t("Capacity equivalents, tokens by type and the window measurement", "Ekwiwalenty pojemności, tokeny wg typu i pomiar okna")}
            style={{ color: moreColumns ? "var(--text)" : "var(--muted)", fontSize: "var(--fs-3)", padding: "var(--s-2) var(--s-5)" }}
          >
            {t("more columns", "więcej kolumn")}
          </button>
        ) : undefined
      }
    >
      {isCostFailed ? (
        costFailure
      ) : isCostPending ? (
        <LoadingCard label={t("Loading project cost data...", "Wczytuję dane kosztowe projektu...")} height={110} shape="kpi" />
      ) : receiptLines.length > 0 ? (
        <>
          <SubscriptionSplitTable lines={receiptLines} nameOf={nameOf} moreColumns={moreColumns} />
          {uncalibrated && (
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              <span>{t("Unit columns are empty for the entire mix.", "Kolumny w sztukach są puste dla całego miksu.")}</span>
              <HelpDot>
                <HelpBlock>{uncalibrated}</HelpBlock>
                <HelpBlock>{t("The dollars beside them are still real. They need a declared price, not window capacity.", "Dolary obok są prawdziwe niezależnie od tego. Nie potrzebują pojemności okna, tylko zadeklarowanej ceny.")}</HelpBlock>
              </HelpDot>
            </div>
          )}
        </>
      ) : (
        <div
          className="mono"
          style={{
            padding: "var(--s-7)",
            fontSize: "var(--fs-3)",
            color: "var(--muted)",
            borderRadius: "var(--r-chip)",
            background: "var(--sunk)",
            textAlign: "center",
          }}
        >
          {t("No subscriptions assigned in the selected period.", "Brak przypisanych subskrypcji w wybranym okresie.")}
        </div>
      )}
    </QuestionSection>
  );
  // Both answers are hypothetical; choosing the tab is what starts the project plan read.
  const renderSimulation = () => (
    <>
      <QuestionSection
        first
        data="what-if"
        title={t("What if all traffic went through one subscription?", "Co gdyby cały ruch szedł przez jedną subskrypcję?")}
        help={
          <EstimateTag title={t("Hypothetical conversion: what if all project traffic went only through this subscription. The denominator is window capacity, not price.", "Hipotetyczne przeliczenie: co gdyby cały ruch tego projektu szedł wyłącznie przez ten jeden abonament. Mianownikiem jest pojemność okna, nie cena.")}>
            {t("hypothetical", "hipotetycznie")}
          </EstimateTag>
        }
      >
        {isCostFailed ? (
          <div style={{ fontSize: "var(--fs-3)", color: "var(--warn)" }}>{t("Could not load cost", "nie udało się pobrać kosztu")}</div>
        ) : isCostPending ? (
          <div style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>{t("loading…", "wczytuję…")}</div>
        ) : apiUsd == null ? (
          <div style={{ fontSize: "var(--fs-3)", color: "var(--faint)" }}>{t("no API catalog price for this range", "brak wyceny cennikiem API dla tego zakresu")}</div>
        ) : (
          <WhatIfTable rows={whatIfRows} rangeDays={rangeDays} />
        )}
      </QuestionSection>
      {subject.kind === "project" && <QuestionSection
        data="plan"
        title={t("Plan simulation", "Symulacja planu")}
        help={
          <EstimateTag title={t("The simulation reads the whole project, not the dates selected in this drawer.", "Symulacja czyta cały projekt, nie daty wybrane w tej szufladzie.")}>
            {t("whole project", "cały projekt")}
          </EstimateTag>
        }
      >
        <ProjectPlanPanel initialProject={`p:${subject.id}`} />
      </QuestionSection>}
    </>
  );
  const tabs: DetailTab[] = [
    { key: "summary", label: t("Summary", "Podsumowanie"), render: renderSummary },
    { key: "timeline", label: t("Timeline", "Przebieg"), render: renderTimeline },
    { key: "cost", label: t("Cost and subscriptions", "Koszt i abonamenty"), render: renderCost },
    { key: "simulation", label: t("Plan simulation", "Symulacja planu"), render: renderSimulation },
  ];
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 30,
        background: "color-mix(in oklab, var(--bg) 72%, transparent)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1120px, 100vw)",
          height: "100%",
          background: "var(--surface)",
          border: "1px solid var(--pencil)",
          borderRight: 0,
          borderRadius: "var(--r-card)",
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          boxShadow: "var(--shadow)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "var(--s-9) var(--s-10) var(--s-8)",
            borderBottom: "1px solid var(--pencil)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Eyebrow>{subject.kind === "project" ? t("project", "projekt") : t("repository", "repozytorium")}</Eyebrow>
            <div className="ui-display" style={{ fontSize: "var(--fs-card-title)", lineHeight: 1.2, marginTop: "var(--s-1)", wordBreak: "break-word" }}>
              {subject.name}
            </div>
            {subject.kind === "project" && subject.repos.length > 1 && (
              <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: 2 }}>
                {t("combines", "scala")} {subject.repos.length} {localizedPlural(subject.repos.length, "repository", "repositories", "katalog", "katalogi", "katalogów")}: {subject.repos.join(", ")}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="hovertext"
            aria-label={t("Close drawer", "Zamknij drawer")}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--faint)",
              fontSize: "var(--fs-7)",
              cursor: "pointer",
              lineHeight: 1,
              padding: "2px 4px",
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: "0 var(--s-10) var(--s-12)", display: "flex", flexDirection: "column", minWidth: 0 }}>
          <DetailTabs label={t("Project details", "Szczegóły projektu")} active={tab} onChange={chooseTab} groups={[{ tabs }]} />
        </div>
      </aside>
    </div>
  );
}
