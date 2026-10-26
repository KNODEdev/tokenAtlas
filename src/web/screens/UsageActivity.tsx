import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { ActivityHeatmap } from "../components/ActivityHeatmap";
import "./History.css";
import "./Insights.css";

/** Usage → Activity (IA-2026-10-19 v1.1, US): the all-subscription heatmap formerly under Analytics → Patterns. */
export function UsageActivity() {
  const { t } = useI18n();
  return <div className="archive ui-tab-page">
    <ActivityHeatmap load={(signal) => api.activity({ vendor: "all" }, signal)} deps={[]} scope={t("all subscriptions", "wszystkie subskrypcje")} />
  </div>;
}
