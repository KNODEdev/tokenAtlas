import { useEffect, useState, type ReactNode } from "react";
import type { WindowProject, WindowProjectMeasures, WindowProjectsResponse } from "../../shared/window-projects";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { compact, full, pct, usd } from "../lib/format";
import { calendarTimeTicks, chartDateFormatter } from "../lib/chart-dates";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { ChartExport } from "./ChartExport";
import { useWidth } from "./WindowStatusCard";
import { TableRow, EmptyState, ErrorState, Fact, Facts, HelpDot, LegendAllToggle, LoadingCard, Table, Tabs, Td, Th } from "./ui";
import { clearHoveredSeries, hoverSeries, useHoveredSeries } from "../lib/hovered-series";
import type { RailWindow } from "../lib/windows";
import { ALL_WINDOW_PROJECTS, projectTokenAllocation, windowProjectsForScope } from "../lib/window-projects";
import { DISTINCT_INKS } from "../lib/model-colors";

const projectKey = (project: WindowProject) => project.project_id === null ? "unassigned" : `p:${project.project_id}`;
// Every chart and table of one account window shares the hovered project.
const hoverScope = (data: WindowProjectsResponse) => `projects|${data.account}|${Date.parse(data.from)}|${Date.parse(data.until)}`;
const DIMMED = 0.2;
const HOUR = 3_600_000, DAY = 86_400_000;
/** One colour per project for the whole window: rank by tokens, Unassigned in the faint ink. */
export function projectColors(projects: readonly WindowProject[]): Map<string, string> {
  const ranked = projects.filter(project => project.project_id !== null)
    .sort((a, b) => b.tokens - a.tokens || projectKey(a).localeCompare(projectKey(b)));
  const colors = new Map(ranked.map((project, index) => [projectKey(project), DISTINCT_INKS[index % DISTINCT_INKS.length]!]));
  colors.set("unassigned", "var(--faint)");
  return colors;
}
function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  return now;
}
const money = (row: Pick<WindowProjectMeasures, "api_usd" | "unpriced_calls" | "unknown_mode_tokens">) => row.api_usd === null ? "—" : `${row.unpriced_calls || row.unknown_mode_tokens ? "≥ " : ""}${usd(row.api_usd)}`;
export function railWindowProjects(account: string, window?: RailWindow | null) {
  return window?.startIso && window.resetIso
    ? <WindowProjects key={JSON.stringify([account, window.startIso, window.resetIso])} account={account} from={window.startIso} until={window.resetIso} /> : undefined;
}
export function WindowProjects({ account, from, until, project, chartOnly = false, usedPercent, control }: {
  account: string; from: string; until: string; project?: string; chartOnly?: boolean; usedPercent?: number | null;
  /** The project picker; it stays in reach while the selected project's chart loads. */
  control?: ReactNode;
}) {
  const { t } = useI18n();
  const state = useAsync(signal => api.windowProjects({ account, from, until }, signal), [account, from, until]);
  const data = windowProjectsForScope(state.data, account, from, until);
  const controlRow = control ? <div className="ui-toolbar"><span style={{ marginLeft: "auto" }}>{control}</span></div> : null;
  if (state.error) return <>{controlRow}<ErrorState message={state.error} onRetry={state.reload} /></>;
  if (!data) return <>{controlRow}<LoadingCard label={t("Loading window projects…", "Wczytywanie projektów okna…")} /></>;
  if (chartOnly && project) return <SelectedProjectChart key={JSON.stringify([account, from, until, project])} data={data} project={project} usedPercent={usedPercent} control={control} />;
  return <WindowProjectsReport key={JSON.stringify([account, from, until])} data={data} />;
}

export function SelectedProjectChart({ data, project, usedPercent, control }: { data: WindowProjectsResponse; project: string; usedPercent?: number | null; control?: ReactNode }) {
  const { t } = useI18n(), allocation = projectTokenAllocation(data, project, usedPercent);
  const [unit, setUnit] = useState<"tokens" | "percent">("tokens");
  const all = project === ALL_WINDOW_PROJECTS, selected = allocation.project;
  const controlRow = control ? <div className="ui-toolbar"><span style={{ marginLeft: "auto" }}>{control}</span></div> : null;
  if (!all && !selected) return <>{controlRow}<EmptyState title={t("This project has no traffic in this window", "Ten projekt nie ma ruchu w tym oknie")} /></>;
  if (!data.projects.length) return <>{controlRow}<EmptyState title={t("No projects in this window", "Brak projektów w tym oknie")} /></>;
  const tokens = all ? data.projects.reduce((sum, row) => sum + row.tokens, 0) : selected!.tokens;
  const share = all ? tokens > 0 ? 1 : null : allocation.share;
  const allocatedPercent = allocation.factor === null ? null : tokens * allocation.factor;
  const percent = unit === "percent" && allocation.factor !== null;
  return <section aria-label={all ? t("All projects usage", "Zużycie wszystkich projektów") : t("Selected project usage", "Zużycie wybranego projektu")}>
    <div className="ui-toolbar">
      <h3>{all ? t("All projects", "Wszystkie projekty") : selected!.name ?? t("Unassigned", "Nieprzypisane")} <HelpDot label={t("Project token allocation", "Podział zużycia według tokenów")}>
        {`${data.from} → ${data.until}. `}
        {all && t("Colored areas divide cumulative tokens between projects. Click a legend entry to hide or show its series. Hiding a series does not change account totals or the allocation denominator. ",
          "Kolorowe obszary dzielą narastające zużycie tokenów między projekty. Kliknij pozycję legendy, aby ukryć lub pokazać serię. Ukrycie serii nie zmienia sum konta ani podstawy przeliczenia. ")}
        {t("The chart shows cumulative recorded tokens in the selected account and window. Estimated limit share = account reading × project tokens / all account tokens in this window, including Unassigned. This assumes equal limit weight per token across models and cache, so it is an allocation estimate, not a measured project limit. Estimates stop at 100%, where later traffic may no longer move the counter, and are unavailable with invalid counters. Account headline metrics remain account-wide.",
          "Wykres pokazuje narastająco zapisane tokeny w wybranym koncie i oknie. Szacowany udział limitu = odczyt konta × tokeny projektu / wszystkie tokeny konta w tym oknie, także Nieprzypisane. Zakłada jednakową wagę tokenów różnych modeli i cache, więc jest podziałem szacunkowym, nie zmierzonym limitem projektu. Przy 100% szacunek jest niedostępny, bo późniejszy ruch może nie zmieniać licznika; podobnie przy nieprawidłowych licznikach. Górne wskaźniki nadal dotyczą całego konta.")}
      </HelpDot></h3>
      <Tabs value={percent ? "percent" : "tokens"} onChange={value => setUnit(value as "tokens" | "percent")} options={[
        { value: "tokens", label: t("Tokens", "Tokeny") }, { value: "percent", label: t("≈ % of limit", "≈ % limitu"), disabled: allocation.factor === null },
      ]} />
      <span className="mono">{compact(tokens)} · {share === null ? "—" : pct(share * 100, 1)} {t("of tokens", "tokenów")}{allocatedPercent !== null ? ` · ≈ ${pct(allocatedPercent, 1)} ${t("of limit", "limitu")}` : ""}</span>
      {control && <span style={{ marginLeft: "auto" }}>{control}</span>}
    </div>
    <ProjectWindowChart data={all ? data : { ...data, projects: [selected!] }} colors={projectColors(data.projects)} cumulative stacked={all} multiplier={percent ? allocation.factor! : 1} percent={percent} />
  </section>;
}

export function WindowProjectsReport({ data }: { data: WindowProjectsResponse }) {
  const { t, locale } = useI18n();
  const dates = chartDateFormatter(locale, Date.parse(data.from), Date.parse(data.until), true);
  const rangeLabel = `${dates.format(Date.parse(data.from))} → ${dates.format(Date.parse(data.until))} UTC`;
  const [open, setOpen] = useState<{ key: string; opener: HTMLElement | null } | null>(null);
  const scope = hoverScope(data), hovered = useHoveredSeries(scope);
  // The table is the legend here: its switches decide what the chart draws.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const colors = projectColors(data.projects);
  const shown = open ? data.projects.find(project => projectKey(project) === open.key) : undefined;
  const name = (project: WindowProject) => project.name ?? t("Unassigned", "Nieprzypisane");
  const tokens = data.projects.reduce((sum, project) => sum + project.tokens, 0);
  const toggle = (key: string) => setHidden(previous => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next; });
  if (!data.projects.length) return <EmptyState title={t("No projects in this window", "Brak projektów w tym oknie")} />;
  return <>
    <div className="ui-toolbar">
      <h3>{t("Project usage", "Zużycie projektów")} <HelpDot label={t("Projects in this window", "Projekty w tym oknie")}>
        {`${data.account} · ${data.from} → ${data.until}. `}
        {t("The exact interval includes its start and excludes its end. Token shares use this account's recorded traffic, including Unassigned; they are not percentages of the provider's limit. API-eq uses the shared historical valuation. ≥ means a priced portion or the Standard lower bound for an unknown billing mode; — means no price. All canonical traffic in the interval is included, also traffic outside the measured limit sample. Invalid counters and approximate conversation times are marked in row tooltips.",
          "Dokładny przedział obejmuje początek i nie obejmuje końca. Udziały tokenów dotyczą zapisanego ruchu tego konta, także Nieprzypisanych; nie są procentami limitu dostawcy. API-eq korzysta ze wspólnej wyceny historycznej. ≥ oznacza wycenioną część albo dolną granicę Standard dla nieznanego trybu; — brak wyceny. Obejmuje cały kanoniczny ruch w przedziale, również poza próbką pomiaru limitu. Nieprawidłowe liczniki i przybliżone czasy rozmów są oznaczone w dymkach wierszy.")}
      </HelpDot></h3>
      <span className="mono" title={`${data.from} → ${data.until}`}>{rangeLabel}</span>
    </div>
    <ProjectWindowChart data={data} colors={colors} hidden={hidden} />
    <Table tableId="WindowProjects:0"><thead><TableRow header><Th columnId="c0">{t("Project", "Projekt")}{data.projects.length > 1 && <> <LegendAllToggle allShown={hidden.size === 0}
      onShowAll={() => setHidden(new Set())} onHideAll={() => setHidden(new Set(data.projects.map(projectKey)))} /></>}</Th><Th columnId="c1" align="right">{t("Tokens", "Tokeny")}</Th>
      <Th columnId="c2" align="right" title={t("Share of this account's tokens in this window", "Udział tokenów tego konta w tym oknie")}>{t("Share", "Udział")}</Th>
      <Th columnId="c3" align="right">API-eq</Th><Th columnId="c4" align="right">{t("Calls", "Wywołania")}</Th><Th columnId="c5" align="right">{t("Models", "Modele")}</Th></TableRow></thead>
      <tbody>{data.projects.map(project => <TableRow key={projectKey(project)} {...hoverSeries(scope, projectKey(project))}
        style={{ background: shown === project || hovered === projectKey(project) ? "var(--accent-soft)" : undefined, opacity: hidden.has(projectKey(project)) ? 0.55 : undefined }}>
        <Td><button type="button" className="ui-legend-dot" aria-pressed={!hidden.has(projectKey(project))} aria-label={`${name(project)} · ${t("on the chart", "na wykresie")}`}
          title={hidden.has(projectKey(project)) ? t("Show on the chart", "Pokaż na wykresie") : t("Hide from the chart", "Ukryj na wykresie")}
          onClick={() => toggle(projectKey(project))} style={{ color: colors.get(projectKey(project)) }}>{hidden.has(projectKey(project)) ? "○" : "●"}</button>{" "}
          <button type="button" className="ui-link-button" onClick={event => setOpen({ key: projectKey(project), opener: event.currentTarget })}>{name(project)} ›</button></Td>
        <Td align="right" mono title={`${full(project.tokens)} · ${t("Invalid counters", "Nieprawidłowe liczniki")}: ${project.invalid_calls} · ${t("Approximate times", "Przybliżone czasy")}: ${project.approximate_calls}`}>
          {project.invalid_calls || project.approximate_calls ? "⚠ " : ""}{compact(project.tokens)}</Td>
        <Td align="right" mono>{tokens > 0 ? pct(project.tokens / tokens * 100, 1) : "—"}</Td>
        <Td align="right" mono title={`${t("Unpriced calls", "Niewycenione wywołania")}: ${project.unpriced_calls} · ${t("Unknown mode tokens", "Tokeny bez trybu")}: ${full(project.unknown_mode_tokens)}`}>{money(project)}</Td>
        <Td align="right" mono>{full(project.calls)}</Td><Td align="right" mono>{project.models.length}</Td>
      </TableRow>)}</tbody></Table>
    {shown && open && <AccountPeriodDrawer busy={false} title={name(shown)} subtitle={`${data.account} · ${rangeLabel}`} returnFocus={open.opener}
      closeLabel={t("Close project", "Zamknij projekt")} onClose={() => setOpen(null)}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-8)" }}>
        <Facts><Fact label={t("Tokens", "Tokeny")} value={compact(shown.tokens)} /><Fact label="API-eq" value={money(shown)} />
          <Fact label={t("Calls", "Wywołania")} value={full(shown.calls)} /></Facts>
        <ProjectWindowChart data={{ ...data, projects: [shown] }} colors={colors} />
        <Table tableId="WindowProjects:1"><thead><TableRow header><Th columnId="c0">{t("Model", "Model")}</Th><Th columnId="c1" align="right">{t("Tokens", "Tokeny")}</Th><Th columnId="c2" align="right">API-eq</Th><Th columnId="c3" align="right">{t("Calls", "Wywołania")}</Th></TableRow></thead>
          <tbody>{shown.models.map(model => <TableRow key={model.model ?? ""}><Td>{model.model ?? "?"}</Td><Td align="right" mono>{compact(model.tokens)}</Td>
            <Td align="right" mono title={`${t("Unpriced calls", "Niewycenione wywołania")}: ${model.unpriced_calls} · ${t("Unknown mode tokens", "Tokeny bez trybu")}: ${full(model.unknown_mode_tokens)}`}>{money(model)}</Td><Td align="right" mono>{full(model.calls)}</Td></TableRow>)}</tbody></Table>
      </div>
    </AccountPeriodDrawer>}
  </>;
}

/** UTC buckets clipped to the chosen window, with a bounded number of bars. */
export function projectWindowBuckets(data: WindowProjectsResponse, step = Date.parse(data.until) - Date.parse(data.from) <= 10 * DAY ? HOUR : DAY) {
  const from = Date.parse(data.from), until = Date.parse(data.until);
  const start = Math.floor(from / step) * step;
  const buckets = Array.from({ length: Math.ceil((until - start) / step) }, (_, index) => ({
    from: Math.max(from, start + index * step), until: Math.min(until, start + (index + 1) * step),
    values: data.projects.map(() => 0),
  }));
  data.projects.forEach((project, projectIndex) => project.hours.forEach(point => {
    const at = Math.max(from, Date.parse(point.hour)), index = Math.floor((at - start) / step);
    if (buckets[index] && at < until) buckets[index]!.values[projectIndex]! += point.tokens;
  }));
  return buckets;
}
const BAR_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
const MIN_BAR_PX = 6, RESET_BAND_PX = 72;
/** The narrowest bucket whose bars stay at least a few pixels wide over the drawn span. */
export function barStep(span: number, plotWidth: number) {
  return BAR_STEPS.find(step => plotWidth / Math.ceil(span / step) >= MIN_BAR_PX) ?? DAY;
}
/** A running window is drawn up to now plus a small margin; the rest until the reset folds into a narrow band. */
export function drawnEnd(from: number, until: number, now: number) {
  return until <= now ? until : Math.min(until, Math.max(from + HOUR, now + Math.max(HOUR, (now - from) * 0.03)));
}
function ProjectWindowChart({ data, colors, hidden: controlled, cumulative = false, stacked = false, multiplier = 1, percent = false }: {
  data: WindowProjectsResponse; colors: Map<string, string>; hidden?: ReadonlySet<string>; cumulative?: boolean; stacked?: boolean; multiplier?: number; percent?: boolean;
}) {
  const { t, locale } = useI18n(), [ref, width] = useWidth(900), now = useMinuteNow();
  const [own, setOwn] = useState<Set<string>>(() => new Set());
  // A table acting as the legend passes its own switches; otherwise the chart keeps a legend of its own.
  const hidden = controlled ?? own, legend = controlled === undefined;
  const visible = data.projects.map(project => !hidden.has(projectKey(project)));
  const color = (project: WindowProject) => colors.get(projectKey(project)) ?? "var(--faint)";
  const scope = hoverScope(data), hovered = useHoveredSeries(scope);
  useEffect(() => () => clearHoveredSeries(scope), [scope]);
  const opacity = (project: WindowProject) => hovered !== null && hovered !== projectKey(project) ? DIMMED : 1;
  const from = Date.parse(data.from), until = Date.parse(data.until);
  const end = drawnEnd(from, until, now), span = end - from;
  const left = 56, right = width - 16, top = 16, bottom = 196, height = 236;
  const plotRight = end < until ? right - RESET_BAND_PX : right;
  const running = data.projects.map(() => 0);
  const buckets = projectWindowBuckets(data, cumulative ? undefined : barStep(span, plotRight - left)).map(bucket => ({ ...bucket, values: bucket.values.map((value, index) => {
    running[index]! += value;
    return (cumulative ? running[index]! : value) * multiplier;
  }) })).filter(bucket => bucket.from < end);
  const lastTraffic = data.projects.reduce((last, project, index) => !visible[index] ? last : project.hours.reduce((stop, hour) =>
    hour.tokens > 0 || hour.calls > 0 ? Math.max(stop, Date.parse(hour.hour) + HOUR) : stop, last), from);
  const max = Math.max(percent ? 0.1 : 1, ...buckets.map(bucket => bucket.values.reduce((sum, value, index) => sum + (visible[index] ? value : 0), 0)));
  const x = (ms: number) => left + (Math.min(ms, end) - from) / span * (plotRight - left);
  const y = (value: number) => bottom - value / max * (bottom - top);
  // A running window's unaligned end may crowd the last calendar tick; it is labelled only when there is room.
  const calendar = calendarTimeTicks(from, end, plotRight - left, locale, span <= 2 * DAY);
  // About 6px per character (as calendarTimeTicks assumes); the end label hangs left, a middle one spreads both ways.
  const ticks = calendar.filter((tick, index) => {
    if (end === until || tick.time !== end || index === 0) return true;
    const previous = calendar[index - 1]!, previousReach = previous.label.length * (previous.time === from ? 6 : 3);
    return x(end) - x(previous.time) >= previousReach + tick.label.length * 6 + 12;
  });
  const resetDay = chartDateFormatter(locale, from, until, false), resetFull = chartDateFormatter(locale, from, until, true);
  const title = `${data.projects.length === 1 ? data.projects[0]!.name ?? t("Unassigned", "Nieprzypisane") : t("Project usage", "Zużycie projektów")} · ${percent ? t("estimated limit share", "szacowany udział limitu") : t("tokens", "tokeny")} · ${data.account} · ${data.from} → ${data.until}`;
  const format = (value: number) => percent ? `≈ ${pct(value, 1)}` : compact(value);
  return <ChartExport title={title}><div ref={ref}>
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={title} style={{ fontFamily: "var(--font-figure)", fontSize: "var(--fs-2)" }}>
      {plotRight < right && <g data-reset-band="">
        <title>{`${t("Reset", "Reset")} · ${resetFull.format(until)}`}</title>
        <rect x={plotRight + 6} y={top} width={right - plotRight - 6} height={bottom - top} fill="var(--band)" />
        <line x1={plotRight + 6} x2={plotRight + 6} y1={top} y2={bottom} stroke="var(--line2)" strokeDasharray="2 3" />
        <text x={right} y={bottom + 24} textAnchor="end" fill="var(--faint)">{`↦ ${resetDay.format(until)}`}</text>
      </g>}
      {[0, max / 2, max].map(value => <g key={value}><line x1={left} x2={plotRight} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeDasharray="3 4" />
        <text x={left - 8} y={y(value) + 4} textAnchor="end" fill="var(--muted)">{format(value)}</text></g>)}
      {cumulative ? data.projects.map((project, index) => {
        if (!visible[index]) return null;
        const points = buckets.filter(bucket => bucket.from < lastTraffic).map(bucket => {
          const lower = stacked ? bucket.values.reduce((sum, value, previous) => sum + (previous < index && visible[previous] ? value : 0), 0) : 0;
          return { time: bucket.until, lower, upper: lower + bucket.values[index]! };
        });
        const upper = `M ${x(from)},${bottom} ` + points.map(point => `L ${x(point.time)},${y(point.upper)}`).join(" ");
        const area = stacked ? ` ${[...points].reverse().map(point => `L ${x(point.time)},${y(point.lower)}`).join(" ")} L ${x(from)},${bottom} Z` : "";
        return <path key={projectKey(project)} d={upper + area} fill={stacked ? color(project) : "none"} fillOpacity={0.2}
          opacity={opacity(project)} stroke={color(project)} strokeWidth={hovered === projectKey(project) ? 2.5 : 1.75} strokeLinecap="round"
          {...hoverSeries(scope, projectKey(project))}><title>{`${project.name ?? t("Unassigned", "Nieprzypisane")} · ${format(running[index]! * multiplier)}`}</title></path>;
      }) : buckets.map(bucket => {
        let sum = 0;
        return <g key={bucket.from}>{bucket.values.map((value, index) => {
          if (!visible[index]) return null;
          sum += value;
          const project = data.projects[index]!;
          return value > 0 ? <rect key={projectKey(project)} x={x(bucket.from)} y={y(sum)}
            width={Math.max(1, x(bucket.until) - x(bucket.from) - 1)} height={value / max * (bottom - top)} fill={color(project)}
            opacity={opacity(project)} {...hoverSeries(scope, projectKey(project))}>
            <title>{`${project.name ?? t("Unassigned", "Nieprzypisane")} · ${new Date(bucket.from).toISOString()} → ${new Date(bucket.until).toISOString()} · ${full(value)} ${t("tokens", "tokenów")}`}</title>
          </rect> : null;
        })}</g>;
      })}
      {!visible.some(Boolean) && <text x={(left + plotRight) / 2} y={(top + bottom) / 2} textAnchor="middle" fill="var(--muted)">{t("No projects selected", "Brak wybranych projektów")}</text>}
      {ticks.map(tick => <text key={tick.time} x={x(tick.time)} y={bottom + 24} textAnchor={tick.time === from ? "start" : tick.time === end ? "end" : "middle"} fill="var(--muted)">{tick.label}</text>)}
    </svg>
    {legend && <div role="group" aria-label={t("Project legend", "Legenda projektów")} style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "var(--s-5)", fontSize: "var(--fs-3)" }}>
      {data.projects.map((project, index) => <button type="button" className="ui-link-button" key={projectKey(project)} aria-pressed={visible[index]}
        {...hoverSeries(scope, projectKey(project))}
        title={`${project.name ?? t("Unassigned", "Nieprzypisane")} · ${format(project.tokens * multiplier)}`}
        onClick={() => setOwn(previous => { const next = new Set(previous), key = projectKey(project); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
        style={{ fontSize: "var(--fs-3)", color: visible[index] ? "var(--text)" : "var(--muted)", textDecoration: visible[index] ? "none" : "line-through" }}>
        <span style={{ color: color(project) }}>●</span> {project.name ?? t("Unassigned", "Nieprzypisane")} · {format(project.tokens * multiplier)}
      </button>)}
      {data.projects.length > 1 && <LegendAllToggle allShown={visible.every(Boolean)} onShowAll={() => setOwn(new Set())}
        onHideAll={() => setOwn(new Set(data.projects.map(projectKey)))} />}
    </div>}
  </div></ChartExport>;
}
