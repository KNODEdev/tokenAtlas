import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { capacityWithContext, contextPremiumIncluded } from "../lib/capacity-context";
import { useContextPreview } from "../lib/context-premium";
import type { CapacityBasis } from "../../shared/codex-promotions";
import type { ApiAccount } from "../lib/api";
import { onApiRefresh } from "../lib/api";
import type { RosterCard } from "../lib/roster";
import { useI18n } from "../lib/i18n";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../shared/time-range-presets";
import { useRecordedRange } from "../lib/recorded-range";
import { capacityAccounts, readGlobalCapacity, type CapacityAccount, type CapacityAccountResult } from "../lib/global-capacity";
import { capacityFull, capacityIsLowerBound, capacityLocalLowerBound, capacityMissingReason, capacityPeriodLabel, capacityPlanEstablished, capacityPlanLabel, capacityUnitFormat, type CapacityUnit } from "../lib/codex-capacity";
import { accountCycles, chosenCycles, comparableAccounts, COMPARE_SELECTION_KEY, leaveOutCycles, providerName, subscriptionColors } from "../lib/capacity-compare";
import { accountSelected, modelSelected, readSpeedSelection, setAccounts, toggleModel, writeSpeedSelection, type SpeedSelection } from "../lib/model-speed";
import { subscriptionAnalysisAdapter } from "../lib/subscription-analysis";
import { vendorColor } from "../lib/model-colors";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import { DataTable, TableRow, Card, EmptyState, ErrorState, Field, GhostButton, HelpDot, LoadingCard, Selector, Tabs } from "./ui";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { CapacityHistoryChart } from "./CapacityHistoryChart";
import { CapacityCycleList, capacityUnitLabel, type CycleSubject } from "./CapacityCycleList";
import "./CodexCapacitySummary.css";
import "./SubscriptionChoice.css";
import "./GlobalCapacity.css";
import { visibleReportFreshness } from "../lib/report-freshness";

export type History = { results: CapacityAccountResult[]; stale: boolean };
/** Samples under this many percentage points extrapolate far; the drawer can leave them out in one step. */
const SMALL_SAMPLE_PP = 20;
const NO_MEDIAN = { value: null, plan: null, count: 0, reason: "no_plan" } as const;

/**
 * The histories of every subscription, in one read of the stored cycles (`readGlobalCapacity`). Shown histories stay until
 * the next answer replaces them; the read repeats when the range or the data changes, and two seconds later while some
 * account's sums are still being stored.
 */
export function useCapacityHistories(subjects: CapacityAccount[], since: string, until: string, minutes: 300 | 10080 | 43200, dataRevision?: number, enabled = true) {
  const scope = JSON.stringify([since, until, minutes, enabled]);
  // Roster refreshes rebuild the subject list; only a change of who is listed needs a new read.
  const subjectsKey = subjects.map(subject => `${subject.id}\u0000${subject.provider}`).join("\n");
  const current = useRef(subjects);
  current.current = subjects;
  const [state, setState] = useState<{ scope: string; histories: ReadonlyMap<string, History> }>({ scope, histories: new Map() });
  const histories = state.scope === scope ? state.histories : new Map<string, History>();
  const [round, setRound] = useState(0);
  const [reading, setReading] = useState(false);
  useEffect(() => onApiRefresh(() => setRound(value => value + 1)), []);
  const observedDataRevision = useRef(dataRevision);
  useEffect(() => {
    if (observedDataRevision.current === dataRevision) return;
    observedDataRevision.current = dataRevision;
    setRound(value => value + 1);
  }, [dataRevision]);
  useEffect(() => {
    if (!enabled) { setReading(false); return; }
    const controller = new AbortController();
    let alive = true, retry: ReturnType<typeof setTimeout> | undefined;
    const subjects = current.current;
    setReading(true);
    readGlobalCapacity(subjects, { since, until }, minutes, controller.signal).then(results => {
      if (!alive) return;
      const next = new Map([...results].map(([id, list]) => [id, { results: list, stale: list.some(item => item.preparing || item.preparedAt != null) }]));
      setState(previous => {
        if (previous.scope !== scope) return { scope, histories: next };
        const histories = new Map([...next].map(([id, history]) => {
          const before = previous.histories.get(id);
          if (!before) return [id, history] as const;
          // Pending publication is not an empty result; keep the last complete cycles for this counter.
          const results = history.results.map(result => {
            const completed = before.results.find(prior => prior.counter === result.counter);
            return result.preparing && !result.windows.length && completed?.windows.length
              ? { ...completed, preparing: true } : result;
          });
          return [id, { ...history, results }] as const;
        }));
        return { scope, histories };
      });
      if ([...next.values()].some(history => history.stale)) retry = setTimeout(() => { if (alive) setRound(value => value + 1); }, 2000);
    }, (error: unknown) => {
      if (!alive) return;
      const message = error instanceof Error ? error.message : String(error);
      setState({ scope, histories: new Map(subjects.map(subject => [subject.id,
        { results: [{ account: subject, counter: "", counterLabel: "", windows: [], error: message }], stale: false }])) });
    }).finally(() => { if (alive) setReading(false); });
    return () => { alive = false; controller.abort(); clearTimeout(retry); };
  }, [scope, subjectsKey, round, enabled]);
  const staleTimes = [...histories.values()].flatMap(history => history.results.flatMap(result => result.preparedAt == null ? [] : [result.preparedAt]));
  return { histories, reading, staleAt: staleTimes.length ? Math.min(...staleTimes) : null };
}

/** Cycles of the chosen subscriptions on one scale: the timeline chart and the cycle list of one subscription, coloured per subscription. */
export function GlobalCapacity({ accounts, cards, dataRevision }: { accounts: ApiAccount[]; cards: RosterCard[]; dataRevision?: number }) {
  const { t, locale } = useI18n();
  const [days, setDays] = useState(90);
  const [minutes, setMinutes] = useState<300 | 10080 | 43200>(10080);
  const [basis, setBasis] = useState<CapacityBasis>("observed");
  const [unit, setUnit] = useState<CapacityUnit>("api_standard");
  const subjects = useMemo(() => comparableAccounts(capacityAccounts(accounts, cards)), [accounts, cards]);
  const inactive = useMemo(() => new Set(subjects.filter(subject => !subject.active).map(subject => subject.id)), [subjects]);
  const colors = useMemo(() => subscriptionColors(subjects), [subjects]);
  const [selection, setSelection] = useState<SpeedSelection>(() => readSpeedSelection(undefined, COMPARE_SELECTION_KEY));
  const update = (next: SpeedSelection) => { setSelection(next); writeSpeedSelection(next, undefined, COMPARE_SELECTION_KEY); };
  const [drawer, setDrawer] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const chosen = subjects.filter(subject => accountSelected(selection, subject.id, inactive));
  const today = new Date().toISOString().slice(0, 10);
  const whole = useRecordedRange(days === 0);
  const until = days === 0 ? whole.data?.until ?? today : today;
  const since = days === 0 ? whole.data?.since ?? today : new Date(Date.parse(today) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const { histories, reading, staleAt } = useCapacityHistories(subjects, since, until, minutes, dataRevision, whole.ready);
  const freshnessId = useId();
  useEffect(() => { visibleReportFreshness(freshnessId, staleAt); return () => visibleReportFreshness(freshnessId, null); }, [freshnessId, staleAt]);

  const contextPreview = useContextPreview();
  const results = useMemo(() => new Map([...histories].map(([id, history]) => [id, history.results.map(result =>
    contextPreview && result.account.provider === "codex"
      ? { ...result, windows: result.windows.map(window => capacityWithContext(window, true).window) } : result)])), [histories, contextPreview]);
  const pricedHistories = new Map([...histories].map(([id, history]) => [id, { ...history, results: results.get(id)! }]));
  const cycles = chosenCycles(results, chosen, selection, inactive);
  const accountOf = new Map(cycles.map(cycle => [cycle.window.id, cycle.account]));
  const counterOf = new Map([...histories.values()].flatMap(history => history.results.flatMap(result => result.windows.map(window => [window.id, result.counter] as const))));
  const subjectOf = (window: CodexComparisonWindow): CycleSubject => {
    const account = accountOf.get(window.id)!;
    const provider = subscriptionAnalysisAdapter(account.provider).id;
    return { key: account.id, label: `${providerName(account.provider)} · ${account.label}`, color: colors.get(account.id) ?? "var(--accent)",
      creditsAvailable: account.provider === "codex",
      scope: { provider, options: { since, until, account: account.id, counter: counterOf.get(window.id) || undefined } } };
  };
  const windows = cycles.map(cycle => cycle.window);
  const contextPriced = contextPremiumIncluded(windows);
  const contextImpact = contextPriced === null ? undefined : contextPreview || contextPriced;
  const creditsAvailable = cycles.some(cycle => cycle.account.provider === "codex");
  const activeUnit: CapacityUnit = unit === "credits_low" && !creditsAvailable ? "api_standard" : unit;
  const preparing = (id: string) => histories.get(id)?.results.some(result => result.preparing) ?? false;
  const waiting = chosen.filter(subject => !histories.has(subject.id) || preparing(subject.id)).length;
  const troubled = chosen.flatMap(subject => (histories.get(subject.id)?.results ?? []).filter(result => !result.preparing && (result.error || result.unavailable || !result.windows.length))
    .map(result => ({ subject, result })));
  const openDrawer = () => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDrawer(true); };
  const subscriptionsLabel = t("Subscriptions and cycles · {0} of {1} · {2} cycles",
    `Abonamenty i cykle · ${chosen.length} z ${subjects.length} · ${cycles.length} cykli`, [chosen.length, subjects.length, cycles.length]);

  return <section className="global-capacity"><Card pad="0" style={{ overflow: "hidden" }}>
    <header className="global-capacity-head">
      <h2>{t("Global subscription capacity", "Globalna pojemność abonamentów")}</h2>
      <p>{t("Cycles of the chosen subscriptions on one scale · colour = subscription, in shades of its provider", "Cykle wybranych abonamentów na wspólnej skali · kolor = abonament, w odcieniach dostawcy")}</p>
    </header>
    <div className="ui-toolbar global-capacity-controls">
      <GhostButton onClick={openDrawer}>{subscriptionsLabel}</GhostButton>
      <Field label={t("History", "Historia")}><Selector ariaLabel={t("History", "Historia")} value={String(days)} onChange={value => setDays(Number(value))}
        options={[...TIME_RANGE_DAYS.map(value => ({ value: String(value), label: timeRangeLabel(value, t) })), { value: "0", label: t("All", "Całość") }]} /></Field>
      <Field label={t("Counter", "Licznik")}><Selector ariaLabel={t("Counter", "Licznik")} value={String(minutes)} onChange={value => setMinutes(Number(value) as 300 | 10080 | 43200)} options={[
        { value: "10080", label: t("Weekly", "Tygodniowy") }, { value: "300", label: "5h" }, { value: "43200", label: t("30 days", "30 dni") },
      ]} /></Field>
      <Field label={t("Capacity basis", "Pojemność")}><Selector ariaLabel={t("Capacity basis", "Pojemność")} value={basis} onChange={value => setBasis(value as CapacityBasis)} options={[
        { value: "observed", label: t("Observed capacity", "Zaobserwowana pojemność") }, { value: "regular", label: t("Without promotions", "Bez promocji") },
      ]} /></Field>
      <Field label={t("Unit", "Jednostka")}><Tabs value={activeUnit} onChange={setUnit}
        options={(creditsAvailable ? ["api_standard", "credits_low", "tokens"] as const : ["api_standard", "tokens"] as const).map(value => ({ value, label: capacityUnitLabel(value, t) }))} /></Field>
      <HelpDot label={t("What is compared", "Co porównujemy")}>{t("Each chosen cycle keeps its own plan, tier and prices; the chart and the list put cycles of different subscriptions on one scale per measure. Credits exist only for Codex. To compare tiers, switch the chart to “Per 1% as ×1”. Promotions are removed only with “Without promotions” and only where they are declared. Dates are UTC.",
        "Każdy wybrany cykl zachowuje swój plan, wariant i ceny; wykres i lista stawiają cykle różnych abonamentów na wspólnej skali każdej miary. Kredyty istnieją tylko w Codeksie. Aby porównać warianty, przełącz wykres na „Na 1% jako ×1”. Promocje usuwamy tylko w trybie „Bez promocji” i tylko tam, gdzie są zadeklarowane. Daty są w UTC.")}</HelpDot>
    </div>
    {waiting > 0 && <p role="status" className="global-capacity-status">{t("Reading subscription history", "Wczytywanie historii abonamentów")}: {chosen.length - waiting}/{chosen.length}. {t("Available cycles appear as they arrive.", "Dostępne cykle pojawiają się na bieżąco.")}</p>}
    {whole.error && <ErrorState message={whole.error} onRetry={whole.reload} />}
    {!whole.ready && !whole.error && <LoadingCard />}
    <div className="global-capacity-body">
      {!chosen.length
        ? <EmptyState title={t("No subscription chosen", "Nie wybrano abonamentu")}
          detail={t("Choose subscriptions and their cycles to compare them on one scale.", "Wybierz abonamenty i ich cykle, aby porównać je na wspólnej skali.")} />
        : !windows.length && !waiting && whole.ready ? <EmptyState title={t("No cycles to compare", "Brak cykli do porównania")}
          detail={t("The chosen subscriptions have no cycles of this counter in the range, or all of them were left out. Try a longer history or the other counter.", "Wybrane abonamenty nie mają cykli tego licznika w zakresie albo wszystkie zostały pominięte. Wybierz dłuższą historię lub drugi licznik.")} />
        : <>
          <div className="capacity-section capacity-history">
            <CapacityHistoryChart contextImpact={contextImpact} windows={windows} unit={activeUnit} basis={basis} median={NO_MEDIAN} markers={[]} since={since} until={until} subjectOf={subjectOf}
              title={`${t("Capacity at 100% in successive cycles", "Pojemność 100% w kolejnych cyklach")} · ${capacityUnitLabel(activeUnit, t)}`}
              subtitle={t("one segment per cycle, from reset to reset · colour = subscription", "odcinek = cykl od resetu do resetu · kolor = abonament")} />
          </div>
          <CapacityCycleList key={String(creditsAvailable)} contextImpact={contextImpact} windows={windows} basis={basis} creditsAvailable={creditsAvailable} subjectOf={subjectOf}
            referenceScope={JSON.stringify(["compare", minutes])} measuresKey="tokenatlas.capacity-compare-measures.v1" defaultMeasures={["api_standard"]}
            subtitle={t("newest first, every chosen subscription · click a row to open the cycle details", "najnowsze na górze, wszystkie wybrane abonamenty · kliknij wiersz, aby otworzyć szczegóły cyklu")}
            empty={t("No cycles to compare.", "Brak cykli do porównania.")} />
        </>}
    </div>
    {troubled.length > 0 && <footer className="global-capacity-foot">
      <details className="global-capacity-unavailable" open={!windows.length && !waiting}>
        <summary>{t("Chosen subscriptions without cycles", "Wybrane abonamenty bez cykli")} · {troubled.length}</summary>
        {troubled.map(({ subject, result }) => <p key={subject.id + result.counter}><strong>{providerName(subject.provider)} · {subject.label}</strong>{result.counterLabel ? ` · ${result.counterLabel}` : ""} · {result.error
          ? browserSafeDiagnostic(result.error) : t("No measurements for this counter in the selected range.", "Brak pomiarów tego licznika w wybranym zakresie.")}</p>)}
      </details>
    </footer>}
    {drawer && <AccountPeriodDrawer busy={false} onClose={() => setDrawer(false)} returnFocus={opener.current} className="capacity-compare-drawer"
      closeLabel={t("Close the subscription and cycle choice", "Zamknij wybór abonamentów i cykli")}
      title={t("Subscriptions and cycles", "Abonamenty i cykle")}
      subtitle={t("{0} of {1} subscriptions · {2} cycles · {3} – {4} UTC",
        `${chosen.length} z ${subjects.length} abonamentów · ${cycles.length} cykli · ${since} – ${until} UTC`, [chosen.length, subjects.length, cycles.length, since, until])}>
      <CompareChoiceList subjects={subjects} histories={pricedHistories} reading={reading} colors={colors} selection={selection} inactive={inactive} onChange={update}
        unit={activeUnit} basis={basis} />
    </AccountPeriodDrawer>}
  </Card></section>;
}

/**
 * Providers, their subscriptions and, for an opened subscription, its cycles (newest first). Clicking a subscription only
 * opens or closes its list; cycles are chosen one by one (or per provider with the actions).
 */
function CompareChoiceList({ subjects, histories, reading, colors, selection, inactive, onChange, unit, basis }: {
  subjects: CapacityAccount[]; histories: ReadonlyMap<string, History>; reading: boolean; colors: ReadonlyMap<string, string>;
  selection: SpeedSelection; inactive: ReadonlySet<string>; onChange: (next: SpeedSelection) => void; unit: CapacityUnit; basis: CapacityBasis;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggleOpen = (id: string) => setOpen(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const providers = [...new Set(subjects.map(subject => subject.provider))].map(provider => ({ provider, group: subjects.filter(subject => subject.provider === provider) }));
  const cyclesOf = (id: string) => accountCycles(histories.get(id)?.results ?? []);
  const actions = (ids: string[], name: string) => <span className="speed-drawer-actions">
    <button type="button" aria-label={t("Select all · {0}", `Zaznacz wszystkie · ${name}`, [name])}
      onClick={() => onChange(setAccounts(selection, ids, true, inactive))}>{t("select all", "zaznacz wszystkie")}</button>
    <button type="button" aria-label={t("Clear · {0}", `Wyczyść · ${name}`, [name])}
      onClick={() => onChange(setAccounts(selection, ids, false, inactive))}>{t("clear", "wyczyść")}</button>
  </span>;
  const leaveOutSmall = () => onChange(subjects.reduce((next, subject) => leaveOutCycles(next, subject.id,
    cyclesOf(subject.id).filter(window => window.observed_pp < SMALL_SAMPLE_PP).map(window => window.id)), selection));
  return <div className="speed-drawer-list capacity-choice-list">
    <div className="speed-drawer-global"><span>{t("All subscriptions", "Wszystkie abonamenty")}</span>{actions(subjects.map(subject => subject.id), t("all subscriptions", "wszystkie abonamenty"))}</div>
    <div className="speed-drawer-global"><span>{t("Cycles with a sample under {0} pp", `Cykle z próbką poniżej ${SMALL_SAMPLE_PP} p.p.`, [SMALL_SAMPLE_PP])}</span>
      <span className="speed-drawer-actions"><button type="button" onClick={leaveOutSmall}>{t("leave out", "pomiń")}</button></span></div>
    <div className="capacity-legend capacity-choice-legend">
      <span>{capacityUnitLabel(unit, t)} · {basis === "regular" ? t("without promotions", "bez promocji") : t("observed capacity", "zaobserwowana pojemność")}</span>
      <span><b className="capacity-tier-chip is-tier-1">×1</b><b className="capacity-tier-chip is-tier-5">×5</b><b className="capacity-tier-chip is-tier-20">×20</b>
        <b className="capacity-tier-chip" title={t("No usage tier on record", "Brak zapisanego wariantu zużycia")}>{t("no tier", "bez wariantu")}</b></span>
    </div>
    {providers.map(({ provider, group }) => {
      const name = providerName(provider);
      return <section key={provider} className="speed-drawer-provider" aria-label={name}>
        <h3><span className="capacity-subject"><i className="capacity-swatch" style={{ background: vendorColor(provider) ?? "var(--accent)" }} />{name}</span>{actions(group.map(subject => subject.id), name)}</h3>
        {group.map(subject => {
          const history = histories.get(subject.id);
          const cycles = cyclesOf(subject.id);
          const ids = cycles.map(window => window.id);
          const picked = ids.filter(id => modelSelected(selection, subject.id, id, inactive)).length;
          const error = history?.results.find(result => result.error)?.error;
          const expandable = cycles.length > 0;
          const expanded = expandable && open.has(subject.id);
          return <div key={subject.id} className={`speed-drawer-sub${error ? " is-failed" : ""}${expanded ? " is-open" : ""}`}>
            <button type="button" className="capacity-choice-sub" aria-expanded={expandable ? expanded : undefined} disabled={!expandable}
              onClick={() => toggleOpen(subject.id)} aria-label={`${name} · ${subject.label}`}>
              <span className="capacity-choice-caret" aria-hidden="true">{expandable ? (expanded ? "▾" : "▸") : ""}</span>
              <i className="capacity-swatch" style={{ background: colors.get(subject.id) }} />
              <span className="speed-drawer-name">{subject.label}{!subject.active && <span className="speed-drawer-inactive"> · {t("inactive", "nieaktywny")}</span>}</span>
              <span className="speed-drawer-facts">{error ? t("could not be read", "nie udało się odczytać")
                : !history ? (reading ? t("loading…", "wczytywanie…") : t("waiting…", "w kolejce…"))
                : history.stale ? t("being prepared on the server…", "serwer przygotowuje…")
                : !cycles.length ? t("no cycles", "brak cykli")
                : <>{t("{0} cycles", `${cycles.length} cykli`, [cycles.length])}{picked > 0 && <b className="capacity-choice-picked"> · {t("{0} chosen", `wybrane ${picked}`, [picked])}</b>}</>}</span>
            </button>
            {error && <div className="speed-drawer-error">{browserSafeDiagnostic(error)}</div>}
            {expanded && <CycleTable subject={subject} cycles={cycles} unit={unit} basis={basis}
              checked={id => modelSelected(selection, subject.id, id, inactive)} onToggle={id => onChange(toggleModel(selection, subject.id, id, ids, inactive))} />}
          </div>;
        })}
      </section>;
    })}
  </div>;
}

/**
 * The cycles of one subscription, newest first: the period, the plan in its tier colour, the sample and the value of 100%
 * in the screen's unit and capacity basis; the meter and the value of 1% are in the row's tooltip. A cycle that cannot
 * carry an estimate (sample under SMALL_SAMPLE_PP, or none) is drawn in faint ink; its reason is in the tooltip.
 */
export function CycleTable({ subject, cycles, unit, basis, checked, onToggle }: {
  subject: CapacityAccount; cycles: CodexComparisonWindow[]; unit: CapacityUnit; basis: CapacityBasis;
  checked: (id: string) => boolean; onToggle: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const n = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const format = capacityUnitFormat(unit, locale);
  // Only Codex bills in credits.
  const noCredits = unit === "credits_low" && subject.provider !== "codex";
  return <DataTable tableId="GlobalCapacity:0" className="capacity-choice-table">
    <thead><TableRow header>
      <th data-column-id="c0" aria-label={t("Chosen", "Wybrany")} />
      <th data-column-id="c1">{t("Cycle", "Cykl")}</th><th data-column-id="c2">{t("Plan", "Plan")}</th>
      <th data-column-id="c3" className="is-num">{t("Sample", "Próbka")}</th><th data-column-id="c4" className="is-num">100%</th>
    </TableRow></thead>
    <tbody>{[...cycles].reverse().map(window => {
      const on = checked(window.id);
      const full = noCredits ? null : capacityFull(window, unit, basis);
      const mark = capacityIsLowerBound(window, unit) ? "≥" : "≈";
      const missing = noCredits ? t("n/a", "nie dotyczy") : full !== null ? null
        : window.observed_pp <= 1 ? t("sample too small", "za mała próbka") : capacityMissingReason(window, basis) ?? t("No estimate", "Brak szacunku");
      const floor = full === null && !noCredits ? capacityLocalLowerBound(window, unit) : null;
      const tier = capacityPlanEstablished(window) ? window.plan_detail?.multiplier : null;
      const small = window.observed_pp < SMALL_SAMPLE_PP;
      const period = capacityPeriodLabel(window, locale);
      const facts = [t("Meter {0} → {1}%", `Licznik ${n(window.start_percent)} → ${n(window.end_percent)}%`, [n(window.start_percent), n(window.end_percent)]),
        full !== null ? `1% = ${format.per(full / 100)}` : missing,
        floor !== null ? t("Local traffic ÷ meter increase; other products may have used part of the meter, so the capacity is at least this.",
          "Ruch lokalny ÷ przyrost licznika; inne produkty mogły zużyć część licznika, więc pojemność jest co najmniej taka.") : null,
        small ? t("Sample under {0} pp: the 100% value extrapolates far", `Próbka poniżej ${SMALL_SAMPLE_PP} p.p.: wartość 100% to daleka ekstrapolacja`, [SMALL_SAMPLE_PP]) : null];
      return <TableRow key={window.id} className={[on ? "" : "is-off", full === null || small ? "is-weak" : ""].filter(Boolean).join(" ") || undefined}
        title={facts.filter(Boolean).join("\n")} onClick={event => {
          if ((event.target as Element).closest?.("button, input")) return;
          onToggle(window.id);
        }}>
        <td><button type="button" className="codex-column-option__switch" role="switch" aria-checked={on}
          aria-label={`${subject.label} · ${period}`} onClick={event => { event.stopPropagation(); onToggle(window.id); }}><span /></button></td>
        <td>{period}</td>
        <td><span className={`capacity-tier-chip${tier === 1 || tier === 5 || tier === 20 ? ` is-tier-${tier}` : ""}`}>{capacityPlanLabel(window)}</span></td>
        <td className="is-num">{n(window.observed_pp)} {t("pp", "p.p.")}</td>
        <td className="is-num">{full !== null ? <b>{mark} {format.full(full)}</b> : floor !== null ? `≥ ${format.full(floor)}` : <span className="ui-missing">{missing}</span>}</td>
      </TableRow>;
    })}</tbody>
  </DataTable>;
}
