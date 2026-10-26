import { calendarTimeTicks } from "../lib/chart-dates";
import { ChartExport } from "./ChartExport";
import { useState } from "react";
import type { CodexWindowCacheTimeline } from "../../shared/codex-window-detail";
import { full, pct } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { cacheShareAxis, modelCacheGrain, modelCachePeriods } from "../lib/model-cache-history";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../shared/time-range-presets";
import { usageDateRange } from "../lib/global-usage";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { EmptyState, ErrorState, Fact, Facts, HelpDot, LoadingCard, Selector } from "./ui";
import { useWidth } from "./WindowStatusCard";

/** `timeline` is the caller's own range ("Cycle" unless `baseLabel` renames it). */
export function ModelCacheHistory({ timeline, model, account, baseLabel, initialRange }: {
  timeline?: CodexWindowCacheTimeline; model: string; account?: string; baseLabel?: string; initialRange?: string;
}) {
  const { t } = useI18n();
  // A cycle is often a few days; 30 days shows the trend. Without an account only the cycle can be read.
  const [chosen, setRange] = useState(initialRange ?? "30");
  const range = account ? chosen : "cycle";
  const dates = usageDateRange(range === "cycle" || range === "all" ? 1 : Number(range));
  const since = range === "all" ? undefined : dates.since;
  const history = useAsync(signal => range === "cycle" || !account ? Promise.resolve(null)
    : api.modelCacheHistory({ account, model, since, until: dates.until }, signal), [range, account, model, since, dates.until]);
  const result = history.data;
  const selected = range === "cycle" ? timeline : result && result.account.toLowerCase() === account?.toLowerCase()
    && result.model === model ? result : undefined;
  return <>
    <div className="ui-toolbar codex-model-cache-toolbar">
      <Selector label={t("History", "Historia")} ariaLabel={t("Cache history range", "Zakres historii cache")} value={range} onChange={setRange}
        options={[{ value: "cycle", label: baseLabel ?? t("Cycle", "Cykl") },
          ...TIME_RANGE_DAYS.map(days => ({ value: String(days), label: timeRangeLabel(days, t), disabled: !account })),
          { value: "all", label: t("All", "Całość"), disabled: !account }]} />
      {selected && <span className="mono codex-models-note">{selected.from.slice(0, 10)} → {new Date(Date.parse(selected.until) - 1).toISOString().slice(0, 10)}</span>}
    </div>
    {range !== "cycle" && history.error && <ErrorState message={history.error} onRetry={history.reload} />}
    {range !== "cycle" && history.loading && !selected ? <LoadingCard />
      : <CacheHistoryChart timeline={selected} model={model} />}
  </>;
}

function CacheHistoryChart({ timeline, model }: { timeline?: CodexWindowCacheTimeline; model: string }) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(760);
  const periods = timeline ? modelCachePeriods(timeline, model) : [];
  const observed = periods.some(period => period.percent !== null);
  const from = timeline ? Date.parse(timeline.from) : 0, until = timeline ? Date.parse(timeline.until) : 0;
  const grain = timeline ? modelCacheGrain(timeline) : "day", hourly = grain === "hour";
  const totals = periods.reduce((sum, period) => ({ input: sum.input + period.input, cached: sum.cached + period.cached }), { input: 0, cached: 0 });
  const left = 48, right = width - 20, top = 16, bottom = 220, height = 256;
  const x = (period: (typeof periods)[number]) => left + ((period.from + period.until) / 2 - from) / (until - from) * (right - left);
  const axis = cacheShareAxis(periods.flatMap(period => period.percent === null ? [] : [period.percent]));
  const y = (value: number) => bottom - (value - axis.min) / (axis.max - axis.min) * (bottom - top);
  const ticks = calendarTimeTicks(from, until - 1, right - left, locale, hourly);
  const exact = (at: number) => new Date(at).toISOString().replace("T", " ").replace(/\.000Z$/, "Z").replace(/Z$/, " UTC");

  let connected = false;
  const path = periods.map(period => {
    if (period.percent === null) { connected = false; return ""; }
    const command = `${connected ? "L" : "M"}${x(period)},${y(period.percent)}`;
    connected = true;
    return command;
  }).join(" ");
  return <ChartExport title={model + " · " + t("Cache history", "Historia cache")} available={observed}><section className="codex-model-cache" ref={ref}>
    {timeline && <Facts>
      <Fact id="cache-range-share" label={t("Cache share", "Udział cache")} value={totals.input > 0 ? pct(100 * totals.cached / totals.input, 1) : "—"} />
      <Fact label={t("Cache read", "Odczyt cache")} value={full(totals.cached)} />
      <Fact label={t("Total input", "Całe wejście")} value={full(totals.input)} />
    </Facts>}
    <div className="codex-model-cache-head">
      <h3>{t("Share of input", "Udział w inpucie")} <HelpDot label={t("Cache read share", "Udział odczytu cache")}>
        {t("Cache reads / total input × 100, for this model and selected range. The range total is a ratio of token sums, never an average of percentages. Input already includes cache reads and writes; output and reasoning are excluded. Dates are UTC; rolling ranges include today. Cycle retains the selected window's traffic; longer ranges include all canonical valid traffic of this account and model. Gaps mean no input evidence, not 0%. Missing prices do not exclude valid token counters.",
          "Odczyt cache / całe wejście × 100, dla tego modelu i wybranego zakresu. Wynik zakresu to iloraz sum tokenów, nie średnia procentów. Wejście zawiera już odczyty i zapisy cache; output i reasoning nie wchodzą do mianownika. Daty są w UTC; zakresy kroczące obejmują dziś. Cykl zachowuje ruch wybranego okna; dłuższe zakresy obejmują cały kanoniczny ruch konta i modelu z poprawnymi licznikami. Luka oznacza brak danych wejścia, nie 0%. Brak ceny nie wyklucza poprawnych tokenów.")}
      </HelpDot></h3>
      {observed && <span className="mono">{{ hour: t("hourly", "godzinowo"), day: t("daily", "dziennie"), week: t("weekly", "tygodniowo"), month: t("monthly", "miesięcznie") }[grain]}</span>}
    </div>
    {!observed ? <EmptyState title={t("Cache history unavailable", "Historia cache niedostępna")} /> :
      <svg className="codex-model-cache-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        role="group" aria-label={t("Cache read share over time", "Udział odczytu cache w czasie")}>
        {axis.ticks.map(value => <g key={value}>
          <line x1={left} x2={right} y1={y(value)} y2={y(value)} className="codex-model-cache-grid" />
          <text x={left - 10} y={y(value) + 4} textAnchor="end">{pct(value, axis.step < 1 ? 1 : 0)}</text>
        </g>)}
        {ticks.map(tick => <text key={tick.time} x={left + (tick.time - from) / (until - from) * (right - left)} y={bottom + 22} textAnchor={tick.time === from ? "start" : tick.time === until - 1 ? "end" : "middle"}><title>{exact(tick.time)}</title>{tick.label}</text>)}
        <path d={path} className="codex-model-cache-line" />
        {periods.map(period => {
          const title = `${exact(period.from)} → ${exact(period.until)}\n${period.percent === null ? t("No input evidence", "Brak danych wejścia") : `${pct(period.percent, 1)} · ${t("cache read", "odczyt cache")} ${full(period.cached)} / ${t("input", "wejście")} ${full(period.input)} · ${t("calls", "wywołania")} ${full(period.calls)}`}`;
          return <g key={period.from}>
            {period.percent !== null && <g tabIndex={0} role="img" aria-label={title} className="codex-model-cache-point">
              <title>{title}</title>
              <circle cx={x(period)} cy={y(period.percent)} r={4} />
            </g>}

          </g>;
        })}
      </svg>}
  </section></ChartExport>;
}
