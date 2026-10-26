import { useMemo } from "react";
import type { ApiPoint } from "../lib/api";
import type { CycleView } from "../lib/cycle";
import { milestones } from "../lib/cycle";
import { compact, dayTime, duration, full, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { Card, CardTitle, EmptyState, ErrorState, Eyebrow, Fact, Facts, HelpBlock, LoadingCard } from "./ui";
import type { WindowTokenCounts } from "../../shared/window-model-usage";
import { freshWindowInput, totalWindowTokens, windowTokenDefinitions, windowTokenLabels } from "../lib/window-tokens";
import "./CodexWindowModels.css";
function medianOf(xs: number[]): number | null {
  const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  if (v.length % 2 === 1) return v[mid] ?? null;
  const lo = v[mid - 1];
  const hi = v[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}
export function TokenComposition({ tokens, loading = false, error = null }: {
  tokens: WindowTokenCounts | null;
  loading?: boolean;
  error?: string | null;
}) {
  const { t } = useI18n();
  const labels = windowTokenLabels(t), definitions = windowTokenDefinitions(t);
  if (error) return <ErrorState message={error} />;
  if (tokens == null) return loading
    ? <LoadingCard label={t("Loading token composition…", "Wczytywanie podziału tokenów…")} height={180} />
    : <EmptyState title={t("Token composition is not prepared yet", "Podział tokenów jeszcze nieprzygotowany")} />;
  const total = totalWindowTokens(tokens);
  const parts = [
    { key: "cached", label: labels.cached, tokens: tokens.cached, color: "var(--accent)" },
    { key: "fresh", label: labels.fresh, tokens: freshWindowInput(tokens), color: "var(--violet)" },
    { key: "cache_write", label: labels.cache_write, tokens: tokens.cache_write, color: "var(--warn)" },
    { key: "output", label: labels.output, tokens: tokens.output, color: "var(--ok)" },
  ] as const;
  return <Card>
    <CardTitle title={t("Token composition", "Podział tokenów")} sub={`${compact(total)} ${t("total", "razem")}`}
      help={<>{Object.values(definitions).map(definition => <HelpBlock key={definition}>{definition}</HelpBlock>)}
        <HelpBlock>{t("Percentages beside token types divide by all tokens in the window. Cache / In divides by all input only.", "Procenty przy typach tokenów odnoszą się do wszystkich tokenów okna. Cache / In odnosi się wyłącznie do całego inputu.")}</HelpBlock></>} />
    <Facts>
      <Fact label={<span title={definitions.input}>{labels.input}</span>} value={compact(tokens.input)} />
      <Fact label={<span title={definitions.cache_share}>{labels.cache_share}</span>}
        value={tokens.input > 0 ? pct(100 * tokens.cached / tokens.input, 1) : "—"} />
    </Facts>
    <div className="codex-models-split-bar">
      {parts.filter(part => part.tokens > 0).map(part => <span key={part.key}
        title={`${part.label}: ${full(part.tokens)} (${pct(total > 0 ? 100 * part.tokens / total : 0, 1)})`}
        style={{ width: `${total > 0 ? 100 * part.tokens / total : 0}%`, background: part.color }} />)}
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)", marginTop: "var(--s-6)" }}>
      {parts.map(part => <div key={part.key} title={definitions[part.key] + (part.key === "output" && tokens.reasoning > 0
        ? ` ${t("Including reasoning", "W tym rozumowanie")}: ${full(tokens.reasoning)}.` : "")}
        style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", fontSize: "var(--fs-4)" }}>
        <span className="codex-models-split-dot" style={{ background: part.color }} />
        <span>{part.label}</span>
        <span className="mono" style={{ marginLeft: "auto", color: "var(--muted)" }} title={full(part.tokens)}>{compact(part.tokens)}</span>
        <span className="mono" style={{ minWidth: "var(--s-10)", textAlign: "right" }}>{total > 0 ? pct(100 * part.tokens / total, 1) : "—"}</span>
      </div>)}
    </div>
  </Card>;
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
