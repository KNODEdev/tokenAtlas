import { SpeedChart } from "../components/SpeedChart";
import { ChartExport } from "../components/ChartExport";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScreenProps } from "../lib/screens";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../shared/time-range-presets";
import { api, onApiRefresh } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { compact, usageModelLabel } from "../lib/format";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import { ALL_ACCOUNT, type RosterCard } from "../lib/roster";
import {
  MIN_POINT_CALLS, MIN_RANKED_CALLS, accountSelected, accountState, entriesSince, latestWeek, mergeSpeedParts, modelSelected, modelTotals,
  rangeStart, rankedModels, readHiddenModels, readSpeedSelection, selectedParts, setAccounts, speedModels, speedProviderOf,
  speedSubscriptions, toggleAccount, toggleModel, totalSpeed, writeHiddenModels, writeSpeedSelection,
  type ModelSpeedResponse, type ModelTotals, type SpeedEntry, type SpeedGrain, type SpeedKind, type SpeedPart, type SpeedRange, type SpeedSelection,
  type SpeedSubscription,
  type SpeedProvider,
  type SpeedChartMetric,
} from "../lib/model-speed";
import { TableRow, Card, EmptyState, ErrorState, GhostButton, LegendAllToggle, LoadingCard, Table, Tabs, Td, Th, HelpDot } from "../components/ui";
import { Kpi, KpiRow, unit } from "../components/WindowStatusCard";
import { modelStrokes } from "../lib/model-colors";
import { AccountPeriodDrawer } from "../components/AccountPeriodDrawer";
import { TriStateCheck as Check } from "../components/TriStateCheck";
import "../components/SubscriptionChoice.css";
import "./History.css";
import "./Speed.css";

/** The provider whose calls carry response times, or null for a subscription without them. */
/** A card's own title: the display voice (docs/design/paper-atlas.md §2). */
const CARD_TITLE = { fontSize: "var(--fs-card-title)", color: "var(--text)" } as const;

export function speedProvider(props: Pick<ScreenProps, "account" | "accounts" | "card">): SpeedProvider | null {
  return speedProviderOf(props.accounts.find(account => account.id === props.account)?.vendor
    ?? (props.card?.id === props.account ? props.card.group : null));
}

/**
 * Output speed of each model over time for one Claude or Codex subscription, or for the chosen subscriptions of "All"
 * (docs/design/model-speed-mockup.html, approved 2026-10-07; "All" approved the same day): stored day sums from
 * /api/model-speed, week buckets and subscriptions summed here.
 */
export function Speed(props: ScreenProps & { cards?: RosterCard[] }) {
  const { t } = useI18n();
  if (props.account === ALL_ACCOUNT) return <SpeedAll cards={props.cards ?? []} />;
  if (speedProvider(props) === null) {
    return <EmptyState
      title={t("No supported provider selected", "Nie wybrano obsługiwanego dostawcy")}
      detail={t("Select a subscription to inspect its recorded timings.", "Wybierz subskrypcję, aby sprawdzić zapisane pomiary czasu.")} />;
  }
  return <SpeedSingle key={props.account} account={props.account} />;
}

function SpeedSingle({ account }: { account: string }) {
  const { t } = useI18n();
  const state = useAsync(signal => api.modelSpeed({ account }, signal), [account]);
  const data = state.data?.account.toLowerCase() === account.toLowerCase() ? state.data : null;
  const entries = useMemo(() => data ? mergeSpeedParts([{ account, models: data.models }], false) : [], [data, account]);
  if (!data) {
    if (state.error) return <ErrorState message={browserSafeDiagnostic(state.error)} onRetry={state.reload} />;
    return <LoadingCard label={t("Loading response times", "Wczytywanie czasów odpowiedzi")} height={420} shape="kpi" />;
  }
  if (!entries.length) {
    return <EmptyState title={t("No calls of this subscription yet", "Ta subskrypcja nie ma jeszcze wywołań")}
      detail={t("Speeds appear once its calls are imported.", "Prędkości pojawią się po zaimportowaniu jej wywołań.")} />;
  }
  return <SpeedReport entries={entries} hiddenScope={account} longOutMin={data.long_out_min} firstTokenPending={data.first_token_pending} />;
}

type Loaded = { sub: SpeedSubscription; data: ModelSpeedResponse | null; error: string | null; pending: boolean; off: boolean };
type Answer = Pick<Loaded, "data" | "error">;
/** Past this, a request still waiting is named as data the server is preparing (as LoadingStatus does). */
const PREPARING_AFTER_MS = 20_000;

/**
 * The answers of the subscriptions that are on (`wanted`), each published as it arrives, so one that is slow or still being
 * prepared never holds back the others. A subscription that is off is not read; turning it on reads it, and an answer it
 * already has stays. A change aborts the requests in flight and ignores their late answers (what is still wanted is read
 * again); a data refresh reads every wanted subscription again and keeps the shown answers until new ones arrive.
 */
function useSpeedAnswers(subs: SpeedSubscription[], wanted: readonly string[]): { loaded: Loaded[]; slow: boolean } {
  const list = subs.map(sub => sub.id).join("\n"), wantedKey = wanted.join("\n");
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer>>(new Map());
  const [round, setRound] = useState(0);
  const [slow, setSlow] = useState(false);
  const current = useRef(answers), readRound = useRef(round);
  useEffect(() => { current.current = answers; }, [answers]);
  useEffect(() => {
    const unsubscribe = onApiRefresh(() => setRound(value => value + 1));
    return () => { unsubscribe(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), ids = new Set(list.split("\n"));
    let alive = true;
    const refresh = readRound.current !== round;
    readRound.current = round;
    // Answers of subscriptions that left the list go with them.
    setAnswers(previous => [...previous.keys()].every(id => ids.has(id)) ? previous
      : new Map([...previous].filter(([id]) => ids.has(id))));
    const publish = (id: string, answer: Answer) => { if (alive) setAnswers(previous => new Map(previous).set(id, answer)); };
    const reading = wantedKey ? wantedKey.split("\n").filter(id => ids.has(id) && (refresh || !current.current.has(id))) : [];
    for (const id of reading) api.modelSpeed({ account: id }, controller.signal).then(
      data => publish(id, { data, error: null }),
      (error: unknown) => publish(id, { data: null, error: error instanceof Error ? error.message : String(error) }));
    setSlow(false);
    const timer = reading.length ? setTimeout(() => { if (alive) setSlow(true); }, PREPARING_AFTER_MS) : null;
    return () => { alive = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [list, wantedKey, round]);
  const on = new Set(wanted);
  return { slow, loaded: subs.map(sub => {
    const answer = answers.get(sub.id);
    return { sub, data: answer?.data ?? null, error: answer?.error ?? null, pending: !answer && on.has(sub.id), off: !on.has(sub.id) };
  }) };
}

/** "All": each eligible subscription read in parallel (each answer is quick), merged here by the drawer's selection. */
function SpeedAll({ cards }: { cards: RosterCard[] }) {
  const { t } = useI18n();
  const subs = useMemo(() => speedSubscriptions(cards, ALL_ACCOUNT), [cards]);
  const inactive = useMemo(() => new Set(subs.filter(sub => !sub.active).map(sub => sub.id)), [subs]);
  const [selection, setSelection] = useState<SpeedSelection>(() => readSpeedSelection());
  // Only subscriptions that are on are read; an inactive one waits until it is turned on.
  const { loaded, slow } = useSpeedAnswers(subs, subs.filter(sub => accountSelected(selection, sub.id, inactive)).map(sub => sub.id));
  const [drawer, setDrawer] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const update = (next: SpeedSelection) => { setSelection(next); writeSpeedSelection(next); };
  const parts = useMemo<SpeedPart[]>(() => loaded.flatMap(item => item.data ? [{ account: item.sub.id, models: item.data.models }] : []), [loaded]);
  const entries = useMemo(() => mergeSpeedParts(selectedParts(parts, selection, inactive), selection.split), [parts, selection, inactive]);
  const lookup = useMemo(() => {
    const byId = new Map(subs.map(sub => [sub.id, sub]));
    return (accounts: string[]) => accounts.map(id => byId.get(id) ?? { id, name: id, label: id, provider: "codex" as const, active: true });
  }, [subs]);
  if (!subs.length) {
    return <EmptyState title={t("No supported subscription", "Brak obsługiwanej subskrypcji")}
      detail={t("Unknown response and first-token times are shown as missing.", "Nieznane czasy odpowiedzi i pierwszego tokena są pokazywane jako brak danych.")} />;
  }
  const modelsOf = (account: string) => speedModels(parts.find(part => part.account === account)?.models ?? []).map(series => series.model!);
  const chosen = subs.filter(sub => accountState(selection, sub.id, modelsOf(sub.id), inactive) !== "none").length;
  const failed = loaded.filter(item => item.error !== null).length;
  const waiting = loaded.filter(item => item.pending).length;
  const controls = <>
    <GhostButton onClick={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDrawer(true); }}>
      {t("Subscriptions and models · {0} of {1}", `Subskrypcje i modele · ${chosen} z ${subs.length}`, [chosen, subs.length])}
    </GhostButton>
    <label className="mono speed-split">
      <input type="checkbox" checked={selection.split} onChange={event => update({ ...selection, split: event.target.checked })} />
      {t("split by subscription", "rozbij na subskrypcje")}
    </label>
    {waiting > 0 && <span className="mono speed-note" role="status">{slow
      ? t("{0} of {1} subscriptions are still being prepared on the server · shown when ready",
        `${waiting} z ${subs.length} subskrypcji serwer wciąż przygotowuje · pojawią się, gdy będą gotowe`, [waiting, subs.length])
      : t("loading {0} of {1} subscriptions…", `wczytywanie ${waiting} z ${subs.length} subskrypcji…`, [waiting, subs.length])}</span>}
    {failed > 0 && <span className="mono speed-warn">{t("{0} of {1} subscriptions could not be read · see the list",
      `nie udało się odczytać ${failed} z ${subs.length} subskrypcji · zobacz listę`, [failed, subs.length])}</span>}
  </>;
  return <>
    {/* One report for both views: its metric, grain and the split checkbox (with focus) survive a split toggle. Merged and
        split entries have different keys, so their hidden series never mix. */}
    <SpeedReport entries={entries} hiddenScope={ALL_ACCOUNT} waiting={waiting > 0}
      firstTokenPending={loaded.some(item => !item.off && item.data?.first_token_pending)}
      longOutMin={loaded.find(item => item.data)?.data?.long_out_min ?? 256} controls={controls} split={selection.split} subscriptions={lookup} />
    {drawer && <AccountPeriodDrawer busy={false} onClose={() => setDrawer(false)} returnFocus={opener.current} className="speed-drawer"
      closeLabel={t("Close the subscription and model choice", "Zamknij wybór subskrypcji i modeli")}
      title={t("Subscriptions and models", "Subskrypcje i modele")}
      subtitle={t("{0} of {1} subscriptions · the choice sets the tiles, the chart and the table",
        `${chosen} z ${subs.length} subskrypcji · wybór obejmuje kafelki, wykres i tabelę`, [chosen, subs.length])}>
      <SpeedSelectionList subs={subs} loaded={loaded} slow={slow} selection={selection} inactive={inactive} onChange={update} />
    </AccountPeriodDrawer>}
  </>;
}

function SpeedSelectionList({ subs, loaded, slow, selection, inactive, onChange }: {
  subs: SpeedSubscription[]; loaded: Loaded[]; slow: boolean; selection: SpeedSelection; inactive: ReadonlySet<string>;
  onChange: (next: SpeedSelection) => void;
}) {
  const { t, locale } = useI18n();
  const oneDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const providers = [...new Set(subs.map(sub => sub.provider))].map(provider => ({ provider, subs: subs.filter(sub => sub.provider === provider) }))
    .filter(group => group.subs.length);
  const actions = (accounts: string[], name: string) => <span className="speed-drawer-actions">
    <button type="button" aria-label={t("Select all · {0}", `Zaznacz wszystkie · ${name}`, [name])}
      onClick={() => onChange(setAccounts(selection, accounts, true, inactive))}>{t("select all", "zaznacz wszystkie")}</button>
    <button type="button" aria-label={t("Clear · {0}", `Wyczyść · ${name}`, [name])}
      onClick={() => onChange(setAccounts(selection, accounts, false, inactive))}>{t("clear", "wyczyść")}</button>
  </span>;
  return <div className="speed-drawer-list">
    <div className="speed-drawer-global"><span>{t("All subscriptions", "Wszystkie subskrypcje")}</span>{actions(subs.map(sub => sub.id), t("all subscriptions", "wszystkie subskrypcje"))}</div>
    {providers.map(({ provider, subs: group }) => {
      const name = provider === "glm" ? "GLM" : provider[0]!.toUpperCase() + provider.slice(1);
      return <section key={provider} className="speed-drawer-provider" aria-label={name}>
        <h3><span>{name}</span>{actions(group.map(sub => sub.id), name)}</h3>
        {group.map(sub => {
          const item = loaded.find(entry => entry.sub.id === sub.id);
          const models = speedModels(item?.data?.models ?? []);
          const names = models.map(series => series.model!);
          const calls = models.reduce((sum, series) => sum + series.total.calls, 0);
          const timed = models.reduce((sum, series) => sum + series.total.timed_calls, 0);
          return <div key={sub.id} className={`speed-drawer-sub${item?.error ? " is-failed" : item?.pending ? " is-pending" : ""}`}>
            <label className="speed-drawer-row">
              <Check state={accountState(selection, sub.id, names, inactive)} label={sub.label}
                onChange={() => onChange(toggleAccount(selection, sub.id, names, inactive))} />
              <span className="speed-drawer-name">{sub.label}{!sub.active && <span className="mono speed-drawer-inactive"> · {t("inactive", "nieaktywna")}</span>}</span>
              <span className="mono speed-drawer-facts">{item?.error
                ? t("could not be read", "nie udało się odczytać")
                : item?.pending ? (slow ? t("being prepared on the server…", "serwer przygotowuje…") : t("loading…", "wczytywanie…"))
                : item?.off && !item.data ? t("off · read when turned on", "wyłączona · wczyta się po włączeniu")
                : t("{0} calls · {1}% measured",
                  `${compact(calls)} wywołań · ${calls ? oneDecimal.format(timed / calls * 100) : "—"}% zmierzonych`, [compact(calls), calls ? oneDecimal.format(timed / calls * 100) : "—"])}</span>
            </label>
            {item?.error && <div className="mono speed-drawer-error">{browserSafeDiagnostic(item.error)}</div>}
            {models.length > 0 && <div className="speed-drawer-models">
              {models.map(series => <label key={series.model} className="speed-drawer-row">
                <Check state={modelSelected(selection, sub.id, series.model!, inactive) ? "all" : "none"} label={`${sub.label} · ${usageModelLabel(series.model!)}`}
                  onChange={() => onChange(toggleModel(selection, sub.id, series.model!, names, inactive))} />
                <span className="speed-drawer-name">{usageModelLabel(series.model!)}</span>
                <span className="mono speed-drawer-facts">{t("{0} calls", `${compact(series.total.calls)} wywołań`, [compact(series.total.calls)])}</span>
              </label>)}
            </div>}
          </div>;
        })}
      </section>;
    })}
  </div>;
}

type Row = { key: string; label: string; color: string; dash: string | undefined; totals: ModelTotals; series: ModelSpeedResponse["models"][number];
  accounts: SpeedSubscription[] | null };

function SpeedReport({ entries, hiddenScope, longOutMin, controls, split = false, subscriptions, waiting = false, firstTokenPending = false }: {
  entries: SpeedEntry[]; hiddenScope: string; longOutMin: number; controls?: ReactNode; split?: boolean;
  /** "All" only: a chosen subscription has not answered yet, so an empty report is still loading. */
  waiting?: boolean;
  firstTokenPending?: boolean;
  /** "All" only: the subscriptions behind an entry, for its label and the table's column. */
  subscriptions?: (accounts: string[]) => SpeedSubscription[];
}) {
  const { t, locale, language } = useI18n();
  const [kind, setKind] = useState<SpeedKind>("long");
  const [grain, setGrain] = useState<SpeedGrain>("day");
  const [chartMetric, setChartMetric] = useState<SpeedChartMetric>("speed");
  const chartLatency = chartMetric !== "speed";
  const chartTitle = chartLatency ? t("Time to first token", "Czas do pierwszego tokena") : t("Speed over time", "Prędkość w czasie");
  // The period narrows the tiles, the chart and the table alike; UTC days, as the server's day rows.
  const [range, setRange] = useState<SpeedRange>("all");
  const today = new Date().toISOString().slice(0, 10), since = rangeStart(range, today);
  const ranged = useMemo(() => entriesSince(entries, since), [entries, since]);
  const [hidden, setHidden] = useState<Set<string>>(() => readHiddenModels(hiddenScope));
  const rows = useMemo<Row[]>(() => {
    const sorted = ranged.map(entry => {
      const accounts = subscriptions ? subscriptions(entry.accounts) : null;
      const model = usageModelLabel(entry.model);
      return { key: entry.key, model: entry.model, series: entry.series, totals: modelTotals(entry.series), accounts,
        label: split && accounts?.[0] ? `${model} · ${accounts[0].name}` : model };
    }).sort((a, b) => b.totals.calls - a.totals.calls);
    // Each line takes its vendor's hue; models of one vendor get its shades in order of calls.
    const strokes = modelStrokes(sorted.map(row => row.model));
    return sorted.map((row, index) => ({ ...row, ...strokes[index]! }));
  }, [ranged, language, split, subscriptions]);
  const toggle = (key: string) => setHidden(previous => {
    const next = new Set(previous);
    if (!next.delete(key)) next.add(key);
    writeHiddenModels(hiddenScope, next);
    return next;
  });
  const setAll = (next: Set<string>) => { setHidden(next); writeHiddenModels(hiddenScope, next); };
  const kinds = [{ value: "long" as const, label: t("long calls ≥{0}", `długie wywołania ≥${longOutMin}`, [longOutMin]) },
    { value: "all" as const, label: t("all calls", "wszystkie wywołania") }];
  const grains = [{ value: "day" as const, label: t("day", "dzień") }, { value: "week" as const, label: t("week", "tydzień") }];
  const ranges = [...TIME_RANGE_DAYS.map(days => ({ value: `${days}d` as const, label: timeRangeLabel(days, t) })),
    { value: "all" as const, label: t("all", "całość") }];
  const periodDays = range === "all" ? null : Number.parseInt(range, 10);
  const periodName = periodDays === null ? null : t("last {0} days", `ostatnie ${periodDays} dni`, [periodDays]);
  const controlRow = <div className="speed-controls">
    <Tabs value={kind} onChange={setKind} options={kinds} />
    <Tabs value={grain} onChange={setGrain} options={grains} />
    <Tabs value={range} onChange={setRange} options={ranges} />
    {controls}
  </div>;
  if (!rows.length) {
    return <div className="archive speed ui-tab-page">{controlRow}
      {waiting ? <LoadingCard label={t("Loading response times", "Wczytywanie czasów odpowiedzi")} height={420} shape="kpi" />
        : entries.length ? <EmptyState title={t("No calls in the {0}", `Brak wywołań w okresie: ${periodName}`, [periodName])}
          detail={t("Choose a longer period.", "Wybierz dłuższy okres.")} />
        : <EmptyState title={t("No subscription or model is chosen", "Nie wybrano żadnej subskrypcji ani modelu")}
          detail={t("Choose them in “Subscriptions and models”.", "Wybierz je w „Subskrypcje i modele”.")} />}</div>;
  }
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const oneDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const ranked = rankedModels(rows, kind);
  const calls = rows.reduce((sum, row) => sum + row.totals.calls, 0), timed = rows.reduce((sum, row) => sum + row.totals.timed, 0);
  const latest = latestWeek(rows.map(row => row.series), kind);
  const speedValue = (value: number | null) => value === null ? "—" : <>{whole.format(value)}{unit(" tok/s")}</>;
  const noRanked = t("no model with {0} calls of this kind", `brak modelu z ${MIN_RANKED_CALLS} wywołaniami tego rodzaju`, [MIN_RANKED_CALLS]);
  const all = subscriptions !== undefined;
  return (
    <div className="archive speed ui-tab-page">
      {controlRow}
      <KpiRow columns={4}>
        <Kpi label={t("Fastest model", "Najszybszy model")} value={speedValue(ranked[0] ? totalSpeed(ranked[0].totals, kind) : null)} visual={null}
          caption={ranked[0]?.label ?? noRanked} />
        <Kpi label={t("Slowest model", "Najwolniejszy model")} value={speedValue(ranked.length ? totalSpeed(ranked.at(-1)!.totals, kind) : null)} visual={null}
          caption={ranked.at(-1)?.label ?? noRanked} />
        <Kpi label={t("Measured calls", "Zmierzone wywołania")}
          value={calls ? <>{oneDecimal.format(timed / calls * 100)}{unit("%")}</> : "—"} visual={null}
          caption={t("{0} of {1} calls", `${compact(timed)} z ${compact(calls)} wywołań`, [compact(timed), compact(calls)])} />
        <Kpi label={t("Latest week", "Ostatni tydzień")} value={speedValue(latest?.speed ?? null)} visual={null}
          caption={latest ? t("all models · week of {0} · {1} calls",
            `wszystkie modele · tydzień od ${latest.week} · ${compact(latest.calls)} wywołań`, [latest.week, compact(latest.calls)]) : "—"} />
      </KpiRow>
      <Card><ChartExport title={chartTitle}>
        <div className="archive-head">
          <div><span className="ui-display" style={CARD_TITLE}>{chartTitle}</span> <HelpDot label={chartTitle}>{chartLatency
            ? t("Verified client-reported first-token times in seconds; lower is faster. Each point uses the combined measurements for that day or week. Missing data creates gaps; hover a point for the number of measured turns and coverage.",
              "Pewne czasy pierwszego tokena raportowane przez klienta, w sekundach; mniej znaczy szybciej. Punkt jest liczony z połączonych pomiarów dnia lub tygodnia. Brak danych pozostawia przerwę; podpowiedź punktu podaje liczbę zmierzonych tur i pokrycie.") : t(
            "Points with ≥{0} calls; gaps without traffic are not bridged. Click a model to hide it.",
            `Punkty z ≥${MIN_POINT_CALLS} wywołań; przerwy bez ruchu nie są łączone. Kliknij model, żeby go ukryć.`, [MIN_POINT_CALLS])}</HelpDot> <span className="archive-sub">· {chartLatency
            ? chartMetric === "first-token-median" ? t("median · seconds", "mediana · sekundy") : "P90 · " + t("seconds", "sekundy") : kind === "long"
            ? t("calls with ≥{0} output tokens", `wywołania z ≥${longOutMin} tokenami wyjścia`, [longOutMin])
            : t("all measured calls", "wszystkie zmierzone wywołania")} · {grain === "week" ? t("per week", "na tydzień") : t("per day", "na dzień")}</span></div>
        </div>
        <Tabs value={chartMetric} onChange={setChartMetric} options={[
          { value: "speed" as const, label: t("Token speed", "Prędkość tokenów") },
          { value: "first-token-median" as const, label: t("First token · median", "Pierwszy token · mediana") },
          { value: "first-token-p90" as const, label: t("First token · P90", "Pierwszy token · P90") },
        ]} />
        <SpeedChart rows={rows.filter(row => !hidden.has(row.key))} kind={kind} grain={grain} metric={chartMetric} span={since === null ? null : [since, today]} />
        <div className="speed-legend">
          {rows.map(row => <button key={row.key} type="button" className={`speed-toggle${hidden.has(row.key) ? " is-off" : ""}`}
            aria-pressed={!hidden.has(row.key)} onClick={() => toggle(row.key)}
            title={hidden.has(row.key) ? t("Show on the chart", "Pokaż na wykresie") : t("Hide from the chart", "Ukryj na wykresie")}>
            <svg className="speed-legend-line" width={18} height={6} aria-hidden="true">
              <line x1={1} x2={17} y1={3} y2={3} stroke={row.color} strokeWidth={2} strokeDasharray={row.dash} strokeLinecap={row.dash ? "butt" : "round"} />
            </svg>{row.label}</button>)}
          {rows.length > 1 && <LegendAllToggle allShown={rows.every(row => !hidden.has(row.key))} onShowAll={() => setAll(new Set())}
            onHideAll={() => setAll(new Set([...hidden, ...rows.map(row => row.key)]))} />}
        </div>
      </ChartExport></Card>
      <Card>
        <div className="archive-head">
          <div><span className="ui-display" style={CARD_TITLE}>{t("Per model", "Według modeli")}</span> <span className="archive-sub">· {periodName
            ? (all ? t("{0} of the chosen subscriptions", `${periodName} wybranych subskrypcji`, [periodName])
              : t("{0} of the subscription", `${periodName} subskrypcji`, [periodName]))
            : all ? t("whole history of the chosen subscriptions", "cała historia wybranych subskrypcji")
            : t("whole history of the subscription", "cała historia subskrypcji")}</span></div>
        </div>
        <Table tableId="Speed:0">
          <thead><TableRow header>
            <Th columnId="c0">{t("Model", "Model")}</Th>{all && <Th columnId="c1">{t("Subscriptions", "Subskrypcje")}</Th>}
            <Th columnId="c2" align="right">{t("Calls", "Wywołania")}</Th><Th columnId="c3" align="right">{t("Measured", "Zmierzone")}</Th>
            <Th columnId="c4" align="right">{t("Long ≥{0} tok/s", `Długie ≥${longOutMin} tok/s`, [longOutMin])}</Th>
            <Th columnId="c5" align="right">{t("All tok/s", "Wszystkie tok/s")}</Th>
            <Th columnId="ttft-median" align="right">{t("First token · median", "Pierwszy token · mediana")} <HelpDot label={t("Time to first token", "Czas do pierwszego tokena")}>
              {t("Seconds from turn start to the first token reported by the client. One measurement per completed turn, including reasoning when counted by the client. Not pure server time. Median and P90 use the combined measurements; missing or unverified values stay unknown.",
                "Sekundy od początku tury do pierwszego tokena raportowanego przez klienta. Jeden pomiar na zakończoną turę, z reasoning, jeśli klient go uwzględnia. To nie jest sam czas serwera. Mediana i P90 dotyczą połączonych pomiarów; brak lub niepewne dane pozostają nieznane.")}
              {firstTokenPending && <><br />{t("Historical first-token measurements are still being prepared; coverage is provisional.", "Historyczne pomiary pierwszego tokena są jeszcze przygotowywane; pokrycie jest tymczasowe.")}</>}
            </HelpDot></Th>
            <Th columnId="ttft-p90" align="right"><span title={t("90% of measured turns received the first token within this time.", "90% zmierzonych tur otrzymało pierwszy token w tym czasie.")}>{t("First token · P90", "Pierwszy token · P90")}</span></Th>
            <Th columnId="c6" align="right">{t("Period", "Okres")}</Th>
          </TableRow></thead>
          <tbody>{rows.map(row => {
            const share = row.totals.calls ? row.totals.timed / row.totals.calls : 0;
            const accounts = row.accounts ?? [];
            const ttft = row.totals.firstToken;
            const timingTitle = ttft?.turns ? t("{0} of {1} completed turns measured · {2}% coverage",
              `${ttft.measured} z ${ttft.turns} zakończonych tur zmierzonych · ${oneDecimal.format((ttft.coverage ?? 0) * 100)}% pokrycia`,
              [ttft.measured, ttft.turns, oneDecimal.format((ttft.coverage ?? 0) * 100)])
              : t("No verified first-token measurements", "Brak pewnych pomiarów pierwszego tokena");
            const firstTokenValue = (ms: number | null | undefined) => ms == null ? "—" : `${oneDecimal.format(ms / 1000)} s`;
            return <TableRow key={row.key}>
              <Td><button type="button" className={`speed-toggle${hidden.has(row.key) ? " is-off" : ""}`} aria-pressed={!hidden.has(row.key)}
                onClick={() => toggle(row.key)}
                title={hidden.has(row.key) ? t("Show on the chart", "Pokaż na wykresie") : t("Hide from the chart", "Ukryj na wykresie")}>
                <span className="speed-swatch" style={{ background: row.color }} />{row.label}</button></Td>
              {all && <Td title={accounts.map(sub => sub.label).join("\n")} style={{ color: "var(--muted)" }}>
                <span className="speed-subs">{accounts.slice(0, 2).map(sub => sub.name).join(", ")}{accounts.length > 2 ? ` +${accounts.length - 2}` : ""}</span></Td>}
              <Td mono align="right">{compact(row.totals.calls)}</Td>
              <Td mono align="right"><span className={`speed-cov${share < 0.9 ? " is-low" : ""}`}>
                <i><b style={{ width: `${(share * 100).toFixed(1)}%` }} /></i>{oneDecimal.format(share * 100)}%</span></Td>
              <Td mono align="right">{row.totals.long === null ? "—" : oneDecimal.format(row.totals.long)}</Td>
              <Td mono align="right">{row.totals.all === null ? "—" : oneDecimal.format(row.totals.all)}</Td>
              <Td mono align="right" title={timingTitle}>{firstTokenValue(ttft?.median_ms)}</Td>
              <Td mono align="right" title={timingTitle}>{firstTokenValue(ttft?.p90_ms)}</Td>
              <Td mono align="right" style={{ color: "var(--muted)" }}>{row.totals.first} … {row.totals.last}</Td>
            </TableRow>;
          })}</tbody>
        </Table>
        <div className="speed-foot">
          {t("Measured = calls with a known response time. Unknown is never 0: calls from Codex before 0.142.5, retried requests and copied fork history stay unmeasured.",
            "Zmierzone = wywołania ze znanym czasem odpowiedzi. Nieznany czas nigdy nie jest zerem: wywołania z Codex sprzed 0.142.5, ponowione żądania i skopiowana historia rozwidleń pozostają niezmierzone.")}
          <br />{t("The time runs from sending the request to the end of the response, so it includes time to first token: long contexts lower the number.",
            "Czas biegnie od wysłania żądania do końca odpowiedzi, więc obejmuje czas do pierwszego tokenu: długie konteksty obniżają wynik.")}
          {all && <><br />{t("All subscriptions: a model's calls are summed across the chosen subscriptions, and its speed comes from the summed tokens and time.",
            "Wszystkie subskrypcje: wywołania modelu są sumowane w wybranych subskrypcjach, a jego prędkość wynika z sumy tokenów i czasu.")}</>}
        </div>
      </Card>
    </div>
  );
}
