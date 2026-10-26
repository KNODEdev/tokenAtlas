import { calendarDateLabels } from "../lib/chart-dates";
import { useState, type ReactNode } from "react";
import type { ScreenProps } from "../lib/screens";
import type { CycleView } from "../lib/cycle";
import { Card, Dropdown, EmptyState, HelpDot } from "../components/ui";
import { Kpi, KpiRow, Track, unit } from "../components/WindowStatusCard";
import { ResultBar, WindowBarChart, type WindowBar } from "../components/WindowBarChart";
import { CycleHistoryTable } from "../components/CycleHistoryTable";
import { EARLY_RESET_SHARE, WINDOW_RESULTS, windowResult, windowResultColor, windowResultLabel, type WindowResult } from "../lib/window-archive";
import { compact, dayTime, duration, pct, usd } from "../lib/format";
import { useI18n } from "../lib/i18n";
import "./History.css";
type Range = "10" | "30" | "all";
const TABLE_ROWS = 10;
/**
 * The whole cycle archive (docs/design/audit-history-compare-mockup.html, History · Codex): four
 * tiles, one bar per window and the Overview's window table, folded to the newest ten.
 */
function CycleArchive(props: ScreenProps) {
  const { model, openDrawer, selectCycle, account } = props;
  const { t, locale } = useI18n();
  const [range, setRange] = useState<Range>("all");
  const [filter, setFilter] = useState<WindowResult | null>(null);
  const [modelFilter, setModelFilter] = useState("all");
  const [showAll, setShowAll] = useState(false);
  const cycles = model.cycles;
  if (cycles.length === 0) {
    return (
      <EmptyState
        title={t("No registered cycles", "Brak zarejestrowanych cykli")}
        detail={t("No cycle history was found for the selected window and account. Change the account or sync the index.", "W wybranym oknie i koncie nie znaleziono żadnych danych historycznych cykli. Zmień konto albo zsynchronizuj indeks.")}
      />
    );
  }
  const resultOf = (c: CycleView) => windowResult(c.usedPercent, c.isActive, c.elapsedHours, c.windowHours);
  const count = (result: WindowResult) => cycles.filter((c) => resultOf(c) === result).length;
  const oldest = cycles.at(-1)!;
  const windowHours = cycles[0]!.windowHours;
  const median = model.median.peakPercent;
  const lastClosed = model.closed.slice(0, 10);
  const exhausted = count("exhausted");
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const dollars = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const since = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(oldest.startIso));
  const resultParts = WINDOW_RESULTS.map((result) => ({ key: result, count: count(result), color: windowResultColor(result), title: `${windowResultLabel(result)} ${count(result)}` }));
  const series = (range === "all" ? cycles : cycles.slice(0, Number(range))).slice().reverse();
  const models = [...new Set(cycles.map((c) => c.topModel).filter((m): m is string => m != null))].sort();
  const rows = cycles.filter((c) => (filter == null || resultOf(c) === filter) && (modelFilter === "all" || c.topModel === modelFilter));
  const shown = showAll ? rows : rows.slice(0, TABLE_ROWS);
  const bars: WindowBar[] = series.map((c) => ({
    key: String(c.index),
    percent: c.usedPercent,
    color: windowResultColor(resultOf(c)),
    current: c.isActive,
    band: c.topModel,
    lane: Math.min(c.windowHours, c.elapsedHours),
    laneColor: c.elapsedHours < c.windowHours * EARLY_RESET_SHARE ? "var(--line2)" : "var(--muted)",
    title: `#${whole.format(c.number)} · ${c.startIso} · ${pct(c.usedPercent)} · ${t("lasted", "trwało")} ${duration(c.elapsedHours)} · ${compact(c.tokensTotal)} ${t("tokens", "tokenów")} · ${usd(c.usd)} · ${c.topModel ?? "—"}`,
  }));
  const newest = series.at(-1)!;
  const dateLabels = calendarDateLabels(series.map(row => row.startIso), locale);
  const closedExhausted = lastClosed.filter((c) => c.usedPercent >= 100).length;
  const tokens = compact(cycles.reduce((sum, c) => sum + c.tokensTotal, 0));
  return (
    <div className="archive ui-tab-page">
      <KpiRow columns={4}>
        <Kpi label={t("Windows", "Okna")} value={whole.format(cycles.length)} visual={<ResultBar parts={resultParts} />}
          caption={t("since {0} · each up to {1}", `od ${since} · każde do ${duration(windowHours)}`, [since, duration(windowHours)])} />
        <Kpi label={t("Typical end", "Typowy koniec")} value={median == null ? "—" : <>{whole.format(median)}{unit("%")}</>}
          visual={median == null ? null : <Track fill={median} tick={100} color="var(--violet)" />}
          caption={t("median of the last {0} closed windows", `mediana ${model.typical.length} ostatnich zamkniętych okien`, [model.typical.length])} />
        <Kpi label={t("Exhausted", "Wyczerpane")} color={exhausted > 0 ? "var(--crit)" : undefined}
          value={<>{whole.format(exhausted)}{unit(` ${t("of", "z")} ${whole.format(cycles.length)}`)}</>}
          visual={<ResultBar parts={lastClosed.slice().reverse().map((c) => ({ key: String(c.index), count: 1, color: c.usedPercent >= 100 ? "var(--crit)" : "var(--line)", title: `#${whole.format(c.number)} · ${pct(c.usedPercent)}` }))} />}
          caption={t("in the last {0}: {1} · one definition: ≥ 100%", `w ${lastClosed.length} ostatnich: ${closedExhausted} · jedna definicja: ≥ 100%`, [lastClosed.length, closedExhausted])} />
        <Kpi label={t("API-eq total", "API-eq razem")} value={dollars.format(cycles.reduce((sum, c) => sum + c.usd, 0))} visual={null}
          caption={t("{0} tokens · at API rates, not a bill", `${tokens} tokenów · po cenniku API, nie rachunek`, [tokens])} />
      </KpiRow>
      <Card>
        <div className="archive-head">
          <div><b>{t("Each window", "Każde okno")}</b> <HelpDot label={t("Each window", "Każde okno")}>{t("Bar: usage at the end; under it the duration out of {0}; band on top: the main model.", `Słupek: zużycie na końcu; pod nim czas trwania z ${duration(windowHours)}; pasek u góry: główny model.`, [duration(windowHours)])}</HelpDot></div>
          <div className="ui-tabs" role="group" aria-label={t("Windows shown", "Pokazane okna")}>
            {([["10", "10"], ["30", "30"], ["all", t("all", "wszystkie")]] as const).map(([value, label]) => (
              <button key={value} type="button" className="ui-tab" aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>
            ))}
          </div>
        </div>
        <WindowBarChart bars={bars} median={median == null ? null : { value: median, label: `${t("typically", "typowo")} ${whole.format(median)}%` }}
          laneMax={windowHours} laneLabel={t("time", "czas")} laneNote={`│ ${duration(windowHours)}`}
          endLabel={newest.isActive ? {
            candidates: [`#${whole.format(newest.number)} · ${pct(newest.usedPercent)} · ${t("in progress", "trwa")}`, `#${whole.format(newest.number)} · ${pct(newest.usedPercent)}`, pct(newest.usedPercent)],
            color: "var(--accent)",
          } : null}
          tick={(_, i) => dateLabels[i] ?? null}
          onSelect={(bar) => openDrawer(Number(bar.key))} />
        <div className="archive-legend">
          {WINDOW_RESULTS.map((result) => <span key={result}><i style={{ background: windowResultColor(result) }} />{windowResultLabel(result)}</span>)}
          <span><i className="archive-legend-line" />{t("typical end", "typowy koniec")}</span>
          <span>{t("click a bar = window panel", "klik w słupek = panel okna")}</span>
        </div>
      </Card>
      <Card>
        <div className="archive-head">
          <div><b>{t("Window table", "Tabela okien")}</b> <HelpDot label={t("Window table", "Tabela okien")}>{t("Newest at the top. Click opens the window panel, double-click the Overview.", "Najnowsze u góry. Klik otwiera panel okna, dwuklik Przegląd.")}</HelpDot></div>
          <div className="archive-chips">
            {WINDOW_RESULTS.map((result) => (
              <button key={result} type="button" className="archive-chip" aria-pressed={filter === result} disabled={count(result) === 0}
                onClick={() => { setFilter(filter === result ? null : result); setShowAll(false); }}>
                <i style={{ background: windowResultColor(result) }} />{windowResultLabel(result)} {count(result)}
              </button>
            ))}
            <label className="archive-chip">
              {t("model", "model")}:
              <Dropdown className="" value={modelFilter} onChange={(value) => { setModelFilter(value); setShowAll(false); }}
                options={[{ value: "all", label: t("all", "wszystkie") }, ...models.map((m) => ({ value: m, label: m }))]} />
            </label>
          </div>
        </div>
        {rows.length === 0
          ? <div className="archive-empty" style={{ marginTop: 10 }}>{t("No window matches the selected result and model.", "Żadne okno nie pasuje do wybranego wyniku i modelu.")}</div>
          : <CycleHistoryTable cycles={shown} selectedIndex={model.current?.index ?? null} medianPercent={median} onOpen={openDrawer} onDetails={selectCycle} />}
        {rows.length > TABLE_ROWS && (
          <button type="button" className="archive-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? t("fold to {0} ▴", `zwiń do ${TABLE_ROWS} ▴`, [TABLE_ROWS]) : t("show all {0} ▾", `pokaż wszystkie ${rows.length} ▾`, [rows.length])}
          </button>
        )}
        <div className="archive-note">
          {account} · {t("allowance is inferred from the gauge, not returned by the API", "allowance jest inferowany z gauge, nie zwracany przez API")}
        </div>
      </Card>
    </div>
  );
}
export function History(props: ScreenProps & { windowsView?: ReactNode }) {
  // Accounts without a cycle series (Claude) open on their limit windows, never on an empty cycle list.
  // Events of a window open from its panel in Usage events (UI audit decision 2).
  return props.model.cycles.length === 0 && props.windowsView != null ? <>{props.windowsView}</> : <CycleArchive {...props} />;
}
