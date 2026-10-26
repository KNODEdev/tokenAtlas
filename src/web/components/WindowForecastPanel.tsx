import type { CSSProperties, ReactNode } from "react";
import { compact, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { Card, Eyebrow } from "./ui";

/** One unit of the window budget; `rate` is the unit's value of one percentage point. */
export interface BudgetUnit {
  key: string;
  label: string;
  rate: number | null;
  used: number | null;
  /** Incomplete pricing: every derived amount is a lower bound. */
  partial: boolean;
  /** The used amount itself is an estimate (e.g. a conditional share of the account), not an indexed total. */
  estimated?: boolean;
  cap: number | null;
  format: (value: number) => string;
}

const endColor = (value: number | null) => value == null ? "var(--text)" : value >= 100 ? "var(--crit)" : value >= 90 ? "var(--warn)" : "var(--text)";
const cell: CSSProperties = { padding: "var(--s-4) 0", borderTop: "var(--rule)", minWidth: 0, whiteSpace: "nowrap" };
const head: CSSProperties = { paddingBottom: "var(--s-2)", textAlign: "right", whiteSpace: "nowrap" };
// Amounts are read-outs: the figure voice, as in the tables' numeric columns.
const figure: CSSProperties = { fontFamily: "var(--font-figure)", fontWeight: "var(--fw-medium)", letterSpacing: "var(--ls-tight)" };

/**
 * Used, remaining and end-of-window amounts in every unit the window can be valued in.
 * Bars share one percentage scale, so the markers line up across units.
 */
export function BudgetCard({ units, usedPercent, typicalEnd, linearEnd, active, foot }: {
  units: BudgetUnit[]; usedPercent: number; typicalEnd: number | null; linearEnd: number | null; active: boolean; foot?: ReactNode;
}) {
  const { t } = useI18n();
  const capPercent = (u: BudgetUnit) => u.cap != null && u.rate != null && u.rate > 0 ? (u.cap / u.rate) * 100 : null;
  const scale = Math.min(250, Math.max(100, typicalEnd ?? 0, linearEnd ?? 0, ...units.map((u) => capPercent(u) ?? 0)) * 1.04);
  const at = (p: number) => `${(Math.max(0, p) / scale) * 100}%`;
  const amount = (u: BudgetUnit, percent: number | null) => u.rate == null || percent == null ? "—"
    : `${u.partial ? "≥ " : u.key === "percent" ? "" : "≈ "}${u.format(u.rate * Math.max(0, percent))}`;
  const ends = (u: BudgetUnit) => [typicalEnd, linearEnd].map((p) => amount(u, p)).join(" · ");
  return (
    <Card>
      <Eyebrow>{t("Window budget", "Budżet okna")} · ▮ {t("used", "użyte")} · ░ {t("left", "zostało")} · │ 100%
        {active && <> · <span style={{ color: "var(--accent)" }}>●</span> {t("typical", "typowo")} · <span style={{ color: "var(--crit)" }}>●</span> {t("current pace", "obecne tempo")}</>}
        {" · "}◆ {t("historical cap", "cap z historii")}</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "64px minmax(200px, 1fr) auto auto auto auto", columnGap: "var(--s-7)", alignItems: "center", fontSize: "var(--fs-4)", marginTop: "var(--s-5)" }}>
        <span />
        <span />
        <Eyebrow style={head}>{t("used", "użyte")}</Eyebrow>
        <Eyebrow style={head}>{t("left", "zostało")}</Eyebrow>
        <Eyebrow style={head}>{active ? t("at reset: typical · pace", "na reset: typowo · tempo") : t("window result", "wynik okna")}</Eyebrow>
        <Eyebrow style={head}>{t("historical cap", "cap z historii")}</Eyebrow>
        {units.map((u) => {
          const cap = capPercent(u);
          return [
            <span key={`${u.key}-l`} className="mono" style={{ ...cell, color: "var(--muted)" }}>{u.label}</span>,
            <div key={`${u.key}-b`} style={cell}>
              <div style={{ position: "relative", height: 12, boxSizing: "border-box", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", background: "var(--sunk)" }}>
                <div style={{ position: "absolute", inset: `0 auto 0 0`, width: at(Math.min(usedPercent, scale)), background: "var(--accent)", borderRadius: "inherit" }} />
                {usedPercent < 100 && <div style={{ position: "absolute", top: 2, bottom: 2, left: at(usedPercent), width: `calc(${at(100)} - ${at(usedPercent)})`, background: "color-mix(in oklab, var(--accent) 22%, transparent)" }} />}
                <div style={{ position: "absolute", top: -3, bottom: -3, width: 2, left: at(100), background: "var(--text)" }} />
                {cap != null && <Marker left={at(cap)} color="var(--muted)" diamond title={t("historical cap", "cap z historii")} />}
                {active && typicalEnd != null && <Marker left={at(typicalEnd)} color="var(--accent)" title={t("at reset · typical", "na reset · typowo")} />}
                {active && linearEnd != null && <Marker left={at(linearEnd)} color="var(--crit)" title={t("at reset · current pace", "na reset · obecne tempo")} />}
              </div>
            </div>,
            <span key={`${u.key}-u`} style={{ ...cell, ...figure, textAlign: "right" }}>
              {u.used == null ? "—" : `${u.partial ? "≥ " : u.estimated ? "≈ " : ""}${u.format(u.used)}`}</span>,
            <span key={`${u.key}-r`} style={{ ...cell, ...figure, textAlign: "right" }}>{amount(u, 100 - usedPercent)}</span>,
            <span key={`${u.key}-e`} style={{ ...cell, ...figure, textAlign: "right", color: endColor(Math.max(typicalEnd ?? 0, linearEnd ?? 0)) }}>
              {active ? ends(u) : amount(u, usedPercent)}</span>,
            <span key={`${u.key}-c`} style={{ ...cell, ...figure, textAlign: "right", color: "var(--muted)" }}>{u.cap == null ? "—" : `≈ ${u.format(u.cap)}`}</span>,
          ];
        })}
      </div>
      {foot && <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: "var(--s-4)" }}>{foot}</div>}
    </Card>
  );
}

function Marker({ left, color, diamond, title }: { left: string; color: string; diamond?: boolean; title: string }) {
  return <div title={title} style={{
    position: "absolute", top: "50%", left, width: diamond ? 8 : 10, height: diamond ? 8 : 10, background: color,
    border: diamond ? undefined : "2px solid var(--surface)", borderRadius: diamond ? 0 : "var(--r-dot)",
    transform: `translate(-50%, -50%)${diamond ? " rotate(45deg)" : ""}`,
  }} />;
}

/** Recent burn against the pace that still lasts until reset; `format` prints a per-day rate. */
export function PaceCard({ burns, sustainablePerDay, averagePerDay, active, format = (v) => `${compact(v)}/d` }: {
  burns: { label: string; perDay: number }[]; sustainablePerDay: number | null; averagePerDay: number | null; active: boolean;
  format?: (perDay: number) => string;
}) {
  const { t } = useI18n();
  const rows = [...burns, ...(averagePerDay != null ? [{ label: t("window", "okno"), perDay: averagePerDay }] : [])];
  const max = Math.max(1, sustainablePerDay ?? 0, ...rows.map((r) => r.perDay)) * 1.05;
  const change = active && sustainablePerDay != null && averagePerDay != null && averagePerDay > 0 ? (sustainablePerDay / averagePerDay - 1) * 100 : null;
  return (
    <Card>
      <Eyebrow>{active ? t("Pace now vs pace that lasts", "Tempo teraz a tempo, które wystarczy") : t("Recorded traffic before window end", "Zarejestrowany ruch przed końcem okna")}</Eyebrow>
      {change != null && <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-5)", marginTop: "var(--s-4)", fontSize: "var(--fs-4)" }}>
        <span className="ui-figure" style={{ fontSize: "var(--fs-8)", color: change < 0 ? "var(--crit)" : "var(--ok)" }}>
          {change < 0 ? `−${Math.round(-change)}%` : `+${Math.round(change)}%`}</span>
        <span style={{ color: "var(--muted)" }}>{change < 0
          ? t("slower pace needed for the allowance to last until reset", "tyle trzeba zwolnić, żeby limit wystarczył do resetu")
          : t("room left at the average pace", "zapasu przy średnim tempie")}</span>
      </div>}
      {rows.length === 0
        ? <div className="mono" style={{ fontSize: "var(--fs-4)", color: "var(--muted)", marginTop: "var(--s-5)" }}>{t("No recorded traffic yet.", "Brak zarejestrowanego ruchu.")}</div>
        : <div style={{ position: "relative", display: "grid", gridTemplateColumns: "56px 1fr 90px", gap: "var(--s-4) var(--s-6)", alignItems: "center", fontSize: "var(--fs-4)", marginTop: "var(--s-5)" }}>
          {rows.map((r) => [
            <span key={`${r.label}-l`} className="mono" style={{ color: "var(--muted)" }}>{r.label}</span>,
            <div key={`${r.label}-b`} style={{ position: "relative", height: 12 }}>
              <div style={{ height: 12, borderRadius: "var(--r-bar)", width: `${(r.perDay / max) * 100}%`,
                background: sustainablePerDay != null && active && r.perDay > sustainablePerDay ? "var(--crit)" : "var(--accent)" }} />
              {sustainablePerDay != null && active && <div style={{ position: "absolute", top: -4, bottom: -4, left: `${(sustainablePerDay / max) * 100}%`, borderLeft: "2px dashed var(--ok)" }} />}
            </div>,
            <span key={`${r.label}-v`} style={figure}>{format(r.perDay)}</span>,
          ])}
        </div>}
      {active && sustainablePerDay != null && <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--ok)", marginTop: "var(--s-3)" }}>┊ {t("lasts until reset", "starczy do resetu")}: {format(sustainablePerDay)}</div>}
    </Card>
  );
}

/** Differences from the previous comparable window, as bars left (less) or right (more); green is the better side. */
export function VersusCard({ title, rows, empty, note }: {
  title: string; rows: { key: string; label: string; delta: number; text: string; higherIsBetter: boolean }[]; empty: string; note: string;
}) {
  const scale = Math.max(50, ...rows.map((r) => Math.abs(r.delta)));
  return (
    <Card>
      <Eyebrow>{title}</Eyebrow>
      {rows.length === 0
        ? <div className="mono" style={{ fontSize: "var(--fs-4)", color: "var(--muted)", marginTop: "var(--s-5)" }}>{empty}</div>
        : <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr 70px", gap: "var(--s-4) var(--s-6)", alignItems: "center", fontSize: "var(--fs-4)", marginTop: "var(--s-5)" }}>
          {rows.map((r) => {
            const width = `${(Math.abs(r.delta) / scale) * 50}%`;
            return [
              <span key={`${r.key}-l`}>{r.label}</span>,
              <div key={`${r.key}-b`} style={{ position: "relative", height: 10, boxSizing: "border-box", border: "1px solid var(--line)", borderRadius: "var(--r-bar)", background: "var(--sunk)" }}>
                <div style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: "var(--line2)" }} />
                <div style={{ position: "absolute", top: 0, bottom: 0, borderRadius: "inherit", width, ...(r.delta < 0 ? { right: "50%" } : { left: "50%" }),
                  background: (r.delta > 0) === r.higherIsBetter ? "var(--ok)" : "var(--crit)" }} />
              </div>,
              <span key={`${r.key}-v`} style={{ ...figure, textAlign: "right" }}>{r.text}</span>,
            ];
          })}
        </div>}
      <div className="mono" style={{ fontSize: "var(--fs-3)", color: "var(--muted)", marginTop: "var(--s-4)", lineHeight: 1.5 }}>{note}</div>
    </Card>
  );
}

export const percentUnit = (label: string, usedPercent: number): BudgetUnit => ({
  key: "percent", label, rate: 1, used: usedPercent, partial: false, cap: null, format: (v) => pct(v),
});
