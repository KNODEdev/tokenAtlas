import { useMemo, useState } from "react";
import type { ScreenId, ScreenProps } from "../lib/screens";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { compact, pct, usd as fmtUsd } from "../lib/format";
import { Card, CardTitle, EmptyState, ErrorState, LoadingCard, Tabs } from "../components";
import { useI18n } from "../lib/i18n";
import { subscriptionNameLookup, type RosterCard } from "../lib/roster";
import { sumClaudeAccountSplits } from "../../shared/claude-code-capacity";
import { apiEq, colorOf, formatNumber, type Tinted } from "./all-aggregate/format";
import { CompareView } from "./all-aggregate/CompareView";
import { AnalyticsView } from "./all-aggregate/AnalyticsView";
import { AllModels } from "./all-aggregate/AllModels";
import { Legend, StackedBars } from "./all-aggregate/StackedBars";
import { ShareTable } from "./all-aggregate/ShareTable";
import { Kpi, Notes } from "./all-aggregate/presentation";

const GRANULARITY = [
  { value: "day", en: "Day", pl: "Dzień" },
  { value: "week", en: "Week", pl: "Tydzień" },
  { value: "month", en: "Month", pl: "Miesiąc" },
];
export function AllAggregate({ screen, unit, cards }: { screen: ScreenId; unit: ScreenProps["unit"]; cards: RosterCard[] }) {
  const { t, locale } = useI18n();
  const [group, setGroup] = useState("month");
  const needsSeries = screen === "history" || screen === "compare" || screen === "analytics";
  // Compare shows no time series, so its request does not follow the granularity. The last answer of each request
  // stays across remounts: returning to the screen shows it at once while it is read again.
  const seriesGroup = screen === "compare" ? "month" : group;
  const state = useAsync(
    signal => (needsSeries ? api.accountHistory({ group: seriesGroup },signal) : Promise.resolve(null)),
    [seriesGroup, needsSeries], false, needsSeries ? `account-history:${seriesGroup}` : undefined
  );
  // Every window that carries the vendor split; the endpoint only counts windows started in range.
  // Only the shared History/Compare header shows it.
  const needsSplits = screen === "history" || screen === "compare";
  // Today's date is part of the request, so an answer kept from another day is never shown as today's.
  const splitsUntil = new Date().toISOString().slice(0, 10);
  const splitState = useAsync(
    signal => (needsSplits ? api.claudeAccountSplits({ since: "2020-01-01", until: splitsUntil }, signal) : Promise.resolve(null)),
    [needsSplits, splitsUntil], false, needsSplits ? `claude-account-splits:${splitsUntil}` : undefined
  );
  const claudeWindows = splitState.data?.windows ?? [];
  const claudeSum = sumClaudeAccountSplits(claudeWindows.map((window) => window.split));
  const claudeCode = claudeSum?.rows.find((row) => row.measured)?.api_usd ?? null;
  const money = unit === "usd";
  const valueOf = (s: { tokens: number; usd: number | null; priced_usd?: number }) =>
    (money ? s.usd ?? s.priced_usd ?? 0 : s.tokens);
  const fmt = (v: number) => (money ? fmtUsd(v) : compact(v));
  const data = state.data;
  const nameOf = useMemo(() => subscriptionNameLookup(cards), [cards]);
  const ordered: Tinted[] = useMemo(() => {
    if (!data) return [];
    let codexSeen = 0;
    return data.accounts.map((a) => {
      const color = colorOf(a.id, a.vendor, codexSeen);
      if (a.vendor === "codex") codexSeen += 1;
      return { ...a, color, label: nameOf(a.id) };
    });
  }, [data, nameOf]);
  if (screen === "models") return <AllModels money={money} />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  // The skeleton stands on the same frameless page as the report it replaces.
  if (!data) return <div className="ui-tab-page"><LoadingCard label={t("Loading subscription overview", "Wczytuję zestawienie subskrypcji")} height={420} shape="table" /></div>;
  if (data.points.length === 0) {
    return (
      <EmptyState
        title={t("No events in the index", "Brak zdarzeń w indeksie")}
        detail={t(
          "This overview is built from indexed events for all vendors. Run synchronization to populate it.",
          "Zestawienie powstaje z zaindeksowanych zdarzeń wszystkich vendorów. Uruchom synchronizację, żeby je wypełnić."
        )}
      />
    );
  }
  const total = valueOf(data.totals);
  const granularity = <Tabs value={group} onChange={setGroup} options={GRANULARITY.map(({ value, en, pl }) => ({ value, label: t(en, pl) }))} />;
  return (
    <div className="ui-tab-page">
      {/* Analytics puts its own four tiles here; subscriptions, calls and Claude accounts stay in History and Compare. */}
      {screen !== "analytics" && <Card>
        <div style={{ display: "flex", gap: 28, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Kpi label={t("Subscriptions with activity", "Subskrypcji z ruchem")} value={String(ordered.length)} />
          <Kpi label={t("Total tokens", "Tokeny łącznie")} value={compact(data.totals.tokens)} title={formatNumber(data.totals.tokens, locale)} />
          <Kpi label={t("API-equivalent value", "Wartość API-eq")} value={apiEq(data.totals)} sub={t("At API pricing, not an invoice", "po cenniku API, nie rachunek")} />
          <Kpi label={t("Calls", "Wywołania")} value={compact(data.totals.calls)} title={formatNumber(data.totals.calls, locale)} />
          {claudeSum && (
            <Kpi
              label={t("Claude whole accounts (est.)", "Claude całe konta (szac.)")}
              value={claudeSum.account_api_usd == null ? "—" : `≈ ${fmtUsd(claudeSum.account_api_usd)}`}
              sub={`${t("of which Claude Code measured", "w tym zmierzony Claude Code")} ${claudeCode == null ? "—" : fmtUsd(claudeCode)} · ${t("since", "od")} ${claudeWindows[0]!.window_started_at.slice(0, 10)}`}
              title={t(
                "Estimated from the Claude Code share the account reports, over {0} weekly windows that carry it. Shown beside the measured value and not added to it: local non-Code traffic is already measured. Split: {1}",
                `Szacunek z udziału Claude Code podawanego przez konto, z ${claudeWindows.length} tygodni, które go mają. Pokazany obok wartości zmierzonej, nie doliczony do niej: lokalny ruch spoza Code jest już zmierzony. Podział: ${claudeSum.rows.map((row) => `${row.display_name ?? "poza Claude Code"} ${pct(row.percent)}`).join(" · ")}`, [claudeWindows.length, claudeSum.rows.map((row) => `${row.display_name ?? "outside Claude Code"} ${pct(row.percent)}`).join(" · ")]
              )}
            />
          )}
          <div style={{ marginLeft: "auto" }}>{granularity}</div>
        </div>
      </Card>}
      {screen === "history" && (
        <Card>
          <CardTitle
            title={money ? t("API-equivalent value over time", "Wartość API-eq w czasie") : t("Tokens over time", "Tokeny w czasie")}
            help={
              unit === "percent"
                ? t(
                    "Allowance percentages do not add across subscriptions because they are fractions of different totals. The chart shows tokens; switch to $ in the header to see API-equivalent value.",
                    "Procent limitu nie sumuje się w poprzek subskrypcji — to ułamki różnych całości. Wykres pokazuje tokeny; przełącz na $ w nagłówku, żeby zobaczyć wartość API-eq."
                  )
                : t(
                    "Each bar is a period and each segment is a subscription. Height is the total work completed by that subscription.",
                    "Słupek to okres, segment to subskrypcja. Wysokość = ile stanowisko przerobiło łącznie."
                  )
            }
          />
          <StackedBars points={data.points} accounts={ordered} group={group} money={money} fmt={fmt} />
          <Legend accounts={ordered} />
        </Card>
      )}
      {screen === "compare" && <CompareView accounts={ordered} total={total} valueOf={valueOf} money={money} />}
      {screen === "analytics" && (
        <AnalyticsView points={data.points} accounts={ordered} group={group} money={money} fmt={fmt} totals={data.totals} granularity={granularity} />
      )}
      <ShareTable accounts={ordered} total={total} valueOf={valueOf} folded={screen === "analytics"} />
      <Notes notes={data.notes} unpricedTokens={data.unpriced.tokens} />
    </div>
  );
}
