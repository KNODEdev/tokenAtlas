import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type SetupState } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Disclosure, Dropdown, ErrorState, GhostButton, HelpDot, Pill } from "../components/ui";
import { LoadingStatus } from "../components/LoadingStatus";
import { Brand } from "../components/Sidebar";
import { LANGUAGE_OPTIONS, useI18n } from "../lib/i18n";
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

/**
 * The view before the application: one centred panel with every folder the app uses. Purposes sit
 * in HelpDots so the paths stay readable. Rows only collect changes; the one button applies them all,
 * and on a clean machine it also creates the suggested archive.
 */
export function FirstRun({ onDone }: { onDone: () => void }) {
  const { language, setLanguage, t } = useI18n();
  const state = useAsync(() => api.setup(), []);
  const data: SetupState | null = state.data ?? null;
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
      await api.confirmLocations();
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
          : !data ? <div className="first-run-loading"><LoadingStatus label={t("Checking what this machine knows about itself", "Sprawdzam, co ta maszyna o sobie wie")} /></div>
          : done ? <Saved done={done} onDone={onDone} />
          : <>
            <div className="first-run-head">
              <h1 className="first-run-title">{t("Where tokenAtlas keeps its data", "Gdzie tokenAtlas trzyma dane")}</h1>
              <span className="first-run-machine">{data.machine} / {data.login}</span>
            </div>
            <p className="first-run-lead">
              {createDefault
                ? t("The defaults are ready: save to create the archive and start.", "Domyślne ustawienia są gotowe: zapisz, aby utworzyć archiwum i zacząć.")
                : t("Check the folders before the first import; the defaults usually fit.", "Sprawdź foldery przed pierwszym importem; domyślne zwykle pasują.")}
            </p>
            {/* A missing archive is said on its row; the server's reason then only repeats it. */}
            {data.reason && data.archive.exists && <p className="first-run-reason" role="alert">{data.reason}</p>}
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
                  : changedLabels.length || !data.configured ? t("Save and start", "Zapisz i zacznij")
                  : t("Start with these folders", "Zacznij z tymi folderami")}
              </GhostButton>
            </div>
          </>}
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
