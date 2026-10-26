import { useMemo, useState } from "react";
import type { AccountCapabilities, ClaudeLimitResponse } from "../lib/api";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { claudeSections } from "../components/ClaudeSections";
import { VendorOverview } from "../components/VendorOverview";
import { WindowInsightCard } from "../components/WindowInsightCard";
import { ErrorState, LoadingCard } from "../components/ui";
import { useI18n } from "../lib/i18n";
import { buildWindowInsights } from "../lib/window-insights";
import type { RailWindow } from "../lib/windows";
import { WindowProjects } from "../components/WindowProjects";
import { OverviewProjectSelector } from "../components/OverviewProjectSelector";

export function ClaudeOverview({ capabilities, account, bounds = null, windows = [], selectedKey = null, selectedEndIso = null, onFullHistory }: {
  capabilities: AccountCapabilities | null;
  account?: string;
  /** Bounds of a closed window or counter segment picked in the rail; null reports the live window. */
  bounds?: { from: string; until: string } | null;
  /** The account's rail windows; their counters fill the status block. */
  windows?: RailWindow[];
  selectedKey?: string | null;
  selectedEndIso?: string | null;
  /** Opens History; the Overview's window table links to it. */
  onFullHistory?: () => void;
}) {
  const { t } = useI18n();
  const [project, setProject] = useState("");
  const state = useAsync<ClaudeLimitResponse>(signal => api.claudeLimitCard(account,bounds,signal), [account, bounds?.from, bounds?.until]);
  const insights = useMemo(() => buildWindowInsights(windows, Date.now(), selectedKey), [windows, selectedKey]);
  // Until the status block can render, the counters keep their own card.
  const counters = windows.length > 0
    ? <WindowInsightCard windows={windows} account={account ?? ""} selectedKey={selectedKey} selectedEndIso={selectedEndIso} />
    : null;

  if (state.error) return <>{counters}<ErrorState message={state.error} onRetry={state.reload} /></>;
  if (!state.data) return <>{counters}<LoadingCard label={t("Loading Claude window...", "Wczytywanie okna Claude...")} height={220} shape="kpi" /></>;

  const selected = selectedKey ? windows.find((window) => window.key === selectedKey) ?? null : null;
  const from = selected?.startIso ?? bounds?.from ?? state.data.current?.window_start;
  const until = selected?.resetIso ?? bounds?.until ?? state.data.current?.reset_at;
  const chartRange = from && until ? { from, until } : null;
  const projectControl = account && chartRange ? <OverviewProjectSelector account={account} range={chartRange} value={project} onChange={setProject} /> : undefined;
  const sections = claudeSections({
    capabilities, data: state.data, windows, insights, account: account ?? "",
    selectedHistorical: selected != null && !selected.isCurrent, onFullHistory, bounds,
    chartControl: projectControl,
    chartOverride: account && chartRange && project ? <WindowProjects account={account} {...chartRange} project={project} chartOnly control={projectControl}
      usedPercent={selected ? selected.scope == null ? selected.usedPercent : null : state.data.current?.percent_all_measured} /> : undefined,
  });
  const projects = account && from && until ? <WindowProjects key={JSON.stringify([account, from, until])} account={account} from={from} until={until} /> : undefined;
  return <>{sections.lead == null && counters}<VendorOverview sections={{ ...sections, openWindows: onFullHistory, projects }} /></>;
}
