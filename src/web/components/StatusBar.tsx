import { useEffect, useRef, type ReactNode } from "react";
import type { AppActivity as ActivitySnapshot } from "../../shared/app-activity";
import type { AnalysisRebuildJob, SyncStatus } from "../lib/api";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import { getLocale, useI18n, type MessageTranslator } from "../lib/i18n";
import { dayTime } from "../lib/format";
import { useStaleReportTime } from "../lib/report-freshness";
import { useAppActivity } from "../lib/useAppActivity";
import { backgroundTasks, isSyncScope, overallFraction, vendorName, type BackgroundTask } from "../lib/progress";
import { missingRateAlert, tokenAmount, useMissingRates } from "../lib/missing-rate";
import { probeNoticeLines, useProbeNotices } from "../lib/probe-notices";
import type { ProbeNotice } from "../../shared/probe-error";
import { requestSettingsTab } from "../lib/settings-link";
import type { MissingRateSummary } from "../../shared/missing-rate";
import { isOpenCreditNotice, type CreditNoticeView } from "../../shared/credit-notices";
import { api } from "../lib/api";
import { creditNoticeAlert, creditNoticeLine, creditNoticeSuffix, useCreditNotices } from "../lib/credit-notices";
import { AppActivityDetails, viewName } from "./AppActivity";
import "./StatusBar.css";
import { ClaudeConnect } from "./ClaudeConnect";
import { CloudSessionsHelp } from "./CloudSessionsHelp";
import { cloudSessionProblems, useCloudSessions } from "../lib/cloud-sessions";
import type { CloudSessionsResponse } from "../../shared/cloud-sessions";
import { GhostButton } from "./ui";
import { BOOTSTRAP_STAGES, bootstrapStageIndex, bootstrapStageLabel, DetailsChevron, LiveMark, RemapActivity,
  StartupActivity, SYNC_ACTIVITY_HEIGHT, SyncSources, SyncSummaryContent, useElapsed, useSyncView } from "./SyncActivity";

type Rebuild = { job: AnalysisRebuildJob | null; unavailable: boolean };
export type StatusBarProps = {
  sync: SyncStatus | null;
  syncUnavailable: boolean;
  syncObservedAt: number | null;
  rebuild: Rebuild;
  waitingForSubscriptions: boolean;
  stickyTop: number;
  compact?: boolean;
  onOpenSettings: () => void;
  /** Selects a subscription (a package notice's "Open subscription"). */
  onOpenAccount?: (account: string) => void;
};
type Tone = "busy" | "ok" | "warn" | "error" | "unknown";
/** One line of application state; `progress` is shown only when it is actually measured. */
export type StatusLine = { tone: Tone; title: string; detail: string;
  progress: { completed: number; total: number } | "indeterminate" | null; startedAt?: string | null };

const REMAP_PHASES = 4;
const REBUILD_PHASES = 3;

function time(value: string): string {
  return new Date(value).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
}

/**
 * The single state the bar reports, most urgent first. A running synchronization is not handled
 * here: the bar then shows the synchronization itself, with its sources and counts.
 */

export function statusLine({ sync, syncUnavailable, rebuild, waitingForSubscriptions, activity, staleAt, missingRates, probeNotices, creditNotices, cloudSessions, cloudSessionsError, overall = null, tasks = [], now = Date.now(), t }: {
  sync: SyncStatus | null; syncUnavailable: boolean; rebuild: Rebuild; waitingForSubscriptions: boolean;
  activity: { data: ActivitySnapshot | null; unavailable: boolean }; staleAt: number | null;
  /** Models in traffic without a price; an otherwise current state says so instead of "Data up to date". */
  missingRates?: MissingRateSummary | null;
  /** Accounts whose limit readings stopped until the user signs in again. */
  probeNotices?: readonly ProbeNotice[] | null;
  /** Open package notices: a warning takes the line after a missing price; arrivals extend "Data up to date". */
  creditNotices?: readonly CreditNoticeView[] | null;
  cloudSessions?: CloudSessionsResponse | null;
  cloudSessionsError?: string | null;
  /** Share of the background work done (`overallFraction`), shown after the task count. */
  overall?: number | null;
  /** Background tasks of the current stretch (`backgroundTasks`). */
  tasks?: readonly BackgroundTask[];
  now?: number;
  t: MessageTranslator;
}): StatusLine {
  const job = rebuild.job;
  if (!sync && syncUnavailable) return { tone: "unknown", title: t("Status unavailable", "Status niedostępny"),
    detail: t("Cannot reach the server. Retrying automatically.", "Brak połączenia z serwerem. Ponawiam automatycznie."), progress: null };
  if (sync?.remap?.running) {
    const current = Math.max(0, Math.min(sync.remap.progress?.phase_index ?? 0, REMAP_PHASES));
    return { tone: "busy", title: t("Updating project assignments", "Aktualizuję przypisania projektów"),
      detail: `${browserSafeDiagnostic(sync.remap.message)} · ${t("stage", "etap")} ${current}/${REMAP_PHASES}`,
      progress: { completed: current, total: REMAP_PHASES }, startedAt: sync.remap.started_at };
  }
  if (sync?.bootstrap?.running) {
    const index = Math.max(0, bootstrapStageIndex(sync.bootstrap));
    const stage = BOOTSTRAP_STAGES[Math.min(index, BOOTSTRAP_STAGES.length - 1)]!.stage;
    return { tone: "busy", title: t("Preparing the local Atlas index", "Przygotowuję lokalny indeks Atlas"),
      detail: `${bootstrapStageLabel(stage)} · ${t("stage", "etap")} ${index + 1}/${BOOTSTRAP_STAGES.length}`
        + (sync.bootstrap.status === "full-ingest-required"
          ? ` · ${t("no compatible snapshot, full safety ingest", "brak zgodnego snapshotu, pełny ingest bezpieczeństwa")}` : ""),
      progress: { completed: index, total: BOOTSTRAP_STAGES.length }, startedAt: sync.bootstrap.started_at };
  }
  if (job && (job.state === "running" || job.state === "queued")) {
    const phase = job.phase === "reports" ? 2 : job.phase === "summaries" ? 1 : 0;
    const label = [t("Source files", "Pliki źródłowe"), t("Summaries", "Podsumowania"), t("Reports", "Raporty")][phase]!;
    const scope = job.range ? `${job.range.from} – ${job.range.until}` : t("entire history", "cała historia");
    const counted = job.phase === "reports" && job.total != null && job.total > 0 && job.completed != null;
    const waiting = activity.data?.providers.filter(provider => [provider.register, provider.facts]
      .some(stage => stage && ["pending", "retiring", "backfill", "replay"].includes(stage.state))).map(provider => provider.provider) ?? [];
    const detail = job.state === "queued" ? t("waiting for current data writes to finish", "czeka na zakończenie bieżących zapisów")
      : counted ? `${job.completed} / ${job.total} ${t("reports", "raportów")}`
      : job.phase === "reports" && waiting.length ? `${t("waiting for prepared prices", "czeka na przygotowanie cen")}: ${waiting.join(", ")}`
      : job.phase === "summaries" ? t("recalculating summaries", "przeliczam podsumowania")
      : t("no item count for this step yet", "ten etap nie podaje jeszcze liczby elementów");
    return { tone: "busy", title: `${t("Data rebuild", "Przebudowa danych")} · ${phase + 1}/${REBUILD_PHASES} ${label}`,
      detail: `${scope} · ${detail}`, progress: counted ? { completed: job.completed!, total: job.total! } : "indeterminate",
      startedAt: job.requestedAt };
  }
  if (job?.state === "error") return { tone: "error", title: t("Data rebuild stopped", "Przebudowa danych zatrzymana"),
    detail: browserSafeDiagnostic(job.error ?? t("Rebuild failed", "Przebudowa nie powiodła się")), progress: null };
  const views = activity.data?.reports.views.reduce((sum, view) => sum + view.pending, 0) ?? 0;
  const preparing = activity.data?.providers.filter(provider => [provider.register, provider.facts]
    .some(stage => stage && ["pending", "retiring", "backfill", "replay"].includes(stage.state))).map(provider => provider.provider) ?? [];
  if (activity.data?.busy || waitingForSubscriptions || staleAt != null) {
    // One short line: how many tasks of this stretch finished and the share of the whole; the details list them.
    const finished = tasks.filter(task => !task.entry).length;
    const failed = activity.data?.reports.views.filter(view => view.failed > 0) ?? [];
    const parts = [tasks.length ? t("{0} of {1} tasks", `${finished} z ${tasks.length} zadań`, [finished, tasks.length]) : "",
      overall !== null && tasks.length ? `~${Math.floor(overall * 100)}%` : "",
      preparing.length && !tasks.length ? `${t("prices", "ceny")}: ${preparing.map(vendorName).join(", ")}` : "",
      views ? `${views} ${t("views queued", "widoków w kolejce")}` : "",
      ...failed.map(view => `${viewName(view.view, t)}: ${view.failed} ${t("failed", "błąd")}`)].filter(Boolean);
    return { tone: "busy", title: t("Preparing data in the background", "Przygotowuję dane w tle"),
      detail: parts.join(" · ") || t("the visible data will refresh automatically", "widoczne dane odświeżą się automatycznie"),
      progress: overall !== null && tasks.length ? { completed: Math.floor(overall * 100), total: 100 } : "indeterminate" };
  }
  const run = sync?.run;
  const finished = sync?.finished_at ?? run?.finishedAt ?? null;
  if (run?.status === "failure") return { tone: "error", title: t("Last synchronization failed", "Ostatnia synchronizacja nie powiodła się"),
    detail: `${finished ? `${time(finished)} · ` : ""}${browserSafeDiagnostic(run.error ?? t("no details", "brak szczegółów"))}`, progress: null };
  const partial = run?.status === "partial_success";
  if (cloudSessionsError && sync) return { tone: "warn", title: t("Cloud import status unavailable", "Status importu chmury niedostępny"),
    detail: t("Cloud import details in events", "Szczegóły importu chmury w zdarzeniach"), progress: null };
  if (cloudSessionProblems(cloudSessions).length && sync) return { tone: "warn",
    title: t("Claude cloud history incomplete", "Niepełna historia Claude z chmury"),
    detail: t("Cloud import details in events", "Szczegóły importu chmury w zdarzeniach"), progress: null };
  // A reading not taken while a sign-in is expired is lost for good (a missing price applies later too), so it
  // comes first among the warnings; the details list every account and computer.
  const notices = probeNoticeLines(probeNotices);
  if (notices.length && sync) return { tone: "warn", title: notices[0]!.head, detail: `${notices[0]!.tail}${notices.length > 1
    ? ` · ${t("and {0} more (details)", `i ${notices.length - 1} więcej (szczegóły)`, [notices.length - 1])}` : ""}`, progress: null };
  // A missing price skews every amount on screen, so it outranks a partial synchronization (whose
  // sources stay listed in the details); failures and running work still come first.
  const alert = missingRateAlert(missingRates, 1) ?? creditNoticeAlert(creditNotices, now);
  if (alert && sync) return { tone: "warn", title: alert.title, detail: `${alert.detail} · ${partial
    ? t("last synchronization completed with issues (details)", "ostatnia synchronizacja z problemami (szczegóły)")
    : finished ? `${t("last synchronization", "ostatnia synchronizacja")} ${time(finished)}` : t("no synchronization yet", "brak synchronizacji")}`, progress: null };
  if (partial) return { tone: "warn",
    title: t("Last synchronization completed with issues", "Ostatnia synchronizacja zakończona z problemami"),
    detail: `${finished ? `${time(finished)} · ` : ""}${t("details show which sources were not read", "szczegóły pokazują, których źródeł nie odczytano")}`,
    progress: null };
  if (!sync) return { tone: "unknown", title: t("Checking status", "Sprawdzam stan"), detail: "", progress: null };
  const synchronized = finished ? `${t("last synchronization", "ostatnia synchronizacja")} ${time(finished)}` : t("no synchronization yet", "brak synchronizacji");
  const arrivals = creditNoticeSuffix(creditNotices);
  return { tone: "ok", title: t("Data up to date", "Dane aktualne"), detail: arrivals ? `${synchronized} · ${arrivals}` : synchronized, progress: null };
}

/** Stored package history; acknowledgement clears alerts without removing rows. */
export function CreditNotices({ notices, now, onOpenAccount, onRead }: { notices: readonly CreditNoticeView[]; now: number;
  onOpenAccount?: (account: string) => void; onRead: (ids: number[]) => void }) {
  const { t } = useI18n();
  // Opening a subscription closes the panel so it does not cover the selected account.
  const ref = useRef<HTMLDivElement>(null);
  const unread = notices.filter(notice => notice.acknowledged_at == null).map(notice => notice.id);
  const rows = notices.map(notice => {
    const line = creditNoticeLine(notice, now);
    return { notice, line, action: !!onOpenAccount && isOpenCreditNotice(notice) && line.tone === "warn" };
  });
  return (
    <div ref={ref} data-credit-notices className="status-event">
      <div className="status-event-head">
        <strong>{t("Packages", "Pakiety")}<span className="status-event-count mono">{notices.length}</span></strong>
        <div className="status-event-actions">
          <GhostButton disabled={!unread.length} onClick={() => onRead(unread)}>{t("Mark as read", "Oznacz jako przeczytane")}</GhostButton>
        </div>
      </div>
      {/* One row per notice: the panel is wide enough for columns, so nothing wraps into a second line. */}
      <table className="ui-table status-event-table">
        <thead><tr>
          <th className="ui-th">{t("Event", "Zdarzenie")}</th>
          <th className="ui-th">{t("Subscription", "Subskrypcja")}</th>
          <th className="ui-th">{t("Details", "Szczegóły")}</th>
          <th className="ui-th status-event-when">{t("When", "Kiedy")}</th>
        </tr></thead>
        <tbody>
          {rows.map(({ notice, line, action }) => {
            const tooltip = [notice.occurred_at,
              notice.acknowledged_at && `${t("Read", "Przeczytane")}: ${dayTime(notice.acknowledged_at)}`,
              notice.resolved_at && `${t("Resolved", "Nieaktualne")}: ${dayTime(notice.resolved_at)}`].filter(Boolean).join(" · ");
            return <tr key={notice.id} title={tooltip} className={isOpenCreditNotice(notice) ? undefined : "is-closed"}>
              <td className="ui-td"><strong className={line.tone === "warn" ? "is-warn" : line.tone === "ok" ? "is-ok" : undefined}>{line.title}</strong></td>
              <td className="ui-td status-event-who" title={notice.label}>
                <span aria-hidden="true" className="status-event-dot" style={{ background: `var(--${notice.provider}, var(--faint))` }} />
                {/* An open warning links its subscription instead of a button column that would narrow the details. */}
                {action ? <button type="button" className="status-event-link" title={t("Open subscription", "Otwórz subskrypcję")}
                  onClick={() => { ref.current?.closest("details")?.removeAttribute("open"); onOpenAccount!(notice.account); }}>
                  {notice.label}</button> : <span>{notice.label}</span>}</td>
              <td className="ui-td status-event-facts">{line.facts}</td>
              <td className="ui-td is-num status-event-when">{line.when}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Models listed by name in the details; the rest are counted. */
const MISSING_RATE_ROWS = 5;

const TONE_COLOR: Record<Tone, string> = { busy: "var(--accent)", ok: "var(--ok)", warn: "var(--warn)", error: "var(--crit)", unknown: "var(--faint)" };

/** The one permanent place for application progress: always visible, never shifting the layout. */
export function StatusBar(props: StatusBarProps) {
  const { t } = useI18n();
  const activity = useAppActivity();
  const staleAt = useStaleReportTime();
  const { sync, rebuild, stickyTop, compact = false } = props;
  const missingRates = useMissingRates();
  const credit = useCreditNotices();
  const probeNotices = useProbeNotices();
  const cloudRead = useCloudSessions();
  const cloudSessions = cloudRead.data;
  const cloudProblems = [...(cloudRead.error ? [cloudRead.error] : []), ...cloudSessionProblems(cloudSessions)];
  // Scopes of the current stretch of background work; it ends when no producer reports any.
  const seen = useRef(new Map<string, number>()).current;
  const names = useRef(new Map<string, string>()).current;
  const background = (activity.data?.progress ?? []).filter(entry => !isSyncScope(entry));
  if (!background.length) { seen.clear(); names.clear(); }
  const overall = background.length ? overallFraction(background, seen) : null;
  const tasks = background.length ? backgroundTasks(background, seen, names) : [];
  const now = Date.now();
  const line = statusLine({ ...props, activity, staleAt, missingRates, probeNotices, creditNotices: credit.notices, cloudSessions, cloudSessionsError: cloudRead.error, overall, tasks, now, t });
  const alert = missingRateAlert(missingRates);
  const notices = probeNoticeLines(probeNotices);
  // The details panel closes when its button leaves for Settings, so it does not cover the opened tab.
  const alertRef = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(line.startedAt, line.tone === "busy" && !!line.startedAt);
  const state = <>
    {sync?.remap?.running && <RemapActivity remap={sync.remap} />}
    {sync?.bootstrap && (sync.bootstrap.running || sync.bootstrap.ok === false) && <StartupActivity bootstrap={sync.bootstrap} />}
    <AppActivityDetails {...props} data={activity.data} unavailable={activity.unavailable} staleAt={staleAt} tasks={tasks} />
  </>;
  const events = (
    <div className="status-details-events" data-status-events>
      <h3>{t("Events", "Zdarzenia")}</h3>
      {!notices.length && !alert && !credit.notices?.length && !cloudProblems.length && rebuild.job?.state !== "error"
        && <p className="status-details-empty">{t("No new events", "Brak nowych zdarzeń")}</p>}
      {rebuild.job?.state === "error" && <div className="status-event">
        <div className="status-event-head">
          <strong className="is-warn">{t("Rebuild stopped with an error", "Przebudowa zatrzymana z błędem")}</strong>
          <div className="status-event-actions"><GhostButton onClick={props.onOpenSettings}>
            {t("Open rebuild settings", "Otwórz ustawienia przebudowy")}</GhostButton></div>
        </div>
      </div>}
      {notices.length > 0 && <div data-probe-notices className="status-event">
        {notices.map((notice, index) => <div key={notice.key} data-probe-notice className="status-event-item">
          <div className="status-event-head">
            <strong className="is-warn">{notice.head}</strong>
            {probeNotices?.[index] && <div className="status-event-actions"><ClaudeConnect issue={probeNotices[index]!}
              reasonClassName="mono status-event-meta" /></div>}
          </div>
          <span className="status-event-meta mono">{notice.tail}</span>
        </div>)}
      </div>}
      {cloudProblems.length > 0 && <div className="status-event" data-cloud-import-warning>
        <div className="status-event-head">
          <strong className="is-warn">{cloudRead.error ? t("Cloud import status unavailable", "Status importu chmury niedostępny")
            : t("Claude cloud history incomplete", "Niepełna historia Claude z chmury")}</strong>
          <div className="status-event-actions"><CloudSessionsHelp problems={cloudProblems} /></div>
        </div>
      </div>}
      {alert && missingRates && <div ref={alertRef} data-missing-rate-alert className="status-event">
        <div className="status-event-head">
          <strong className="is-warn">{alert.title}</strong>
          <div className="status-event-actions"><GhostButton onClick={() => { alertRef.current?.closest("details")?.removeAttribute("open"); requestSettingsTab("rates"); props.onOpenSettings(); }}>
            {t("Open Price lists → Models", "Otwórz Cenniki → Modele")}</GhostButton></div>
        </div>
        <ul className="status-event-rows mono status-event-meta">
          {missingRates.models.slice(0, MISSING_RATE_ROWS).map(row => <li key={`${row.model}|${row.rate_vendor}`}>
            <span title={row.model}>{row.model}</span><span>{tokenAmount(row.tokens)}</span></li>)}
        </ul>
        {missingRates.models.length > MISSING_RATE_ROWS && <span className="status-event-meta">
          {t("and {0} more", `i ${missingRates.models.length - MISSING_RATE_ROWS} więcej`, [missingRates.models.length - MISSING_RATE_ROWS])}</span>}
      </div>}
      {!!credit.notices?.length && <CreditNotices notices={credit.notices} now={now}
        onOpenAccount={props.onOpenAccount}
        onRead={ids => { void api.acknowledgeCreditNotices(ids).then(credit.reload, credit.reload); }} />}
    </div>
  );
  if (sync?.running) {
    const job = rebuild.job;
    const context = job && (job.state === "running" || job.state === "queued") && sync.run?.rebuildGeneration === job.generation
      ? `${t("Data rebuild", "Przebudowa danych")} · 1/${REBUILD_PHASES} ${t("Source files", "Pliki źródłowe")}` : undefined;
    return <SyncStatusBar sync={sync} context={context} compact={compact} stickyTop={stickyTop} state={state} events={events} />;
  }
  const measured = line.progress && line.progress !== "indeterminate" ? line.progress : null;
  return (
    <StatusShell label={t("Application status", "Stan aplikacji")} expand={t("Expand details", "Rozwiń szczegóły")} stickyTop={stickyTop}
      summary={<>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {line.tone === "busy" ? <LiveMark /> : <span aria-hidden="true" style={{ width: 8, height: 8, flex: "0 0 auto",
            borderRadius: "var(--r-dot)", background: TONE_COLOR[line.tone] }} />}
          <div style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 9, flex: 1 }}>
            <strong style={{ minWidth: 0, fontSize: "var(--fs-4)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden",
              textOverflow: "ellipsis", color: line.tone === "error" ? "var(--crit)" : line.tone === "warn" ? "var(--warn)" : undefined }}>
              {line.title}
            </strong>
            <span className="mono" style={{ minWidth: 0, color: "var(--muted)", fontSize: "var(--fs-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {line.detail}{line.tone === "busy" && line.startedAt ? ` · ${elapsed}` : ""}
            </span>
          </div>
          <DetailsChevron />
        </div>
        <div role="progressbar" aria-label={line.title}
          aria-valuemin={measured ? 0 : undefined} aria-valuemax={measured?.total} aria-valuenow={measured ? Math.min(measured.completed, measured.total) : undefined}
          style={{ height: 6, borderRadius: "var(--r-bar)", background: "var(--sunk)", border: "1px solid var(--line)", overflow: "hidden" }}>
          {line.progress && <div style={{ height: "100%", background: "var(--accent)",
            width: measured ? `${Math.min(100, measured.completed / measured.total * 100)}%` : "30%",
            animation: measured ? undefined : "ta-pulse 1.4s ease-in-out infinite" }} />}
        </div>
      </>}
      state={state} events={events} />
  );
}

/** A running synchronization keeps the same bar and details; its sources lead the state column. */
function SyncStatusBar({ sync, context, compact, stickyTop, state, events }: { sync: SyncStatus; context?: string; compact: boolean;
  stickyTop: number; state: ReactNode; events: ReactNode }) {
  const { t } = useI18n();
  const view = useSyncView(sync, context);
  return <StatusShell label={t("Synchronization progress", "Postęp synchronizacji")}
    expand={t("Expand provider synchronization details", "Rozwiń szczegóły synchronizacji dostawców")} stickyTop={stickyTop}
    summary={<SyncSummaryContent view={view} compact={compact} />} state={<><SyncSources view={view} />{state}</>} events={events} />;
}

/** The permanent strip under the header and its details: state on the left, events on the right. */
function StatusShell({ label, expand, stickyTop, summary, state, events }: { label: string; expand: string; stickyTop: number;
  summary: ReactNode; state: ReactNode; events: ReactNode }) {
  // An open panel closes on a click outside it or on Escape, like the header menus.
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (details.current?.open && !details.current.contains(event.target as Node)) details.current.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (event.key === "Escape" && details.current?.open) details.current.open = false;
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey); };
  }, []);
  return (
    <section role="status" aria-live="polite" aria-label={label}
      style={{ position: "sticky", top: stickyTop, zIndex: "calc(var(--z-header) - 1)", height: SYNC_ACTIVITY_HEIGHT, padding: "7px 16px 6px",
        borderBottom: "1px solid var(--line2)", background: "var(--band)" }}>
      <details ref={details} className="sync-activity" style={{ position: "relative", height: "100%" }}>
        <summary title={expand} style={{ display: "grid", height: "100%", gridTemplateRows: "1fr auto", gap: 6, cursor: "pointer" }}>
          {summary}
        </summary>
        <div className="sync-activity-details status-details-columns" style={{ position: "absolute", top: "calc(100% - 1px)", left: 12, right: 12, zIndex: 24,
          border: "1px solid var(--pencil)", borderRadius: "var(--r-card)", background: "var(--surface)", boxShadow: "var(--shadow)" }}>
          <div className="status-details-state">{state}</div>
          {events}
        </div>
      </details>
    </section>
  );
}
