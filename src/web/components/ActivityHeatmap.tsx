import { ChartExport } from "./ChartExport";
import { useState } from "react";
import type { ActivityBucket, ActivityResponse } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { heatScale } from "../lib/cycle-insights";
import { compact, full } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { Card, EmptyState, ErrorState, HelpDot, LoadingCard, Tabs } from "./ui";
import "../screens/History.css";
import "../screens/Insights.css";

type HeatMetric = "tokens" | "tokens_fresh" | "calls";
const HEAT_METRICS: { value: HeatMetric; en: string; pl: string }[] = [
  { value: "tokens", en: "gross tokens", pl: "tokeny brutto" },
  { value: "tokens_fresh", en: "fresh tokens", pl: "nowe tokeny" },
  { value: "calls", en: "calls", pl: "wywołania" },
];
const DAYS: [string, string][] = [["Mon", "pon"], ["Tue", "wt"], ["Wed", "śr"], ["Thu", "czw"], ["Fri", "pt"], ["Sat", "sob"], ["Sun", "nd"]];
/** The card's own title: the display voice (docs/design/paper-atlas.md §2). */
const CARD_TITLE = { fontSize: "var(--fs-card-title)", color: "var(--text)" } as const;
// Five steps of an accent wash over the sunken paper; an hour without activity stays sunken.
const SHADES = [18, 36, 56, 76, 100];
const shade = (level: number) => (level < 0 ? "var(--sunk)" : `color-mix(in oklab, var(--accent) ${SHADES[level]}%, var(--sunk))`);
// Longest day-total bar in the right margin, in CSS pixels.
const MARGIN_BAR = 40;
const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Hours of the week over the whole indexed history (docs/ui-audit-2026-09-26.md, Patterns and finding 4):
 * one card for a subscription and for all of them, with the day and hour profiles as its margins and a
 * five-step scale in which every step holds a fifth of the active hours.
 */
export function ActivityHeatmap({ load, deps, scope }: {
  load: (signal: AbortSignal) => Promise<ActivityResponse>;
  deps: unknown[];
  /** Whose activity this is, named in the subtitle. */
  scope: string;
}) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<HeatMetric>("tokens");
  const state = useAsync(load, deps);
  const title = t("When you work", "Kiedy pracujesz");
  if (state.error && !state.data) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data) return <LoadingCard label={t("Loading working hours…", "Wczytywanie godzin pracy…")} height={260} shape="chart" />;
  const data = state.data;
  const value = (bucket: ActivityBucket) => bucket[metric];
  const active = data.cells.filter((cell) => cell.tokens > 0 || cell.calls > 0);
  const head = (
    <div className="archive-head">
      <div><span className="ui-display" style={CARD_TITLE}>{title}</span> <HelpDot label={title}>{t("Hour × day, local time.", "Godzina × dzień, czas lokalny.")}</HelpDot> <span className="archive-sub">· {t("whole history · {0}", `cała historia · ${scope}`, [scope])}</span></div>
      <Tabs value={metric} onChange={setMetric} options={HEAT_METRICS.map(({ value: v, en, pl }) => ({ value: v, label: t(en, pl) }))} />
    </div>
  );
  if (active.length === 0) {
    return <Card>{head}<div style={{ marginTop: 10 }}><EmptyState title={t("No activity recorded", "Brak zarejestrowanej aktywności")}
      detail={t("No indexed event belongs to this scope yet.", "Żadne zaindeksowane zdarzenie nie należy jeszcze do tego zakresu.")} /></div></Card>;
  }
  const at = new Map(data.cells.map((cell) => [`${cell.dow}:${cell.hour}`, cell]));
  const scale = heatScale(data.cells.map(value));
  const peak = data.cells.reduce((best, cell) => (value(cell) > value(best) ? cell : best), data.cells[0]!);
  const dayMax = Math.max(1, ...data.by_dow.map(value)), hourMax = Math.max(1, ...data.by_hour.map(value));
  const peakHour = data.by_hour.reduce((best, row) => (value(row) > value(best) ? row : best), data.by_hour[0]!);
  const unitLabel = HEAT_METRICS.find((m) => m.value === metric)!;
  const amount = (n: number) => `${compact(n)} ${t(unitLabel.en, unitLabel.pl)}`;
  const day = (dow: number) => t(DAYS[dow]![0], DAYS[dow]![1]);
  return (
    <Card>
      {head}
      <ChartExport title={title + " · " + t(unitLabel.en, unitLabel.pl)}><div className="archive-sub mono insights-heat-summary">
        {full(data.totals.calls)} {t("calls", "wywołań")} · {compact(data.totals.tokens)} {t("gross tokens", "tokenów brutto")} · {t("peak", "szczyt")} {day(peak.dow)} {hour(peak.hour)} · {amount(value(peak))} ({t("outlined", "obwódka")})
      </div>
      <div className="insights-heat" role="img" aria-label={title}>
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={`h${h}`} className="insights-heat-axis">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
        <span className="insights-heat-axis is-margin">{t("week", "tydzień")}</span>
        {DAYS.map((_, dow) => {
          const total = data.by_dow.find((row) => row.dow === dow);
          return [
            <span key={`d${dow}`} className="insights-heat-day">{day(dow)}</span>,
            ...Array.from({ length: 24 }, (_, h) => {
              const cell = at.get(`${dow}:${h}`);
              const v = cell ? value(cell) : 0;
              return <span key={`${dow}:${h}`} className={`insights-heat-cell${cell === peak ? " is-peak" : ""}`} style={{ background: shade(scale.level(v)) }}
                title={`${day(dow)} ${hour(h)}–${hour((h + 1) % 24)} · ${v > 0 ? `${amount(v)}${cell && metric !== "calls" ? ` · ${full(cell.calls)} ${t("calls", "wywołań")}` : ""}` : t("no activity", "brak aktywności")}`} />;
            }),
            <span key={`m${dow}`} className="insights-heat-margin" title={total ? amount(value(total)) : undefined}>
              <i style={{ width: total ? (value(total) / dayMax) * MARGIN_BAR : 0 }} /><em>{total ? compact(value(total)) : "—"}</em>
            </span>,
          ];
        })}
        <span className="insights-heat-day">{t("day", "doba")}</span>
        {Array.from({ length: 24 }, (_, h) => {
          const row = data.by_hour.find((bucket) => bucket.hour === h);
          const v = row ? value(row) : 0;
          return <span key={`p${h}`} className="insights-heat-profile" title={`${hour(h)} · ${amount(v)}`}>
            <i style={{ height: `${(v / hourMax) * 100}%`, background: h === peakHour.hour ? "var(--accent)" : undefined }} />
          </span>;
        })}
        <span className="insights-heat-axis is-margin">{hour(peakHour.hour)} · {compact(value(peakHour))}</span>
      </div>
      <div className="archive-legend">
        {scale.edges.slice(0, 5).map((edge, level) => (
          <span key={level}><i style={{ background: shade(level) }} />{compact(edge)}–{compact(scale.edges[level + 1])}</span>
        ))}
        <span>{t("each step holds a fifth of the active hours", "każdy próg to piąta część godzin z ruchem")}</span>
      </div>
      </ChartExport>
    </Card>
  );
}
