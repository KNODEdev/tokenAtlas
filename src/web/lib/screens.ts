import type { AtlasModel, CycleView } from "./cycle";
import type { AccountCapabilities, ApiAccount, ApiProject, SyncStatus } from "./api";
import type { RosterCard } from "./roster";
import { translateForLanguage, type Language } from "./i18n";
import type { DataSettingsTarget } from "./data-settings";
import type { EventsTarget } from "./events-filter";
export type ScreenId =
  | "overview"
  | "usage"
  | "capacity"
  | "history"
  | "compare"
  | "analytics"
  | "patterns"
  | "models"
  | "model-traffic"
  | "speed"
  | "events"
  | "projects"
  | "sources"
  | "settings"
  // IA-2026-10-19 v1.1: views that existed only inside other screens or for all accounts.
  | "periods"
  | "plans"
  | "shares"
  | "usage-history"
  | "usage-pace"
  | "structure"
  | "structure-models"
  | "activity"
  | "data-problems"
  | "data-operations";
export type Unit = "percent" | "tokens" | "usd";

export type InsightsTab = "analytics" | "patterns";
export function isInsightsScreen(screen: ScreenId): screen is InsightsTab {
  return screen === "analytics" || screen === "patterns";
}

export function shouldReadWindowRail(screen: ScreenId): boolean {
  return screen === "overview" || screen === "compare";
}

const GAUGE_SERIES_SCREENS = new Set<ScreenId>([
  "history",
  "compare",
  "analytics",
  "patterns",
]);
export function screenAvailability(
  screen: ScreenId,
  capabilities: AccountCapabilities | null
): boolean | null {
  if (!GAUGE_SERIES_SCREENS.has(screen)) return true;
  return capabilities?.hasGaugeSeries ?? null;
}
export interface ScreenProps {
  model: AtlasModel;
  unit: Unit;
  setUnit: (u: Unit) => void;
  account: string;
  /** Make `id` the selected subscription; screens pair it with `goto`. */
  selectAccount: (id: string) => void;
  accounts: ApiAccount[];
  capabilities: AccountCapabilities | null;
  card: RosterCard | null;
  project: string;
  setProject: (id: string) => void;
  projects: ApiProject[];
  chosen: CycleView | null;
  selectCycle: (index: number) => void;
  openDrawer: (index: number) => void;
  windowRailInShell: boolean;
  goto: (screen: ScreenId) => void;
  compare: number[];
  setCompare: (ids: number[]) => void;
  sync: SyncStatus | null;
  triggerSync: (mode: "incremental" | "full") => void;
  dataSettings?: DataSettingsTarget | null;
  openDataSettings?: (target: DataSettingsTarget) => void;
  returnFromSettings?: () => void;
  analysisRange?: NonNullable<DataSettingsTarget["returnRange"]>;
  /** Opens Usage events for a subscription, UTC dates and optionally a model (UI audit decision 2). */
  openEvents?: (target: EventsTarget) => void;
  /** What Usage events was opened with; null after plain navigation. */
  eventsTarget?: EventsTarget | null;
}
export const SCREEN_TITLES: Record<ScreenId, string> = {
  overview: "Overview",
  usage: "Usage",
  capacity: "Subscription capacity",
  history: "History",
  compare: "Cycle comparison",
  analytics: "Analytics",
  patterns: "Analytics · Patterns",
  models: "Models",
  "model-traffic": "Model traffic history",
  speed: "Speed",
  events: "Usage events",
  projects: "Projects",
  sources: "Data sources",
  settings: "Settings",
  periods: "Billing periods",
  plans: "Plan comparison",
  shares: "Saved comparisons",
  "usage-history": "Accounts over time",
  "usage-pace": "Pace",
  structure: "Structure by account",
  "structure-models": "Structure by model",
  activity: "Activity",
  "data-problems": "Data problems",
  "data-operations": "Data operations",
};
export const SCREEN_TITLES_PL: Record<ScreenId, string> = {
  overview: "Przegląd",
  usage: "Zużycie",
  capacity: "Pojemność abonamentu",
  history: "Historia",
  compare: "Porównanie cykli",
  analytics: "Analityka",
  patterns: "Analityka · Wzorce",
  models: "Modele",
  "model-traffic": "Historia ruchu modeli",
  speed: "Prędkość",
  events: "Zdarzenia użycia",
  projects: "Projekty",
  sources: "Źródła danych",
  settings: "Ustawienia",
  periods: "Okresy rozliczeniowe",
  plans: "Porównanie planów",
  shares: "Zapisane porównania",
  "usage-history": "Konta w czasie",
  "usage-pace": "Tempo",
  structure: "Struktura według kont",
  "structure-models": "Struktura według modeli",
  activity: "Aktywność",
  "data-problems": "Problemy z danymi",
  "data-operations": "Operacje na danych",
};
export type SectionId = "overview" | "limits" | "value" | "usage" | "projects" | "models" | "data" | "settings";
export interface NavLabel { en: string; pl: string }
export interface NavView { screen: ScreenId; label: NavLabel }
/** A page tab; its first view is where the tab opens. */
export interface NavTab { id: string; label: NavLabel; views: NavView[] }
export interface NavSection { id: SectionId; label: NavLabel; icon: string; system?: boolean; tabs: NavTab[] }
const view = (screen: ScreenId, en: string, pl: string): NavView => ({ screen, label: { en, pl } });
const tab = (id: string, en: string, pl: string, views: NavView[]): NavTab => ({ id, label: { en, pl }, views });
/**
 * The one navigation registry (IA-2026-10-19 v1.1, IA-14): menu, page title, tabs, views and the command
 * palette read their names here. Old screen ids stay as views, so every existing goto() keeps its target.
 */
export const NAVIGATION: readonly NavSection[] = [
  { id: "overview", label: { en: "Overview", pl: "Przegląd" }, icon: "◎", tabs: [tab("overview", "Overview", "Przegląd", [view("overview", "Overview", "Przegląd")])] },
  // Capacity first: Limits opens on it (user decision 2026-10-21).
  { id: "limits", label: { en: "Limits", pl: "Limity" }, icon: "%", tabs: [
    tab("capacity", "Capacity", "Pojemność", [view("capacity", "Capacity", "Pojemność")]),
    tab("windows", "Limit windows", "Okna limitu", [
      view("history", "List", "Lista"), view("compare", "Compare", "Porównaj"),
      view("analytics", "Trends", "Trendy"), view("patterns", "Patterns", "Wzorce"),
    ]),
  ] },
  { id: "value", label: { en: "Value", pl: "Opłacalność" }, icon: "$", tabs: [
    tab("periods", "Billing periods", "Okresy rozliczeniowe", [view("periods", "Billing periods", "Okresy rozliczeniowe")]),
    tab("plans", "Plan comparison", "Porównanie planów", [view("plans", "Comparison", "Porównanie"), view("shares", "Saved comparisons", "Zapisane porównania")]),
  ] },
  { id: "usage", label: { en: "Usage", pl: "Zużycie" }, icon: "▥", tabs: [
    tab("trend", "Trend", "Przebieg", [view("usage", "Report", "Raport"), view("usage-history", "Accounts over time", "Konta w czasie"), view("usage-pace", "Pace", "Tempo")]),
    tab("structure", "Structure", "Struktura", [view("structure", "Accounts", "Konta"), view("structure-models", "Models", "Modele")]),
    tab("activity", "Activity", "Aktywność", [view("activity", "Activity", "Aktywność")]),
    tab("events", "Events", "Zdarzenia", [view("events", "Events", "Zdarzenia")]),
  ] },
  { id: "projects", label: { en: "Projects", pl: "Projekty" }, icon: "▤", tabs: [tab("projects", "Projects", "Projekty", [view("projects", "Projects", "Projekty")])] },
  { id: "models", label: { en: "Models", pl: "Modele" }, icon: "⬡", tabs: [
    tab("speed", "Speed", "Szybkość", [view("speed", "Speed", "Szybkość")]),
    // "models" keeps every existing target (events, data settings) on the per-model table.
    tab("sources", "Models & sources", "Modele i źródła", [view("models", "Models & sources", "Modele i źródła")]),
    tab("traffic", "Traffic history", "Historia ruchu", [view("model-traffic", "Traffic history", "Historia ruchu")]),
  ] },
  { id: "data", label: { en: "Data and sync", pl: "Dane i synchronizacja" }, icon: "⌸", system: true, tabs: [
    tab("sources", "Source status", "Stan źródeł", [view("sources", "Source status", "Stan źródeł")]),
    tab("problems", "Data problems", "Problemy z danymi", [view("data-problems", "Data problems", "Problemy z danymi")]),
    tab("operations", "Operations", "Operacje", [view("data-operations", "Operations", "Operacje")]),
  ] },
  { id: "settings", label: { en: "Settings", pl: "Ustawienia" }, icon: "⚙", system: true, tabs: [tab("settings", "Settings", "Ustawienia", [view("settings", "Settings", "Ustawienia")])] },
];
export interface NavLocation { section: NavSection; tab: NavTab; view: NavView }
const LOCATIONS = new Map<ScreenId, NavLocation>(NAVIGATION.flatMap(section =>
  section.tabs.flatMap(tab => tab.views.map(view => [view.screen, { section, tab, view }] as const))));
/** Where a screen lives in the menu: its section, page tab and view. */
export function navLocation(screen: ScreenId): NavLocation {
  return LOCATIONS.get(screen)!;
}
export function navText(label: NavLabel, language: Language): string {
  return translateForLanguage(language, label.en, label.pl);
}
/** The first view of a section, where its menu entry opens. */
export function sectionScreen(section: NavSection): ScreenId {
  return section.tabs[0]!.views[0]!.screen;
}
/** The menu entry a screen belongs to (its section's first view). */
export function navScreen(screen: ScreenId): ScreenId {
  return sectionScreen(navLocation(screen).section);
}
/** One destination as the command palette lists it: section › tab › view. */
export function screenLabel(screen: ScreenId, language: Language): string {
  const { section, tab, view } = navLocation(screen);
  const parts = [section.label, ...(section.tabs.length > 1 ? [tab.label] : []), ...(tab.views.length > 1 ? [view.label] : [])];
  return parts.map(part => navText(part, language)).join(" › ");
}
/** The former screen names stay searchable in the palette (IA-14), never as a second menu entry. */
export function screenAliases(screen: ScreenId): string[] {
  return [SCREEN_TITLES[screen], SCREEN_TITLES_PL[screen]];
}
/** The page title is the menu entry. */
export function screenTitle(screen: ScreenId, language: Language): string {
  return navText(navLocation(screen).section.label, language);
}
/**
 * Old all-account targets of window screens keep their meaning in the new menu (02, "Zgodność starych celów"):
 * calendar history and pace go to Usage, the account comparison and model ranking to Structure, the heatmap to Activity.
 */
export function allAccountsTarget(screen: ScreenId): ScreenId {
  switch (screen) {
    case "history": return "usage-history";
    case "analytics": return "usage-pace";
    case "compare": return "structure";
    case "patterns": return "activity";
    case "models": return "structure-models";
    case "model-traffic": return "usage-history";
    default: return screen;
  }
}
