import { useI18n } from "../lib/i18n";
import { Card } from "./ui";
import { LoadingSkeleton, LoadingStatus } from "./LoadingStatus";

/**
 * The loading state of a view whose data is not ready yet. Progress of synchronization, data
 * rebuilds and background preparation belongs to the permanent status bar, not to this panel.
 */
export function AnalysisActivity({ unavailable, preparing, preparingLabel }: {
  unavailable: boolean;
  preparing: boolean;
  preparingLabel?: string;
}) {
  const { t } = useI18n();
  if (!preparing) return null;
  return <Card style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
    <LoadingStatus label={preparingLabel ?? t("Preparing the view", "Przygotowanie widoku")} />
    <LoadingSkeleton shape="kpi" />
    {unavailable && <p role="alert" className="ui-alert">{t("Cannot read progress from the server. Retrying automatically.", "Nie można odczytać postępu z serwera. Ponawiam połączenie automatycznie.")}</p>}
  </Card>;
}
