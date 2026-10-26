import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SourceHealthResponse, SourceHealthRow, SourceHealthStatus, SourceProfileConfiguration, SourceProfileEdit } from "../../shared/source-health";
import { api, refreshApiData } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import { probeIssueText } from "../lib/probe";
import { probeErrorCode } from "../../shared/probe-error";
import { dayTime, relativeTime } from "../lib/format";
import { polishPlural } from "../lib/mixFormat";
import { ageTone } from "../lib/source-providers";
import { DataTable, TableRow, DetailTabs, Disclosure, ErrorState, Fact, FactNote, Facts, GhostButton, LoadingCard, Pill, toneColor, type DetailTab, type Tone } from "./ui";
import { useFillHeight } from "../lib/useFillHeight";
import { groupSourceSubscriptions, providerLabel, SourceSubscriptionPicker } from "./SourceSubscriptionPicker";
import { SourceFolderBrowser } from "./SourceFolderBrowser";
import "./SourceHealthPanel.css";

const key = (value?: string | null) => (value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const basename = (value: string) => value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? value;
const statuses: Record<SourceHealthStatus, { en: string; pl: string; tone: Tone }> = {
  configured: { en: "Assigned", pl: "Przypisany", tone: "neutral" },
  current: { en: "Recent data", pl: "Świeże dane", tone: "ok" },
  older: { en: "Older data", pl: "Starsze dane", tone: "warn" },
  "missing-assignment": { en: "Missing assignment", pl: "Brak przypisania", tone: "warn" },
  "no-sessions": { en: "No sessions", pl: "Brak sesji", tone: "warn" },
  error: { en: "Reading error", pl: "Błąd odczytu", tone: "crit" },
  history: { en: "Historical source", pl: "Źródło historyczne", tone: "neutral" },
  unknown: { en: "Unknown computer", pl: "Nieznany komputer", tone: "neutral" },
};

function newSourceArchive(config: SourceProfileConfiguration, source: SourceHealthRow, profile: string): string {
  if (source.archive) return source.archive;
  const name = basename(profile || "profile");
  const suffix = name === `.${source.vendor}` ? "" : `-${name.replace(/^\./, "")}`;
  const machineProfile = source.vendor === "claude" && !suffix ? config.machine : `${config.machine}-${config.login}${suffix}`;
  return `\${ARCHIVE}/${source.vendor}/${machineProfile}`;
}

export function initialSourceProfileEdit(config: SourceProfileConfiguration, source: SourceHealthRow): SourceProfileEdit {
  const index = config.declarations.findIndex((row, i) => row.vendor === source.vendor &&
    key(row.machine) === key(config.machine) && !!source.archive && key(config.resolved[i]?.archive) === key(source.archive));
  return { revision: config.revision, index: index < 0 ? null : index,
    subscription: source.subscription === "unassigned" ? "" : source.subscription,
    vendor: source.vendor, profile: source.profile?.startsWith("pool:") ? "" : source.profile ?? "",
    archive: index >= 0 ? config.declarations[index]!.home : newSourceArchive(config, source, source.profile ?? "") };
}

export function profileOptions(config: SourceProfileConfiguration, source: SourceHealthRow, fallback: string[] = []) {
  const detected = config.detected_profiles?.filter(profile => profile.vendor === source.vendor && profile.kind === "folder");
  const options = detected ?? fallback.filter(home => !home.startsWith("pool:")).map(home => ({ home, name: basename(home), account:
    config.inventory?.sources.find(row => row.local && row.vendor === source.vendor && key(row.profile) === key(home))?.label ?? null }));
  return [...new Map(options.map(profile => [key(profile.home), { value: profile.home, vendor: source.vendor,
    label: profile.name + (profile.account ? ` · ${profile.account}` : ""), detail: profile.home }])).values()];
}

function SourceProfileForm({ config, source, profiles, onClose }: { config: SourceProfileConfiguration; source: SourceHealthRow; profiles: string[]; onClose: () => void }) {
  const { t } = useI18n();
  const [edit, setEdit] = useState(() => initialSourceProfileEdit(config, source));
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changeProfile = (profile: string) => setEdit(previous => ({ ...previous, profile,
    archive: previous.index === null ? newSourceArchive(config, source, profile) : previous.archive }));
  const save = async () => {
    setBusy(true); setError(null);
    try { await api.saveSourceProfile(edit); setSaved(true); refreshApiData(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (saved) return <div role="status" className="ui-toolbar">{t("Saved", "Zapisano")}
    <GhostButton onClick={onClose}>{t("Close", "Zamknij")}</GhostButton>
  </div>;
  return <form className="source-editor" aria-label={t("Profile assignment", "Przypisanie profilu")} onSubmit={event => { event.preventDefault(); if (!busy) void save(); }}>
    <SourceSubscriptionPicker value={edit.profile} options={profileOptions(config, source, profiles)} onChange={changeProfile}
      input={{ label: t("Profile location", "Lokalizacja profilu"), disabled: busy }} />
    <GhostButton disabled={busy} onClick={() => setBrowsing(true)}>{t("Browse…", "Przeglądaj…")}</GhostButton>
    <GhostButton emphasis type="submit" disabled={busy || !edit.profile.trim() || !edit.archive.trim()}>{busy ? t("Saving…", "Zapisuję…") : t("Save", "Zapisz")}</GhostButton>
    <GhostButton disabled={busy} onClick={onClose}>{t("Cancel", "Anuluj")}</GhostButton>
    {error && <div role="alert" className="ui-alert source-editor-error">{browserSafeDiagnostic(error)}</div>}
    {browsing && <SourceFolderBrowser initialPath={edit.profile} onSelect={profile => { changeProfile(profile); setBrowsing(false); }} onClose={() => setBrowsing(false)} />}
  </form>;
}
function SourceProfileEditor({ source, profiles, onClose }: { source: SourceHealthRow; profiles: string[]; onClose: () => void }) {
  const { t } = useI18n();
  const state = useAsync(signal => api.sourceProfiles(source.vendor,signal), [source.vendor], false, `source-settings:configuration:${source.vendor}`);
  if (state.error) return <div><ErrorState message={state.error} onRetry={state.reload} /><GhostButton onClick={onClose}>{t("Close", "Zamknij")}</GhostButton></div>;
  if (!state.data) return <LoadingCard label={t("Loading assignment", "Wczytuję przypisanie")} height={100} shape="table" />;
  return <SourceProfileForm config={state.data} source={source} profiles={profiles} onClose={onClose} />;
}

/** A coded limit-reading failure reads as the status bar's sentence; any other error as its safe diagnostic. */
export function sourceErrorText(row: SourceHealthRow): string | null {
  if (!row.error) return null;
  const code = probeErrorCode(row.error);
  return code ? probeIssueText({ provider: row.vendor, machine: row.machine, code, since: row.last_meter }).text
    : browserSafeDiagnostic(row.error);
}

function SourceDetails({ row }: { row: SourceHealthRow }) {
  const { t } = useI18n();
  return <details className="source-details">
    <summary className="ui-disclosure">{t("Technical details", "Szczegóły techniczne")}</summary>
    <div className="source-detail-content">
      <div>{t("Subscription ID:", "ID abonamentu:")} <span className="mono">{row.subscription}</span></div>
      <div>{t("Profile:", "Profil:")} <span className="mono">{row.profile ?? t("not declared", "niezadeklarowany")}</span></div>
      <div>{t("Archive:", "Archiwum:")} <span className="mono">{row.archive ?? t("not assigned", "nieprzypisane")}</span></div>
      {!row.last_session && row.last_meter && <div>{t("A limit reading does not confirm session import. The counter covers the whole subscription.", "Odczyt limitu nie potwierdza importu sesji. Licznik obejmuje cały abonament.")}</div>}
      {row.error && <div role="alert" style={{ color: "var(--crit)" }}>{sourceErrorText(row)}</div>}
      {row.last_attempt && <div>{t("Last meter attempt:", "Ostatnia próba odczytu limitu:")} {row.last_attempt}</div>}
    </div>
  </details>;
}

/**
 * Assigned rows have an archive route; detected ones were linked to the subscription by a limit reading or a
 * session but have none (often other Windows users' profiles on this computer); traces have no computer at all.
 */
export type SourceRowGroup = "assigned" | "detected" | "trace";
export function sourceRowGroup(row: SourceHealthRow): SourceRowGroup {
  if (!row.machine) return "trace";
  return row.configured ? "assigned" : "detected";
}

/** The picker's dot: the state of the routes that feed the subscription, not of stray detections. */
export function subscriptionTone(rows: SourceHealthRow[]): Tone {
  const assigned = rows.filter((row) => sourceRowGroup(row) === "assigned");
  if (assigned.some((row) => row.status === "error")) return "crit";
  if (assigned.some((row) => row.status === "current")) return "ok";
  if (assigned.some((row) => row.status === "older" || row.status === "no-sessions")) return "warn";
  return "neutral";
}

/**
 * A known instant always shows its age. The server flags a row pending while limit readings are being prepared,
 * which can take long after a restart; it hides nothing that is already known, and a missing value says so.
 */
function Age({ label, value, olderAfterHours, pending }: { label: string; value: string | null; olderAfterHours: number; pending?: boolean }) {
  const { t } = useI18n();
  const tone = ageTone(value, olderAfterHours);
  const exact = value ? new Date(value).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : pending ? t("Readings are still being prepared", "Odczyty są jeszcze przygotowywane") : undefined;
  return <div className="source-age" title={exact}>
    <i style={tone ? { background: toneColor(tone), borderColor: toneColor(tone) } : undefined} aria-hidden="true" />
    {label}: {value ? relativeTime(value) : pending ? t("no data yet", "jeszcze brak danych") : t("no data", "brak danych")}
  </div>;
}

function SourceComputerRow({ row, profiles, pending, olderAfterHours }: { row: SourceHealthRow; profiles: string[]; pending?: boolean; olderAfterHours: number }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const editable = row.local && !row.historical && ["codex", "claude", "grok", "gemini"].includes(row.vendor);
  const detected = sourceRowGroup(row) === "detected";
  return <TableRow data-source-machine={row.machine ?? "unknown"} className={detected ? "source-row-detected" : undefined}>
      <td><strong>{row.machine ?? t("Unknown computer", "Nieznany komputer")}</strong>
        {row.local && <div className="source-muted">{t("This computer", "Ten komputer")}</div>}
      </td>
      {editing ? <td colSpan={4}><div id={editorId}>
        <SourceProfileEditor source={row} profiles={profiles} onClose={() => setEditing(false)} />
      </div></td> : <>
      <td><div className="mono source-profile-name">{row.profile?.startsWith("pool:") ? `AGY · ${row.profile.slice(5)}` : row.profile ?? "—"}</div>
        <SourceDetails row={row} />
      </td>
      <td>{row.vendor !== "glm" && <Age label={t("Sessions", "Sesje")} value={row.last_session} olderAfterHours={olderAfterHours} pending={pending} />}
        <Age label={t("Limit", "Limit")} value={row.last_meter} olderAfterHours={olderAfterHours} pending={pending} /></td>
      <td><div className="source-row-actions">
        <Pill tone={statuses[row.status].tone}>{t(statuses[row.status].en, statuses[row.status].pl)}</Pill>
      </div></td>
      <td>
        {editable && <GhostButton emphasis aria-expanded={editing} aria-controls={editorId} onClick={() => setEditing(!editing)}>
          {editing ? t("Close", "Zamknij") : detected ? t("Assign", "Przypisz") : t("Edit", "Edytuj")}
        </GhostButton>}
        {!editable && <span className="source-muted" title={!row.local && row.machine ? t("Open tokenAtlas on {0} to edit this profile.", `Otwórz tokenAtlas na ${row.machine}, aby edytować profil.`, [row.machine]) : undefined}>
          {!row.local && row.machine ? t("Other computer", "Inny komputer") : "—"}
        </span>}
      </td>
      </>}
    </TableRow>;
}

export function sourceSettingsData(inventory: SourceHealthResponse, health?: SourceHealthResponse | null): SourceHealthResponse {
  const sameSource = (a: SourceHealthRow, b: SourceHealthRow) => a.vendor === b.vendor && a.subscription === b.subscription &&
    key(a.machine) === key(b.machine) && key(a.profile) === key(b.profile) && (!a.configured || !b.configured || key(a.archive) === key(b.archive));
  const sources = inventory.sources.map(row => {
    const observed = health?.sources.find(other => sameSource(row, other) && row.configured === other.configured);
    return observed ? { ...observed, ...row, status: observed.status, error: observed.error,
      last_session: observed.last_session, last_meter: observed.last_meter, last_attempt: observed.last_attempt }
      // Without a health report the activity is still coming; with one, an unmatched route simply has none yet.
      : { ...row, activity_pending: !health || health.activity_pending === true };
  });
  for (const row of health?.sources ?? []) if (!row.configured && !inventory.sources.some(other => sameSource(other, row))) sources.push(row);
  return { ...inventory, activity_pending: false, sources };
}

function count(t: (en: string, pl: string) => string, n: number, enOne: string, enMany: string, plOne: string, plFew: string, plMany: string) {
  return `${n} ${t(n === 1 ? enOne : enMany, polishPlural(n, plOne, plFew, plMany))}`;
}


const OVERVIEW = "\u0000overview";
const VENDOR_TOKEN: Record<string, string> = { codex: "codex", claude: "claude", gemini: "gemini", glm: "glm", grok: "grok" };
const stateText = (tone: Tone, t: (en: string, pl: string) => string) => tone === "ok" ? t("recent data", "świeże dane")
  : tone === "warn" ? t("older data", "starsze dane") : tone === "crit" ? t("reading error", "błąd odczytu") : t("no data yet", "jeszcze bez danych");

/** The subscriptions with their routes, keyed by vendor and subscription. */
function sourceGroups(data: SourceHealthResponse) {
  const groups = new Map<string, SourceHealthRow[]>();
  for (const row of data.sources) {
    const id = `${row.vendor}:${row.subscription}`;
    groups.set(id, [...groups.get(id) ?? [], row]);
  }
  return groups;
}

/** One subscription's computers: assigned ones, then folded detections and traces. */
function SourceComputersTable({ rows, data }: { rows: SourceHealthRow[]; data: SourceHealthResponse }) {
  const { t } = useI18n();
  const [opened, setOpened] = useState<Partial<Record<SourceRowGroup, boolean>>>({});
  const profiles = [...new Set(data.sources.filter(row => row.local && row.vendor === rows[0]?.vendor).flatMap(row => row.profile ? [row.profile] : []))];
  const byGroup = (group: SourceRowGroup) => rows.filter((row) => sourceRowGroup(row) === group);
  const assigned = byGroup("assigned");
  // Detections are offered for assignment folded (UI audit decision 16), unless nothing is assigned yet.
  const isOpen = (group: SourceRowGroup) => opened[group] ?? (group === "assigned" || (group === "detected" && assigned.length === 0));
  const lastTrace = byGroup("trace").reduce<string | null>((latest, row) => row.last_session && (!latest || row.last_session > latest) ? row.last_session : latest, null);
  const section = (group: SourceRowGroup, title: string, note?: string) => {
    const members = byGroup(group);
    if (!members.length) return null;
    const open = isOpen(group);
    return <tbody key={group} data-source-group={group}>
      <TableRow className="source-group"><th colSpan={5}>
        {group === "assigned" ? <span>{title} · {members.length}</span>
          : <Disclosure open={open} onToggle={() => setOpened({ ...opened, [group]: !open })}>{title} · {members.length}</Disclosure>}
        {note && <span className="source-muted"> — {note}</span>}
      </th></TableRow>
      {open && members.map(row => <SourceComputerRow key={JSON.stringify([row.vendor, row.subscription, row.machine, row.profile, row.configured ? row.archive : null, row.historical])}
        row={row} profiles={profiles} pending={data.activity_pending || row.activity_pending} olderAfterHours={data.older_after_hours} />)}
    </tbody>;
  };
  return <DataTable tableId="SourceHealthPanel:0" className="source-computers">
    <thead><TableRow header>{[t("Computer", "Komputer"), t("Profile location", "Lokalizacja profilu"), t("Latest data", "Ostatnie dane"), t("Status", "Stan"), t("Edit", "Edycja")].map((label, index) => <th data-column-id={`c${index}`} key={index}>{label}</th>)}</TableRow></thead>
    {section("assigned", t("Assigned", "Przypisane"))}
    {section("detected", t("Detected without assignment", "Wykryte bez przypisania"),
      t("a limit reading or a session linked them to this subscription", "odczyt limitu lub sesja powiązały je z tą subskrypcją"))}
    {section("trace", t("Traces without a computer", "Ślady bez komputera"),
      lastTrace ? `${t("sessions until", "sesje do")} ${dayTime(lastTrace)}` : undefined)}
  </DataTable>;
}

/**
 * Settings → Computers and data (user, 2026-10-12): the subscriptions on the paper, the chosen one on a sheet with its
 * computers and archive history; the rail's first entry holds what applies to every account (recalculation, the
 * archive's whole range, advanced configuration).
 */
export function SourceHealthTable({ data, initialSubscription, history, overview = [], request }: {
  data: SourceHealthResponse;
  initialSubscription?: string;
  /** The archive history tab of one subscription. */
  history?: (subscription: string) => ReactNode;
  /** The tabs of the "every account" entry. */
  overview?: DetailTab[];
  /** A link's request: open this subscription (or every account) on this tab; `seq` changes per request. */
  request?: { subscription: string | null; tab: string; seq: number } | null;
}) {
  const { t } = useI18n();
  const groups = sourceGroups(data);
  const findGroup = (subscription?: string | null) => [...groups].find(([, rows]) => rows[0]?.subscription === subscription)?.[0];
  const fallback = findGroup(initialSubscription) ?? groups.keys().next().value ?? (overview.length ? OVERVIEW : null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("computers");
  useEffect(() => {
    if (!request) return;
    const wanted = request.subscription && request.subscription !== "all" ? findGroup(request.subscription) : null;
    setSelected(wanted ?? (overview.length ? OVERVIEW : null)); setTab(request.tab);
  }, [request?.seq]);
  const groupId = selected === OVERVIEW && overview.length ? OVERVIEW : selected && groups.has(selected) ? selected : fallback;
  const workspace = useRef<HTMLDivElement>(null);
  const height = useFillHeight(workspace);
  const choose = (id: string) => { setSelected(id); setTab(id === OVERVIEW ? overview[0]?.key ?? "" : "computers"); };
  // Every provider's unassigned profiles sit together under one heading at the end.
  const options = [...groups].map(([value, rows]) => {
    const first = rows[0]!;
    return first.subscription === "unassigned"
      ? { value, vendor: first.vendor, label: providerLabel(first.vendor), group: { id: "unassigned", label: t("Unassigned profiles", "Nieprzypisane profile") } }
      : { value, vendor: first.vendor, label: first.label || first.subscription };
  });
  const item = (option: (typeof options)[number]) => {
    const rows = groups.get(option.value)!;
    const machines = new Set(rows.filter((row) => sourceRowGroup(row) === "assigned").map((row) => row.machine)).size;
    const detected = rows.filter((row) => sourceRowGroup(row) === "detected").length;
    const tone = subscriptionTone(rows);
    const detectedTitle = count(t, detected, "profile detected without assignment", "profiles detected without assignment",
      "profil wykryty bez przypisania", "profile wykryte bez przypisania", "profili wykrytych bez przypisania");
    return <button key={option.value} type="button" className={`ui-rail-item${machines ? "" : " is-quiet"}`} aria-pressed={groupId === option.value}
      aria-label={`${providerLabel(option.vendor)} · ${option.label}`} data-source-subscription={rows[0]!.subscription} onClick={() => choose(option.value)}>
      <strong title={option.label}>{option.label}</strong>
      {tone === "crit" ? <span className="ui-rail-flag is-crit">{t("error", "błąd")}</span>
        : detected ? <span className="ui-rail-flag" title={detectedTitle}>{count(t, detected, "profile detected", "profiles detected", "wykryty", "wykryte", "wykrytych")}</span> : <span />}
      <span>{machines ? <><b>{count(t, machines, "computer", "computers", "komputer", "komputery", "komputerów")}</b> · {stateText(tone, t)}</> : stateText(tone, t)}</span>
    </button>;
  };
  const rows = groupId && groupId !== OVERVIEW ? groups.get(groupId) ?? [] : [];
  const first = rows[0];
  const sheet = () => {
    if (groupId === OVERVIEW) return <>
      <div className="ui-sheet-head"><div><span className="ui-sheet-eyebrow">{t("Every account", "Wszystkie konta")}</span><h3>{t("Archive and recalculation", "Archiwum i przeliczanie")}</h3></div></div>
      <DetailTabs groups={[{ tabs: overview }]} active={tab} onChange={setTab} label={t("Archive and recalculation", "Archiwum i przeliczanie")} />
    </>;
    if (!first) return <p className="source-muted">{t("No sources have been declared or observed yet.", "Nie zadeklarowano ani nie wykryto jeszcze źródeł.")}</p>;
    const assigned = rows.filter((row) => sourceRowGroup(row) === "assigned");
    const machines = [...new Set(assigned.map((row) => row.machine ?? ""))].filter(Boolean);
    const detected = rows.filter((row) => sourceRowGroup(row) === "detected").length;
    const traces = rows.filter((row) => sourceRowGroup(row) === "trace").length;
    const tone = subscriptionTone(rows);
    const latest = (field: "last_session" | "last_meter") => assigned.reduce<string | null>((max, row) => row[field] && (!max || row[field]! > max) ? row[field]! : max, null);
    const session = latest("last_session"), meter = latest("last_meter");
    const unassigned = first.subscription === "unassigned";
    const tabs: DetailTab[] = [
      { key: "computers", label: t("Computers", "Komputery"), badge: rows.length, render: () => <SourceComputersTable key={groupId} rows={rows} data={data} /> },
      ...(history && !unassigned ? [{ key: "history", label: t("Archive history", "Historia archiwum"), render: () => history(first.subscription) }] : []),
    ];
    return <>
      <div className="ui-sheet-head"><div>
        <span className="ui-sheet-eyebrow">{providerLabel(first.vendor)}{unassigned ? null : <> · <span className="mono">{first.subscription}</span></>}</span>
        <h3>{unassigned ? t("Unassigned profiles", "Nieprzypisane profile") : first.label || first.subscription}</h3>
      </div></div>
      <Facts>
        <Fact id="computers" label={t("Assigned computers", "Przypisane komputery")} value={<strong>{machines.length}</strong>}
          notes={machines.length ? <FactNote>{machines.join(", ")}</FactNote> : undefined} />
        <Fact id="state" label={t("Data", "Dane")} tone={tone === "warn" ? "warn" : tone === "crit" ? "crit" : undefined} value={<strong>{stateText(tone, t)}</strong>}
          notes={session || meter ? <FactNote>{[session && `${t("sessions", "sesje")} ${relativeTime(session)}`, meter && `${t("limit", "limit")} ${relativeTime(meter)}`].filter(Boolean).join(" · ")}</FactNote> : undefined} />
        {detected > 0 && <Fact id="detected" tone="warn" label={t("Detected without assignment", "Wykryte bez przypisania")} value={<strong>{detected}</strong>}
          notes={<FactNote>{t("a limit reading or a session linked them here", "odczyt limitu lub sesja powiązały je tutaj")}</FactNote>} />}
        {traces > 0 && <Fact id="traces" label={t("Traces without a computer", "Ślady bez komputera")} value={<strong>{traces}</strong>} />}
      </Facts>
      <DetailTabs key={groupId} groups={[{ tabs }]} active={tab} onChange={setTab} label={t("Subscription details", "Szczegóły subskrypcji")} />
    </>;
  };
  return <div data-source-health className="source-settings ui-workspace" ref={workspace} style={height ? { height } : undefined}>
    <nav className="ui-workspace-rail" aria-label={t("Subscription to configure", "Abonament do konfiguracji")}>
      {overview.length > 0 && <button type="button" className="ui-rail-item source-overview-item" aria-pressed={groupId === OVERVIEW} onClick={() => choose(OVERVIEW)}>
        <strong>{t("Archive and recalculation", "Archiwum i przeliczanie")}</strong><span>{t("all", "całość")} →</span>
      </button>}
      {groupSourceSubscriptions(options).map((group) => <div className="ui-rail-group" key={group.vendor}>
        <div className="ui-rail-heading">{VENDOR_TOKEN[group.vendor] && <i style={{ background: `var(--${VENDOR_TOKEN[group.vendor]})` }} />}{group.label} <span>· {group.options.length}</span></div>
        {group.options.map(item)}
      </div>)}
    </nav>
    <div className="ui-workspace-sheet">{sheet()}</div>
  </div>;
}

export function SourceHealthPanel({ initialSubscription, history, overview, request }: Omit<Parameters<typeof SourceHealthTable>[0], "data">) {
  const { t } = useI18n();
  const config = useAsync(signal => api.sourceProfiles(undefined,signal), [], true, "source-settings:configuration");
  const state = useAsync(api.sourceHealth, [], true, "source-settings:health");
  const data = config.data?.inventory ? sourceSettingsData(config.data.inventory, state.data) : state.data;
  return <>
    {config.error && <ErrorState message={config.error} onRetry={config.reload} />}
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    {data ? <SourceHealthTable data={data} initialSubscription={initialSubscription} history={history} overview={overview} request={request} />
      : !config.error && <LoadingCard label={t("Loading profiles", "Wczytuję profile")} height={160} shape="table" />}
  </>;
}
