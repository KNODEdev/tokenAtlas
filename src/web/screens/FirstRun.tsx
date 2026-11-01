import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type SetupState, type SourcePreview } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Disclosure, Dropdown, ErrorState, GhostButton, HelpDot, Pill } from "../components/ui";
import { LoadingStatus } from "../components/LoadingStatus";
import { Brand } from "../components/Sidebar";
import { LANGUAGE_OPTIONS, useI18n } from "../lib/i18n";
import { countLabel } from "../lib/format";
import { VENDOR_LABELS } from "../components/SyncActivity";
import { requestTourAfterConsent } from "../lib/guided-tour";
import { SetupSources, setupDeclarations, useDatabaseMove, type SetupRow } from "./Setup";
import "../components/AppHeader.css";
import "./FirstRun.css";

type FolderKey = "archive" | "config" | "database" | "temporary" | "snapshot";

/** Paths under the home folder read as `~\…`; the full path stays in the tooltip. */
function shortPath(value: string, home?: string): string {
  const base = home?.replace(/[\\/]+$/, "");
  if (!base) return value;
  const rest = value.slice(base.length);
  return value.slice(0, base.length).toLowerCase() === base.toLowerCase() && /^[\\/]/.test(rest) ? `~${rest}` : value;
}

/** Bytes as the consent screen shows them: MB below one gigabyte, otherwise GB. */
function size(bytes: number, locale: string): string {
  const gb = bytes >= 1e9;
  return `${(bytes / (gb ? 1e9 : 1e6)).toLocaleString(locale, { maximumFractionDigits: 1 })} ${gb ? "GB" : "MB"}`;
}

/**
 * The view before the application: one centred panel. On a new installation it first says what the app will
 * copy and whom it will contact, and nothing starts before the user agrees (TALK-001 D3/D7/D11); the folders
 * sit under "Change folders". Purposes sit in HelpDots so the paths stay readable. Rows only collect changes;
 * the one button applies them all, and on a clean machine it also creates the suggested archive.
 */
export function FirstRun({ onDone }: { onDone: () => void }) {
  const { language, setLanguage, t, locale } = useI18n();
  const state = useAsync(() => api.setup(), []);
  const data: SetupState | null = state.data ?? null;
  // Only an installation whose first import still waits asks for consent; a configured one keeps the folder view (D10).
  const status = useAsync(() => api.setupStatus(), []);
  const consent = status.data?.locations_confirmed === false;
  const preview = useAsync(() => consent ? api.setupPreview() : Promise.resolve(null), [consent]);
  const [readings, setReadings] = useState(true);
  const [cloud, setCloud] = useState(false);
  const [folders, setFolders] = useState(false);
  const [rows, setRows] = useState<SetupRow[]>([]);
  const [pending, setPending] = useState<Record<FolderKey, string>>({ archive: "", config: "", database: "", temporary: "", snapshot: "" });
  const [archiveAction, setArchiveAction] = useState<"create" | "connect">("create");
  const [editing, setEditing] = useState<FolderKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [initialSources, setInitialSources] = useState("");
  const [done, setDone] = useState<{ wrote: string[]; restart: string | null } | null>(null);
  const databaseMove = useDatabaseMove();
  useEffect(() => {
    if (!data) return;
    // Detected sources are saved as suggested; the advanced section is only for corrections.
    const initial = data.suggestion.map((s) => ({ ...s, editedId: s.id, include: true }));
    setRows(initial);
    setInitialSources(JSON.stringify(setupDeclarations(initial)));
  }, [data]);
  const value = (key: FolderKey) => pending[key].trim();
  // Saving on a clean machine is the explicit choice to create the suggested archive (missing or empty folder).
  const archiveKind = data ? data.archive.kind ?? (data.archive.exists ? "archive" : "missing") : null;
  const createDefault = (archiveKind === "missing" || archiveKind === "empty") && !value("archive");
  const folderChanged = Boolean(value("archive") || value("config") || value("snapshot"));
  const restarts = folderChanged || Boolean(value("database"));
  const sourcesEdited = data != null && JSON.stringify(setupDeclarations(rows)) !== initialSources;
  const labels: Record<FolderKey, string> = {
    archive: t("Archive", "Archiwum"), config: t("Configuration", "Konfiguracja"), database: t("Database", "Baza danych"),
    temporary: t("Temporary", "Tymczasowe"), snapshot: t("Snapshots", "Snapshoty"),
  };
  const changedLabels = (Object.keys(pending) as FolderKey[]).filter((key) => value(key)).map((key) => labels[key]);
  const chooseFolder = async (): Promise<string | null> => {
    setErr(null);
    try { return (await api.chooseArchiveDirectory()).path; }
    catch (error) { setErr(error instanceof Error ? error.message : String(error)); return null; }
  };
  // Order matters: the temporary folder applies at once, declarations and folders are written next, and
  // a database move goes last because it restarts the server. Folders confirmed after a restart only.
  const start = async () => {
    if (!data) return;
    setBusy(true);
    setErr(null);
    try {
      if (value("temporary")) await api.saveTemporaryDirectory(value("temporary"));
      let restartReason: string | null = null, wrote: string[] = [];
      if (folderChanged || sourcesEdited || !data.configured) {
        const archive = value("archive") || (createDefault ? data.archive.root : "");
        // Accounts come from each provider's login; a subscription that names no account would never
        // match one and only shadow the real account, so the first save declares sources alone.
        const declarations = setupDeclarations(rows);
        const res = await api.setupSave({
          archive: archive || null,
          ...(archive ? { archiveAction: value("archive") ? archiveAction : "create" } : {}),
          // An inherited configuration folder must be named, or choosing the archive would move it.
          config: value("config") || (createDefault && data.config.explicit ? data.config.root : null),
          snapshot: value("snapshot") || null,
          ...declarations,
          subscriptions: declarations.subscriptions.filter((subscription) => subscription.account),
        });
        wrote = res.wrote;
        if (res.restart_required) restartReason = res.restart_reason;
      }
      if (value("database")) {
        // The server restarts itself onto the moved copy and the page reloads; the screen asks again there.
        await databaseMove.relocate(value("database"));
        return;
      }
      if (restartReason) { setDone({ wrote, restart: restartReason }); return; }
      await api.confirmLocations(consent ? { limit_readings: readings, cloud_import: cloud } : {});
      // The tour opens with the application, while the import runs (TALK-001 D13).
      if (consent) requestTourAfterConsent();
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const row = (key: FolderKey, props: { path: string; status?: ReactNode; note?: ReactNode; placeholder?: string; explanation: ReactNode; extra?: ReactNode }) => (
    <LocationRow label={labels[key]} {...props} home={data?.home} pending={pending[key]} editing={editing === key}
      disabled={busy || !!databaseMove.moving} onEdit={(open) => setEditing(open ? key : null)}
      onPending={(next) => setPending((current) => ({ ...current, [key]: next }))} choose={chooseFolder} />
  );
  const error = err ?? databaseMove.error;
  return (
    <div className="first-run">
      <div className="ui-card first-run-panel">
        <div className="first-run-top">
          <Brand />
          <div role="group" aria-label={t("Language", "Język")} className="shell-lang">
            {LANGUAGE_OPTIONS.map(({ value: option, label }) => (
              <button key={option} type="button" aria-pressed={language === option} onClick={() => setLanguage(option)}
                title={label} className={`shell-lang-option${language === option ? " is-active" : ""}`}>
                {option.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} />
          : !data || (!status.data && !status.error) ? <div className="first-run-loading"><LoadingStatus label={t("Checking what this machine knows about itself", "Sprawdzam, co ta maszyna o sobie wie")} /></div>
          : done ? <Saved done={done} onDone={onDone} />
          : <>
            <div className="first-run-head">
              <h1 className="first-run-title">{consent ? t("What tokenAtlas will do", "Co zrobi tokenAtlas") : t("Where tokenAtlas keeps its data", "Gdzie tokenAtlas trzyma dane")}</h1>
              <span className="first-run-machine">{data.machine} / {data.login}</span>
            </div>
            {consent ? <p className="first-run-lead">
              {t("Nothing is copied or sent until you agree.", "Nic nie jest kopiowane ani wysyłane, dopóki się nie zgodzisz.")}{" "}
              <HelpDot label={t("Antivirus", "Antywirus")}>{t(
                "An antivirus may react while the app reads sign-in files and many session files. Everything it reads and contacts is listed here; sign-ins stay on this computer and go only to their own provider.",
                "Antywirus może zareagować, gdy aplikacja czyta pliki logowania i wiele plików sesji. Wszystko, co czyta i z czym się łączy, jest wypisane tutaj; logowania zostają na tym komputerze i trafiają tylko do swojego dostawcy.")}</HelpDot>
            </p> : <p className="first-run-lead">
              {createDefault
                ? t("The defaults are ready: save to create the archive and start.", "Domyślne ustawienia są gotowe: zapisz, aby utworzyć archiwum i zacząć.")
                : t("Check the folders before the first import; the defaults usually fit.", "Sprawdź foldery przed pierwszym importem; domyślne zwykle pasują.")}
            </p>}
            {/* A missing archive is said on its row; the server's reason then only repeats it. */}
            {data.reason && data.archive.exists && <p className="first-run-reason" role="alert">{data.reason}</p>}
            {consent && <ConsentFacts preview={preview.data ?? null} error={preview.error} archive={data.archive.root} home={data.home}
              readings={readings} setReadings={setReadings} cloud={cloud} setCloud={setCloud} disabled={busy} locale={locale} />}
            {consent && <div className="first-run-advanced">
              <Disclosure open={folders} onToggle={() => setFolders((open) => !open)} controls="first-run-folders">
                {t("Change folders", "Zmień foldery")}
              </Disclosure>
            </div>}
            {(!consent || folders) && <div id="first-run-folders">
              <div className="first-run-rows">
                <Group title={t("Source data", "Dane źródłowe")}
                  hint={t("One computer: keep the default folder. Several computers: choose a network or synced folder, the same one on each computer; the configuration follows the archive.",
                    "Jeden komputer: zostaw domyślny folder. Kilka komputerów: wskaż folder sieciowy lub synchronizowany, ten sam na każdym komputerze; konfiguracja idzie za archiwum.")} />
                {row("archive", {
                  path: data.archive.root,
                  status: archiveKind === "missing" || archiveKind === "empty" ? <Pill tone="accent">{t("new", "nowe")}</Pill>
                    : archiveKind === "other" ? <Pill tone="warn">{t("not empty", "niepusty")}</Pill> : null,
                  note: createDefault ? t("Created on save. Several computers? Choose a shared network folder (Change…).",
                    "Powstanie przy zapisie. Kilka komputerów? Wskaż wspólny folder sieciowy (Zmień…).")
                    : archiveKind === "other" && !value("archive") ? t("This folder holds other files. Choose an empty folder (Change…).",
                    "Ten folder zawiera inne pliki. Wskaż pusty folder (Zmień…).") : null,
                  extra: (
                    <Dropdown ariaLabel={t("Archive operation", "Operacja archiwum")} value={archiveAction} disabled={busy}
                      onChange={value => setArchiveAction(value as "create" | "connect")} className="ui-input" options={[
                        { value: "create", label: t("Create in an empty folder", "Utwórz w pustym folderze") },
                        { value: "connect", label: t("Connect an existing archive", "Podłącz istniejące archiwum") },
                      ]} />
                  ),
                  explanation: t("Provider originals from every computer; the whole history is rebuilt from them. Worth a backup.",
                    "Oryginały od dostawców ze wszystkich komputerów; z nich odtwarza się całą historię. Warto mieć kopię."),
                })}
                {row("config", {
                  path: data.config.root,
                  status: data.config.present.length > 0 ? null : createDefault
                    ? <Pill tone="accent">{t("new", "nowa")}</Pill>
                    : <Pill tone="warn">{t("missing", "brak")}</Pill>,
                  explanation: t("Subscriptions, projects, account periods: the same rules on every computer. Inside the archive by default.",
                    "Subskrypcje, projekty, okresy kont: te same zasady na każdym komputerze. Domyślnie w archiwum."),
                })}
                <Group tone="neutral" badge={t("local", "lokalne")} title={t("This computer only", "Tylko ten komputer")}
                  hint={t("Local disk, never synced: each computer builds its own from the shared archive.",
                    "Dysk lokalny, bez synchronizacji: każdy komputer buduje własne ze wspólnego archiwum.")} />
                {row("database", {
                  path: data.snapshot.database, placeholder: data.snapshot.database.replace(/[/\\][^/\\]+$/, ""),
                  explanation: t("This computer's results and import progress. The move copies it; the original stays as a backup.",
                    "Wyliczenia i postęp importu tego komputera. Przeniesienie kopiuje bazę; oryginał zostaje jako kopia."),
                })}
                {data.temporary && row("temporary", {
                  path: data.temporary.root,
                  explanation: t("Disposable working files; can be emptied while the app is stopped.",
                    "Pliki robocze do wyrzucenia; można je czyścić, gdy aplikacja jest zatrzymana."),
                })}
                {row("snapshot", {
                  path: data.snapshot.root,
                  explanation: t("Database copy taken before a migration. Beside the database.",
                    "Kopia bazy przed migracją. Obok bazy."),
                })}
                <div className="first-run-row">
                  <div className="first-run-label">
                    {t("Sources", "Źródła")}
                    <HelpDot label={t("Sources", "Źródła")}>{t("Detected provider folders; new sessions are copied to the archive.",
                      "Wykryte foldery dostawców; nowe sesje trafiają do archiwum.")}</HelpDot>
                  </div>
                  <div className="first-run-sources">
                    {data.live.some((l) => l.exists)
                      ? data.live.filter((l) => l.exists).map((l) => <span key={l.vendor} title={l.path}><Pill dot>{l.vendor}</Pill></span>)
                      : <Pill tone="warn">{t("none found", "nie znaleziono")}</Pill>}
                  </div>
                  <div />
                </div>
              </div>
              <div className="first-run-advanced">
                <Disclosure open={advanced} onToggle={() => setAdvanced((open) => !open)} controls="first-run-sources">
                  {t("Advanced: profiles and subscriptions", "Zaawansowane: profile i subskrypcje")}
                </Disclosure>
                {advanced && <div id="first-run-sources">
                  <SetupSources data={data} rows={rows} setRows={setRows} onError={setErr} Frame={Section} />
                  {data.notes.length > 0 && <Section>
                    <div className="first-run-section-title">{t("Check this", "Do sprawdzenia")}</div>
                    <ul className="first-run-notes">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                  </Section>}
                </div>}
              </div>
            </div>}
            {error && <p className="first-run-error" role="alert">{error}</p>}
            <div className="first-run-foot">
              <span className="first-run-foot-note">
                {editing !== null
                  ? t("Finish the open change first: Done or Cancel.", "Najpierw zakończ otwartą zmianę: Gotowe albo Anuluj.")
                  : changedLabels.length === 0
                  ? t("Every folder can be changed later in Settings.", "Każdy folder zmienisz później w Ustawieniach.")
                  : <>
                    <strong>{t("To save:", "Do zapisania:")}</strong> {changedLabels.join(", ")}.{" "}
                    {restarts && t("The app restarts, then you confirm the folders once more.", "Aplikacja uruchomi się ponownie, potem jeszcze raz potwierdzisz foldery.")}
                  </>}
              </span>
              <GhostButton emphasis onClick={start} disabled={busy || editing !== null || !!databaseMove.moving}>
                {databaseMove.moving ? t("Moving the database…", "Przenoszę bazę…")
                  : busy ? t("Saving…", "Zapisuję…")
                  : restarts ? t("Save and restart", "Zapisz i uruchom ponownie")
                  : consent ? t("I agree, start", "Zgadzam się, zacznij")
                  : changedLabels.length || !data.configured ? t("Save and start", "Zapisz i zacznij")
                  : t("Start with these folders", "Zacznij z tymi folderami")}
              </GhostButton>
            </div>
          </>}
      </div>
    </div>
  );
}

/**
 * What the first import will copy and whom the app will contact, from a read-only scan of this computer (D11),
 * with the two network toggles (D4: cloud history off by default). Hosts sit on the rows; reasons in HelpDots.
 */
function ConsentFacts({ preview, error, archive, home, readings, setReadings, cloud, setCloud, disabled, locale }: {
  preview: SourcePreview | null; error: string | null; archive: string; home?: string; locale: string;
  readings: boolean; setReadings: (on: boolean) => void; cloud: boolean; setCloud: (on: boolean) => void; disabled: boolean;
}) {
  const { t } = useI18n();
  const readingHosts = preview?.readings.map(reading => reading.via_cli
    ? t("OpenAI through your Codex CLI", "OpenAI przez Twoje Codex CLI") : reading.hosts.join(", ")) ?? [];
  return (
    <div className="first-run-rows">
      <Group title={t("Copies into the archive", "Kopiuje do archiwum")}
        hint={t("Session files of your AI tools are copied into the archive and analysed there. The originals are only read, never changed.",
          "Pliki sesji Twoich narzędzi AI są kopiowane do archiwum i tam analizowane. Oryginały są tylko czytane, nigdy zmieniane.")} />
      {error ? <p className="first-run-reason" role="alert">{error}</p>
        : !preview ? <div className="first-run-row"><LoadingStatus label={t("Counting session files", "Liczę pliki sesji")} /></div>
        : preview.sources.length === 0 ? <div className="first-run-row"><div className="first-run-label">{t("Sources", "Źródła")}</div>
          <div className="first-run-path"><span><Pill tone="warn">{t("none found", "nie znaleziono")}</Pill></span></div><div /></div>
        : preview.sources.map(source => (
          <div key={source.vendor} className="first-run-row" data-consent-source={source.vendor}>
            <div className="first-run-label">
              {VENDOR_LABELS[source.vendor as keyof typeof VENDOR_LABELS] ?? source.vendor}
              <HelpDot label={t("Folders", "Foldery")}>{source.paths.map(item => <div key={item} className="mono">{shortPath(item, home)}</div>)}</HelpDot>
            </div>
            <div className="first-run-path">{countLabel(source.files, ["file", "files"], ["plik", "pliki", "plików"])} · {size(source.bytes, locale)}</div>
            <div />
          </div>
        ))}
      <div className="first-run-row">
        <div className="first-run-label">{t("Archive", "Archiwum")}</div>
        <div className="first-run-path">
          <span className="mono" title={archive}>{shortPath(archive, home)}</span>
          <span className="first-run-note">{t("Originals stay untouched.", "Oryginały zostają nietknięte.")}</span>
        </div>
        <div />
      </div>
      <Group title={t("Network", "Sieć")}
        hint={t("Only what is listed here leaves this computer, and only after you agree. Both switches can be changed later in Settings.",
          "Tylko to, co jest tu wypisane, wychodzi z tego komputera, i dopiero po Twojej zgodzie. Oba przełączniki zmienisz później w Ustawieniach.")} />
      <div className="first-run-row">
        <label className="ui-check first-run-label">
          <input type="checkbox" checked={readings} disabled={disabled} onChange={event => setReadings(event.target.checked)} />
          {t("Limit readings", "Odczyty limitów")}
          <HelpDot label={t("Limit readings", "Odczyty limitów")}>{t(
            "Asks each provider how much of your plan's limit is left, using the sign-in already on this computer. Without it the app still counts tokens and costs from the copied files.",
            "Pyta każdego dostawcę, ile zostało z limitu planu, używając logowania, które już jest na tym komputerze. Bez tego aplikacja nadal liczy tokeny i koszty ze skopiowanych plików.")}</HelpDot>
        </label>
        <div className="first-run-path mono">{readingHosts.length ? readingHosts.join(" · ") : "—"}</div>
        <div />
      </div>
      <div className="first-run-row">
        <label className="ui-check first-run-label">
          <input type="checkbox" checked={cloud} disabled={disabled} onChange={event => setCloud(event.target.checked)} />
          {t("Claude cloud history", "Historia Claude z chmury")}
          <HelpDot label={t("Claude cloud history", "Historia Claude z chmury")}>{t(
            "Downloads your Claude Code sessions that ran in Anthropic's cloud, using your Claude Code sign-in. Off by default.",
            "Pobiera Twoje sesje Claude Code uruchomione w chmurze Anthropic, używając logowania Claude Code. Domyślnie wyłączone.")}</HelpDot>
        </label>
        <div className="first-run-path mono">{preview?.cloud.hosts.join(", ") ?? "—"}</div>
        <div />
      </div>
      <div className="first-run-row">
        <div className="first-run-label">
          {t("Exchange rates", "Kursy walut")}
          <HelpDot label={t("Exchange rates", "Kursy walut")}>{t(
            "Only when you declare a payment in another currency than USD: the NBP rate of that day. Only dates are sent.",
            "Tylko gdy zadeklarujesz płatność w innej walucie niż USD: kurs NBP z tego dnia. Wysyłane są tylko daty.")}</HelpDot>
        </div>
        <div className="first-run-path">
          <span className="mono">{preview?.rates.hosts.join(", ") ?? "—"}</span>
          <span className="first-run-note">{t("only for payments in another currency", "tylko dla płatności w innej walucie")}</span>
        </div>
        <div />
      </div>
    </div>
  );
}

/** A heading inside the folder list that says whether the folders below are shared or local; the advice sits in its HelpDot. */
function Group({ tone = "neutral", badge, title, hint }: { tone?: "accent" | "neutral"; badge?: string; title: string; hint: string }) {
  return (
    <div className="first-run-group">
      <span className="first-run-group-title">{title}</span>
      {badge && <Pill tone={tone}>{badge}</Pill>}
      <HelpDot label={title}>{hint}</HelpDot>
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <section className="first-run-section">{children}</section>;
}

/**
 * One folder: name (purpose in its HelpDot), location and "Change…". Editing happens in a recessed well on a draft;
 * "Done" keeps it as a pending change, "Cancel" (or Esc) drops the draft. Nothing is written here.
 */
function LocationRow({ label, path, home, status, note, placeholder, explanation, extra, pending, editing, disabled, onEdit, onPending, choose }: {
  label: string;
  path: string;
  home?: string;
  status?: ReactNode;
  note?: ReactNode;
  placeholder?: string;
  explanation: ReactNode;
  extra?: ReactNode;
  pending: string;
  editing: boolean;
  disabled: boolean;
  onEdit: (open: boolean) => void;
  onPending: (value: string) => void;
  choose: () => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(pending);
  const next = pending.trim();
  const open = () => { setDraft(pending); onEdit(true); };
  const keep = () => { onPending(draft.trim()); onEdit(false); };
  const cancel = () => onEdit(false);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter") { event.preventDefault(); keep(); }
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
  };
  return (
    <div className={`first-run-row${editing ? " is-editing" : ""}`}>
      <div className="first-run-label">
        {label}
        <HelpDot label={label}>{explanation}</HelpDot>
        {!next && status}
      </div>
      <div className="first-run-path">
        <span className={`mono${next ? " is-replaced" : ""}`} title={path}>{shortPath(path, home)}</span>
        {next && <span className="mono is-next" title={next}>→ {shortPath(next, home)}</span>}
        {!next && note && <span className="first-run-note">{note}</span>}
      </div>
      <div className="first-run-change">
        {!editing && <GhostButton onClick={open} disabled={disabled}>{t("Change…", "Zmień…")}</GhostButton>}
      </div>
      {editing && (
        <div className="first-run-editor" onKeyDown={keys}>
          <div className="first-run-editor-field">
            <input autoFocus aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder ?? path} className="ui-input" disabled={disabled} />
            <GhostButton onClick={async () => { const picked = await choose(); if (picked) setDraft(picked); }} disabled={disabled}>
              {t("Choose folder…", "Wybierz folder…")}
            </GhostButton>
            {draft.trim() ? extra : null}
          </div>
          <div className="first-run-editor-actions">
            {next && <button type="button" className="ui-link-button" onClick={() => { onPending(""); onEdit(false); }}>
              {t("Keep the current folder", "Zostaw obecny folder")}
            </button>}
            <button type="button" className="ui-link-button" onClick={cancel}>{t("Cancel", "Anuluj")}</button>
            <GhostButton emphasis onClick={keep} disabled={disabled || !draft.trim()}>{t("Done", "Gotowe")}</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

function Saved({ done, onDone }: { done: { wrote: string[]; restart: string | null }; onDone: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <h1 className="first-run-title">{t("Saved", "Zapisane")}</h1>
      <ul className="first-run-notes">{done.wrote.map((w) => <li key={w} className="mono">{w}</li>)}</ul>
      {done.restart
        ? <p className="first-run-reason">{done.restart}</p>
        : <div className="first-run-foot"><GhostButton emphasis onClick={onDone}>{t("Go to dashboard", "Przejdź do pulpitu")}</GhostButton></div>}
    </>
  );
}
