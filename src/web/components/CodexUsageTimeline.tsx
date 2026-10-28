import { calendarTimeTicks } from "../lib/chart-dates";
import { useWidth } from "./WindowStatusCard";
import { ChartExport } from "./ChartExport";
import { useMemo, useState, type ReactNode } from "react";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
import { compact, usageModelLabel } from "../lib/format";
import { modelColorsByTokens } from "../lib/model-colors";
import { getLocale, useI18n } from "../lib/i18n";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { capacityPerPoint } from "../lib/codex-capacity";
import { capacityWithContext } from "../lib/capacity-context";
import { useContextPreview } from "../lib/context-premium";
import { CodexMarkerEditor } from "./CodexMarkerEditor";
import { Dropdown, ErrorState, HelpBlock, HelpDot } from "./ui";
import "./CodexCapacitySummary.css";
import { allModelMarkers } from "../lib/all-model-reports";

const DAY = 86400000;
type Metric = "creditsPP" | "apiPP" | "api" | "credits" | "tokens";
interface Bar { start: number; end: number; value: number | null; tokens: number; priced: number; fast: number; unknown: number; color: string; model: string | null; note: string;
  events: number | null; partial: boolean; extra?: string }
/** Drawn at the container's real width, like the other analytical charts: the plot band and 10 px axis text never scale. */
const HEIGHT = 300, X0 = 65, RIGHT = 20, BASE = 250, PLOT = 185, AXIS_FONT = 10, MARKER_FONT = 10;
const numeric = (v: number) => v.toLocaleString(getLocale(), { maximumFractionDigits: 2 });

interface MarkerInput { day: string; label: string; color: string; title: string }
interface MarkerSlot { day: string; x: number; y: number; label: string; anchor: "start" | "end"; color: string; title: string }

let measureContext: CanvasRenderingContext2D | null | undefined;
/** Screen width of a marker label in px; falls back to an average glyph width where canvas is unavailable. */
function labelWidth(text: string, px: number) {
  if (measureContext === undefined) {
    try { measureContext = document.createElement("canvas").getContext("2d"); } catch { measureContext = null; }
  }
  if (!measureContext) return text.length * px * 0.58;
  measureContext.font = `${px}px ${getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() || "sans-serif"}`;
  return measureContext.measureText(text).width;
}

/**
 * Places marker labels in the band above the bars: markers of one day share a line, and each label takes the
 * first lane where it covers neither another label nor another marker's line. A label that fits nowhere is
 * shortened to its date, then to the bare dot; the full text stays in the tooltip.
 */
function layoutMarkers(markers: MarkerInput[], xOf: (day: string) => number, width: number, px: number): MarkerSlot[] {
  const pitch = Math.max(13, px + 3), lanes = Math.max(2, Math.floor(58 / pitch));
  const dot = 4, pad = 7, gap = 6;
  const placed: { x: number; lane: number; left: number; right: number }[] = [];
  const fits = (lane: number, x: number, left: number, right: number) => left >= 0 && right <= width && placed.every(p =>
    (p.lane !== lane || right + gap < p.left || left > p.right + gap)
    && !(p.lane < lane && p.x > left - gap && p.x < right + gap)
    && !(lane < p.lane && x > p.left - gap && x < p.right + gap));
  const groups = new Map<string, MarkerInput[]>();
  for (const marker of markers) groups.set(marker.day, [...groups.get(marker.day) ?? [], marker]);
  return [...groups].map(([day, group]) => {
    const x = xOf(day), first = group[0]!, date = day.slice(5);
    const name = first.label.length > 22 ? first.label.slice(0, 21) + "…" : first.label;
    const texts = [`${name}${group.length > 1 ? ` +${group.length - 1}` : ""} · ${date}`, date, ""];
    const anchors: ("start" | "end")[] = x > width * 0.8 ? ["end", "start"] : ["start", "end"];
    const place = (lane: number, label: string, anchor: "start" | "end") => {
      const span = label ? pad + labelWidth(label, px) : dot;
      const [left, right] = anchor === "start" ? [x - dot, x + span] : [x - span, x + dot];
      if (!fits(lane, x, left, right)) return undefined;
      placed.push({ x, lane, left, right });
      return { day, x, y: 10 + lane * pitch, label, anchor, color: first.color, title: group.map(m => m.title).join("\n") };
    };
    for (const label of texts) for (let lane = 0; lane < lanes; lane++) for (const anchor of anchors) {
      const slot = place(lane, label, anchor);
      if (slot) return slot;
    }
    placed.push({ x, lane: lanes - 1, left: x - dot, right: x + dot });
    return { day, x, y: 10 + (lanes - 1) * pitch, label: "", anchor: "start", color: first.color, title: group.map(m => m.title).join("\n") };
  });
}

export function CodexUsageTimeline({ data, help, markerProviders }: { data: CodexAccountingReport; help?: ReactNode; markerProviders?: readonly string[] }) {
  const { language, t, locale } = useI18n();
  const [chartRef, chartWidth] = useWidth(1000);
  const provider = data.provider?.id ?? "codex";
  const isCodex = provider === "codex";
  const all = provider === "all";
  const contextPreview = useContextPreview();
  const windows = useMemo(() => contextPreview && isCodex
    ? data.windows?.map(window => capacityWithContext(window, true).window) : data.windows, [data.windows, contextPreview, isCodex]);
  const metricLabels = useMemo<Record<Metric, string>>(
    () => ({
      creditsPP: t("Credits / pp - limit windows", "Kredyty / p.p. — okna limitu"),
      apiPP: t("API Standard USD / pp - limit windows", "API Standard USD / p.p. — okna limitu"),
      api: t("API Standard USD - traffic", "API Standard USD — ruch"),
      credits: t("Standard credits - traffic", "Kredyty Standard — ruch"),
      tokens: t("Tokens - traffic", "Tokeny — ruch"),
    }),
    [language, t],
  );
  const [metric, setMetric] = useState<Metric>("api");
  const [active, setActive] = useState<number | null>(null);
  const [editingMarkers, setEditingMarkers] = useState(false);
  const markerProvidersKey = JSON.stringify(markerProviders ?? []);
  const markerState = useAsync(() => all ? allModelMarkers(markerProviders ?? []) : isCodex ? api.codexTimelineMarkers() : api.subscriptionTimelineMarkers(provider), [provider, data.events, markerProvidersKey]);
  const markerMap = new Map(markerState.data?.automatic.filter(m => m.id !== "model:?" && !m.id.endsWith(":model:?")).map(m => [m.id, m]));
  for (const marker of markerState.data?.markers ?? []) markerMap.set(marker.id, marker);
  const allMarkers = [...markerMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  const from = Date.parse(data.scope.since), to = Date.parse(data.scope.until) + DAY;
  const customMarkerIds = new Set(markerState.data?.markers.map(m => m.id) ?? []);
  const markerNote = (marker: (typeof allMarkers)[number]) => {
    if (customMarkerIds.has(marker.id)) return marker.note;
    const prefix = "Pierwsza obserwacja w całym zaindeksowanym archiwum Codex: ";
    const suffix = ". Nie jest to potwierdzona data premiery.";
    if (!marker.id.startsWith("model:") || !marker.note.startsWith(prefix) || !marker.note.endsWith(suffix)) return marker.note;
    const timestamp = marker.note.slice(prefix.length, -suffix.length);
    return `${t("First observation in the indexed Codex archive:", "Pierwsza obserwacja w całym zaindeksowanym archiwum Codex:")} ${timestamp}. ${t("This is not a confirmed launch date.", "Nie jest to potwierdzona data premiery.")}`;
  };
  const milestones = allMarkers.filter(m => m.visible && Date.parse(m.day) >= from && Date.parse(m.day) < to);
  const capacity = metric === "creditsPP" || metric === "apiPP";
  // A bar takes its dominant model's colour: vendor hues across "All", the vendor's shades in one subscription.
  const modelColors = useMemo(() => modelColorsByTokens(data.breakdown, all ? undefined : provider), [data.breakdown, all, provider]);
  const colorOf = (model: string | null | undefined) => model === undefined ? "var(--muted)" : modelColors.get(model) ?? "var(--muted)";
  const bars = useMemo<Bar[]>(() => {
    if (metric === "creditsPP" || metric === "apiPP") return (windows ?? []).map(w => ({
      start: Date.parse(w.start), end: Date.parse(w.end),
      value: capacityPerPoint(w, metric === "creditsPP" ? "credits_low" : "api_standard"),
      tokens: w.usage.tokens, priced: w.usage.priced_tokens, fast: w.usage.fast_tokens, unknown: w.usage.unknown_tokens,
      color: colorOf(w.models[0]?.name), model: w.models[0]?.name ?? null,
      note: `${w.start_percent} → ${w.end_percent}% · ${w.observed_pp} ${t("pp", "p.p.")} · ${w.account}`,
      events: null, partial: false, extra: `${w.start_percent} → ${w.end_percent}% · ${w.observed_pp} ${t("pp", "p.p.")}`,
    }));
    return (data.traffic_periods ?? []).map(period => {
      const top = Object.entries(period.models).sort((a, b) => b[1] - a[1])[0]?.[0];
      const model = top === undefined ? undefined : top === "?" ? null : top;
      return {
        start: Date.parse(period.start), end: Date.parse(period.end),
        value: metric === "tokens" ? (period.events ? period.tokens : null) : period.priced_events ? (metric === "api" ? period.api : period.credits) : null,
        tokens: period.tokens, priced: metric === "tokens" ? period.tokens : period.priced_tokens,
        fast: period.fast_tokens, unknown: period.unknown_tokens,
        color: colorOf(model), model: model ?? null,
        events: period.events, partial: isCodex && !(period.start_reset && period.end_reset),
        note: `${period.account} · ${!isCodex ? t("Recorded UTC day; independent of reset boundaries", "Zapisany dzień UTC; niezależny od granic resetów") : period.start_reset && period.end_reset ? t("Reset to reset", "Od resetu do resetu") : t("Partial period — reset boundary not fully observed or range clipped", "Niepełny okres — niepełne odczyty granic resetu lub ograniczony zakres")} · ${numeric((Date.parse(period.end) - Date.parse(period.start)) / DAY)} ${t("days", "dni")} · ${period.events} ${t("events", "zdarzeń")}`,
      };
    });
  }, [data, windows, isCodex, language, metric, t, modelColors]);
  const dominant = [...new Map(bars.filter(b => b.value !== null && b.model !== null).map(b => [b.model, b.color])).entries()];
  const max = Math.max(1, ...bars.map(b => b.value ?? 0));
  const unassignedTokens = Math.max(0, data.breakdown.reduce((sum, row) => sum + (isCodex && row.model === "gpt-5.3-codex-spark" ? 0 : row.tokens), 0)
    - (data.traffic_periods ?? []).reduce((sum, period) => sum + period.tokens, 0));
  const width = Math.max(chartWidth, 400), X1 = width - RIGHT;
  const x = (ms: number) => X0 + (X1 - X0) * (ms - from) / (to - from);
  const barTop = (b: Bar) => b.value === null ? BASE - 4 : BASE - Math.max(1, PLOT * b.value / max);
  const selected = active === null ? undefined : bars[active];
  const markerSlots = layoutMarkers(milestones.map(m => ({ day: m.day, label: m.label, color: m.color, title: `${m.label} · ${m.day} · ${markerNote(m)}` })),
    day => x(Date.parse(day)), width, MARKER_FONT);
  const about = isCodex ? <>
    {help && <HelpBlock>{help}</HelpBlock>}
    <HelpBlock>{capacity ? t("Bar height is priced work per 1 pp of the limit; width is the observed window segment. Credits show the lower scenario (unknown mode = Standard). Without paired readings we cannot reconstruct capacity; choose a traffic metric for earlier dates.", "Wysokość słupka to wyceniona praca na 1 p.p. limitu; szerokość to obserwowany odcinek okna. Kredyty pokazują dolny scenariusz (nieznany tryb = Standard). Bez par odczytów nie odtwarzamy pojemności: dla wcześniejszych dat wybierz miarę ruchu.")
      : t("Bars follow recorded reset cycles, with widths proportional to their actual duration. Partial periods are labelled. Gaps around early resets or missing readings remain unassigned; no seven-day boundaries are assumed. API and credits use Standard as a reference, without the Fast surcharge. Traffic totals alone do not measure subscription capacity.", "Słupki odpowiadają zarejestrowanym cyklom resetów, a ich szerokość rzeczywistemu czasowi trwania. Niepełne okresy są oznaczone. Luki przy wcześniejszych resetach lub brakujących odczytach pozostają nieprzypisane; nie zakładamy granic co siedem dni. API i kredyty są referencją Standard, bez dopłaty Fast. Sam ruch nie mierzy pojemności abonamentu.")}</HelpBlock>
    <HelpBlock>{t("A yellow line marks incomplete pricing; no bar does not prove no usage. Spark is omitted. Automatic points mark first observations in the archive, not confirmed launch dates; set custom dates and descriptions in ‘Edit points’. Historical prices remain an assumption described in the audit.", "Żółta kreska oznacza niepełną wycenę; brak słupka nie dowodzi braku zużycia. Spark jest pominięty. Automatyczne punkty oznaczają pierwsze obserwacje w archiwum, a nie potwierdzone daty premiery; własne daty i opisy możesz ustawić w „Edytuj punkty”. Historyczne ceny pozostają założeniem opisanym w audycie.")}</HelpBlock>
  </> : <>
    {help && <HelpBlock>{help}</HelpBlock>}
    <HelpBlock>{t("Daily traffic remains visible without meter readings. Capacity requires matching account and counter readings; missing data is not zero. Automatic model points mark first archive observations. API price changes do not by themselves establish a subscription allowance change.", "Ruch dzienny pozostaje widoczny bez odczytów licznika. Pojemność wymaga dopasowanych odczytów konta i licznika; brak danych nie jest zerem. Automatyczne punkty modeli oznaczają pierwsze obserwacje w archiwum. Sama zmiana ceny API nie dowodzi zmiany limitu abonamentu.")}</HelpBlock>
  </>;
  const stamp = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const share = (part: number, b: Bar) => b.tokens ? `${numeric(100 * part / b.tokens)}%` : "—";
  const valueText = (b: Bar) => b.value === null ? "—" : metric === "api" || metric === "apiPP" ? `$${numeric(b.value)}` : metric === "tokens" ? compact(b.value) : `${numeric(b.value)} ${t("cr", "kr")}`;
  const details = (b: Bar) => `${new Date(b.start).toISOString().slice(0, 16).replace("T", " ")} – ${new Date(b.end).toISOString().slice(0, 16).replace("T", " ")} UTC · ${b.value === null ? t("no pricing / data", "brak wyceny / danych") : numeric(b.value)} · ${b.note}`;
  return <section aria-label={t("Subscription capacity and traffic history", "Historia pojemności abonamentu i ruchu")} style={{ fontSize: "var(--fs-4)", margin: "18px 0 24px" }}>
    <h3 className="stats-section-title" style={{ margin: 0 }}>{all ? t("Traffic history", "Historia ruchu") : t("Capacity and traffic over time", "Pojemność i ruch w czasie")}
      <HelpDot label={t("About this view", "O tym widoku")}>{about}</HelpDot>
    </h3>
    {markerState.error && <ErrorState message={`${t("Timeline points", "Punkty osi czasu")}: ${markerState.error}`} onRetry={markerState.reload} />}
    {editingMarkers && markerState.data && <CodexMarkerEditor markers={allMarkers} onClose={() => setEditingMarkers(false)}
      onSave={async marker => { const change = { revision: markerState.data!.revision, marker }; await (isCodex ? api.saveCodexTimelineMarker(change) : api.saveSubscriptionTimelineMarker(provider, change)); markerState.reload(); }}
      onRemove={async remove => { const change = { revision: markerState.data!.revision, remove }; await (isCodex ? api.saveCodexTimelineMarker(change) : api.saveSubscriptionTimelineMarker(provider, change)); markerState.reload(); }} />}
    <div className="ui-toolbar" style={{ margin: "10px 0" }}>
      <button className="ui-button" type="button" disabled={all || !markerState.data || markerState.loading}
        title={all ? t("Select one subscription to edit its timeline points", "Wybierz jedną subskrypcję, aby edytować jej punkty osi czasu") : undefined}
        onClick={() => setEditingMarkers(true)}>{t("Edit points", "Edytuj punkty")} ({milestones.length})</button>
      <label className="ui-field"><span className="ui-field-label">{t("Metric", "Miara")}</span> <Dropdown className="ui-input" value={metric} onChange={value => { setMetric(value as Metric); setActive(null); }}
        options={Object.entries(metricLabels).filter(([key]) => all ? key === "api" || key === "tokens" : isCodex || !key.startsWith("credits")).map(([key, label]) => ({ value: key, label }))} /></label>
      {!capacity && <span style={{ color: "var(--muted)" }}>{isCodex ? t("Periods: reset to reset · UTC", "Okresy: od resetu do resetu · UTC") : t("Traffic by recorded UTC day", "Ruch według zapisanych dni UTC")}</span>}
      {dominant.length > 0 && <span className="timeline-models" title={t("Colour: the dominant model of each bar by tokens", "Kolor: dominujący model słupka według tokenów")}>
        {dominant.map(([model, color]) => <span key={model}><i style={{ background: color }} />{usageModelLabel(model!)}</span>)}
      </span>}
    </div>
    {!bars.length && <p role="status">{all ? t("No recorded traffic in this range.", "Brak zapisanego ruchu w tym zakresie.") : t("No reset periods can be reconstructed from the available readings in this range.", "Dostępne odczyty nie pozwalają odtworzyć okresów resetów w tym zakresie.")}</p>}
    {!capacity && unassignedTokens > 0 && <p style={{ color: "var(--warn)" }} title={t("Missing readings or uncertain reset boundaries. Excluded from these bars; retained in Models & sources.", "Brak odczytów lub niepewne granice resetów. Pominięte na wykresie; zachowane w Modelach i źródłach.")}>
      {compact(unassignedTokens)} {t("tokens outside reset periods, not in the bars", "tokenów poza okresami resetów, poza słupkami")}</p>}
    <ChartExport title={metricLabels[metric]}><div ref={chartRef} className="capacity-chart" style={{ minWidth: 0, overflowX: "clip" }}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} style={{ display: "block", fontFamily: "var(--font-figure)" }} role="group" aria-label={metricLabels[metric]}>
      {[0, .25, .5, .75, 1].map(r => <g key={r}>
        <line x1={X0} x2={X1} y1={BASE - PLOT * r} y2={BASE - PLOT * r} stroke={r === 0 ? "var(--line2)" : "var(--line)"} strokeDasharray={r === 0 ? undefined : "3 4"} />
        <text x={X0 - 8} y={BASE + 4 - PLOT * r} fill="var(--muted)" fontSize={AXIS_FONT} textAnchor="end">{compact(max * r)}</text>
      </g>)}
      {bars.map((b, i) => <g key={b.start} role="button" tabIndex={0} aria-label={details(b)}
        onFocus={() => setActive(i)} onMouseEnter={() => setActive(i)} onClick={() => setActive(i)}
        onMouseLeave={() => setActive(current => current === i ? null : current)} onBlur={() => setActive(current => current === i ? null : current)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive(i); } }}>
        <rect x={x(b.start)} y={barTop(b)} width={Math.max(1, x(b.end) - x(b.start) - 2)} height={BASE - barTop(b)}
          fill={b.value === null ? "var(--line2)" : b.color} opacity={active === null || active === i ? .9 : .5} />
        {b.value !== null && b.priced < b.tokens && <line x1={x(b.start)} x2={x(b.end) - 2} y1={BASE + 4} y2={BASE + 4} stroke="var(--warn)" strokeWidth={3} strokeLinecap="round" />}
      </g>)}
      {markerSlots.map(m => <g key={m.day}>
        <title>{m.title}</title>
        <line x1={m.x} x2={m.x} y1={m.y} y2={BASE + 7} stroke={`var(--${m.color})`} strokeDasharray="3 4" />
        <circle cx={m.x} cy={m.y} r={3.5} fill={`var(--${m.color})`} />
        {m.label && <text x={m.anchor === "start" ? m.x + 7 : m.x - 7} y={m.y} dominantBaseline="central" textAnchor={m.anchor}
          fill={`var(--${m.color})`} fontSize={MARKER_FONT}>{m.label}</text>}
      </g>)}
      {calendarTimeTicks(from, to - 1, X1 - X0, locale).map(tick => <text key={tick.time} x={x(tick.time)} y={BASE + 22} textAnchor={tick.time === from ? "start" : tick.time === to - 1 ? "end" : "middle"}
        fill="var(--muted)" fontSize={AXIS_FONT}><title>{new Date(tick.time).toISOString()}</title>{tick.label}</text>)}
      </svg>
      {/* The hovered period as the event card: numbers first; exact bounds and caveats stay in its title. */}
      {selected && <div className="capacity-event-card" role="tooltip" title={details(selected)}
        style={{ left: Math.max(0, Math.min(x((selected.start + selected.end) / 2) + 8, width - 330)), top: Math.max(0, barTop(selected) - 20) }}>
        <strong className="mono">{stamp.format(selected.start)} – {stamp.format(selected.end)} UTC · {numeric((selected.end - selected.start) / DAY)} {t("d", "d")}</strong>
        <div><span className="mono">{valueText(selected)}</span><small>{metricLabels[metric]}</small></div>
        <small>{[
          selected.extra,
          selected.events !== null && `${selected.events.toLocaleString(locale)} ${t("events", "zdarzeń")}`,
          metric !== "tokens" && `${t("priced", "wycenione")} ${share(selected.priced, selected)}`,
          `${t("unknown mode", "tryb nieznany")} ${share(selected.unknown, selected)}`,
          `Fast ${share(selected.fast, selected)}`,
        ].filter(Boolean).join(" · ")}</small>
        {selected.partial && <small style={{ color: "var(--warn)" }}>{t("partial period", "niepełny okres")}</small>}
      </div>}
    </div></ChartExport>
  </section>;
}
