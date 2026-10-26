import { useMemo } from "react";
import type { ApiPoint } from "../lib/api";
import type { CycleView } from "../lib/cycle";
import { milestones } from "../lib/cycle";
import { compact, dayTime, duration, full, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { Card, CardTitle, Eyebrow } from "./ui";
function medianOf(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid] ?? null;
  const lo = v[mid - 1];
  const hi = v[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}
export function UsageComposition({ cycle }: { cycle: CycleView }) {
  const { t } = useI18n();
  const tokens = cycle.raw.tokens;
  const freshIn = Math.max(0, tokens.in - tokens.cached_in);
  const reasoning = Math.min(tokens.out, Math.max(0, tokens.reasoning));
  const parts = [
    { label: t("input (cached)", "input (z cache)"), tokens: tokens.cached_in, color: "var(--accent)" },
    { label: t("input (fresh)", "input (świeży)"), tokens: freshIn, color: "var(--violet)" },
    { label: t("output (without reasoning)", "output (bez rozumowania)"), tokens: tokens.out - reasoning, color: "var(--ok)" },
    { label: t("reasoning (within output)", "rozumowanie (w output)"), tokens: reasoning, color: "var(--warn)" },
  ];
  const total = parts.reduce((acc, p) => acc + p.tokens, 0);
  const denom = total > 0 ? total : 1;
  const rows = [...parts.map((p) => {
    const share = (p.tokens / denom) * 100;
    return { ...p, pctStr: total > 0 ? pct(share, 1) : "0%", w: `${Math.max(0, share).toFixed(1)}%` };
  }), ...(tokens.cache_write > 0 ? [{ label: t("cache write (overlap unknown)", "zapis cache (pokrywanie nieznane)"), tokens: tokens.cache_write, color: "color-mix(in oklab, var(--violet) 45%, var(--faint))", pctStr: t("unknown", "nieznany"), w: "0%" }] : [])];
  return (
    <Card>
      <CardTitle title={t("Token composition", "Podział tokenów")} sub={`${compact(total)} ${t("gross", "brutto")}`} />
      <div
        style={{
          marginTop: 12,
          display: "flex",
          height: 12,
          borderRadius: "var(--r-bar)",
          overflow: "hidden",
          border: "1px solid var(--line)",
          background: "var(--sunk)",
        }}
      >
        {rows
          .filter((r) => r.tokens > 0 && r.w !== "0%")
          .map((r) => (
            <div key={r.label} title={`${r.label}: ${compact(r.tokens)} (${r.pctStr})`} style={{ width: r.w, background: r.color, minWidth: 2 }} />
          ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-4)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "var(--r-bar)", background: r.color, flexShrink: 0 }} />
            <span style={{ color: "var(--text)" }}>{r.label}</span>
            <span className="mono" style={{ marginLeft: "auto", color: "var(--muted)" }} title={`${full(r.tokens)} ${t("tokens", "tokenów")}`}>
              {compact(r.tokens)}
            </span>
            <span className="mono" style={{ width: 46, textAlign: "right", color: "var(--text)", fontWeight: 500 }}>
              {r.pctStr}
            </span>
          </div>
        ))}
      </div>
      <div className="mono" style={{ marginTop: 12, fontSize: "var(--fs-3)", color: "var(--muted)", lineHeight: 1.5 }}>
        {t("Total = input + output. Cache reads are within input; reasoning is within output. Cache writes are shown separately because their overlap is unknown.", "Suma = input + output. Odczyty cache są częścią inputu, a rozumowanie częścią outputu. Zapis cache pokazano osobno, bo jego pokrywanie się z inputem jest nieznane.")}
      </div>
    </Card>
  );
}
const MARKS = [25, 50, 75, 90, 100];
/**
 * Time to reach each allowance threshold on the window's time axis: reached (dot), usual median
 * of earlier windows (diamond) and, while the window is open, when the current pace gets there.
 */
export function CycleMilestones({
  cycle,
  points,
  typical,
  perHour,
}: {
  cycle: CycleView;
  points: ApiPoint[];
  typical: CycleView[];
  /** Average percentage points per hour since the window start; null when no fresh reading. */
  perHour: number | null;
}) {
  const { t } = useI18n();
  const medians = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const mark of MARKS) {
      const list: number[] = [];
      for (const c of typical) {
        const h = milestones(c, points, [mark])[0]?.hours;
        if (h != null && Number.isFinite(h)) list.push(h);
      }
      map.set(mark, medianOf(list));
    }
    return map;
  }, [typical, points]);
  const span = cycle.windowHours;
  const at = (h: number) => `${Math.max(0, Math.min(100, (h / span) * 100))}%`;
  const startMs = new Date(cycle.startIso).getTime();
  const rows = milestones(cycle, points, MARKS).map((m) => {
    const usual = medians.get(m.mark) ?? null;
    const projected = cycle.isActive && m.hours == null && perHour != null && perHour > 0 ? m.mark / perHour : null;
    let text: string, color = "var(--muted)";
    if (m.hours != null) {
      const diff = usual == null ? null : m.hours - usual;
      text = `${duration(m.hours)}` + (diff == null ? ` · ${t("no median", "brak mediany")}`
        : Math.abs(diff) < 0.5 ? ` · ${t("as usual", "jak zwykle")}`
        : ` · ${diff < 0 ? "−" : "+"}${duration(Math.abs(diff))}`);
      if (diff != null && Math.abs(diff) >= 0.5) color = diff < 0 ? "var(--warn)" : "var(--ok)";
    } else if (projected != null && projected <= span) {
      text = `${t("pace", "tempo")}: ${dayTime(new Date(startMs + projected * 3_600_000).toISOString())}`;
      color = "var(--crit)";
    } else {
      text = cycle.isActive ? t("not before reset", "nie przed resetem") : t("not reached", "nie osiągnięto");
      color = "var(--faint)";
    }
    return { mark: m.mark, hours: m.hours, usual, projected: projected != null && projected <= span ? projected : null, text, color };
  });
  return (
    <Card>
      <Eyebrow>{t("Milestones", "Kamienie milowe")} · ● {t("reached", "osiągnięte")} · ◆ {t("usual", "zwykle")} · ○ {t("current pace", "obecne tempo")}
        {" · "}{t("median of {0} windows", `mediana z ${typical.length} okien`, [typical.length])}</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "44px 1fr 190px", gap: "9px 12px", alignItems: "center", marginTop: 10 }}>
        {rows.map((r) => [
          <span key={`${r.mark}-l`} className="mono" style={{ fontSize: "var(--fs-4)", fontWeight: 600 }}>{r.mark}%</span>,
          <div key={`${r.mark}-b`} style={{ position: "relative", height: 10, borderRadius: "var(--r-bar)", background: "var(--sunk)", border: "1px solid var(--line)" }}>
            <div style={{ position: "absolute", inset: "0 auto 0 0", width: at(cycle.elapsedHours), borderRadius: "var(--r-bar)", background: "color-mix(in oklab, var(--accent) 16%, transparent)" }} />
            {r.usual != null && <span title={t("usual", "zwykle")} style={{ ...dot, left: at(r.usual), width: 8, height: 8, borderRadius: 0, background: "var(--muted)", transform: "translate(-50%, -50%) rotate(45deg)" }} />}
            {r.projected != null && <span title={t("at current pace", "przy obecnym tempie")} style={{ ...dot, left: at(r.projected), border: "2px solid var(--crit)", background: "var(--surface)" }} />}
            {r.hours != null && <span title={t("reached", "osiągnięte")} style={{ ...dot, left: at(r.hours), background: "var(--accent)" }} />}
          </div>,
          <span key={`${r.mark}-t`} className="mono" style={{ fontSize: "var(--fs-3)", color: r.color, whiteSpace: "nowrap" }}>{r.text}</span>,
        ])}
      </div>
    </Card>
  );
}

const dot = { position: "absolute", top: "50%", width: 10, height: 10, borderRadius: "var(--r-dot)", transform: "translate(-50%, -50%)" } as const;
