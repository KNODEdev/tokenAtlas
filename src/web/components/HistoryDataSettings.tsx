import { useEffect, useMemo, useState } from "react";
import type { TimelineMarker, TimelineMarkersResponse } from "../../shared/codex-accounting";
import type { DataSettingsTarget } from "../lib/data-settings";
import { api, refreshApiData, type HistoryCoverageRow } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { TableRow, Card, CardTitle, Dropdown, ErrorState, GhostButton, LoadingCard, Table, Th, Td } from "./ui";
import { CodexMarkerEditor } from "./CodexMarkerEditor";

export interface HistoryDataSettingsProps {
  account: string;
  since?: string;
  until?: string;
  onNavigate: (target: DataSettingsTarget) => void;
}

type CoverageAction = HistoryCoverageRow["actions"][number];
type PlanGap = { since: string; until: string; days: number };
type MarkerScope = { provider: string; response: TimelineMarkersResponse };

const PROVIDER_ALIASES: Record<string, string> = {
  openai: "codex",
  codex: "codex",
  anthropic: "claude",
  claude: "claude",
  google: "gemini",
  gemini: "gemini",
  zai: "glm",
  glm: "glm",
  xai: "grok",
  grok: "grok",
};

function markerProvider(vendor: string): string | null {
  return PROVIDER_ALIASES[vendor.trim().toLowerCase()] ?? null;
}

function providerOrder(a: string, b: string): number {
  if (a === "codex") return -1;
  if (b === "codex") return 1;
  return a.localeCompare(b);
}

function planGaps(row: HistoryCoverageRow): PlanGap[] {
  return row.plan_history.uncovered_ranges?.filter((gap) => gap.since && gap.until) ?? [];
}

function dateContext(row: HistoryCoverageRow, since?: string, until?: string, range?: Pick<PlanGap, "since" | "until">): Pick<DataSettingsTarget, "since" | "until"> {
  return {
    since: range?.since ?? since ?? row.usage.first_day ?? undefined,
    until: range?.until ?? until ?? row.usage.last_day ?? undefined,
  };
}

function actionLabel(action: CoverageAction, t: (en: string, pl: string) => string): string {
  switch (action) {
    case "declare-plan-history": return t("Declare plan history", "Zadeklaruj historię planu");
    case "review-observed-plan-history": return t("Review observed plan", "Sprawdź obserwowany plan");
    case "confirm-capacity-regimes": return t("Confirm capacity periods", "Potwierdź okresy warunków limitu");
    case "collect-reset-anchors": return t("Review reset cadence and dates", "Sprawdź rytm i daty resetów");
    case "start-gauge-collection": return t("Start gauge collection", "Uruchom zbieranie pomiarów");
  }
}

function actionTarget(action: CoverageAction, row: HistoryCoverageRow, since: string | undefined, until: string | undefined, t: (en: string, pl: string) => string, range?: PlanGap): DataSettingsTarget | null {
  const dates = dateContext(row, since, until, range);
  if (action === "declare-plan-history" || action === "review-observed-plan-history" || action === "confirm-capacity-regimes") {
    return {
      // Both open the account in Settings → Accounts: plan history on its timeline, capacity periods in its promotions.
      area: action === "confirm-capacity-regimes" ? "subscriptions" : "periods",
      account: row.subscription,
      ...dates,
      issue: action === "declare-plan-history"
        ? t("Declare dated plan history for this subscription.", "Zadeklaruj datowaną historię planu dla tej subskrypcji.")
        : action === "review-observed-plan-history"
          ? t("Review observed plan history before using it for capacity.", "Sprawdź obserwowaną historię planu przed użyciem jej do pojemności.")
          : t("Confirm dated capacity periods for this subscription.", "Potwierdź datowane okresy warunków limitu dla tej subskrypcji."),
    };
  }
  if (action === "collect-reset-anchors") {
    return {
      area: "cadence",
      account: row.subscription,
      ...dates,
      issue: t("Review reset cadence and dates; configuration cannot recreate missing measured samples.", "Sprawdź rytm i daty resetów; konfiguracja nie odtworzy brakujących pomiarów."),
    };
  }
  return null;
}

function mergeMarkers(automatic: TimelineMarker[], manual: TimelineMarker[]): TimelineMarker[] {
  const byId = new Map<string, TimelineMarker>();
  for (const marker of automatic) byId.set(marker.id, marker);
  for (const marker of manual) byId.set(marker.id, marker);
  return [...byId.values()].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

export function HistoryDataSettings({ account, since, until, onNavigate }: HistoryDataSettingsProps) {
  const { t } = useI18n();
  const allAccounts = account === "all" || account === "__all__";
  const coverageState = useAsync(() => api.historyCoverage(allAccounts ? undefined : account), [account]);
  const coverageRows = coverageState.data?.subscriptions ?? [];
  const availableProviders = useMemo(() => [...new Set(coverageRows.map((row) => markerProvider(row.vendor)).filter((value): value is string => !!value))].sort(providerOrder), [coverageRows]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>("codex");
  const selectedAccountProvider = coverageRows.find((row) => row.subscription === account);
  const defaultProvider = availableProviders.includes("codex") ? "codex" : availableProviders[0] ?? null;
  const provider = allAccounts
    ? selectedProvider && availableProviders.includes(selectedProvider) ? selectedProvider : defaultProvider
    : selectedAccountProvider ? markerProvider(selectedAccountProvider.vendor) : null;
  const markerState = useAsync<MarkerScope | null>(async () => provider
    ? { provider, response: await api.subscriptionTimelineMarkers(provider) }
    : null, [provider]);
  const [editingMarkers, setEditingMarkers] = useState(false);
  useEffect(() => { setEditingMarkers(false); }, [provider]);
  const markerData = provider && markerState.data?.provider === provider ? markerState.data.response : null;
  const allMarkers = useMemo(
    () => mergeMarkers(markerData?.automatic ?? [], markerData?.markers ?? []),
    [markerData],
  );
  const hiddenMarkers = allMarkers.filter((marker) => !marker.visible).length;

  function navigateRates(row: HistoryCoverageRow): void {
    onNavigate({
      area: "rates",
      account: row.subscription,
      ...dateContext(row, since, until),
      issue: t("Review model rates for this archive interval.", "Sprawdź stawki modeli dla tego przedziału archiwum."),
    });
  }

  function planActionRanges(row: HistoryCoverageRow, action: CoverageAction): PlanGap[] {
    if (action !== "declare-plan-history" && action !== "review-observed-plan-history") return [];
    return planGaps(row);
  }

  async function saveMarker(marker: TimelineMarker): Promise<void> {
    const current = provider && markerState.data?.provider === provider ? markerState.data.response : null;
    if (!provider || !current) return;
    await api.saveSubscriptionTimelineMarker(provider, { revision: current.revision, marker });
    refreshApiData();
    markerState.reload();
  }

  async function removeMarker(id: string): Promise<void> {
    const current = provider && markerState.data?.provider === provider ? markerState.data.response : null;
    if (!provider || !current) return;
    await api.saveSubscriptionTimelineMarker(provider, { revision: current.revision, remove: id });
    refreshApiData();
    markerState.reload();
  }

  return <div style={{ display: "grid", gap: "var(--s-8)" }}>
    <Card>
      <CardTitle
        title={t("Archive history range", "Zakres historii archiwum")}
        help={t("Whole indexed archive; this view does not certify completeness.", "Całe zaindeksowane archiwum; ten widok nie potwierdza kompletności.")}
      />
      <p>
        {t("The table reads the complete indexed archive. Selected dates only provide context for the actions below; they do not narrow these history figures.", "Tabela odczytuje całe zaindeksowane archiwum. Wybrane daty są tylko kontekstem dla poniższych działań; nie zawężają tych wartości historii.")}
        {(since || until) && <> {t("Requested context", "Żądany kontekst")}: <span className="mono">{since ?? "—"} → {until ?? "—"}</span>.</>}
      </p>
      {coverageState.error && <ErrorState message={coverageState.error} onRetry={coverageState.reload} />}
      {coverageState.loading && !coverageState.data && <LoadingCard shape="table" />}
      {coverageState.data && <>
        <Table tableId="HistoryDataSettings:0">
          <thead><TableRow header>
            <Th columnId="c0">{t("Subscription", "Subskrypcja")}</Th>
            <Th columnId="c1">{t("Usage first / last", "Zużycie pierwszy / ostatni")}</Th>
            <Th columnId="c2">{t("Gauge first / reset samples", "Pomiar pierwszy / próbki resetu")}</Th>
            <Th columnId="c3">{t("Plan uncovered days", "Dni bez historii planu")}</Th>
            <Th columnId="c4">{t("Declared capacity periods", "Wpisane okresy warunków limitu")}</Th>
            <Th columnId="c5">{t("Actions", "Akcje")}</Th>
          </TableRow></thead>
          <tbody>
            {coverageRows.map((row) => <TableRow key={row.subscription}>
              <Td>{row.subscription}</Td>
              <Td mono>
                {row.usage.first_day ?? "—"} → {row.usage.last_day ?? "—"}
                <div style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>{row.usage.active_days} {t("active days", "aktywnych dni")} · {row.usage.calls} {t("source records (may include copies)", "zapisów źródeł (mogą obejmować kopie)")}</div>
              </Td>
              <Td mono>
                <div>{row.gauge.first_at ?? "—"}</div>
                <div style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>{row.gauge.reset_samples} {t("reset samples", "próbek resetu")} · {row.gauge.samples} {t("samples", "próbek")}</div>
              </Td>
              <Td mono>
                {row.plan_history.uncovered_usage_days}
                <div style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>{row.plan_history.status} · {row.plan_history.plan_periods} {t("plan periods", "okresów planu")}</div>
              </Td>
              <Td mono>
                {row.capacity_history.declared_regimes}
                <div style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>{row.capacity_history.status === "explicit" ? t("explicit entries", "wpisane okresy") : t("unconfirmed conditions", "brak potwierdzonych warunków")}</div>
              </Td>
              <Td>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {row.actions.map((action) => {
                    const ranges = planActionRanges(row, action);
                    if (ranges.length) {
                      const current = ranges.filter(range => (!since || range.until >= since) && (!until || range.since <= until));
                      const other = ranges.filter(range => !current.includes(range));
                      const renderRange = (range: PlanGap, clip = false) => {
                        const from = clip && since && since > range.since ? since : range.since;
                        const to = clip && until && until < range.until ? until : range.until;
                        const selected = { since: from, until: to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 };
                        const target = actionTarget(action, row, since, until, t, selected);
                        return target && <GhostButton key={`${action}:${from}:${to}`} onClick={() => onNavigate(target)} title={target.issue}>{actionLabel(action, t)} · {from} → {to} ({selected.days} {t("days", "dni")})</GhostButton>;
                      };
                      return <div key={action} style={{ display: "grid", gap: 6 }}>
                        {(since || until) ? <>{current.map(range => renderRange(range, true))}{!!other.length && <details><summary>{t("Other uncovered dates", "Pozostałe daty bez planu")} ({other.length})</summary><div style={{ display: "grid", gap: 6 }}>{other.map(range => renderRange(range))}</div></details>}</>
                          : <details><summary>{actionLabel(action, t)} ({ranges.length} {t("intervals", "przedziałów")})</summary><div style={{ display: "grid", gap: 6 }}>{ranges.map(range => renderRange(range))}</div></details>}
                      </div>;
                    }
                    const target = actionTarget(action, row, since, until, t);
                    if (!target) return <span key={action} style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }} title={t("Use the existing Sync or top button after machine setup. No measurements are invented here.", "Użyj istniejącego przycisku Sync lub przycisku na górze po skonfigurowaniu maszyny. Nie tworzymy tu pomiarów." )}>{actionLabel(action, t)}: {t("use Sync / top button after machine setup", "użyj Sync / przycisku na górze po konfiguracji maszyny")}</span>;
                    return <GhostButton key={action} onClick={() => onNavigate(target)} title={target.issue}>{actionLabel(action, t)}</GhostButton>;
                  })}
                  <GhostButton onClick={() => navigateRates(row)} title={t("Open dated model rates for this subscription", "Otwórz datowane stawki modeli dla tej subskrypcji")}>{t("Review rates", "Sprawdź stawki")}</GhostButton>
                </div>
                {row.actions.includes("collect-reset-anchors") && <div style={{ marginTop: 7, color: "var(--muted)", fontSize: "var(--fs-3)" }}>{t("Cadence configuration does not recreate missing measured samples.", "Konfiguracja cyklu nie odtworzy brakujących pomiarów.")}</div>}
              </Td>
            </TableRow>)}
          </tbody>
        </Table>
        {!coverageRows.length && <p role="status">{t("No subscriptions are covered in the indexed archive.", "W zaindeksowanym archiwum nie ma pokrytych subskrypcji.")}</p>}
      </>}
    </Card>

    <Card>
      <CardTitle
        title={t("Timeline events", "Zdarzenia osi czasu")}
        sub={provider
          ? `${t("Full provider archive", "Pełne archiwum dostawcy")} · ${provider}`
          : t("Provider is loading or unknown; timeline points are hidden.", "Dostawca jest wczytywany lub nieznany; punkty osi czasu są ukryte.")}
        right={allAccounts && availableProviders.length > 0 && <label className="mono" style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>
          {t("Provider", "Dostawca")} <Dropdown value={provider ?? ""} onChange={(value) => { setSelectedProvider(value || null); setEditingMarkers(false); }}
            options={availableProviders.map((value) => ({ value, label: value }))} />
        </label>}
      />
      {provider && markerState.error && <ErrorState message={markerState.error} onRetry={markerState.reload} />}
      {!provider && <p role="status">{t("No timeline points are shown until the provider is known from account history.", "Punkty osi czasu pojawią się dopiero po ustaleniu providera z historii konta.")}</p>}
      {provider && markerState.loading && !markerData && <LoadingCard height={120} shape="table" />}
      {provider && markerData && <>
        <p>
          {allMarkers.length} {t("points", "punktów")} · {markerData.automatic.length} {t("automatic", "automatycznych")} · {markerData.markers.length} {t("manual", "ręcznych")} · {hiddenMarkers} {t("hidden, including suggestions", "ukrytych, w tym sugestii")}.
        </p>
        <p style={{ color: "var(--muted)" }}>{t("Events annotate this provider timeline only; they do not modify charges or measured percentages. Hidden suggestions remain in this list.", "Zdarzenia opisują tylko oś czasu tego providera; nie zmieniają opłat ani zmierzonych procentów. Ukryte sugestie pozostają na tej liście.")}</p>
        <GhostButton disabled={markerState.loading} onClick={() => setEditingMarkers(true)}>{t("Edit all points", "Edytuj wszystkie punkty")} ({allMarkers.length})</GhostButton>
        {editingMarkers && <CodexMarkerEditor
          markers={allMarkers}
          initialDay={since}
          onClose={() => setEditingMarkers(false)}
          onSave={saveMarker}
          onRemove={removeMarker}
        />}
      </>}
    </Card>
  </div>;
}
