import { TableGrid, TableGridRow } from "../components/DataTable";
import { useEffect, useState } from "react";
import { VENDOR_IDS } from "../../sync/contracts";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import type { ScreenProps } from "../lib/screens";
import { requestSettingsTab } from "../lib/settings-link";
import { useAsync } from "../lib/useAsync";
import { useMissingRates } from "../lib/missing-rate";
import {
  api,
  type AtlasSnapshotStatus,
  type SyncStatus,
  type VendorId,
} from "../lib/api";
import {
  startupWriteActive,
  syncVendorStage,
  VENDOR_LABELS,
} from "../components/SyncActivity";
import {
  Card,
  CardTitle,
  GhostButton,
  Pill,
  Selector,
  toneColor,
  type Tone,
} from "../components/ui";
import { IdentityWarnings } from "../components/IdentityWarnings";
import { dayTime, full, relativeTime } from "../lib/format";
import { polishPlural } from "../lib/mixFormat";
import { useI18n } from "../lib/i18n";
import {
  agePosition,
  ageTone,
  sourceChecks,
  sourceProviderRows,
  type SourceCheck,
  type SourceCheckLink,
  type SourceProviderRow,
} from "../lib/source-providers";
import "./Sources.css";

type SourcesProps = Omit<ScreenProps, "triggerSync"> & {
  triggerSync: (mode: "incremental" | "full", vendor?: VendorId) => void;
  view?: "sources" | "data-problems" | "data-operations";
};
type Translate = (en: string, pl: string) => string;

type SyncScopeKey = "all" | VendorId;

export function startSyncScope(
  onStart: (mode: "incremental" | "full", vendor?: VendorId) => void,
  scope: SyncScopeKey,
  mode: "incremental" | "full"
): void {
  onStart(mode, scope === "all" ? undefined : scope);
}

function syncBlockReason(sync: SyncStatus | null, t: Translate): string | null {
  if (sync?.running) return t("A synchronization is already running. Start another one after it finishes.", "Trwa już synchronizacja. Kolejną można uruchomić po jej zakończeniu.");
  if (sync?.remap?.running) return t("Projects are being remapped. Synchronization will start after the save finishes.", "Trwa przemapowanie projektów. Synchronizacja ruszy po zakończeniu zapisu.");
  if (startupWriteActive(sync?.bootstrap)) {
    return t("Atlas index startup is installing or migrating the local database. Wait for the write stage to finish.", "Start indeksu Atlas instaluje lub migruje lokalną bazę. Poczekaj na zakończenie etapu zapisu.");
  }
  return null;
}

function runTone(sync: SyncStatus | null): Tone {
  if (sync?.running) return "accent";
  if (sync?.run?.status === "success") return "ok";
  if (sync?.run?.status === "partial_success") return "warn";
  if (sync?.run?.status === "failure") return "crit";
  return "neutral";
}

function runLabel(sync: SyncStatus | null, t: Translate): string {
  if (sync?.running) return t("running", "w toku");
  if (sync?.run?.status === "success") return t("success", "sukces");
  if (sync?.run?.status === "partial_success") return t("partial success", "częściowy sukces");
  if (sync?.run?.status === "failure") return t("error", "błąd");
  return t("ready", "gotowe");
}

export function retrySyncScope(
  onStart: (mode: "incremental" | "full", vendor?: VendorId) => void,
  onConfirmScope: (scope: SyncScopeKey | null) => void,
  mode: "incremental" | "full",
  vendor: VendorId,
): void {
  if (mode === "full") {
    onConfirmScope(vendor);
    return;
  }
  onStart("incremental", vendor);
}

/** Sync scopes by name; the readings journal gets words instead of its scope id. */
const vendorName = (vendor: VendorId, t: Translate) => vendor === "gauges" ? t("Limit readings", "Odczyty limitu") : VENDOR_LABELS[vendor];
const providerName = (id: SourceProviderRow["id"], t: Translate) => id === "glm" ? "GLM" : id === "claude" ? "Claude" : vendorName(id, t);

/** One phrase and tone for a provider's part of the last run. */
function vendorOutcome(sync: SyncStatus | null, vendor: VendorId, t: Translate): { text: string; tone: Tone; detail: string | null } {
  const result = sync?.run?.vendors.find((item) => item.vendor === vendor);
  const stage = syncVendorStage(sync, vendor);
  if (stage === "active") return { text: t("running", "w toku"), tone: "accent", detail: null };
  if (stage === "queued") return { text: t("queued", "oczekuje"), tone: "accent", detail: null };
  if (result?.status === "failure") return { text: t("error", "błąd"), tone: "crit", detail: null };
  if (result?.status === "success") {
    return result.dataChanged
      ? { text: t("new data", "nowe dane"), tone: "ok", detail: `${full(result.writtenRows)} ${t("rows", "wierszy")}` }
      : { text: t("no changes", "bez zmian"), tone: "ok", detail: null };
  }
  if (stage === "skipped") return { text: t("no changes", "bez zmian"), tone: "neutral", detail: t("skipped", "pominięty") };
  if (stage === "outside") return { text: t("outside the run", "poza przebiegiem"), tone: "neutral", detail: null };
  return { text: t("ready", "gotowy"), tone: "neutral", detail: null };
}

/** Data age on a logarithmic 30-day scale; the dot takes the freshness tone. */
function AgeScale({ value, olderAfterHours, pending }: { value: string | null; olderAfterHours: number; pending?: boolean }) {
  const { t } = useI18n();
  const tone = ageTone(value, olderAfterHours);
  return <div className="sources-age" title={value ? dayTime(value) : undefined}>
    <span className="mono">{value ? relativeTime(value) : pending ? "…" : t("no data", "brak danych")}</span>
    <div className="sources-age-track" aria-hidden="true">
      {value && <i style={{ left: `${agePosition(value) * 100}%`, background: tone ? toneColor(tone) : "var(--faint)" }} />}
    </div>
  </div>;
}

function RunDetails({ sync }: { sync: SyncStatus | null }) {
  const { t } = useI18n();
  const run = sync?.run;
  const results = run?.vendors.filter((result) => result.status !== "pending") ?? [];
  if (!run || results.length === 0) return null;
  return <details className="sources-run-details">
    <summary>{t("Last run details (inputs, skipped, range, revisions)", "Szczegóły ostatniego przebiegu (wejścia, pominięte, zakres, rewizje)")}</summary>
    {results.map((result) => {
      const before = run.beforeRevisions.vendors[result.vendor], after = run.afterRevisions.vendors[result.vendor];
      return <div key={result.vendor} className="mono">
        <b>{vendorName(result.vendor, t)}</b>
        <span>{t("inputs", "wejścia")}: {result.processedInputs}</span>
        <span>{t("skipped", "pominięte")}: {result.skippedInputs}</span>
        <span>{t("written rows", "zapisane wiersze")}: {result.writtenRows}</span>
        <span>{t("range", "zakres")}: {result.dirtyRange ? `${dayTime(result.dirtyRange.from)} → ${dayTime(result.dirtyRange.to)}` : t("no changes", "bez zmian")}</span>
        <span>{t("revision", "rewizja")}: {before == null || after == null ? t("no data", "brak danych") : before === after ? `r${after} · ${t("unchanged", "bez zmiany")}` : `r${before} → r${after}`}</span>
        {result.status === "failure" && <span className="sources-crit">
          {t("Last good revision:", "Ostatnia dobra rewizja:")} {after == null ? t("unknown", "nieznana") : `r${after}`} · {browserSafeDiagnostic(result.error ?? result.diagnostics)}
        </span>}
      </div>;
    })}
  </details>;
}

/**
 * One row per provider with its data age, events and part of the last run (UI audit, Data sources). Synchronizing
 * everything is the header's button; a full update, which rereads a whole range, sits behind a scoped confirmation.
 */
export function SyncControlPanel({
  sync,
  onStart,
  providers = sourceProviderRows({ sources: [], probes: [], accounts: [] }),
  olderAfterHours = 24,
  pending = false,
  onProvider,
}: {
  sync: SyncStatus | null;
  onStart: (mode: "incremental" | "full", vendor?: VendorId) => void;
  providers?: SourceProviderRow[];
  olderAfterHours?: number;
  /** Source health or readings are still loading, so a missing age is not yet "no data". */
  pending?: boolean;
  /** Opens where the provider's profiles are configured. */
  onProvider?: () => void;
}) {
  const { t } = useI18n();
  const [fullOpen, setFullOpen] = useState(false);
  const [fullScope, setFullScope] = useState<SyncScopeKey>("all");
  const [confirmScope, setConfirmScope] = useState<SyncScopeKey | null>(null);
  const disabledReason = syncBlockReason(sync, t);
  useEffect(() => {
    if (disabledReason) setConfirmScope(null);
  }, [disabledReason]);
  const run = sync?.run;
  const scopeName = (scope: SyncScopeKey) => scope === "all" ? t("all providers", "wszyscy dostawcy") : vendorName(scope, t);
  const seconds = run?.finishedAt ? Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000) : null;
  const lastRun = run ? [
    run.finishedAt ? dayTime(run.finishedAt) : t("in progress", "w toku"),
    run.trigger === "auto" ? t("automatic", "automatyczna") : run.trigger === "cli" ? t("command line", "z wiersza poleceń") : t("manual", "ręczna"),
    run.mode === "full" ? t("full update", "pełna aktualizacja") : t("incremental", "przyrostowa"),
    run.scope.kind === "all" ? t("all providers", "wszyscy dostawcy") : run.scope.kind === "accounts" ? run.scope.accounts.map((account) => `${vendorName(account.vendor, t)}: ${account.account}`).join(", ") : run.scope.kind === "vendors" ? run.scope.vendors.map((vendor) => vendorName(vendor, t)).join(", ") : vendorName(run.scope.vendor, t),
    ...(seconds != null && Number.isFinite(seconds) ? [`${seconds} s`] : []),
  ].join(" · ") : t("no run in this server session yet", "brak przebiegu w tej sesji serwera");

  return (
    <TableGrid tableId="Sources:synchronization"><Card pad="0">
      <div className="sources-head">
        <CardTitle title={t("Synchronization", "Synchronizacja")} sub={`${t("last", "ostatnia")}: ${lastRun}`}
          right={<div className="ui-toolbar">
            <Pill tone={runTone(sync)} dot={runTone(sync) !== "neutral"}>{runLabel(sync, t)}</Pill>
            <GhostButton aria-expanded={fullOpen} onClick={() => { setFullOpen(!fullOpen); setConfirmScope(null); }}>{t("Full update…", "Pełna aktualizacja…")}</GhostButton>
          </div>} />
        {run?.status === "partial_success" && <div className="sources-note">{t("Some providers kept their previous valid state.", "Część dostawców zachowała poprzedni poprawny stan.")}</div>}
        {fullOpen && <div className="ui-inset sources-full">
          <Selector label={t("Scope", "Zakres")} value={fullScope} onChange={(value) => { setFullScope(value as SyncScopeKey); setConfirmScope(null); }}
            options={(["all", ...VENDOR_IDS] as SyncScopeKey[]).map((scope) => ({ value: scope, label: scopeName(scope) }))} />
          <GhostButton disabled={disabledReason != null} title={disabledReason ?? undefined} onClick={() => setConfirmScope(fullScope)}>{t("Full update", "Pełna aktualizacja")}</GhostButton>
        </div>}
        {confirmScope && !disabledReason && (
          <div role="group" aria-label={`${t("Confirm full update", "Potwierdzenie pełnej aktualizacji")}: ${scopeName(confirmScope)}`} className="sources-confirm">
            <span>{t("A full update rereads the entire range:", "Pełna aktualizacja przeczyta od nowa cały zakres:")} <strong>{scopeName(confirmScope)}</strong>. {t("Continue?", "Kontynuować?")}</span>
            <span className="ui-toolbar">
              <GhostButton onClick={() => setConfirmScope(null)}>{t("Cancel", "Anuluj")}</GhostButton>
              <GhostButton onClick={() => { const scope = confirmScope; setConfirmScope(null); setFullOpen(false); startSyncScope(onStart, scope, "full"); }}>
                {t("Yes, start full update", "Tak, uruchom pełną")}
              </GhostButton>
            </span>
          </div>
        )}
        {disabledReason && <div role="status" aria-live="polite" className="sources-blocked">{disabledReason}</div>}
      </div>
      <TableGridRow header template="calc(var(--s-12) * 3 - var(--s-2)) minmax(0, 1.2fr) calc(var(--s-4) * 11) minmax(0, 1.4fr) calc(var(--s-12) * 3 - var(--s-2))" className="sources-grid sources-grid-head mono">
        <span>{t("Provider", "Dostawca")}</span>
        <span title={t("Scale: now · 1 h · 1 day · 7 days · 30 days", "Skala: teraz · 1 h · 1 dzień · 7 dni · 30 dni")}>{t("Latest data", "Ostatnie dane")}</span>
        <span className="sources-right">{t("Events", "Zdarzenia")}</span>
        <span>{t("Last run", "Ostatni przebieg")}</span>
        <span aria-label={t("Actions", "Akcje")} />
      </TableGridRow>
      {providers.map((row) => {
        const outcome = row.sync ? vendorOutcome(sync, row.sync, t) : null;
        const failed = outcome?.tone === "crit";
        const vendor = row.sync;
        return <TableGridRow template="calc(var(--s-12) * 3 - var(--s-2)) minmax(0, 1.2fr) calc(var(--s-4) * 11) minmax(0, 1.4fr) calc(var(--s-12) * 3 - var(--s-2))" key={row.id} className="sources-grid sources-row" data-sync-scope={row.id}>
          <span>{onProvider && row.id !== "gauges"
            ? <button type="button" className="ui-link-button sources-provider" title={t("Computers and data in Settings", "Komputery i dane w Ustawieniach")} onClick={onProvider}>{providerName(row.id, t)}</button>
            : <strong>{providerName(row.id, t)}</strong>}</span>
          <AgeScale value={row.latest} olderAfterHours={olderAfterHours} pending={pending} />
          <span className="mono sources-right">{row.events == null ? "—" : full(row.events)}</span>
          <span className="sources-outcome">
            {outcome ? <><Pill tone={outcome.tone} dot={outcome.tone !== "neutral"}>{outcome.text}</Pill>{outcome.detail && <span className="mono">{outcome.detail}</span>}</>
              : <span className="sources-muted">{t("arrives with limit readings", "przychodzi z odczytami limitu")}</span>}
          </span>
          <span className="sources-right">{vendor && <GhostButton disabled={disabledReason != null}
            title={disabledReason ?? `${t("Synchronize", "Synchronizuj")}: ${providerName(row.id, t)}`}
            onClick={() => failed ? retrySyncScope(onStart, setConfirmScope, run?.mode ?? "incremental", vendor) : startSyncScope(onStart, vendor, "incremental")}>
            {failed ? t("Retry", "Ponów") : t("Synchronize", "Synchronizuj")}
          </GhostButton>}</span>
        </TableGridRow>;
      })}
      <div className="sources-foot"><RunDetails sync={sync} /></div>
    </Card></TableGrid>
  );
}

function snapshotAge(ageSeconds: number, t: Translate): string {
  if (ageSeconds < 60) return t("just now", "przed chwilą");
  if (ageSeconds < 3_600) return `${Math.floor(ageSeconds / 60)} ${t("min ago", "min temu")}`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3_600)} ${t("hours ago", "godz. temu")}`;
  return `${Math.floor(ageSeconds / 86_400)} ${t("days ago", "dni temu")}`;
}

/** Feedback only when there is something to say: an action's result, a running copy or an error. */
function snapshotFeedback(
  snapshot: AtlasSnapshotStatus | null,
  loading: boolean,
  requestError: string | null,
  t: Translate,
): string | null {
  if (!snapshot) return loading ? t("Checking the local copy pool…", "Sprawdzam lokalną pulę kopii…") : requestError ? browserSafeDiagnostic(requestError) : null;
  if (snapshot.running) return t("Creating the index recovery copy…", "Tworzę kopię awaryjną indeksu…");
  if (snapshot.error) return `${t("Could not create the copy:", "Nie udało się utworzyć kopii:")} ${browserSafeDiagnostic(snapshot.error)}`;
  if (snapshot.result?.status === "created") return t("Created a new index recovery copy.", "Utworzono nową kopię awaryjną indeksu.");
  if (snapshot.result?.status === "reused") return t("The existing valid snapshot has the same revisions and was reused.", "Istniejący poprawny snapshot ma te same rewizje — użyto go ponownie.");
  if (snapshot.result?.status === "skipped") return t("Snapshot skipped according to the publication rule.", "Snapshot pominięty zgodnie z regułą publikacji.");
  if (snapshot.result?.status === "aborted") return t("Publication was stopped without changing the previous snapshot.", "Publikację przerwano bez naruszenia poprzedniego snapshotu.");
  return null;
}

/** The index recovery copy on one line: newest valid copy, compatibility, revisions and one action. */
export function SnapshotCard({
  sync,
  snapshotStatus,
}: {
  sync: SyncStatus | null;
  snapshotStatus?: AtlasSnapshotStatus | null;
}) {
  const { t } = useI18n();
  const snapshotState = useAsync(async () => api.indexSnapshotStatus(), []);
  const [actionState, setActionState] = useState<AtlasSnapshotStatus | null>(snapshotStatus ?? null);
  const snapshot = actionState ?? snapshotStatus ?? snapshotState.data;
  const newest = snapshot?.newest_valid ?? null;
  const disabledReason = syncBlockReason(sync, t) ?? (snapshot?.running ? t("Snapshot creation is already running.", "Tworzenie snapshotu już trwa.") : null);
  const compatibilityText = newest
    ? `${newest.compatible ? t("compatible", "zgodny") : t("incompatible", "niezgodny")} · ${
        newest.validation === "full"
          ? t("full manifest and database validation", "pełna walidacja manifestu i bazy")
          : t("manifest only - the database file was unavailable for full validation", "tylko manifest — plik bazy nie był dostępny do pełnej walidacji")
      }`
    : null;
  const createSnapshot = async () => {
    setActionState({
      running: true,
      mode: "manual",
      started_at: new Date().toISOString(),
      finished_at: null,
      result: null,
      error: null,
      newest_valid: newest,
      discovery_error: snapshot?.discovery_error ?? null,
    });
    try {
      setActionState(await api.indexSnapshotCreate());
    } catch (error) {
      setActionState({
        running: false,
        mode: "manual",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        result: null,
        error: error instanceof Error ? error.message : String(error),
        newest_valid: newest,
        discovery_error: snapshot?.discovery_error ?? null,
      });
    }
  };
  const feedback = snapshotFeedback(snapshot, snapshotState.loading, snapshotState.error, t);
  const failed = snapshot?.error || snapshot?.result?.status === "aborted";
  return (
    <Card>
      <div className="sources-snapshot">
        <div>
          <b title={t("A local recovery copy created manually or before a schema migration. Ordinary startup and sync do not create it; it is never stored in OneDrive.", "Lokalna kopia awaryjna tworzona ręcznie albo przed migracją schematu. Zwykły start i synchronizacja jej nie tworzą; nigdy nie trafia do OneDrive.")}>
            {t("Index recovery copy", "Kopia awaryjna indeksu")}
          </b>
          <span className="mono sources-muted">
            {newest ? <>{t("latest valid", "najnowsza poprawna")} {snapshotAge(newest.age_seconds, t)} · {compatibilityText} · r{newest.revisions.data}/{newest.revisions.config}/{newest.revisions.derived}</>
              : snapshot?.discovery_error ? t("pool read error", "błąd odczytu puli") : snapshot ? t("no valid copy", "brak poprawnej kopii") : t("checking…", "sprawdzam…")}
          </span>
        </div>
        <GhostButton disabled={disabledReason != null} title={disabledReason ?? t("Create or reuse a valid index recovery copy", "Utwórz lub ponownie wykorzystaj poprawną kopię awaryjną indeksu")} onClick={createSnapshot}>
          {snapshot?.running ? t("Creating…", "Tworzę…") : t("Create now", "Utwórz teraz")}
        </GhostButton>
      </div>
      {snapshot?.discovery_error && (
        <div role="alert" className="sources-crit sources-snapshot-note">
          {t("Could not read the local Atlas snapshot pool", "Nie udało się odczytać lokalnej puli snapshotów Atlas")} ({t("stage", "etap")}: {browserSafeDiagnostic(snapshot.discovery_error.stage)}, {t("code", "kod")}: {browserSafeDiagnostic(snapshot.discovery_error.code)}).
        </div>
      )}
      {feedback && <div role="status" aria-live="polite" className={`sources-snapshot-note ${failed ? "sources-crit" : "sources-muted"}`}>{feedback}</div>}
    </Card>
  );
}

const CHECK_ICON: Record<SourceCheck["tone"], { icon: string; color: string }> = {
  warn: { icon: "!", color: "var(--warn)" },
  info: { icon: "i", color: "var(--accent)" },
  ok: { icon: "✓", color: "var(--ok)" },
};

function SourceChecks({ checks, onLink }: { checks: SourceCheck[]; onLink: (link: SourceCheckLink) => void }) {
  const { t } = useI18n();
  const label: Record<SourceCheckLink, string> = {
    profiles: t("Profiles →", "Profile →"),
    periods: t("Accounts →", "Konta →"),
    rates: t("Price lists: Models →", "Cenniki: Modele →"),
  };
  const order = { warn: 0, info: 1, ok: 2 };
  const problems = checks.filter((check) => check.tone === "warn").length;
  return <Card>
    <CardTitle title={t("Checks", "Kontrole")} sub={problems ? `${problems} ${t(problems === 1 ? "needs attention" : "need attention", polishPlural(problems, "wymaga uwagi", "wymagają uwagi", "wymaga uwagi"))}` : t("nothing needs attention", "nic nie wymaga uwagi")} />
    <ul className="sources-checks">
      {[...checks].sort((a, b) => order[a.tone] - order[b.tone]).map((check) => <li key={check.key} data-check={check.key} data-tone={check.tone}>
        <i style={{ color: CHECK_ICON[check.tone].color, borderColor: CHECK_ICON[check.tone].color }} aria-hidden="true">{CHECK_ICON[check.tone].icon}</i>
        <span><b>{check.title}</b> <span className="sources-muted">{check.detail}</span>
          {check.items && check.items.length > 0 && <details className="sources-check-items">
            <summary>{check.items.length} {t(check.items.length === 1 ? "entry" : "entries", polishPlural(check.items.length, "pozycja", "pozycje", "pozycji"))}</summary>
            <ul className="mono">{check.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>}
        </span>
        {check.link && <button type="button" className="ui-link-button" onClick={() => onLink(check.link!)}>{label[check.link]}</button>}
      </li>)}
    </ul>
  </Card>;
}

export function Sources(props: SourcesProps) {
  const { accounts, goto, sync, triggerSync, view = "sources" } = props;
  const healthState = useAsync(async () => api.health(), []);
  const probeState = useAsync(async () => api.accountState(), []);
  // Same retained view as Settings → Computers and data.
  const sourceState = useAsync((signal) => api.sourceHealth(signal), [], true, "source-settings:health");
  const health = healthState.data;
  // The same summary as the status bar's missing-price alert.
  const missingRates = useMissingRates();
  const probes = probeState.data?.probes ?? [];
  const identity = health?.identity?.warnings ?? [];
  const tables = health?.tables as { events?: number; claude_events?: number } | undefined;
  const providers = sourceProviderRows({ sources: sourceState.data?.sources ?? [], probes, accounts, tables });
  const checks = sourceChecks({
    probes, accounts, identity, watch: sync?.watch ?? null,
    unpricedTokens: missingRates?.tokens ?? 0,
    unpricedModels: missingRates?.models.length ?? 0,
  });
  const openSettings = (link: SourceCheckLink) => {
    requestSettingsTab(link === "profiles" ? "sources" : link);
    goto("settings");
  };
  return (
    // The page stands on the paper (paper-atlas §3): its cards drop their frames and are divided by dashed rules.
    // Data and sync tabs (IA-2026-10-19 v1.1, DA): state, problems grouped for repair, operations.
    <div className="sources ui-tab-page" data-screen="sources">
      {view === "sources" && <SyncControlPanel sync={sync} onStart={triggerSync} providers={providers}
        olderAfterHours={sourceState.data?.older_after_hours ?? 24} pending={(!sourceState.data && sourceState.loading) || (!probeState.data && probeState.loading)} onProvider={() => openSettings("profiles")} />}
      {view === "data-problems" && <SourceChecks checks={checks} onLink={openSettings} />}
      {view === "data-problems" && <IdentityWarnings warnings={identity} />}
      {view === "data-operations" && <SnapshotCard sync={sync} />}
    </div>
  );
}
