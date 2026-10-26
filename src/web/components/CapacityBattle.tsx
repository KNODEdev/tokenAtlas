import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CodexComparisonWindow } from "../../shared/codex-accounting";
import { capacityWithContext } from "../lib/capacity-context";
import { useContextPreview } from "../lib/context-premium";
import type { CapacityBasis } from "../../shared/codex-promotions";
import { formatPlanLabel } from "../../shared/plan-label";
import type { ApiAccount } from "../lib/api";
import { refreshApiData } from "../lib/api";
import { browserSafeDiagnostic } from "../lib/browserDiagnostic";
import type { RosterCard } from "../lib/roster";
import { useI18n } from "../lib/i18n";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../shared/time-range-presets";
import { useRecordedRange } from "../lib/recorded-range";
import { capacityAccounts, type CapacityAccount } from "../lib/global-capacity";
import { capacityFull, capacityIsLowerBound, capacityLocalLowerBound, capacityMissingReason, capacityPeriodLabel, capacityUnitFormat, type CapacityUnit } from "../lib/codex-capacity";
import { claudeShareNeverReported } from "../../shared/claude-code-capacity";
import { accountCycles, comparableAccounts, providerName } from "../lib/capacity-compare";
import { BATTLE_PROVIDERS, battleRows, cycleTier, deriveSources, EMPTY_PICK, planKey, readBattlePicks, writeBattlePicks,
  type BattleCell, type BattlePicks, type BattleProvider, type BattleRow, type PlanPick } from "../lib/capacity-battle";
import { vendorColor } from "../lib/model-colors";
import { visibleReportFreshness } from "../lib/report-freshness";
import { DataTable, TableRow, Card, EmptyState, ErrorState, Field, HelpDot, LoadingCard, Selector, Tabs } from "./ui";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { capacityUnitLabel } from "./CapacityCycleList";
import { TriStateCheck } from "./TriStateCheck";
import { useCapacityHistories } from "./GlobalCapacity";
import "./CodexCapacitySummary.css";
import "./SubscriptionChoice.css";
import "./GlobalCapacity.css";
import "./CapacityBattle.css";

/** Samples under this many percentage points extrapolate far; they can be attached but are drawn faint. */
const SMALL_SAMPLE_PP = 20;

/**
 * Codex and Claude plans tier by tier. Each plan shows only the cycles attached to it in its drawer (none at first);
 * a plan without attached cycles can be derived from another plan of the same provider on request.
 */
export function CapacityBattle({ accounts, cards, dataRevision }: { accounts: ApiAccount[]; cards: RosterCard[]; dataRevision?: number }) {
  const { t, locale } = useI18n();
  const [days, setDays] = useState(360);
  const [minutes, setMinutes] = useState<300 | 10080 | 43200>(10080);
  const [basis, setBasis] = useState<CapacityBasis>("observed");
  const [unit, setUnit] = useState<CapacityUnit>("api_standard");
  const [picks, setPicks] = useState<BattlePicks>(() => readBattlePicks());
  const [drawer, setDrawer] = useState<{ provider: BattleProvider; tier: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const subjects = useMemo(() => comparableAccounts(capacityAccounts(accounts, cards))
    .filter(subject => (BATTLE_PROVIDERS as readonly string[]).includes(subject.provider)), [accounts, cards]);
  const today = new Date().toISOString().slice(0, 10);
  const whole = useRecordedRange(days === 0);
  const until = days === 0 ? whole.data?.until ?? today : today;
  const since = days === 0 ? whole.data?.since ?? today : new Date(Date.parse(today) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const { histories, reading, staleAt } = useCapacityHistories(subjects, since, until, minutes, dataRevision, whole.ready);
  const freshnessId = useId();
  useEffect(() => { visibleReportFreshness(freshnessId, staleAt); return () => visibleReportFreshness(freshnessId, null); }, [freshnessId, staleAt]);

  const contextPreview = useContextPreview();
  const cycles = subjects.flatMap(subject => accountCycles(histories.get(subject.id)?.results ?? []).map(window => ({ subject,
    window: contextPreview && subject.provider === "codex" ? capacityWithContext(window, true).window : window })));
  const byId = new Map(cycles.map(item => [item.window.id, item.window]));
  const counter = String(minutes);
  const own = picks[counter] ?? {};
  const rows = battleRows(byId, own, unit, basis, minutes);
  const setPick = (provider: BattleProvider, tier: number, change: (pick: PlanPick) => PlanPick) => {
    const key = planKey(provider, tier);
    const next = { ...picks, [counter]: { ...own, [key]: change(own[key] ?? EMPTY_PICK) } };
    setPicks(next);
    writeBattlePicks(next);
  };
  const openDrawer = (provider: BattleProvider, tier: number) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawer({ provider, tier });
  };
  const format = capacityUnitFormat(unit, locale);
  const top = Math.max(0, ...rows.flatMap(row => BATTLE_PROVIDERS.map(provider => row.cells[provider]?.value ?? 0)));
  const showRatio = unit === "api_standard" && minutes === 10080;
  const drawerCell = drawer ? rows.find(row => row.tier === drawer.tier)?.cells[drawer.provider] ?? null : null;
  const drawerResults = drawer ? subjects.filter(subject => subject.provider === drawer.provider)
    .flatMap(subject => histories.get(subject.id)?.results ?? []) : [];
  const drawerErrors = [...new Set(drawerResults.flatMap(result => result.error ? [result.error] : []))];
  const preparing = [...histories.values()].some(history => history.results.some(result => result.preparing));

  return <section className="global-capacity capacity-battle"><Card pad="0" style={{ overflow: "hidden" }}>
    <header className="global-capacity-head">
      <h2>{t("Capacity battle", "Bitwa pojemności")}</h2>
      <p>{t("Codex and Claude plans tier by tier · each plan shows the cycles you attach to it", "Plany Codex i Claude wariant po wariancie · każdy plan pokazuje cykle, które do niego podepniesz")}</p>
    </header>
    <div className="ui-toolbar global-capacity-controls">
      <Field label={t("History", "Historia")}><Selector ariaLabel={t("History", "Historia")} value={String(days)} onChange={value => setDays(Number(value))}
        options={[...TIME_RANGE_DAYS.map(value => ({ value: String(value), label: timeRangeLabel(value, t) })), { value: "0", label: t("All", "Całość") }]} /></Field>
      <Field label={t("Counter", "Licznik")}><Selector ariaLabel={t("Counter", "Licznik")} value={counter} onChange={value => setMinutes(Number(value) as 300 | 10080 | 43200)} options={[
        { value: "10080", label: t("Weekly", "Tygodniowy") }, { value: "300", label: "5h" }, { value: "43200", label: t("30 days", "30 dni") },
      ]} /></Field>
      <Field label={t("Capacity basis", "Pojemność")}><Selector ariaLabel={t("Capacity basis", "Pojemność")} value={basis} onChange={value => setBasis(value as CapacityBasis)} options={[
        { value: "observed", label: t("Observed capacity", "Zaobserwowana pojemność") }, { value: "regular", label: t("Without promotions", "Bez promocji") },
      ]} /></Field>
      <Field label={t("Unit", "Jednostka")}><Tabs value={unit === "credits_low" ? "api_standard" : unit} onChange={setUnit}
        options={(["api_standard", "tokens"] as const).map(value => ({ value, label: capacityUnitLabel(value, t) }))} /></Field>
      <HelpDot label={t("How the battle is counted", "Jak liczymy bitwę")}>{t(
        "A plan's value is the median capacity of a full window over the cycles attached to it (one cycle shows that cycle). Attached cycles are kept per counter. A plan without attached cycles stays empty unless you choose “derive from”: then it takes another plan of the same provider, divided by that plan's tier and multiplied by its own (≈); providers do not promise that tiers scale exactly. The price is the catalog list price. “API $ per $1” is the weekly window × weeks in a month ÷ the monthly price.",
        "Wartość planu to mediana pojemności pełnego okna z podpiętych cykli (jeden cykl pokazuje ten cykl). Podpięte cykle są zapamiętane osobno dla każdego licznika. Plan bez podpiętych cykli zostaje pusty, chyba że wybierzesz „przelicz od”: wtedy bierze inny plan tego samego dostawcy, dzieli przez jego wariant i mnoży przez swój (≈); dostawcy nie obiecują, że warianty skalują się dokładnie. Cena to cena katalogowa. „$ API za 1 $” to okno tygodniowe × liczba tygodni w miesiącu ÷ cena miesięczna.")}</HelpDot>
    </div>
    {whole.error && <ErrorState message={whole.error} onRetry={whole.reload} />}
    {!whole.ready && !whole.error && <LoadingCard />}
    {(reading || preparing) && <p role="status" className="global-capacity-status">{preparing
      ? t("Preparing cycles…", "Przygotowywanie cykli…") : t("Loading cycles…", "Wczytywanie cykli…")}</p>}
    <div className="global-capacity-body">
      {!subjects.length ? <EmptyState title={t("No Codex or Claude subscription", "Brak abonamentu Codex lub Claude")}
        detail={t("The battle compares Codex and Claude plans.", "Bitwa porównuje plany Codex i Claude.")} />
        : <DataTable tableId="CapacityBattle:0" className="capacity-battle-table">
          <thead><TableRow header>
            <th data-column-id="c0">{t("Tier", "Wariant")}</th>
            {BATTLE_PROVIDERS.map(provider => <th data-column-id={`provider:${provider}`} key={provider}><span className="capacity-subject"><i className="capacity-swatch" style={{ background: vendorColor(provider) ?? "var(--accent)" }} />{providerName(provider)}</span></th>)}
            <th data-column-id="c2">{t("Lead", "Przewaga")} · {capacityUnitLabel(unit, t)}</th>
          </TableRow></thead>
          <tbody>{rows.map(row => <TableRow key={row.tier}>
            <th scope="row"><span className={`capacity-tier-chip${row.tier === 1 || row.tier === 5 || row.tier === 20 ? ` is-tier-${row.tier}` : ""}`}>×{row.tier}</span></th>
            {BATTLE_PROVIDERS.map(provider => <td key={provider}>{row.cells[provider]
              ? <PlanCell cell={row.cells[provider]!} sources={deriveSources(rows, provider, row.tier)} format={format} showRatio={showRatio}
                onAttach={() => openDrawer(provider, row.tier)} onDerive={from => setPick(provider, row.tier, pick => ({ ...pick, from }))} />
              : <span className="capacity-battle-none">{t("no such plan", "brak takiego planu")}</span>}</td>)}
            <td><Lead row={row} top={top} /></td>
          </TableRow>)}</tbody>
        </DataTable>}
    </div>
    {drawer && <AccountPeriodDrawer busy={false} onClose={() => setDrawer(null)} returnFocus={opener.current} className="capacity-compare-drawer"
      closeLabel={t("Close the cycle choice", "Zamknij wybór cykli")}
      title={`${t("Attach cycles", "Podepnij cykle")} · ${providerName(drawer.provider)} ${formatPlanLabel(drawerCell?.label ?? "", drawer.tier)}`}
      subtitle={t("{0} counter · {1} – {2} UTC", `Licznik ${minutes === 10080 ? "tygodniowy" : "5h"} · ${since} – ${until} UTC`, [minutes === 10080 ? t("Weekly", "tygodniowy") : "5h", since, until])}>
      <AttachList subjects={subjects.filter(subject => subject.provider === drawer.provider)} cycles={cycles.filter(item => item.subject.provider === drawer.provider)}
        tier={drawer.tier} reading={reading} unit={unit} basis={basis} chosen={new Set((own[planKey(drawer.provider, drawer.tier)] ?? EMPTY_PICK).cycles)}
        preparing={drawerResults.some(result => result.preparing)} errors={drawerErrors} onRetry={refreshApiData}
        onChange={ids => setPick(drawer.provider, drawer.tier, pick => ({ ...pick, cycles: ids }))} />
    </AccountPeriodDrawer>}
  </Card></section>;
}

/** One plan of one provider: price, value, value per $ of the price, and how the value came about. */
export function PlanCell({ cell, sources, format, showRatio, onAttach, onDerive }: {
  cell: BattleCell; sources: number[]; format: ReturnType<typeof capacityUnitFormat>; showRatio: boolean;
  onAttach: () => void; onDerive: (from: number | null) => void;
}) {
  const { t, locale } = useI18n();
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const ratio = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const derived = cell.source === "derived";
  const mark = derived ? "≈ " : "";
  return <div className={`capacity-battle-plan${derived ? " is-derived" : ""}`}>
    <div className="capacity-battle-plan-head"><b>{formatPlanLabel(cell.label, cell.tier)}</b><span>{cell.usdPerMonth === null ? <span className="ui-missing">{t("no price", "brak ceny")}</span> : `${usd.format(cell.usdPerMonth)} / ${t("mo", "mies.")}`}</span></div>
    <div className="capacity-battle-value">{cell.value === null ? <span className="ui-missing">{t("no estimate", "brak szacunku")}</span> : `${mark}${format.full(cell.value)}`}
      {showRatio && cell.perDollar !== null && <span>{mark}{ratio.format(cell.perDollar)}× {t("per $1", "za 1 $")}</span>}</div>
    <div className="capacity-battle-meta">
      {cell.source === "attached" ? <span>{cell.counted === 1 ? t("1 cycle", "1 cykl") : t("median of {0} cycles", `mediana z ${cell.counted} cykli`, [cell.counted])}
        {cell.attached.length > cell.counted && ` · ${t("{0} without an estimate", `${cell.attached.length - cell.counted} bez szacunku`, [cell.attached.length - cell.counted])}`}</span>
        : derived ? <span>{t("derived from ×{0}", `przeliczone od ×${cell.from}`, [cell.from])}</span>
        : <span>{cell.attached.length ? t("attached cycles have no estimate", "podpięte cykle nie mają szacunku") : t("nothing attached", "nic nie podpięto")}</span>}
      <span className="speed-drawer-actions">
        <button type="button" onClick={onAttach}>{cell.attached.length ? t("attached · {0}", `podpięte · ${cell.attached.length}`, [cell.attached.length]) : t("attach", "podepnij")}</button>
        {cell.source !== "attached" && (sources.length > 0 || cell.from !== null) && <Selector ariaLabel={t("Derive from", "Przelicz od")}
          value={cell.from === null ? "" : String(cell.from)} onChange={value => onDerive(value ? Number(value) : null)}
          options={[{ value: "", label: t("derive from…", "przelicz od…") }, ...sources.map(tier => ({ value: String(tier), label: `×${tier}` }))]} />}
      </span>
    </div>
  </div>;
}

/** Both values on one scale and the winner's lead. */
function Lead({ row, top }: { row: BattleRow; top: number }) {
  const { t } = useI18n();
  return <div className="capacity-battle-lead">
    {BATTLE_PROVIDERS.map(provider => {
      const cell = row.cells[provider];
      const value = cell?.value ?? null;
      return <div key={provider} className={`capacity-battle-bar${cell?.source === "derived" ? " is-derived" : ""}`} aria-hidden="true">
        <i style={{ width: value !== null && top > 0 ? `${value / top * 100}%` : "0", background: vendorColor(provider) ?? "var(--accent)" }} />
      </div>;
    })}
    <span>{row.winner && row.lead !== null ? `${providerName(row.winner)} +${Math.round(row.lead)}%` : t("needs both sides", "potrzebne obie strony")}</span>
  </div>;
}

/** The cycles of one provider and tier, newest first, with their value; attaching is per cycle, plus two shortcuts. */
export function AttachList({ subjects, cycles, tier, reading, preparing = false, errors = [], onRetry, unit, basis, chosen, onChange }: {
  subjects: CapacityAccount[]; cycles: Array<{ subject: CapacityAccount; window: CodexComparisonWindow }>; tier: number; reading: boolean;
  preparing?: boolean; errors?: readonly string[]; onRetry?: () => void;
  unit: CapacityUnit; basis: CapacityBasis; chosen: ReadonlySet<string>; onChange: (ids: string[]) => void;
}) {
  const { t, locale } = useI18n();
  const format = capacityUnitFormat(unit, locale);
  const n = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const matching = cycles.filter(item => cycleTier(item.window) === tier)
    .sort((a, b) => Date.parse(b.window.cycle_start ?? b.window.start) - Date.parse(a.window.cycle_start ?? a.window.start));
  const untiered = cycles.filter(item => cycleTier(item.window) === null).length;
  const solid = matching.filter(item => item.window.observed_pp >= SMALL_SAMPLE_PP && capacityFull(item.window, unit, basis) !== null).map(item => item.window.id);
  const pendingLabel = preparing ? t("Preparing cycles…", "Przygotowywanie cykli…") : t("Loading cycles…", "Wczytywanie cykli…");
  const toggle = (id: string) => onChange(chosen.has(id) ? [...chosen].filter(item => item !== id) : [...chosen, id]);
  return <div className="speed-drawer-list capacity-choice-list">
    <div className="speed-drawer-global"><span role={!matching.length && (reading || preparing) ? "status" : undefined}>{!matching.length && (reading || preparing) ? pendingLabel
      : t("{0} cycles of this tier · {1} attached", `${matching.length} cykli tego wariantu · podpięte ${chosen.size}`, [matching.length, chosen.size])}</span>
      <span className="speed-drawer-actions">
        <button type="button" onClick={() => onChange([...new Set([...chosen, ...solid])])}>{t("attach solid · {0}", `podepnij pewne · ${solid.length}`, [solid.length])}</button>
        <button type="button" onClick={() => onChange([])}>{t("detach all", "odepnij wszystkie")}</button>
      </span></div>
    {errors.map(error => <ErrorState key={error} message={browserSafeDiagnostic(error)} onRetry={onRetry} />)}
    {matching.length > 0 && (reading || preparing) && <p role="status" className="capacity-battle-empty">{pendingLabel}</p>}
    {!matching.length ? !reading && !preparing && !errors.length && <p className="capacity-battle-empty">{t(
      "No cycles of this tier in the range across {0} subscriptions. Try a longer history.", `Brak cykli tego wariantu w zakresie w ${subjects.length} abonamentach. Wybierz dłuższą historię.`, [subjects.length])}</p>
      : <DataTable tableId="CapacityBattle:1" className="capacity-choice-table capacity-battle-attach">
        <thead><TableRow header>
          <th data-column-id="c0" aria-label={t("Attached", "Podpięty")} />
          <th data-column-id="c1">{t("Subscription", "Abonament")}</th><th data-column-id="c2">{t("Cycle", "Cykl")}</th>
          <th data-column-id="c3" className="is-num">{t("Sample", "Próbka")}</th><th data-column-id="c4" className="is-num">100%</th>
        </TableRow></thead>
        <tbody>{matching.map(({ subject, window }) => {
          const on = chosen.has(window.id);
          const full = capacityFull(window, unit, basis);
          const floor = full === null ? capacityLocalLowerBound(window, unit) : null;
          const weak = full === null || window.observed_pp < SMALL_SAMPLE_PP;
          const period = capacityPeriodLabel(window, locale);
          const missing = full === null ? window.observed_pp <= 1 ? t("sample too small", "za mała próbka") : capacityMissingReason(window, basis) ?? t("No estimate", "Brak szacunku") : null;
          const facts = [missing,
            floor !== null ? t("Local traffic ÷ meter increase; other products may have used part of the meter, so the capacity is at least this.",
              "Ruch lokalny ÷ przyrost licznika; inne produkty mogły zużyć część licznika, więc pojemność jest co najmniej taka.") : null,
            full !== null && claudeShareNeverReported(window) ? t("The provider sent no Claude Code share in this cycle: local traffic ÷ meter increase, taken as the whole meter.",
              "Dostawca nie podał w tym cyklu udziału Claude Code: ruch lokalny ÷ przyrost licznika, przyjęty jako cały licznik.") : null,
            full !== null && window.observed_pp < SMALL_SAMPLE_PP ? t("Sample under {0} pp: the 100% value extrapolates far", `Próbka poniżej ${SMALL_SAMPLE_PP} p.p.: wartość 100% to daleka ekstrapolacja`, [SMALL_SAMPLE_PP]) : null];
          return <TableRow key={window.id} className={[on ? "" : "is-off", weak ? "is-weak" : ""].filter(Boolean).join(" ") || undefined}
            title={facts.filter(Boolean).join("\n") || undefined}
            onClick={event => { if (!(event.target as Element).closest?.("input")) toggle(window.id); }}>
            <td><TriStateCheck state={on ? "all" : "none"} label={`${subject.label} · ${period}`} onChange={() => toggle(window.id)} /></td>
            <td className="capacity-battle-account">{subject.label}</td>
            <td>{period}</td>
            <td className="is-num">{n(window.observed_pp)} {t("pp", "p.p.")}</td>
            <td className="is-num">{full !== null ? <b>{capacityIsLowerBound(window, unit) ? "≥" : "≈"} {format.full(full)}</b> : floor !== null ? `≥ ${format.full(floor)}` : <span className="ui-missing">{missing}</span>}</td>
          </TableRow>;
        })}</tbody>
      </DataTable>}
    {untiered > 0 && <p className="capacity-battle-empty">{t("{0} cycles without a confirmed tier are not listed.", `${untiered} cykli bez ustalonego wariantu nie jest pokazanych.`, [untiered])}</p>}
  </div>;
}
