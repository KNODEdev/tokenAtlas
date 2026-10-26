import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { api, type SetupState, type SuggestedSubscription } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { DataTable, TableRow, Card, CardTitle, Dropdown, ErrorState, GhostButton, LoadingCard, Pill } from "../components/ui";
import { polishPlural } from "../lib/mixFormat";
import { useI18n } from "../lib/i18n";
import type { CloudSessionsResponse } from "../../shared/cloud-sessions";
export interface SetupRow extends SuggestedSubscription {
  editedId: string;
  include: boolean;
}
/** The wizard may display an owner from periods, but saving a source never assigns one. */
export function setupDeclarations(rows: SetupRow[]) {
  const included = rows.filter(row => row.include);
  return {
    sources: included.map(row => ({vendor:row.vendor,machine:row.machine,login:row.login,home:row.home,
      ...(row.source_home ? {source_home:row.source_home} : {})})),
    subscriptions: included.filter(row => row.editedId.trim() &&
      (row.found_in === "live" || row.editedId.trim() !== row.id.trim())).map(row => ({
      id:row.editedId.trim(),vendor:row.vendor,machine:row.machine,login:row.login,home:row.home,
      ...(row.source_home ? {source_home:row.source_home} : {}),
      ...(row.account ? {account:row.account} : {}),
      ...(row.from ? {from:row.from} : {}), ...(row.until ? {until:row.until} : {}),
      ...(row.note ? {note:row.note} : {}),
    })),
  };
}
type Translate = (en: string, pl: string) => string;

function countLabel(
  t: Translate,
  n: number,
  enOne: string,
  enMany: string,
  plOne: string,
  plFew: string,
  plMany: string,
): string {
  return t(Math.abs(n) === 1 ? enOne : enMany, polishPlural(n, plOne, plFew, plMany));
}
export function Setup({ onDone, heading }: { onDone: () => void; heading?: string }) {
  const { t } = useI18n();
  const title = heading ?? t("First setup", "Pierwsze uruchomienie");
  const state = useAsync(() => api.setup(), []);
  const [rows, setRows] = useState<SetupRow[]>([]);
  const [archive, setArchive] = useState("");
  const [archiveAction, setArchiveAction] = useState<"create"|"connect">("create");
  const [config, setConfig] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ wrote: string[]; restart: string | null } | null>(null);
  const data: SetupState | null = state.data ?? null;
  useEffect(() => {
    if (!data) return;
    setRows(data.suggestion.map((s) => ({ ...s, editedId: s.id, include: true })));
    setArchive("");
    setConfig("");
    setSnapshot("");
  }, [data]);
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!data) return <LoadingCard label={t("Checking what this machine knows about itself", "Sprawdzam, co ta maszyna o sobie wie")} height={320} />;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.setupSave({
        archive: archive.trim() || null,
        ...(archive.trim()?{archiveAction}:{}),
        config: config.trim() || null,
        snapshot: snapshot.trim() || null,
        ...setupDeclarations(rows),
      });
      setDone({ wrote: res.wrote, restart: res.restart_required ? res.restart_reason : null });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const chooseDirectory = async () => {
    setBusy(true);setErr(null);
    try { const result=await api.chooseArchiveDirectory(); if(result.path)setArchive(result.path); }
    catch(error) {setErr(error instanceof Error?error.message:String(error));}
    finally {setBusy(false);}
  };
  if (done) {
    return (
      <Card>
        <CardTitle title={t("Saved", "Zapisane")} sub={t("this machine's configuration is in place", "konfiguracja tej maszyny jest na miejscu")} />
        <div style={{ fontSize: "var(--fs-4)", lineHeight: 1.7 }}>
          {t("Saved files:", "Zapisane pliki:")}
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {done.wrote.map((w) => (
              <li key={w} className="mono" style={{ fontSize: "var(--fs-3)" }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
        {done.restart ? (
          <div style={{ marginTop: 14, fontSize: "var(--fs-4)", color: "var(--warn)", lineHeight: 1.6 }}>
            {done.restart}
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <GhostButton onClick={onDone}>{t("Go to dashboard", "Przejdź do pulpitu")}</GhostButton>
          </div>
        )}
        <div style={{ marginTop: 14, fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.6, maxWidth: 760 }}>
          {t("The next step is", "Kolejny krok to")} <span className="mono">_sync.bat</span>{t(": it copies transcripts to the archive, indexes them, and recalculates project assignments. Until it runs, screens will be empty - the index is simply empty.", ": dociąga transkrypty do archiwum, indeksuje je i przelicza przypisania projektów. Dopóki nie przebiegnie, ekrany będą puste — nie dlatego, że coś jest źle, tylko dlatego, że indeks jest jeszcze pusty.")}
        </div>
      </Card>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-8)", maxWidth: 1000 }}>
      <Card>
        <CardTitle
          title={title}
          sub={`${data.machine} / ${data.login}${t(" - ", " — ")}${t("profile", "profil")} ${data.profile}`}
        />
        {data.reason && (
          <div style={{ fontSize: "var(--fs-5)", color: "var(--warn)", lineHeight: 1.6, marginBottom: 12 }}>{data.reason}</div>
        )}
        <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.7, maxWidth: 820 }}>
          {t("Source folders → shared source archive → local results. Choose any archive folder; OneDrive is optional. Transcripts, original readings and input declarations preserve your history. Calculated results and processing progress stay in this computer's database; temporary files have a separate folder.", "Foldery źródłowe → wspólne archiwum źródeł → lokalne wyniki. Możesz wybrać dowolny folder archiwum; OneDrive jest opcjonalny. Transkrypty, oryginalne odczyty i deklaracje wejściowe zachowują historię. Wyliczenia i postęp przetwarzania pozostają w bazie tego komputera, a pliki tymczasowe mają osobny folder.")}
        </div>
      </Card>
      <Card>
        <CardTitle title={t("What is visible on this machine", "Co widać na tej maszynie")} help={t("Detected automatically; change only if it is wrong.", "Wykryte automatycznie; do zmiany tylko, jeśli się nie zgadza.")} />
        <div style={{ display: "grid", gap: 0, fontSize: "var(--fs-4)" }}>
          <Found label={t("Archive", "Archiwum")} ok={data.archive.exists} value={data.archive.root}>
            {data.archive.exists
              ? `${data.archive.vendors.length} ${countLabel(t, data.archive.vendors.length, "vendor", "vendors", "vendor", "vendory", "vendorów")}: ${data.archive.vendors.map((v) => `${v.vendor} (${v.profiles.length})`).join(", ")}`
              : t("does not exist - there is nothing to index without it", "nie istnieje — bez niego nie ma czego indeksować")}
          </Found>
          <Found label={t("Configuration", "Konfiguracja")} ok={data.config.present.length > 0} value={data.config.root}>
            {data.config.present.length > 0
              ? `${t("present:", "jest:")} ${data.config.present.join(", ")}`
              : t("empty - it will be created on save", "pusta — powstanie przy zapisie")}
          </Found>
          <Found label={t("Local index snapshots", "Lokalne snapshoty indeksu")} ok={data.snapshot.exists} value={data.snapshot.root}>
            {t("Created before a real schema migration or on request; never inside OneDrive", "Tworzone przed rzeczywistą migracją schematu albo na żądanie; nigdy wewnątrz OneDrive")}
          </Found>
          <Found label={t("Live sources", "Żywe źródła")} ok={data.live.some((l) => l.exists)} value={data.live.filter((l) => l.exists).map((l) => l.vendor).join(", ") || t("none", "brak")}>
            {t("vendor directories on this computer that", "katalogi vendorów na tym komputerze, z których")} <span className="mono">_sync.bat</span> {t("copies into the archive", "kopiuje do archiwum")}
          </Found>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 14 }}>
          <Field label={t("Different archive path (optional)", "Inna ścieżka archiwum (opcjonalnie)")}>
            <input
              value={archive}
              onChange={(e) => setArchive(e.target.value)}
              placeholder={data.archive.root}
              className="ui-input"
              style={{ width: 380, maxWidth: "100%" }}
            />
            <GhostButton onClick={chooseDirectory} disabled={busy}>{t("Choose folder…", "Wybierz folder…")}</GhostButton>
          </Field>
          {archive.trim() && <Field label={t("Archive operation", "Operacja archiwum")}>
            <Dropdown value={archiveAction} disabled={busy} onChange={value=>setArchiveAction(value as "create"|"connect")} className="ui-input" options={[
              { value: "create", label: t("Create in an empty folder", "Utwórz w pustym folderze") },
              { value: "connect", label: t("Connect an existing archive", "Podłącz istniejące archiwum") },
            ]} />
          </Field>}
          <Field label={t("Different configuration directory (optional)", "Inny katalog konfiguracji (opcjonalnie)")}>
            <input
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              placeholder={data.config.root}
              className="ui-input"
              style={{ width: 380, maxWidth: "100%" }}
            />
          </Field>
          <Field label={t("Different local snapshot directory (optional)", "Inny lokalny katalog snapshotów (opcjonalnie)")}>
            <input
              value={snapshot}
              onChange={(e) => setSnapshot(e.target.value)}
              placeholder={data.snapshot.root}
              className="ui-input"
              style={{ width: 380, maxWidth: "100%" }}
            />
          </Field>
        </div>
        <div style={{ marginTop: 8, fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          {t("Empty means no change; snapshots default beside the database. An entered path goes to", "Puste = bez zmiany; snapshoty domyślnie leżą obok bazy. Wpisana ścieżka trafi do")} <span className="mono">.env</span> {t("and takes effect after the server restarts - these values are read once at startup.", "i zacznie obowiązywać po restarcie serwera — te wartości czytane są raz, przy starcie.")}
        </div>
        <DatabaseLocation database={data.snapshot.database} disabled={busy} />
        {data.temporary && <TemporaryLocation root={data.temporary.root} disabled={busy} />}
        <CloudSessionsInterval disabled={busy} />
      </Card>
      <SetupSources data={data} rows={rows} setRows={setRows} onError={setErr} Frame={Card} />
      {data.notes.length > 0 && (
        <Card>
          <CardTitle title={t("Check this", "Do sprawdzenia")} help={t("Does not block saving, but it is useful to know.", "Nie blokuje zapisu, ale warto o tym wiedzieć.")} />
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.7 }}>
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Card>
      )}
      {err && <ErrorState message={err} onRetry={() => setErr(null)} />}
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <GhostButton onClick={save} disabled={busy}>
            {busy ? t("saving…", "zapisuję…") : t("Save configuration", "Zapisz konfigurację")}
          </GhostButton>
          <span style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
            {t("Will create ", "Powstanie ")}<span className="mono">accounts.json</span>{t(" in the configuration directory. Nothing will be written to the repository.", " w katalogu konfiguracji. Nic nie zostanie zapisane do repozytorium.")}
          </span>
        </div>
      </Card>
    </div>
  );
}
/** Profiles and source subscriptions; `Frame` wraps each of the two groups (a card in Settings). */
export function SetupSources({ data, rows, setRows, onError, Frame }: {
  data: SetupState;
  rows: SetupRow[];
  setRows: Dispatch<SetStateAction<SetupRow[]>>;
  onError: (message: string | null) => void;
  Frame: (props: { children: ReactNode }) => ReactNode;
}) {
  const { t } = useI18n();
  const [profileVendor, setProfileVendor] = useState("codex");
  const [profileHome, setProfileHome] = useState("");
  const [profileTarget, setProfileTarget] = useState("");
  const [profileId, setProfileId] = useState("");
  const [profileArchive, setProfileArchive] = useState("");
  const merged = useMemo(() => rows.filter((r) => r.merged_from_login), [rows]);
  const hasDeclared = useMemo(() => rows.some((r) => r.found_in === "declared"), [rows]);
  const setRow = (i: number, patch: Partial<SetupRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addProfile = () => {
    const source = profileHome.trim();
    if (!source) { onError(t("Enter a profile directory", "Podaj katalog profilu")); return; }
    const detected = data.profiles?.find(p => p.vendor === profileVendor && p.home === source);
    if (profileTarget !== "") {
      const index = Number(profileTarget);
      const previous = rows[index];
      if (!previous || previous.vendor !== profileVendor) return;
      if (previous.account && detected?.account && previous.account.toLowerCase() !== detected.account.toLowerCase()) {
        onError(t("The selected profile belongs to another account", "Wybrany profil należy do innego konta")); return;
      }
      setRow(index, { source_home: source, machine: data.machine, login: data.login, include: true,
        account: previous.account || detected?.account || undefined });
    } else {
      if (!profileId.trim() || !profileArchive.trim()) {
        onError(t("Enter subscription ID and archive directory", "Podaj ID subskrypcji i katalog archiwum")); return;
      }
      setRows(previous => [...previous, { id: profileId.trim(), editedId: profileId.trim(), vendor: profileVendor,
        machine: data.machine, login: data.login, home: profileArchive.trim(), source_home: source,
        account: detected?.account ?? undefined, found_in: "live", include: true, is_this_machine: true, merged_from_login: false }]);
    }
    onError(null); setProfileHome(""); setProfileTarget(""); setProfileId(""); setProfileArchive("");
  };
  const split = (i: number) => {
    const used = new Set(rows.map((r) => r.editedId.toLowerCase()));
    let n = 1;
    while (used.has(`codex${n}`)) n += 1;
    setRow(i, { editedId: `codex${n}`, merged_from_login: false });
  };
  return (
    <>
      <Frame>
        <CardTitle title={t("Add or move a profile", "Dodaj lub przenieś profil")}
          help={t("Moving preserves the subscription, archive and history. Save the configuration below to apply.", "Przeniesienie zachowuje subskrypcję, archiwum i historię. Zastosuj zmiany przyciskiem Zapisz konfigurację poniżej.")} />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <Field label={t("Provider", "Dostawca")}><Dropdown ariaLabel={t("Profile provider", "Dostawca profilu")} className="ui-input" value={profileVendor}
            onChange={value => { setProfileVendor(value); setProfileTarget(""); setProfileHome(""); }}
            options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }]} /></Field>
          <Field label={t("Profile directory (detected or manual)", "Katalog profilu (wykryty lub wpisany ręcznie)")}>
            <input aria-label={t("Profile directory", "Katalog profilu")} className="ui-input" style={{ width: 340 }} list="atlas-profile-homes" value={profileHome} onChange={e => setProfileHome(e.target.value)} />
            <datalist id="atlas-profile-homes">{data.profiles?.filter(p => p.vendor === profileVendor).map(p => <option key={p.home} value={p.home}>{p.account ?? p.error ?? ""}</option>)}</datalist>
          </Field>
          <Field label={t("Assignment", "Przypisanie")}><Dropdown ariaLabel={t("Profile assignment", "Przypisanie profilu")} className="ui-input" value={profileTarget} onChange={value => setProfileTarget(value)} options={[
            { value: "", label: t("Add a source", "Dodaj źródło") },
            ...rows.flatMap((r, i) => r.vendor === profileVendor && !r.until ? [{ value: String(i), label: `${t("Move", "Przenieś")} ${r.editedId} — ${r.account ?? r.login} — ${r.home}` }] : []),
          ]} /></Field>
          {profileTarget === "" && <>
            <Field label={t("Subscription ID (existing or new)", "ID subskrypcji (istniejące lub nowe)")}><input aria-label={t("New source subscription", "Subskrypcja nowego źródła")} className="ui-input" value={profileId} onChange={e => setProfileId(e.target.value)} /></Field>
            <Field label={t("Archive directory", "Katalog archiwum")}><input aria-label={t("New source archive", "Archiwum nowego źródła")} className="ui-input" style={{ width: 340 }} placeholder={`\${ARCHIVE}/${profileVendor}/${data.profile}-mr`} value={profileArchive} onChange={e => setProfileArchive(e.target.value)} /></Field>
          </>}
          <GhostButton onClick={addProfile}>{t("Apply to list", "Zastosuj do listy")}</GhostButton>
        </div>
        {profileHome && <div style={{ marginTop: 8, fontSize: "var(--fs-4)" }}>{data.profiles?.find(p => p.vendor === profileVendor && p.home === profileHome)?.account ?? t("Identity will be checked when saving. Historical session ownership requires your assignment.", "Tożsamość zostanie sprawdzona przy zapisie. Przypisanie historycznych sesji wymaga Twojej deklaracji.")}</div>}
      </Frame>
      <Frame>
        <CardTitle
          title={t("Source subscriptions", "Subskrypcje źródeł")}
          help={t("Rollouts do not carry an account identifier; this is the only thing that cannot be detected.", "Rollouty nie niosą identyfikatora konta; to jedyna rzecz, której nie da się wykryć.")}
        />
        {rows.length === 0 ? (
          <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)" }}>
            {t("No Codex profile was found. This is not an error - save an empty list if you use only Claude, Gemini, Grok, or opencode.", "Nie znaleziono żadnego profilu Codeksa. To nie jest błąd — zapisz pustą listę, jeśli używasz tylko Claude, Gemini, groka albo opencode.")}
          </div>
        ) : (
          <>
            {merged.length > 0 && (
              <div style={{ fontSize: "var(--fs-4)", color: "var(--muted)", lineHeight: 1.6, marginBottom: 10, maxWidth: 820 }}>
                {merged.length} {countLabel(t, merged.length, "row was merged", "rows were merged", "wiersz został scalony", "wiersze zostały scalone", "wierszy zostało scalonych")} {t("with an earlier row because they share a login - this is what", "z wcześniejszym, bo dzielą login — tak wygląda")} <strong>{t("one account used from two computers", "jedno konto używane z dwóch komputerów")}</strong>.
                {t(" If these are two different accounts, split them: without recognition they would appear as one subscription with a doubled counter.", " Jeśli to jednak dwa różne konta, rozdziel je: nierozpoznane pokazałyby się jako jedna subskrypcja o zdublowanym liczniku.")}
              </div>
            )}
            <DataTable tableId="Setup:0" className="ui-table">
              <thead>
                <TableRow header style={{ textAlign: "left" }}>
                  <th data-column-id="c0" className="ui-th" style={{ width: 34 }}> </th>
                  <th data-column-id="c1" className="ui-th" style={{ width: 110 }}>id</th>
                  <th data-column-id="c2" className="ui-th">{t("machine / login", "maszyna / login")}</th>
                  <th data-column-id="c3" className="ui-th">{t("archive directory", "katalog w archiwum")}</th>
                  <th data-column-id="c4" className="ui-th" style={{ width: 150 }}> </th>
                </TableRow>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <TableRow
                    key={`${r.vendor}:${r.home}:${r.from ?? ""}:${r.until ?? ""}`}
                    style={{ opacity: r.include ? 1 : 0.45 }}
                  >
                    <td className="ui-td">
                      <input
                        type="checkbox"
                        checked={r.include}
                        onChange={(e) => setRow(i, { include: e.target.checked })}
                        aria-label={`${t("Include", "Uwzględnij")} ${r.machine}/${r.login}`}
                        style={{ accentColor: "var(--accent)" }}
                      />
                    </td>
                    <td className="ui-td">
                      <input
                        value={r.editedId}
                        onChange={(e) => setRow(i, { editedId: e.target.value })}
                        className="ui-input"
                        style={{ width: 92 }}
                        aria-label={t("Subscription identifier", "Identyfikator subskrypcji")}
                      />
                    </td>
                    <td className="ui-td">
                      {r.machine} / {r.login || "—"}
                      {r.is_this_machine && (
                        <>
                          {" "}
                          <Pill tone="accent">{t("this machine", "ta maszyna")}</Pill>
                        </>
                      )}
                      {hasDeclared && r.found_in !== "declared" && (
                        <>
                          {" "}
                          <Pill tone="warn">{t("new", "nowa")}</Pill>
                        </>
                      )}
                    </td>
                    <td className="ui-td mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", whiteSpace: "normal" }}>
                      {r.home}
                      {r.source_home && <div>{t("Source", "Źródło")}: {r.source_home}</div>}
                    </td>
                    <td className="ui-td">
                      {r.merged_from_login && (
                        <GhostButton onClick={() => split(i)} title={t("Give this profile its own id", "Nadaj temu profilowi własne id")}>
                          {t("this is another account", "to inne konto")}
                        </GhostButton>
                      )}
                    </td>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </>
        )}
      </Frame>
    </>
  );
}
/** Moving the database copies it, restarts the server and reloads the page once it answers from the new place. */
export function useDatabaseMove() {
  const [destination, setDestination] = useState("");
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const choose = async () => {
    setChoosing(true); setError(null);
    try { const result = await api.chooseArchiveDirectory(); if (result.path) setDestination(result.path); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setChoosing(false); }
  };
  useEffect(() => {
    if (!moving) return;
    let active = true;
    let checking = false;
    const timer = window.setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await api.databaseLocation(AbortSignal.timeout(5000));
        if (!active) return;
        if (status.result?.destination === moving && status.result.error) {
          setError(status.result.error);
          setMoving(null);
        } else if (status.database.replace(/\\/g, "/").toLowerCase() === moving.replace(/\\/g, "/").toLowerCase()) {
          window.location.reload();
        }
      } catch { /* The server is unavailable while the database is copied and reopened. */ }
      finally { checking = false; }
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [moving]);
  const relocate = async (directory: string = destination): Promise<boolean> => {
    setChoosing(true); setError(null);
    try {
      const accepted = await api.relocateDatabaseToFolder(directory.trim());
      setMoving(accepted.destination);
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setChoosing(false); }
  };
  return { destination, setDestination, moving, error, choosing, choose, relocate };
}
function DatabaseLocation({ database, disabled }: { database: string; disabled: boolean }) {
  const { t } = useI18n();
  const { destination, setDestination, moving, error, choosing, choose, relocate } = useDatabaseMove();
  return <div style={{ marginTop: 14 }}>
    <Field label={t("Local database folder", "Folder lokalnej bazy danych")}>
      <div className="mono" style={{ fontSize: "var(--fs-3)", marginBottom: 6 }}>{database}</div>
      <input aria-label={t("New database folder", "Nowy folder bazy danych")} value={destination}
        onChange={event => setDestination(event.target.value)} disabled={disabled || choosing || !!moving}
        placeholder={database.replace(/[/\\][^/\\]+$/, "")} className="ui-input" style={{ width: 380, maxWidth: "100%" }} />
      <GhostButton onClick={choose} disabled={disabled || choosing || !!moving}>{t("Choose folder…", "Wybierz folder…")}</GhostButton>
      <GhostButton onClick={() => void relocate()} disabled={disabled || choosing || !!moving || !destination.trim()}>
        {moving ? t("Moving and restarting…", "Przenoszę i restartuję…") : t("Move database and restart", "Przenieś bazę i restartuj")}
      </GhostButton>
    </Field>
    <div style={{ marginTop: 6, fontSize: "var(--fs-3)", color: "var(--muted)" }}>
      {t("Results and processing progress are durable. Moving copies and verifies the database without recalculating history. Choose a local folder outside the archive and temporary folder. The original remains as a recovery copy; the page reloads after restarting.",
        "Wyniki i postęp przetwarzania są trwałe. Przeniesienie kopiuje i sprawdza bazę bez przeliczania historii. Wybierz lokalny folder poza archiwum i temp. Oryginał pozostanie jako kopia awaryjna; po restarcie strona odświeży się automatycznie.")}
    </div>
    {error && <div role="alert" style={{ marginTop: 6, fontSize: "var(--fs-4)", color: "var(--warn)" }}>{error}</div>}
  </div>;
}
/** The temporary folder takes effect at once; `choose` fills the field, `save` applies it. */
export function useTemporaryFolder(root: string) {
  const [current, setCurrent] = useState(root);
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = async (choose: boolean) => {
    setBusy(true); setError(null);
    try {
      if (choose) { const result = await api.chooseArchiveDirectory(); if (result.path) setDirectory(result.path); }
      else { const result = await api.saveTemporaryDirectory(directory.trim()); setCurrent(result.root); setDirectory(""); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return { current, directory, setDirectory, busy, error, update };
}
function TemporaryLocation({ root, disabled }: { root: string; disabled: boolean }) {
  const { t } = useI18n();
  const { current, directory, setDirectory, busy, error, update } = useTemporaryFolder(root);
  return <div style={{ marginTop: 14 }}>
    <Field label={t("Temporary files folder", "Folder plików tymczasowych")}>
      <div className="mono" style={{ fontSize: "var(--fs-3)", marginBottom: 6 }}>{current}</div>
      <input aria-label={t("New temporary folder", "Nowy folder tymczasowy")} value={directory}
        onChange={event => setDirectory(event.target.value)} disabled={disabled || busy}
        placeholder={current} className="ui-input" style={{ width: 380, maxWidth: "100%" }} />
      <GhostButton onClick={() => update(true)} disabled={disabled || busy}>{t("Choose folder…", "Wybierz folder…")}</GhostButton>
      <GhostButton onClick={() => update(false)} disabled={disabled || busy || !directory.trim()}>{t("Save folder", "Zapisz folder")}</GhostButton>
    </Field>
    <div style={{ marginTop: 6, fontSize: "var(--fs-3)", color: "var(--muted)" }}>
      {t("Used for disposable working files. New operations use the saved folder immediately. After stopping the app, its temporary files can be removed without losing results or import progress.",
        "Służy do przejściowych plików roboczych. Nowe operacje od razu używają zapisanego folderu. Po zatrzymaniu aplikacji jej pliki tymczasowe można usunąć bez utraty wyników i postępu importu.")}
    </div>
    {error && <div role="alert" style={{ marginTop: 6, fontSize: "var(--fs-4)", color: "var(--warn)" }}>{error}</div>}
  </div>;
}
/** How often this computer reads Claude cloud sessions into its `-cloud` archive folders (0 turns it off). */
function CloudSessionsInterval({ disabled }: { disabled: boolean }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<CloudSessionsResponse | null>(null);
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.cloudSessions().then(setState).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)));
  }, []);
  const save = async () => {
    setBusy(true); setError(null);
    try { setState(await api.saveCloudSessionsMinutes(Number(minutes))); setMinutes(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const setting = state?.setting;
  const last = state?.status?.last;
  const problems = [...(state?.status?.error ? [state.status.error] : []),
    ...(last?.profiles.flatMap(profile => profile.errors.map(e => `${profile.archiveDir.split(/[\\/]/).pop()}: ${e}`)) ?? [])];
  const valid = /^\d+$/.test(minutes.trim()) && Number(minutes) <= 1440;
  return <div style={{ marginTop: 14 }}>
    <Field label={t("Claude cloud sessions: check every (minutes)", "Sesje Claude w chmurze: sprawdzaj co (min)")}>
      <div className="mono" style={{ fontSize: "var(--fs-3)", marginBottom: 6 }}
        title={setting?.source === "environment" ? t("Set by TOKENATLAS_CLOUD_MINUTES; the saved value applies without it.",
          "Ustawione przez TOKENATLAS_CLOUD_MINUTES; zapisana wartość działa bez tej zmiennej.") : t("0 turns it off.", "0 wyłącza.")}>
        {!setting ? "…" : setting.minutes === 0 ? t("off", "wyłączone") : `${setting.minutes} min`}
        {setting?.source === "environment" ? " · TOKENATLAS_CLOUD_MINUTES" : ""}
        {last ? ` · ${new Date(last.finishedAt).toLocaleString(locale)} · ${last.profiles.reduce((n, p) => n + p.sessions, 0)} ${t("sessions", "sesji")}` : ""}
      </div>
      <input aria-label={t("Interval in minutes", "Odstęp w minutach")} value={minutes} inputMode="numeric"
        onChange={event => setMinutes(event.target.value)} disabled={disabled || busy}
        placeholder={setting ? String(setting.minutes) : ""} className="ui-input" style={{ width: 120 }} />
      <GhostButton onClick={() => void save()} disabled={disabled || busy || !valid}>{t("Save interval", "Zapisz odstęp")}</GhostButton>
    </Field>
    {[...(error ? [error] : []), ...problems].map(problem =>
      <div key={problem} role="alert" style={{ marginTop: 6, fontSize: "var(--fs-4)", color: "var(--warn)" }}>{problem}</div>)}
  </div>;
}
function Found({
  label,
  ok,
  value,
  children,
}: {
  label: string;
  ok: boolean;
  value: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: 10, alignItems: "baseline", padding: "var(--s-4) 0", borderBottom: "var(--rule)" }}>
      <div style={{ color: "var(--muted)" }}>
        {label} <Pill tone={ok ? "ok" : "warn"}>{ok ? t("present", "jest") : t("missing", "brak")}</Pill>
      </div>
      <div>
        <div className="mono" style={{ fontSize: "var(--fs-3)" }}>
          {value}
        </div>
        <div style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: 2 }}>{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="ui-eyebrow" style={{ marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}
