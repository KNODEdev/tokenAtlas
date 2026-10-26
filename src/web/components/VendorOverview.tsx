import { useId, useState, type ReactNode } from "react";
import { translate, useI18n } from "../lib/i18n";
import { EmptyState, GhostButton, Tabs, type KpiSpec } from "./ui";
export type VendorSectionKey = "planWindows" | "models" | "traffic" | "provenance" | "calibration";
export interface VendorOverviewSections {
  /** Shown above the first section: the selected window's status. */
  lead?: ReactNode;
  /**
   * Tabbed layout under the lead: plan windows become "Forecast and budget", models with traffic,
   * this window history, and provenance with calibration.
   */
  history?: ReactNode;
  /** Opens Limits → Limit windows, the owner of the full window history (IA-2026-10-19 v1.1, OV). */
  openWindows?: () => void;
  projects?: ReactNode;
  planWindows: ReactNode;
  models: ReactNode;
  traffic: ReactNode;
  provenance: ReactNode;
  calibration: ReactNode;
  subs?: Partial<Record<VendorSectionKey, ReactNode>>;
}
export const VENDOR_SECTION_TITLES = [
  "Okna planu",
  "Modele w oknie",
  "Skład ruchu",
  "Proweniencja danych",
  "Kalibracja i obserwacje",
] as const;
export const VENDOR_KPI_SLOTS = [
  "Remaining",
  "Avg burn",
  "Sustainable burn",
  "Current pace",
  "Projected",
  "Czas okna",
  "Koszt API-eq",
  "Cache rate",
] as const;
export type VendorKpiSlot = (typeof VENDOR_KPI_SLOTS)[number];
export const VENDOR_KPI_COLUMNS = 5;
function vendorSectionTitle(index: number): string {
  if (index === 0) return translate("Plan windows", "Okna planu");
  if (index === 1) return translate("Models in window", "Modele w oknie");
  if (index === 2) return translate("Traffic composition", "Skład ruchu");
  if (index === 3) return translate("Data provenance", "Proweniencja danych");
  return translate("Calibration and observations", "Kalibracja i obserwacje");
}
function vendorKpiLabel(slot: VendorKpiSlot): string {
  switch (slot) {
    case "Remaining": return translate("Remaining", "Pozostało");
    case "Avg burn": return translate("Avg burn", "Śr. zużycie");
    case "Sustainable burn": return translate("Sustainable burn", "Zużycie zrównoważone");
    case "Current pace": return translate("Current pace", "Bieżące tempo");
    case "Projected": return translate("Projected", "Prognoza");
    case "Czas okna": return translate("Window time", "Czas okna");
    case "Koszt API-eq": return translate("API-equivalent cost", "Koszt API-eq");
    case "Cache rate": return translate("Cache rate", "Udział cache");
  }
}
function absentTitle(slot: VendorKpiSlot): string {
  switch (slot) {
    case "Remaining": return translate("This provider does not publish a window cap, so there is nothing to subtract usage from.", "Ten dostawca nie publikuje pułapu okna, więc nie ma od czego odjąć zużycia.");
    case "Avg burn": return translate("There is no window start anchor or usage measure over time. A backward average would have no denominator.", "Brak kotwicy początku okna albo miary zużycia w czasie. Średnia wsteczna nie miałaby mianownika.");
    case "Sustainable burn": return translate("This requires both a window cap and a reset date. Missing either one closes this slot.", "Wymaga i pułapu okna, i daty resetu. Brak któregokolwiek zamyka ten slot.");
    case "Current pace": return translate("Pace combines usage with elapsed window time. Without elapsed percentage there is nothing to compare.", "Tempo to zużycie zestawione z upływem okna. Bez procentu upływu nie ma czego zestawiać.");
    case "Projected": return translate("Projection extends measured pace to reset. Without pace or reset it would be invented.", "Projekcja przedłuża zmierzone tempo do resetu. Bez tempa albo bez resetu byłaby zmyślona.");
    case "Czas okna": return translate("The provider does not say when the window started or ends.", "Vendor nie mówi, kiedy okno się zaczęło ani kiedy się kończy.");
    case "Koszt API-eq": return translate("There is no indexed traffic that can be priced with a catalog.", "Brak zaindeksowanego ruchu, który dałoby się wycenić cennikiem.");
    case "Cache rate": return translate("This provider does not separate cache reads from the rest of input.", "Ten dostawca nie rozdziela odczytów z cache od reszty inputu.");
  }
}
export function vendorKpis(
  filled: Partial<Record<VendorKpiSlot, Omit<KpiSpec, "label">>>,
  extras: KpiSpec[] = []
): KpiSpec[] {
  const common = VENDOR_KPI_SLOTS.map((slot) => {
    const spec = filled[slot];
    if (spec) return { label: vendorKpiLabel(slot), ...spec };
    return { label: vendorKpiLabel(slot), value: "—", note: translate("not provided by vendor", "vendor nie podaje"), absent: true, title: absentTitle(slot) };
  });
  return [...common, ...extras];
}
function OverviewSection({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="overview-section">
      <div className="overview-section-header">
        <h2 className="overview-section-title">{title}</h2>
        {sub != null && <span className="mono overview-section-subtitle">{sub}</span>}
      </div>
      <div className="overview-section-content">{children}</div>
    </section>
  );
}
/** The empty state is already a dashed sheet, so it stands in for the card instead of nesting in one. */
export function MissingSection({ title, detail }: { title: string; detail: string }) {
  return <EmptyState title={title} detail={detail} />;
}
export function missingVendorSections(title: string, detail: string): VendorOverviewSections {
  const content = <MissingSection title={title} detail={detail} />;
  return { planWindows: content, models: content, traffic: content, provenance: content, calibration: content };
}
const VENDOR_SECTION_KEYS: VendorSectionKey[] = ["planWindows", "models", "traffic", "provenance", "calibration"];
// The window history has its owner in Limits → Limit windows; Overview links there instead of a copy (01 OV).
type OverviewTab = "forecast" | "models" | "projects" | "data";
const TAB_KEY = "tokenatlas.overview-tab.v1";
function storedTab(): OverviewTab {
  try {
    const value = localStorage.getItem(TAB_KEY);
    return value === "models" || value === "projects" || value === "data" ? value : "forecast";
  } catch { return "forecast"; }
}
function TabbedOverview({ sections }: { sections: VendorOverviewSections }) {
  const { t } = useI18n();
  const [selectedTab, setTab] = useState<OverviewTab>(storedTab);
  const hasHistory = sections.history != null;
  const tab = selectedTab === "projects" ? sections.projects == null ? "forecast" : selectedTab
    : !hasHistory ? "forecast" : selectedTab;
  const idBase = useId();
  const choose = (value: OverviewTab) => {
    setTab(value);
    try { localStorage.setItem(TAB_KEY, value); } catch { /* Storage may be unavailable in private browsing. */ }
  };
  const panelId = `${idBase}-panel`;
  const titled = (key: VendorSectionKey, index: number) => (
    <OverviewSection key={key} title={vendorSectionTitle(index)} sub={sections.subs?.[key]}>{sections[key]}</OverviewSection>
  );
  return (
    <>
      {sections.lead}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-6)", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <Tabs value={tab} onChange={choose} tablist={{ label: t("Overview sections", "Sekcje przeglądu"), idBase, panelId }} options={[
            { value: "forecast", label: hasHistory ? t("Forecast and budget", "Prognoza i budżet") : t("Overview", "Przegląd") },
            ...(hasHistory ? [{ value: "models" as const, label: t("Models and traffic", "Modele i ruch") }] : []),
            ...(sections.projects != null ? [{ value: "projects" as const, label: t("Projects", "Projekty") }] : []),
            ...(hasHistory ? [{ value: "data" as const, label: t("Data and calibration", "Dane i kalibracja") }] : []),
          ]} />
        </div>
        {hasHistory && sections.openWindows && <GhostButton onClick={sections.openWindows}>{`${t("Limit windows", "Okna limitu")} →`}</GhostButton>}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={`${idBase}-${tab}`} style={{ display: "flex", flexDirection: "column", gap: "var(--s-8)" }}>
        {tab === "forecast" && (hasHistory ? sections.planWindows : VENDOR_SECTION_TITLES.map((_, index) => titled(VENDOR_SECTION_KEYS[index]!, index)))}
        {tab === "models" && <>{titled("models", 1)}{titled("traffic", 2)}</>}
        {tab === "projects" && sections.projects}
        {tab === "data" && <>{titled("provenance", 3)}{titled("calibration", 4)}</>}
      </div>
    </>
  );
}
export function VendorOverview({ sections }: { sections: VendorOverviewSections }) {
  useI18n();
  if (sections.history != null || sections.projects != null) return <TabbedOverview sections={sections} />;
  return (
    <>
      {sections.lead}
      {VENDOR_SECTION_TITLES.map((_, index) => {
        const key = VENDOR_SECTION_KEYS[index]!;
        return (
          <OverviewSection key={key} title={vendorSectionTitle(index)} sub={sections.subs?.[key]}>
            {sections[key]}
          </OverviewSection>
        );
      })}
    </>
  );
}
