import { useMemo, type ReactNode } from "react";
import { buildWindowInsights, type WindowInsight, type WindowRisk } from "../lib/window-insights";
import type { RailWindow } from "../lib/windows";
import { compact, dayTime, duration, pct, signedPp } from "../lib/format";
import { translate, useI18n } from "../lib/i18n";
import { Bar, Card, CardTitle, EstimateTag, Pill, type Tone } from "./ui";

const RISK_RANK: Record<WindowRisk, number> = { neutral: 0, warning: 1, critical: 2 };

function toneOf(risk: WindowRisk): Tone {
  if (risk === "critical") return "crit";
  if (risk === "warning") return "warn";
  return "neutral";
}

function colorOf(risk: WindowRisk): string {
  if (risk === "critical") return "var(--crit)";
  if (risk === "warning") return "var(--warn)";
  return "var(--accent)";
}

function ageLabel(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const sampleMs = Date.parse(iso);
  if (!Number.isFinite(sampleMs)) return null;
  const minutes = Math.max(0, Math.round((nowMs - sampleMs) / 60_000));
  if (minutes < 1) return translate("just now", "przed chwilą");
  if (minutes < 60) return `${minutes} ${translate("min ago", "min temu")}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ${translate("ago", "temu")}` : `${Math.round(hours / 24)} ${translate("days ago", "dni temu")}`;
}

function remainingLabel(resetIso: string | null, nowMs: number): string {
  if (!resetIso) return translate("reset -", "reset —");
  const resetMs = Date.parse(resetIso);
  if (!Number.isFinite(resetMs)) return translate("reset -", "reset —");
  if (resetMs <= nowMs) return translate("reset should have happened already", "reset powinien już nastąpić");
  return `${translate("reset in", "reset za")} ${duration((resetMs - nowMs) / 3_600_000)}`;
}

function urgentInsight(insights: WindowInsight[]): WindowInsight | null {
  return [...insights]
    .filter((item) => item.forecastPercent != null)
    .sort(
      (a, b) =>
        RISK_RANK[b.risk] - RISK_RANK[a.risk] ||
        (b.forecastPercent ?? 0) - (a.forecastPercent ?? 0)
    )[0] ?? null;
}

const TRAFFIC_COLORS = [
  "var(--accent)",
  "color-mix(in oklab, var(--accent) 68%, var(--surface))",
  "color-mix(in oklab, var(--accent) 42%, var(--surface))",
  "color-mix(in oklab, var(--accent) 24%, var(--surface))",
];

function TrafficBreakdown({ shares }: { shares: WindowInsight["current"]["trafficByMachine"] }) {
  const { t } = useI18n();
  const rows = shares
    .filter((row) => Number.isFinite(row.amount) && row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  if (total <= 0) return null;
  const ariaLabel = rows
    .map((row) => `${row.machine ?? t("unknown", "nieznane")}: ${pct((row.amount / total) * 100)}`)
    .join(", ");
  return (
    <div
      style={{ marginTop: "var(--s-4)" }}
      title={t("Share of indexed tokens in this window. This is not the percentage share of the vendor limit.", "Udział w zaindeksowanych tokenach tego okna. To nie jest udział procentowy limitu vendora.")}
    >
      <div
        role="img"
        aria-label={`${t("Share of indexed tokens by machine.", "Udział zaindeksowanych tokenów według komputera.")} ${ariaLabel}`}
        style={{
          height: 6,
          boxSizing: "border-box",
          display: "flex",
          overflow: "hidden",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-bar)",
          background: "var(--sunk)",
        }}
      >
        {rows.map((row, index) => (
          <span
            key={row.machine ?? "unknown"}
            aria-hidden="true"
            style={{
              width: `${(row.amount / total) * 100}%`,
              minWidth: row.amount > 0 ? 2 : 0,
              background: row.machine ? TRAFFIC_COLORS[index % TRAFFIC_COLORS.length] : "var(--line2)",
              borderLeft: index === 0 ? undefined : "1px solid var(--surface)",
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-1) var(--s-5)", flexWrap: "wrap", marginTop: "var(--s-2)" }}>
        <span style={{ color: "var(--faint)" }}>{t("indexed token share:", "udział zaindeksowanych tokenów:")}</span>
        {rows.map((row, index) => (
          <span
            key={row.machine ?? "unknown"}
            className="mono"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, color: row.machine ? "var(--muted)" : "var(--faint)" }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 3,
                borderRadius: "var(--r-bar)",
                background: row.machine ? TRAFFIC_COLORS[index % TRAFFIC_COLORS.length] : "var(--line2)",
              }}
            />
            {row.machine ?? t("unknown", "nieznane")} {pct((row.amount / total) * 100)} ({compact(row.amount)})
          </span>
        ))}
      </div>
    </div>
  );
}

function CounterRow({ insight, nowMs, historicalEndIso }: { insight: WindowInsight; nowMs: number; historicalEndIso?: string | null }) {
  const { t } = useI18n();
  const used = insight.current.usedPercent;
  const forecast = insight.forecastPercent;
  const historical = !insight.current.isCurrent;
  const historicalDate = historicalEndIso && Number.isFinite(Date.parse(historicalEndIso))
    ? dayTime(historicalEndIso)
    : null;
  const age = ageLabel(insight.current.sampledAtIso, nowMs);
  const measured = insight.current.percentBasis === "measured";
  const source = [
    measured && age ? `${t("% read", "% odczyt")} ${age}` : !measured && used != null ? t("computed percentage", "procent wyliczony") : null,
    insight.current.sampleMachine,
  ].filter(Boolean).join(" · ");
  const barColor = colorOf(insight.risk);
  return (
    <div
      data-counter={insight.counterKey}
      data-risk={insight.risk}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(104px, 0.7fr) minmax(0, 1.3fr)",
        gap: "var(--s-4) var(--s-8)",
        padding: insight.isSublimit ? "var(--s-5) 0 var(--s-5) var(--s-8)" : "var(--s-5) 0",
        borderTop: "var(--rule)",
        minWidth: 0,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {insight.isSublimit && <span aria-hidden="true" style={{ color: "var(--faint)" }}>↳</span>}
          <span style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {insight.label}
          </span>
          {insight.isSublimit && <Pill tone="neutral">{t("sub-limit", "podlimit")}</Pill>}
        </div>
        <div className="mono" style={{ marginTop: "var(--s-2)", fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          {historical
            ? historicalDate
              ? `${t("closed", "zamknięte")} · ${historicalDate}`
              : `${t("closed window", "zamknięte okno")} · ${insight.current.dateLabel}`
            : remainingLabel(insight.current.resetIso, nowMs)}
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <span className="ui-figure" style={{ fontSize: "var(--fs-8)", lineHeight: 1, color: used == null ? "var(--faint)" : barColor }}>
            {used == null ? pct(used) : `${measured ? "" : "≈"}${pct(used)}`}
          </span>
          {!measured && used != null && (
            <EstimateTag title={t("Percentage computed from local traffic and current calibration. It is not a vendor limit reading.", "Procent wyliczony z lokalnego ruchu i bieżącej kalibracji. Nie jest odczytem limitu vendora.")}>
              {t("estimate", "szacunek")}
            </EstimateTag>
          )}
          {historical ? (
            <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              {t("selected closed window", "wybrane zamknięte okno")}
            </span>
          ) : forecast != null ? (
            <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              {t("forecast", "prognoza")} ≈{pct(forecast)} <EstimateTag title={t("Forecast equals current usage plus typical usage for the remaining part of the window.", "Prognoza = bieżące zużycie + typowe zużycie pozostałej części okna.")}>{t("computed", "wyliczone")}</EstimateTag>
            </span>
          ) : (
            <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              {t("building history", "buduję historię")} · {Math.min(insight.baselineCount, 2)}/2 {t("comparable windows", "porównywalnych okien")}
            </span>
          )}
        </div>
        <div style={{ marginTop: "var(--s-4)" }}>
          <Bar value={Math.max(0, Math.min(100, used ?? 0))} color={used == null ? "var(--line2)" : barColor} height={6} />
        </div>
        <div className="mono" style={{ marginTop: "var(--s-3)", fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.45 }}>
          {insight.typicalAtElapsed != null && insight.deviationPp != null ? (
            <>
              {t("typical", "typowo")} ≈{pct(insight.typicalAtElapsed)} {historical ? t("at selected point", "w wybranym punkcie") : t("now", "teraz")} · {signedPp(insight.deviationPp)}
            </>
          ) : (
            historical
              ? t("No forecast is applied to a closed window", "Dla zamkniętego okna nie stosujemy prognozy")
              : t("typical course appears after the second comparable window", "typowy przebieg pojawi się po drugim porównywalnym oknie")
          )}
          {source && <span style={{ color: "var(--faint)" }}> · {source}</span>}
          <TrafficBreakdown shares={insight.current.trafficByMachine} />
        </div>
      </div>
    </div>
  );
}

const COUNTER_GRID = "minmax(190px, 1.25fr) 84px minmax(220px, 2.6fr) 128px 118px minmax(150px, 1fr)";

/** Time share and even-pace ratio of a counter; after a drop the pace runs from the segment's first percent. */
function paceOf(used: number | null, elapsed: number | null, baseline: number): { ratio: number | null; tone: Tone } {
  const room = 100 - baseline;
  if (used == null || elapsed == null || elapsed <= 1 || room <= 0) return { ratio: null, tone: "neutral" };
  const ratio = (used - baseline) / ((room * elapsed) / 100);
  return { ratio, tone: ratio >= 1.5 ? "crit" : ratio > 1 ? "warn" : "ok" };
}

function Meter({ used, now }: { used: number | null; now: number | null }) {
  return (
    <div style={{ position: "relative", height: 12, boxSizing: "border-box", background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
      <div style={{
        position: "absolute", top: 0, bottom: 0, left: 0, width: `${Math.max(0, Math.min(100, used ?? 0))}%`,
        background: "var(--claude)",
      }} />
      {now != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.max(0, Math.min(100, now))}%`, width: 2, background: "var(--text)" }} />}
    </div>
  );
}

function CounterCells({ name, sub, child, value, meter, caption, reset, pace, history, dim }: {
  name: string; sub: string; child?: boolean; value: ReactNode; meter: ReactNode; caption: [ReactNode, ReactNode];
  reset: ReactNode; pace: ReactNode; history: ReactNode; dim?: boolean;
}) {
  const cell = { padding: "var(--s-5) 0", borderTop: "var(--rule)", minWidth: 0, opacity: dim ? 0.6 : 1 } as const;
  return (
    <>
      <div style={{ ...cell, paddingLeft: child ? 16 : 0, position: "relative" }}>
        {child && <span aria-hidden="true" style={{ position: "absolute", left: 1, color: "var(--faint)" }}>↳</span>}
        <div style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)" }}>{name}</div>
        <div style={{ marginTop: "var(--s-1)", fontSize: "var(--fs-3)", color: "var(--muted)", overflowWrap: "anywhere" }}>{sub}</div>
      </div>
      <div className="ui-figure" style={{ ...cell, fontSize: "var(--fs-8)", lineHeight: 1, whiteSpace: "nowrap" }}>{value}</div>
      <div style={cell}>
        {meter}
        <div className="mono" style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-4)", marginTop: "var(--s-2)", fontSize: "var(--fs-2)", color: "var(--muted)" }}>
          <span>{caption[0]}</span><span>{caption[1]}</span>
        </div>
      </div>
      <div className="mono" style={cell}>{reset}</div>
      <div style={cell}>{pace}</div>
      <div className="mono" style={{ ...cell, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.45 }}>{history}</div>
    </>
  );
}

/**
 * Claude's Overview counters: every meter of the account in one row layout (percent, time marker,
 * reset, pace, typical course), the meters without windows from the same reading, and a note when
 * a plan change restarted the weekly counter.
 */
function ClaudeCountersCard({ windows, insights, account, nowMs, selectedHistorical, selectedEndIso }: {
  windows: RailWindow[]; insights: WindowInsight[]; account: string; nowMs: number;
  selectedHistorical: boolean; selectedEndIso?: string | null;
}) {
  const { t } = useI18n();
  const hostOf = (insight: WindowInsight) => windows.find((window) => window.key === insight.current.windowKey) ?? null;
  const weekly = insights.find((insight) => !insight.isSublimit && insight.current.windowHours === 168) ?? null;
  const weeklyHost = weekly ? hostOf(weekly) : null;
  const meters = selectedHistorical ? null : weeklyHost?.accountMeters ?? null;
  const drop = weeklyHost?.counterSegment?.startDrop ?? null;
  const newest = insights.map((insight) => insight.current).filter((row) => row.sampledAtIso)
    .sort((a, b) => Date.parse(b.sampledAtIso!) - Date.parse(a.sampledAtIso!))[0] ?? null;
  const age = ageLabel(newest?.sampledAtIso ?? null, nowMs);
  const counterName = (insight: WindowInsight) => insight.isSublimit
    ? insight.label
    : insight.current.windowHours === 5 ? t("5h session", "Sesja 5h")
    : insight.current.windowHours === 168 ? t("7d week", "Tydzień 7d") : insight.label;
  const counterSub = (insight: WindowInsight) => {
    if (insight.isSublimit) return t("sub-limit of the 7d window · own denominator", "podlimit okna 7d · własny mianownik");
    if (insight.current.windowHours === 5) return t("rolling from the first use", "okno kroczące od pierwszego użycia");
    return hostOf(insight)?.counterSegment?.startDrop
      ? t("all models · segment since the plan change", "wszystkie modele · odcinek od zmiany planu")
      : t("all models", "wszystkie modele");
  };
  const resetCell = (resetIso: string | null) => {
    const resetMs = resetIso ? Date.parse(resetIso) : NaN;
    if (!Number.isFinite(resetMs)) return <span style={{ color: "var(--faint)" }}>{t("no reset reported", "konto nie podaje resetu")}</span>;
    return <>
      <div style={{ fontSize: "var(--fs-5)", fontWeight: "var(--fw-semibold)" }}>{resetMs > nowMs ? `${t("in", "za")} ${duration((resetMs - nowMs) / 3_600_000)}` : t("reset due", "reset minął")}</div>
      <div style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>{dayTime(resetIso)}</div>
    </>;
  };
  const historyCell = (insight: WindowInsight) => {
    if (selectedHistorical) {
      return <>{t("selected closed window", "wybrane zamknięte okno")}
        <div style={{ color: "var(--faint)" }}>{t("No forecast is applied to a closed window", "Dla zamkniętego okna nie stosujemy prognozy")}</div></>;
    }
    if (insight.forecastPercent != null) {
      return <>{t("forecast", "prognoza")} ≈{pct(insight.forecastPercent)} <EstimateTag title={t("Forecast equals current usage plus typical usage for the remaining part of the window.", "Prognoza = bieżące zużycie + typowe zużycie pozostałej części okna.")}>{t("computed", "wyliczone")}</EstimateTag>
        {insight.typicalAtElapsed != null && insight.deviationPp != null && <div>{t("typical", "typowo")} ≈{pct(insight.typicalAtElapsed)} {t("now", "teraz")} · {signedPp(insight.deviationPp)}</div>}</>;
    }
    return <span style={{ color: "var(--faint)" }}>{t("typical course", "typowy przebieg")}: {Math.min(insight.baselineCount, 2)}/2 {t("windows", "okien")}</span>;
  };
  const dollars = (value: number | null) => value == null ? "—" : `${value.toLocaleString(t("en-GB", "pl-PL"), { maximumFractionDigits: 2 })} $`;
  const title = selectedHistorical ? t("Selected subscription window", "Wybrane okno subskrypcji") : t("Account counters", "Liczniki konta");
  const measuredNewest = newest?.percentBasis === "measured";
  const sourceLine = [
    account,
    measuredNewest && age ? `${t("% read", "% odczyt")} ${age}` : !measuredNewest ? t("computed percentage", "procent wyliczony") : null,
    newest?.sampleMachine ?? null,
  ].filter(Boolean).join(" · ");
  return (
    <Card>
      <CardTitle title={title} sub={sourceLine} />
      <div style={{ display: "grid", gridTemplateColumns: COUNTER_GRID, columnGap: "var(--s-8)", alignItems: "center", marginTop: "var(--s-4)" }}>
        {[t("Counter", "Licznik"), t("Used", "Zużycie"), t("Used vs window time", "Zużycie a czas okna"), t("Reset", "Reset"), t("Pace", "Tempo"), t("History", "Historia")].map((label) => (
          <div key={label} style={{ fontSize: "var(--fs-3)", color: "var(--muted)", paddingBottom: "var(--s-3)" }}>{label}</div>
        ))}
        {insights.map((insight) => {
          const host = hostOf(insight);
          const used = insight.current.usedPercent;
          const measured = insight.current.percentBasis === "measured";
          const elapsed = insight.current.isCurrent ? insight.current.elapsedPercent : null;
          const baseline = insight.isSublimit ? 0 : host?.counterSegment?.startDrop?.after ?? 0;
          const pace = paceOf(used, elapsed, baseline);
          const start = insight.current.startIso;
          return <CounterCells key={insight.counterKey}
            name={counterName(insight)} sub={counterSub(insight)} child={insight.isSublimit}
            value={<>{used == null ? pct(used) : `${measured ? "" : "≈"}${pct(used)}`}
              {!measured && used != null && <div style={{ marginTop: 4 }}><EstimateTag title={t("Percentage computed from local traffic and current calibration. It is not a vendor limit reading.", "Procent wyliczony z lokalnego ruchu i bieżącej kalibracji. Nie jest odczytem limitu vendora.")}>{t("estimate", "szacunek")}</EstimateTag></div>}</>}
            meter={<><Meter used={used} now={elapsed} />{!insight.isSublimit && <TrafficBreakdown shares={insight.current.trafficByMachine} />}</>}
            caption={[
              insight.isSublimit ? "" : start ? `${dayTime(start)} ${host?.counterSegment?.startDrop ? `↓ ${t("plan change", "zmiana planu")}` : t("start", "start")}` : "",
              insight.isSublimit ? t("does not add up with 7d", "nie sumuje się z 7d") : elapsed != null ? `${pct(elapsed)} ${t("of window time", "czasu okna")}` : "",
            ]}
            reset={selectedHistorical
              ? <span style={{ color: "var(--muted)", fontSize: "var(--fs-3)" }}>{selectedEndIso && Number.isFinite(Date.parse(selectedEndIso))
                ? `${t("closed", "zamknięte")} · ${dayTime(selectedEndIso)}` : `${t("closed window", "zamknięte okno")} · ${insight.current.dateLabel}`}</span>
              : insight.isSublimit ? <span style={{ color: "var(--muted)" }}>{t("as 7d", "jak 7d")}</span> : resetCell(insight.current.resetIso)}
            pace={pace.ratio == null
              ? <span style={{ color: "var(--faint)" }}>{used === 0 ? t("no use", "brak użycia") : "—"}</span>
              : <Pill tone={pace.tone}>{pace.ratio.toLocaleString(t("en-GB", "pl-PL"), { maximumFractionDigits: 2 })}× {pace.ratio > 1 ? t("faster", "szybciej") : t("slower", "wolniej")}</Pill>}
            history={historyCell(insight)} />;
        })}
        {meters?.meters.map((meter) => {
          const dollarLimit = meter.limit_dollars != null;
          return <CounterCells key={meter.key}
            name={dollarLimit ? t("Dollar limit", "Limit dolarowy") : t("Additional counter", "Licznik dodatkowy")}
            sub={`${meter.key} · ${t("meaning unconfirmed", "znaczenie niepotwierdzone")}`}
            value={dollarLimit
              ? <span style={{ fontSize: "var(--fs-readout)" }}>{dollars(meter.used_dollars)}<span style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}> / {dollars(meter.limit_dollars)}</span></span>
              : <>{meter.utilization_percent == null ? "—" : Math.round(meter.utilization_percent)}<span style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>%</span></>}
            meter={<Meter used={meter.utilization_percent} now={null} />}
            caption={[dollarLimit && meter.remaining_dollars != null ? `${t("remaining", "zostało")} ${dollars(meter.remaining_dollars)}` : "", pct(meter.utilization_percent)]}
            reset={resetCell(meter.resets_at)}
            pace={<span style={{ color: "var(--faint)" }}>—</span>}
            history={<span style={{ color: "var(--faint)" }}>{t("read", "odczyt")} {dayTime(meters.read_at)}</span>} />;
        })}
        {meters?.extra_usage && (() => {
          const extra = meters.extra_usage;
          const spent = extra.spent_minor == null ? null : extra.spent_minor / 10 ** (extra.exponent ?? 2);
          return <CounterCells key="extra_usage" dim={!extra.enabled}
            name={t("Extra usage", "Dodatkowe zużycie")} sub={t("paid beyond the limit · extra_usage", "płatne ponad limit · extra_usage")}
            value={<Pill tone={extra.enabled ? "warn" : "neutral"}>{extra.enabled ? t("enabled", "włączone") : t("disabled", "wyłączone")}</Pill>}
            meter={<span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              {t("spent", "wydano")} {spent == null ? "—" : `${spent.toLocaleString(t("en-GB", "pl-PL"), { minimumFractionDigits: 2 })} ${extra.currency ?? ""}`}
              {extra.user_disabled ? ` · ${t("turned off by the user", "wyłączone przez użytkownika")}` : ""}
            </span>}
            caption={["", ""]} reset={null} pace={null} history={null} />;
        })()}
      </div>
      {drop && !selectedHistorical && weekly && (
        <div style={{ margin: "var(--s-5) 0 var(--s-2)", padding: "var(--s-4) var(--s-6)", borderRadius: "var(--r-chip)", background: "var(--warn-soft)", fontSize: "var(--fs-4)", lineHeight: 1.5 }}>
          ↓ {dayTime(weekly.current.startIso)} {t(
            "the weekly counter fell from {0}% to {1}% without moving its reset (plan change). The 7d window counts from that reading; the earlier segment is in Periods → Limit windows.",
            `licznik tygodniowy spadł z ${drop.before}% do ${drop.after}% bez zmiany resetu (zmiana planu). Okno 7d liczy się od tego odczytu; poprzedni odcinek jest w Okresy → Okna limitu.`, [drop.before, drop.after])}
        </div>
      )}
    </Card>
  );
}

export function WindowInsightCard({
  windows,
  account,
  nowMs = Date.now(),
  selectedKey,
  selectedEndIso,
}: {
  windows: RailWindow[];
  account: string;
  nowMs?: number;
  selectedKey?: string | null;
  selectedEndIso?: string | null;
}) {
  const { t } = useI18n();
  const selected = selectedKey ? windows.find((window) => window.key === selectedKey) ?? null : null;
  const selectedHistorical = selected != null && !selected.isCurrent;
  const insights = useMemo(() => buildWindowInsights(windows, nowMs, selectedKey), [windows, nowMs, selectedKey]);
  if (insights.length === 0) return null;
  if (windows.some((window) => window.counterKey?.startsWith("claude:"))) {
    return <ClaudeCountersCard windows={windows} insights={insights} account={account} nowMs={nowMs}
      selectedHistorical={selectedHistorical} selectedEndIso={selectedEndIso} />;
  }
  const urgent = selectedHistorical ? null : urgentInsight(insights);
  const allLearning = insights.every((item) => item.buildingHistory);
  const title = selectedHistorical
    ? t("Selected subscription window", "Wybrane okno subskrypcji")
    : urgent
      ? `${t("Most urgent", "Najpilniejszy")}: ${urgent.label} · ${t("forecast", "prognoza")} ≈${pct(urgent.forecastPercent)}`
      : allLearning
        ? t("Building the typical course for this subscription", "Buduję typowy przebieg tej subskrypcji")
        : t("Current subscription limits", "Bieżące limity subskrypcji");
  return (
    <Card>
      <CardTitle
        title={title}
        sub={account}
        help={t("Sub-limit percentages have their own denominator and do not add up to the main limit.", "Procenty podlimitów mają własny mianownik i nie sumują się z limitem głównym.")}
        right={urgent && urgent.risk !== "neutral" ? <Pill tone={toneOf(urgent.risk)} dot>{urgent.risk === "critical" ? t("limit risk", "ryzyko limitu") : t("near the limit", "blisko limitu")}</Pill> : undefined}
      />
      <div style={{ marginTop: "var(--s-4)" }}>
        {insights.map((insight) => <CounterRow key={insight.counterKey} insight={insight} nowMs={nowMs} historicalEndIso={selectedEndIso} />)}
      </div>
    </Card>
  );
}
