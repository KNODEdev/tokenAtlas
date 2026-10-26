import { useEffect, useRef, useState } from "react";
import { api, refreshApiData, type AnalysisRebuildScope, type AnalysisRebuildJob } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useAsync } from "../lib/useAsync";
import { Card, CardTitle, Dropdown, Field, GhostButton, HelpDot } from "./ui";
import { parseRebuildOptions, REBUILD_DAYS, type RebuildMode } from "../../shared/analysis-rebuild";
import { timeRangeLabel } from "../../shared/time-range-presets";

export function AnalysisRebuildControl() {
  const { t } = useI18n();
  const state = useAsync(api.analysisRebuildStatus, []);
  const [scope, setScope] = useState<AnalysisRebuildScope>("all");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [mode, setMode] = useState<RebuildMode>("archive");
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false), observed = useRef(0);
  const job = state.data?.job;
  const running = job?.state === "queued" || job?.state === "running";
  const busy = requesting || running || state.loading;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(state.reload, 2000);
    return () => clearInterval(timer);
  }, [running, state.reload]);
  useEffect(() => {
    if (running && job) observed.current = job.generation;
    if (job?.state === "complete" && observed.current === job.generation) {
      observed.current = 0;
      refreshApiData();
    }
  }, [running, job]);
  const rebuild = async (resume=false) => {
    if (pending.current || busy) return;
    pending.current = true;
    setRequesting(true); setError(null);
    try {
      const result = await (resume?api.resumeAnalysis():api.rebuildAnalysis(scope === "custom" ? parseRebuildOptions({scope,from,until,mode}) : mode==="archive"?scope:{scope,mode}));
      observed.current = result.generation;
      refreshApiData();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setRequesting(false); }
  };
  return <Card>
    <CardTitle title={t("Recalculate data", "Przeliczanie danych")}
      help={t("All accounts and providers, regardless of the selected filters.", "Wszystkie konta i dostawcy, niezależnie od wybranych filtrów.")} />
    <div className="ui-toolbar">
      <Field label={t("Period (UTC)", "Zakres (UTC)")}>
        <Dropdown className="ui-input" ariaLabel={t("Recalculation period", "Zakres przeliczania")} value={scope}
          onChange={value => setScope(value as AnalysisRebuildScope)} disabled={busy} options={[
            { value: "all", label: t("Entire history", "Cała historia") },
            ...REBUILD_DAYS.filter(days => days !== 365).map(days => ({ value: days===7?"week":days===30?"month":`${days}d`,
              label: timeRangeLabel(days, t) })),
            { value: "custom", label: t("Custom dates", "Własne daty") },
          ]} />
      </Field>
      {scope === "custom" && <>
        <Field label={t("From (UTC, inclusive)", "Od (UTC, włącznie)")}><input type="date" className="ui-date-input" aria-label={t("Start date UTC", "Data początkowa UTC")} value={from} max={until || undefined} onChange={event=>setFrom(event.target.value)} disabled={busy}/></Field>
        <Field label={t("Until (UTC, inclusive)", "Do (UTC, włącznie)")}><input type="date" className="ui-date-input" aria-label={t("End date UTC", "Data końcowa UTC")} value={until} min={from || undefined} onChange={event=>setUntil(event.target.value)} disabled={busy}/></Field>
      </>}
      <Field label={t("Sources", "Źródła")}>
        <Dropdown className="ui-input" ariaLabel={t("Rebuild source mode", "Tryb źródeł odbudowy")} value={mode} disabled={busy} onChange={value=>setMode(value as RebuildMode)} options={[
          { value: "archive", label: t("Rebuild from archive", "Odbuduj z archiwum") },
          { value: "collect-archive", label: t("Collect available sources, then rebuild", "Zbierz dostępne źródła, potem odbuduj") },
        ]} />
      </Field>
      <GhostButton onClick={()=>rebuild()} disabled={busy}>
        {requesting || running ? t("Recalculating…", "Przeliczanie…") : scope === "all"
          ? t("Recalculate everything from scratch", "Przelicz wszystko od nowa")
          : t("Recalculate this period from scratch", "Przelicz ten okres od nowa")}
      </GhostButton>
      {job?.state==="error" && <GhostButton onClick={()=>rebuild(true)} disabled={busy}>
        {t("Resume from the last completed step", "Wznów od ostatniego ukończonego etapu")}
      </GhostButton>}
      <HelpDot label={t("Recalculation scope", "Zakres przeliczania")}>{t(
        "Rereads available source files for this period, rebuilds valuations and summaries, then prepares reports for all accounts. Sessions crossing the selected dates are read in full. Progress survives restart. Unavailable sources keep their previous indexed data and are reported. Source logs, prices and settings are preserved.",
        "Ponownie odczytuje dostępne pliki źródłowe dla tego okresu, odbudowuje wyceny i podsumowania, a następnie przygotowuje raporty wszystkich kont. Sesje przecinające wybrane daty są odczytywane w całości. Postęp jest zachowany po restarcie. Niedostępne źródła zachowują wcześniejsze dane i są zgłaszane. Logi źródłowe, ceny i ustawienia zostają zachowane.",
      )}</HelpDot>
    </div>
    <RebuildJobStatus job={job} />
    {job?.warnings?.map(warning=><p key={warning} className="stats-count">{warning}</p>)}
    {(error || state.error || job?.error) && <p role="alert" className="ui-alert">{error || state.error || job?.error}</p>}
  </Card>;
}

const jobMessages: Record<AnalysisRebuildJob["state"], [string, string]> = {
  queued: ["Queued; will start when current data writes finish.", "Zlecono — rozpocznie się po zakończeniu bieżącego zapisu danych."],
  running: ["Rebuilding summaries… You can leave this screen.", "Trwa odbudowa podsumowań… Możesz opuścić ten ekran."],
  complete: ["Recalculation complete. Summaries and reports are ready.", "Przeliczanie zakończone. Podsumowania i raporty są gotowe."],
  error: ["Recalculation failed. Retry after resolving the error.", "Przeliczanie nie powiodło się. Po usunięciu błędu ponów próbę."],
};
function RebuildJobStatus({job}: {job:AnalysisRebuildJob|null|undefined}) {
  const {t} = useI18n();
  if (!job) return null;
  return <p role="status" className="stats-count">
    {job.range ? `${job.range.from} – ${job.range.until}: ` : `${t("Entire history", "Cała historia")}: `}
    {job.state==="running" && job.phase==="sources" ? t("Rereading available source files…", "Ponowny odczyt dostępnych plików źródłowych…")
      :job.state==="running" && job.phase==="reports" ? `${t("Preparing reports", "Przygotowanie raportów")}: ${job.completed??0} / ${job.total??"…"}`
      :t(...jobMessages[job.state])}
  </p>;
}
