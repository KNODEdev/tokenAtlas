import type { AppActivity as ActivitySnapshot, ActivityStage } from "../../shared/app-activity";
import type { AnalysisRebuildJob, SyncStatus } from "../lib/api";
import { getLocale, useI18n } from "../lib/i18n";
import { progressStepLabel, vendorName, type BackgroundTask } from "../lib/progress";
import { phaseLabel } from "./SyncActivity";
import { Bar, HelpBlock, HelpDot, Pill, type Tone } from "./ui";
import "./AppActivity.css";

type ActivityProps = {
  sync: SyncStatus | null;
  syncUnavailable: boolean;
  syncObservedAt: number | null;
  rebuild: { job: AnalysisRebuildJob | null; unavailable: boolean };
  waitingForSubscriptions: boolean;
};
type DetailsProps = ActivityProps & {
  data: ActivitySnapshot | null;
  unavailable: boolean;
  staleAt: number | null;
  /** Background tasks of the current stretch (`backgroundTasks`); none while nothing is reported. */
  tasks?: readonly BackgroundTask[];
};
type T = (en: string, pl: string) => string;

const BUSY: readonly ActivityStage["state"][] = ["pending", "retiring", "backfill", "replay"];

/** A waiting view's name; an unknown one is "Other views". */
export function viewName(view: string, t: T): string {
  const names: Record<string, string> = {
    subscriptions: t("Subscriptions", "Abonamenty"), accounts: t("Accounts", "Konta"), overview: t("Overview", "Przegląd"),
    usage: t("Usage", "Zużycie"), capacity: t("Capacity", "Pojemność"), history: t("History", "Historia"), projects: t("Projects", "Projekty"),
  };
  return names[view] ?? t("Other views", "Pozostałe widoki");
}

function stageLabel(stage: ActivityStage, t: T): string {
  const labels: Record<ActivityStage["state"], string> = {
    ready: t("Prepared", "Gotowe"), retiring: t("Removing old summaries", "Usuwanie starych podsumowań"),
    backfill: t("Building history", "Przygotowanie historii"), replay: t("Applying changes", "Nanoszenie zmian"),
    pending: t("Awaiting preparation", "Oczekuje na przygotowanie"), missing: t("Not prepared yet", "Jeszcze nieprzygotowane"),
    unavailable: t("Status unavailable", "Status niedostępny"),
  };
  return labels[stage.state];
}

const time = (value: number) => new Date(value).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shortTime = (value: string | number) => new Date(value).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
const count = (value: number) => value.toLocaleString(getLocale());

/** One task row: name, bar and its count; the step and any wait go into the row's tooltip. */
function TaskRow({ task, waitingFor, t }: { task: BackgroundTask; waitingFor: string; t: T }) {
  const entry = task.entry;
  const counted = entry && entry.total !== null && entry.total > 1;
  const units: Record<string, [string, string]> = {
    files: ["files", "plików"], records: ["records", "rekordów"], indexes: ["indexes", "indeksów"], tables: ["data sets", "zbiorów"],
    changes: ["changes", "zmian"], readings: ["readings", "odczytów"], accounts: ["accounts", "kont"], sources: ["sources", "źródeł"],
    days: ["days", "dni"], items: ["items", "elementów"],
  };
  const state = !entry ? t("done", "gotowe")
    : counted ? `${count(entry.done)} / ${count(entry.total!)} ${t(...units[entry.unit]!)}`
    : t("pending", "oczekuje");
  const title = entry ? [progressStepLabel(entry), entry.scope === "window-usage" && waitingFor ? `${t("waiting for prices", "czeka na ceny")}: ${waitingFor}` : ""]
    .filter(Boolean).join(" · ") : undefined;
  return <div className="app-activity-task" data-task={task.scope} title={title}>
    <span className="app-activity-task-name">{task.name}</span>
    <Bar value={entry ? task.fraction * 100 : 100} height={5} color={entry ? "var(--accent)" : "var(--ok)"} />
    <span className={`mono app-activity-task-state${entry ? "" : " is-done"}`}>{state}</span>
  </div>;
}

/** The synchronization in one or two words with the time of its last run. */
function syncState(sync: SyncStatus | null, unavailable: boolean, t: T): { label: string; tone: Tone } {
  const progress = sync?.running ? sync.run?.progress : null;
  if (unavailable) return { label: t("unavailable", "niedostępna"), tone: "warn" };
  if (!sync) return { label: t("checking", "sprawdzam"), tone: "neutral" };
  if (sync.bootstrap?.running) return { label: t("preparing local data", "przygotowanie lokalnych danych"), tone: "accent" };
  if (sync.running) return { label: progress ? phaseLabel(progress.phase) : t("running", "w toku"), tone: "accent" };
  if (sync.remap?.running) return { label: t("updating projects", "aktualizacja projektów"), tone: "accent" };
  if (sync.run?.status === "failure") return { label: t("failed", "nieudana"), tone: "crit" };
  if (sync.run?.status === "partial_success") return { label: t("with issues", "z problemami"), tone: "warn" };
  return { label: t("complete", "zakończona"), tone: "ok" };
}

export function AppActivityDetails({ data, unavailable, sync, syncUnavailable, syncObservedAt, rebuild, waitingForSubscriptions, staleAt, tasks = [] }: DetailsProps) {
  const { t } = useI18n();
  const job = rebuild.job;
  const rebuilding = job?.state === "running" || job?.state === "queued";
  const issueLabels = {
    "account-unavailable": t("A saved request refers to an unavailable account. Select an existing account to load the view.", "Zapisane żądanie dotyczy niedostępnego konta. Wybierz istniejące konto, aby wczytać widok."),
    "database-busy": t("Waiting for a database write to finish. The request will be retried automatically.", "Oczekiwanie na zakończenie zapisu bazy. Żądanie zostanie ponowione automatycznie."),
    "invalid-request": t("A saved request has invalid parameters. Reopen the view with a valid selection.", "Zapisane żądanie ma nieprawidłowe parametry. Otwórz widok ponownie z poprawnym wyborem."),
    "preparation-failed": t("View preparation failed. The request remains recorded for recovery.", "Przygotowanie widoku nie powiodło się. Żądanie pozostaje zapisane do ponowienia."),
  };
  const busyProviders = data?.providers.filter(provider => [provider.register, provider.facts].some(stage => stage && BUSY.includes(stage.state))) ?? [];
  const waitingFor = busyProviders.map(provider => vendorName(provider.provider)).join(", ");
  const syncNow = syncState(sync, syncUnavailable, t);
  const syncTime = sync?.running ? sync.started_at : sync?.finished_at;
  const views = data?.reports.views.filter(view => view.pending > 0 || view.failed > 0) ?? [];
  const showTasks = tasks.length > 0 || rebuilding || staleAt != null || waitingForSubscriptions;
  const syncProgress = sync?.running ? sync.run?.progress : null;
  return <div className="app-activity-content">
    {(unavailable || data?.unavailable) && <p role="alert" className="app-activity-warning">{t("Cannot read current progress. Retrying automatically; any details below are the last observed state.", "Nie można odczytać bieżącego postępu. Ponawiam automatycznie; szczegóły poniżej to ostatni odczytany stan.")}</p>}
    {showTasks && <section className="app-activity-section" data-activity-tasks>
      <h3>{t("Background tasks", "Zadania w tle")}<HelpDot>
        {staleAt != null && <HelpBlock>{t("Last consistent result", "Ostatni spójny wynik")}: {new Date(staleAt).toLocaleString(getLocale())}</HelpBlock>}
        {waitingForSubscriptions && <HelpBlock>{waitingFor ? `${t("Subscription cards are waiting for", "Karty abonamentów czekają na")}: ${waitingFor}`
          : t("Subscription cards appear when their result is ready.", "Karty abonamentów pojawią się, gdy wynik będzie gotowy.")}</HelpBlock>}
        <HelpBlock>{t("The share is the mean of the tasks; tasks without a count add their part when they finish.", "Udział to średnia zadań; zadania bez licznika dodają swoją część po zakończeniu.")}</HelpBlock>
        {data && <HelpBlock>{t("Observed since", "Obserwacja od")} {time(data.observationStartedAt)} · {t("read at", "odczyt")} {time(data.observedAt)}</HelpBlock>}
      </HelpDot></h3>
      {rebuilding && <div className="app-activity-task">
        <span className="app-activity-task-name">{t("Rebuild", "Przebudowa")}</span>
        <Bar value={job.phase === "reports" && job.completed != null && job.total ? job.completed / job.total * 100 : 0} height={5} />
        <span className="mono app-activity-task-state">{job.state === "queued" ? t("pending", "oczekuje")
          : job.phase === "sources" ? t("sources", "źródła") : job.phase === "summaries" ? t("summaries", "podsumowania")
          : job.completed != null && job.total != null ? `${job.completed} / ${job.total}` : t("reports", "raporty")}</span>
      </div>}
      {tasks.map(task => <TaskRow key={task.scope} task={task} waitingFor={waitingFor} t={t} />)}
      {!tasks.length && !rebuilding && <p className="app-activity-meta">{waitingForSubscriptions
        ? t("Preparing subscription cards", "Przygotowanie kart abonamentów") : t("Refreshing visible data", "Odświeżanie widocznych danych")}</p>}
    </section>}
    <div className="app-activity-pair">
      <section className="app-activity-section" data-activity-prices>
        <h3>{t("Prices", "Ceny")}{busyProviders.length > 0 && <HelpDot>{busyProviders.map(provider => {
          const stage = [provider.facts, provider.register].find(item => item && BUSY.includes(item.state))!;
          return <HelpBlock key={provider.provider}>{vendorName(provider.provider)}: {stageLabel(stage, t)}{stage.lastProgressAt != null
            ? ` · ${t("progress at", "postęp o")} ${time(stage.lastProgressAt)}` : ` · ${t("no progress observed yet", "bez zaobserwowanego postępu")}`}</HelpBlock>;
        })}</HelpDot>}</h3>
        {!data ? <p className="app-activity-meta">{t("Status unavailable", "Status niedostępny")}</p> : <div className="app-activity-chips">
          {data.providers.map(provider => {
            const stages = [provider.facts, provider.register].filter((stage): stage is ActivityStage => !!stage);
            const busy = stages.find(stage => BUSY.includes(stage.state));
            const off = stages.find(stage => stage.state === "unavailable" || stage.state === "missing");
            const shown = busy ?? off ?? provider.register;
            const tone: Tone = busy ? "accent" : off ? "warn" : "ok";
            return <span key={provider.provider} data-provider={provider.provider} title={stageLabel(shown, t)}>
              <Pill tone={tone}>{vendorName(provider.provider)}{busy || off ? ` · ${stageLabel(shown, t).toLocaleLowerCase(getLocale())}` : ""}</Pill></span>;
          })}
        </div>}
      </section>
      <section className="app-activity-section" data-activity-sync>
        <h3>{t("Synchronization", "Synchronizacja")}{(sync?.finished_at || sync?.started_at || syncObservedAt != null) && <HelpDot>
          {sync?.started_at && sync.running && <HelpBlock>{t("Started", "Rozpoczęto")}: {new Date(sync.started_at).toLocaleString(getLocale())}</HelpBlock>}
          {sync?.finished_at && <HelpBlock>{t("Last completed run", "Ostatni zakończony przebieg")}: {new Date(sync.finished_at).toLocaleString(getLocale())}</HelpBlock>}
          {syncObservedAt != null && <HelpBlock>{t("Status read at", "Status odczytany o")} {time(syncObservedAt)}</HelpBlock>}
        </HelpDot>}</h3>
        <p className="app-activity-line"><span className={`is-${syncNow.tone}`}>{syncNow.label}</span>
          {syncProgress?.total != null && syncProgress.completed != null && <span className="mono app-activity-meta"> · {count(syncProgress.completed)} / {count(syncProgress.total)}</span>}
          {syncTime && <span className="mono app-activity-meta"> · {shortTime(syncTime)}</span>}</p>
      </section>
    </div>
    {views.length > 0 && <section className="app-activity-section" data-activity-views>
      <h3>{t("Views", "Widoki")}{(data?.reports.truncated || views.some(view => view.issues?.length)) && <HelpDot>
        {data?.reports.truncated && <HelpBlock>{t("A portion of the queue is shown; counts are lower bounds.", "Pokazano część kolejki; liczniki są wartościami minimalnymi.")}</HelpBlock>}
        {views.flatMap(view => view.issues?.map(issue => <HelpBlock key={`${view.view}|${issue.reason}`}>{viewName(view.view, t)}: {issueLabels[issue.reason]}{issue.count > 1 ? ` (${issue.count})` : ""}</HelpBlock>) ?? [])}
      </HelpDot>}</h3>
      {views.map(view => <p key={view.view} className="app-activity-row"><span>{viewName(view.view, t)}</span><span className="mono">
        {view.pending > 0 && `${data?.reports.truncated ? "≥" : ""}${view.pending} ${t("waiting", "oczekuje")}`}
        {view.pending > 0 && view.failed > 0 && " · "}
        {view.failed > 0 && <span className="is-warn">{view.failed} {t("failed", "błąd")}</span>}</span></p>)}
    </section>}
    {rebuild.unavailable && <p className="app-activity-warning">{t("Rebuild status unavailable", "Status przebudowy niedostępny")}</p>}
  </div>;
}
