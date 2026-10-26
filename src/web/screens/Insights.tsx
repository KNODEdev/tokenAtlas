import type { ScreenProps } from "../lib/screens";
import { api } from "../lib/api";
import { ALL_ACCOUNT, type RosterCard } from "../lib/roster";
import { Tabs } from "../components/ui";
import { ActivityHeatmap } from "../components/ActivityHeatmap";
import { useI18n } from "../lib/i18n";
import { AllAggregate } from "./AllAggregate";
import { Analytics } from "./Analytics";
import { Patterns } from "./Patterns";
import "./History.css";
import "./Insights.css";

import type { InsightsTab } from "../lib/screens";
export { isInsightsScreen, type InsightsTab } from "../lib/screens";
export type InsightsScope = "all" | "claude" | "credits" | "cycles";

/** What the screen can read for the selected subscription. */
export function insightsScope(props: Pick<ScreenProps, "account" | "accounts" | "card">): InsightsScope {
  if (props.account === ALL_ACCOUNT) return "all";
  const entry = props.accounts.find((account) => account.id === props.account);
  const vendor = entry?.vendor ?? props.card?.group ?? null;
  if (vendor === "claude" || vendor === "anthropic") return "claude";
  // Business is billed in credits: it has no limit meter and therefore no windows (as on Capacity).
  if (entry?.plan === "self_serve_business_usage_based" || ((vendor === "codex" || vendor === "openai") && props.account.endsWith("::business"))) return "credits";
  return "cycles";
}

/**
 * Analytics and Patterns as one screen with two tabs and one navigation entry (UI audit decision 1).
 * Each tab keeps its screen id, so anything that opens "patterns" lands on its tab.
 */
export function Insights(props: ScreenProps & { tab: InsightsTab; cards: RosterCard[]; showTabs?: boolean }) {
  const { t } = useI18n();
  const { tab, goto } = props;
  const scope = insightsScope(props);
  return (
    <div className="archive">
      {props.showTabs !== false && <div className="insights-tabs">
        <Tabs value={tab} onChange={goto} tablist={{ label: t("Analytics", "Analityka"), idBase: "insights-tab", panelId: "insights-panel" }}
          options={[{ value: "analytics", label: t("Trends", "Trendy") }, { value: "patterns", label: t("Patterns", "Wzorce") }]} />
      </div>}
      <div id="insights-panel" role={props.showTabs !== false ? "tabpanel" : undefined} aria-labelledby={props.showTabs !== false ? `insights-tab-${tab}` : undefined} className="archive">
        {scope === "claude" ? (
          <div className="insights-note">
            <b>{t("Analytics and patterns cover Codex cycles for now.", "Analityka i wzorce obejmują na razie cykle Codexa.")}</b>{" "}
            {t("Claude's limit windows need their own data source here. Until then they are in History and Compare.", "Okna limitu Claude'a potrzebują tu własnego źródła danych. Do tego czasu są w Historii i Porównaniu.")}
          </div>
        ) : scope === "credits" ? (
          <div className="insights-note">
            <b>{t("Business is billed in credits.", "Business rozlicza się kredytami.")}</b>{" "}
            {t("It has no limit meter, so there are no windows to analyse. Its usage and credits are in Usage and Models.", "Nie ma licznika limitu, więc nie ma okien do analizy. Zużycie i kredyty znajdziesz w Zużyciu i Modelach.")}
          </div>
        ) : scope === "all" ? (
          tab === "analytics"
            ? <AllAggregate screen="analytics" unit={props.unit} cards={props.cards} />
            : <ActivityHeatmap load={(signal) => api.activity({ vendor: "all" }, signal)} deps={[]} scope={t("all subscriptions", "wszystkie subskrypcje")} />
        ) : tab === "analytics" ? <Analytics {...props} /> : <Patterns {...props} />}
      </div>
    </div>
  );
}
