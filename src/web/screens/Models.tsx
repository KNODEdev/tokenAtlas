import type { ScreenProps } from "../lib/screens";
import { SubscriptionStats } from "../components/SubscriptionStats";
import { chooseOverviewTab } from "../lib/overview-tab";
import { useI18n } from "../lib/i18n";

/**
 * One subscription's models over the selected dates. The selected window's models are the
 * Overview's "Models and traffic" tab, so this screen links there (UI audit decision 8).
 */
/** `view` picks the page tab: the per-model table ("usage"), the traffic history ("trends") or the cost per 1M ("cost"). */
export function Models(props: ScreenProps & { view?: "usage" | "trends" | "cost" }) {
  const { t } = useI18n();
  const vendor = props.accounts.find(account => account.id === props.account)?.vendor;
  const isCodex = vendor === "codex" || vendor === "openai" || (props.card?.id === props.account && props.card.group === "codex");
  const { openEvents, goto, account } = props;
  const all = ["all", "__all__"].includes(account.toLowerCase());
  // The screen stands on the paper like Capacity: the stats card drops its frame (paper-atlas §3).
  return <div className="ui-tab-page"><SubscriptionStats
    section="models"
    modelsView={props.view ?? "usage"}
    provider={all ? "all" : isCodex ? "codex" : vendor ?? props.card?.group ?? "unknown"}
    accounts={props.accounts}
    key={account}
    account={account}
    project={props.project}
    openDataSettings={props.openDataSettings}
    initialRange={props.analysisRange}
    onOverview={all ? undefined : () => { chooseOverviewTab("models"); goto("overview"); }}
    onModelEvents={openEvents ? (model, range) => openEvents({ account, model, ...range,
      origin: `${t("Models", "Modele")} › ${account} › ${model}`, returnScreen: "models" }) : undefined}
  /></div>;
}
