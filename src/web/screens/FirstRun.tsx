import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type SetupState } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { Disclosure, Dropdown, ErrorState, GhostButton, Pill } from "../components/ui";
import { LoadingStatus } from "../components/LoadingStatus";
import { Brand } from "../components/Sidebar";
import { LANGUAGE_OPTIONS, useI18n } from "../lib/i18n";
import { SetupSources, setupDeclarations, useDatabaseMove, type SetupRow } from "./Setup";
import "../components/AppHeader.css";
import "./FirstRun.css";

type FolderKey = "archive" | "config" | "database" | "temporary" | "snapshot";

/**
 * The view before the application: one centred panel with every folder the app uses, each beside a
 * short explanation. Rows only collect changes; the one button at the bottom applies them all.
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
    const initial = data.suggestion.map((s) => ({ ...s, editedId: s.id, include: true }));
    setRows(initial);
    setInitialSources(JSON.stringify(setupDeclarations(initial)));
    // Without declared accounts the sources are the one thing left to answer, so they start open.
    setAdvanced(!data.configured);
  }, [data]);
  const value = (key: FolderKey) => pending[key].trim();
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
        const res = await api.setupSave({
          archive: value("archive") || null,
          ...(value("archive") ? { archiveAction } : {}),
          config: value("config") || null,
          snapshot: value("snapshot") || null,
          ...setupDeclarations(rows),
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
  const row = (key: FolderKey, props: { path: string; missing?: boolean; placeholder?: string; explanation: ReactNode; extra?: ReactNode }) => (
    <LocationRow label={labels[key]} {...props} pending={pending[key]} editing={editing === key}
      disabled={busy || !!databaseMove.moving} onEdit={(open) => setEditing(open ? key : null)}
      onPending={(next) => setPending((current) => ({ ...current, [key]: next }))} choose={chooseFolder} />
  );
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
              {t("Check the folders before the first import; the defaults usually fit.",
                "Sprawdź foldery przed pierwszym importem; domyślne zwykle pasują.")}
            </p>
            {data.reason && <p className="first-run-reason" role="alert">{data.reason}</p>}
            <div className="first-run-rows">
              <div className="first-run-row is-head" aria-hidden="true">
                <span>{t("Folder", "Folder")}</span>
                <span>{t("What it holds", "Co przechowuje")}</span>
                <span>{t("Location", "Lokalizacja")}</span>
                <span />
              </div>
              <Group tone="accent" badge={t("synced", "synchronizowane")} title={t("Shared by all computers", "Wspólne dla wszystkich komputerów")}
                hint={t("Keep them in OneDrive or another synced folder and point every computer at the same place.",
                  "Trzymaj je w OneDrive lub innym synchronizowanym folderze i wskaż to samo miejsce na każdym komputerze.")} />
              {row("archive", {
                path: data.archive.root, missing: !data.archive.exists,
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
                path: data.config.root, missing: data.config.present.length === 0,
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
                  "Kopia bazy przed migracją. Obok bazy, nigdy w OneDrive."),
              })}
              <div className="first-run-row">
                <div className="first-run-label">{t("Sources", "Źródła")}{data.live.some((l) => l.exists) ? null : <Pill tone="warn">{t("missing", "brak")}</Pill>}</div>
                <div className="first-run-explain">{t("Detected provider folders; new sessions are copied to the archive.",
                  "Wykryte foldery dostawców; nowe sesje trafiają do archiwum.")}</div>
                <div className="mono first-run-path">{data.live.filter((l) => l.exists).map((l) => l.vendor).join(", ") || t("none found", "nie znaleziono")}</div>
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
            {(err ?? databaseMove.error) && <ErrorState message={(err ?? databaseMove.error)!} onRetry={() => setErr(null)} />}
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
                  : changedLabels.length ? t("Save and start", "Zapisz i zacznij")
                  : t("Start with these folders", "Zacznij z tymi folderami")}
              </GhostButton>
            </div>
          </>}
      </div>
    </div>
  );
}

/** A heading inside the folder list that says whether the folders below are shared or local. */
function Group({ tone, badge, title, hint }: { tone: "accent" | "neutral"; badge: string; title: string; hint: string }) {
  return (
    <div className="first-run-group">
      <span className="first-run-group-title">{title}</span>
      <Pill tone={tone}>{badge}</Pill>
      <span className="first-run-group-hint">{hint}</span>
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <section className="first-run-section">{children}</section>;
}

/**
 * One folder: name, purpose, location and "Change…". Editing happens in a recessed well on a draft;
 * "Done" keeps it as a pending change, "Cancel" (or Esc) drops the draft. Nothing is written here.
 */
function LocationRow({ label, path, missing, placeholder, explanation, extra, pending, editing, disabled, onEdit, onPending, choose }: {
  label: string;
  path: string;
  missing?: boolean;
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
      <div className="first-run-label">{label}{!next && missing ? <Pill tone="warn">{t("missing", "brak")}</Pill> : null}</div>
      <div className="first-run-explain">{explanation}</div>
      <div className="mono first-run-path">
        <span className={next ? "is-replaced" : undefined}>{path}</span>
        {next && <span className="is-next">→ {next}</span>}
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
