import { calendarDateLabels } from "../lib/chart-dates";
import { useMemo, useState } from "react";
import type { RailWindow } from "../lib/windows";
import { buildWindowInsights } from "../lib/window-insights";
import { windowCounters, windowPlanKey, windowPlanLabel } from "../lib/window-archive";
import { compact, dayMonth, dayTime, duration, pct, usd } from "../lib/format";
import { historyEventsTarget, type EventsTarget } from "../lib/events-filter";
import { useI18n } from "../lib/i18n";
import { AccountSplitTable } from "../components/AccountSplitTable";
import { RailWindowTable } from "../components/RailWindowTable";
import { ResultBar, WindowBarChart, type WindowBar } from "../components/WindowBarChart";
import { Kpi, KpiRow, Track, unit } from "../components/WindowStatusCard";
import { OUTSIDE_CODE_PRODUCT_KEY } from "../../shared/claude-code-capacity";
import { Card, EmptyState, Eyebrow, Tabs, HelpDot } from "../components/ui";
import "./History.css";

const TABLE_ROWS = 10;
const MEASURED = "color-mix(in srgb, var(--accent) 70%, var(--surface))";

/** A closed window whose newest reading came before its end: the bar is its last known value. */
function endedUnread(window: RailWindow): boolean {
  if (window.isCurrent || window.percentBasis !== "measured") return false;
  const last = Math.max(...(window.shape ?? []).map((point) => point.t));
  return Number.isFinite(last) && last < 99.5;
}

/**
 * Limit windows of vendors without a cycle series (docs/design/audit-history-compare-mockup.html,
 * History · Claude): one tab per meter, four tiles, one bar per window and the Overview's table.
 */
export function WindowHistory({
  windows,
  account,
  activeKey,
  onSelect,
  onEvents,
}: {
  windows: RailWindow[];
  account: string;
  activeKey: string | null;
  onSelect: (window: RailWindow) => void;
  /** Opens Usage events for the selected window (UI audit decision 2). */
  onEvents?: (target: EventsTarget) => void;
}) {
  const { t, locale } = useI18n();
  const counters = useMemo(() => windowCounters(windows, "longest"), [windows]);
  const [counterKey, setCounterKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const active = counters.find((counter) => counter.key === counterKey) ?? counters[0] ?? null;
  if (!active) {
    return (
      <EmptyState
        title={`${account} ${t("has no windows yet", "nie ma jeszcze żadnego okna")}`}
        detail={t(
          "The probe has recorded no reading and the cadence in cycles.json cannot reconstruct the boundaries. History will appear after the first reading or after adding a reset anchor in Settings → Accounts → Window rhythm.",
          "Ani probe nie zapisał odczytu, ani rytm w cycles.json nie pozwala odtworzyć granic. Historia pojawi się po pierwszym odczycie albo po wpisaniu kotwicy resetu w Ustawienia → Konta → Rytm okien.",
        )}
      />
    );
  }
  const rows = active.rows;
  const hours = active.windowHours;
  const session = hours != null && hours < 24;
  const provider = rows[0]?.counterKey?.split(":")[0] ?? "";
  const planOf = (window: RailWindow) => windowPlanLabel(provider, windowPlanKey(window), window.startIso?.slice(0, 10));
  const current = rows.find((row) => row.isCurrent && row.usedPercent != null) ?? null;
  const insight = current ? buildWindowInsights(rows).find((item) => !item.isSublimit && item.current.windowKey === current.key) ?? null : null;
  const measured = rows.filter((row) => row.percentBasis === "measured");
  const closedPercents = rows.filter((row) => !row.isCurrent && row.usedPercent != null && row.percentBasis === "measured");
  const highest = closedPercents.reduce<RailWindow | null>((top, row) => top == null || row.usedPercent! > top.usedPercent! ? row : top, null);
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const dollars = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const oldest = rows.at(-1);
  const since = oldest?.startIso ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(oldest.startIso)) : "—";
  const usdRows = rows.filter((row) => row.usd != null);
  const percentWithoutUsd = rows.some((row) => row.usedPercent != null && row.usd == null);
  const typicalEnd = insight?.typicalEndPercent ?? null;
  const tokenMax = Math.max(0, ...rows.map((row) => row.tokensTotal ?? 0));
  const series = rows.slice().reverse();
  const dateLabels = calendarDateLabels(series.map(row => row.startIso), locale);
  const bars: WindowBar[] = series.map((row) => {
    const sub = active.isSublimit ? null : row.sublimits[0] ?? null;
    return {
      key: row.key,
      percent: row.usedPercent,
      color: row.isCurrent ? "var(--accent)" : row.percentBasis === "measured" ? MEASURED : "var(--muted)",
      current: row.isCurrent,
      dim: endedUnread(row),
      sub: sub?.usedPercent ?? null,
      ...(session ? {} : { band: planOf(row) }),
      lane: row.tokensTotal,
      title: [
        `${row.startIso ?? "—"} → ${row.resetIso ?? "—"}`,
        row.usedPercent == null ? t("no %", "brak %") : `${row.percentBasis === "measured" ? "" : "≈"}${pct(row.usedPercent)}`,
        ...(sub ? [`${sub.label} ${pct(sub.usedPercent)}`] : []),
        row.tokensTotal == null ? `${t("tokens", "tokeny")} —` : `${compact(row.tokensTotal)} ${t("tokens", "tokenów")}`,
        usd(row.usd),
        ...(endedUnread(row) ? [t("last reading before the end", "ostatni odczyt przed końcem")] : []),
      ].join(" · "),
    };
  });
  const riskColor = insight?.risk === "critical" ? "var(--crit)" : insight?.risk === "warning" ? "var(--warn)" : undefined;
  const shown = showAll ? rows : rows.slice(0, TABLE_ROWS);
  const selectedRow = rows.find((row) => row.key === activeKey) ?? rows[0];
  const countLabel = session ? t("Sessions", "Sesje") : hours === 168 ? t("Weekly windows", "Okna tygodniowe") : t("Windows", "Okna");
  return (
    <div className="archive ui-tab-page">
      {counters.length > 1 && (
        <div role="region" aria-label={t("History counter selection", "Wybór licznika historii")} tabIndex={0} style={{ maxWidth: "100%", overflowX: "auto", paddingBottom: 2 }}>
          <Tabs value={active.key} onChange={(key) => { setCounterKey(key); setShowAll(false); }} options={counters.map((counter) => ({ value: counter.key, label: counter.label }))} />
        </div>
      )}
      <KpiRow columns={4}>
        <Kpi label={countLabel} value={whole.format(rows.length)}
          visual={measured.length < rows.length ? <ResultBar parts={[
            { key: "measured", count: measured.length, color: "var(--accent)", title: t("read from the account", "odczyt z konta") },
            { key: "cadence", count: rows.length - measured.length, color: "var(--line2)", title: t("reconstructed from the cadence", "odtworzone z rytmu") },
          ]} /> : null}
          caption={measured.length < rows.length
            ? t("{0} from a % reading · {1} reconstructed from the cadence", `${measured.length} z odczytu % · ${rows.length - measured.length} odtworzone z rytmu`, [measured.length, rows.length - measured.length])
            : t("since {0} · each {1} · percentage from the account", `od ${since} · każde ${duration(hours)} · procent z konta`, [since, duration(hours)])} />
        <Kpi label={t("Typical end", "Typowy koniec")} value={typicalEnd == null ? "—" : <>{whole.format(typicalEnd)}{unit("%")}</>}
          visual={typicalEnd == null ? null : <Track fill={typicalEnd} color="var(--violet)" />}
          caption={typicalEnd != null
            ? t("median of {0} comparable windows (same plan and cadence)", `mediana ${insight!.baselineCount} porównywalnych okien (ten sam plan i rytm)`, [insight!.baselineCount])
            : insight
              ? t("building history · {0}/2 comparable windows (same plan and cadence)", `buduję historię · ${Math.min(insight.baselineCount, 2)}/2 porównywalnych okien (ten sam plan i rytm)`, [Math.min(insight.baselineCount, 2)])
              : t("no current window with a reading", "brak bieżącego okna z odczytem")} />
        {active.isSublimit ? (
          <Kpi label={t("{0} - highest", `${active.rows[0]?.label ?? ""} — najwyżej`, [active.rows[0]?.label ?? ""])}
            value={highest ? <>{whole.format(highest.usedPercent!)}{unit("%")}</> : "—"} visual={null}
            caption={highest ? `${dayMonth(highest.startIso)} → ${dayMonth(highest.resetIso)} · ${planOf(highest)}` : t("no closed window with a reading", "brak zamkniętego okna z odczytem")} />
        ) : (
          <Kpi label={session ? t("Current", "Bieżąca") : t("Current window", "Bieżące okno")} color={riskColor}
            value={current ? <>{whole.format(current.usedPercent!)}{unit("%")}</> : "—"} visual={null}
            caption={current
              ? `${insight?.forecastPercent != null ? t("forecast at the end ≈ {0}", `prognoza na koniec ≈ ${pct(insight.forecastPercent)}`, [pct(insight.forecastPercent)]) : planOf(current)} · ${t("details in Overview", "szczegóły w Przeglądzie")}`
              : t("no window in progress", "żadne okno nie trwa")} />
        )}
        {session ? (
          <Kpi label={t("Highest", "Najwyższa")} value={highest ? <>{whole.format(highest.usedPercent!)}{unit("%")}</> : "—"} visual={null}
            caption={closedPercents.some((row) => row.usedPercent! >= 100)
              ? t("closed sessions · {0} reached 100%", `zamknięte sesje · ${closedPercents.filter((row) => row.usedPercent! >= 100).length} doszło do 100%`, [closedPercents.filter((row) => row.usedPercent! >= 100).length])
              : t("closed sessions · none reached 100%", "zamknięte sesje · żadna nie doszła do 100%")} />
        ) : (
          <Kpi label="API-eq" value={usdRows.length ? dollars.format(usdRows.reduce((sum, row) => sum + row.usd!, 0)) : "—"} visual={null}
            caption={percentWithoutUsd
              ? t("only windows reconstructed from the cadence carry tokens and $; windows read from the account show —", "tylko okna odtworzone z rytmu mają tokeny i $ — okna z odczytu % mają „—”")
              : t("at API rates, not a bill", "po cenniku API, nie rachunek")} />
        )}
      </KpiRow>
      <Card>
        <div className="archive-head">
          <div>
            <b>{session ? t("Each session", "Każda sesja") : t("Each window", "Każde okno")}</b>{" "}
            <HelpDot>{session
              ? t("Bar: usage at the end (or the last reading).", "Słupek: zużycie na końcu (lub ostatni odczyt).")
              : t("Bar: % at the end. Dashed frame: no % (window from the cadence). Below: tokens. Band on top: plan.", "Słupek: % na końcu. Ramka przerywana: brak % (okno z rytmu). Niżej: tokeny. Pasek u góry: plan.")}</HelpDot>
          </div>
        </div>
        <WindowBarChart bars={bars} median={typicalEnd == null ? null : { value: typicalEnd, label: `${t("typically", "typowo")} ${whole.format(typicalEnd)}%` }}
          laneMax={tokenMax} laneLabel={t("tokens", "tokeny")}
          endLabel={series.at(-1)?.isCurrent && series.at(-1)!.usedPercent != null
            ? { candidates: [`${pct(series.at(-1)!.usedPercent)} · ${t("in progress", "trwa")}`, pct(series.at(-1)!.usedPercent)], color: "var(--accent)" } : null}
          tick={(_, i) => dateLabels[i] ?? null}
          onSelect={(bar) => { const row = rows.find((window) => window.key === bar.key); if (row) onSelect(row); }} />
        <div className="archive-legend">
          <span><i style={{ background: MEASURED }} />{t("read from the account", "odczyt z konta")}</span>
          {rows.some((row) => row.usedPercent == null) && <span><i className="archive-legend-frame" />{t("reconstructed from the cadence, no %", "odtworzone z rytmu, bez %")}</span>}
          {rows.some((row) => row.percentBasis === "counterfactual") && <span><i style={{ background: "var(--muted)" }} />{t("≈ calculated from cost", "≈ wyliczone z kosztu")}</span>}
          {bars.some((bar) => bar.sub != null) && <span><i className="archive-legend-diamond" />{rows.find((row) => row.sublimits.length)?.sublimits[0]?.label} ({t("sublimit", "podlimit")})</span>}
          {tokenMax > 0 && <span><i style={{ background: "var(--line2)" }} />{t("tokens from the index", "tokeny z indeksu")}</span>}
          {typicalEnd != null && <span><i className="archive-legend-line" />{t("typical end", "typowy koniec")}</span>}
        </div>
      </Card>
      <Card>
        <div className="archive-head">
          <div><b>{t("Window table", "Tabela okien")}</b> <HelpDot label={t("Window table", "Tabela okien")}>{t("Newest at the top. Click selects a window.", "Najnowsze u góry. Klik wybiera okno.")}</HelpDot></div>
          {onEvents && selectedRow?.startIso && (
            <button type="button" className="ui-link-button" title={`${dayTime(selectedRow.startIso)} → ${dayTime(selectedRow.resetIso)}`}
              onClick={() => onEvents(historyEventsTarget(account, selectedRow.startIso!, selectedRow.isCurrent ? null : selectedRow.resetIso))}>
              {t("Events for the window {0} →", `Zdarzenia okna ${selectedRow.dateLabel} →`, [selectedRow.dateLabel])}
            </button>
          )}
        </div>
        <RailWindowTable rows={shown} isSelected={(window) => window.key === activeKey} onSelect={onSelect} />
        {rows.length > TABLE_ROWS && (
          <button type="button" className="archive-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? t("fold to {0} ▴", `zwiń do ${TABLE_ROWS} ▴`, [TABLE_ROWS]) : t("show all {0} ▾", `pokaż wszystkie ${rows.length} ▾`, [rows.length])}
          </button>
        )}
        {selectedRow?.accountSplit && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "var(--rule)" }}>
            <Eyebrow>
              {t("Whole account in window", "Całe konto w oknie")} {selectedRow.dateLabel} ·{" "}
              {selectedRow.accountSplit.rows.some((row) => row.key === OUTSIDE_CODE_PRODUCT_KEY)
                ? t("Claude Code share read from the account", "udział Claude Code odczytany z konta")
                : t("split read from the account", "podział odczytany z konta")}
            </Eyebrow>
            <AccountSplitTable split={selectedRow.accountSplit} />
          </div>
        )}
        <div className="archive-note">
          {t("Tokens and dollars are measured from indexed calls within the window. A percentage without '≈' comes from the account; with '≈' it was calculated from those dollars and today's point rate. The cadence behind the boundaries is edited in Settings → Accounts → Window rhythm.",
            "Tokeny i dolary są zmierzone z zaindeksowanych wywołań w granicach okna. Procent bez „≈” pochodzi z konta; z „≈” wyliczono go z tych dolarów i dzisiejszego kursu punktu. Rytm, z którego wynikają granice, poprawia się w Ustawienia → Konta → Rytm okien.")}
        </div>
      </Card>
    </div>
  );
}
