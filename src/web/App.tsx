import { ContextReportScreen } from "./lib/use-context-companion";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "./screen-styles";
import {
  api,
  refreshApiData,
  refreshLiveApiData,
  readingsRevisionDecision,
  syncRevisionDecision,
  syncRunChanged,
  type SyncStatus,
  type UsageSeries,
  type VendorId,
  type WindowsResponse,
} from "./lib/api";
import { withoutBucket } from "../projects/bucket";
import { SYNC_ACTIVITY_HEIGHT, startupWriteActive } from "./components/SyncActivity";
import { StatusBar } from "./components/StatusBar";
import { buildModel, emptyModel, type CycleView } from "./lib/cycle";
import { railWithContextPreview, rosterWithContextPreview, seriesWithContextPreview } from "./lib/window-context-preview";
import { browserSafeDiagnostic } from "./lib/browserDiagnostic";
import { railWindowsFromCycles, type RailWindow } from "./lib/windows";
import { comparedCycles, toggleCompared } from "./lib/window-archive";
import { ALL_ACCOUNT, buildAllCard, buildRoster, providerColor, subscriptionName, selectedAccountId, preferredAccountOrder } from "./lib/roster";
import { subscriptionPlan } from "./lib/subscription-plan";
import { usePlanCatalog } from "./lib/use-plan-catalog";
import { cyclePlanDescription } from "./lib/codex-window-stats";
import type { DataSettingsTarget } from "./lib/data-settings";
import { cycleEventsTarget, type EventsTarget } from "./lib/events-filter";
import { useAsync } from "./lib/useAsync";
import { useRebuildStatus } from "./lib/useRebuildStatus";
import { AnalysisActivity } from "./components/AnalysisActivity";
import { LoadingScope } from "./components/LoadingStatus";
import {
  allAccountsTarget,
  navLocation,
  screenTitle,
  screenAvailability,
  shouldReadWindowRail,
  type ScreenId,
  type ScreenProps,
  type Unit,
} from "./lib/screens";
import { dayTime, duration } from "./lib/format";
import { NAV_W, NAV_W_COLLAPSED, SUBS_RAIL_COMPACT_W, SUBS_RAIL_W, WINDOW_RAIL_W, useBreakpoint, useRailMode, useWindowRailRoom } from "./lib/useBreakpoint";
import { AppHeader } from "./components/AppHeader";
import { contextPreviewAppliesTo, useContextPreview } from "./lib/context-premium";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { CycleDrawer } from "./components/CycleDrawer";
import { WindowRail } from "./components/CycleRail";
import { planText } from "./lib/no-plan";
import { EmptyState, ErrorState, Field, GhostButton, Picker, Selector, Tabs, type PickerOption } from "./components/ui";
import { AccountPeriodDrawer } from "./components/AccountPeriodDrawer";
import { AccountPeriodsSettings } from "./components/AccountPeriodsSettings";
import { SubscriptionCards, SubscriptionRail } from "./components/SubscriptionCards";
import { WindowInsightCard } from "./components/WindowInsightCard";
import { Overview } from "./screens/Overview";
import { Usage } from "./screens/deferred";
import { Portfolio } from "./screens/Portfolio";
import { LimitWindowLanes } from "./screens/LimitWindowLanes";
import { GeminiOverview } from "./screens/GeminiOverview";
import { GrokOverview } from "./screens/GrokOverview";
import { GlmOverview } from "./screens/GlmOverview";
import { ClaudeOverview } from "./screens/ClaudeOverview";
import { History } from "./screens/deferred";
import { Compare } from "./screens/deferred";
import { Insights } from "./screens/deferred";
import { isInsightsScreen } from "./lib/screens";
import { Models } from "./screens/deferred";
import { Speed } from "./screens/deferred";
import { Capacity } from "./screens/deferred";
import { Events } from "./screens/deferred";
import { Sources } from "./screens/deferred";
import { Settings } from "./screens/deferred";
import { WindowHistory } from "./screens/deferred";
import { WindowCompare } from "./screens/deferred";
import { AllAggregate } from "./screens/deferred";
import { Projects } from "./screens/deferred";
import { UsageActivity, Value } from "./screens/deferred";
import { ContextBar, PageTabs } from "./components/PageNavigation";
import { FirstRun } from "./screens/FirstRun";
import { useI18n } from "./lib/i18n";
import { readRefreshDecision, type ReadRefreshCheck } from "../shared/read-refresh";
const THEME_KEY = "tokenatlas.theme";
const VENDOR_GROUP_NAMES: Readonly<Record<string, string>> = { codex: "Codex", openai: "Codex", claude: "Claude", anthropic: "Claude", gemini: "Gemini", grok: "Grok", glm: "GLM", opencode: "OpenCode" };
/** The vendor heading a subscription is listed under in the subscription picker. */
function vendorGroupName(group: string): string {
  return VENDOR_GROUP_NAMES[group.toLowerCase()] ?? group;
}
const HEADER_H = 52;
function readTheme(): "dark" | "light" {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
  }
  return "light";
}
// Usage's other views read all subscriptions in calendar time, like Usage itself (IA-41).
const ACCOUNT_FREE_SCREENS = new Set<ScreenId>(["projects", "sources", "data-problems", "data-operations", "events", "settings", "usage",
  "usage-history", "usage-pace", "structure", "structure-models", "activity"]);
/** Views read independently of the shell's cycle history and do not wait for it. */
const INDEPENDENT_SCREENS = new Set<ScreenId>(["capacity", "sources", "data-problems", "data-operations", "speed", "models", "model-traffic", "model-cost", "periods", "plans", "shares"]);
/** Account-scoped views whose scope line shows the shell's counter (IA-42). Models pages name it in their own Counter control. */
const COUNTER_SCREENS = new Set<ScreenId>(["overview", "history", "compare", "analytics", "patterns"]);
function RailSkeleton({ width, rows, rowHeight }: { width: number; rows: number; rowHeight: number }) {
  return (
    <aside
      aria-busy="true"
      style={{
        width,
        flex: `0 0 ${width}px`,
        background: "var(--surface)",
        borderRight: "1px solid var(--line)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        overflow: "hidden",
      }}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{ height: rowHeight, borderRadius: "var(--r-card)", opacity: Math.max(0.15, 1 - i * 0.14) }}
        />
      ))}
    </aside>
  );
}
export function seriesRailFacts(series: {
  latest?: { ts?: string | null; age_hours?: number | null } | null;
  stats?: { total_calls?: number | null } | null;
} | null | undefined): { lastSync: string | null; calls: number | null; live: boolean } {
  return {
    lastSync: series?.latest?.ts ?? null,
    calls: series?.stats?.total_calls ?? null,
    live: (series?.latest?.age_hours ?? 999) < 6,
  };
}

export function shouldRenderLegacyCycleDetail(
  screen: ScreenId,
  gaugeScreenAvailable: boolean,
  seriesless: boolean
): boolean {
  return gaugeScreenAvailable && !seriesless && (screen === "history" || screen === "compare");
}

export function overviewCycleSubtitle(cycle: CycleView, t: (en: string, pl: string) => string): string {
  const status = cycle.isActive ? t("current", "bieżące") : t("closed", "zamknięte");
  const plan = cyclePlanDescription(cycle);
  const endIso = cycle.isActive ? cycle.resetIso ?? cycle.endIso : cycle.raw.work_to_ts || cycle.endIso;
  return `${cycle.label} · ${status}${plan ? ` · ${plan}` : ""} · ${dayTime(cycle.startIso)} → ${cycle.isActive ? "~" : ""}${dayTime(endIso)} · ${cycle.elapsedPercent.toFixed(0)}% ${t("of the cycle elapsed", "czasu minęło")}`;
}

export function RemapFailureBadge({ logTail }: { logTail: string[] }) {
  const { t } = useI18n();
  return (
    <span
      className="mono"
      style={{ fontSize: 10, color: "var(--crit)" }}
      title={browserSafeDiagnostic(logTail.join("\n"))}
    >
      {t("remap error", "błąd przemapowania")}
    </span>
  );
}
export function App() {
  useAsync(() => api.plansCatalog(), [], true);
  usePlanCatalog();
  const { language, t } = useI18n();
  const [screen, setScreen] = useState<ScreenId>("overview");
  const [theme, setTheme] = useState<"dark" | "light">(readTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const [drawerCycle, setDrawerCycle] = useState<number | null>(null);
  const [requestedAccount, setAccount] = useState("codex1");
  const [dataSettings, setDataSettings] = useState<DataSettingsTarget | null>(null);
  const [eventsTarget, setEventsTarget] = useState<EventsTarget | null>(null);
  const [periodsOpen, setPeriodsOpen] = useState(false);
  const periodsOpener = useRef<HTMLElement | null>(null);
  const [project, setProject] = useState("");
  const [windowMinutes, setWindowMinutes] = useState("10080");
  const [unit, setUnit] = useState<Unit>("percent");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedRailKey, setSelectedRailKey] = useState<string | null>(null);
  const [compare, setCompare] = useState<number[]>([]);
  const [mobileNav, setMobileNav] = useState(false);
  const unitOptions = useMemo(
    () => [
      { value: "percent", label: "%" },
      { value: "tokens", label: t("tokens", "tokeny") },
      { value: "usd", label: "$" },
    ],
    [language, t],
  );
  const windowOptions = useMemo(
    () => [
      { value: "10080", label: t("Weekly window", "Okno tygodniowe") },
      { value: "300", label: t("5h window", "Okno 5 h") },
      { value: "43200", label: t("Monthly window", "Okno miesięczne") },
    ],
    [language, t],
  );
  const bp = useBreakpoint();
  const railMode = useRailMode();
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
    }
  }, [theme]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
      }
      if (e.key === "Escape") {
        setPalette(false);
        setDrawerCycle(null);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const accountsState = useAsync(() => api.accounts(), []);
  const projectsState = useAsync(() => api.projects(), []);
  const setupState = useAsync(() => api.setupStatus(), []);
  const needsSetup = setupState.data != null && (!setupState.data.configured || setupState.data.locations_confirmed === false);
  const rosterState = useAsync(() => api.roster({ window: Number(windowMinutes) }), [windowMinutes], true);
  const contextPreview = useContextPreview();
  const rosterCards = useMemo(() => {
    if (!rosterState.data) return [];
    const cards = buildRoster(rosterWithContextPreview(rosterState.data, contextPreview));
    // The portfolio row exists once there are two LIVE subscriptions to compare;
    // an archive of closed ones never conjures one, and never lands inside it.
    return cards.filter((c) => c.active).length >= 2 ? [buildAllCard(cards), ...cards] : cards;
  }, [language, rosterState.data, contextPreview]);
  const activeRosterCards = useMemo(() => rosterCards.filter((c) => c.active), [rosterCards]);
  const accountsList = accountsState.data?.subscriptions ?? [];
  const rosterIds = useMemo(() => new Set(rosterState.data?.accounts.map(entry => entry.id) ?? []), [rosterState.data]);
  const account = selectedAccountId(requestedAccount, preferredAccountOrder(accountsList, rosterIds));
  const isAll = account === ALL_ACCOUNT;
  const activeRosterAccount = rosterState.data?.accounts.find((entry) => entry.id === account) ?? null;
  const accountWindowMinutes = activeRosterAccount?.live?.window_minutes ?? Number(windowMinutes);
  // A prepared Codex history does not depend on the cross-provider roster.
  const indexedCodexAccount = accountsList.some(entry => entry.id === account && entry.has_gauge
    && (!entry.vendor || entry.vendor === "codex" || entry.vendor === "openai")
    && entry.plan !== "self_serve_business_usage_based");
  const accountReady = accountsState.data != null && (isAll ||
    ((activeRosterAccount != null || indexedCodexAccount) && accountsList.some(entry => entry.id === account)));
  const activeCapabilities = activeRosterAccount?.capabilities ?? null;
  const activeGroup = rosterCards.find((c) => c.id === account)?.group ?? null;
  // Account periods know the account, not its billing variant (`codex1::business`).
  const periodsSubject = useMemo(() => {
    const card = rosterCards.find((c) => c.id === account && c.id !== ALL_ACCOUNT);
    if (!card) return null;
    return { provider: card.vendor.toLowerCase(), account: card.id.split("::")[0]!, label: `${card.group} / ${subscriptionName(card)}` };
  }, [rosterCards, account]);
  const isGemini = activeGroup === "gemini";
  const isGrok = activeGroup === "grok";
  const isGlm = activeGroup === "glm";
  const isClaude =
    activeGroup === "claude" ||
    accountsList.some((a) => a.id === account && (a.vendor === "claude" || a.vendor === "anthropic"));
  const creditBilling = accountsList.some(a => a.id === account && a.plan === "self_serve_business_usage_based");
  const seriesless = isAll || creditBilling || (activeCapabilities != null && activeCapabilities.hasGaugeSeries !== true);
  const selectedScreenAvailability = screenAvailability(screen, activeCapabilities);
  const gaugeScreenUnavailable = !isAll && selectedScreenAvailability === false;
  const gaugeScreenAvailable = !isAll && selectedScreenAvailability === true;
  const gaugeScreenUndeclared =
    !isAll && activeCapabilities != null && selectedScreenAvailability == null;
  // 2026-09-27, UI audit approved 2026-09-26, decisions 1 and 7: Analytics and Patterns are one tabbed
  // screen; it explains itself for Claude and Business instead of the generic empty states.
  const insightsScreen = isInsightsScreen(screen);
  const insightsNote = insightsScreen && (isClaude || creditBilling);
  const seriesState = useAsync<UsageSeries | null>(
    signal => (!accountReady || seriesless ? Promise.resolve(null) : api.usageSeries({ account, window: accountWindowMinutes, points: 900 },signal)),
    [account, accountWindowMinutes, seriesless, accountReady], true
  );
  const windowsState = useAsync<WindowsResponse | null>(
    signal => (accountReady && seriesless && !isAll ? api.windows({ account },signal) : Promise.resolve(null)),
    [account, seriesless, isAll, accountReady], true
  );
  useEffect(() => {
    setSelectedRailKey(null);
    setSelectedIndex(null);
    setDrawerCycle(null);
  }, [account, accountWindowMinutes]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncUnavailable, setSyncUnavailable] = useState(false);
  const [syncObservedAt, setSyncObservedAt] = useState<number | null>(null);
  const rebuild = useRebuildStatus();
  const syncPollInFlight = useRef(false);
  const observedRevision = useRef<string | undefined>(undefined);
  const observedBusy = useRef(false);
  const observedIdentity = useRef<number | undefined>(undefined);
  const observedReadings = useRef<number | undefined>(undefined);
  const observedReadChanges = useRef<ReadRefreshCheck | undefined>(undefined);
  const syncRunning = sync?.running === true;
  const remapRunning = sync?.remap?.running === true;
  const startupWriting = startupWriteActive(sync?.bootstrap);
  const syncBusy = syncRunning || remapRunning || startupWriting;
  const observeSync = useCallback((next: SyncStatus) => {
    const busy = next.running || next.remap?.running === true;
    if (busy) observedBusy.current = true;
    const decision = syncRevisionDecision(observedRevision.current, next);
    const changedDuringObservedRun =
      !busy && observedRevision.current === undefined && observedBusy.current && syncRunChanged(next);
    observedRevision.current = decision.revision;
    if (!busy) observedBusy.current = false;
    const identityChanged = observedIdentity.current !== undefined && next.identity_revision !== observedIdentity.current;
    observedIdentity.current = next.identity_revision;
    const readings = readingsRevisionDecision(observedReadings.current, next);
    observedReadings.current = readings.revision;
    const changes = readRefreshDecision(observedReadChanges.current, next.read_changes);
    if (next.read_changes) observedReadChanges.current = next.read_changes;
    setSync(next);
    setSyncUnavailable(false);
    setSyncObservedAt(Date.now());
    if (decision.refresh || changedDuringObservedRun || identityChanged || changes.changed)
      refreshApiData(identityChanged ? undefined : changes.refresh && { ...changes.refresh, live: readings.refresh });
    else if (readings.refresh) refreshLiveApiData();
  }, []);
  useEffect(() => {
    let active = true;
    let syncRequest: AbortController | null = null;
    const poll = () => {
      // Preserve the guard when a busy-state change replaces this interval.
      if (syncPollInFlight.current) return;
      syncPollInFlight.current = true;
      const controller = new AbortController();
      syncRequest = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      api
        .syncStatus(controller.signal, observedReadChanges.current?.cursor)
        .then((next) => {
          if (active) observeSync(next);
        })
        .catch(() => { if (active) setSyncUnavailable(true); })
        .finally(() => { clearTimeout(timeout); syncRequest = null; syncPollInFlight.current = false; });
    };
    poll();
    const t = setInterval(poll, syncBusy ? 2_000 : 10_000);
    return () => {
      active = false;
      clearInterval(t);
      syncRequest?.abort();
    };
  }, [observeSync, syncBusy]);
  const triggerSync = useCallback((mode: "incremental" | "full" = "incremental", vendor?: VendorId) => {
    api.syncStart(mode, vendor).then(observeSync).catch(() => {});
  }, [observeSync]);
  const live = useMemo(() => {
    const row = rosterState.data?.accounts.find((a) => a.id === account)?.live ?? null;
    return row;
  }, [rosterState.data, account]);
  const scopedSeries = useMemo(() => seriesState.data?.account === account
    && seriesState.data.window_minutes === accountWindowMinutes ? seriesWithContextPreview(seriesState.data, contextPreview) : null,
    [seriesState.data, account, accountWindowMinutes, contextPreview]);
  const model = useMemo(
    () =>
      scopedSeries
        ? buildModel(scopedSeries, live)
        : seriesless
          ? emptyModel(account, accountWindowMinutes)
          : null,
    [language, scopedSeries, live, seriesless, account, accountWindowMinutes]
  );
  const railWindows = useMemo(
    () =>
      scopedSeries && model
        ? railWindowsFromCycles(
            model.cycles,
            scopedSeries.points,
            scopedSeries.activity ?? [],
            scopedSeries.traffic ?? []
          )
        : railWithContextPreview(windowsState.data?.windows ?? [], contextPreview),
    [language, scopedSeries, model, windowsState.data, contextPreview]
  );
  const legacyCycleDetail = shouldRenderLegacyCycleDetail(screen, gaugeScreenAvailable, seriesless);
  const windowHistory = !isAll && screen === "history" && railWindows.length > 0;
  // One comparison per account: cycles compare in Compare, windows without a cycle series here.
  const windowCompare = !isAll && screen === "compare" && railWindows.length > 0 && !legacyCycleDetail;
  const genericWindowScreen = windowHistory || windowCompare;
  const awaitingCapabilities = !isAll && activeCapabilities==null && selectedScreenAvailability==null && !genericWindowScreen;
  const isAllNow = useRef(isAll);
  isAllNow.current = isAll;
  const openView = useCallback((s: ScreenId) => {
    if (s === "settings") setDataSettings(null);
    if (s === "events") setEventsTarget(null);
    setScreen(s);
    setPalette(false);
    setMobileNav(false);
  }, []);
  // Existing links and the palette name old screens; for all subscriptions they keep their meaning (02, old targets).
  const goto = useCallback((s: ScreenId) => openView(isAllNow.current ? allAccountsTarget(s) : s), [openView]);
  const openEvents = useCallback((target: EventsTarget) => {
    setEventsTarget(target);
    setScreen("events");
    setPalette(false);
    setMobileNav(false);
  }, []);
  const openDataSettings = useCallback((target: DataSettingsTarget) => {
    setDataSettings({ ...target, returnScreen: screen === "models" || screen === "model-traffic" || screen === "model-cost" || screen === "periods" ? screen : "capacity" });
    setAccount(target.account);
    setScreen("settings");
    setPalette(false);
    setMobileNav(false);
  }, [screen]);
  const returnFromSettings = useCallback(() => {
    refreshApiData();
    setScreen(dataSettings?.returnScreen ?? "capacity");
    setPalette(false);
    setMobileNav(false);
  }, [dataSettings?.returnScreen]);
  const selectCycle = useCallback(
    (index: number) => {
      setSelectedIndex(index);
      setScreen("overview");
    },
    []
  );
  const chosen = useMemo(
    () => (model && selectedIndex != null ? model.cycles.find((c) => c.index === selectedIndex) ?? null : null),
    [model, selectedIndex]
  );
  const drawer = useMemo(
    () => (model && drawerCycle != null ? model.cycles.find((c) => c.index === drawerCycle) ?? null : null),
    [model, drawerCycle]
  );
  const accounts = accountsList;
  const isMobile = bp === "mobile";
  const bootstrapping = rosterState.loading && !rosterState.data;
  const accountFree = ACCOUNT_FREE_SCREENS.has(screen);
  const showRail = !accountFree && railMode !== "none" && (rosterCards.length > 0 || bootstrapping);
  const compactRail = railMode === "compact";
  const subsWidth = showRail ? (compactRail ? SUBS_RAIL_COMPACT_W : SUBS_RAIL_W) : 0;
  const roomWithNavOpen = useWindowRailRoom(NAV_W, subsWidth);
  const roomWithNavShut = useWindowRailRoom(NAV_W_COLLAPSED, subsWidth);
  const windowRailRead = shouldReadWindowRail(screen);
  const hasWindows =
    windowRailRead && !accountFree && !isAll && (railWindows.length > 0 || seriesless || model != null || bootstrapping);
  const autoCollapse = !isMobile && hasWindows && !roomWithNavOpen && roomWithNavShut;
  const railCollapsed = bp === "tablet" ? true : collapsed || autoCollapse;
  // The status bar is permanent, so the content never shifts when work starts or ends.
  const shellHeaderHeight = HEADER_H + SYNC_ACTIVITY_HEIGHT;
  // The page tabs pin right under the sticky screen head, whose height follows its wrapping controls.
  const screenHeadRef = useRef<HTMLDivElement>(null);
  const [screenHeadHeight, setScreenHeadHeight] = useState(0);
  // A report's own tab row pins below both (`--report-sticky-top`, read by SubscriptionStats.css).
  const [pageTabsHeight, setPageTabsHeight] = useState(0);
  useEffect(() => {
    const head = screenHeadRef.current;
    if (!head || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScreenHeadHeight(head.offsetHeight));
    observer.observe(head);
    return () => observer.disconnect();
  }, []);
  const navWidth = isMobile ? 0 : railCollapsed ? NAV_W_COLLAPSED : NAV_W;
  const windowRailRoom = railCollapsed ? roomWithNavShut : roomWithNavOpen;
  const showWindowRail = !isMobile && windowRailRoom && hasWindows;
  const railActiveIndex = chosen?.index ?? model?.current?.index ?? null;
  const railActiveKey = seriesless
    ? selectedRailKey ?? railWindows.find((window) => window.isCurrent)?.key ?? railWindows[0]?.key ?? null
    : railActiveIndex == null ? null : String(railActiveIndex);
  // Codex's and Claude's Overviews show their counters in their own status block.
  const overviewWindowStatus = !isGemini && !isGrok && !isGlm && (isClaude || !seriesless);
  const selectedInsightKey = !isAll
    ? seriesless
      ? selectedRailKey
      : chosen?.index != null
        ? String(chosen.index)
        : null
    : null;
  const selectedInsightEndIso = !isAll && chosen
    ? (chosen.isActive ? chosen.resetIso ?? chosen.endIso : chosen.raw.work_to_ts || chosen.endIso)
    : null;
  const selectedRailWindow = seriesless && selectedRailKey != null
    ? railWindows.find((window) => window.key === selectedRailKey) ?? null
    : null;
  // A closed window or counter segment is reported for exactly its bounds; the live window stays "now".
  const vendorOverviewBounds = selectedRailWindow && !selectedRailWindow.isCurrent
    && selectedRailWindow.startIso && selectedRailWindow.resetIso
    ? { from: selectedRailWindow.startIso, until: selectedRailWindow.resetIso } : null;
  const analysisRange = dataSettings?.account === account && dataSettings.since && dataSettings.until
    ? dataSettings.returnRange ?? { since: dataSettings.since, until: dataSettings.until }
    : undefined;
  const selectRailWindow = useCallback((window: RailWindow) => {
    if (window.source === "cycle") {
      const index = Number(window.key);
      if (!Number.isFinite(index)) return;
      // On Compare the rail and the window chips are one selection; the current window is always in it.
      if (screen === "compare" && model) {
        if (index !== model.current?.index) setCompare(toggleCompared(comparedCycles(model.cycles, compare), index));
        return;
      }
      setSelectedIndex(index);
      return;
    }
    setSelectedRailKey(window.key);
  }, [screen, model, compare]);
  const openRailInfo = useCallback((window: RailWindow) => {
    if (window.source !== "cycle") return;
    const index = Number(window.key);
    if (Number.isFinite(index)) setDrawerCycle(index);
  }, []);
  // Independently prepared screens must not wait for the shell's cycle history.
  const screenProps: ScreenProps | null = model || accountFree || INDEPENDENT_SCREENS.has(screen)
    ? {
        model: model ?? emptyModel(account, accountWindowMinutes),
        unit,
        setUnit,
        account,
        selectAccount: setAccount,
        accounts,
        capabilities: activeCapabilities,
        card: rosterCards.find((c) => c.id === account) ?? null,
        project,
        setProject,
        projects: projectsState.data?.projects ?? [],
        chosen,
        selectCycle,
        openDrawer: setDrawerCycle,
        windowRailInShell: showWindowRail,
        goto,
        compare,
        setCompare,
        sync,
        triggerSync,
        dataSettings,
        openDataSettings,
        returnFromSettings,
        analysisRange,
        openEvents,
        eventsTarget,
      }
    : null;
  const current = model?.current ?? null;
  const valueScreen = navLocation(screen).section.id === "value";
  const section = navLocation(screen).section.id;
  const projectUnused = screen === "overview" || screen === "speed" || valueScreen;
  const windowUnused = screen === "capacity" || screen === "speed" || valueScreen;
  const windowUnusedTitle = !windowUnused ? undefined : screen === "capacity"
    ? t("Capacity has its own counter and unit below", "Pojemność ma własny licznik i jednostkę poniżej")
    : t("Not used on this screen", "Nieużywane na tym ekranie");
  // Limit windows and their views read one subscription's counter; all subscriptions are read in Usage (IA-04).
  const limitsForAll = isAll && navLocation(screen).tab.id === "windows";
  const counterName = windowOptions.find(option => option.value === String(accountWindowMinutes))?.label.split(" · ")[0];
  // The capacity battle and the saved comparisons span several subscriptions, so they name no single one.
  const scopeParts = accountFree || section === "data" || section === "settings" || screen === "plans" || screen === "shares" ? [] : [
    ...(isAll ? [t("All subscriptions", "Wszystkie subskrypcje")] : []),
    ...(COUNTER_SCREENS.has(screen) && !isAll && counterName ? [counterName] : []),
    ...(screen === "overview" && !isAll && (chosen ?? current) ? [`${(chosen ?? current)!.label} · ${(chosen ?? current)!.isActive ? t("current", "bieżące") : t("closed", "zamknięte")}`] : []),
  ];
  const scopeHelp = screen === "overview" && !isAll && (chosen ?? current) ? overviewCycleSubtitle((chosen ?? current)!, t) : undefined;
  // "Compare windows" opens Limit windows in Compare mode with the selected window marked (01 OV).
  const compareWindows = screen === "overview" && !isAll && railWindows.length > 1 ? (
    <GhostButton onClick={() => {
      if (chosen && model && chosen.index !== model.current?.index) setCompare(toggleCompared(comparedCycles(model.cycles, []), chosen.index));
      openView("compare");
    }}>{t("Compare windows", "Porównaj okna")}</GhostButton>
  ) : undefined;
  const sub = (() => {
    if (screen === "settings") return t("Accounts, computers and data, price lists", "Konta, komputery i dane, cenniki");
    if (screen === "usage") return t("All sources · historical subscriptions, accounts and models · UTC dates", "Wszystkie źródła · historyczne subskrypcje, konta i modele · daty UTC");
    if (screen === "capacity") return t("Per-1% conversions, estimated full allowance and deviation from comparable cycles", "Przeliczniki 1%, szacowana pełna pojemność i odchylenie od porównywalnych cykli");
    if (screen === "periods") return t("Actual billing cycles, their prices and use", "Rzeczywiste okresy rozliczeniowe, ich ceny i wykorzystanie");
    if (screen === "plans" || screen === "shares") return t("Measured and converted plan variants", "Zmierzone i przeliczone warianty planów");
    if (screen === "usage-history" || screen === "usage-pace" || screen === "structure" || screen === "structure-models" || screen === "activity")
      return t("All subscriptions · calendar time · UTC dates", "Wszystkie subskrypcje · czas kalendarzowy · daty UTC");
    if (!model) return t("Loading…", "Wczytywanie…");
    switch (screen) {
      case "overview":
        if (isAll)
          return t(
            "{0} active subscriptions on a shared scale · percentages are averaged, dollars are summed",
            `${activeRosterCards.length - 1} aktywnych subskrypcji zestawionych na wspólnej skali · procenty są średnią, dolary sumą`, [activeRosterCards.length - 1],
          );
        // The account is in the subscription picker; the subtitle keeps only what no control above says.
        if (isGemini)
          return t(
            "Antigravity pool · limit counter + tokens reconstructed from protobuf (conversation-level timing)",
            "pula Antigravity · licznik limitu + tokeny odtworzone z protobufu (czas z rozdzielczością rozmowy)",
          );
        if (isGrok) {
          const cal = rosterCards.find((c) => c.id === account)?.grok?.limit?.calibration ?? null;
          return cal
            ? t(
                "xAI · percentage CALCULATED from a ${0}/point scale (grok-gauge.json) - the vendor does not publish a counter",
                `xAI · procent WYLICZONY ze skali $${cal.usd_per_point.toFixed(2)}/pkt (grok-gauge.json) — vendor nie publikuje licznika`, [cal.usd_per_point.toFixed(2)],
              )
            : t(
                "xAI · full tokens and vendor pricing, but NO limit counter",
                "xAI · pełne tokeny i własna wycena vendora, ale ŻADNEGO licznika limitu",
              );
        }
        if (isGlm) {
          const gl = rosterCards.find((c) => c.id === account)?.glm ?? null;
          const hw = gl?.windows.find((w) => w.kind === gl.headline_kind) ?? gl?.windows[0] ?? null;
          return hw
            ? t(
                "{0} plan · {1} of {2} credits in the {3} window - read from the account, both values",
                `plan ${gl?.level ?? "coding"} · ${hw.used} z ${hw.allowance ?? "?"} kredytów okna ${hw.label} — ODCZYT z konta, obie liczby`, [gl?.level ?? "coding", hw.used, hw.allowance ?? "?", hw.label],
              )
            : t("z.ai coding plan · no counter reading", "plan z.ai coding · brak odczytu licznika");
        }
        // Claude and Codex: window, state, plan, dates and the reading's basis are all in the picker, the context
        // line and the window header (user, 2026-10-23); the full cycle line stays in the context line's help.
        if (isClaude) return null;
        return chosen ?? current ? null : t("no active cycle in this window", "brak aktywnego cyklu w tym oknie");
      case "history":
        if (isAll) return t("Workspace history - how usage grew across all subscriptions", "Historia stanowiska — jak zużycie rosło w poprzek wszystkich subskrypcji");
        if (model.cycles.length > 0) {
          return `${model.cycles.length} ${t("cycles", "cykli")} · ${t("account", "konto")} ${account} · ${t("window", "okno")} ${duration(model.cycles[0]!.windowHours)}`;
        }
        {
          // Accounts without registered cycles (Claude) show their limit windows instead.
          const main = railWindows.filter((w) => w.scope == null && w.windowHours != null);
          const lengths = [...new Set(main.map((w) => w.windowHours!))].sort((a, b) => a - b).map(duration);
          return `${main.length} ${t("windows", "okien")} · ${t("account", "konto")} ${account}${lengths.length ? ` · ${lengths.join(" / ")}` : ""}`;
        }
      case "compare":
        if (isAll) return t("Subscription by subscription - which uses how much and how it works", "Subskrypcja przy subskrypcji — która ile zjada i jak pracuje");
        if (legacyCycleDetail) return t("Usage since each window's start, in hours, at the same moment as now", "Zużycie od startu każdego okna, w godzinach, w tym samym momencie co teraz");
        return t("The same moments of windows with the same plan", "Te same momenty okien z tym samym planem");
      case "analytics":
        if (isAll) return t("Workspace pace - period average, peak, change from the previous period", "Tempo stanowiska — średnia na okres, szczyt, zmiana wobec poprzedniego");
        return t("Usage per window and the estimated full allowance", "Zużycie na okno i szacowany pełny limit");
      case "patterns":
        if (isAll) return t("When the workspace works - hours of the week across all subscriptions", "Kiedy pracuje stanowisko — godziny tygodnia, wszystkie subskrypcje");
        return t("Typical window course, working hours, anomalies", "Typowy przebieg okna, godziny pracy, anomalie");
      case "models":
        if (isAll) return t("Models and surfaces across all subscriptions", "Modele i konteksty użycia w poprzek wszystkich subskrypcji");
        return t("Usage by model and surface", "Zużycie według modeli i kontekstów");
      case "model-traffic":
        return t("Traffic per reset cycle, model appearances and your markers", "Ruch w cyklach resetu, pojawienie się modeli i własne znaczniki");
      case "model-cost":
        return t("What 1M tokens of each model cost at API prices, against its list prices", "Ile kosztuje 1M tokenów każdego modelu po cenach API, na tle jego cennika");
      case "speed":
        return t("Output tokens per second per model · from sending the request to the end of the response · ratio of sums, never an average of calls",
          "Tokeny wyjścia na sekundę według modeli · od wysłania żądania do końca odpowiedzi · iloraz sum, nigdy średnia wywołań");
      case "events":
        return t("Individual API calls - the bottom of the drill-down, paginated", "Pojedyncze wywołania API — najniższy poziom szczegółów, stronicowane");
      case "sources":
      case "data-problems":
      case "data-operations":
        return t("Synchronization per provider, data age and checks", "Synchronizacja dostawców, wiek danych i kontrole");
    }
  })();
  const rail = (
    <Sidebar
      screen={screen}
      goto={openView}
      collapsed={isMobile ? false : railCollapsed}
      onToggleCollapse={() => (isMobile ? setMobileNav(false) : setCollapsed((c) => !c))}
      headerHeight={0}
      status={{
        cycleBadge: (chosen ?? current)?.label,
        cycleCount: isAll ? undefined : model?.cycles.length,
        ...seriesRailFacts(scopedSeries),
      }}
    />
  );
  if (needsSetup) return <FirstRun onDone={() => setupState.reload()} />;
  return (
    <ContextReportScreen.Provider value={screen}>
    <div className="shell">
      {!isMobile && rail}
      <div className="shell-column">
      <AppHeader
        contextPreviewApplies={contextPreviewAppliesTo(screen)}
        account={account}
        accounts={accounts}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onOpenPalette={() => setPalette(true)}
        goto={goto}
        onMobileNav={isMobile ? () => setMobileNav(true) : undefined}
        compact={isMobile}
      />
      <StatusBar sync={sync} syncUnavailable={syncUnavailable} syncObservedAt={syncObservedAt} rebuild={rebuild}
        waitingForSubscriptions={bootstrapping} stickyTop={HEADER_H} compact={isMobile} onOpenSettings={() => goto("settings")}
        onOpenAccount={id => { setAccount(accountsList.find(entry => entry.id.toLowerCase() === id)?.id ?? id); goto("overview"); }} />

      <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
        {showRail &&
          (rosterCards.length > 0 ? (
            <SubscriptionRail cards={rosterCards} selected={account} onSelect={setAccount} headerHeight={shellHeaderHeight} width={subsWidth} compact={compactRail} />
          ) : (
            <RailSkeleton width={subsWidth} rows={5} rowHeight={62} />
          ))}
        {showWindowRail && !model && <RailSkeleton width={WINDOW_RAIL_W} rows={7} rowHeight={40} />}
        {showWindowRail && model && (
          <WindowRail
            windows={railWindows}
            pointBasis={rosterCards.find(c => c.id === account)?.pointBasis ?? null}
            activeKey={railActiveKey}
            cycleDetails={!seriesless ? { cycles: model.cycles, points: model.series.points } : undefined}
            medianPercent={model.median.peakPercent}
            medianTokens={model.median.tokens}
            onSelect={selectRailWindow}
            onInfo={openRailInfo}
            headerHeight={shellHeaderHeight}
          />
        )}
        {isMobile && mobileNav && (
          <div
            onClick={() => setMobileNav(false)}
            style={{ position: "fixed", inset: 0, zIndex: 35, background: "color-mix(in oklab, var(--text) 35%, transparent)", display: "flex" }}
          >
            <div onClick={(e) => e.stopPropagation()} style={{ boxShadow: "var(--shadow)" }}>
              {rail}
            </div>
          </div>
        )}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--surface)",
        "--report-sticky-top": `${shellHeaderHeight + screenHeadHeight + pageTabsHeight}px` } as CSSProperties}>
        <div className="screen-head" ref={screenHeadRef} style={{ top: shellHeaderHeight }}>
          <div className="screen-head-title">
            <h1>{screenTitle(screen, language)}</h1>
            {sub && <div className="mono">{sub}</div>}
          </div>
          <div className="screen-head-controls">
            {screen !== "settings" && section !== "data" && (screen === "events" || section !== "usage") && <>
            <Picker
              label={t("subscription", "subskrypcja")}
              ariaLabel={t("Subscription", "Subskrypcja")}
              mutedLabel={t("inactive", "nieaktywne")}
              value={account}
              onChange={setAccount}
              options={
                rosterCards.length > 0
                  ? rosterCards.map((c): PickerOption => (c.id === ALL_ACCOUNT
                      ? { value: c.id, title: t("All subscriptions", "Wszystkie subskrypcje") }
                      : { value: c.id, title: subscriptionName(c), group: vendorGroupName(c.group), groupColor: providerColor(c.vendor),
                          tag: planText(subscriptionPlan(c.vendor, c.plan) ?? c.plan), muted: !c.active }))
                    .concat([...new Map(accounts.filter(a => a.has_events && !rosterCards.some(c => c.id === a.id)).map(a => [a.id, a])).values()].map(a => ({
                      value: a.id, title: a.declared_account || a.label || a.id, group: vendorGroupName(a.vendor ?? ""), groupColor: providerColor(a.vendor),
                      tag: a.plan === "self_serve_business_usage_based" ? "Business credits" : null,
                    })))
                  : [...new Map(accounts.map(a => [a.id, a])).values()].map((a) => ({
                      value: a.id, title: a.declared_account || a.label || a.id, group: vendorGroupName(a.vendor ?? ""), groupColor: providerColor(a.vendor),
                      tag: a.has_gauge ? subscriptionPlan(a.vendor ?? "", a.plan) : `${a.plan ? `${subscriptionPlan(a.vendor ?? "", a.plan)} · ` : ""}${t("no gauge", "brak gauge")}`,
                    }))
              }
            />
            {periodsSubject && <GhostButton
              onClick={() => {
                periodsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                setPeriodsOpen(true);
              }}
              title={t("Who was signed in where and which plan this account had, as dated periods", "Kto był zalogowany gdzie i jaki plan miało to konto — datowane okresy")}
            >
              {t("Periods", "Okresy")}
            </GhostButton>}
            {periodsOpen && periodsSubject && <AccountPeriodDrawer busy={false} onClose={() => setPeriodsOpen(false)}
              returnFocus={periodsOpener.current} className="subscription-periods-drawer"
              closeLabel={t("Close account periods", "Zamknij okresy konta")}
              title={t("Account periods", "Okresy kont")} subtitle={periodsSubject.label}>
              <AccountPeriodsSettings provider={periodsSubject.provider} providerAliases={[periodsSubject.provider]} focus={periodsSubject.account} />
            </AccountPeriodDrawer>}
            {/* Speed reads whole subscriptions per model (docs/design/model-speed-mockup.html, approved 2026-10-07). */}
            {/* Report controls keep fixed places: a screen that does not use one disables it instead of removing it. */}
            <Selector
              className="screen-head-project"
              label={t("project", "projekt")}
              strong={project !== "" && !projectUnused}
              disabled={projectUnused}
              title={projectUnused ? (screen === "overview"
                ? t("Overview picks projects above its chart", "Przegląd wybiera projekty nad wykresem")
                : t("Not used on this screen", "Nieużywane na tym ekranie")) : undefined}
              value={project}
              onChange={setProject}
              options={[
                { value: "", label: t("all", "wszystkie") },
                { value: "unassigned", label: t("unassigned", "nieprzypisane") },
                ...withoutBucket(projectsState.data?.projects ?? [])
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            {/* Capacity keeps its own counter and unit switch (UI audit decision 5, approved 2026-09-26); there the
                header's copies are hidden, not disabled, so the screen shows each control once (user, 2026-10-21). */}
            {screen !== "capacity" && <>
            <Selector value={String(accountWindowMinutes)} onChange={setWindowMinutes} options={windowOptions}
              disabled={windowUnused} title={windowUnusedTitle} />
            <Field label={t("unit", "jednostka")} title={windowUnusedTitle}>
              <Tabs value={unit} onChange={(v) => setUnit(v as Unit)}
                options={unitOptions.map(o => ({ ...o, disabled: windowUnused }))} />
            </Field>
            </>}
            </>}
            <GhostButton
              onClick={() => triggerSync("incremental")}
              disabled={syncBusy}
              title={
                remapRunning
                  ? t(
                      "Project remapping is running ({0}) - data will load after it finishes",
                      `Trwa przemapowanie projektów (${browserSafeDiagnostic(sync?.remap?.why ?? "reguły się zmieniły")}) — dane doładują się po zakończeniu`, [browserSafeDiagnostic(sync?.remap?.why ?? "the rules changed")],
                    )
                  : startupWriting
                    ? t("Atlas index startup is writing the local database - synchronization will be available after this stage", "Start indeksu Atlas zapisuje lokalną bazę — synchronizacja będzie dostępna po zakończeniu etapu")
                  : syncRunning
                    ? t("Synchronization is running (started {0})", `Trwa synchronizacja (start ${sync?.started_at ? dayTime(sync.started_at) : "?"})`, [sync?.started_at ? dayTime(sync.started_at) : "?"])
                    : sync?.finished_at
                      ? t(
                          "Last synchronization: {0} · {1}",
                          `Ostatnia synchronizacja: ${dayTime(sync.finished_at)} · ${sync.run?.status === "partial_success" ? "częściowy sukces" : sync.ok ? "sukces" : "błąd"}`, [dayTime(sync.finished_at), sync.run?.status === "partial_success" ? "partial success" : sync.ok ? "success" : "error"],
                        )
                      : t("Copies sources into the archive and indexes them; the server also starts automatic refreshes", "Kopiuje źródła do archiwum i indeksuje; serwer uruchamia też automatyczne odświeżanie")
              }
            >
              {remapRunning
                ? `⟳ ${t("Remapping…", "Przemapowuję…")}`
                : startupWriting
                  ? `⟳ ${t("Starting Atlas…", "Uruchamiam Atlas…")}`
                  : syncRunning
                    ? `⟳ ${t("Synchronizing…", "Synchronizuję…")}`
                    : `↻ ${t("Synchronize", "Synchronizuj")}`}
            </GhostButton>
            {sync?.remap?.ok === false && !remapRunning && (
              <RemapFailureBadge logTail={sync.remap.log_tail} />
            )}
          </div>
        </div>
        <div data-screen={screen === "overview" ? "overview" : undefined} style={{ padding: isMobile ? "12px 12px 40px" : "16px 20px 40px", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Speed reads neither the shell's cycle series nor its windows, so their failures are not its errors. */}
          {screen !== "usage" && screen !== "speed" && seriesState.error && <ErrorState message={browserSafeDiagnostic(seriesState.error)} onRetry={seriesState.reload} />}
          {screen !== "usage" && screen !== "speed" && windowsState.error && <ErrorState message={browserSafeDiagnostic(windowsState.error)} onRetry={windowsState.reload} />}
          {!accountsState.data && accountsState.error && <ErrorState message={browserSafeDiagnostic(accountsState.error)} onRetry={accountsState.reload} />}
          {accountsState.data && (!accountReady || awaitingCapabilities) && rosterState.error && <ErrorState message={browserSafeDiagnostic(rosterState.error)} onRetry={rosterState.reload} />}
          <PageTabs screen={screen} open={openView} top={shellHeaderHeight + screenHeadHeight} onHeight={setPageTabsHeight} />
          <ContextBar parts={scopeParts} help={scopeHelp} actions={compareWindows} />
          <LoadingScope.Provider value={`${account}:${windowMinutes}:${screen}:${project}`}>
          <AnalysisActivity unavailable={rebuild.unavailable}
            preparing={!seriesState.error && !accountsState.error && !rosterState.error && (!screenProps || awaitingCapabilities)}
            preparingLabel={!accountsState.data ? t("Loading the account list", "Wczytywanie listy kont")
              : !accountReady || awaitingCapabilities ? t("Loading subscription details", "Wczytywanie danych subskrypcji")
              : t("Loading subscription history and charts", "Wczytywanie historii i wykresów subskrypcji")} />
          {screenProps && screen === "overview" && isMobile && !showRail && rosterCards.length > 0 && (
            <SubscriptionCards
              cards={activeRosterCards}
              selected={account}
              onSelect={setAccount}
              columns={isMobile ? 1 : 2}
            />
          )}
          {screenProps && screen === "overview" && isAll && (
            <Portfolio cards={activeRosterCards} onSelect={setAccount} windowMinutes={Number(windowMinutes)} />
          )}
          {screenProps && screen === "overview" && !isAll && !overviewWindowStatus && railWindows.length > 0 && (
            <WindowInsightCard
              windows={railWindows}
              account={account}
              selectedKey={selectedInsightKey}
              selectedEndIso={selectedInsightEndIso}
            />
          )}
          {screenProps && screen === "overview" && isGemini && screenProps.card && (
            <GeminiOverview
              projectWindow={selectedRailWindow ?? railWindows.find(window => window.isCurrent)}
              card={screenProps.card}
              pool={activeRosterCards.filter((c) => c.group === "gemini")}
              onSelect={setAccount}
              capabilities={screenProps.capabilities}
            />
          )}
          {screenProps && screen === "overview" && isGrok && screenProps.card && (
            <GrokOverview card={screenProps.card} capabilities={screenProps.capabilities} projectWindow={selectedRailWindow ?? railWindows.find(window => window.isCurrent)} />
          )}
          {screenProps && screen === "overview" && isGlm && screenProps.card && (
            <GlmOverview card={screenProps.card} capabilities={screenProps.capabilities} projectWindow={selectedRailWindow ?? railWindows.find(window => window.isCurrent)} />
          )}
          {screenProps && screen === "overview" && !isAll && !isGemini && !isGrok && !isGlm && (
            isClaude ? <ClaudeOverview capabilities={screenProps.capabilities} account={account} bounds={vendorOverviewBounds}
              windows={railWindows} selectedKey={selectedInsightKey} selectedEndIso={selectedInsightEndIso} onFullHistory={() => goto("history")} onOpenUsage={() => goto("usage")} /> : <Overview {...screenProps} />
          )}
          {screenProps && (screen === "usage-history" || screen === "usage-pace" || screen === "structure" || screen === "structure-models") && (
            <AllAggregate screen={screen === "usage-history" ? "history" : screen === "usage-pace" ? "analytics" : screen === "structure" ? "compare" : "models"}
              unit={unit} cards={rosterCards} />
          )}
          {screenProps && screen === "activity" && <UsageActivity />}
          {/* List for all subscriptions: every current window on one time axis (approved 2026-10-21). */}
          {screenProps && limitsForAll && screen === "history" && (
            <LimitWindowLanes cards={activeRosterCards} windowMinutes={Number(windowMinutes)} counterName={counterName} onSelect={setAccount} />
          )}
          {screenProps && limitsForAll && screen !== "history" && (
            <EmptyState title={t("Limit windows belong to one subscription and counter.", "Okna limitu należą do jednej subskrypcji i licznika.")}
              action={<GhostButton onClick={() => openView(allAccountsTarget(screen))}>
                {screen === "compare" ? t("Usage › Structure", "Zużycie › Struktura") : screen === "patterns" ? t("Usage › Activity", "Zużycie › Aktywność") : t("Usage › Trend", "Zużycie › Przebieg")}
              </GhostButton>} />
          )}
          {screenProps && isGemini && gaugeScreenUnavailable && !genericWindowScreen && (
            <EmptyState
              title={t("{0} has no cycle series. Only a live counter is available.", `${account} nie ma serii cykli — jest sam licznik, bez historii`, [account])}
              detail={t("Antigravity returns the current limit percentage and reset time, but no window history. Cycle history, comparisons, and tokens/% calibration require samples that this provider does not expose. Indexed tokens, cost, models, and events remain available. Check Overview, Models, or Usage events.", "Antigravity zwraca bieżący procent limitu i moment resetu, ale nie udostępnia przebiegu okna. Historia cykli, porównania i kalibracja tokens/% potrzebują serii próbek, której ten vendor nie daje. Tokeny, koszt, modele i zdarzenia są zindeksowane i działają — sprawdź Overview, Models albo Usage events.")}
            />
          )}
          {screenProps && isGrok && gaugeScreenUnavailable && !genericWindowScreen && (
            <EmptyState
              title={t("{0} has no cycle history. xAI does not publish a limit counter.", `${account} nie ma cykli — xAI nie publikuje licznika`, [account])}
              detail={t("Cycle history, comparisons, and tokens/% calibration require a percentage and a reset anchor. xAI provides neither, and its weekly pool is also shared with grok.com chat. Indexed tokens, cost, models, and projects remain available. Check Overview, Models, Usage events, or Projects.", "Historia cykli, porównania i kalibracja tokens/% stoją na procencie i na kotwicy resetu. xAI nie zwraca ani jednego, ani drugiego, a tygodniowy pool jest dodatkowo dzielony z czatem grok.com. Tokeny, koszt, modele i projekty są zindeksowane i działają — sprawdź Overview, Models, Usage events albo Projects.")}
            />
          )}
          {screenProps && isGlm && gaugeScreenUnavailable && !genericWindowScreen && (
            <EmptyState
              title={t("{0} has a counter but no cycle history.", `${account} nie ma serii cykli — jest licznik, bez historii`, [account])}
              detail={t("z.ai returns the current window state, including credit allowance, usage, and reset time, but no history. Cycle history, comparisons, and tokens/% calibration require samples that this reading does not provide. Calibration would not add a denominator because the limit percentage is already read from the account. Indexed tokens, cost, models, and events remain available. Check Overview, Models, or Usage events.", "z.ai zwraca stan bieżącego okna (przydział i zużycie w kredytach) oraz moment resetu, ale nie udostępnia przebiegu. Historia cykli, porównania i kalibracja tokens/% potrzebują serii próbek, której ten odczyt nie daje — a kalibracja i tak nie miałaby czego szukać, bo mianownik jest odczytany. Tokeny, koszt, modele i zdarzenia są zindeksowane i działają — sprawdź Overview, Models albo Usage events.")}
            />
          )}
          {screenProps && isClaude && gaugeScreenUnavailable && !genericWindowScreen && !insightsNote && (
            <EmptyState
              title={t("{0} has no cycle series for this screen.", `${account} nie ma serii cykli — ten ekran nie ma czego pokazać`, [account])}
              detail={t("Claude's percentage comes from the account (GET /api/oauth/usage), but it is a single reading of current usage rather than window history. Reset cycles, tokens/% calibration, and cycle comparisons require samples that this reading does not provide. Indexed usage, costs, models, and projects remain available. Check Overview, Models, Usage events, or Projects.", "Procent Claude'a jest czytany z konta (GET /api/oauth/usage), ale to pojedynczy odczyt „ile zużyto teraz”, nie przebieg okna. Cykle resetu, kalibracja tokens/% i porównania między cyklami stoją na serii próbek, której ten odczyt nie daje. Zużycie, koszty, modele i projekty są zindeksowane i działają — sprawdź Overview, Models, Usage events albo Projects.")}
            />
          )}
          {screenProps && gaugeScreenUndeclared && !insightsNote && (
            <EmptyState
              title={t("{0} has no declared gauge-series capability.", `${account} nie ma zadeklarowanej zdolności serii gauge`, [account])}
              detail={t("The backend has not confirmed /api/usage-series for this account. This is missing knowledge rather than an empty dataset. Cycle screens stay unavailable until the provider declares this capability.", "Backend nie potwierdził, że dla tego konta istnieje /api/usage-series. To brak wiedzy, nie odpowiedź „brak danych”; ekran cykli pozostaje zablokowany, dopóki provider nie zadeklaruje tej zdolności.")}
            />
          )}
          {screenProps && windowCompare && <WindowCompare windows={railWindows} account={account} />}
          {screenProps && screen === "history" && (legacyCycleDetail || windowHistory) && (
            <History
              {...screenProps}
              windowsView={windowHistory ? (
                <WindowHistory
                  windows={railWindows}
                  account={account}
                  activeKey={railActiveKey}
                  onSelect={selectRailWindow}
                  onEvents={openEvents}
                />
              ) : undefined}
            />
          )}
          {screenProps && legacyCycleDetail && screen === "compare" && <Compare {...screenProps} />}
          {screenProps && isInsightsScreen(screen) && !isAll && (insightsNote || gaugeScreenAvailable) && <Insights {...screenProps} tab={screen} cards={rosterCards} showTabs={false} />}
          {screenProps && screen === "models" && <Models {...screenProps} />}
          {screenProps && screen === "model-traffic" && <Models {...screenProps} view="trends" />}
          {screenProps && screen === "model-cost" && <Models {...screenProps} view="cost" />}
          {screenProps && screen === "speed" && <Speed {...screenProps} cards={rosterCards} />}
          {screenProps && screen === "capacity" && <Capacity {...screenProps} cards={rosterCards} />}
          {screenProps && (screen === "periods" || screen === "plans" || screen === "shares") && <Value {...screenProps} view={screen} cards={rosterCards} />}
          {screenProps && screen === "events" && <Events {...screenProps} />}
          {screenProps && screen === "usage" && <Usage />}
          {screenProps && screen === "projects" && <Projects {...screenProps} cards={rosterCards} />}
          {screenProps && (screen === "sources" || screen === "data-problems" || screen === "data-operations") && <Sources {...screenProps} view={screen} />}
          {screenProps && screen === "settings" && <Settings {...screenProps} />}
          </LoadingScope.Provider>
        </div>
      </main>
      </div>
      </div>
      {palette && model && (
        <CommandPalette
          model={model}
          onClose={() => setPalette(false)}
          goto={openView}
          selectCycle={selectCycle}
          setUnit={setUnit}
          toggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />
      )}
      {drawer && <CycleDrawer cycle={drawer} model={model!} onClose={() => setDrawerCycle(null)} onOpen={selectCycle}
        onEvents={screen === "history" ? () => { setDrawerCycle(null); openEvents(cycleEventsTarget(account, drawer)); } : undefined} />}
    </div>
    </ContextReportScreen.Provider>
  );
}
