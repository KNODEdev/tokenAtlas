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
  rangeStart, rankedModels, readSpeedSelection, storedPickedSeries, selectedParts, setAccounts, speedModels, speedProviderOf,
  speedSubscriptions, speedSeriesKey, executionSuffix, toggleAccount, toggleModel, totalSpeed, writePickedSeries, writeSpeedSelection,
  type ModelSpeedResponse, type ModelTotals, type SpeedEntry, type SpeedGrain, type SpeedKind, type SpeedPart, type SpeedRange, type SpeedSelection,
  type SpeedSubscription,
  type SpeedProvider,
  type SpeedChartMetric,
  type SpeedYScale,
} from "../lib/model-speed";
import { TableRow, Card, Dropdown, EmptyState, ErrorState, GhostButton, LoadingCard, Table, Tabs, Td, Th, HelpDot } from "../components/ui";
import { Kpi, KpiRow, unit } from "../components/WindowStatusCard";
import {
  NO_EXECUTION, PRESET_SIZE, UNKNOWN_EFFORT, compareChoices, compareSeries, effortColumn, executionStroke, fastPairPicks, fastestPicks, modelInks,
  speedSection, topPicks, type SpeedCompare,
} from "../lib/speed-matrix";
import { SpeedChips, SpeedSeriesPicker } from "../components/SpeedSeries";
import { AccountPeriodDrawer } from "../components/AccountPeriodDrawer";
import { TriStateCheck as Check } from "../components/TriStateCheck";
import { compareTableValues, modelVersionSortValue } from "../lib/table-sort";
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
    if (data.speed_pending || data.first_token_pending) return <LoadingCard label={t("Preparing model timings", "Przygotowywanie pomiarów modeli")} height={420} shape="kpi" />;
    return <EmptyState title={t("No calls of this subscription yet", "Ta subskrypcja nie ma jeszcze wywołań")}
      detail={t("Speeds appear once its calls are imported.", "Prędkości pojawią się po zaimportowaniu jej wywołań.")} />;
  }
  return <SpeedReport entries={entries} hiddenScope={account} longOutMin={data.long_out_min} firstTokenPending={data.first_token_pending} speedPending={data.speed_pending} />;
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
  const modelsOf = (account: string) => speedModels(parts.find(part => part.account === account)?.models ?? []).map(speedSeriesKey);
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
      speedPending={loaded.some(item => !item.off && item.data?.speed_pending)}
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
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
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
        <h3><span>{name}</span></h3>
        {group.map(sub => {
          const item = loaded.find(entry => entry.sub.id === sub.id);
          const models = speedModels(item?.data?.models ?? []).sort((a, b) => {
            const version = (model: string | null) => modelVersionSortValue(model)?.split(" ")[0];
            return compareTableValues(version(a.model), version(b.model), { column: "model", direction: "desc" }, collator)
              || collator.compare(a.model!, b.model!);
          });
          const names = models.map(speedSeriesKey);
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
              {models.map(series => <label key={speedSeriesKey(series)} className="speed-drawer-row">
                <Check state={modelSelected(selection, sub.id, speedSeriesKey(series), inactive) && modelSelected(selection, sub.id, series.model!, inactive) ? "all" : "none"}
                  label={`${sub.label} · ${usageModelLabel(series.model!)}${executionSuffix(series, t("unknown", "nieznany"), t("mixed", "mieszany"), t("unknown effort", "effort nieznany"))}`}
                  onChange={() => onChange(toggleModel(selection, sub.id, speedSeriesKey(series), names, inactive))} />
                <span className="speed-drawer-name">{usageModelLabel(series.model!)}{executionSuffix(series, t("unknown", "nieznany"), t("mixed", "mieszany"), t("unknown effort", "effort nieznany"))}</span>
                <span className="mono speed-drawer-facts">{t("{0} calls", `${compact(series.total.calls)} wywołań`, [compact(series.total.calls)])}</span>
              </label>)}
            </div>}
          </div>;
        })}
      </section>;
    })}
  </div>;
}

/** How busy a series is, for ordering and the default selection: calls, or first-token turns while call timings are still prepared. */
const activity = (totals: ModelTotals) => Math.max(totals.calls, totals.firstToken?.turns ?? 0);

type Row = { key: string; label: string; name: string; model: string; ink: string; color: string; dash: string | undefined; totals: ModelTotals;
  series: ModelSpeedResponse["models"][number]; accounts: SpeedSubscription[] | null };

function SpeedReport({ entries, hiddenScope, longOutMin, controls, split = false, subscriptions, waiting = false, firstTokenPending = false, speedPending = false }: {
  entries: SpeedEntry[]; hiddenScope: string; longOutMin: number; controls?: ReactNode; split?: boolean;
  /** "All" only: a chosen subscription has not answered yet, so an empty report is still loading. */
  waiting?: boolean;
  firstTokenPending?: boolean;
  speedPending?: boolean;
  /** "All" only: the subscriptions behind an entry, for its label and the table's column. */
  subscriptions?: (accounts: string[]) => SpeedSubscription[];
}) {
  const { t, locale, language } = useI18n();
  const [kind, setKind] = useState<SpeedKind>("long");
  const [grain, setGrain] = useState<SpeedGrain>("day");
  const [chartMetric, setChartMetric] = useState<SpeedChartMetric>("speed");
  const [yScale, setYScale] = useState<SpeedYScale>("capped");
  const [hover, setHover] = useState<string | null>(null);
  const chartLatency = chartMetric !== "speed";
  const chartTitle = chartLatency ? t("Time to first token", "Czas do pierwszego tokena") : t("Speed over time", "Prędkość w czasie");
  // The period narrows the tiles, the chart and the table alike; UTC days, as the server's day rows.
  const [range, setRange] = useState<SpeedRange>("all");
  const today = new Date().toISOString().slice(0, 10), since = rangeStart(range, today);
  const ranged = useMemo(() => entriesSince(entries, since), [entries, since]);
  // First day of each series in the whole history: a recent one is marked new whatever the period.
  const firstDays = useMemo(() => new Map(entries.map(entry => [entry.key, entry.series.points[0]?.at ?? null])), [entries]);
  const rows = useMemo<Row[]>(() => {
    const sorted = ranged.map(entry => {
      const accounts = subscriptions ? subscriptions(entry.accounts) : null;
      const name = usageModelLabel(entry.model) + (split && accounts?.[0] ? ` · ${accounts[0].name}` : "");
      const model = usageModelLabel(entry.model) + executionSuffix(entry.series, t("unknown", "nieznany"), t("mixed", "mieszany"), t("unknown effort", "effort nieznany"));
      return { key: entry.key, model: entry.model, series: entry.series, totals: modelTotals(entry.series), accounts, name,
        label: split && accounts?.[0] ? `${model} · ${accounts[0].name}` : model };
    }).sort((a, b) => activity(b.totals) - activity(a.totals));
    // A model's ink (its vendor's hue, turned per model in order of calls); effort sets the shade, speed mode the pattern.
    const inks = modelInks(sorted.map(row => row.model));
    return sorted.map(row => { const ink = inks.get(row.model)!; return { ...row, ink, ...executionStroke(ink, row.series) }; });
  }, [ranged, language, split, subscriptions, t]);
  // The period's value of the chart's metric (the server's combined first-token percentiles, or a ratio of sums).
  const cellValue = (totals: ModelTotals) => {
    if (chartMetric === "speed") return totalSpeed(totals, kind);
    const ms = chartMetric === "first-token-median" ? totals.firstToken?.median_ms : totals.firstToken?.p90_ms;
    return ms == null ? null : ms / 1000;
  };
  /*
   * The chart shows a few series (docs/design/mockups/speed-series-picker.html, approved 2026-10-29): the picked ones,
   * every measured execution of one model, or one effort across models. Nothing stored starts from the top preset.
   */
  const pickItems = useMemo(() => rows.map(row => ({ key: row.key, name: row.name, series: row.series, calls: activity(row.totals) })), [rows]);
  const [stored, setStored] = useState<Set<string> | null>(() => storedPickedSeries(hiddenScope));
  const picked = useMemo(() => stored ?? topPicks(pickItems), [stored, pickItems]);
  const [compare, setCompare] = useState<SpeedCompare>("custom");
  const [compareModel, setCompareModel] = useState<string | null>(null);
  const [compareEffort, setCompareEffort] = useState("high");
  const [withFast, setWithFast] = useState(true);
  const [kpiScope, setKpiScope] = useState<"chart" | "all">("chart");
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState("");
  const [onlyMeasured, setOnlyMeasured] = useState(true);
  const opener = useRef<HTMLElement | null>(null);
  const measured = pickItems.filter(item => cellValue(rows.find(row => row.key === item.key)!.totals) !== null
    && ["standard", "fast"].includes(speedSection(item.series)));
  const choices = compareChoices(measured);
  const model = compareModel !== null && choices.models.includes(compareModel) ? compareModel : choices.models[0] ?? "";
  const effort = choices.efforts.includes(compareEffort) ? compareEffort : choices.efforts.includes("high") ? "high" : choices.efforts[0] ?? "";
  const shownKeys = compare === "custom" ? picked
    : new Set(compareSeries(measured, compare, compare === "model" ? model : effort, withFast).map(item => item.key));
  const setPicked = (next: Set<string>) => { setStored(next); writePickedSeries(hiddenScope, next); setCompare("custom"); };
  // Editing a comparison keeps what it shows as the starting point; a group turns on unless all of it is on already.
  const toggle = (keys: string[]) => {
    const next = new Set(shownKeys), on = keys.every(key => shownKeys.has(key));
    for (const key of keys) if (on) next.delete(key); else next.add(key);
    setPicked(next);
  };
  const openDrawer = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (compare !== "custom") setPicked(new Set(shownKeys));
    setDrawer(true);
  };
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
      {waiting || speedPending || firstTokenPending ? <LoadingCard label={t("Loading response times", "Wczytywanie czasów odpowiedzi")} height={420} shape="kpi" />
        : entries.length ? <EmptyState title={t("No calls in the {0}", `Brak wywołań w okresie: ${periodName}`, [periodName])}
          detail={t("Choose a longer period.", "Wybierz dłuższy okres.")} />
        : <EmptyState title={t("No subscription or model is chosen", "Nie wybrano żadnej subskrypcji ani modelu")}
          detail={t("Choose them in “Subscriptions and models”.", "Wybierz je w „Subskrypcje i modele”.")} />}</div>;
  }
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const oneDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // The tiles follow the series on the chart unless switched to all of them.
  const shownRows = rows.filter(row => shownKeys.has(row.key));
  const kpiRows = kpiScope === "chart" ? shownRows : rows;
  const ranked = rankedModels(kpiRows, kind);
  const calls = kpiRows.reduce((sum, row) => sum + row.totals.calls, 0), timed = kpiRows.reduce((sum, row) => sum + row.totals.timed, 0);
  const allCalls = rows.reduce((sum, row) => sum + row.totals.calls, 0);
  const latest = latestWeek(kpiRows.map(row => row.series), kind);
  const speedValue = (value: number | null) => value === null ? "—" : <>{whole.format(value)}{unit(" tok/s")}</>;
  const noRanked = t("no model with {0} calls of this kind", `brak modelu z ${MIN_RANKED_CALLS} wywołaniami tego rodzaju`, [MIN_RANKED_CALLS]);
  const all = subscriptions !== undefined;
  // One model's efforts share its ink, so their shades spread wider.
  const stroke = (row: Row) => compare === "model" ? executionStroke(row.ink, row.series, 1.8) : { color: row.color, dash: row.dash };
  const formatValue = (value: number | null) => value === null ? "—" : chartLatency ? `${oneDecimal.format(value)} s` : `${whole.format(value)} tok/s`;
  const effortText = (row: Row) => { const column = effortColumn(row.series); return column === NO_EXECUTION ? "" : column === UNKNOWN_EFFORT ? "?" : column; };
  const valueOf = (key: string) => { const row = rows.find(item => item.key === key); return row ? cellValue(row.totals) : null; };
  const cellTitle = chartMetric === "speed" ? t("Cells: tok/s for the period", "Komórki: tok/s w okresie")
    : chartMetric === "first-token-median" ? t("Cells: first-token median for the period, seconds", "Komórki: mediana pierwszego tokena w okresie, sekundy")
    : t("Cells: first-token P90 for the period, seconds", "Komórki: P90 pierwszego tokena w okresie, sekundy");
  return (
    <div className="archive speed ui-tab-page">
      {controlRow}
      <div className="speed-kpi-scope">{t("Tiles for", "Kafelki dla")} <Tabs value={kpiScope} onChange={setKpiScope} options={[
        { value: "chart" as const, label: t("series on the chart", "serii na wykresie"), title: t("Counted only from the series on the chart", "Liczone tylko z serii na wykresie") },
        { value: "all" as const, label: t("all", "wszystkich"), title: t("Counted from every series in the period", "Liczone ze wszystkich serii w okresie") },
      ]} /></div>
      <KpiRow columns={4}>
        <Kpi label={t("Fastest model", "Najszybszy model")} value={speedValue(ranked[0] ? totalSpeed(ranked[0].totals, kind) : null)} visual={null}
          caption={ranked[0]?.label ?? noRanked} />
        <Kpi label={t("Slowest model", "Najwolniejszy model")} value={speedValue(ranked.length ? totalSpeed(ranked.at(-1)!.totals, kind) : null)} visual={null}
          caption={ranked.at(-1)?.label ?? noRanked} />
        {kpiScope === "chart"
          ? <Kpi label={t("Calls on the chart", "Wywołania na wykresie")} value={compact(calls)} visual={null}
            caption={t("{0}% of {1} calls · {2}% measured",
              `${allCalls ? oneDecimal.format(calls / allCalls * 100) : "—"}% z ${compact(allCalls)} wywołań · ${calls ? oneDecimal.format(timed / calls * 100) : "—"}% zmierzonych`,
              [allCalls ? oneDecimal.format(calls / allCalls * 100) : "—", compact(allCalls), calls ? oneDecimal.format(timed / calls * 100) : "—"])} />
          : <Kpi label={t("Measured calls", "Zmierzone wywołania")}
            value={calls ? <>{oneDecimal.format(timed / calls * 100)}{unit("%")}</> : "—"} visual={null}
            caption={t("{0} of {1} calls", `${compact(timed)} z ${compact(calls)} wywołań`, [compact(timed), compact(calls)])} />}
        <Kpi label={t("Latest week", "Ostatni tydzień")} value={speedValue(latest?.speed ?? null)} visual={null}
          caption={!latest ? "—" : kpiScope === "chart"
            ? t("{0} series on the chart · week of {1} · {2} calls",
              `${shownRows.length} serii na wykresie · tydzień od ${latest.week} · ${compact(latest.calls)} wywołań`, [shownRows.length, latest.week, compact(latest.calls)])
            : t("all models · week of {0} · {1} calls",
              `wszystkie modele · tydzień od ${latest.week} · ${compact(latest.calls)} wywołań`, [latest.week, compact(latest.calls)])} />
      </KpiRow>
      <Card><ChartExport title={chartTitle}>
        <div className="archive-head">
          <div><span className="ui-display" style={CARD_TITLE}>{chartTitle}</span> <HelpDot label={chartTitle}>{chartLatency
            ? t("Verified first-token times in seconds, grouped by model, speed mode and reasoning effort. Lower is faster. Unknown settings stay separate. Each day's or week's percentiles use only that execution variant's measurements.",
              "Pewne czasy pierwszego tokena w sekundach, według modelu, trybu szybkości i poziomu rozumowania. Mniej znaczy szybciej. Nieznane ustawienia pozostają osobno. Percentyle dnia lub tygodnia obejmują tylko pomiary danego wariantu.") : t(
            "Points with ≥{0} calls; gaps without traffic are not bridged. Pick series under “Series”, or compare one model or one effort.",
            `Punkty z ≥${MIN_POINT_CALLS} wywołań; przerwy bez ruchu nie są łączone. Wybierz serie w „Serie” albo porównaj jeden model lub jeden effort.`, [MIN_POINT_CALLS])}
            <br />{t("Separate series for each model, speed mode and reasoning effort. Missing settings remain unknown.", "Osobne serie dla modelu, trybu szybkości i poziomu rozumowania. Brakujące ustawienia pozostają nieznane.")}
            {speedPending && <><br />{t("Execution timing history is still being prepared.", "Historia pomiarów według trybów jest jeszcze przygotowywana.")}</>}
            </HelpDot> <span className="archive-sub">· {chartLatency
            ? chartMetric === "first-token-median" ? t("median · seconds", "mediana · sekundy") : "P90 · " + t("seconds", "sekundy") : kind === "long"
            ? t("calls with ≥{0} output tokens", `wywołania z ≥${longOutMin} tokenami wyjścia`, [longOutMin])
            : t("all measured calls", "wszystkie zmierzone wywołania")} · {grain === "week" ? t("per week", "na tydzień") : t("per day", "na dzień")}</span></div>
        </div>
        <div className="speed-chart-switches">
          <Tabs value={chartMetric} onChange={setChartMetric} options={[
            { value: "speed" as const, label: t("Token speed", "Prędkość tokenów") },
            { value: "first-token-median" as const, label: t("First token · median", "Pierwszy token · mediana") },
            { value: "first-token-p90" as const, label: t("First token · P90", "Pierwszy token · P90") },
          ]} />
          <span className="speed-yscale">{t("Y axis", "oś Y")} <Tabs value={yScale} onChange={setYScale} options={[
            { value: "capped" as const, label: t("capped", "przycięta"), title: chartLatency
              ? t("Up to the 95th percentile of the drawn values; slower ones are marked ▲ at the top", "Do 95. percentyla rysowanych wartości; wolniejsze oznaczone ▲ u góry")
              : t("Without a model far faster than the rest; faster points are marked ▲ at the top", "Bez modelu dużo szybszego od reszty; szybsze punkty oznaczone ▲ u góry") },
            { value: "log" as const, label: "log", title: t("Logarithmic scale", "Skala logarytmiczna") },
            { value: "full" as const, label: t("full", "pełna"), title: t("Every value on the scale", "Wszystkie wartości na skali") },
          ]} /></span>
        </div>
        <div className="speed-compare">
          <Tabs value={compare} onChange={setCompare} options={[
            { value: "custom" as const, label: t("Picked", "Wybrane"), title: t("Your own choice of series", "Własny wybór serii") },
            { value: "model" as const, label: t("One model", "Jeden model"), title: t("Every effort and speed mode of one model", "Wszystkie efforty i tryby szybkości jednego modelu") },
            { value: "effort" as const, label: t("One effort", "Jeden effort"), title: t("One effort across every model", "Jeden effort we wszystkich modelach") },
          ]} />
          {compare === "model" && choices.models.length > 0 && <Dropdown value={model} onChange={setCompareModel} ariaLabel={t("Model", "Model")}
            options={choices.models.map(name => ({ value: name, label: name }))} />}
          {compare === "effort" && choices.efforts.length > 0 && <Tabs value={effort} onChange={setCompareEffort}
            options={choices.efforts.map(column => ({ value: column, label: column === UNKNOWN_EFFORT ? "?" : column === NO_EXECUTION ? "—" : column,
              title: column === UNKNOWN_EFFORT ? t("unknown effort", "effort nieznany") : column === NO_EXECUTION ? t("No reasoning setting recorded", "Brak zapisanego poziomu rozumowania") : undefined }))} />}
          {compare !== "custom" && <label className="speed-split"><input type="checkbox" checked={withFast} onChange={event => setWithFast(event.target.checked)} />
            {t("with fast", "z fast")}</label>}
          <GhostButton onClick={openDrawer}>{t("Series · {0}", `Serie · ${shownRows.length}`, [shownRows.length])}</GhostButton>
        </div>
        <SpeedChips compare={compare} highlight={hover} onHover={setHover} onAdd={openDrawer} onRemove={key => toggle([key])}
          chips={shownRows.map(row => ({ key: row.key, name: row.name, effort: effortText(row), fast: row.series.speed === "fast", label: row.label,
            mode: row.series.speed === "mixed" ? t("mixed", "mieszany") : row.series.speed?.startsWith("unknown") ? t("unknown", "nieznany") : null,
            ...stroke(row), value: formatValue(cellValue(row.totals)) }))} />
        <SpeedChart rows={shownRows.map(row => ({ ...row, ...stroke(row) }))} kind={kind} grain={grain} metric={chartMetric} yScale={yScale}
          highlight={hover !== null && shownKeys.has(hover) ? hover : null} span={since === null ? null : [since, today]} />
      </ChartExport></Card>
      {drawer && <AccountPeriodDrawer busy={false} onClose={() => { setDrawer(false); setHover(null); }} returnFocus={opener.current} className="speed-series-drawer"
        closeLabel={t("Close the series choice", "Zamknij wybór serii")} title={t("Series on the chart", "Serie na wykresie")}
        subtitle={t("{0} picked · a cell adds or removes a series, a row its model, a column its effort",
          `wybrane: ${shownRows.length} · komórka dodaje lub usuwa serię, wiersz jej model, kolumna jej effort`, [shownRows.length])}>
        <SpeedSeriesPicker picked={shownRows.length} search={search} onSearch={setSearch} onlyMeasured={onlyMeasured} onOnlyMeasured={setOnlyMeasured}
          items={rows.map(row => ({ key: row.key, name: row.name, model: row.model, series: row.series,
            calls: chartLatency ? row.totals.firstToken?.turns ?? 0 : row.totals.calls,
            label: row.label, ink: row.ink, color: row.color, dash: row.dash, value: cellValue(row.totals) }))}
          hidden={new Set(rows.filter(row => !shownKeys.has(row.key)).map(row => row.key))} onToggle={toggle} onHover={setHover}
          firstDay={key => firstDays.get(key) ?? null} today={today}
          format={value => chartLatency ? oneDecimal.format(value) : whole.format(value)} valueTitle={cellTitle}
          countLabel={chartLatency ? t("turns", "tury") : t("calls", "wywołania")}
          presets={[
            { label: t("Top {0}", `Top ${PRESET_SIZE}`, [PRESET_SIZE]), title: t("The busiest series of the busiest models, and the busiest fast one",
              "Najczęstsza seria najczęściej używanych modeli i najczęstsza fast"), apply: () => setPicked(topPicks(pickItems)) },
            { label: t("Fastest {0}", `Najszybsze ${PRESET_SIZE}`, [PRESET_SIZE]), title: cellTitle,
              apply: () => setPicked(fastestPicks(pickItems, valueOf, !chartLatency)) },
            ...rows.some(row => row.series.speed === "fast") ? [{ label: t("Fast vs standard", "Fast vs standard"),
              title: t("Each fast series beside the same model and effort without fast", "Każda seria fast obok tego samego modelu i effortu bez fast"),
              apply: () => setPicked(fastPairPicks(pickItems)) }] : [],
            { label: t("Clear", "Wyczyść"), title: t("Take every series off the chart", "Zdejmij wszystkie serie z wykresu"), apply: () => setPicked(new Set()) },
          ]} />
      </AccountPeriodDrawer>}
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
              <Td><button type="button" className={`speed-toggle${shownKeys.has(row.key) ? "" : " is-off"}`} aria-pressed={shownKeys.has(row.key)}
                onClick={() => toggle([row.key])}
                title={shownKeys.has(row.key) ? t("Hide from the chart", "Ukryj na wykresie") : t("Show on the chart", "Pokaż na wykresie")}>
                <span className="speed-swatch" style={{ background: stroke(row).color }} />{row.label}</button></Td>
              {all && <Td title={accounts.map(sub => sub.label).join("\n")} style={{ color: "var(--muted)" }}>
                <span className="speed-subs">{accounts.slice(0, 2).map(sub => sub.name).join(", ")}{accounts.length > 2 ? ` +${accounts.length - 2}` : ""}</span></Td>}
              <Td sortValue={row.totals.calls} mono align="right">{compact(row.totals.calls)}</Td>
              <Td sortValue={share} mono align="right"><span className={`speed-cov${share < 0.9 ? " is-low" : ""}`}>
                <i><b style={{ width: `${(share * 100).toFixed(1)}%` }} /></i>{oneDecimal.format(share * 100)}%</span></Td>
              <Td sortValue={row.totals.long} mono align="right">{row.totals.long === null ? "—" : oneDecimal.format(row.totals.long)}</Td>
              <Td sortValue={row.totals.all} mono align="right">{row.totals.all === null ? "—" : oneDecimal.format(row.totals.all)}</Td>
              <Td sortValue={ttft?.median_ms ?? null} mono align="right" title={timingTitle}>{firstTokenValue(ttft?.median_ms)}</Td>
              <Td sortValue={ttft?.p90_ms ?? null} mono align="right" title={timingTitle}>{firstTokenValue(ttft?.p90_ms)}</Td>
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
