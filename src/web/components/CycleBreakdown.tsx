import { TableGrid, TableGridRow } from "./DataTable";
import type { CycleBreakdownResponse, CycleDay, CycleSession, ShortCounterState } from "../lib/api";
import { Card, CardTitle, Eyebrow } from "./ui";
import { clockTime, compact, dayMonth, pct, relativeTime, usd } from "../lib/format";
import { getLocale, useI18n } from "../lib/i18n";
const DOW = [["Mon", "pon"], ["Tue", "wt"], ["Wed", "śr"], ["Thu", "czw"], ["Fri", "pt"], ["Sat", "sob"], ["Sun", "niedz"]] as const;
export interface DayRow extends CycleDay {
  percentPoints: number | null;
  derived: boolean;
}
function toRow(d: CycleDay, tokensPerPercent: number | null): DayRow {
  if (d.gauge_delta != null && d.gauge_samples > 0) {
    return { ...d, percentPoints: Math.max(0, d.gauge_delta), derived: false };
  }
  if (tokensPerPercent != null && tokensPerPercent > 0 && d.tokens > 0) {
    return { ...d, percentPoints: d.tokens / tokensPerPercent, derived: true };
  }
  return { ...d, percentPoints: d.tokens > 0 ? null : 0, derived: false };
}
export function CycleBreakdown({
  data,
  windowHours,
  tokensPerPercent,
  loading,
  error,
  columns,
}: {
  data: CycleBreakdownResponse | null;
  windowHours: number;
  tokensPerPercent: number | null;
  loading: boolean;
  error: string | null;
  columns: string;
}) {
  const { t } = useI18n();
  const days = (data?.days ?? []).map((d) => toRow(d, tokensPerPercent));
  const windowDays = Math.max(1, windowHours / 24);
  const sustainablePp = 100 / windowDays;
  const maxPp = Math.max(sustainablePp, ...days.map((d) => d.percentPoints ?? 0));
  const scale = maxPp > 0 ? maxPp * 1.08 : 1;
  return (
    <TableGrid tableId="CycleBreakdown:days"><section style={{ display: "grid", gridTemplateColumns: columns, gap: 14 }}>
      <Card>
        <CardTitle
          title={t("Daily breakdown", "Podział na dni")}
          sub={
            data
              ? `${days.length} ${t("days in this window", "dni tego okna")} · ${t("sustainable pace", "tempo zrównoważone")} ${sustainablePp.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp/${t("day", "dzień")}`
              : t("loading…", "wczytywanie…")
          }
          right={
            <div className="mono" style={{ display: "flex", gap: 12, fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: "var(--accent)" }} />
                {t("measured from gauge", "zmierzone ze wskaźnika")}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: "var(--violet)" }} />
                {t("calculated from tokens", "wyliczone z tokenów")}
              </span>
            </div>
          }
        />
        {error && (
          <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-4)", color: "var(--crit)" }}>
            {error}
          </div>
        )}
        {!error && loading && days.length === 0 && (
          <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-4)", color: "var(--muted)" }}>
            {t("Loading daily breakdown…", "Wczytywanie podziału dziennego…")}
          </div>
        )}
        {!error && !loading && days.length === 0 && (
          <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-4)", color: "var(--muted)" }}>
            {t("This window does not cover a full day yet.", "To okno nie objęło jeszcze pełnej doby.")}
          </div>
        )}
        {days.length > 0 && (
          <>
            <TableGridRow header
              className="mono"
              style={{
                marginTop: 12,
                display: "grid",
                gridTemplateColumns: "76px 58px 1fr 68px 52px 58px",
                gap: 10,
                padding: "0 2px var(--s-3)",
                borderBottom: "1px solid var(--line2)",
                fontSize: "var(--fs-2)",
                color: "var(--muted)",
              }}
            >
              <span>{t("day", "dzień")}</span>
              <span style={{ textAlign: "right" }}>pp</span>
              <span>{t("vs sustainable", "vs tempo zrównoważone")}</span>
              <span style={{ textAlign: "right" }}>{t("tokens", "tokeny")}</span>
              <span style={{ textAlign: "right" }}>{t("calls", "wywołania")}</span>
              <span style={{ textAlign: "right" }}>API-eq</span>
            </TableGridRow>
            {days.map((d) => (
              <DayLadderRow key={d.date} row={d} scale={scale} sustainablePp={sustainablePp} />
            ))}
            <div
              className="mono"
              style={{ marginTop: 8, display: "flex", gap: 14, fontSize: "var(--fs-3)", color: "var(--faint)", flexWrap: "wrap" }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 1, height: 9, background: "var(--text)", opacity: 0.55 }} />
                {t("sustainable pace", "tempo zrównoważone")} {sustainablePp.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp/{t("day", "dzień")}
              </span>
              <span style={{ marginLeft: "auto" }}>
                {t("The first and last day are partial - pp covers that part of the window, not a full day.", "pierwszy i ostatni dzień są niepełne — kolumna pp nie jest za dobę, tylko za tę część okna")}
              </span>
            </div>
          </>
        )}
      </Card>
      <SessionsCard
        sessions={data?.sessions ?? []}
        short={data?.short_counter ?? null}
        windowMinutes={data?.session_window_minutes ?? 300}
        loading={loading}
        error={error}
      />
    </section></TableGrid>
  );
}
function DayLadderRow({
  row,
  scale,
  sustainablePp,
}: {
  row: DayRow;
  scale: number;
  sustainablePp: number;
}) {
  const { language, t } = useI18n();
  const pp = row.percentPoints;
  const budget = sustainablePp * Math.min(1, row.hours / 24);
  const over = pp != null && budget > 0 && pp > budget * 1.15;
  const under = pp != null && budget > 0 && pp < budget * 0.6;
  const fill = row.derived ? "var(--violet)" : over ? "var(--warn)" : "var(--accent)";
  return (
    <TableGridRow
      className="mono"
      title={
        `${row.date} · ${row.hours.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h ${t("in window", "w oknie")} · ${t("budget", "budżet")} ${budget.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp\n` +
        (row.derived
          ? t("No gauge sample on this day - pp calculated from tokens using tokens/% calibration.", "Brak próbki wskaźnika w tym dniu — pp wyliczone z tokenów przez kalibrację tokens/%.")
          : `${t("Gauge", "Wskaźnik")}: ${row.gauge_samples} ${t("samples", "próbek")}, ${t("at end of day", "na koniec dnia")} ${pct(row.gauge_end, 1)}.`) +
        (row.top_model ? `\n${t("Most common model", "Najczęstszy model")}: ${row.top_model}` : "")
      }
      style={{
        display: "grid",
        gridTemplateColumns: "76px 58px 1fr 68px 52px 58px",
        gap: 10,
        alignItems: "center",
        padding: "6px 2px",
        borderBottom: "var(--rule)",
        background: row.is_today ? "var(--accent-soft)" : "transparent",
      }}
    >
      <span style={{ fontSize: "var(--fs-3)", color: row.is_today ? "var(--text)" : "var(--muted)", fontWeight: row.is_today ? 600 : 400 }}>
        {(DOW[row.dow] ? t(DOW[row.dow]![0], DOW[row.dow]![1]) : undefined)} {dayMonth(row.from_ts)}
      </span>
      <span
        style={{
          fontSize: "var(--fs-4)",
          fontWeight: 500,
          fontFamily: "var(--font-figure)",
          letterSpacing: "-0.02em",
          textAlign: "right",
          color: pp == null ? "var(--faint)" : over ? "var(--warn)" : under ? "var(--ok)" : "var(--text)",
        }}
      >
        {pp == null ? "—" : `${pp.toFixed(1)}`}
        {pp != null && row.derived && <span style={{ color: "var(--faint)" }}>*</span>}
      </span>
      <span
        style={{
          position: "relative",
          display: "block",
          height: 9,
          background: "var(--sunk)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
        }}
      >
        {pp != null && (
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${Math.min(100, (pp / scale) * 100)}%`,
              background: fill,
              display: "block",
            }}
          />
        )}
        <span
          title={`${t("day budget", "budżet tego dnia")}: ${budget.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${Math.min(100, (budget / scale) * 100)}%`,
            width: 1,
            background: "var(--text)",
            opacity: 0.55,
            display: "block",
          }}
        />
      </span>
      <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--muted)" }}>{compact(row.tokens)}</span>
      <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--faint)" }}>{row.calls || "—"}</span>
      <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: "var(--faint)" }}>{row.usd > 0 ? `${row.usd_partial ? "≥ " : ""}${usd(row.usd)}` : "—"}</span>
    </TableGridRow>
  );
}
function SessionsCard({
  sessions,
  short,
  windowMinutes,
  loading,
  error,
}: {
  sessions: CycleSession[];
  short: ShortCounterState | null;
  windowMinutes: number;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const label = `${Math.round(windowMinutes / 60)}h`;
  const ordered = [...sessions].reverse();
  const worked = sessions.filter((s) => s.calls > 0).length;
  const maxTokens = Math.max(1, ...sessions.map((s) => s.tokens));
  const live = short?.live ?? null;
  const others = short?.other ?? [];
  const shown = ordered.slice(0, 14);
  return (
    <Card>
      <CardTitle
        title={`${t("Sessions", "Sesje")} ${label}`}
        help={`${t("Fixed blocks", "Stałe bloki")} ${label} ${t("counted from the cycle start.", "liczone od startu cyklu.")}`}
        right={
          sessions.length > 0 ? (
            <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
              {worked} {t("of", "z")} {sessions.length} {t("blocks with traffic", "bloków z ruchem")}
            </span>
          ) : undefined
        }
      />
      {live && <ShortCounterBox row={live} label={label} own />}
      {!live && others.length > 0 && <ShortCounterBox row={others[0]!} label={label} own={false} />}
      {short && !short.reported && (
        <div className="mono" style={{ marginTop: 10, fontSize: "var(--fs-3)", color: "var(--faint)", lineHeight: 1.55 }}>
          {t("The account does not report the short window for the plan limit", "Konto nie raportuje krótkiego okna dla limitu planu")}
          {short.last_reported_ts ? ` ${t("since", "od")} ${dayMonth(short.last_reported_ts)}` : ""} — {t("the blocks below are measured from the event index, not the vendor counter.", "bloki poniżej są zmierzone z indeksu zdarzeń, nie z licznika vendora.")}
        </div>
      )}
      {error && (
        <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-4)", color: "var(--crit)" }}>
          {error}
        </div>
      )}
      {!error && loading && sessions.length === 0 && (
        <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-4)", color: "var(--muted)" }}>
          {t("Loading", "Wczytywanie")} {t("blocks", "bloków")} {label}…
        </div>
      )}
      {!error && !loading && sessions.length === 0 && (
        <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-4)", color: "var(--muted)" }}>
          {t("This cycle does not have a full", "Cykl nie ma jeszcze pełnego bloku")} {label}.
        </div>
      )}
      {shown.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column" }}>
          {shown.map((s) => (
            <SessionRow key={s.index} s={s} maxTokens={maxTokens} />
          ))}
          {ordered.length > shown.length && (
            <div className="mono" style={{ marginTop: 8, fontSize: "var(--fs-3)", color: "var(--faint)" }}>
              +{ordered.length - shown.length} {t("earlier blocks in this cycle", "wcześniejszych bloków w tym cyklu")}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
function ShortCounterBox({
  row,
  label,
  own,
}: {
  row: NonNullable<ShortCounterState["live"]>;
  label: string;
  own: boolean;
}) {
  const { t } = useI18n();
  const spent = row.rate_limit_reached;
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: "var(--r-chip)",
        background: spent ? "var(--crit-soft)" : "var(--sunk)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Eyebrow>{own ? `${t("Plan", "Licznik")} ${label}` : `${t("Other counter", "Inny licznik")} ${label} ${t("on this account", "na tym koncie")}`}</Eyebrow>
        <span className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)" }}>
          konto · {relativeTime(row.ts)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
        <span
          className="ui-figure"
          style={{ fontSize: "var(--fs-8)", color: spent ? "var(--crit)" : "var(--text)" }}
        >
          {pct(row.used_percent)}
        </span>
        <span style={{ fontSize: "var(--fs-4)", color: "var(--muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {spent ? t("window exhausted", "okno wyczerpane") : own ? t("short limit", "krótkiego limitu") : row.limit_name ?? row.limit_id}
        </span>
        {row.resets_at_iso && (
          <span className="mono" style={{ marginLeft: "auto", fontSize: "var(--fs-3)", color: "var(--muted)", whiteSpace: "nowrap" }}>
            reset {clockTime(row.resets_at_iso)}
          </span>
        )}
      </div>
      <div
        style={{
          height: 6,
          marginTop: 6,
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, row.used_percent)}%`,
            background: spent ? "var(--crit)" : own ? "var(--accent)" : "var(--violet)",
          }}
        />
      </div>
      {!own && (
        <div className="mono" style={{ marginTop: 6, fontSize: "var(--fs-3)", color: "var(--faint)", lineHeight: 1.5 }}>
          {t("This is a separate allowance", "To osobny limit")} (<span style={{ color: "var(--muted)" }}>{row.limit_id}</span>), {t("not part of the plan limit - it is not added to it.", "nie część limitu planu — nie sumuje się z nim.")}
        </div>
      )}
    </div>
  );
}
function SessionRow({ s, maxTokens }: { s: CycleSession; maxTokens: number }) {
  const { t } = useI18n();
  const quiet = s.calls === 0;
  const fill = s.reported_percent != null ? "var(--accent)" : "var(--violet)";
  return (
    <div
      className="mono"
      title={
        `${dayMonth(s.start_ts)} ${clockTime(s.start_ts)} → ${clockTime(s.end_ts)}\n` +
        (quiet
          ? t("No calls in this block.", "Brak wywołań w tym bloku.")
          : `${compact(s.tokens)} ${t("gross tokens", "tokenów brutto")}, ${compact(s.tokens_fresh)} ${t("without cache", "bez cache")}, ${s.calls} ${t("calls", "wywołań")}, ${s.usd_partial ? s.usd > 0 ? "≥ " + usd(s.usd) : "—" : usd(s.usd)} API-eq`) +
        (s.top_model ? `\n${t("Most common model", "Najczęstszy model")}: ${s.top_model}` : "") +
        (s.reported_percent != null
          ? `\n${t("The plan counter closed the window at", "Licznik planu zamknął okno na")} ${pct(s.reported_percent)} (${s.reported_samples} ${t("samples", "próbek")}).`
          : `\n${t("The vendor did not report a short window ending in this block.", "Vendor nie zaraportował krótkiego okna kończącego się w tym bloku.")}`)
      }
      style={{
        display: "grid",
        gridTemplateColumns: "94px 1fr 58px 46px",
        gap: 9,
        alignItems: "center",
        padding: "6px 2px",
        borderBottom: "var(--rule)",
        background: s.active ? "var(--accent-soft)" : "transparent",
        opacity: quiet && !s.active ? 0.55 : 1,
      }}
    >
      <span style={{ fontSize: "var(--fs-3)", color: s.active ? "var(--text)" : "var(--muted)", whiteSpace: "nowrap" }}>
        {dayMonth(s.start_ts)} {clockTime(s.start_ts)}
      </span>
      <span
        style={{
          position: "relative",
          display: "block",
          height: 8,
          background: "var(--sunk)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${(s.tokens / maxTokens) * 100}%`,
            background: fill,
            display: "block",
          }}
        />
      </span>
      <span style={{ fontSize: "var(--fs-3)", fontFamily: "var(--font-figure)", letterSpacing: "-0.02em", textAlign: "right", color: quiet ? "var(--faint)" : "var(--muted)" }}>
        {quiet ? "—" : compact(s.tokens)}
      </span>
      <span
        style={{
          fontSize: "var(--fs-3)",
          fontFamily: "var(--font-figure)",
          letterSpacing: "-0.02em",
          textAlign: "right",
          fontWeight: 500,
          color: s.reported_percent == null ? "var(--faint)" : s.reported_percent >= 90 ? "var(--crit)" : "var(--muted)",
        }}
      >
        {s.reported_percent == null ? "·" : pct(s.reported_percent)}
      </span>
    </div>
  );
}
