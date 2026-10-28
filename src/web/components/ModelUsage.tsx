import { useDisclosure } from "../lib/disclosure";
import { ChartExport } from "./ChartExport";
import { useMemo, useState } from "react";
import type { CodexAccountingReport } from "../../shared/codex-accounting";
import type { DataSettingsTarget } from "../lib/data-settings";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { compact, full, pct, usageModelLabel, usd } from "../lib/format";
import { codexModelUsage, detailModelUsage, type ModelMode, type ModelUsageRow } from "../lib/model-usage";
import { surfaceName } from "../lib/surfaces";
import { TOKEN_PARTS, tokenPartLabel, UNKNOWN_HATCH, type TokenPart } from "../lib/token-parts";
import { polishPlural } from "../lib/mixFormat";
import { TableColGroup, TableRow, GhostButton, HelpDot, HelpBlock, Table, Td, Th } from "./ui";
import { ACCENT_SOFT, Chip, Kpi, KpiRow, Stack, Track, unit, withUnit } from "./WindowStatusCard";
import { SubscriptionModelDetails } from "./SubscriptionModelDetails";
import { AccountPeriodDrawer } from "./AccountPeriodDrawer";
import { ModelCacheHistory } from "./ModelCacheHistory";
import { cacheTotalsByModel, type CacheTotals } from "../lib/model-cache-history";
import { modelVersionSortValue, useTableSort } from "../lib/table-sort";
import { modelColorsByTokens } from "../lib/model-colors";
import "../screens/History.css";
import "../screens/Usage.css";
import "./ModelUsage.css";

type Translate = (en: string, pl: string) => string;
const PAGE_SIZE = 50;
// Each bar takes its model's colour; Speed is a pale wash of it, so the mode reads without a second hue.
const speedWash = (color: string) => `color-mix(in oklab, ${color} 45%, var(--surface))`;
const MODE_LEGEND: Record<ModelMode, string> = { standard: "var(--muted)", fast: speedWash("var(--muted)"), unknown: UNKNOWN_HATCH };
const CONTEXT_COLORS = ["var(--accent)", ACCENT_SOFT, "var(--violet)", "var(--warn)"];

function modeLabel(mode: ModelMode, t: Translate): string {
  return { standard: "Standard", fast: "Speed", unknown: t("mode not recorded", "tryb niezapisany") }[mode];
}

/** Share of a whole; a tiny non-zero share reads "<0.1%" rather than "0.0%". */
function share(part: number, whole: number): string {
  const value = whole > 0 ? part / whole * 100 : 0;
  return value > 0 && value < 0.05 ? "<0.1%" : pct(value, 1);
}

/** Token types of every detail row (providers other than Codex); Codex rows carry no split. */
function detailComposition(data: CodexAccountingReport): { part: TokenPart; value: number; color: string }[] | null {
  const rows = data.model_details ?? [];
  if (!rows.length) return null;
  const sum = (...keys: string[]) => rows.reduce((total, row) => total + keys.reduce((acc, key) => acc + (Number.isFinite(row.quantities[key]) ? row.quantities[key]! : 0), 0), 0);
  const values: Record<TokenPart, number> = {
    input: sum("in_uncached"),
    cache_read: sum("in_cache_read"),
    cache_write: sum("in_cache_write_5m", "in_cache_write_1h", "in_cache_write_unknown"),
    output: sum("out_total"),
  };
  return TOKEN_PARTS.map(([part, color]) => ({ part, value: values[part], color }));
}

/** Cache read and whole input (fresh + cache read + cache write) per model of the detail rows. */
function detailCache(rows: NonNullable<CodexAccountingReport["model_details"]>): Map<string | null, CacheTotals> {
  const totals = new Map<string | null, CacheTotals>();
  const value = (row: (typeof rows)[number], key: string) => Number.isFinite(row.quantities[key]) ? row.quantities[key]! : 0;
  for (const row of rows) {
    const key = row.model || null, total = totals.get(key) ?? { input: 0, cached: 0 };
    total.cached += value(row, "in_cache_read");
    total.input += ["in_uncached", "in_cache_read", "in_cache_write_5m", "in_cache_write_1h", "in_cache_write_unknown"].reduce((sum, part) => sum + value(row, part), 0);
    totals.set(key, total);
  }
  return totals;
}

/** The cache history reads one account; "All" has no single owner. */
const cacheHistoryAccount = (account: string) => !["all", "__all__"].includes(account.toLowerCase());

/**
 * The Models view of one subscription over the selected dates (docs/design/audit-models-events-projects-mockup.html):
 * four tiles, one model chart split by mode, launch contexts or token types, and the daily rows folded.
 */
export function ModelUsage({ data, codex, account, project, since, until, openDataSettings, onModelEvents, onOverview, aggregateCodexAccounts, vendor }: {
  data: CodexAccountingReport; codex: boolean; account: string; project?: string; since: string; until: string;
  /** One subscription's vendor, for model names without a vendor prefix; "All" leaves it out. */
  vendor?: string;
  openDataSettings?: (target: DataSettingsTarget) => void;
  /** Opens Usage events for this subscription, model and dates. */
  onModelEvents?: (model: string) => void;
  /** Opens the Overview on its "Models and traffic" tab. */
  onOverview?: () => void;
  aggregateCodexAccounts?: readonly string[];
}) {
  const { t, locale } = useI18n();
  const [cacheOpen, setCacheOpen] = useState<{ model: string | null; opener: HTMLElement | null } | null>(null);
  const aggregate = data.provider?.id === "all";
  const cacheAccounts = aggregate ? aggregateCodexAccounts ?? [] : codex && cacheHistoryAccount(account) ? [account] : [];
  const cacheAccountsKey = JSON.stringify(cacheAccounts);
  // Codex cache counters come from stored ledger hours, which carry no project, so a project filter leaves them out.
  const codexCache = useAsync(async signal => {
    if (project || !cacheAccounts.length) return null;
    const timelines = await Promise.all(cacheAccounts.map(account => api.modelCacheHistory({ account, model: "*", since, until }, signal)));
    return { ...timelines[0]!, hours: timelines.flatMap(timeline => timeline.hours) };
  }, [project, cacheAccountsKey, since, until]);
  const cache = useMemo(() => {
    if (cacheAccounts.length && !codexCache.data) return null;
    const totals = codexCache.data ? cacheTotalsByModel(codexCache.data.hours) : new Map<string | null, CacheTotals>();
    if (!codex) for (const [model, counts] of detailCache(data.model_details ?? [])) {
      const prior = totals.get(model) ?? { input: 0, cached: 0 };
      totals.set(model, { input: prior.input + counts.input, cached: prior.cached + counts.cached });
    }
    return totals;
  }, [codex, cacheAccountsKey, codexCache.data, data]);
  const cacheNote = cacheAccounts.length && project ? t("Cache counters are not split by project.", "Liczniki cache nie są dzielone na projekty.")
    : codexCache.error ?? undefined;
  const [detailsOpen, setDetailsOpen] = useDisclosure("models:daily-details");
  const summary = useMemo(() => codex || aggregate ? codexModelUsage(data.breakdown) : detailModelUsage(data.model_details ?? []), [codex, aggregate, data]);
  const composition = useMemo(() => codex || aggregate ? null : detailComposition(data), [codex, aggregate, data]);
  // Providers that record no mode at all (Grok, Gemini, GLM) get no mode tile and plain bars.
  const modesRecorded = codex || summary.modes.standard + summary.modes.fast > 0;
  const known = summary.tokens > 0 ? (summary.modes.standard + summary.modes.fast) / summary.tokens * 100 : null;
  const sources = codex || aggregate ? data.source_home_count : new Set((data.model_details ?? []).map(row => row.source)).size;
  const standard = data.normalization.standard_api_usd;
  const unpricedRows = aggregate ? data.breakdown.filter(row => row.normalization.standard_api_usd.unpriced_events > 0).length
    : (data.model_details ?? []).filter(row => row.api_standard == null && row.tokens > 0).length;
  const compositionSum = composition?.reduce((sum, part) => sum + part.value, 0) ?? 0;
  // Whole dollars and a small "≥" keep four tiles legible in the ~810 px card body; cents stay in the rows.
  const dollars = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const apiValue = summary.apiUsd == null ? "—" : <>{summary.apiPartial && unit("≥ ")}{dollars.format(summary.apiUsd)}</>;
  return <div className="models">
    <KpiRow columns={modesRecorded ? 4 : 3}>
      <Kpi label={t("Tokens", "Tokeny")} value={withUnit(compact(summary.tokens))}
        visual={composition && compositionSum > 0 ? <div className="models-tile-stack" title={composition.map(part => `${tokenPartLabel(part.part, t)} ${full(part.value)}`).join(" · ")}>
          <Stack parts={composition.map(part => ({ value: part.value, color: part.color }))} /></div> : null}
        caption={composition && compositionSum > 0
          ? [...composition].sort((a, b) => b.value - a.value).slice(0, 2).map(part => `${tokenPartLabel(part.part, t)} ${share(part.value, compositionSum)}`).join(" · ")
          : <>{sources} {t(sources === 1 ? "source" : "sources", polishPlural(sources, "źródło", "źródła", "źródeł"))}{codex && <>{" "}
            <HelpDot label={t("Sources", "Źródła")}>{t("Profiles whose calls were read. Completeness of traffic across all machines is unconfirmed.", "Profile, z których odczytano wywołania. Kompletność ruchu wszystkich maszyn jest niepotwierdzona.")}</HelpDot></>}</>} />
      <Kpi label={t("Calls", "Wywołania")} value={full(summary.calls)} visual={null}
        caption={summary.calls > 0 ? `≈ ${compact(summary.tokens / summary.calls)} ${t("tokens / call", "tokenów / wywołanie")}` : "—"} />
      <Kpi label="API-eq · Standard" value={apiValue} visual={null}
        caption={<>
          {codex
            ? <>{t("limit load", "obciążenie limitu")} ≈ {dollars.format(data.normalization.normalized_usd.priced_subtotal)}{standard.unpriced_events > 0 ? ` · ${compact(standard.unpriced_events)} ${t("events without a rate", "zdarzeń bez stawki")}` : ""}</>
            : unpricedRows > 0 ? `${full(unpricedRows)} ${t("rows without a Standard rate", "wierszy bez stawki Standard")}` : t("every row priced", "wszystkie wiersze wycenione")}
          {" "}<HelpDot label="API-eq · Standard">
            <HelpBlock>{t("The work priced at Standard API rates. It is an estimate for comparison, not a charge; ≥ marks a known part when some calls have no rate.", "Praca wyceniona po stawkach Standard API. To szacunek do porównań, nie opłata; ≥ oznacza znaną część, gdy część wywołań nie ma stawki.")}</HelpBlock>
            {codex && <HelpBlock>{t("The limit-load equivalent ({0}) weights each request by its configured credit burden, so Speed work counts as heavier.", `Ekwiwalent obciążenia limitu (${usd(data.normalization.normalized_usd.priced_subtotal)}) waży każde wywołanie jego skonfigurowanym obciążeniem kredytowym, więc praca w Speed liczy się jako cięższa.`, [usd(data.normalization.normalized_usd.priced_subtotal)])}</HelpBlock>}
          </HelpDot>
        </>} />
      {modesRecorded && <Kpi label={t("Known mode", "Znany tryb")} value={known == null ? "—" : <>{Math.round(known)}{unit("%")}</>}
        visual={known == null ? null : <Track fill={known} />}
        caption={known == null ? "—" : t("{0} of tokens without a recorded mode", `${pct(100 - known)} tokenów bez zapisanego trybu`, [pct(100 - known)])} />}
    </KpiRow>
    <ModelChart rows={summary.rows} total={summary.tokens} modesRecorded={modesRecorded} onModelEvents={onModelEvents} vendor={aggregate ? undefined : vendor}
      cache={cache} cacheLoading={cacheAccounts.length > 0 && codexCache.loading} cacheNote={cacheNote}
      onCacheHistory={codex && codexCache.data ? (model, opener) => setCacheOpen({ model, opener }) : undefined} />
    {cacheOpen && codexCache.data && <AccountPeriodDrawer busy={false} returnFocus={cacheOpen.opener} onClose={() => setCacheOpen(null)}
      className="codex-models-drawer" title={cacheOpen.model == null ? t("unknown model", "nieznany model") : usageModelLabel(cacheOpen.model)}
      subtitle={`${account} · ${since} → ${until}`} closeLabel={t("Close cache history", "Zamknij historię cache")}>
      <ModelCacheHistory timeline={codexCache.data} model={cacheOpen.model ?? "?"} account={account}
        baseLabel={t("Selected dates", "Wybrane daty")} initialRange="cycle" />
    </AccountPeriodDrawer>}
    {codex && <CodexContexts account={account} project={project} since={since} until={until} />}
    {codex || aggregate ? <CodexDailyRows breakdown={data.breakdown} showAccounts={aggregate} />
      : <details open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)} className="usage-fold">
        <summary><b>{t("Daily details and rates", "Szczegóły dzienne i stawki")}</b><span>{full(data.model_details?.length ?? 0)} {t("rows · day × model × mode × source, quantity × rate", "wierszy · dzień × model × tryb × źródło, ilość × stawka")}</span></summary>
        <div className="usage-fold-body"><SubscriptionModelDetails rows={data.model_details ?? []} account={account} openDataSettings={openDataSettings} /></div>
      </details>}
    {onOverview && <p className="archive-note">
      {t("Models and contexts of the selected window:", "Modele i konteksty wybranego okna:")}{" "}
      <button type="button" className="ui-link-button" onClick={onOverview}>{t("Overview → Models and traffic", "Przegląd → Modele i ruch")}</button>
    </p>}
  </div>;
}

function ModelChart({ rows, total, modesRecorded, onModelEvents, cache, cacheLoading, cacheNote, onCacheHistory, vendor }: {
  rows: ModelUsageRow[]; total: number; modesRecorded: boolean; onModelEvents?: (model: string) => void; vendor?: string;
  /** Cache read and whole input per model; null while unknown. */
  cache: Map<string | null, CacheTotals> | null; cacheLoading: boolean; cacheNote?: string;
  onCacheHistory?: (model: string | null, opener: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const largest = Math.max(0, ...rows.map(row => row.tokens));
  const modes = modesRecorded ? (["standard", "fast", "unknown"] as const).filter(mode => rows.some(row => row.modes[mode] > 0)) : [];
  const colors = modelColorsByTokens(rows, vendor);
  const colorOf = (model: string | null, mode: ModelMode) => {
    const color = colors.get(model) ?? "var(--muted)";
    return !modesRecorded || mode === "standard" ? color : mode === "fast" ? speedWash(color) : UNKNOWN_HATCH;
  };
  return <ChartExport title={t("Models", "Modele")} available={rows.length > 0}><section className="models-chart" aria-label={t("Models", "Modele")}>
    <div className="archive-head">
      <div><b>{t("Models", "Modele")}</b> <span className="archive-sub">· {t("share of the tokens in the selected dates", "udział w tokenach wybranych dat")}</span></div>
      <div className="archive-legend">{modes.map(mode => <span key={mode}><i style={{ background: MODE_LEGEND[mode] }} />{modeLabel(mode, t)}</span>)}</div>
    </div>
    {!rows.length ? <div className="archive-empty">{t("No events in this period.", "Brak zdarzeń w tym okresie.")}</div> : <Table tableId="ModelUsage:0" defaultSort={{ column: "c0", direction: "desc" }} fixed><TableColGroup>
      <col style={{ width: "22%" }} /><col /><col style={{ width: 72 }} /><col style={{ width: 76 }} /><col style={{ width: 72 }} /><col style={{ width: 104 }} />{onModelEvents && <col style={{ width: 104 }} />}
    </TableColGroup><thead><TableRow header>
      <Th columnId="c0" title={t("Default: newer model versions first", "Domyślnie: nowsze wersje modeli najpierw")}>{t("Model", "Model")}</Th><Th columnId="c1">{t("Share of tokens · mode", "Udział w tokenach · tryb")}</Th><Th columnId="c2" align="right">{t("Tokens", "Tokeny")}</Th>
      <Th columnId="c3" align="right">{t("Calls", "Wywołania")}</Th>
      <Th columnId="c6" align="right" title={cacheNote ?? t("Cache read as a share of input over the selected dates", "Odczyt z cache jako udział inputu w wybranych datach")}>{t("Cache", "Cache")}</Th>
      <Th columnId="c4" align="right" title={t("Standard API rates; ≥ = known part", "Stawki Standard API; ≥ = znana część")}>API-eq</Th>{onModelEvents && <Th columnId="c5"> </Th>}
    </TableRow></thead><tbody>
      {rows.map(row => {
        const title = [
          ...(modesRecorded ? ["standard", "fast", "unknown"] as const : []).filter(mode => row.modes[mode] > 0).map(mode => `${modeLabel(mode, t)} ${compact(row.modes[mode])}`),
          ...(row.extraCredits != null ? [`${t("Speed credits above Standard", "Kredyty Speed ponad Standard")} ${row.extraPartial ? "≥ " : ""}${row.extraCredits.toFixed(2)}`] : []),
        ].join(" · ");
        return <TableRow key={row.model ?? ""}>
          <Td sortValue={modelVersionSortValue(row.model)} style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={row.model ?? undefined}>
            {row.model == null ? <span className="models-muted">{t("unknown model", "nieznany model")}</span> : <span className="mono">{row.model}</span>}
            {row.model?.includes("spark") && <> <Chip tone="var(--muted)" soft="var(--raised)" title={t("A model with its own limit; Capacity leaves it out of the shared-limit comparison.", "Model z osobnym limitem; Pojemność pomija go w porównaniu wspólnego limitu.")}>{t("separate limit", "osobny limit")}</Chip></>}
          </Td>
          <Td sortValue={row.tokens}><div className="usage-share" title={title}>
            <div className="models-bar" style={{ width: `${largest > 0 ? Math.max(1, row.tokens / largest * 100) : 0}%` }}>
              {(["standard", "fast", "unknown"] as const).map(mode => row.modes[mode] > 0 && <span key={mode} style={{ flexGrow: row.modes[mode], background: colorOf(row.model, mode) }} />)}
            </div>
            <span>{share(row.tokens, total)}</span>
          </div></Td>
          <Td sortValue={row.tokens} mono align="right" title={full(row.tokens)}>{compact(row.tokens)}</Td>
          <Td sortValue={row.calls} mono align="right" title={full(row.calls)}>{compact(row.calls)}</Td>
          <Td sortValue={cache?.get(row.model)?.input ? cache.get(row.model)!.cached / cache.get(row.model)!.input : null} mono align="right">{(() => {
            const counts = cache?.get(row.model);
            if (!counts || counts.input <= 0) return <span className="models-muted" title={cacheNote}>{cacheLoading ? "…" : "—"}</span>;
            const value = pct(100 * counts.cached / counts.input, 1);
            const detail = `${t("cache read", "odczyt cache")} ${full(counts.cached)} / ${t("input", "wejście")} ${full(counts.input)}`;
            return onCacheHistory ? <button type="button" className="ui-link-button" title={`${detail} · ${t("open cache history", "otwórz historię cache")}`}
              aria-label={`${row.model ?? t("unknown model", "nieznany model")}: ${value} · ${t("open cache history", "otwórz historię cache")}`}
              onClick={event => onCacheHistory(row.model, event.currentTarget)}>{value}</button> : <span title={detail}>{value}</span>;
          })()}</Td>
          <Td sortValue={row.apiUsd} mono align="right" title={row.apiPartial ? t("some calls have no Standard rate", "część wywołań bez stawki Standard") : undefined}>
            {row.apiUsd == null ? <span className="models-muted">{t("no rate", "brak stawki")}</span> : `${row.apiPartial ? "≥ " : ""}${usd(row.apiUsd)}`}
          </Td>
          {onModelEvents && <Td align="right">{row.model != null && <button type="button" className="ui-link-button" onClick={() => onModelEvents(row.model!)}>{t("events →", "zdarzenia →")}</button>}</Td>}
        </TableRow>;
      })}
    </tbody></Table>}
  </section></ChartExport>;
}

/** Launch contexts over the same dates and project, as shares of tokens. */
function CodexContexts({ account, project, since, until }: { account: string; project?: string; since: string; until: string }) {
  const { t } = useI18n();
  const state = useAsync(signal => api.breakdown({ dim: "surface", account, since, until, project_id: project || undefined }, signal), [account, project, since, until]);
  const rows = (state.data?.rows ?? []).filter(row => row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const color = (index: number) => CONTEXT_COLORS[index] ?? "var(--line2)";
  return <ChartExport title={t("Launch contexts", "Konteksty uruchomienia")} available={rows.length > 0}><section className="models-contexts" aria-label={t("Launch contexts", "Konteksty uruchomienia")}>
    <div className="archive-head"><div><b>{t("Launch contexts", "Konteksty uruchomienia")}</b> <span className="archive-sub">· {t("share of tokens", "udział w tokenach")}</span></div></div>
    {state.error ? <div className="archive-note">{t("Contexts could not be loaded", "Nie udało się wczytać kontekstów")}: {state.error}</div>
      : !state.data ? <div className="archive-note">{t("Loading contexts…", "Wczytywanie kontekstów…")}</div>
      : !rows.length ? <div className="archive-note">{t("No context recorded in this period.", "W tym okresie nie zapisano kontekstu.")}</div>
      : <>
        <Stack parts={rows.map((row, index) => ({ value: row.tokens, color: color(index) }))} />
        <div className="models-context-list">
          {rows.map((row, index) => <span key={row.name} title={`${full(row.tokens)} ${t("tokens", "tokenów")} · ${full(row.calls)} ${t("calls", "wywołań")}`}>
            <i style={{ background: color(index) }} />{surfaceName(row.name, t)} <code>{row.name}</code> <b>{share(row.tokens, total)}</b>
          </span>)}
        </div>
      </>}
  </section></ChartExport>;
}

/** Codex's day × model × mode × source rows, folded and paginated at 50. */
function CodexDailyRows({ breakdown, showAccounts }: { breakdown: CodexAccountingReport["breakdown"]; showAccounts?: boolean }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useDisclosure("models:codex-daily-details");
  const [page, setPage] = useState(0);
  const { rows, sorting } = useTableSort(breakdown, {
    c0: row => row.day, c1: row => modelVersionSortValue(row.model), c2: row => row.home,
    c3: row => row.events, c4: row => row.tokens,
    c5: row => row.normalization.standard_api_usd.priced_events > 0 ? row.normalization.standard_api_usd.priced_subtotal : null,
  }, locale, { column: "c0", direction: "desc" }, () => setPage(0));
  const pageCount = Math.max(1, Math.ceil(breakdown.length / PAGE_SIZE));
  const active = Math.min(page, pageCount - 1);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="usage-fold">
    <summary><b>{t("Daily details", "Szczegóły dzienne")}</b><span>{full(breakdown.length)} {t("rows · day × model × mode × source", "wierszy · dzień × model × tryb × źródło")}</span></summary>
    <div className="usage-fold-body">
      <Table tableId="ModelUsage:1" sorting={sorting} fixed><TableColGroup><col style={{ width: 96 }} /><col /><col /><col style={{ width: 88 }} /><col style={{ width: 76 }} /><col style={{ width: 104 }} /></TableColGroup>
        <thead><TableRow header><Th columnId="c0">{t("Day", "Dzień")}</Th><Th columnId="c1">{t("Model / mode", "Model / tryb")}</Th><Th columnId="c2">{t("Source", "Źródło")}</Th>
        <Th columnId="c3" align="right">{t("Calls", "Wywołania")}</Th><Th columnId="c4" align="right">{t("Tokens", "Tokeny")}</Th><Th columnId="c5" align="right">API-eq</Th></TableRow></thead><tbody>
        {rows.slice(active * PAGE_SIZE, (active + 1) * PAGE_SIZE).map(row => {
          const api = row.normalization.standard_api_usd;
          const source = showAccounts ? [row.account, row.home].filter(Boolean).join(" · ") : row.home;
          return <TableRow key={JSON.stringify([row.day, row.model, row.speed, row.account, row.home])}>
            <Td mono>{row.day}</Td>
            <Td style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.model ?? t("unknown model", "nieznany model")} · {row.speed === "fast" ? "Speed" : row.speed === "standard" ? "Standard" : t("mode not recorded", "tryb niezapisany")}</Td>
            <Td style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={source ?? undefined}>{source || t("unknown", "nieznane")}</Td>
            <Td mono align="right">{full(row.events)}</Td>
            <Td mono align="right" title={full(row.tokens)}>{compact(row.tokens)}</Td>
            <Td mono align="right">{api.priced_events > 0 ? `${api.unpriced_events > 0 ? "≥ " : ""}${usd(api.priced_subtotal)}` : "—"}</Td>
          </TableRow>;
        })}
      </tbody></Table>
      {breakdown.length > PAGE_SIZE && <div className="ui-toolbar models-pages">
        <GhostButton disabled={active === 0} onClick={() => setPage(active - 1)}>{t("Previous", "Poprzednia")}</GhostButton>
        <span className="mono">{t("Page", "Strona")} {active + 1} / {pageCount}</span>
        <GhostButton disabled={active + 1 >= pageCount} onClick={() => setPage(active + 1)}>{t("Next", "Następna")}</GhostButton>
      </div>}
    </div>
  </details>;
}
