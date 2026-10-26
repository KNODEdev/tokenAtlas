import type { ScreenProps } from "../lib/screens";
import { ALL_ACCOUNT, type RosterCard } from "../lib/roster";
import { useI18n } from "../lib/i18n";
import { SubscriptionMonth } from "../components/SubscriptionMonth";
import { CapacityBattle } from "../components/CapacityBattle";
import { EmptyState } from "../components/ui";
import { SavedComparisons } from "./SavedComparisons";
import "./SubscriptionMonthAnalysis.css";

export type ValueView = "periods" | "plans" | "shares";

/**
 * Billing periods, plan comparison and saved comparisons read independently of the shell's history.
 */
export function Value(props: ScreenProps & { view: ValueView; cards: RosterCard[] }) {
  const { t } = useI18n();
  const all = props.account === ALL_ACCOUNT || props.account === "all";
  const vendor = props.accounts.find(account => account.id === props.account)?.vendor ?? props.card?.group ?? "unknown";
  const business = (vendor === "codex" || vendor === "openai") && props.account.endsWith("::business");
  const dataRevision = props.sync?.revisions?.data ?? undefined;
  return <div className="ui-tab-page">
    {props.view === "plans" ? <CapacityBattle accounts={props.accounts} cards={props.cards} dataRevision={dataRevision} />
      : props.view === "periods" ? business
        ? <EmptyState title={t("Business uses credits", "Business korzysta z kredytów")} />
        : all
          ? <SubscriptionMonth vendor="all" account={props.account} dataRevision={dataRevision} all={{ cards: props.cards, select: props.selectAccount }} />
          : <SubscriptionMonth key={props.account} vendor={vendor} account={props.account} dataRevision={dataRevision} openDataSettings={props.openDataSettings}
              initialCycle={props.dataSettings?.area === "windows" && props.dataSettings.account === props.account ? props.dataSettings.cycle?.start : undefined} />
      : <SavedComparisons account={all ? undefined : props.account} vendor={all ? "all" : vendor} />}
  </div>;
}
