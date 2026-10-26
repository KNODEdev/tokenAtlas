import { useEffect } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { ErrorState, GhostButton, LoadingCard } from "../components/ui";
import type { SubscriptionRateResponse } from "../../shared/subscription-rate";
import { RateSharePanel } from "./RateSharePanel";
import { useContextPreview } from "../lib/context-premium";
import { rateWithContextPreview } from "../lib/window-context-preview";

export function SavedComparisons({ account, vendor }: { account?: string; vendor: string }) {
  const contextPreview = useContextPreview();
  const { t } = useI18n();
  const business = !!account?.endsWith("::business") && (vendor === "codex" || vendor === "openai");
  const supported = !account || !business && ["claude", "anthropic", "codex", "openai"].includes(vendor);
  const state = useAsync(signal => supported ? api.subscriptionRate(account, signal)
    : Promise.resolve<SubscriptionRateResponse>({ windows: [], annotations: [], preparing: false, hours_preparing: false, stale: false }), [account, supported]);
  useEffect(() => {
    if (!state.data?.preparing && !state.data?.hours_preparing && !state.data?.stale) return;
    const timer = setTimeout(state.reload, 3000);
    return () => clearTimeout(timer);
  }, [state.data, state.reload]);
  if (!state.data) return state.error ? <ErrorState message={state.error} onRetry={state.reload} />
    : <LoadingCard label={t("Reading subscription rates", "Wczytywanie kursów abonamentów")} />;
  const data = state.data;
  return <div className="subscription-month-analysis ui-tab-page">
    <div className="rate-controls">
      <GhostButton onClick={state.reload}>{t("Refresh", "Odśwież")}</GhostButton>
    </div>
    {(data.preparing || data.stale) && <p role="status">{t("Updating in the background", "Aktualizacja w tle")}</p>}
    <RateSharePanel windows={data.windows.map(window => rateWithContextPreview(window, contextPreview))} />
  </div>;
}
