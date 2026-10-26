import type { ScreenProps } from "../lib/screens";
import type { RosterCard } from "../lib/roster";
import { useI18n } from "../lib/i18n";
import { SubscriptionStats } from "../components/SubscriptionStats";
import { GlobalCapacity } from "../components/GlobalCapacity";
import { EmptyState } from "../components/ui";

/**
 * Limits → Capacity (IA-2026-10-19 v1.1, LI): one subscription's capacity, or the global comparison when all
 * subscriptions are selected. The battle and the subscription month moved to Value with their components.
 */
export function Capacity(props: ScreenProps & { cards: RosterCard[] }) {
  const { t } = useI18n();
  const all = props.account === "__all__" || props.account === "all";
  const vendor = props.accounts.find(account => account.id === props.account)?.vendor ?? props.card?.group ?? "unknown";
  const business = (vendor === "codex" || vendor === "openai") && props.account.endsWith("::business");
  const dataRevision = props.sync?.revisions?.data ?? undefined;
  return <div className="ui-tab-page">{all ? <GlobalCapacity accounts={props.accounts} cards={props.cards} dataRevision={dataRevision} />
      : business
      ? <EmptyState title={t("Business uses credits", "Business korzysta z kredytów")}
          detail={t("This account has no percentage-based subscription allowance. Its credit and model usage is available in Models.", "To konto nie ma procentowego limitu abonamentu. Zużycie kredytów i modeli znajdziesz w Modelach.")} />
      : <SubscriptionStats key={props.account} section="capacity" dataRevision={dataRevision} provider={vendor === "openai" ? "codex" : vendor}
          account={props.account} project={props.project} openDataSettings={props.openDataSettings} initialRange={props.analysisRange} />}</div>;
}
