import type { AccountCapabilities, ClaudeLimitResponse, ClaudeSurfaceBreakdown } from "../lib/api";
import { claudeReading } from "../lib/claude";
import { useBreakpoint, splitColumns } from "../lib/useBreakpoint";
import { ClaudeCalibrationHistoryCard } from "./ClaudeLimitPanel";
import { ClaudeStatusCard, claudeWindowModel, sameInstant, type ClaudeWindowModel } from "./ClaudeStatusCard";
import { MissingSection, missingVendorSections, type VendorOverviewSections } from "./VendorOverview";
import { BudgetCard, PaceCard, VersusCard, percentUnit, type BudgetUnit } from "./WindowForecastPanel";
import {
  Card,
  CardTitle,
  Eyebrow,
  Pill,
  type Tone,
} from "./ui";
import { compact, dayTime, duration, full, pct, signedPp, usd } from "../lib/format";
import { getLocale, translate, useI18n } from "../lib/i18n";
import { useState, type ReactNode } from "react";
import { claudeAccountSplit, type ClaudeAccountSplit } from "../../shared/claude-code-capacity";
import { AccountSplitTable } from "./AccountSplitTable";
import { ClaudeWindowModels } from "./ClaudeWindowModels";
import { TokenComposition } from "./CycleComposition";
import { sumWindowTokens } from "../lib/window-tokens";
import { RailWindowTable } from "./RailWindowTable";
import { FullHistoryLink } from "./CycleHistoryTable";
import { sampleCurveAt, type WindowInsight } from "../lib/window-insights";
import { shapeAt } from "../lib/window-status";
import type { RailWindow } from "../lib/windows";

function localizedNumber(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString(getLocale(), { maximumFractionDigits });
}

export function claudeSections({
  capabilities,
  data,
  windows = [],
  insights = [],
  account = "",
  selectedHistorical = false,
  onFullHistory,
  bounds,
  chartControl,
  chartOverride,
}: {
  capabilities: AccountCapabilities | null;
  data: ClaudeLimitResponse;
  /** The account's rail windows: measured courses, account meters and window history. */
  windows?: RailWindow[];
  /** Counters of those windows as the rail reads them. */
  insights?: WindowInsight[];
  account?: string;
  selectedHistorical?: boolean;
  /** Opens History with every window; the Overview table shows the newest only. */
  onFullHistory?: () => void;
  bounds?: { from: string; until: string } | null;
  chartControl?: ReactNode;
  chartOverride?: ReactNode;
}): VendorOverviewSections {
  if (!data.configured) {
    return missingVendorSections(
      translate("Claude has no declared cap", "Claude nie ma zadeklarowanego pułapu"),
      translate(
        "The vendor does not publish a gauge, so the weekly percentage comes from the reading entered in claude-gauge.json. Until the file exists, every section remains explicitly undefined.",
        "Vendor nie publikuje gauge'a, więc procent tygodnia bierze się z odczytu wpisanego do claude-gauge.json. Dopóki pliku nie ma, każda sekcja pozostaje jawnie nieokreślona."
      )
    );
  }
  const cur = data.current;
  if (!cur) {
    return missingVendorSections(
      translate("No active window", "Brak aktywnego okna"),
      translate(
        "claude-gauge.json has no reading from which the current week's boundary can be derived. Usage is indexed. Only the window anchor is missing.",
        "claude-gauge.json nie zawiera odczytu, z którego dałoby się wyprowadzić granicę bieżącego tygodnia. Zużycie jest zindeksowane — brakuje tylko kotwicy okna."
      )
    );
  }
  const session = capabilities?.hasSecondWindow === false ? null : data.session;
  const model = claudeWindowModel(cur, data.window_hours, insights, data.plan);
  const weeklyKey = model.weekly?.current.windowKey;
  const weeklyHost = weeklyKey ? windows.find((w) => w.key === weeklyKey) ?? null : null;
  return {
    lead: <ClaudeStatusCard data={data} model={model} insights={insights} account={account}
      chartControl={chartControl} chartOverride={chartOverride}
      selectedHistorical={selectedHistorical} meters={weeklyHost?.accountMeters ?? null} creditPools={weeklyHost?.creditPools ?? null} />,
    planWindows: <ClaudeForecast data={data} model={model} session={session} />,
    history: <ClaudeWindowHistory windows={windows} windowHours={data.window_hours} reportedStart={cur.window_start} onFullHistory={onFullHistory} />,
    models: <ClaudeWindowModels rows={cur.model_usage} />,
    traffic: <TokenComposition tokens={cur.model_usage == null ? null : sumWindowTokens(cur.model_usage)} />,
    provenance: <ClaudeCaveats caveats={data.caveats} fableShare={data.fable_share_of_all} cur={cur} />,
    calibration: <ClaudeCalibrationHistoryCard data={data} account={account} bounds={bounds} />,
    subs: {
      models: cur.model_usage
        ? `${localizedNumber(cur.model_usage.length)} ${translate("models", "modeli")}`
        : undefined,
      traffic: translate("token types in the selected window", "typy tokenów w wybranym oknie"),
    },
  };
}
type Current = NonNullable<ClaudeLimitResponse["current"]>;
type Session = NonNullable<ClaudeLimitResponse["session"]>;
const RECENT_HOURS = [1, 6, 24];

/**
 * Forecast and budget: the window in every unit Claude can be valued in, recent pace from the
 * account's own readings, the previous comparable window, the used bar's surfaces and the session.
 */
function ClaudeForecast({ data, model, session }: { data: ClaudeLimitResponse; model: ClaudeWindowModel; session: Session | null }) {
  const { t } = useI18n();
  const { cur, used, active, weekly } = model;
  const capacity = data.claude_code_capacity ?? null;
  // The shared Claude Code estimate values the window only when it describes this very reset.
  const shared = capacity && sameInstant(capacity.reset_at, cur.reset_at) ? capacity : null;
  const tokenCap = shared?.weekly_capacity_tokens.value ?? null;
  const apiCap = shared?.weekly_capacity_api_usd.value
    ?? (data.calibration && cur.remaining_usd != null ? data.calibration.window_value_usd : null);
  const units: BudgetUnit[] = used == null ? [] : [
    percentUnit("%", used),
    ...(tokenCap != null ? [{ key: "tokens", label: t("tokens", "tokeny"), rate: tokenCap / 100, used: shared?.account_total_tokens.value ?? null,
      estimated: true, partial: false, cap: null, format: (v: number) => compact(v) }] : []),
    ...(apiCap != null ? [{ key: "api", label: "API-eq", rate: apiCap / 100,
      used: shared ? shared.account_total_api_usd.value : cur.spend.usd, estimated: shared != null,
      partial: shared ? shared.weekly_capacity_api_usd.relation === "≥" : (cur.spend.unpriced_calls ?? 0) > 0, cap: null, format: usd }] : []),
  ];
  const confidence = data.calibration?.confidence;
  const foot = units.length > 1
    ? <span title={[data.calibration?.reason ?? shared?.coverage.assumptions.join(" "),
        shared?.as_of ? `${t("Measurement", "Pomiar")}: ${dayTime(shared.as_of)}` : null].filter(Boolean).join(" · ")}>
      100% ≈ {[tokenCap != null ? `${compact(tokenCap)} ${t("tokens", "tokenów")}` : null,
        apiCap != null ? `${shared?.weekly_capacity_api_usd.relation === "≥" ? "≥ " : ""}${usd(apiCap)} API-eq` : null].filter(Boolean).join(" · ")}
      {" · "}{shared ? t("conditional estimate from the account's Claude Code share", "warunkowy szacunek z udziału Claude Code w koncie") : t("from the calibrated cost per point", "z kalibracji kosztu punktu")}
      {confidence ? ` · ${t("calibration", "kalibracja")}: ${confidence}` : ""}</span>
    : t("No tokens-per-% calibration for this window yet.", "To okno nie ma jeszcze kalibracji tokenów na %.");

  // Recent pace from the account's own readings; nothing is extrapolated outside the measured course.
  const shape = model.measured ? weekly?.current.shape ?? null : null;
  const burns = shape && used != null && model.spanHours > 0 ? RECENT_HOURS.flatMap((hours) => {
    const before = shapeAt(shape, model.reading.t - (hours / model.spanHours) * 100);
    return before == null ? [] : [{ label: `${hours}h`, perDay: (Math.max(0, used - before) / hours) * 24 }];
  }) : [];
  const perHour = (perDay: number) => `${(perDay / 24).toLocaleString(getLocale(), { maximumFractionDigits: 2 })} ${t("pp/h", "p.p./h")}`;
  const previous = weekly?.comparableWindows[0] ?? null;
  const sample = previous && used != null && model.measured ? sampleCurveAt(previous.shape, model.reading.t, previous.activityShape) : null;
  const versus = sample && used != null ? [{ key: "limit", label: t("Limit at the same elapsed time", "Limit po takim samym czasie"),
    delta: used - sample.value, text: (sample.basis === "measured" ? "" : "≈ ") + signedPp(used - sample.value), higherIsBetter: false }] : [];
  return (
    <>
      {used == null
        ? <MissingSection title={t("No percentage for this window", "Brak procentu dla tego okna")}
          detail={t("The account gave no reading and there is no calibration to compute one, so the window cannot be budgeted.", "Konto nie podało odczytu i nie ma kalibracji, z której dałoby się go wyliczyć, więc okna nie da się rozliczyć.")} />
        : <BudgetCard units={units} usedPercent={used} typicalEnd={model.typicalEnd} linearEnd={model.linearEnd} active={active} foot={foot} />}
      <section style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "var(--s-8)" }}>
        <PaceCard burns={burns} active={active} format={perHour}
          averagePerDay={model.perHour != null ? model.perHour * 24 : null}
          sustainablePerDay={model.remainingPerHour != null ? model.remainingPerHour * 24 : null} />
        <VersusCard
          title={previous ? `${t("vs", "vs")} ${previous.dateLabel} · ${t("at the same elapsed time", "w tym samym momencie okna")}` : t("Versus previous comparable window", "Względem poprzedniego porównywalnego okna")}
          rows={versus}
          empty={previous ? t("Previous window found; it has no reading at this point of its course.", "Znaleziono poprzednie okno; nie ma odczytu w tym punkcie przebiegu.")
            : t("No earlier weekly window with the same plan and counter segment yet.", "Brak wcześniejszego okna tygodniowego z tym samym planem i odcinkiem licznika.")}
          note={t("Green is the better side: less limit used at the same point of the window. Past Claude windows carry only the account percentage, so tokens and API-eq per point are not compared.",
            "Zielone = lepiej: mniej zużytego limitu w tym samym punkcie okna. Poprzednie okna Claude'a mają tylko procent z konta, więc tokenów i API-eq na punkt nie porównujemy.")} />
      </section>
      {(cur.surface_breakdown || session) && <section style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "var(--s-8)", alignItems: "start" }}>
        {cur.surface_breakdown && <Card>
          <SurfaceSplit breakdown={cur.surface_breakdown} split={shared ? claudeAccountSplit(shared) : null} />
        </Card>}
        {session && <ClaudeSessionCard session={session} />}
      </section>}
    </>
  );
}

/** The account's weekly windows as the rail knows them, newest first; unknown values stay empty. */
function ClaudeWindowHistory({ windows, windowHours, reportedStart, onFullHistory }: {
  windows: RailWindow[]; windowHours: number; reportedStart: string; onFullHistory?: () => void;
}) {
  const { t } = useI18n();
  const all = windows.filter((w) => w.windowHours === windowHours && !w.parentCounterKey);
  const rows = [...all].sort((a, b) => Date.parse(b.startIso ?? "") - Date.parse(a.startIso ?? "")).slice(0, 12);
  if (rows.length === 0) {
    return <MissingSection title={t("No weekly windows", "Brak okien tygodniowych")}
      detail={t("The account has no weekly windows in the index yet.", "Konto nie ma jeszcze okien tygodniowych w indeksie.")} />;
  }
  return (
    <Card>
      <CardTitle title={t("Weekly windows", "Okna tygodniowe")}
        sub={t("{0} windows", `${rows.length} okien`, [rows.length])}
        help={t("Newest first. Percentages come from the account, traffic from the index.", "Najnowsze u góry. Procent pochodzi z konta, ruch z indeksu.")} />
      <RailWindowTable rows={rows} isSelected={(w) => sameInstant(w.startIso, reportedStart)} />
      {onFullHistory && <FullHistoryLink count={all.length} onOpen={onFullHistory} />}
    </Card>
  );
}
const CLAUDE_CODE_SURFACE = "claude_code";
const OTHER_SURFACE_COLORS = ["var(--violet)", "var(--accent)", "var(--muted)", "var(--line2)"];
/**
 * The account's own split of the window's USED bar. Only the Claude Code slice has a
 * counterpart in the local index, so the rest is the account stating, in its own numbers,
 * how much spend this machine never sees.
 */
function SurfaceSplit({ breakdown, split }: { breakdown: ClaudeSurfaceBreakdown; split: ClaudeAccountSplit | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const total = breakdown.rows.reduce((sum, row) => sum + row.percent, 0);
  if (total <= 0) return null;
  let other = 0;
  const segments = breakdown.rows.map((row) => ({
    ...row,
    label: row.display_name ?? row.key,
    color: row.key === CLAUDE_CODE_SURFACE
      ? "var(--claude)"
      : OTHER_SURFACE_COLORS[other++ % OTHER_SURFACE_COLORS.length]!,
  }));
  const outside = breakdown.rows
    .filter((row) => row.key !== CLAUDE_CODE_SURFACE)
    .reduce((sum, row) => sum + row.percent, 0);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--s-3)" }}>
        <Eyebrow>{t("Used bar by surface", "Zużyty słupek wg powierzchni")}</Eyebrow>
        <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          {t("outside Claude Code", "poza Claude Code")} <b style={{ color: "var(--text)" }}>{pct(outside)}</b> · {t("from account", "z konta")}
          {split && (
            <>
              {" · "}
              <button
                type="button"
                className="mono"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }}
              >
                {open ? t("hide amounts ▴", "ukryj kwoty ▴") : t("amounts ▾", "kwoty ▾")}
              </button>
            </>
          )}
        </span>
      </div>
      <div style={{ display: "flex", height: 14, boxSizing: "border-box", background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            title={`${segment.label} · ${pct(segment.percent)} ${t("of the used bar", "zużytego słupka")}`}
            style={{ width: `${(segment.percent / total) * 100}%`, background: segment.color }}
          />
        ))}
      </div>
      <div className="mono" style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-1) var(--s-6)", marginTop: "var(--s-2)", fontSize: "var(--fs-3)", color: "var(--muted)" }}>
        {segments.map((segment) => (
          <span key={segment.key} style={{ display: "inline-flex", alignItems: "center", gap: "var(--s-2)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "var(--r-bar)", background: segment.color }} />
            {segment.label} {pct(segment.percent)}
          </span>
        ))}
      </div>
      {open && split && <AccountSplitTable split={split} />}
      <div className="mono" style={{ marginTop: "var(--s-2)", fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.5 }}>
        {t(
          "Read from the account at {0}. Only Claude Code also reaches the local index, so the rest is spend the index cannot price.",
          `Odczyt z konta ${dayTime(breakdown.as_of)}. Tylko Claude Code trafia też do lokalnego indeksu — reszty indeks nie wycenia.`, [dayTime(breakdown.as_of)]
        )}
      </div>
    </div>
  );
}
function ClaudeSessionCard({ session }: { session: Session }) {
  const { t } = useI18n();
  const used = session.percent_measured;
  const elapsed = session.elapsed_percent;
  const ahead = session.pp_ahead;
  const tone: Tone =
    used == null ? "neutral" : used >= 100 ? "crit" : used >= 85 ? "warn" : ahead != null && ahead > 15 ? "warn" : "ok";
  const barColor =
    tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--warn)" : "var(--claude)";
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Eyebrow>{t("5h window · session", "Okno 5h · sesja")}</Eyebrow>
        <Pill tone="ok" dot>
          {t("from account", "z konta")}
        </Pill>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-4)", marginTop: "var(--s-2)" }}>
        <div className="ui-figure" style={{ fontSize: "var(--fs-9)", color: tone === "crit" ? "var(--crit)" : "var(--text)" }}>
          {used != null ? localizedNumber(used) : "—"}
          <span style={{ fontSize: "var(--fs-7)", color: "var(--muted)", letterSpacing: 0 }}>%</span>
        </div>
        <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          {pct(elapsed)} {t("of window time", "czasu okna")}
        </div>
      </div>
      <div
        style={{
          position: "relative",
          height: 12,
          boxSizing: "border-box",
          marginTop: "var(--s-3)",
          background: "var(--sunk)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
        }}
      >
        {used != null && (
          <div style={{ position: "absolute", inset: `0 ${100 - Math.min(100, used)}% 0 0`, background: barColor }} />
        )}
        <div
          title={`${pct(elapsed)} ${t("of window time elapsed", "czasu okna minęło")}`}
          style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.min(100, elapsed)}%`, width: 2, background: "var(--text)" }}
        />
      </div>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--s-2)", fontSize: "var(--fs-3)", color: "var(--muted)" }}>
        <span>{t("reset", "reset")} {duration(session.remaining_hours)} · {dayTime(session.reset_at)}</span>
        <span title={t("Age of the account reading", "Wiek odczytu z konta")}>
          {session.measured_age_minutes != null
            ? session.measured_age_minutes < 1
              ? t("just now", "przed chwilą")
              : `${localizedNumber(session.measured_age_minutes)} ${t("min ago", "min temu")}`
            : "—"}
        </span>
      </div>
      <div style={{ marginTop: "var(--s-5)", paddingTop: "var(--s-5)", borderTop: "var(--rule)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <Line label={t("Window usage", "Zużycie w oknie")} value={usd(session.spend.usd)} title={t("API-equivalent cost of these 5 hours at the API price.", "API-eq: ile te 5 h kosztowałoby po cenniku API.")} />
        <Line label={t("Tokens", "Tokeny")} value={`${compact(session.spend.gross)} · ${compact(session.spend.fresh)} ${t("without cache", "bez cache")}`} />
        <Line label={t("Calls", "Wywołania")} value={full(session.spend.calls)} />
        <Line
          label={t("Pace", "Tempo")}
          value={ahead == null ? "—" : `${signedPp(ahead)} ${t("vs time", "vs czas")}`}
          tone={ahead != null && ahead > 15 ? "var(--warn)" : ahead != null && ahead < -15 ? "var(--ok)" : undefined}
        />
      </div>
      <div className="mono" style={{ marginTop: "var(--s-4)", fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.5 }}>
        {t(
          "The session cap is not calibrated. This shows percentage and usage, not how many dollars remain.",
          "Pułap sesji nie jest skalibrowany — dlatego jest tu procent i zużycie, a nie „ile dolarów zostało”."
        )}
      </div>
    </Card>
  );
}
function ClaudeCaveats({
  caveats,
  fableShare,
  cur,
}: {
  caveats: string[];
  fableShare: number | null;
  cur: Current;
}) {
  const { t } = useI18n();
  const bp = useBreakpoint();
  const cols = splitColumns(bp);
  const bars = claudeReading(cur);
  return (
    <section style={{ display: "grid", gridTemplateColumns: cols, gap: "var(--s-8)" }}>
      <Card>
        <CardTitle title={t("Why these numbers are estimates", "Dlaczego te liczby są estymatami")} help={t("Caveats from claude-gauge.json.", "Zastrzeżenia z claude-gauge.json.")} />
        <div style={{ marginTop: "var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          {caveats.length === 0 && (
            <span className="mono" style={{ fontSize: "var(--fs-4)", color: "var(--muted)" }}>
              {t("No caveats in the configuration.", "Brak zastrzeżeń w konfiguracji.")}
            </span>
          )}
          {caveats.map((c, i) => (
            <div key={i} style={{ display: "flex", gap: "var(--s-4)", padding: "var(--s-4) var(--s-5)", borderRadius: "var(--r-chip)", background: "var(--sunk)" }}>
              <span style={{ width: 4, borderRadius: "var(--r-bar)", background: "var(--warn)", flex: "0 0 4px" }} />
              <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.55 }}>
                {c}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardTitle title={t("Two bars, not one", "Dwa słupki, nie jeden")} help={t("The account-wide limit and the Fable sub-limit.", "Limit całego konta i podlimit Fable.")} />
        <div style={{ marginTop: "var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
          <BarRow
            label="All models"
            value={bars.percentAll}
            color="var(--claude)"
             note={`${usd(cur.spend.usd)} · ${full(cur.spend.calls)} ${t("calls", "wywołań")} · ${bars.measured ? t("from account", "z konta") : t("from index", "z indeksu")}`}
          />
          <BarRow
            label="Fable"
            value={bars.percentFable}
            color="var(--violet)"
             note={`${usd(cur.fable_spend.usd)} · ${full(cur.fable_spend.calls)} ${t("calls", "wywołań")} · ${
               bars.fableMeasured ? t("from account", "z konta") : t("from index", "z indeksu")
             }`}
          />
        </div>
        <div className="mono" style={{ marginTop: "var(--s-6)", fontSize: "var(--fs-2)", color: "var(--faint)", lineHeight: 1.55 }}>
           {t(
             "Fable has its own weekly bar worth {0} the account window, and its usage counts toward both. This second bar makes it possible to measure the cost per point at all. Two independent readings share one scale.",
             `Fable ma własny tygodniowy słupek wart ${fableShare != null ? `${localizedNumber(fableShare * 100)}%` : "część"} okna kontowego, a jego zużycie liczy się do obu. To ten drugi słupek pozwala w ogóle zmierzyć koszt punktu — dwa niezależne odczyty na jednej skali.`, [fableShare != null ? `${localizedNumber(fableShare * 100)}%` : "a share of"]
           )}
        </div>
      </Card>
    </section>
  );
}
function BarRow({ label, value, color, note }: { label: string; value: number | null; color: string; note: string }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--s-2)" }}>
        <span style={{ fontSize: "var(--fs-4)", color: "var(--muted)" }}>{label}</span>
        <span style={{ fontSize: "var(--fs-5)", fontFamily: "var(--font-figure)", fontWeight: "var(--fw-semibold)" }}>
          {pct(value)}
        </span>
      </div>
      <div style={{ height: 8, boxSizing: "border-box", background: "var(--sunk)", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(100, value ?? 0)}%`, background: color }} />
      </div>
      <div className="mono" style={{ marginTop: "var(--s-1)", fontSize: "var(--fs-2)", color: "var(--muted)" }}>
        {note}
      </div>
    </div>
  );
}
function Line({ label, value, tone, title }: { label: string; value: React.ReactNode; tone?: string; title?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-4)" }} title={title}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-figure)", fontWeight: "var(--fw-medium)", letterSpacing: "var(--ls-tight)", color: tone ?? "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}
