import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ModelUsageShareResponse, ModelUsageShareWindow } from "../../shared/model-usage-share";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { pct, usageModelLabel } from "../lib/format";
import { calendarTimeTicks, chartDateFormatter } from "../lib/chart-dates";
import { DISTINCT_INKS } from "../lib/model-colors";
import { seriesStroke } from "../lib/model-speed";
import { ChartExport } from "./ChartExport";
import { useWidth } from "./WindowStatusCard";
import { EmptyState, ErrorState, HelpBlock, HelpDot, LegendAllToggle, LoadingCard, Tabs } from "./ui";
import "./ModelUsageShare.css";

type Unit = "pct" | "api";
const DAY = 86_400_000;
const UNATTRIBUTED = "var(--line2)";
interface Series { key: string; label: string; color: string; dash: string | undefined; index: number | null }

/** Round axis maximum just above the highest stack, so bars use most of the height. */
const niceMax = (value: number) => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(step => step * power >= value) ?? 10) * power;
};

/** Usage share by model: cycles as stacked bars, the chosen cycle as stacked cumulative areas. */
export function ModelUsageShare({ provider, account, counter, since, until, dataRevision }: {
  provider: string; account: string; counter?: string; since: string; until: string; dataRevision?: number;
}) {
  const { t, locale } = useI18n();
  const [unit, setUnit] = useState<Unit>("pct");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  const scope = JSON.stringify([provider, account, counter, since, until]);
  const state = useAsync(signal => api.modelUsageShare({ provider, account, counter, since, until, window: chosen ?? undefined }, signal),
    [provider, account, counter, since, until, chosen, dataRevision], true);
  // Choosing another cycle keeps this range's bars on screen while its hours load.
  const last = useRef<{ scope: string; data: ModelUsageShareResponse } | null>(null);
  if (state.data) last.current = { scope, data: state.data };
  const data = state.data ?? (last.current?.scope === scope ? last.current.data : null);
  if (state.error && !data) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!data) return <LoadingCard label={t("Usage by model", "Zużycie według modeli")} shape="chart" />;
  if (!data.windows.length) return <EmptyState title={t("No cycles in the selected dates", "Brak cykli w wybranych datach")} />;

  // One subscription's models mostly share a vendor, whose shades blur together in a stack: distinct inks by
  // API value over the range keep the largest neighbours apart.
  const ranked = data.models.map((_, index) => index)
    .sort((a, b) => data.windows.reduce((sum, cycle) => sum + cycle.api_usd[b]!, 0) - data.windows.reduce((sum, cycle) => sum + cycle.api_usd[a]!, 0) || a - b);
  const strokes = new Map(ranked.map((index, rank) => [index, seriesStroke(rank, DISTINCT_INKS)]));
  const used = data.models.map((_, index) => data.windows.some(cycle => cycle.pct[index]! > 0 || cycle.api_usd[index]! > 0));
  const series: Series[] = data.models.flatMap((model, index) => used[index] ? [{ key: model ?? "", index,
    label: model === null ? t("unknown model", "nieznany model") : usageModelLabel(model), ...strokes.get(index)! }] : []);
  const unattributed = unit === "pct" && data.windows.some(cycle => cycle.unattributed_pct > 0);
  const shown: Series[] = [...series.filter(item => !hidden.has(item.key)),
    ...(unattributed ? [{ key: "\u0000rest", index: null, label: t("unattributed", "nieprzypisane"), color: UNATTRIBUTED, dash: undefined }] : [])];
  const cycle = data.windows.find(item => item.window_id === data.detail?.window_id) ?? data.windows.at(-1)!;
  const toggle = (key: string) => setHidden(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const range = chartDateFormatter(locale, Date.parse(cycle.start), Date.parse(cycle.end));
  const subject = `${account} · ${since} → ${until}`;
  return <section className="mus" aria-label={t("Usage by model", "Zużycie według modeli")} aria-busy={state.loading}>
    <div className="ui-toolbar">
      <div className="mus-legend" role="group" aria-label={t("Models", "Modele")}>
        {series.map(item => <button type="button" key={item.key} aria-pressed={!hidden.has(item.key)} onClick={() => toggle(item.key)}>
          <span className="mus-swatch" style={{ background: item.color }} />{item.label}
        </button>)}
        {series.length > 1 && <LegendAllToggle allShown={series.every(item => !hidden.has(item.key))} onShowAll={() => setHidden(new Set())}
          onHideAll={() => setHidden(new Set(series.map(item => item.key)))} />}
        {unattributed && <span className="mus-rest"><span className="mus-swatch" style={{ background: UNATTRIBUTED }} />{t("unattributed", "nieprzypisane")}</span>}
      </div>
      <span className="ui-spacer" />
      <Tabs value={unit} onChange={setUnit} options={[{ value: "pct", label: t("≈ % of limit", "≈ % limitu") }, { value: "api", label: "API $" }]} />
      <HelpDot label={t("How the limit is divided between models", "Jak dzielimy limit między modele")}>
        <HelpBlock>{t("The provider measures the limit for the whole account. Each hour's meter increase is divided by the models' API value in that hour; a model's stored API value is spread over its hourly tokens, so nothing is repriced.",
          "Dostawca mierzy limit dla całego konta. Przyrost licznika w każdej godzinie dzielimy według wartości API modeli w tej godzinie; zapisana wartość API modelu jest rozłożona na jego godzinowe tokeny, więc nic nie jest wyceniane ponownie.")}</HelpBlock>
        <HelpBlock>{t("An increase without priced traffic in its hour follows the preceding three hours, then the cycle so far; the rest is unattributed. Models without prices receive no share. This is an estimate, not a per-model limit.",
          "Przyrost bez wycenionego ruchu w swojej godzinie idzie za trzema poprzednimi godzinami, potem za cyklem do tej chwili; reszta jest nieprzypisana. Modele bez cen nie dostają udziału. To szacunek, nie limit modelu.")}</HelpBlock>
        <HelpBlock>{t("API $ is the stored API Standard value of the cycle's counted traffic.", "API $ to zapisana wartość API Standard policzonego ruchu cyklu.")}</HelpBlock>
      </HelpDot>
    </div>
    <div>
      <div className="mus-head"><span className="mus-title">{t("Cycles", "Cykle")}</span></div>
      <ChartExport title={`${t("Cycles by model", "Cykle według modeli")} · ${unit === "pct" ? t("estimated limit share", "szacowany udział limitu") : "API $"} · ${subject}`}>
        <CycleBars windows={data.windows} series={shown} unit={unit} chosen={cycle.window_id} onChoose={setChosen} />
      </ChartExport>
    </div>
    <div className="mus-cycle">
      <div className="mus-head">
        <span className="mus-title">{t("Cycle", "Cykl")} {range.format(Date.parse(cycle.start))} → {range.format(Date.parse(cycle.end))}</span>
        <span className="mus-meta">{[cycle.plan, cycle.meter === null ? null : `${cycle.meter}%`, money(cycle.api_usd.reduce((sum, value) => sum + value, 0), locale)].filter(Boolean).join(" · ")}</span>
      </div>
      {data.detail
        ? <ChartExport title={`${t("Cycle by model", "Cykl według modeli")} · ${cycle.start} → ${cycle.end} · ${unit === "pct" ? t("estimated limit share", "szacowany udział limitu") : "API $"} · ${account}`}>
          <CycleAreas cycle={cycle} points={data.detail.points} series={shown} unit={unit} />
        </ChartExport>
        : <LoadingCard label={t("Cycle by model", "Cykl według modeli")} shape="chart" />}
    </div>
  </section>;
}

const money = (value: number, locale: string) => `$${Math.round(value).toLocaleString(locale)}`;
const valueOf = (item: Series, unit: Unit, pctValues: number[], apiValues: number[], rest: number) =>
  item.index === null ? (unit === "pct" ? rest : 0) : (unit === "pct" ? pctValues : apiValues)[item.index] ?? 0;

function CycleBars({ windows, series, unit, chosen, onChoose }: {
  windows: ModelUsageShareWindow[]; series: Series[]; unit: Unit; chosen: string; onChoose: (id: string) => void;
}) {
  const { t, locale } = useI18n(), [ref, width] = useWidth(900);
  const stacks = windows.map(cycle => series.map(item => valueOf(item, unit, cycle.pct, cycle.api_usd, cycle.unattributed_pct)));
  const max = unit === "pct" ? Math.max(100, ...stacks.map(values => values.reduce((a, b) => a + b, 0))) : niceMax(Math.max(...stacks.map(values => values.reduce((a, b) => a + b, 0))));
  const left = 52, top = 20, bottom = 176, height = 214;
  const slot = (width - left) / windows.length, bar = Math.min(46, slot * 0.56);
  const y = (value: number) => bottom - value / max * (bottom - top);
  const format = (value: number) => unit === "pct" ? pct(value, value > 0 && value < 10 ? 1 : 0) : money(value, locale);
  const dates = chartDateFormatter(locale, Date.parse(windows[0]!.start), Date.parse(windows.at(-1)!.end));
  const choose = (id: string) => (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onChoose(id); } };
  return <div ref={ref}>
    <svg className="mus-svg" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="group" aria-label={t("Cycles by model", "Cykle według modeli")}>
      {[0.25, 0.5, 0.75, 1].map(step => <g key={step}>
        <line className="mus-grid" x1={left} x2={width} y1={y(max * step)} y2={y(max * step)} />
        <text className="mus-tick" x={left - 8} y={y(max * step) + 3} textAnchor="end">{format(max * step)}</text>
      </g>)}
      {windows.map((cycle, index) => {
        const x = left + index * slot, center = x + slot / 2, values = stacks[index]!;
        const total = values.reduce((a, b) => a + b, 0);
        let base = 0;
        const label = `${dates.format(Date.parse(cycle.start))} → ${dates.format(Date.parse(cycle.end))}`;
        const lines = series.map((item, position) => [item.label, values[position]!] as const).filter(([, value]) => value > 0)
          .map(([name, value]) => `${name}: ${unit === "pct" ? "≈ " : ""}${format(value)}`);
        return <g key={cycle.window_id} className={`mus-column${cycle.window_id === chosen ? " is-on" : ""}`} role="button" tabIndex={0}
          aria-pressed={cycle.window_id === chosen} aria-label={label} onClick={() => onChoose(cycle.window_id)} onKeyDown={choose(cycle.window_id)}>
          <title>{[label, ...lines, `${t("meter", "licznik")}: ${cycle.meter ?? "—"}%`, cycle.preparing ? t("preparing", "w przygotowaniu") : ""].filter(Boolean).join("\n")}</title>
          <rect className="mus-column-hit" x={x + 2} y={0} width={Math.max(0, slot - 4)} height={bottom + 4} />
          {series.map((item, position) => {
            const value = values[position]!;
            if (value <= 0) return null;
            const from = base; base += value;
            return <rect key={item.key} className="mus-segment" x={center - bar / 2} y={y(base)} width={bar} height={Math.max(0, y(from) - y(base))} fill={item.color} />;
          })}
          <text className="mus-total" x={center} y={y(total) - 5} textAnchor="middle">{cycle.preparing && !total ? "…" : format(total)}</text>
          <text className="mus-tick" x={center} y={bottom + 18} textAnchor="middle">{dates.format(Date.parse(cycle.start))}</text>
          {cycle.current && <text className="mus-note" x={center} y={bottom + 31} textAnchor="middle">{t("now", "teraz")}</text>}
        </g>;
      })}
      <line className="mus-axis" x1={left} x2={width} y1={bottom} y2={bottom} />
    </svg>
  </div>;
}

function CycleAreas({ cycle, points, series, unit }: {
  cycle: ModelUsageShareWindow; points: NonNullable<ModelUsageShareResponse["detail"]>["points"]; series: Series[]; unit: Unit;
}) {
  const { t, locale } = useI18n(), [ref, width] = useWidth(900);
  const [hover, setHover] = useState<number | null>(null);
  const start = Date.parse(cycle.start), end = Date.parse(cycle.end), span = Math.max(1, end - start);
  const times = points.map(point => Date.parse(point.t));
  const layers = points.map(point => series.map(item => valueOf(item, unit, point.pct, point.api_usd, point.unattributed)));
  const top = 12, bottom = 268, height = 296, left = 52, right = width - 12;
  const highest = Math.max(0, ...layers.map(values => values.reduce((a, b) => a + b, 0)));
  const max = unit === "pct" ? Math.max(100, highest) : niceMax(highest);
  const x = (ms: number) => left + (ms - start) / span * (right - left);
  const y = (value: number) => bottom - value / max * (bottom - top);
  const format = (value: number) => unit === "pct" ? pct(value, value > 0 && value < 10 ? 1 : 0) : money(value, locale);
  // The edge labels are anchored outward, so an inner label needs its whole width clear of them.
  const clear = (edge: string, inner: string) => edge.length * 7 + inner.length * 3.5 + 8;
  const ticks = calendarTimeTicks(start, end, right - left, locale, span <= 4 * DAY).filter((tick, _, all) => tick.time === start || tick.time === end
    || x(tick.time) - x(start) > clear(all[0]!.label, tick.label) && x(end) - x(tick.time) > clear(all.at(-1)!.label, tick.label));
  const stamp = chartDateFormatter(locale, start, end, true);
  const lower = points.map(() => 0);
  const paths = series.map((item, position) => {
    const upper = layers.map((values, index) => lower[index]! + values[position]!);
    const edge = times.map((time, index) => `${x(time)},${y(upper[index]!)}`);
    const base = times.map((time, index) => `${x(time)},${y(lower[index]!)}`).reverse();
    upper.forEach((value, index) => { lower[index] = value; });
    return { item, area: `M ${edge.join(" L ")} L ${base.join(" L ")} Z`, edge: `M ${edge.join(" L ")}` };
  });
  const move = (event: MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect(), at = start + ((event.clientX - box.left) * width / box.width - left) / (right - left) * span;
    if (at < start - span * 0.02 || at > times.at(-1)! + span * 0.02) { setHover(null); return; }
    setHover(times.reduce((best, time, index) => Math.abs(time - at) < Math.abs(times[best]! - at) ? index : best, 0));
  };
  const point = hover === null ? null : points[hover]!;
  return <div ref={ref} className="mus-areas">
    <svg className="mus-svg" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
      aria-label={t("Cycle by model", "Cykl według modeli")} onMouseMove={move} onMouseLeave={() => setHover(null)}>
      {[0.25, 0.5, 0.75, 1].map(step => <g key={step}>
        <line className="mus-grid" x1={left} x2={right} y1={y(max * step)} y2={y(max * step)} />
        <text className="mus-tick" x={left - 8} y={y(max * step) + 3} textAnchor="end">{format(max * step)}</text>
      </g>)}
      {paths.map(({ item, area, edge }) => <g key={item.key}>
        <path className="mus-area" d={area} fill={item.color} />
        <path className="mus-edge" d={edge} stroke={item.color} strokeDasharray={item.dash} />
      </g>)}
      {cycle.current && <g>
        <line className="mus-now" x1={x(times.at(-1)!)} x2={x(times.at(-1)!)} y1={top} y2={bottom} />
        <text className="mus-note" x={x(times.at(-1)!) + 4} y={top + 10}>{t("now", "teraz")}</text>
      </g>}
      {ticks.map(tick => <text key={tick.time} className="mus-tick" x={x(tick.time)} y={bottom + 20}
        textAnchor={tick.time === start ? "start" : tick.time === end ? "end" : "middle"}>{tick.label}</text>)}
      <line className="mus-axis" x1={left} x2={right} y1={bottom} y2={bottom} />
      {hover !== null && <line className="mus-cross" x1={x(times[hover]!)} x2={x(times[hover]!)} y1={top} y2={bottom} />}
    </svg>
    {point && <div className="mus-tip" style={x(times[hover!]!) < width * 0.6
      ? { left: `calc(${x(times[hover!]!) / width * 100}% + var(--s-6))` } : { right: `calc(${(1 - x(times[hover!]!) / width) * 100}% + var(--s-6))` }}>
      <b>{stamp.format(times[hover!]!)} UTC</b>
      {series.map((item, position) => [item, layers[hover!]![position]!] as const).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1])
        .map(([item, value]) => <div key={item.key} className="mus-tip-row">
          <span><span className="mus-swatch" style={{ background: item.color }} />{item.label}</span><span>{unit === "pct" ? "≈ " : ""}{format(value)}</span>
        </div>)}
      <div className="mus-tip-row is-muted"><span>{t("meter", "licznik")}</span><span>{point.meter}%</span></div>
      <div className="mus-tip-row is-muted"><span>API $</span><span>{money(point.api_usd.reduce((a, b) => a + b, 0), locale)}</span></div>
    </div>}
  </div>;
}
