import { useDisclosure } from "../lib/disclosure";
import { calendarDateLabels } from "../lib/chart-dates";
import { ChartExport } from "../components/ChartExport";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { GlobalUsageResponse, GlobalUsageRow } from "../../shared/global-usage";
import { GLOBAL_USAGE_MAX_DAYS } from "../../shared/global-usage";
import { TIME_RANGE_DAYS, timeRangeLabel } from "../../shared/time-range-presets";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRecordedRange } from "../lib/recorded-range";
import { useI18n } from "../lib/i18n";
import { compact, full, pct, usd, usageModelLabel } from "../lib/format";
import { ALL_USAGE_FILTERS, filterUsageRows, isUsageReviewRow, OTHER_USAGE_KEY, topUsageModels, usageAccountKey, usageBucket,
  usageDateRange, usageModelColor, usageModelKey, usagePeriods, usageProviderColor, usageSeries, usageTotals, usageValue,
  USAGE_PROVIDER_LABELS, USAGE_SOURCE_LABELS, USAGE_TOP_MODELS,
  type UsageFilters, type UsageGrouping, type UsageMetric, type UsagePeriod, type UsageSeriesItem, type UsageSplit, type UsageTotals } from "../lib/global-usage";
import { TableRow, Card, CardTitle, ErrorState, Field, GhostButton, LoadingCard, Table, Tabs, Td, Th } from "../components/ui";
import { Kpi, KpiRow, Stack, useWidth, withUnit } from "../components/WindowStatusCard";
import { CLAUDE_CODE_PRODUCT_KEY, OUTSIDE_CODE_PRODUCT_KEY, sumClaudeAccountSplits, type ClaudeAccountSplitWindow,
  type ClaudeAccountSplitsResponse } from "../../shared/claude-code-capacity";
import { polishPlural } from "../lib/mixFormat";
import { TOKEN_PARTS, tokenPartLabel, UNKNOWN_HATCH } from "../lib/token-parts";
import "./Usage.css";

type Translate = (en: string, pl: string) => string;
type Option = { value: string; label: string };
type DateRange = { since: string; until: string };
const monetary = (metric: UsageMetric): metric is "api_usd" | "credits" => metric === "api_usd" || metric === "credits";
const numberOf = (value: number, metric: UsageMetric) => metric === "api_usd" ? usd(value)
  : metric === "credits" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : compact(value);
const providerName = (provider: string) => USAGE_PROVIDER_LABELS[provider] ?? provider;

function tokenComposition(totals: UsageTotals, t: Translate): string {
  const sum = TOKEN_PARTS.reduce((acc, [part]) => acc + totals[part], 0);
  return sum > 0 ? TOKEN_PARTS.map(([part]) => `${tokenPartLabel(part, t)} ${pct(totals[part] / sum * 100, 1)}`).join(" · ") : "";
}

function measureOptions(t: Translate): { value: UsageMetric; label: string; title?: string }[] {
  return [
    { value: "user_tokens", label: t("Tokens", "Tokeny"), title: t("User-work tokens; Codex internal review is shown under the tokens tile", "Tokeny pracy użytkownika; review wewnętrzne Codexa jest podane pod kafelkiem tokenów") },
    { value: "api_usd", label: "API-eq $" },
    { value: "calls", label: t("Calls", "Wywołania") },
    { value: "credits", label: t("Credits", "Kredyty"), title: t("Estimated ChatGPT credits from configured dated rates; other providers have no such unit", "Szacowane kredyty ChatGPT według skonfigurowanych stawek historycznych; inni dostawcy nie mają tej jednostki") },
  ];
}
function measureShort(metric: UsageMetric, t: Translate): string {
  return { user_tokens: t("tokens", "tokeny"), api_usd: "API-eq", calls: t("calls", "wywołania"), credits: t("credits", "kredyty") }[metric];
}
function chartTitle(metric: UsageMetric, group: UsageGrouping, partial: boolean, t: Translate): string {
  const name = { user_tokens: t("Tokens", "Tokeny"), api_usd: "API-eq", calls: t("Calls", "Wywołania"), credits: t("ChatGPT credits (estimate)", "Kredyty ChatGPT (szacunek)") }[metric];
  const per = { day: t("per day", "dziennie"), week: t("per week", "tygodniowo"), month: t("per month", "miesięcznie") }[group];
  return `${name} ${per}${partial ? ` (${t("known part", "znana część")})` : ""}`;
}
function chartSubtitle(group: UsageGrouping, t: Translate): string {
  if (group === "week") return t("the current week is incomplete", "tydzień bieżący niepełny");
  if (group === "month") return t("the current month is incomplete", "miesiąc bieżący niepełny");
  return t("the current day is incomplete", "dzień bieżący niepełny");
}

function UsageFilter({ label, options, value, onChange }: { label: string; options: Option[]; value: string[] | null; onChange: (value: string[] | null) => void }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // The list floats over the page, so a click elsewhere closes it.
    const close = (event: Event) => { const node = ref.current; if (node?.open && !node.contains(event.target as Node)) node.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const selectedKeys = value === null ? null : new Set(value);
  const selected = selectedKeys === null ? options.length : options.filter(option => selectedKeys.has(option.value)).length;
  return <details ref={ref} className="usage-filter">
    <summary className="ui-selector">
      <span className="mono ui-selector-label">{label}</span>
      <span className="mono usage-filter-value">{value === null ? t("all", "wszystkie") : `${selected}/${options.length}`}</span>
      <span className="ui-selector-caret">&#9662;</span>
    </summary>
    <div className="usage-filter-options">
      <div className="usage-group">
        <GhostButton onClick={() => onChange(null)}>{t("All", "Wszystkie")}</GhostButton>
        <GhostButton onClick={() => onChange([])}>{t("None", "Żadne")}</GhostButton>
      </div>
      {options.length > 8 && <input type="search" aria-label={`${t("Search", "Szukaj")}: ${label}`} value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Search…", "Szukaj…")} />}
      {options.filter(option => option.label.toLowerCase().includes(search.toLowerCase())).map(option => <label key={option.value} className="usage-check">
        <input type="checkbox" checked={selectedKeys === null || selectedKeys.has(option.value)} onChange={event => {
          const current = value ?? options.map(item => item.value);
          onChange(event.target.checked ? [...current, option.value] : current.filter(item => item !== option.value));
        }} />{option.label}
      </label>)}
      {!options.length && <span>{t("No indexed entries", "Brak zindeksowanych pozycji")}</span>}
    </div>
  </details>;
}

/** Range presets and the UTC dates; a typed date applies on Enter or when the field loses focus. */
function UsageRange({ range, onApply, all, onAll }: { range: DateRange; onApply: (next: DateRange) => void; all: boolean; onAll: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState<string | null>(null);
  const apply = (next: DateRange) => { setDraft(next); setError(null); onApply(next); };
  const commit = () => {
    if (draft.since === range.since && draft.until === range.until) return;
    const span = (Date.parse(draft.until) - Date.parse(draft.since)) / 86400000 + 1;
    if (!Number.isFinite(span) || span < 1 || span > GLOBAL_USAGE_MAX_DAYS) { setError(t("Choose ordered dates, up to {0} days.", `Wybierz daty w poprawnej kolejności, maksymalnie ${GLOBAL_USAGE_MAX_DAYS} dni.`, [GLOBAL_USAGE_MAX_DAYS])); return; }
    apply(draft);
  };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); commit(); } };
  const preset = TIME_RANGE_DAYS.find(days => { const candidate = usageDateRange(days); return candidate.since === range.since && candidate.until === range.until; });
  return <div className="usage-group">
    <Tabs value={all ? "all" : preset ? String(preset) : ""} onChange={value => value === "all" ? onAll() : apply(usageDateRange(Number(value)))}
      options={[...TIME_RANGE_DAYS.map(days => ({ value: String(days), label: timeRangeLabel(days, t) })), { value: "all", label: t("All", "Całość") }]} />
    <input type="date" className="ui-date-input" aria-label={t("From (UTC)", "Od (UTC)")} required value={draft.since}
      onChange={event => setDraft({ ...draft, since: event.target.value })} onBlur={commit} onKeyDown={onKeyDown} />
    <span className="usage-faint">→</span>
    <input type="date" className="ui-date-input" aria-label={t("Through (UTC)", "Do (UTC)")} required min={draft.since} value={draft.until}
      onChange={event => setDraft({ ...draft, until: event.target.value })} onBlur={commit} onKeyDown={onKeyDown} />
    <span className="mono usage-faint">UTC</span>
    {error && <span className="ui-alert" role="alert">{error}</span>}
  </div>;
}

/** Tokens with their composition, API-eq with its pricing coverage, calls by provider. */
function UsageTiles({ rows, reviewRows }: { rows: GlobalUsageRow[]; reviewRows: GlobalUsageRow[] }) {
  const { t } = useI18n();
  const totals = useMemo(() => usageTotals(rows), [rows]);
  const review = useMemo(() => usageTotals(reviewRows), [reviewRows]);
  const tokens = usageValue(totals, "user_tokens");
  // Review tokens inside rows that also carry user work count here as well.
  const reviewTokens = review.internal_tokens + totals.internal_tokens;
  const parts = TOKEN_PARTS.map(([part, color]) => ({ part, color, value: totals[part] }));
  const partsSum = parts.reduce((sum, part) => sum + part.value, 0);

  const { priced_calls: priced, unpriced_calls: unpriced, subtotal } = totals.api_usd;
  const unpricedModels = useMemo(() => {
    const byModel = new Map<string, { model: string | null; calls: number }>();
    for (const row of rows) {
      if (!row.api_usd.unpriced_calls) continue;
      const entry = byModel.get(usageModelKey(row)) ?? { model: row.model, calls: 0 };
      entry.calls += row.api_usd.unpriced_calls; byModel.set(usageModelKey(row), entry);
    }
    return [...byModel.values()].sort((a, b) => b.calls - a.calls).slice(0, 3);
  }, [rows]);

  const byProvider = useMemo(() => {
    const calls = new Map<string, number>();
    for (const row of rows) calls.set(row.provider, (calls.get(row.provider) ?? 0) + row.calls);
    return [...calls].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const share = (part: number, whole: number) => {
    const value = whole > 0 ? part / whole * 100 : 0;
    return value > 0 && value < 0.05 ? "<0.1%" : pct(value, 1);
  };

  return <KpiRow columns={3}>
    <Kpi label={t("Tokens · without internal review", "Tokeny · bez review wewnętrznego")} value={withUnit(compact(tokens))}
      visual={<div className="usage-tile-stack" title={parts.map(part => `${tokenPartLabel(part.part, t)} ${full(part.value)}`).join(" · ")}>
        <Stack parts={parts.map(part => ({ value: part.value, color: part.color }))} /></div>}
      caption={<>
        {partsSum > 0 ? [...parts].sort((a, b) => b.value - a.value).map(part => `${tokenPartLabel(part.part, t)} ${pct(part.value / partsSum * 100, 1)}`).join(" · ") : "—"}
        {reviewTokens > 0 && <><br />+ {compact(reviewTokens)} {t("Codex internal review · unpriced", "review wewnętrzne Codexa · bez wyceny")}</>}
      </>} />
    <Kpi label={unpriced ? t("API-eq · known part", "API-eq · znana część") : "API-eq"}
      value={priced ? `${unpriced ? "≥ " : ""}${usd(subtotal)}` : "—"}
      visual={<div className="usage-tile-stack" title={t("{0} calls with a price · {1} without", `${full(priced)} wywołań z ceną · ${full(unpriced)} bez ceny`, [full(priced), full(unpriced)])}>
        <Stack parts={[{ value: priced, color: "var(--accent)" }, { value: unpriced, color: UNKNOWN_HATCH }]} /></div>}
      caption={unpriced ? <>
        {t("{0} of calls have no price — not counted as 0", `${pct(unpriced / (priced + unpriced) * 100)} wywołań bez ceny — nie liczone jako 0`, [pct(unpriced / (priced + unpriced) * 100)])}
        {unpricedModels.length > 0 && <> · {t("most", "najwięcej")}: {unpricedModels.map(item => `${usageModelLabel(item.model ?? "?")} ${full(item.calls)}`).join(", ")}</>}
      </> : priced ? t("every call has a price", "wszystkie wywołania mają cenę") : t("no priced calls", "brak wycenionych wywołań")} />
    <Kpi label={t("Calls", "Wywołania")} value={full(totals.calls)}
      visual={<div className="usage-tile-stack"><Stack parts={byProvider.map(([provider, calls]) => ({ value: calls, color: usageProviderColor(provider) }))} /></div>}
      caption={<>
        {byProvider.length ? byProvider.map(([provider, calls]) => `${providerName(provider)} ${share(calls, totals.calls)}`).join(" · ") : "—"}
        {review.calls > 0 && <><br />+ {full(review.calls)} {t("internal review calls", "wywołań review wewnętrznego")}</>}
      </>} />
  </KpiRow>;
}

// Chart geometry in CSS pixels; the width follows the card.
const X0 = 64, RIGHT_GUTTER = 110, Y0 = 232, YT = 22, CHART_HEIGHT = 270;

function UsageChart({ periods, series, metric, group, selected, onSelect }: {
  periods: UsagePeriod[]; series: UsageSeriesItem[]; metric: UsageMetric; group: UsageGrouping; selected: string | null; onSelect: (day: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const [ref, width] = useWidth(1200);
  const X1 = width - RIGHT_GUTTER;
  const sums = periods.map(period => usageValue(period, metric));
  const total = sums.reduce((sum, value) => sum + value, 0);
  const peak = Math.max(0, ...sums);
  const peakIndex = sums.indexOf(peak);
  const mean = periods.length ? total / periods.length : 0;
  const max = peak > 0 ? peak * 1.12 : 1;
  const y = (value: number) => Y0 - (value / max) * (Y0 - YT);
  const step = (X1 - X0) / Math.max(1, periods.length);
  const dateLabels = calendarDateLabels(periods.map(period => period.day), locale);
  const labelWidth = Math.max(1, ...dateLabels.map(label => label?.length ?? 0)) * 6 + 18;
  const stride = Math.max(1, Math.ceil(periods.length / Math.max(1, Math.floor((X1 - X0) / labelWidth))));
  const current = usageBucket(new Date().toISOString().slice(0, 10), group);
  const datesByDay = new Map(periods.map((period, index) => [period.day, dateLabels[index]]));
  const dateLabel = (day: string) => datesByDay.get(day) ?? day;
  const perUnit = { day: t("per day", "na dzień"), week: t("per week", "na tydzień"), month: t("per month", "na miesiąc") }[group];
  const peakX = Math.min(Math.max(X0 + peakIndex * step + step / 2, X0 + 45), X1 - 45);
  return <div ref={ref} style={{ minWidth: 0, overflow: "hidden" }}>
    <svg viewBox={`0 0 ${width} ${CHART_HEIGHT}`} width={width} height={CHART_HEIGHT} role="group" aria-label={t("Usage over time", "Zużycie w czasie")}
      style={{ display: "block", fontFamily: "var(--font-figure)" }}>
      {[0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction}>
        <line x1={X0} x2={X1} y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--line)" strokeDasharray="3 4" />
        <text x={X0 - 8} y={y(max * fraction) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{numberOf(max * fraction, metric)}</text>
      </g>)}
      <line x1={X0} x2={X1} y1={Y0} y2={Y0} stroke="var(--line2)" />
      {periods.map((period, index) => {
        const value = sums[index]!;
        const missing = monetary(metric) ? period[metric].unpriced_calls : 0;
        const known = monetary(metric) ? period[metric].priced_calls > 0 : period.observed;
        const title = `${period.day} UTC · ${!period.observed ? t("No indexed events", "Brak zindeksowanych zdarzeń") : !known ? t("Valuation unavailable", "Wycena niedostępna") : numberOf(value, metric) + (missing ? ` · ${t("known subtotal", "znana część")}` : "")}\n${series.filter(item => (period.segments.get(item.key) ?? 0) > 0).map(item => `${item.label}: ${numberOf(period.segments.get(item.key)!, metric)}`).join("\n")}`;
        const x = X0 + index * step;
        const barWidth = Math.max(1, step - (step > 8 ? 4 : 1));
        const barX = x + (step - barWidth) / 2;
        const on = selected === period.day;
        const activate = () => onSelect(on ? null : period.day);
        let stacked = 0;
        const labelled = index % stride === 0 || (index === periods.length - 1 && index % stride >= stride / 2);
        return <g key={period.day} role="button" tabIndex={0} aria-label={title} aria-pressed={on} className="usage-bar" onClick={activate}
          onKeyDown={event => { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); activate(); }}>
          <title>{title}</title>
          <rect className="usage-bar-hit" x={x} y={YT} width={step} height={Y0 - YT} />
          {series.map(item => {
            const segment = period.segments.get(item.key) ?? 0;
            if (segment <= 0) return null;
            const top = y(stacked + segment), bottom = y(stacked);
            stacked += segment;
            return <rect key={item.key} x={barX} y={top} width={barWidth} height={bottom - top} fill={item.color} />;
          })}
          {!period.observed && <rect x={barX} y={Y0 - 2} width={barWidth} height={2} fill="var(--line2)" />}
          {on && <rect x={x + 0.5} y={YT} width={Math.max(1, step - 1)} height={Y0 - YT} fill="none" stroke="var(--accent)" />}
          {labelled && <text x={x + step / 2} y={Y0 + 16} textAnchor="middle" fontSize={10} fill="var(--muted)">{dateLabel(period.day)}</text>}
        </g>;
      })}
      {peak > 0 && <g pointerEvents="none">
        <text x={peakX} y={y(peak) - 20} textAnchor="middle" fontSize={10} fill="var(--muted)">
          {t("peak", "szczyt")} {dateLabel(periods[peakIndex]!.day)}{periods[peakIndex]!.day === current ? ` (${t("incomplete", "niepełny")})` : ""}
        </text>
        <text x={peakX} y={y(peak) - 6} textAnchor="middle" fontSize={12} fontWeight={500} fill="var(--text)">{numberOf(peak, metric)}</text>
      </g>}
      {total > 0 && <g pointerEvents="none">
        <line x1={X0} x2={X1 + 6} y1={y(mean)} y2={y(mean)} stroke="var(--text)" strokeWidth={1.5} strokeDasharray="6 4" strokeLinecap="round" />
        <text x={X1 + 10} y={y(mean) + 4} fontSize={12} fontWeight={500} fill="var(--text)">{t("avg", "śr.")} {numberOf(mean, metric)}</text>
        <text x={X1 + 10} y={y(mean) + 18} fontSize={10} fill="var(--muted)">{perUnit}</text>
      </g>}
    </svg>
  </div>;
}

function UsageLegend({ series, shares }: { series: UsageSeriesItem[]; shares: Map<string, number> }) {
  return <div className="mono usage-legend">{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.label} {pct((shares.get(item.key) ?? 0) * 100, 1)}</span>)}</div>;
}

const TABLE_MODELS = 5;
function UsageTable({ rows, metric, days, showTypes }: { rows: GlobalUsageRow[]; metric: UsageMetric; days: number; showTypes: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<string[]>([]);
  const expandedKeys = new Set(expanded);
  const groups = useMemo(() => {
    const providers = new Map<string, { rows: GlobalUsageRow[]; models: Map<string, GlobalUsageRow[]> }>();
    for (const row of rows) {
      const provider = providers.get(row.provider) ?? { rows: [] as GlobalUsageRow[], models: new Map<string, GlobalUsageRow[]>() };
      provider.rows.push(row);
      const group = provider.models.get(usageModelKey(row)) ?? []; group.push(row); provider.models.set(usageModelKey(row), group);
      providers.set(row.provider, provider);
    }
    const byValue = (a: { totals: UsageTotals }, b: { totals: UsageTotals }) => usageValue(b.totals, metric) - usageValue(a.totals, metric);
    return [...providers].map(([id, group]) => ({ id, totals: usageTotals(group.rows),
      models: [...group.models.values()].map(items => ({ model: items[0]!.model, totals: usageTotals(items) })).sort(byValue) })).sort(byValue);
  }, [rows, metric]);
  const total = groups.reduce((sum, group) => sum + usageValue(group.totals, metric), 0);
  const largest = Math.max(0, ...groups.map(group => usageValue(group.totals, metric)));
  const columns = 6 + (showTypes ? TOKEN_PARTS.length : 0);
  const cells = (totals: UsageTotals, color: string) => {
    const value = usageValue(totals, metric);
    const known = !monetary(metric) || totals[metric].priced_calls > 0;
    const partial = monetary(metric) && totals[metric].unpriced_calls > 0;
    const { priced_calls: priced, unpriced_calls: unpriced } = totals.api_usd;
    return <>
      <Td><div className="usage-share">
        <div className="usage-share-bar" style={{ width: `${known && largest > 0 && value > 0 ? Math.max(1, value / largest * 100) : 0}%`, background: color }} />
        <span>{known && total > 0 ? pct(value / total * 100, 1) : "—"}</span>
      </div></Td>
      <Td align="right" mono title={tokenComposition(totals, t)}>{compact(usageValue(totals, "user_tokens"))}</Td>
      {showTypes && TOKEN_PARTS.map(([part]) => <Td key={part} align="right" mono>{compact(totals[part])}</Td>)}
      <Td align="right" mono title={unpriced ? t("{0} of {1} calls have no price", `${full(unpriced)} z ${full(priced + unpriced)} wywołań bez ceny`, [full(unpriced), full(priced + unpriced)]) : t("fully priced", "pełna wycena")}>
        {priced ? `${unpriced ? "≥ " : ""}${usd(totals.api_usd.subtotal)}` : "—"}
      </Td>
      <Td align="right" mono>{full(totals.calls)}</Td>
      <Td align="right" mono>{known ? `${partial ? "≥ " : ""}${numberOf(value / Math.max(1, days), metric)}` : "—"}</Td>
    </>;
  };
  const toggle = (id: string) => setExpanded(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  return <Table tableId="Usage:0"><thead><TableRow header>
    <Th columnId="c0">{t("Provider / model", "Dostawca / model")}</Th><Th columnId="c1">{t("Share", "Udział")} · {measureShort(metric, t)}</Th><Th columnId="c2" align="right">{t("Tokens", "Tokeny")}</Th>
    {showTypes && TOKEN_PARTS.map(([part]) => <Th columnId={`token:${part}`} key={part} align="right">{tokenPartLabel(part, t)}</Th>)}
    <Th columnId="c4" align="right">API-eq</Th><Th columnId="c5" align="right">{t("Calls", "Wywołania")}</Th><Th columnId="c6" align="right">{t("Avg / day", "Śr. / dzień")}</Th>
  </TableRow></thead><tbody>
    {groups.map(group => {
      const open = expandedKeys.has(group.id);
      const rest = group.models.slice(TABLE_MODELS);
      const restValue = rest.reduce((sum, model) => sum + usageValue(model.totals, metric), 0);
      return <Fragment key={group.id}>
        <TableRow><Td><button className="usage-expand" type="button" aria-expanded={open} onClick={() => toggle(group.id)}>
          {open ? "▾" : "▸"} <b>{providerName(group.id)}</b>
        </button></Td>{cells(group.totals, usageProviderColor(group.id))}</TableRow>
        {open && group.models.slice(0, TABLE_MODELS).map(model => <TableRow key={model.model ?? ""}>
          <Td><span className="usage-model" title={model.model ?? undefined}>{usageModelLabel(model.model ?? "?")}</span></Td>
          {cells(model.totals, usageModelColor(group.id, model.model))}
        </TableRow>)}
        {open && rest.length > 0 && <TableRow><Td colSpan={columns} style={{ paddingLeft: 28, color: "var(--faint)", fontSize: "var(--fs-3)" }}>
          + {rest.length} {t(rest.length === 1 ? "other" : "others", polishPlural(rest.length, "inny", "inne", "innych"))} ({rest.map(model => usageModelLabel(model.model ?? "?")).join(", ")}) · {numberOf(restValue, metric)}
        </Td></TableRow>}
      </Fragment>;
    })}
    {!groups.length && <TableRow><td colSpan={columns} className="usage-empty">{t("No indexed events match these filters.", "Brak zindeksowanych zdarzeń dla wybranych filtrów.")}</td></TableRow>}
  </tbody></Table>;
}

/**
 * Estimated whole Claude accounts beside the measured table, never added into it: local non-Code
 * traffic is already measured and could reappear inside the vendor's Chats/Other shares.
 */
function ClaudeAccountEstimate({ splits, filters }: { splits: ClaudeAccountSplitsResponse; filters: UsageFilters }) {
  const [estimateOpen, setEstimateOpen] = useDisclosure("usage:claude-account-estimate");
  const { t, locale } = useI18n();
  if (filters.provider !== null && !filters.provider.includes("anthropic")) return null;
  const title = t("Claude — whole account (estimate)", "Claude — całe konto (szacunek)");
  if (splits.pending) {
    return <details className="usage-fold"><summary><b>{title}</b><span>{t("Subscription facts are still being prepared.", "Fakty subskrypcji są jeszcze przygotowywane.")}</span></summary></details>;
  }
  const windows = splits.windows
    .filter(window => filters.account === null || filters.account.includes(usageAccountKey({ provider: "anthropic", account: window.account })))
    .sort((a, b) => a.window_started_at.localeCompare(b.window_started_at));
  if (!windows.length) return null;
  const day = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const date = (iso: string) => day.format(new Date(iso));
  const codeRow = (window: ClaudeAccountSplitWindow) => window.split.rows.find(row => row.key === CLAUDE_CODE_PRODUCT_KEY) ?? null;
  const whole = sumClaudeAccountSplits(windows.map(window => window.split));
  const shares = windows.map(window => codeRow(window)?.percent).filter((value): value is number => value != null);
  const shareText = shares.length <= 2 ? shares.map(value => pct(value)).join(t(" and ", " i "))
    : `${Math.round(Math.min(...shares))}–${pct(Math.max(...shares))}`;
  const facts = [
    `${windows.length} ${t(windows.length === 1 ? "week" : "weeks", polishPlural(windows.length, "tydzień", "tygodnie", "tygodni"))} ${t("from", "od")} ${date(windows[0]!.window_started_at)}`,
    shares.length ? `Claude Code ${shareText} ${t("of the account", "konta")}` : null,
    whole?.account_api_usd != null ? `${t("whole account", "całe konto")} ≈ ${usd(whole.account_api_usd)}` : null,
    whole?.account_tokens != null ? `≈ ${compact(whole.account_tokens)} ${t("tokens", "tokenów")}` : null,
  ].filter(Boolean).join(" · ");
  const accounts = [...new Set(windows.map(window => window.account))];
  const now = Date.now();
  return <details open={estimateOpen} onToggle={event => setEstimateOpen(event.currentTarget.open)} className="usage-fold">
    <summary><b>{title}</b><span>{facts}</span></summary>
    <div className="usage-fold-body mono">
      {accounts.map(account => <Table tableId="Usage:1" key={account}><thead><TableRow header>
        <Th columnId="c0">{t("Week", "Tydzień")} · {t("account", "konto")} {account}</Th><Th columnId="c1">{t("Claude Code · measured", "Claude Code · zmierzone")}</Th>
        <Th columnId="c2">{t("Outside Claude Code · estimate", "Poza Claude Code · szacunek")}</Th><Th columnId="c3">{t("Whole account", "Całe konto")}</Th>
      </TableRow></thead><tbody>
        {windows.filter(window => window.account === account).map(window => {
          const code = codeRow(window);
          const others = window.split.rows.filter(row => !row.measured);
          const unsplit = others.length === 1 && others[0]!.key === OUTSIDE_CODE_PRODUCT_KEY ? others[0]! : null;
          return <TableRow key={window.window_started_at}>
            <Td>{date(window.window_started_at)} → {date(window.reset_at)}{Date.parse(window.reset_at) > now ? ` (${t("current", "bieżący")})` : ""}</Td>
            <Td>{code ? `${pct(code.percent)} · ${usd(code.api_usd)} · ${compact(code.tokens)}` : "—"}</Td>
            <Td>{unsplit ? `${pct(unsplit.percent)} · ≈ ${usd(unsplit.api_usd)} · ≈ ${compact(unsplit.tokens)} (${t("no split", "bez podziału")})`
              : others.length ? others.map(row => `${row.display_name ?? row.key} ${pct(row.percent)}`).join(" · ") : "—"}</Td>
            <Td>{window.split.account_api_usd == null ? "—" : `≈ ${usd(window.split.account_api_usd)}`}</Td>
          </TableRow>;
        })}
      </tbody></Table>)}
      <div className="usage-note">{t("Only weekly windows that started in this period and carry the split are counted; the current one as of its latest reading. Not added to the table above.", "Liczone tylko tygodnie rozpoczęte w okresie i mające podział; bieżący według ostatniego odczytu. Nie dodawane do tabeli powyżej.")}</div>
    </div>
  </details>;
}

function DataCoverage({ data }: { data: GlobalUsageResponse }) {
  const [coverageOpen, setCoverageOpen] = useDisclosure("usage:data-coverage");
  const { t } = useI18n();
  const count = data.sources.length;
  const sources = data.sources.map((source, index) => `${USAGE_SOURCE_LABELS[source.id] ?? source.id} ${source.available
    ? `${full(source.events)}${index === 0 ? ` ${t("events", "zdarzeń")}` : ""}` : t("unavailable", "niedostępne")}`);
  return <details open={coverageOpen} onToggle={event => setCoverageOpen(event.currentTarget.open)} className="usage-fold">
    <summary><b>{t("Data coverage", "Pokrycie danych")}</b><span>
      {count} {t(count === 1 ? "source" : "sources", polishPlural(count, "źródło", "źródła", "źródeł"))} · {full(data.excluded_duplicates)} {t("excluded copies", "pominiętych kopii")} · {full(data.conflicting_events)} {t("conflicting", "sprzecznych")} · {full(data.approximate_time_events)} {t("approximate dates", "przybliżonych dat")}
    </span></summary>
    <div className="usage-fold-body mono usage-muted">
      {[...sources, t("the counts describe all sources in the period, before filters.", "liczby dotyczą wszystkich źródeł w okresie, przed filtrami.")].join(" · ")}
    </div>
  </details>;
}

export function UsageReport({ data, claudeSplits, rangeControl, stale = false }: {
  data: GlobalUsageResponse; claudeSplits?: ClaudeAccountSplitsResponse | null; rangeControl?: ReactNode; stale?: boolean;
}) {
  const { t } = useI18n();
  const [filters, setFilters] = useState<UsageFilters>(ALL_USAGE_FILTERS);
  const [metric, setMetric] = useState<UsageMetric>("user_tokens");
  const [group, setGroup] = useState<UsageGrouping>("day");
  const [split, setSplit] = useState<UsageSplit>("provider");
  const [showTypes, setShowTypes] = useState(false);
  const [selection, setSelection] = useState<{ range: string; day: string } | null>(null);
  const rangeKey = `${data.since}:${data.until}`;
  const selected = selection?.range === rangeKey ? selection.day : null;
  const filtered = useMemo(() => filterUsageRows(data.rows, filters), [data.rows, filters]);
  // Internal review is recorded traffic without a price; it is a caption on the tiles, not part of any measure.
  const { work, review } = useMemo(() => {
    const work: GlobalUsageRow[] = [], review: GlobalUsageRow[] = [];
    for (const row of filtered) (isUsageReviewRow(row) ? review : work).push(row);
    return { work, review };
  }, [filtered]);
  const models = useMemo(() => split === "model" ? topUsageModels(work, metric) : undefined, [work, split, metric]);
  const periods = useMemo(() => usagePeriods(work, data.since, data.until, group, split, metric, models), [work, data.since, data.until, group, split, metric, models]);
  const { series, shares } = useMemo(() => {
    const sums = new Map<string, number>();
    for (const period of periods) for (const [key, value] of period.segments) sums.set(key, (sums.get(key) ?? 0) + value);
    const total = [...sums.values()].reduce((sum, value) => sum + value, 0);
    const shares = new Map([...sums].map(([key, value]) => [key, total > 0 ? value / total : 0]));
    const series = usageSeries(work, split, models, t("Other models", "Pozostałe modele"))
      .filter(item => (sums.get(item.key) ?? 0) > 0)
      .sort((a, b) => Number(a.key === OTHER_USAGE_KEY) - Number(b.key === OTHER_USAGE_KEY) || (sums.get(b.key) ?? 0) - (sums.get(a.key) ?? 0));
    return { series, shares };
  }, [periods, work, split, models, t]);
  const partial = monetary(metric) && work.some(row => row[metric].unpriced_calls > 0);
  const tableRows = selected ? work.filter(row => usageBucket(row.day, group) === selected) : work;
  const days = Math.round((Date.parse(data.until) - Date.parse(data.since)) / 86400000) + 1;
  const selectedDays = selected ? Array.from({ length: days }, (_, i) => new Date(Date.parse(data.since) + i * 86400000).toISOString().slice(0, 10)).filter(day => usageBucket(day, group) === selected).length : days;
  const options = useMemo(() => {
    const sorted = (values: Map<string, string>): Option[] => [...values].map(([value, label]) => ({ value, label })).sort((a,b) => a.label.localeCompare(b.label));
    return {
      provider: sorted(new Map(data.rows.map(row => [row.provider, providerName(row.provider)]))),
      account: sorted(new Map(data.rows.map(row => [usageAccountKey(row), `${providerName(row.provider)} / ${row.account ?? t("Unassigned", "Nieprzypisane")}`]))),
      source: data.sources.map(source => ({ value: source.id, label: `${USAGE_SOURCE_LABELS[source.id] ?? source.id}${source.available ? "" : ` · ${t("unavailable", "niedostępne")}`}` })),
      model: sorted(new Map(data.rows.filter(row => !isUsageReviewRow(row)).map(row => [usageModelKey(row), `${providerName(row.provider)} / ${usageModelLabel(row.model ?? "?")}`]))),
    };
  }, [data.rows, data.sources, t]);
  const labels = { provider: t("Providers", "Dostawcy"), account: t("Accounts", "Konta"), source: t("Sources", "Źródła"), model: t("Models", "Modele") };
  return <>
    <div className="ui-toolbar usage-toolbar">
      {rangeControl}{rangeControl && <span className="usage-sep" />}
      <div className="usage-group">{(Object.keys(labels) as Array<keyof UsageFilters>).map(key => <UsageFilter key={key} label={labels[key]} options={options[key]} value={filters[key]}
        onChange={value => { setFilters(current => ({ ...current, [key]: value })); setSelection(null); }} />)}</div>
      <span className="usage-sep" />
      <Field label={t("Measure", "Miara")}><Tabs value={metric} onChange={value => { setMetric(value); setSelection(null); }} options={measureOptions(t)} /></Field>
      <Field label={t("Period", "Okres")}><Tabs value={group} onChange={value => { setGroup(value); setSelection(null); }}
        options={[{ value: "day", label: t("Day", "Dzień") }, { value: "week", label: t("Week", "Tydzień") }, { value: "month", label: t("Month", "Miesiąc") }]} /></Field>
      <Field label={t("Breakdown", "Podział")}><Tabs value={split} onChange={setSplit}
        options={[{ value: "provider", label: t("Providers", "Dostawcy") }, { value: "model", label: t("Models (top {0})", `Modele (top ${USAGE_TOP_MODELS})`, [USAGE_TOP_MODELS]) }]} /></Field>
    </div>
    <div className="usage-report" hidden={stale}>
      <UsageTiles rows={work} reviewRows={review} />
      <Card><ChartExport title={chartTitle(metric, group, partial, t)}><CardTitle title={chartTitle(metric, group, partial, t)} sub={chartSubtitle(group, t)}
        help={t("Click a bar to narrow the table to that {0}. A gap means no events in the index, not zero.", `Kliknij słupek, aby zawęzić tabelę do ${group === "week" ? "tygodnia" : group === "month" ? "miesiąca" : "dnia"}. Luka oznacza brak zdarzeń w indeksie, nie zero.`, [group])}
        right={<UsageLegend series={series} shares={shares} />} />
        <UsageChart periods={periods} series={series} metric={metric} group={group} selected={selected} onSelect={day => setSelection(day ? { range: rangeKey, day } : null)} />
      </ChartExport>
      </Card>
      <Card><CardTitle title={selected ? `${t("Providers and models", "Dostawcy i modele")} · ${selected}` : t("Providers and models", "Dostawcy i modele")}
        help={t("Share by the selected measure. Expand a provider to see its models.", "Udział według wybranej miary. Rozwiń dostawcę, aby zobaczyć modele.")}
        right={<div className="usage-group">
          {selected && <GhostButton onClick={() => setSelection(null)}>{t("Whole period", "Cały okres")}</GhostButton>}
          <button type="button" className="ui-link-button" aria-pressed={showTypes} onClick={() => setShowTypes(value => !value)}>
            {showTypes ? t("− token type columns", "− kolumny typów tokenów") : t("+ token type columns", "+ kolumny typów tokenów")}
          </button>
        </div>} />
        <UsageTable rows={tableRows} metric={metric} days={selectedDays} showTypes={showTypes} />
        <div className="mono usage-note">{t("≥ = known part (some calls have no price) · token types in the tooltip on the token count or as columns (“+ token type columns”)", "≥ = znana część (część wywołań bez ceny) · typy tokenów w podpowiedzi na liczbie tokenów albo jako kolumny („+ kolumny typów tokenów”)")}</div>
      </Card>
      {claudeSplits && <ClaudeAccountEstimate splits={claudeSplits} filters={filters} />}
      <DataCoverage data={data} />
    </div>
  </>;
}

export function Usage() {
  const [selection, setSelection] = useState<DateRange | null>(() => usageDateRange(30));
  const whole = useRecordedRange(selection === null, undefined, false);
  const range = selection ?? whole.data ?? usageDateRange(1);
  const state = useAsync(signal => whole.ready ? api.globalUsage(range,signal) : Promise.resolve(null), [range.since, range.until, whole.ready]);
  const splits = useAsync(signal => whole.ready ? api.claudeAccountSplits(range,signal) : Promise.resolve(null), [range.since, range.until, whole.ready]);
  const current = whole.ready && state.data?.since === range.since && state.data.until === range.until ? state.data : null;
  const rangeControl = <UsageRange key={`${selection === null}:${range.since}:${range.until}`} range={range} onApply={setSelection}
    all={selection === null} onAll={() => setSelection(null)} />;
  // The page stands on the paper (paper-atlas §3): its blocks drop their frames and are divided by dashed rules.
  return <div className="global-usage ui-tab-page">
    {state.data
      ? <UsageReport data={state.data} stale={!current || !!state.error} rangeControl={rangeControl}
        claudeSplits={splits.data?.since === range.since && splits.data.until === range.until ? splits.data : null} />
      : <div className="ui-toolbar usage-toolbar">{rangeControl}</div>}
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    {whole.error && <ErrorState message={whole.error} onRetry={whole.reload} />}
    {(state.loading || !whole.ready && !whole.error) && (state.data ? <LoadingCard /> : <LoadingCard height={320} shape="kpi" />)}
  </div>;
}
