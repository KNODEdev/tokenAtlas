import { useEffect, useMemo, useState } from "react";
import { VENDOR_IDS, type VendorSyncResult } from "../../sync/contracts";
import type {
  AtlasBootstrapStage,
  AtlasBootstrapStatus,
  RemapStatus,
  SyncStatus,
  VendorId,
} from "../lib/api";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import { getLocale, translate, useI18n } from "../lib/i18n";
import type { SyncPhase, SyncProgress } from "../../shared/sync-progress";
import type { ProgressEntry } from "../../shared/progress";
import { isSyncScope, progressCounter, progressStepLabel, progressText } from "../lib/progress";

/** The four waits `remap()` reports, in the order it reports them. The count is
 *  what the segment bar divides into; the labels live on the server, in the
 *  messages it sends. */
const REMAP_PHASE_COUNT = 4;

const TABLE_LABELS: Record<string, string> = {
  events: "Codex",
  claude_events: "Claude Code",
  oc_events: "OpenCode",
  grok_events: "Grok",
  gemini_events: "Antigravity",
};

export const VENDOR_LABELS: Record<VendorId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  grok: "Grok",
  gemini: "Gemini",
  gauges: "Odczyty",
};

export const SYNC_ACTIVITY_HEIGHT = 56;

export type SyncVendorStage =
  | "active"
  | "queued"
  | "success"
  | "failure"
  | "skipped"
  | "outside"
  | "idle";

export function syncVendorStage(sync: SyncStatus | null | undefined, vendor: VendorId): SyncVendorStage {
  const run = sync?.run;
  if (!run) return "idle";
  const inScope = run.scope.kind === "all" || (run.scope.kind === "vendors"
    ? run.scope.vendors.includes(vendor) : run.scope.kind === "accounts"
      ? run.scope.accounts.some(account => account.vendor === vendor) : run.scope.vendor === vendor);
  if (!inScope) return "outside";
  const result = run.vendors.find((item) => item.vendor === vendor);
  if (!result && sync.running && (run.progress?.phase === "readings" || run.progress?.phase === "scan"))
    return run.progress.phase === "scan" && vendorEntry(sync, vendor) ? "active" : "queued";
  if (!result) return run.mode === "incremental" ? "skipped" : sync.running ? "queued" : "idle";
  if (result.status === "pending") return result.startedAt ? "active" : "queued";
  return result.status;
}

const STARTUP_WRITE_STAGES = new Set<AtlasBootstrapStage>([
  "snapshot-installation",
  "migration",
  "path-rebase",
]);

export function startupWriteActive(bootstrap: AtlasBootstrapStatus | null | undefined): boolean {
  return bootstrap?.running === true && bootstrap.stage != null && STARTUP_WRITE_STAGES.has(bootstrap.stage);
}

function formatCount(value: number): string {
  return value.toLocaleString(getLocale());
}

/** Ticks only while the job runs: a finished panel showing a climbing timer
 *  would keep claiming work that already stopped. */
export function useElapsed(startedAt: string | null | undefined, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  if (!startedAt) return "0:00";
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function LiveMark() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        flex: "0 0 auto",
        borderRadius: "var(--r-dot)",
        background: "var(--accent)",
        animation: "ta-pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}

function Segments({ count, current }: { count: number; current: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        display: "grid",
        gridAutoFlow: "column",
        gridAutoColumns: "1fr",
        gap: 3,
        marginTop: 10,
      }}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          style={{
            height: 3,
            borderRadius: "var(--r-bar)",
            background: index < current ? "var(--accent)" : "var(--line2)",
            animation: index + 1 === current ? "ta-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
      ))}
    </div>
  );
}

function Heading({ title, meta }: { title: string; meta: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
      <LiveMark />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <strong style={{ fontSize: "var(--fs-5)", fontWeight: 600, color: "var(--text)" }}>{title}</strong>
        <span className="mono" style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>
          {meta}
        </span>
      </div>
    </div>
  );
}

// A group inside the status popover: no frame of its own, divided from the next by a rule.
const PANEL: React.CSSProperties = {
  padding: "var(--s-4) 0 var(--s-6)",
  borderBottom: "var(--rule)",
};

const LOG: React.CSSProperties = {
  margin: "9px 0 0",
  padding: "7px 9px",
  maxHeight: 90,
  overflow: "auto",
  borderRadius: "var(--r-chip)",
  background: "var(--sunk)",
  color: "var(--muted)",
  fontSize: "var(--fs-2)",
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

interface VendorProgressItem {
  vendor: VendorId;
  stage: SyncVendorStage;
  result: VendorSyncResult | undefined;
}

function vendorLabel(vendor: VendorId): string {
  return vendor === "gauges" ? translate("Archived readings", "Zapisane odczyty") : VENDOR_LABELS[vendor];
}
function stageLabel(stage: SyncVendorStage): string {
  if (stage === "active") return translate("active", "w toku");
  if (stage === "queued") return translate("queued", "oczekuje");
  if (stage === "success") return translate("ready", "gotowe");
  if (stage === "failure") return translate("error", "błąd");
  if (stage === "skipped") return translate("unchanged", "bez zmian");
  if (stage === "outside") return translate("outside scope", "poza zakresem");
  return translate("ready", "gotowy");
}

function stageColor(stage: SyncVendorStage): string {
  if (stage === "active") return "var(--accent)";
  if (stage === "success") return "var(--ok)";
  if (stage === "failure") return "var(--crit)";
  if (stage === "skipped") return "var(--muted)";
  return "var(--line2)";
}

function stageComplete(stage: SyncVendorStage): boolean {
  return stage === "success" || stage === "failure" || stage === "skipped" || stage === "outside";
}

export function phaseLabel(phase: SyncPhase): string {
  const labels: Record<SyncPhase, [string, string]> = {
    readings: ["Reading current account limits", "Odczytuję bieżące limity kont"],
    scan: ["Checking sources for changes", "Sprawdzam zmiany w źródłach"],
    identity: ["Checking account assignments", "Sprawdzam przypisania kont"],
    mirror: ["Copying source files", "Kopiuję pliki źródłowe"],
    stage: ["Preparing the import", "Przygotowuję import"],
    ingest: ["Indexing history", "Indeksuję historię"],
    validate: ["Validating imported data", "Sprawdzam zaimportowane dane"],
    publish: ["Saving imported data", "Zapisuję zaimportowane dane"],
    attribution: ["Assigning usage to accounts", "Przypisuję zużycie do kont"],
    projects: ["Updating project assignments", "Aktualizuję przypisania projektów"],
    checkpoint: ["Flushing database changes", "Utrwalam zmiany w bazie"],
    finalize: ["Publishing account state", "Publikuję stan kont"],
  };
  return translate(...labels[phase]);
}

/** The register entry of one vendor of the running synchronization. */
function vendorEntry(sync: SyncStatus, vendor: string): ProgressEntry | undefined {
  return sync.running ? sync.progress?.find(entry => entry.scope === `sync:${vendor}`) : undefined;
}

/** The entry of whatever the run is doing now: its vendor's, or the run's own before and after the vendors. */
function currentEntry(sync: SyncStatus): ProgressEntry | undefined {
  const vendor = sync.run?.progress?.vendor;
  if (!sync.running) return undefined;
  return (vendor ? vendorEntry(sync, vendor) : sync.progress?.find(entry => entry.scope.startsWith("sync:")))
    ?? sync.progress?.find(entry => entry.scope === "sync");
}

/** What the run is doing now, named by its register entry when it has one, by its phase otherwise. */
export function syncProgressLabel(progress: SyncProgress, entry?: ProgressEntry): string {
  return entry ? progressStepLabel(entry) : phaseLabel(progress.phase);
}

function vendorProgressItems(sync: SyncStatus): VendorProgressItem[] {
  const run = sync.run;
  // Every source stays listed. An automatic run covers only the sources whose files changed,
  // so the others are unchanged; a narrower manual scope leaves them outside it.
  const unchanged = run?.trigger === "auto" && run.scope.kind === "vendors";
  return VENDOR_IDS.map((vendor) => {
    const stage = syncVendorStage(sync, vendor);
    return {
      vendor,
      stage: stage === "outside" && unchanged ? "skipped" : stage,
      result: run?.vendors.find((item) => item.vendor === vendor),
    };
  });
}

function VendorProgressRail({ items, sync }: { items: VendorProgressItem[]; sync: SyncStatus }) {
  const { t } = useI18n();
  // Sources outside the run are listed but not counted as its work.
  const scoped = items.filter((item) => item.stage !== "outside");
  const completed = scoped.filter((item) => stageComplete(item.stage)).length + Number(!sync.running && sync.ok === true);
  const finishing = sync.running && items.every(item => stageComplete(item.stage));
  return (
    <div
      role="progressbar"
      aria-label={t("Sources and final processing", "Źródła i końcowe przetwarzanie")}
      aria-valuemin={0}
      aria-valuemax={scoped.length + 1}
      aria-valuenow={completed}
      aria-valuetext={`${completed} ${t("of", "z")} ${scoped.length + 1} ${t("scopes completed", "zakresów zakończonych")}`}
      style={{ display: "grid", gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))`, gap: 3 }}
    >
      {items.map((item) => (
        <span
          key={item.vendor}
          aria-hidden="true"
          title={`${vendorLabel(item.vendor)} · ${stageLabel(item.stage)}`}
          style={{
            height: 4,
            borderRadius: "var(--r-bar)",
            background: stageColor(item.stage),
            animation: item.stage === "active" ? "ta-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
      ))}
      <span aria-hidden="true" title={t("Summaries and final save", "Podsumowania i końcowy zapis")}
        style={{ height: 4, borderRadius: "var(--r-bar)",
          background: finishing ? "var(--accent)" : !sync.running && sync.ok ? "var(--ok)" : "var(--line2)",
          animation: finishing ? "ta-pulse 1.4s ease-in-out infinite" : undefined }} />
    </div>
  );
}

function vendorDetail(item: VendorProgressItem, sync: SyncStatus): string {
  const entry = vendorEntry(sync, item.vendor);
  if (entry) return progressText(entry);
  if (item.stage === "queued" && sync.running && sync.run?.progress?.phase === "scan") return sync.progress?.some(entry => entry.scope.startsWith("sync:"))
    ? translate("Waiting for its files to be checked", "Czeka na sprawdzenie plików")
    : translate("Checking source files", "Sprawdzam pliki źródłowe");
  if (item.stage === "outside") return translate("Outside this synchronization", "Poza zakresem tej synchronizacji");
  if (item.stage === "active") return translate("Copying, indexing, and validating", "Kopiowanie, indeksowanie i walidacja");
  if (item.stage === "queued") return translate("Waiting for the previous scope", "Czeka na poprzedni zakres");
  if (item.stage === "skipped") return translate("The coordinator found no changes in the source", "Koordynator nie wykrył zmian w źródle");
  if (!item.result) return translate("No result for this scope", "Brak wyniku dla tego zakresu");
  if (item.result.status === "failure") return browserSafeDiagnostic(item.result.error ?? translate("Synchronization failed", "Synchronizacja nie powiodła się"));
  return `${formatCount(item.result.processedInputs)} ${translate("inputs", "wejść")} · ${formatCount(item.result.skippedInputs)} ${translate("skipped", "pominiętych")} · ${formatCount(item.result.writtenRows)} ${translate("rows", "wierszy")}`;
}

function VendorProgressDetails({ items, sync, detail, inline }: { items: VendorProgressItem[]; sync: SyncStatus; detail: string; inline: boolean }) {
  useI18n();
  return (
    <div data-sync-sources style={inline ? { marginTop: 10, borderTop: "var(--rule)", paddingTop: 4 } : undefined}>
      {items.map((item) => (
        <div
          key={item.vendor}
          data-sync-vendor={item.vendor}
          data-sync-stage={item.stage}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(92px, 0.55fr) minmax(0, 1.45fr) auto",
            gap: 12,
            alignItems: "center",
            minHeight: 34,
            padding: "6px 0",
            borderBottom: "var(--rule)",
          }}
        >
          <strong style={{ fontSize: "var(--fs-4)", fontWeight: 600 }}>{vendorLabel(item.vendor)}</strong>
          <span className="mono" style={{ minWidth: 0, color: "var(--muted)", fontSize: "var(--fs-3)", overflowWrap: "anywhere" }}>
            {vendorDetail(item, sync)}
          </span>
          <span className="mono" style={{ color: stageColor(item.stage), fontSize: "var(--fs-3)", whiteSpace: "nowrap" }}>
            {stageLabel(item.stage)}
          </span>
        </div>
      ))}
      <p className="mono" style={{ margin: "9px 0 0", color: "var(--muted)", fontSize: "var(--fs-3)" }}>{detail}</p>
    </div>
  );
}

/** What a synchronization reports: its title, counters and per-source rows. */
export type SyncView = { sync: SyncStatus; mode: string; title: string; count: string; current: string; elapsed: string;
  detail: string; items: VendorProgressItem[] };

/** Progress comes from the coordinator's typed vendor ledger, never from log text.
 *  `context` names the job this run belongs to, such as the source step of a data rebuild. */
export function useSyncView(sync: SyncStatus, context?: string): SyncView {
  const { t } = useI18n();
  const elapsed = useElapsed(sync.started_at, sync.running);
  const run = sync.run;
  const entry = currentEntry(sync);
  const phaseElapsed = useElapsed(entry?.startedAt ?? run?.progress?.startedAt, sync.running);
  const items = vendorProgressItems(sync);
  const scoped = items.filter((item) => item.stage !== "outside");
  const completed = scoped.filter((item) => stageComplete(item.stage)).length;
  const active = items.find((item) => item.stage === "active") ?? items.find((item) => item.stage === "queued");
  const scope = run?.scope.kind === "vendor" ? vendorLabel(run.scope.vendor)
    : run?.scope.kind === "vendors" ? run.scope.vendors.map(vendorLabel).join(", ") : run?.scope.kind === "accounts"
      ? run.scope.accounts.map(account => `${vendorLabel(account.vendor)}: ${account.account}`).join(", ") : t("all sources", "wszystkie źródła");
  const mode = run?.mode === "full" ? t("Full update", "Pełna aktualizacja") : t("Synchronization", "Synchronizacja");
  const title = `${context ? `${context} · ` : ""}${mode} · ${scope}`;
  const progress = run?.progress;
  const currentVendor = run?.progress?.vendor ?? (entry?.scope.startsWith("sync:") ? entry.scope.slice("sync:".length) : undefined);
  const current = sync.running && run?.progress
    ? `${currentVendor ? `${vendorLabel(currentVendor as VendorId)}: ` : ""}${syncProgressLabel(run.progress, entry)}`
    : active
    ? `${active.stage === "active" ? t("Now", "Teraz") : t("Next", "Następnie")}: ${vendorLabel(active.vendor)}`
    : sync.running
      ? t("Processing summaries and saving results", "Przeliczam podsumowania i zapisuję wyniki")
      : sync.ok === false ? t("Finished with errors", "Zakończono z błędami") : t("Completed", "Zakończono");
  const itemCount = entry ? progressCounter(entry) : null;
  const count = progress && progress.total > 0
    ? `${itemCount ? `${itemCount} · ` : ""}${progress.completed}/${progress.total} ${t("steps", "kroków")}`
    : itemCount ?? `${completed}/${scoped.length} ${t("sources", "źródeł")}`;
  const background = (sync.progress ?? []).filter(item => !isSyncScope(item)).map(progressText);
  const detail = `${current} · ${t("elapsed", "upłynęło")}: ${elapsed}${progress ? ` · ${t("this stage", "ten etap")}: ${phaseElapsed}` : ""}` +
    (sync.running ? ` · ${progress && progress.total > 0 && progress.phase !== "readings" && progress.phase !== "scan" ? `${t("steps remaining (including current)", "pozostałe kroki (z bieżącym)")}: ${progress.total - progress.completed} · ` : ""}${t("Time remaining: unknown; steps differ in duration", "Pozostały czas: nieznany; kroki mają różny czas trwania")}` : "") +
    background.map(text => ` · ${text}`).join("");
  return { sync, mode, title, count, current, elapsed, detail, items };
}

/** The expand marker: only the arrow turns when the panel opens, so the word stays readable. */
export function DetailsChevron() {
  const { t } = useI18n();
  return (
    <span className="mono" aria-hidden="true" style={{ color: "var(--muted)", fontSize: "var(--fs-3)", whiteSpace: "nowrap" }}>
      {/* inline-block, so the open state's rotation applies to the arrow */}
      {t("details", "szczegóły")} <span className="sync-activity-chevron" style={{ display: "inline-block" }}>▾</span>
    </span>
  );
}

/** The collapsed line of a synchronization: title, counters and one rail segment per source. */
export function SyncSummaryContent({ view, compact = false }: { view: SyncView; compact?: boolean }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <LiveMark />
        <div style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 9, flex: 1 }}>
          <strong style={{ minWidth: 0, fontSize: "var(--fs-4)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {compact ? view.mode : view.title}
          </strong>
          <span className="mono" style={{ minWidth: 0, color: "var(--muted)", fontSize: "var(--fs-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {view.count} · {view.current} · {view.elapsed}
          </span>
        </div>
        <DetailsChevron />
      </div>
      <VendorProgressRail items={view.items} sync={view.sync} />
    </>
  );
}

/** Per-source rows and the run's detail line, for the state column of the status details. */
export function SyncSources({ view }: { view: SyncView }) {
  return <VendorProgressDetails items={view.items} sync={view.sync} detail={view.detail} inline={false} />;
}

/** A synchronization panel inside a page; the application bar shows the same parts in its own details. */
export function SyncActivity({ sync, context }: { sync: SyncStatus; context?: string }) {
  const { t } = useI18n();
  const view = useSyncView(sync, context);
  return (
    <section role="status" aria-live="polite" aria-label={t("Synchronization progress", "Postęp synchronizacji")} style={PANEL}>
      <details className="sync-activity" style={{ position: "relative", height: "100%" }}>
        <summary
          title={t("Expand provider synchronization details", "Rozwiń szczegóły synchronizacji dostawców")}
          style={{ display: "grid", height: "100%", gridTemplateRows: "1fr auto", gap: 6, cursor: "pointer" }}
        >
          <SyncSummaryContent view={view} />
        </summary>
        <VendorProgressDetails items={view.items} sync={sync} detail={view.detail} inline />
      </details>
    </section>
  );
}

export const BOOTSTRAP_STAGES: Array<{ stage: AtlasBootstrapStage }> = [
  { stage: "snapshot-discovery" },
  { stage: "snapshot-validation" },
  { stage: "snapshot-installation" },
  { stage: "migration" },
  { stage: "path-rebase" },
  { stage: "incremental-catch-up" },
];
export function bootstrapStageLabel(stage: AtlasBootstrapStage): string {
  if (stage === "snapshot-discovery") return translate("Find Atlas snapshot", "Wyszukanie snapshotu Atlas");
  if (stage === "snapshot-validation") return translate("Validate compatibility", "Walidacja zgodności");
  if (stage === "snapshot-installation") return translate("Install index", "Instalacja indeksu");
  if (stage === "migration") return translate("Database migrations", "Migracje bazy");
  if (stage === "path-rebase") return translate("Rebase paths", "Dopasowanie ścieżek");
  if (stage === "incremental-catch-up") return translate("Incremental synchronization", "Synchronizacja uzupełniająca");
  return translate("Atlas bootstrap", "Uruchamianie Atlas");
}

export function bootstrapStageIndex(bootstrap: AtlasBootstrapStatus): number {
  if (bootstrap.stage === "full-ingest-fallback") return BOOTSTRAP_STAGES.length - 1;
  if (bootstrap.stage === "complete") return BOOTSTRAP_STAGES.length;
  return BOOTSTRAP_STAGES.findIndex((item) => item.stage === bootstrap.stage);
}

export function StartupActivity({ bootstrap }: { bootstrap: AtlasBootstrapStatus }) {
  const { t } = useI18n();
  const elapsed = useElapsed(bootstrap.started_at, bootstrap.running);
  const current = bootstrapStageIndex(bootstrap);
  const localReady = bootstrap.status === "local-ready";
  const headline = bootstrap.running
    ? t("Preparing the local Atlas index", "Przygotowuję lokalny indeks Atlas")
    : bootstrap.ok === false
      ? t("Index startup needs attention", "Uruchomienie indeksu wymaga uwagi")
      : localReady
        ? t("The local Atlas index was ready", "Lokalny indeks Atlas był gotowy")
        : t("Atlas index started", "Indeks Atlas uruchomiony");

  return (
    <section role="status" aria-live="polite" aria-label={t("Atlas index startup stages", "Etapy uruchamiania indeksu Atlas")} style={PANEL}>
      <Heading title={headline} meta={`${bootstrap.running ? t("active", "w toku") : t("completed", "zakończono")} · ${elapsed}`} />
      <ol style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 5 }}>
        {BOOTSTRAP_STAGES.map((item, index) => {
          const skipped = localReady;
          const active = bootstrap.running && index === current;
          const done = !skipped && (current > index || bootstrap.stage === "complete");
          return (
            <li key={item.stage} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-4)" }}>
              <span aria-hidden="true" style={{ color: active ? "var(--accent)" : done ? "var(--ok)" : "var(--faint)" }}>
                {active ? "●" : done ? "✓" : "○"}
              </span>
              <span style={{ color: active || done ? "var(--text)" : "var(--muted)" }}>{bootstrapStageLabel(item.stage)}</span>
              {skipped && <span className="mono" style={{ marginLeft: "auto", color: "var(--faint)", fontSize: "var(--fs-2)" }}>{t("not needed", "niepotrzebne")}</span>}
            </li>
          );
        })}
      </ol>
      {bootstrap.status === "full-ingest-required" && (
        <p style={{ margin: "9px 0 0", color: "var(--warn)", fontSize: "var(--fs-4)" }}>
          {t("No compatible snapshot. A full safety ingest is running.", "Brak zgodnego snapshotu. Wykonywany jest pełny ingest bezpieczeństwa.")}
        </p>
      )}
      {bootstrap.attempts.some((attempt) => !attempt.accepted) && (
        <p style={{ margin: "9px 0 0", color: "var(--muted)", fontSize: "var(--fs-3)" }}>
          {t("Rejected snapshots", "Odrzucone snapshoty")}: {bootstrap.attempts.filter((attempt) => !attempt.accepted).length}. {t("The next valid candidate or a safe fallback was used.", "Użyto kolejnego poprawnego kandydata lub bezpiecznego fallbacku.")}
        </p>
      )}
    </section>
  );
}

function tableLabel(table: string): string {
  const label = TABLE_LABELS[table];
  if (label === "Codex") return translate("Codex", "Codex");
  if (label === "Claude Code") return translate("Claude Code", "Claude Code");
  if (label === "OpenCode") return translate("OpenCode", "OpenCode");
  if (label === "Grok") return translate("Grok", "Grok");
  if (label === "Antigravity") return translate("Antigravity", "Antigravity");
  return table;
}

/** Progress of the background remap. The dashboard stays readable underneath,
 *  so the panel says plainly that the numbers below it are the pre-remap ones. */
export function RemapActivity({ remap }: { remap: RemapStatus }) {
  const { t } = useI18n();
  const elapsed = useElapsed(remap.started_at, remap.running);
  const lines = useMemo(
    () => remap.log_tail.slice(-5).map((line) => browserSafeDiagnostic(line)),
    [remap.log_tail],
  );
  const current = Math.max(0, Math.min(remap.progress?.phase_index ?? 0, REMAP_PHASE_COUNT));
  const rows = Object.entries(remap.rows);
  const tables = Object.entries(remap.tables);

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={t("Project remap progress", "Postęp przemapowania projektów")}
      style={PANEL}
    >
      <Heading
        title={browserSafeDiagnostic(remap.message)}
        meta={`${t("stage", "etap")} ${current} ${t("of", "z")} ${REMAP_PHASE_COUNT} · ${elapsed}`}
      />
      <Segments count={REMAP_PHASE_COUNT} current={current} />
      {remap.why && (
        <p style={{ margin: "9px 0 0", color: "var(--muted)", fontSize: "var(--fs-3)" }}>{browserSafeDiagnostic(remap.why)}</p>
      )}
      {rows.length > 0 && (
        <dl style={{ margin: "10px 0 0" }}>
          {rows.map(([table, count]) => (
            <div
              key={table}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(92px, 0.72fr) minmax(0, 1.28fr)",
                gap: 12,
                padding: "6px 0",
                borderBottom: "var(--rule)",
              }}
            >
              <dt style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>{tableLabel(table)}</dt>
              <dd className="mono" style={{ margin: 0, fontSize: "var(--fs-3)", textAlign: "right" }}>
                {formatCount(count)} {t("events", "zdarzeń")}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {tables.length > 0 && (
        <div style={{ marginTop: 10 }} aria-label={t("Table progress", "Postęp tabel")}>
          {tables.map(([key, item]) => (
            <div
              key={key}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                gap: 12,
                padding: "6px 0",
                borderBottom: "var(--rule)",
              }}
            >
              <span
                className="mono"
                style={{ color: "var(--muted)", fontSize: "var(--fs-3)", overflowWrap: "anywhere" }}
              >
                {browserSafeDiagnostic(item.message)}
              </span>
              {item.assigned != null && item.total != null && (
                <strong className="mono" style={{ fontSize: "var(--fs-3)", fontWeight: 500 }}>
                  {formatCount(item.assigned)} / {formatCount(item.total)}
                </strong>
              )}
            </div>
          ))}
        </div>
      )}
      <p style={{ margin: "10px 0 0", color: "var(--muted)", fontSize: "var(--fs-3)" }}>
        {t("The figures below are from before the remap. They will refresh when it finishes.", "Liczby poniżej są sprzed przemapowania. Odświeżą się po zakończeniu.")}
      </p>
      {lines.length > 0 && (
        <pre className="mono" style={LOG}>
          {lines.join("\n")}
        </pre>
      )}
    </section>
  );
}
